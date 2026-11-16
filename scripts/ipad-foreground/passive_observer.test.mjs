// Hosted tests only. These do not qualify native playback or simulator isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { allowedCollectorRequest, createRecorder, fingerprintAssets, injectObserver, installObserverRoutes,
  MAX_BODY_BYTES, MAX_RECORDS, OBSERVER_SCRIPT, SCRIPT_PATH, validObservation } from './passive_observer.mjs';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const fastify = require('fastify');
const origin = 'http://127.0.0.1:43120';
const mediaOrigin = 'http://127.0.0.1:43121';
const headers = { host: '127.0.0.1:43120', origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
const good = () => ({ at: 123, bufferAhead: 6, currentTime: 12, document: 'ab'.repeat(16), event: 'firstframe',
  frameMediaTime: 12, frames: 350, hidden: false, paused: false, ready: true, readyState: 4, rootReady: true, rvfc: true,
  seeking: false, sourceLocal: true, sourceOrdinal: 1, videoCount: 1, videoOrdinal: 1 });

function temp(t) {
  const path = mkdtempSync(join(tmpdir(), 'ipad-observer-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('schema admits bounded observation and rejects malformed or additional data', () => {
  assert.equal(validObservation(good()), true);
  for (const update of [
    { privateUrl: 'https://example.invalid/' }, { document: 'bad' }, { event: 'fabricated' },
    { at: NaN }, { frames: -1 }, { frames: 1.5 }, { currentTime: Infinity }, { bufferAhead: -1 },
    { videoCount: 65 }, { sourceOrdinal: 1025 }, { readyState: 5 }, { paused: 0 },
    { videoOrdinal: 0 }, { sourceLocal: 'true' },
  ]) assert.equal(validObservation({ ...good(), ...update }), false, JSON.stringify(update));
  const missing = good(); delete missing.currentTime;
  assert.equal(validObservation(missing), false);
  assert.equal(validObservation(null), false);
  assert.equal(validObservation([]), false);
});

test('collector rejects foreign origin, host, content type and cross-site browser requests', () => {
  assert.equal(allowedCollectorRequest(headers, origin), true);
  for (const update of [
    { origin: 'http://localhost:43120' }, { origin: 'http://example.invalid' },
    { host: 'localhost:43120' }, { host: '127.0.0.1:43121' },
    { 'content-type': 'text/plain' }, { 'sec-fetch-site': 'cross-site' },
  ]) assert.equal(allowedCollectorRequest({ ...headers, ...update }, origin), false);
});

test('injection only changes HTML and observer contains no media mutations or heartbeat', () => {
  const input = '<html><head><script type="module" src="/assets/app.js"></script></head></html>';
  assert.equal(injectObserver(input), input.replace('<head>', `<head>\n<script defer src="${SCRIPT_PATH}"></script>`));
  assert.throws(() => injectObserver('<html></html>'));
  assert.throws(() => injectObserver(injectObserver(input)));
  assert.doesNotMatch(OBSERVER_SCRIPT, /\bsetInterval\s*\(|\bsetTimeout\s*\(|\.play\s*\(|\.pause\s*\(|\.currentTime\s*=|\.src\s*=/);
  assert.match(OBSERVER_SCRIPT, /requestVideoFrameCallback/);
  assert.match(OBSERVER_SCRIPT, /observe\('firstframe'/);
});

test('native-event simulation coalesces timeupdate, retains media events, and stops at disconnect and cap', () => {
  const listeners = new Map();
  const posts = [];
  let now = 1000, pendingFrame;
  class Video {
    isConnected = true;
    currentSrc = `${origin}/api/stream/test`;
    currentTime = 1;
    readyState = 4;
    paused = false;
    seeking = false;
    buffered = { length: 1, start: () => 0, end: () => 30 };
    requestVideoFrameCallback(callback) { pendingFrame = callback; }
  }
  const video = new Video();
  const document = {
    hidden: false, readyState: 'complete',
    getElementById: () => ({ children: [1] }),
    querySelector: () => video.isConnected ? video : null,
    querySelectorAll: () => video.isConnected ? [video] : [],
    addEventListener: (name, callback) => listeners.set(name, callback),
  };
  const globals = {
    document, HTMLVideoElement: Video, URL, location: { origin },
    window: { addEventListener() {} }, performance: { now: () => now },
    crypto: { getRandomValues: array => array.fill(1) },
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: (_url, options) => { posts.push(JSON.parse(options.body)); return Promise.resolve(); },
  };
  runInNewContext(OBSERVER_SCRIPT, globals);
  const dispatch = event => listeners.get(event)({ target: video });
  dispatch('loadeddata');
  pendingFrame(now, { presentedFrames: 10, mediaTime: 1 });
  dispatch('timeupdate');
  now += 300;
  dispatch('timeupdate');
  dispatch('waiting'); // Not suppressed by the timeupdate coalescer.
  now += 700;
  video.currentTime = 2;
  pendingFrame(now, { presentedFrames: 35, mediaTime: 2 });
  dispatch('timeupdate');
  const samples = posts.filter(v => v.event === 'timeupdate');
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map(v => [v.currentTime, v.frames]), [[1, 10], [2, 35]]);
  assert.equal(posts.filter(v => v.event === 'waiting').length, 1);
  assert.ok(posts.every(validObservation));
  video.isConnected = false;
  const beforeDisconnect = posts.length;
  now += 1000;
  dispatch('timeupdate');
  pendingFrame(now, { presentedFrames: 36, mediaTime: 2.1 });
  assert.equal(posts.length, beforeDisconnect);
  video.isConnected = true;
  for (let i = 0; i < 4100; i++) { now += 1000; dispatch('timeupdate'); }
  assert.equal(posts.length, 4096);
  assert.equal(posts.at(-1).event, 'observer-limit');
  dispatch('pause');
  assert.equal(posts.length, 4096);
});

test('asset fingerprint ignores index only, detects changes, and refuses links', t => {
  const path = temp(t);
  writeFileSync(join(path, 'index.html'), 'original');
  writeFileSync(join(path, 'app.js'), 'production');
  const original = fingerprintAssets(path);
  writeFileSync(join(path, 'index.html'), 'injected');
  assert.deepEqual(fingerprintAssets(path), original);
  writeFileSync(join(path, 'app.js'), 'changed');
  assert.notEqual(fingerprintAssets(path).sha256, original.sha256);
  symlinkSync('app.js', join(path, 'link.js'));
  assert.throws(() => fingerprintAssets(path), /SYMLINK_REFUSED/);
});

test('actual Fastify collector accepts same-origin observations and rejects bad bodies', async t => {
  const path = temp(t);
  const app = fastify();
  const recorder = createRecorder(path, origin, mediaOrigin);
  installObserverRoutes(app, recorder);
  t.after(() => app.close());
  const request = (body, h = headers) => app.inject({ method: 'POST', url: '/__ipadqa/observe', headers: h, payload: body });
  assert.equal((await request(good())).statusCode, 204);
  const linesBefore = readFileSync(join(path, 'ipad-observations.jsonl'), 'utf8').trim().split('\n');
  assert.equal(linesBefore.length, 1);
  assert.deepEqual(JSON.parse(linesBefore[0]).observation, good());
  assert.equal((await request({ ...good(), currentTime: '12' })).statusCode, 400);
  assert.equal((await request({ ...good(), secret: 'do-not-record' })).statusCode, 400);
  assert.equal((await request(good(), { ...headers, origin: 'http://example.invalid' })).statusCode, 403);
  assert.equal((await request({ ...good(), padding: 'x'.repeat(MAX_BODY_BYTES) })).statusCode, 413);
  assert.equal(readFileSync(join(path, 'ipad-observations.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.equal((await app.inject({ method: 'GET', url: SCRIPT_PATH })).statusCode, 200);
});

test('producer and HLS request attribution are sanitized and correlate the actual generation', t => {
  const path = temp(t);
  const recorder = createRecorder(path, origin, mediaOrigin);
  const gen = 'transcode-Ab123';
  const args = ['-i', `${mediaOrigin}/media/synthetic.mp4`, '-c:v:0', 'libx264', '-f', 'hls', '-hls_time', '6',
    '-hls_playlist_type', 'event', '-var_stream_map', 'v:0,a:0,name:480p', `/private/${gen}/%v.m3u8`];
  assert.equal(recorder.producerStart(args), 1);
  recorder.response({ method: 'GET', raw: { url: `/api/stream/private-session/480p_seg_00001.ts?generation=${gen}&token=do-not-record` } },
    { statusCode: 200, getHeader() { return undefined; } });
  const data = readFileSync(join(path, 'ipad-observations.jsonl'), 'utf8');
  assert.doesNotMatch(data, /private-session|do-not-record|synthetic\.mp4|\/private\//);
  const [producer, response] = data.trim().split('\n').map(JSON.parse);
  assert.equal(producer.generation, response.generation);
  assert.equal(producer.fixed480, true);
  assert.equal(producer.inputLocal, true);
  assert.equal(producer.eventPlaylist, true);
  assert.equal(producer.segmentSeconds, 6);
  assert.equal(response.segment, 1);
  assert.deepEqual(readdirSync(path), ['ipad-observations.jsonl']);
});

test('recorder refuses overflow rather than silently truncating evidence', t => {
  const path = temp(t);
  const recorder = createRecorder(path, origin, mediaOrigin);
  for (let i = 0; i < MAX_RECORDS; i++) assert.equal(recorder.append('test', {}), true);
  assert.equal(recorder.append('test', {}), false);
  assert.equal(recorder.failed, true);
  assert.equal(readFileSync(join(path, 'ipad-observer-refused'), 'utf8'), 'COLLECTOR_LIMIT\n');
  assert.equal(recorder.append('test', {}), false);
});

test('dormant fixture requires explicit mode, preserves production spawn and held-segment hook', () => {
  const fixture = readFileSync(new URL('../android_external_player_server_fixture.mts', import.meta.url), 'utf8');
  assert.match(fixture, /if \(fixtureCLI\.ipadForeground\) \{\s*ipadObserver = await import\("\.\/ipad-foreground\/passive_observer\.mjs"\)/);
  assert.match(fixture, /if \(ipadForeground && !foregroundLong\)/);
  assert.match(fixture, /realTranscoder\.spawnHls\(args\)/);
  assert.match(fixture, /hold-segments/);
  assert.match(fixture, /segment-held/);
});
