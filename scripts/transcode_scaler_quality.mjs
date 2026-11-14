// Local-file-only visual tradeoff probe. It does not benchmark a server or
// establish the provenance of a caller-supplied source frame.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const options = Object.fromEntries(process.argv.slice(2).reduce((rows, value, index, args) => {
  if (index % 2 === 0) rows.push([value, args[index + 1]]);
  return rows;
}, []));
assert.deepEqual(Object.keys(options).sort(), ['--input', '--out']);
const input = options['--input'], out = options['--out'];
assert.ok(isAbsolute(input) && isAbsolute(out), 'Use absolute local paths');
assert.ok(lstatSync(input).isFile() && !lstatSync(input).isSymbolicLink(), 'Input must be a local regular source frame');
assert.ok(!existsSync(out), 'Fresh output directory required');
mkdirSync(out, {recursive: true});
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {build} = await import(pathToFileURL(join(root, 'server/node_modules/esbuild/lib/main.js')));
const bundle = join(out, 'actual-hls-args.mjs');
await build({entryPoints: [join(root, 'server/src/transcodeSession.ts')], bundle: true,
  platform: 'node', format: 'esm', outfile: bundle, logLevel: 'error'});
const {hlsArgs} = await import(pathToFileURL(bundle));
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const run = args => execFileSync(ffmpeg, args, {encoding: 'utf8', timeout: 30_000,
  maxBuffer: 2_000_000, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, TMPDIR: out}});
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const rows = [];
for (const height of [480, 360]) {
  const quality = `${height}p`;
  const args = hlsArgs(input, out, {quality, includeAudio: false});
  // Strip only the frame-rate stage from the actual generated graph: this
  // probe isolates pixel resampling of one already-selected source frame.
  const filter = args[args.indexOf('-vf') + 1].replace(/^fps=fps='[^']+',/, '');
  assert.ok(filter.startsWith('scale=') && filter.includes(':flags=fast_bilinear'));
  const reference = filter.replace(':flags=fast_bilinear', '');
  const ref = join(out, `${quality}-bicubic.png`), candidate = join(out, `${quality}-fast-bilinear.png`);
  for (const [path, graph] of [[ref, reference], [candidate, filter]]) {
    run(['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', input, '-vf', graph,
      '-frames:v', '1', '-threads:v', '1', path]);
  }
  const stats = run(['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', ref, '-i', candidate,
    '-lavfi', 'ssim=stats_file=-', '-f', 'null', '-']);
  const match = /All:([\d.]+)/.exec(stats);
  assert.ok(match, 'Actual FFmpeg SSIM receipt required');
  const contact = join(out, `${quality}-reference-left-fast-right.png`);
  run(['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', ref, '-i', candidate,
    '-filter_complex', '[0:v][1:v]hstack=inputs=2', '-frames:v', '1', '-threads:v', '1', contact]);
  rows.push({quality, referenceFilter: reference, candidateFilter: filter, ssimAgainstBicubic: Number(match[1]),
    referenceSha256: hash(ref), candidateSha256: hash(candidate), contactSheet: contact, contactSheetSha256: hash(contact)});
}
const result = {scope: 'Real FFmpeg pixel comparisons on one caller-supplied local source frame. SSIM is relative to bicubic, not a perceptual quality acceptance threshold or performance proof.',
  inputSha256: hash(input), sourceSha256: hash(join(root, 'server/src/transcodeSession.ts')),
  ffmpeg: run(['-version']).split('\n')[0], contactSheetOrder: 'bicubic left, fast_bilinear right', rows};
writeFileSync(join(out, 'SCALER-QUALITY.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
