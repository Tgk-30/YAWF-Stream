#!/usr/bin/env node
// Hosted destination discovery only. Never builds, tests, installs or launches an app.
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { hostedContext, admitToolchain, registrySnapshot, nativeEnvironment, RUNTIME, MIN_FREE_BYTES } from './ipad-native-qa/hosted-run.mjs';

export const OFFSETS_MS = Object.freeze([0, 15_000, 45_000]);
export const DEVICE_TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPad-A16';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_COMMAND_BYTES = 1024 ** 2;
const MAX_ARTIFACT_BYTES = 32 * 1024 ** 2;
function requireThat(ok, message) { if (!ok) throw new Error(message); }
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value; }
export function fullRegistry(registry, excluding = null) {
  registrySnapshot(registry); // Reuse UUID/duplicate admission before comparison.
  return Object.entries(registry.devices ?? {}).flatMap(([runtime, rows]) => rows.map((row) => canonical({ ...row, rawMetadata: row, runtime, udid: row.udid.toUpperCase() })))
    .filter((row) => row.udid !== excluding?.toUpperCase()).sort((a, b) => a.udid.localeCompare(b.udid));
}
export function diagnosticContext(env, platform = process.platform, arch = process.arch, real = realpathSync) {
  const context = hostedContext(env, platform, arch, real);
  return { ...context, evidence: join(context.temp, `ipad-destination-diagnostic-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`) };
}
export function ownedTarget(ownership, registry, before, home = homedir()) {
  requireThat(ownership?.schemaVersion === 1 && ownership.createdFor === 'ipad-destination-diagnostic' && ownership.createdFresh === true && UUID.test(ownership.udid ?? '') && /^YAWF-iPad-DestinationDiagnostic-[a-f0-9-]{36}$/i.test(ownership.name ?? ''), 'Missing fresh diagnostic ownership');
  requireThat(ownership.runtimeIdentifier === RUNTIME && ownership.deviceTypeIdentifier === DEVICE_TYPE && ownership.rootApprovedDefaultSet === true && ownership.deviceSetPath === join(home, 'Library/Developer/CoreSimulator/Devices'), 'Diagnostic tuple/default set mismatch');
  requireThat(!before.some((row) => row.udid === ownership.udid.toUpperCase()), 'Preexisting simulator cannot become owned');
  const row = fullRegistry(registry).find((entry) => entry.udid === ownership.udid.toUpperCase());
  if (!row) return null;
  requireThat(row.name === ownership.name && row.runtime === RUNTIME && row.deviceTypeIdentifier === DEVICE_TYPE && row.dataPath === join(ownership.deviceSetPath, ownership.udid, 'data'), 'Owned simulator tuple changed');
  return row;
}
export function destinationObservation(text, ownership) {
  let section = null, compatible = false, incompatible = false;
  for (const line of text.split('\n')) {
    if (/Available destinations for|Destinations compatible with/.test(line)) section = 'compatible';
    if (/Ineligible destinations|Unavailable destinations|Destinations incompatible with/.test(line)) section = 'incompatible';
    if (!section || !line.includes('{') || !line.includes('}')) continue;
    const fields = Object.fromEntries(line.slice(line.indexOf('{') + 1, line.lastIndexOf('}')).split(',').map((field) => { const at = field.indexOf(':'); return [field.slice(0, at).trim(), field.slice(at + 1).trim()]; }));
    if (fields.platform !== 'iOS Simulator' || fields.id?.toUpperCase() !== ownership.udid.toUpperCase() || fields.name !== ownership.name) continue;
    if (section === 'compatible') compatible = true; else incompatible = true;
  }
  return { observed: compatible && !incompatible, incompatible };
}
export function executeBounded(command, args, options) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, timedOut = false, truncated = false, errorCode = null, finished = false, grace;
    const finish = (status, signal, closed) => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(grace);
      if (!closed) { child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
      resolveResult({ stdout, stderr, status, signal, closed, timedOut, truncated, errorCode });
    };
    const stop = () => {
      if (grace) return;
      try { child.kill('SIGKILL'); } catch { errorCode = 'KILL_FAILED'; }
      grace = setTimeout(() => finish(null, null, false), 2_000);
    };
    const capture = (side, chunk) => {
      const remaining = Math.max(0, MAX_COMMAND_BYTES - bytes); bytes += chunk.length;
      const text = chunk.subarray(0, remaining).toString('utf8');
      if (side === 'stdout') stdout += text; else stderr += text;
      if (bytes > MAX_COMMAND_BYTES) { truncated = true; stop(); }
    };
    child.stdout.on('data', (chunk) => capture('stdout', chunk)); child.stderr.on('data', (chunk) => capture('stderr', chunk));
    child.once('error', (error) => { errorCode = /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'COMMAND_ERROR'; });
    child.once('close', (status, signal) => finish(status, signal, true));
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeout);
  });
}
function recorder(context, env, deps, prefix) {
  const artifact = join(context.evidence, 'evidence'); let sequence = 0;
  const entries = readdirSync(artifact).map((name) => lstatSync(join(artifact, name)));
  requireThat(entries.every((entry) => entry.isFile() && !entry.isSymbolicLink()), 'Only regular owned artifact files admitted');
  let bytes = entries.reduce((total, entry) => total + entry.size, 0);
  const now = deps.now ?? (() => performance.now());
  const write = (name, value) => {
    const data = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
    bytes += Buffer.byteLength(data); requireThat(bytes <= MAX_ARTIFACT_BYTES, 'Bounded artifact budget exceeded');
    writeFileSync(join(artifact, name), data, { flag: 'wx', mode: 0o600 });
  };
  const exec = async (command, args, timeout = 10_000, tail = false) => {
    const startedMs = now(); const result = await (deps.execute ?? executeBounded)(command, args, { timeout, env: nativeEnvironment(join(context.evidence, 'tmp'), env) });
    const log = `${prefix}-${String(++sequence).padStart(2, '0')}-${basename(command)}.log`;
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    requireThat(Buffer.byteLength(output) <= MAX_COMMAND_BYTES + 8, 'Unbounded command output refused');
    const retained = tail ? Buffer.from(output).subarray(-64 * 1024).toString('utf8') : output; write(log, retained);
    const metadata = { command, args, startedMs, endedMs: now(), wallTimeUTC: new Date().toISOString(), status: result.status, signal: result.signal ?? null, timedOut: result.timedOut === true, truncated: result.truncated === true, closed: result.closed !== false, errorCode: result.errorCode ?? null, log, sha256: createHash('sha256').update(retained).digest('hex'), capturedBytes: Buffer.byteLength(output), retainedBytes: Buffer.byteLength(retained), tail };
    write(`${log}.json`, metadata); return { ...result, metadata };
  };
  const checked = async (command, args, timeout) => {
    const result = await exec(command, args, timeout);
    requireThat(result.status === 0 && result.closed !== false && !result.timedOut && !result.truncated, `Required diagnostic command failed: ${basename(command)}`); return result.stdout;
  };
  return { artifact, write, exec, checked, now };
}
async function cleanup(context, env, deps, record) {
  const { write, checked } = record, home = deps.home ?? homedir();
  const load = (name) => {
    const path = join(record.artifact, name); requireThat(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() && lstatSync(path).size <= MAX_COMMAND_BYTES, 'Invalid bounded ownership input');
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  if (!existsSync(join(record.artifact, 'devices-before.json'))) return { noCreatedDevice: true };
  const before = fullRegistry(load('devices-before.json'));
  const current = JSON.parse(await checked('/usr/bin/xcrun', ['simctl', 'list', 'devices', '-j']));
  if (existsSync(join(record.artifact, 'ownership.json'))) {
    const ownership = load('ownership.json');
    requireThat(ownership.source === context.source && ownership.runId === env.GITHUB_RUN_ID && ownership.runAttempt === env.GITHUB_RUN_ATTEMPT, 'Cleanup source/run mismatch');
    const row = ownedTarget(ownership, current, before, home);
    if (row) {
      const shutdownResult = await record.exec('/usr/bin/xcrun', ['simctl', 'shutdown', ownership.udid]);
      requireThat(shutdownResult.closed !== false && !shutdownResult.timedOut, 'Owned shutdown teardown unknown');
      // Revalidate exact ownership after shutdown, before deletion.
      const shutdown = JSON.parse(await checked('/usr/bin/xcrun', ['simctl', 'list', 'devices', '-j'])); requireThat(ownedTarget(ownership, shutdown, before, home)?.state === 'Shutdown', 'Owned tuple not Shutdown before deletion');
      await checked('/usr/bin/xcrun', ['simctl', 'delete', ownership.udid]);
    }
  }
  const after = JSON.parse(await checked('/usr/bin/xcrun', ['simctl', 'list', 'devices', '-j'])); write(`${record.cleanupName ?? 'devices-after'}.json`, after);
  requireThat(JSON.stringify(fullRegistry(after)) === JSON.stringify(before), 'Preexisting simulator metadata changed or an unrecorded device remains');
  return { preexistingDevicesUnchanged: true, ownedAbsent: true };
}
export async function runDiagnostic(env = process.env, deps = {}) {
  const context = diagnosticContext(env, deps.platform ?? process.platform, deps.arch ?? process.arch, deps.real ?? realpathSync);
  mkdirSync(context.evidence, { mode: 0o700 }); mkdirSync(join(context.evidence, 'evidence'), { mode: 0o700 }); mkdirSync(join(context.evidence, 'tmp'), { mode: 0o700 });
  const record = recorder(context, env, deps, 'run'), { checked, exec, write, now } = record;
  const receipt = { schemaVersion: 1, mode: 'destination-discovery-diagnostic-only', source: context.source, diagnosticCompleted: false, productBuilt: false, nativeTestsExecuted: false, samples: [] }; let failure;
  try {
    write('context.json', { source: context.source, imageOS: env.ImageOS, imageVersion: env.ImageVersion });
    requireThat((await checked('/usr/bin/git', ['-C', context.workspace, 'rev-parse', 'HEAD'])).trim() === context.source, 'Checked-out source mismatch');
    requireThat(/^26\./.test((await checked('/usr/bin/sw_vers', ['-productVersion'])).trim()), 'Actual macOS26 required');
    const version = await checked('/usr/bin/xcodebuild', ['-version']);
    const runtimes = JSON.parse(await checked('/usr/bin/xcrun', ['simctl', 'list', 'runtimes', '-j']));
    const types = JSON.parse(await checked('/usr/bin/xcrun', ['simctl', 'list', 'devicetypes', '-j']));
    const freeBytes = deps.freeBytes ? deps.freeBytes() : (() => { const fs = statfsSync(context.temp); return fs.bavail * fs.bsize; })();
    const admitted = admitToolchain(version, runtimes, types, freeBytes); requireThat(admitted.deviceType.identifier === DEVICE_TYPE, 'Exact A16 type required');
    write('toolchain.json', { version, ...admitted, freeBytes, minimumFreeBytes: MIN_FREE_BYTES });
    const home = deps.home ?? homedir(), deviceSetPath = join(home, 'Library/Developer/CoreSimulator/Devices');
    requireThat((deps.real ?? realpathSync)(deviceSetPath) === deviceSetPath, 'Canonical default device set required');
    const initial = JSON.parse(await checked('/usr/bin/xcrun', ['simctl', 'list', 'devices', '-j'])); const before = fullRegistry(initial); write('devices-before.json', initial);
    const name = `YAWF-iPad-DestinationDiagnostic-${(deps.uuid ?? randomUUID)()}`; requireThat(!before.some((row) => row.name === name), 'Diagnostic name already exists');
    write('creation-intent.json', { name, runtime: RUNTIME, deviceType: DEVICE_TYPE });
    const udid = (await checked('/usr/bin/xcrun', ['simctl', 'create', name, DEVICE_TYPE, RUNTIME], 30_000)).trim().toUpperCase(); requireThat(UUID.test(udid), 'No exact new UUID returned');
    const ownership = { schemaVersion: 1, createdFor: 'ipad-destination-diagnostic', createdFresh: true, source: context.source, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, udid, name, runtimeIdentifier: RUNTIME, deviceTypeIdentifier: DEVICE_TYPE, deviceSetPath, rootApprovedDefaultSet: true };
    write('ownership.json', ownership);
    const created = JSON.parse(await checked('/usr/bin/xcrun', ['simctl', 'list', 'devices', '-j'])); const row = ownedTarget(ownership, created, before, home);
    requireThat(row?.state === 'Shutdown' && row.isAvailable === true && JSON.stringify(fullRegistry(created, udid)) === JSON.stringify(before), 'Fresh tuple/registry not admitted before boot');
    await checked('/usr/bin/xcrun', ['simctl', 'boot', udid]); await checked('/usr/bin/xcrun', ['simctl', 'bootstatus', udid, '-b'], 120_000);
    const bootMs = now(); const project = join(context.workspace, 'scripts/ipad-native-qa/NativeQA.xcodeproj');
    for (const offsetMs of OFFSETS_MS) {
      await (deps.sleep ?? sleep)(Math.max(0, bootMs + offsetMs - now())); const actualMs = now() - bootMs;
      const results = await Promise.all([
        exec('/usr/bin/xcrun', ['simctl', 'list', 'runtimes', '-j']), exec('/usr/bin/xcrun', ['simctl', 'list', 'devices', '-j']),
        exec('/usr/bin/xcrun', ['xcdevice', 'list']), exec('/usr/bin/xcodebuild', ['-project', project, '-scheme', 'NativeQA', '-showdestinations']),
      ]);
      const discoveryComplete = results[3].status === 0 && results[3].closed !== false && !results[3].timedOut && !results[3].truncated;
      const sample = { offsetMs, actualMs, wallTimeUTC: new Date().toISOString(), commands: results.map((result) => result.metadata), destination: { ...(discoveryComplete ? destinationObservation(results[3].stdout ?? '', ownership) : { observed: false, incompatible: false }), commandCompleted: discoveryComplete } }; receipt.samples.push(sample); write(`sample-${offsetMs}.json`, sample);
      requireThat(results.every((result) => result.closed !== false), 'Unknown command teardown; stop discovery');
      requireThat(results.slice(0, 2).every((result) => result.status === 0 && !result.timedOut && !result.truncated), 'Postboot registry/runtime snapshot unavailable');
      const devices = JSON.parse(results[1].stdout); const owned = ownedTarget(ownership, devices, before, home);
      requireThat(owned?.state === 'Booted' && owned.isAvailable === true && JSON.stringify(fullRegistry(devices, udid)) === JSON.stringify(before), 'Postboot tuple/preexisting metadata mismatch');
      const currentRuntime = JSON.parse(results[0].stdout).runtimes?.filter((item) => item.identifier === RUNTIME && item.version === '26.5' && item.isAvailable === true); requireThat(currentRuntime?.length === 1, 'Postboot runtime no longer admitted');
    }
    const resolver = await exec('/usr/bin/xcodebuild', ['-project', project, '-scheme', 'NativeQA', '-sdk', 'iphonesimulator', '-destination', `platform=iOS Simulator,id=${udid}`, '-destination-timeout', '30', '-showBuildSettings', '-derivedDataPath', join(context.evidence, 'DerivedData'), 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO'], 40_000);
    receipt.resolver = resolver.metadata;
    receipt.logTail = (await exec('/usr/bin/log', ['show', '--last', '5m', '--style', 'compact', '--predicate', '(process == "CoreSimulatorService") OR (subsystem BEGINSWITH "com.apple.CoreSimulator") OR (subsystem BEGINSWITH "com.apple.dt") OR (process == "xcodebuild")'], 10_000, true)).metadata;
    requireThat(resolver.closed !== false, 'Resolver teardown unknown'); receipt.diagnosticCompleted = true;
  } catch (error) { failure = error; receipt.error = error.message; }
  finally {
    try { receipt.cleanup = await cleanup(context, env, deps, record); } catch (error) { receipt.cleanupError = error.message; failure ??= error; }
    receipt.destinationObserved = receipt.samples.some((sample) => sample.destination.observed); receipt.status = failure ? 'stopped' : 'diagnostic-completed'; write('receipt.json', receipt);
  }
  if (failure) throw failure; return receipt;
}
export async function runDiagnosticCleanup(env = process.env, deps = {}) {
  const context = diagnosticContext(env, deps.platform ?? process.platform, deps.arch ?? process.arch, deps.real ?? realpathSync);
  if (!existsSync(context.evidence)) return { noOwnedRun: true };
  requireThat(realpathSync(context.evidence) === context.evidence && !lstatSync(context.evidence).isSymbolicLink(), 'Unowned cleanup root');
  const artifact = join(context.evidence, 'evidence'); requireThat(lstatSync(artifact).isDirectory() && !lstatSync(artifact).isSymbolicLink() && realpathSync(artifact) === artifact, 'Unowned cleanup artifact root');
  const record = recorder(context, env, deps, 'final'); record.cleanupName = 'devices-after-final';
  const result = await cleanup(context, env, deps, record); record.write('cleanup-final.json', result); return result;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    requireThat(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--cleanup-only'), 'Only diagnostic or exact cleanup-only operation admitted');
    const receipt = process.argv[2] ? await runDiagnosticCleanup() : await runDiagnostic();
    console.log(JSON.stringify({ mode: 'destination-discovery-diagnostic-only', diagnosticCompleted: receipt.diagnosticCompleted === true, destinationObserved: receipt.destinationObserved === true }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
