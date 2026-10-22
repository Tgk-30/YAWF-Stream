import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/android-current-runtime.yml', import.meta.url), 'utf8');
const start = workflow.indexOf('          collect_bounded_player_logcat() {');
assert.ok(start >= 0);
const match = workflow.slice(start).match(/\| python3 -c '\n([\s\S]*?)\n\s*' > "\$EVIDENCE\/player-logcat\.txt\.part"/);
assert.ok(match, 'actual workflow sanitizer must be executable');
const sanitizer = match[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');

function run(source, input, allowBoundedInputEpipe = false) {
  const result = spawnSync('python3', ['-c', source], {
    input, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  // Intentional input-bound termination can close stdin before the parent
  // finishes writing. Accept that only in explicit bound tests after exit0.
  if (!allowBoundedInputEpipe || result.error?.code !== 'EPIPE') {
    assert.equal(result.error, undefined);
  }
  return result.stdout;
}

const capability = '/api/external-stream/fixture-id/' + 'A'.repeat(40) + '/fixture.mp4';
const cases = [
  ['URL', 'MediaCodec https://example.invalid/stream?token=URL_ONLY_SENTINEL next\n', 'URL_ONLY_SENTINEL'],
  ['uppercase URL', 'MediaCodec HTTP://example.invalid/path?key=UPPER_ONLY_SENTINEL\n', 'UPPER_ONLY_SENTINEL'],
  ['authorization', 'MediaCodec Authorization: Bearer AUTH_ONLY_SENTINEL\n', 'AUTH_ONLY_SENTINEL'],
  ['proxy authorization', 'MediaCodec Proxy-Authorization: PROXY_ONLY_SENTINEL\n', 'PROXY_ONLY_SENTINEL'],
  ['cookie', 'MediaCodec Cookie: ds_session=COOKIE_ONLY_SENTINEL\n', 'COOKIE_ONLY_SENTINEL'],
  ['set-cookie', 'MediaCodec Set-Cookie: opaque=SET_ONLY_SENTINEL\n', 'SET_ONLY_SENTINEL'],
  ['bearer', 'MediaCodec bearer BEARER_ONLY_SENTINEL\n', 'BEARER_ONLY_SENTINEL'],
  ['session', 'MediaCodec ds_session=SESSION_ONLY_SENTINEL\n', 'SESSION_ONLY_SENTINEL'],
  ['csrf', 'MediaCodec ds_csrf=CSRF_ONLY_SENTINEL\n', 'CSRF_ONLY_SENTINEL'],
  ['capability', 'MediaCodec ' + capability + '\n', 'A'.repeat(40)],
];

function assertRedacted(source, input, secret) {
  const output = run(source, input);
  assert.ok(!output.includes(secret), 'sensitive synthetic sentinel survived');
  assert.ok(!/https?:\/\//i.test(output), 'URL survived');
  assert.ok(!output.includes('/api/external-stream/'), 'capability path survived');
  assert.ok(output.endsWith('\n'), 'redaction must preserve line termination');
  return output;
}

for (const [name, input, secret] of cases) {
  test('exact embedded sanitizer redacts ' + name, () => assertRedacted(sanitizer, input, secret));
}

test('ordinary diagnostics survive without sensitive content', () => {
  assert.equal(run(sanitizer, 'MediaCodec ready: 640x360\nAudioTrack started\n'),
    'MediaCodec ready: 640x360\nAudioTrack started\n');
});

test('actual line and UTF8 byte bounds apply before persistence', () => {
  const lines = run(sanitizer, 'MediaCodec ready\n'.repeat(12_001), true);
  assert.equal(lines.split('\n').length - 1, 12_000);
  const bytes = run(sanitizer, ('MediaCodec ' + '🙂'.repeat(300) + '\n').repeat(12_000), true);
  assert.ok(Buffer.byteLength(bytes) <= 8 * 1024 * 1024);
  assert.ok(bytes.length > 0);
});

test('omitted URL redaction is rejected by executed sentinel control', () => {
  const mutant = sanitizer.replace('line=url.sub("[redacted-url]",line)', 'line=line');
  assert.notEqual(mutant, sanitizer);
  assert.throws(() => assertRedacted(mutant, cases[0][1], cases[0][2]));
});

test('double-escaped word boundaries are rejected by executed control', () => {
  const line = sanitizer.split('\n').find(value => value.startsWith('sensitive=re.compile('));
  assert.ok(line);
  const mutant = sanitizer.replace(line, line.replaceAll('\\b', '\\\\b'));
  assert.notEqual(mutant, sanitizer);
  assert.throws(() => assertRedacted(mutant, cases[2][1], cases[2][2]));
});

test('omitted capability redaction is rejected by executed control', () => {
  const mutant = sanitizer.replace('line=capability.sub("[redacted-capability]",line)', 'line=line');
  assert.notEqual(mutant, sanitizer);
  assert.throws(() => assertRedacted(mutant, cases[9][1], cases[9][2]));
});

test('sanitizer controls run in the actual external runtime gate', () => {
  assert.match(workflow, /node --test scripts\/android_external_player_workflow\.test\.mjs scripts\/android_external_logcat_redaction\.test\.mjs/);
});
