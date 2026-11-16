import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFixtureMediaPlan, validMkvFixtureOptions, validateMkvProbe, parseStreamHashes } from './foreground_fixture_media_plan.mjs';

const options = { foregroundLong: true, videoFilter: 'filter', moviePath: '/owned/synthetic.mp4', mkvPath: '/owned/synthetic.mkv', segmentPattern: '/owned/segment%03d.ts', playlistPath: '/owned/index.m3u8' };
const validProbe = { format: { format_name: 'matroska,webm', duration: '600.021' }, streams: [
  { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1280, height: 720, r_frame_rate: '30/1' },
  { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000' },
] };

test('MKV opt-in is explicit, long and observer-only', () => {
  assert.equal(validMkvFixtureOptions({ sourceMkv: true, foregroundLong: true, ipadForeground: true }), true);
  assert.equal(validMkvFixtureOptions({ sourceMkv: true, foregroundLong: false, ipadForeground: true }), false);
  assert.equal(validMkvFixtureOptions({ sourceMkv: true, foregroundLong: true, ipadForeground: false }), false);
  assert.equal(validMkvFixtureOptions({ sourceMkv: false, foregroundLong: false, ipadForeground: false }), true);
  const normal = buildFixtureMediaPlan(options), mkv = buildFixtureMediaPlan({ ...options, sourceMkv: true });
  assert.deepEqual(mkv.slice(0, 4), normal.slice(0, 4));
  assert.deepEqual(mkv[5], normal[5]);
  const cappedLongArgs = [...normal[4].args];
  cappedLongArgs.splice(cappedLongArgs.length - 1, 0, '-fs', String(512 * 1024 * 1024));
  assert.deepEqual(mkv[4].args, cappedLongArgs);
  assert.deepEqual(mkv.slice(-2).map(x => [x.kind, x.stage]), [['ffmpeg', 'media-output-check'], ['mkv-verify', 'media-output-check']]);
  assert.deepEqual(mkv.at(-2).args, ['-i', options.moviePath, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-fs', String(512 * 1024 * 1024), '-f', 'matroska', options.mkvPath]);
  assert.throws(() => buildFixtureMediaPlan({ ...options, sourceMkv: true, foregroundLong: false }));
  assert.throws(() => buildFixtureMediaPlan({ ...options, sourceMkv: true, mkvPath: options.moviePath }));
});

test('format, codec, duration, stream count and bounded size are independently required', () => {
  assert.equal(validateMkvProbe(validProbe, 1234), true);
  for (const mutate of [
    p => p.format.format_name = 'mov,mp4', p => p.format.duration = '598', p => p.format.duration = 'NaN',
    p => p.streams[0].codec_name = 'hevc', p => p.streams[1].codec_name = 'opus',
    p => p.streams[0].width = 640, p => p.streams.push(p.streams[0]),
  ]) { const p = structuredClone(validProbe); mutate(p); assert.equal(validateMkvProbe(p, 1234), false); }
  assert.equal(validateMkvProbe(validProbe, 0), false);
  assert.equal(validateMkvProbe(validProbe, 512 * 1024 * 1024 + 1), false);
});

test('encoded-packet hashes are strict, ordered, bounded and independent', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  const text = `0,v,SHA256=${a}\n1,a,SHA256=${b}\n`;
  assert.deepEqual(parseStreamHashes(text), [a, b]);
  for (const invalid of [text.replace('0,v', '0,a'), text.replace('1,a', '2,a'), text.replace(a, 'x'.repeat(64)), text + 'extra\n', 'x'.repeat(1025)]) assert.equal(parseStreamHashes(invalid), null);
});

test('real fixture connects selected source, strict probes and unchanged full/range checks', () => {
  const source = readFileSync(new URL('./android_external_player_server_fixture.mts', import.meta.url), 'utf8');
  for (const pattern of [
    /Duplicate --source-mkv/, /validMkvFixtureOptions\(\{ sourceMkv, foregroundLong, ipadForeground \}\)/,
    /fixtureCLI\.sourceMkv \? MKV_PATH : MOVIE_PATH/, /fixtureCLI\.sourceMkv \? "video\/x-matroska" : "video\/mp4"/,
    /path: PROVIDER_FILE,\s*bytes: statSync\(SELECTED_PATH\)\.size/, /resolved\.stream\.fileName !== basename\(PROVIDER_FILE\)/,
    /const expected = readFileSync\(SELECTED_PATH\)/, /full\.headers\["content-type"\] !== SELECTED_MIME/,
    /range\.headers\["content-type"\] !== SELECTED_MIME/, /externalRange\.headers\["content-type"\] !== SELECTED_MIME/,
    /validateMkvProbe\(probe, lstatSync\(MKV_PATH\)\.size\)/, /mp4\[0\] !== mkv\[0\] \|\| mp4\[1\] !== mkv\[1\]/,
    /"-c", "copy", "-f", "streamhash", "-hash", "sha256"/, /!info\.isFile\(\) \|\| info\.isSymbolicLink\(\)/,
  ]) assert.match(source, pattern);
});
