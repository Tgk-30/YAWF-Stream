// Disposable Windows runner diagnostic. Never reads application data or changes ACLs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('This diagnostic requires a disposable Windows Actions runner.');
}
const output = process.argv[2];
if (!output || dirname(resolve(output)).toLowerCase() !== resolve(process.env.RUNNER_TEMP).toLowerCase()) {
  throw new Error('The diagnostic output must be directly inside the runner temporary directory.');
}
const modulePath = resolve('server/src/privateStorage.ts');
const source = readFileSync(modulePath, 'utf8');
const prefix = 'const DESCRIPTOR_OBSERVER = String.raw`';
const start = source.indexOf(prefix);
const end = source.indexOf('\n`;', start + prefix.length);
if (start < 0 || end < start || source.indexOf(prefix, start + 1) >= 0) throw new Error('Observer extraction failed.');
const originalObserver = source.slice(start + prefix.length, end);
const observer = '[Console]::Error.WriteLine("phase:start")\n' + originalObserver
  .replace("Add-Type -TypeDefinition @'", "[Console]::Error.WriteLine(\"phase:add-type\")\nAdd-Type -TypeDefinition @'")
  .replace("'@\n$entries =", "'@\n[Console]::Error.WriteLine(\"phase:parse-input\")\n$entries =")
  .replace("$installer = $null", "[Console]::Error.WriteLine(\"phase:identity\")\n$installer = $null")
  .replace('foreach ($entry in $entries) {', 'foreach ($entry in $entries) {\n[Console]::Error.WriteLine("phase:descriptor")')
  .replace('[Console]::WriteLine((ConvertTo-Json', '[Console]::Error.WriteLine("phase:serialize")\n[Console]::WriteLine((ConvertTo-Json');
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const admitted = new Set(['SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'USERPROFILE',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'LOCALAPPDATA', 'APPDATA']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => admitted.has(key.toUpperCase()))
  .map(([key, value]) => [key.toUpperCase(), value]));
env.PSModulePath = join(dirname(powershell), 'Modules');
const root = mkdtempSync(join(tmpdir(), 'yawf-observer-diagnostic-'));
const result = { diagnosticOnly: true, sourceSHA256: createHash('sha256').update(source).digest('hex'),
  node: process.version, observerSucceeded: false, descriptorSummaries: [], failure: null };
try {
  const entries = [{ id: 0, path: root, kind: 'directory' }];
  for (let parent = dirname(root); ; parent = dirname(parent)) {
    entries.push({ id: entries.length, path: parent, kind: 'ancestor' });
    if (dirname(parent) === parent) break;
  }
  const observerStarted = Date.now();
  try {
    const raw = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(observer, 'utf16le').toString('base64')], { input: JSON.stringify(entries), encoding: 'utf8',
      env, timeout: 7000, maxBuffer: 256000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const descriptors = JSON.parse(raw.replace(/^\uFEFF/, '').trim());
    const { windowsStorageDescriptorIsPrivate } = await import(pathToFileURL(modulePath).href);
    result.observerSucceeded = true;
    result.descriptorSummaries = descriptors.map((value, index) => {
      const role = sid => sid === value.currentSid ? 'current-user' : sid === 'S-1-5-18' ? 'system' :
        sid === 'S-1-5-32-544' ? 'administrators' : sid === value.trustedInstallerSid ? 'os-installer' : 'other';
      return { index, kind: value.kind, ownerRole: role(value.ownerSid), directory: value.directory,
        reparse: value.reparse, daclPresent: value.daclPresent, daclNull: value.daclNull,
        rawAceTypes: value.rawAceTypes, policyPrivate: windowsStorageDescriptorIsPrivate(value),
        rules: value.rules.map(rule => ({ principal: role(rule.sid), allow: rule.allow, rights: rule.rights,
          inheritOnly: rule.inheritOnly, objectInherit: rule.objectInherit,
          containerInherit: rule.containerInherit, noPropagate: rule.noPropagate })) };
    });
  } catch (error) {
    // Only this static, content-free observer's failure is retained. Strip runner paths.
    const stderr = String(error.stderr ?? '').replace(/[A-Z]:\\[^\r\n]*/gi, '[runner-path]');
    result.failure = { name: error.name, status: error.status ?? null, code: error.code ?? null,
      stderr: stderr.slice(0, 6000) };
  }
  result.observerDurationMs = Date.now() - observerStarted;
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  const enumControl = String.raw`
$ErrorActionPreference = 'Stop'
$flags = [Security.AccessControl.AceFlags]3
$before = 'completed'
try { $null = $flags -band [Security.AccessControl.AceFlags]::ObjectInherit } catch { $before = $_.Exception.GetType().Name }
[Console]::WriteLine(('{0}|{1}|{2}|{3}|{4}' -f
  [Enum]::GetUnderlyingType([Security.AccessControl.AceFlags]).Name,
  $before,
  (([int]$flags -band [int][Security.AccessControl.AceFlags]::ObjectInherit) -ne 0),
  (([int]$flags -band [int][Security.AccessControl.AceFlags]::ContainerInherit) -ne 0),
  (([int]$flags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -ne 0)))
`;
  const controlStarted = Date.now();
  try {
    const rawControl = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-EncodedCommand', Buffer.from(enumControl, 'utf16le').toString('base64')], { env, encoding: 'utf8',
      timeout: 7000, maxBuffer: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const match = /^(Byte|Int32)\|(completed|[A-Za-z]+Exception)\|(True|False)\|(True|False)\|(True|False)$/.exec(rawControl);
    if (!match) throw new Error('Unexpected bounded enum control result.');
    result.byteEnumControl = { underlyingType: match[1], uncastOutcome: match[2],
      integerObjectInherit: match[3] === 'True', integerContainerInherit: match[4] === 'True',
      integerInheritOnly: match[5] === 'True' };
  } catch (error) {
    result.byteEnumControlFailure = { name: error.name, code: error.code ?? null, status: error.status ?? null };
  }
  result.controlDurationMs = Date.now() - controlStarted;
} finally {
  rmSync(root, { recursive: true, force: true });
}
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ diagnosticOnly: true, observerSucceeded: result.observerSucceeded,
  failureCode: result.failure?.code ?? null }));
