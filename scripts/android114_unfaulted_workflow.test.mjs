import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const workflow = read('../.github/workflows/android114-unfaulted-qa.yml');
const publicWorkflow = read('../.github/workflows/android-foreground-qa.yml');
const driver = read('./android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeForegroundPlaybackFlowTest.java');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function section(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing section ${start}`);
  assert.equal(source.indexOf(start, first + start.length), -1, `Duplicate section ${start}`);
  return source.slice(first, last);
}

function contract(source, reference = publicWorkflow, java = driver) {
  assert.equal(sha256(reference), '1cb644cff702bd51b8bbb2ec533e10b22adadbe5fa7dff6f608b79bd156f89fd');
  assert.equal(sha256(java), '5f1ef260fb1295c234e5448065cbdf8baf478a9abbab06475cffe0d69acd0c3b');
  const trigger = section(source, '\non:\n', '\npermissions:');
  assert.match(trigger, /^\non:\n  push:\n    branches: \[codex\/android114-unfaulted-qa\]\n    paths: \[\.github\/workflows\/android114-unfaulted-qa\.yml\]\n  workflow_dispatch:\n/);
  assert.deepEqual([...trigger.matchAll(/^  ([a-z_]+):/gm)].map((m) => m[1]), ['push', 'workflow_dispatch']);
  assert.match(trigger, /run_mode:[\s\S]*?default: admission\n        options: \[admission, full\]/);
  assert.match(trigger, /playback_case:[\s\S]*?default: direct\n        options: \[direct, hls, auto-mkv\]/);
  assert.ok(source.includes("        playback_case: ${{ fromJSON(format('[\"{0}\"]', inputs.playback_case || 'direct')) }}"));
  assert.ok(source.includes("      REQUESTED_MODE: ${{ github.event_name == 'push' && github.ref_name == 'codex/android-foreground114-full-qa' && 'full' || github.event_name == 'workflow_dispatch' && inputs.run_mode == 'full' && 'full' || 'admission' }}"));
  const guard = section(source, '    if: >-\n', '    name: Unpublished');
  assert.equal(guard, `    if: >-\n      github.repository_owner == 'Tgk-30' &&\n      github.repository == 'Tgk-30/YAWF-Stream' &&\n      github.actor == github.repository_owner &&\n      github.ref_type == 'branch' &&\n      github.ref_name == 'codex/android114-unfaulted-qa'\n`);
  assert.match(source, /^      FIXTURE_SOURCE_SHA: d477d2a3eb2977c429c0a3b1a9128374536075cd$/m);
  assert.match(source, /test "\$\(git -C fixture-source rev-parse HEAD\)" = "\$FIXTURE_SOURCE_SHA"/);
  assert.match(source, /test "\$\(sha256sum fixture-source\/scripts\/ipad-foreground\/passive_observer\.mjs \| awk '\{print \$1\}'\)" = 73d12d475d280ce430993bcbd709a38e4b8f970cbd9e58d39fabe9a2259b0369/);
  assert.match(source, /ref: \$\{\{ env\.FIXTURE_SOURCE_SHA \}\}\n          path: fixture-source\n          persist-credentials: false/);

  // Preserve the public workflow's complete driver build and observation, including
  // private ADB ownership, fresh AVD, cleanup, timeouts, and validator invocation.
  const buildStart = '      - name: Build current long fixture and isolated native UI driver\n';
  const summaryStart = "          python3 - <<'PY'\n          import hashlib,json,os\n";
  const failureStart = '          # BEGIN OWNED FAILURE SCREENSHOT\n';
  const failureEnd = '          # END OWNED FAILURE SCREENSHOT\n';
  const failure = section(source, failureStart, failureEnd) + failureEnd;
  assert.equal((failure.match(/python3 - <<'PY_FAILURE' \|\| true/g) ?? []).length, 1);
  assert.equal(sha256(failure), '653c59086f7baf8a5ac636925279aa0518492ae17bd506f8b6c0541d11c8a98e');
  const observation = section(source, buildStart, summaryStart);
  assert.ok(observation.includes(failure + '\n          test "$instrumentation_status" -eq 0\n'));
  const candidateObservation = observation.replace(failure + '\n', '')
    .replace('"$CANDIDATE_APK_SHA256"', '"$PUBLIC_APK_SHA256"');
  assert.equal(candidateObservation, section(reference, buildStart, summaryStart));
  assert.match(candidateObservation, /-e class com\.yawf\.runtimeinstrumentation\.RuntimeForegroundPlaybackFlowTest/);
  assert.match(candidateObservation, /com\.yawf\.runtimeinstrumentation\.test\/androidx\.test\.runner\.AndroidJUnitRunner/);
  assert.doesNotMatch(source, /FaultOncePlugin|evaluateJavascript|addJavascriptInterface|chrome:\/\/inspect/i);

  const summary = section(source, '          summary={\n', "          if os.environ['REQUESTED_PRESENTATION'] in (");
  for (const entry of [
    "'artifactChannel':'unpublished-candidate114'", "'candidatePublished':False",
    "'startupFaultInjected':False", "'appProcessInstrumented':False", "'runtimePublished':False",
    "'hostedAdmission':False", "'fullQualification':False", "'observerAbiIntegrated':False",
  ]) {
    assert.equal(summary.split(entry).length - 1, 1, `Missing or duplicate boundary ${entry}`);
    const key = entry.split(':')[0];
    assert.equal(summary.split(key).length - 1, 1, `Duplicate key ${key}`);
  }
  const result = section(source, "          if os.environ['REQUESTED_PRESENTATION']=='normal-diagnostic':", '          summary={\n');
  assert.match(result, /result\['outcome'\]=='observer-abi-unintegrated'/);
  assert.match(result, /result\['observerIntegrationStatus'\]=='stage2-schema-and-sealed-window-required'/);
  assert.match(result, /result\['hostedAdmission'\] is False and result\['fullQualification'\] is False/);
}

function mutate(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, `Mutation must be unique: ${before}`);
  return source.replace(before, after);
}

test('unfaulted candidate workflow preserves bounded observation and evidence contracts', () => {
  contract(workflow);
});

test('semantic gates reject weakening mutations', async (t) => {
  const mutations = [
    ['global push', '    branches: [codex/android114-unfaulted-qa]\n', ''],
    ['different push branch', 'branches: [codex/android114-unfaulted-qa]', 'branches: [main]'],
    ['push tags', '    paths: [.github/workflows/android114-unfaulted-qa.yml]', '    tags: [v*]\n    paths: [.github/workflows/android114-unfaulted-qa.yml]'],
    ['push path', 'paths: [.github/workflows/android114-unfaulted-qa.yml]', 'paths: ["**"]'],
    ...['pull_request', 'schedule', 'workflow_call'].map((event) => [event, '  workflow_dispatch:\n', `  ${event}:\n  workflow_dispatch:\n`]),
    ['single default direct', "inputs.playback_case || 'direct'", "inputs.playback_case || 'hls'"],
    ['push admission', "github.ref_name == 'codex/android-foreground114-full-qa' && 'full'", "github.ref_name == 'codex/android114-unfaulted-qa' && 'full'"],
    ['owner guard', "github.actor == github.repository_owner", "github.actor != github.repository_owner"],
    ['branch guard', "github.ref_name == 'codex/android114-unfaulted-qa'", "github.ref_name != 'codex/android114-unfaulted-qa'"],
    ['fixture revision', 'FIXTURE_SOURCE_SHA: d477d2a3eb2977c429c0a3b1a9128374536075cd', 'FIXTURE_SOURCE_SHA: 0000000000000000000000000000000000000000'],
    ['validator hash', '73d12d475d280ce430993bcbd709a38e4b8f970cbd9e58d39fabe9a2259b0369', '0000000000000000000000000000000000000000000000000000000000000000'],
    ['fresh emulator', 'test ! -e "$ANDROID_USER_HOME"', 'true'],
    ['private adb ownership', 'test "${adb_pids[0]}" = "$adb_pid"\n          test "${adb_identity%%:*}"', 'true\n          test "${adb_identity%%:*}"'],
    ['cleanup', 'stop_owned_adb || status=1', 'true'],
    ['deadline', 'deadline=$((SECONDS + 300))', 'deadline=$((SECONDS + 999999))'],
    ['ordinary observer', '-e class com.yawf.runtimeinstrumentation.RuntimeForegroundPlaybackFlowTest', '-e class com.yawf.runtimeinstrumentation.FaultOncePlugin'],
    ['app injection', '          trap cleanup EXIT', '          FaultOncePlugin\n          trap cleanup EXIT'],
    ['validator reused', 'node scripts/android_foreground_playback_receipt.mjs \\', 'node scripts/other_validator.mjs \\'],
    ['failure capture success guard', 'if [ "$native_test_ok" = false ]; then', 'if [ "$native_test_ok" = true ]; then'],
    ['failure capture deadline', 'timeout 10s "${adb_cmd[@]}" exec-out screencap -p', 'timeout 100s "${adb_cmd[@]}" exec-out screencap -p'],
    ['failure capture cap', 'head -c 8388609 > "$failure_capture"', 'head -c 99999999 > "$failure_capture"'],
    ['failure capture crc', 'assert zlib.crc32(payload)&0xffffffff==struct.unpack', 'assert True or zlib.crc32(payload)&0xffffffff==struct.unpack'],
    ['failure capture dimensions', 'width*height<=16777216', 'width*height<=999999999'],
    ['failure capture best effort', "python3 - <<'PY_FAILURE' || true", "python3 - <<'PY_FAILURE'"],
    ['failure capture budget', 'assert len(data)+4096<=remaining', 'assert True'],
    ['failure must not make native success', "'nativeFailureUnchanged':True", "'nativeFailureUnchanged':False"],
    ['native status gate', '          test "$instrumentation_status" -eq 0\n', '          true\n'],
    ['unqualified validator', "result['outcome']=='observer-abi-unintegrated'", "result['outcome']=='qualified'"],
    ...['candidatePublished', 'startupFaultInjected', 'appProcessInstrumented', 'runtimePublished', 'hostedAdmission', 'fullQualification', 'observerAbiIntegrated'].map((key) => [key, `'${key}':False`, `'${key}':True`]),
    ['candidate label', "'artifactChannel':'unpublished-candidate114'", "'artifactChannel':'published'"],
  ];
  for (const [name, before, after] of mutations) {
    await t.test(name, () => assert.throws(() => contract(mutate(workflow, before, after))));
  }
  await t.test('immutable public workflow', () => assert.throws(() => contract(workflow, publicWorkflow + '\n')));
  await t.test('immutable Java driver', () => assert.throws(() => contract(workflow, publicWorkflow, driver + '\n')));
});


test('failure screenshot validator accepts bounded PNG and rejects damaged or over-budget captures', () => {
  const block = section(workflow, "            FAILURE_CAPTURE=", "          PY_FAILURE\n");
  const body = block.slice(block.indexOf("\n") + 1).split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const fixture = `
import json, os, pathlib, struct, subprocess, sys, tempfile, zlib
body = sys.stdin.read()
def chunk(kind, value):
    payload = kind + value
    return struct.pack('>I', len(value)) + payload + struct.pack('>I', zlib.crc32(payload) & 0xffffffff)
png = b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\\0\\0\\0\\0\\0')) + chunk(b'IEND', b'')
with tempfile.TemporaryDirectory(prefix='failure-contract-') as temp:
    root = pathlib.Path(temp)
    for name, data, retained, status, expected in [
        ('valid', png, 0, '0', True),
        ('crc', png[:-1] + bytes([png[-1] ^ 1]), 0, '0', False),
        ('truncated', png[:-1], 0, '0', False),
        ('oversize', png + bytes(8388609), 0, '0', False),
        ('budget', png, 42*1024*1024-4096, '0', False),
        ('capture-status', png, 0, '1', False),
    ]:
        case = root/name
        case.mkdir()
        evidence = case/'evidence'
        evidence.mkdir()
        if retained:
            with (evidence/'retained').open('wb') as f: f.truncate(retained)
        capture = case/'capture.png'
        capture.write_bytes(data)
        env = dict(os.environ, EVIDENCE=str(evidence), FAILURE_CAPTURE=str(capture), CAPTURE_STATUS=status)
        result = subprocess.run([sys.executable, '-I', '-B', '-c', body], env=env, capture_output=True)
        assert result.returncode == 0, (name, result.stderr)
        receipt = json.loads((evidence/'failure-capture.json').read_text())
        assert receipt['screenshotCaptured'] is expected, name
        assert receipt['nativeFailureUnchanged'] is True and receipt['fullQualification'] is False
        assert (evidence/'failure-owned-emulator.png').exists() is expected, name
`;
  const result = spawnSync('python3', ['-I', '-B', '-c', fixture], { input: body, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});


test('failure capture filesystem exception reaches the still-failing native gate', () => {
  const start = '          # BEGIN OWNED FAILURE SCREENSHOT\n';
  const end = '          # END OWNED FAILURE SCREENSHOT\n';
  const block = (section(workflow, start, end) + end)
    .split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const script = `set -euo pipefail
native_test_ok=false
instrumentation_status=1
adb_cmd=(adb)
timeout() { return 0; }
${block}
printf 'NATIVE_GATE_REACHED\n'
test "$instrumentation_status" -eq 0
printf 'INCORRECT_SUCCESS\n'
`;
  const temp = mkdtempSync(join(process.env.TMPDIR, 'failure-shell-contract-'));
  try {
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, RUNNER_TEMP: temp, EVIDENCE: join(temp, 'nonexistent-evidence') },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /FileNotFoundError/);
    assert.match(result.stdout, /NATIVE_GATE_REACHED/);
    assert.doesNotMatch(result.stdout, /INCORRECT_SUCCESS/);
  } finally {
    rmSync(temp, { recursive: true });
  }
});
