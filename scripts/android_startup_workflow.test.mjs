import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(process.env.ANDROID_STARTUP_CI_WORKFLOW ?? new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const title = 'Require Android startup construction and bootstrap behavior';
const files = [
  'scripts/android_async_startup.test.mjs',
  'scripts/android_fullscreen.test.mjs',
  'scripts/android_gesture_insets.test.mjs',
  'scripts/android_ime.test.mjs',
  'scripts/android_startup_runtime_vendor.test.mjs',
  'scripts/android_webview_startup_policy.test.mjs',
  'scripts/patch_tauri_android.test.mjs',
  'scripts/patch_tauri_android_cold_recovery.test.mjs',
  'scripts/patch_tauri_android_webview_compat.test.mjs',
  'scripts/android_creation_completion.test.mjs',
  'scripts/android_startup_bootstrap.test.mjs',
  'scripts/android_startup_workflow.test.mjs',
  'scripts/android_owned_window_destroy.test.mjs',
  'scripts/android_owned_window_destroy_kotlin.test.mjs',
  'scripts/android_owned_destroy_instrumentation_contract.test.mjs',
];
const requiredFlags = [
  'YAWF_REQUIRE_ANDROID_STARTUP_BEHAVIOR',
  'YAWF_REQUIRE_ANDROID_FULLSCREEN_BEHAVIOR',
  'YAWF_REQUIRE_ANDROID_GESTURE_BEHAVIOR',
  'YAWF_REQUIRE_ANDROID_IME_BEHAVIOR',
];

function job(source) {
  const header = '\n  tauri-android:\n';
  assert.equal(source.split(header).length, 2, 'one actual Android compile job');
  return source.slice(source.indexOf(header) + header.length).split(/\n  [a-z][\w-]*:\n/)[0];
}
function gate(source) {
  const body = job(source), marker = `      - name: ${title}\n`;
  assert.equal(body.split(marker).length, 2, 'mandatory gate belongs to Android compile job');
  return marker + body.slice(body.indexOf(marker) + marker.length).split(/\n      - /)[0];
}
function validate(source) {
  const body = job(source), step = gate(source);
  const prefetch = body.indexOf('node scripts/prepare_android_kotlin_gradle.mjs');
  const rust = body.indexOf('cargo check --locked --target aarch64-linux-android');
  const kotlin = body.indexOf('      - name: Compile generated Android Kotlin\n');
  const startup = body.indexOf(`      - name: ${title}\n`);
  assert.ok(prefetch >= 0 && rust > prefetch && kotlin > rust && startup > kotlin, 'prefetch then actual Rust/Kotlin compilation before startup host behavior');
  assert.doesNotMatch(body, /^    (?:if|continue-on-error):/m);
  assert.doesNotMatch(step, /^        (?:if|continue-on-error|working-directory):/m);
  for (const flag of requiredFlags) {
    assert.equal(step.split(`          ${flag}:`).length, 2, `one mandatory ${flag}`);
    assert.match(step, new RegExp(`^          ${flag}: ["']1["']$`, 'm'));
  }
  assert.match(step, /^          RUSTC: rustc$/m, 'Rust compiler comes from installed PATH, not a workstation');
  const run = step.split('        run: |\n');
  assert.equal(run.length, 2);
  const command = run[1].split('\n').filter((line) => line.trim()).map((line) => {
    assert.match(line, /^          /); return line.trim();
  }).join('\n').replace(/\\\n/g, ' ').trim().split(/\s+/);
  assert.deepEqual(command, ['node', '--test', '--test-concurrency=1', ...files]);
}

test('mandatory startup gate uses the prepared Android compile job after generated Kotlin', () => validate(workflow));

test('startup gate rejects a missing, wrong-job or prematurely ordered step', () => {
  const original = gate(workflow);
  const without = workflow.replace(original, '');
  const beforeKotlin = without.replace('      - name: Compile generated Android Kotlin\n', original + '\n      - name: Compile generated Android Kotlin\n');
  const wrongJob = without + '\n  unrelated-startup:\n    runs-on: ubuntu-24.04\n    steps:\n' + original;
  for (const changed of [without, beforeKotlin, wrongJob]) {
    assert.notEqual(changed, workflow); assert.throws(() => validate(changed));
  }
});

test('startup gate refuses optional toolchains, platform paths and missing behavior cases', () => {
  const original = gate(workflow);
  const mutations = [
    ...requiredFlags.flatMap((flag) => [
      original.replace(`${flag}: "1"`, `${flag}: "0"`),
      original.replace(`          ${flag}: "1"\n`, ''),
      original.replace(`          ${flag}: "1"\n`, `          ${flag}: "1"\n          ${flag}: "1"\n`),
    ]),
    original.replace('RUSTC: rustc', 'RUSTC: /opt/homebrew/bin/rustc'),
    original.replace('        env:\n', '        continue-on-error: true\n        env:\n'),
    original.replace('        env:\n', '        if: false\n        env:\n'),
    original.replace('--test-concurrency=1 ', ''),
    ...files.map((file) => original.replace(file, '')),
  ];
  for (const replacement of mutations) {
    assert.notEqual(replacement, original); assert.throws(() => validate(workflow.replace(original, replacement)));
  }
});
