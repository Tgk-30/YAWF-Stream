import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const release = readFileSync(new URL('../.github/workflows/web-release.yml', import.meta.url), 'utf8');
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const desktop = readFileSync(new URL('../.github/workflows/desktop-build.yml', import.meta.url), 'utf8');
const cold = readFileSync(new URL('../.github/workflows/windows-storage-observer-cold.yml', import.meta.url), 'utf8');
const windowsGate = "matrix.os == 'windows' && vars.YAWF_RELEASE_WINDOWS == 'true'";
const shippingGate = "matrix.os != 'windows' || vars.YAWF_RELEASE_WINDOWS == 'true'";
const helper = 'server/.build/windows-storage-observer/unsigned/StorageDescriptorObserver.exe';

function step(source, name) {
  const anchor = `      - name: ${name}\n`;
  const start = source.indexOf(anchor);
  assert.ok(start >= 0, `Missing step ${name}`);
  assert.equal(source.indexOf(anchor, start + 1), -1, `Duplicate step ${name}`);
  const end = source.indexOf('\n      - ', start + anchor.length);
  return source.slice(start, end < 0 ? source.length : end);
}

function validate(source) {
  const names = ['Compile Windows storage observer', 'Sign Windows storage observer',
    'Verify and bind signed Windows storage observer'];
  const [compile, sign, bind] = names.map(name => step(source, name));
  for (const body of [compile, sign, bind]) assert.ok(body.includes(`        if: ${windowsGate}\n`));
  for (const body of [compile, bind]) {
    assert.doesNotMatch(body, /AZURE_|secrets\.|        env:/);
  }
  assert.ok(compile.includes('node scripts/prepare_windows_storage_observer.mjs compile'));
  assert.doesNotMatch(sign, /prepare_windows_storage_observer\.mjs/);
  for (const name of ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID',
    'AZURE_ARTIFACT_SIGNING_ENDPOINT', 'AZURE_ARTIFACT_SIGNING_ACCOUNT', 'AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE']) {
    assert.ok(sign.includes('          ' + name + ': ${{ secrets.' + name + ' }}'));
  }
  assert.ok(sign.includes('if ($unsignedPin -cne $compiled.unsignedHelperSha256)'));
  assert.ok(sign.includes(`$helper = '${helper}'`));
  assert.ok(bind.includes('Get-AuthenticodeSignature -FilePath $helper'));
  assert.ok(bind.includes("if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode')"));
  const check = bind.indexOf('Get-AuthenticodeSignature');
  const hash = bind.indexOf('$finalPin = (Get-FileHash $helper -Algorithm SHA256).Hash.ToLowerInvariant()');
  const finalize = bind.indexOf('node scripts/prepare_windows_storage_observer.mjs bind --sha256 $finalPin');
  assert.ok(check >= 0 && hash > check && finalize > hash);
  assert.ok(bind.includes("if ($LASTEXITCODE -ne 0) { throw 'Signed storage observer binding failed.' }"));
  const order = [...names, 'Test server', 'Build server bundle', 'Build hosted PWA assets', 'Prepare desktop server resources'];
  for (let i = 1; i < order.length; i++) assert.ok(source.indexOf(`      - name: ${order[i - 1]}\n`) < source.indexOf(`      - name: ${order[i]}\n`));
  for (const name of order.slice(3)) assert.ok(step(source, name).includes(`        if: ${shippingGate}\n`));
}

function signer(source, result = { status: 0 }, config = { cmd: 'artifact-signing-cli', args: ['-e', 'https://fixture.codesigning.azure.net', '%1'] }) {
  const body = step(source, 'Sign Windows storage observer').split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const match = body.match(/node --input-type=module -e @'\n([\s\S]*?)\n'@/);
  assert.ok(match);
  const program = match[1].replace(/^import .*;\n/gm, '');
  const calls = [], logs = [], process = { exitCode: 0 };
  const run = new Function('spawnSync', 'resolve', 'windowsSigningConfig', 'console', 'process', `"use strict";\n${program}`);
  run((...args) => { calls.push(args); return result; }, path => { assert.equal(path, helper); return 'fixture/helper.exe'; },
    () => ({ bundle: { windows: { signCommand: config } } }), { error: value => logs.push(value) }, process);
  return { calls, logs, exitCode: process.exitCode };
}

test('Windows observer compile, signing and binding are separate, gated and ordered', () => validate(release));

test('signing uses the approved command without a shell or raw output persistence', () => {
  const run = signer(release);
  assert.equal(run.exitCode, 0); assert.deepEqual(run.logs, []); assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0][0], 'artifact-signing-cli');
  assert.deepEqual(run.calls[0][1], ['-e', 'https://fixture.codesigning.azure.net', 'fixture/helper.exe']);
  assert.deepEqual(run.calls[0][2], { shell: false, timeout: 180000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] });
});

for (const result of [{ status: 9, stdout: 'synthetic-private-output', stderr: 'synthetic-private-error' },
  { status: 0, error: new Error('synthetic-private-error') }, { status: null }]) {
  test(`signing fails closed with sanitized output, status ${String(result.status)}`, () => {
    const run = signer(release, result); assert.equal(run.exitCode, 1);
    assert.deepEqual(run.logs, ['Windows storage observer signing failed. Raw signer output was not retained.']);
  });
}

for (const config of [{ cmd: 'powershell.exe', args: ['%1'] }, { cmd: 'artifact-signing-cli', args: [] },
  { cmd: 'artifact-signing-cli', args: ['%1', '%1'] }]) {
  test(`signing rejects an unexpected command or placeholder count ${config.args.length}`, () => {
    const run = signer(release, { status: 0 }, config); assert.equal(run.exitCode, 1); assert.equal(run.calls.length, 0);
  });
}

test('ordinary Windows source and unsigned bundle jobs explicitly prepare before use', () => {
  for (const [source, name, following] of [[ci, 'Prepare unsigned Windows storage observer for source tests', 'Test server'],
    [desktop, 'Prepare unsigned Windows storage observer for CI bundles', 'Build server bundle']]) {
    const body = step(source, name);
    assert.doesNotMatch(body, /AZURE_|secrets\./);
    assert.ok(body.includes('prepare_windows_storage_observer.mjs compile'));
    assert.ok(body.includes('Get-FileHash $helper -Algorithm SHA256'));
    assert.ok(body.includes('prepare_windows_storage_observer.mjs bind --sha256 $pin'));
    assert.ok(source.indexOf(body) < source.indexOf(`      - name: ${following}\n`, source.indexOf(body)));
  }
});

function validateCold(source) {
  assert.doesNotMatch(source, /secrets\.|contents: write|packages: write/);
  assert.ok(source.includes("    if: github.event_name == 'workflow_dispatch'"));
  assert.ok(source.includes('        os: [windows-2022, windows-2025]'));
  assert.ok(source.includes('    runs-on: windows-2022'));
  assert.ok(source.includes('    needs: [host-contracts, producer]'));
  const consumer = source.slice(source.indexOf('\n  consumer:\n'));
  const suite = 'Full source suite first, unchanged native and test deadlines';
  const before = consumer.slice(0, consumer.indexOf(`      - name: ${suite}\n`));
  assert.ok(before.includes('merge-multiple: true'));
  assert.ok(before.includes('artifact-ids: ${{ needs.producer.outputs.artifact_id }}'));
  assert.ok(before.includes('--sha256 $env:EXPECTED_PACKET_SHA256'));
  assert.ok(before.includes('EXPECTED_PACKET_SHA256: ${{ needs.producer.outputs.packet_sha256 }}'));
  assert.equal((before.match(/npm ci --ignore-scripts --no-audit --no-fund --prefix /g) ?? []).length, 2);
  assert.doesNotMatch(before, /prepare_windows_storage_observer\.mjs compile|csc\.exe|StorageDescriptorObserver\.exe|npm run build|--version/);
  assert.ok(step(source, suite).includes('run: node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism'));
  assert.ok(consumer.indexOf(`      - name: ${suite}\n`) < consumer.indexOf('      - name: Prepare and smoke actual packaged layout with relocated Node\n'));
  assert.equal((source.match(/include-hidden-files: true/g) ?? []).length, 2);
}

test('fresh consumers hash-admit an immutable producer packet before unfiltered full suites without warmup', () => validateCold(cold));

for (const [name, from, to] of [
  ['consumer compilation warmup', '      - name: Full source suite first, unchanged native and test deadlines', '      - run: node scripts/prepare_windows_storage_observer.mjs compile\n      - name: Full source suite first, unchanged native and test deadlines'],
  ['unbound artifact selection', 'artifact-ids: ${{ needs.producer.outputs.artifact_id }}', 'name: latest-observer'],
  ['packet pin omitted', '--sha256 $env:EXPECTED_PACKET_SHA256', '--sha256 unpinned'],
  ['dependency lifecycle warmup', 'npm ci --ignore-scripts --no-audit --no-fund --prefix web\n', 'npm ci --no-audit --no-fund --prefix web\n'],
  ['focused suite substituted', 'run: node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism', 'run: node node_modules/vitest/vitest.mjs run test/privateStorage.test.ts --maxWorkers=1 --no-file-parallelism'],
]) {
  test(`rejects fresh-consumer ${name}`, () => {
    // Target the consumer rather than an earlier producer command.
    const start = cold.indexOf('\n  consumer:\n');
    const before = cold.slice(0, start), body = cold.slice(start);
    const changed = body.replace(from, to); assert.notEqual(changed, body);
    assert.throws(() => validateCold(before + changed));
  });
}

for (const [name, from, to] of [
  ['release hold removal', `      - name: Compile Windows storage observer\n        if: ${windowsGate}`, "      - name: Compile Windows storage observer\n        if: matrix.os == 'windows'"],
  ['credential exposure to compiler', '          node scripts/prepare_windows_storage_observer.mjs compile', '          echo $env:AZURE_CLIENT_SECRET\n          node scripts/prepare_windows_storage_observer.mjs compile'],
  ['unsigned identity bypass', 'if ($unsignedPin -cne $compiled.unsignedHelperSha256)', 'if ($false)'],
  ['signature bypass', 'Get-AuthenticodeSignature -FilePath $helper', 'Get-Item -Path $helper'],
  ['weaker signature predicate', "$signature.Status -ne 'Valid' -or", "$signature.Status -ne 'Valid' -and"],
  ['stale unsigned binding', '$finalPin = (Get-FileHash $helper -Algorithm SHA256).Hash.ToLowerInvariant()', '$finalPin = $unsignedPin'],
  ['binding failure ignored', "if ($LASTEXITCODE -ne 0) { throw 'Signed storage observer binding failed.' }", 'Write-Output complete'],
  ['held Windows resource gate removed', `      - name: Prepare desktop server resources\n        if: ${shippingGate}\n`, '      - name: Prepare desktop server resources\n'],
]) {
  test(`rejects ${name}`, () => {
    const mutant = release.replace(from, to); assert.notEqual(mutant, release); assert.throws(() => validate(mutant));
  });
}
