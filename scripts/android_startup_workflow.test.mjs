import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(process.env.ANDROID_STARTUP_CI_WORKFLOW ?? new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const title = 'Require Android startup construction and bootstrap behavior';
const files = [
  'scripts/android_async_startup.test.mjs',
  'scripts/android_startup_runtime_vendor.test.mjs',
  'scripts/android_webview_startup_policy.test.mjs',
  'scripts/android_creation_completion.test.mjs',
  'scripts/android_startup_bootstrap.test.mjs',
  'scripts/android_startup_workflow.test.mjs',
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
  assert.match(step, /^          YAWF_REQUIRE_ANDROID_STARTUP_BEHAVIOR: ["']1["']$/m);
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
    original.replace('YAWF_REQUIRE_ANDROID_STARTUP_BEHAVIOR: "1"', 'YAWF_REQUIRE_ANDROID_STARTUP_BEHAVIOR: "0"'),
    original.replace('          YAWF_REQUIRE_ANDROID_STARTUP_BEHAVIOR: "1"\n', ''),
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
