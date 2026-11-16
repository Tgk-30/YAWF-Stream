import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  assert.equal(sha256(java), '36122e1fa1fc54ab29bb1556f8b91a0940db6cbe4fb3aa28437d2a41e007c4bc');
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
  const candidateObservation = section(source, buildStart, summaryStart)
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
