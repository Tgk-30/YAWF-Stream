import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// This detector is shared by both the positive runs and the forced stall.
export function evaluateProgress(previous, current, stagnantSince, now) {
  if (current.paused || current.seeking || current.rate !== 1 || current.hidden || current.error) return { failure: 'invalid-player-state' };
  if (current.time + 0.25 < previous.time || current.time - previous.time > (now - previous.wall) / 1000 + 2) return { failure: 'seek-or-clock-jump' };
  if (!current.presented || !previous.presented || current.frames < previous.frames || current.presented.frames < previous.presented.frames || current.source !== previous.source) return { failure: 'frame-or-source-reset' };
  if (current.time > previous.time + 0.05 && current.frames > previous.frames && current.presented.frames > previous.presented.frames) stagnantSince = now;
  return { failure: now - stagnantSince >= 15_000 ? 'no-decoded-progress' : null, stagnantSince };
}

// Positive qualification is stricter than the shared stall watchdog.
export function validatePositiveWindow(first, samples, events, minimumMs) {
  if (!Number.isFinite(minimumMs) || minimumMs <= 0 || !first || !Array.isArray(samples) || samples.length === 0 || !Array.isArray(events)) return false;
  const invalidEvents = new Set(['waiting', 'playing', 'pause', 'seeking', 'seeked', 'ended', 'error', 'emptied', 'visibilitychange']);
  if (events.some((event) => !event || typeof event.type !== 'string' || !Number.isFinite(event.at) || invalidEvents.has(event.type))) return false;
  const all = [first, ...samples];
  for (let i = 0; i < all.length; i += 1) {
    const sample = all[i];
    if (!sample || !sample.presented || ![sample.wall, sample.time, sample.frames, sample.rate, sample.presented.frames, sample.presented.mediaTime].every(Number.isFinite) ||
        sample.paused !== false || sample.seeking !== false || sample.hidden !== false || sample.error != null || sample.rate !== 1 ||
        typeof sample.source !== 'string' || sample.source !== first.source) return false;
    if (i > 0 && (sample.wall <= all[i - 1].wall || sample.time < all[i - 1].time || sample.frames < all[i - 1].frames || sample.presented.frames < all[i - 1].presented.frames)) return false;
    if (Math.abs((sample.wall - first.wall) / 1000 - (sample.time - first.time)) > 2) return false;
  }
  const last = all.at(-1);
  return last.wall - first.wall >= minimumMs && last.time - first.time >= minimumMs / 1000 &&
    last.frames > first.frames && last.presented.frames > first.presented.frames;
}

const EVIDENCE_LIMIT = 32 * 1024 * 1024;
export function validateReceipts(mode, summary, cases, totalBytes) {
  if (!['admission', 'full'].includes(mode) || !Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > EVIDENCE_LIMIT || !summary || !cases) return false;
  const expected = mode === 'admission' ? ['admission'] : ['direct', 'hls', 'stall'];
  if (summary.mode !== mode || summary.status !== (mode === 'admission' ? 'admission-only' : 'passed') || summary.fullQualification !== (mode === 'full')) return false;
  if (Object.keys(cases).sort().join(',') !== expected.slice().sort().join(',')) return false;
  return expected.every((name) => cases[name] && cases[name].case === name && cases[name].fullQualification === false && cases[name].outcome === (mode === 'admission' ? 'admission-only' : 'passed'));
}

// Used by both the container cleanup and the host after docker wait.
export function validateEvidenceDirectory(directory, mode) {
  const expected = mode === 'admission' ? ['admission'] : mode === 'full' ? ['direct', 'hls', 'stall'] : null;
  if (!expected) return false;
  try {
    const allowed = new Set(['binding.txt', 'toolchain.txt', 'summary.json', ...expected.map((name) => `${name}.json`)]);
    const names = readdirSync(directory);
    if (names.length !== allowed.size || names.some((name) => !allowed.has(name))) return false;
    let total = 0;
    for (const name of names) {
      const info = lstatSync(`${directory}/${name}`);
      if (!info.isFile() || info.isSymbolicLink()) return false;
      total += info.size;
      if (total > EVIDENCE_LIMIT) return false;
    }
    const summary = JSON.parse(readFileSync(`${directory}/summary.json`, 'utf8'));
    const cases = Object.fromEntries(expected.map((name) => [name, JSON.parse(readFileSync(`${directory}/${name}.json`, 'utf8'))]));
    return validateReceipts(mode, summary, cases, total);
  } catch { return false; }
}

export function classifyResponse(path) {
  const match = /^\/api\/stream\/[^/]+\/(index\.m3u8|480p\.m3u8|480p_seg_\d{5}\.ts)$/.exec(path);
  if (match) return match[1];
  return /^\/api\/stream\/[^/]+$/.test(path) ? 'direct-proxy' : null;
}

const sha = (s) => createHash('sha256').update(s).digest('hex');
function boundedAppend(list, value, limit = 1200) { if (list.length >= limit) throw new Error('Evidence count exceeded'); list.push(value); }
function assert(condition, message) { if (!condition) throw new Error(message); }
async function sample(page) {
  const s = await page.locator('video').evaluate((v) => ({
    time: v.currentTime, frames: v.getVideoPlaybackQuality().totalVideoFrames,
    dropped: v.getVideoPlaybackQuality().droppedVideoFrames, paused: v.paused, seeking: v.seeking,
    rate: v.playbackRate, hidden: document.hidden, error: v.error?.code ?? null,
    duration: Number.isFinite(v.duration) ? v.duration : null,
    buffered: Array.from({ length: v.buffered.length }, (_, i) => [v.buffered.start(i), v.buffered.end(i)]),
    source: v.currentSrc, presented: window.__qaPresented?.get(v) ?? null, eventCount: window.__qaEvents.length,
  }));
  return { ...s, source: sha(s.source), wall: performance.now() };
}
async function waitForFixture(proc, log) {
  const end = Date.now() + 300_000;
  while (Date.now() < end) {
    if (proc.exitCode !== null) throw new Error('Fixture exited before readiness');
    if (existsSync(log) && readFileSync(log, 'utf8').includes('[fixture] READY server-mode-ui loopback')) return;
    await delay(1000);
  }
  throw new Error('Fixture readiness deadline');
}
function producer(runtimeDir) {
  const dirs = readdirSync(runtimeDir).filter((s) => /^transcode-/.test(s));
  return dirs.map((name) => {
    const dir = `${runtimeDir}/${name}`;
    const segments = readdirSync(dir).filter((s) => /^480p_seg_\d{5}\.ts$/.test(s)).sort();
    const playlist = existsSync(`${dir}/480p.m3u8`) ? readFileSync(`${dir}/480p.m3u8`, 'utf8') : null;
    if (playlist != null && playlist.length > 65536) throw new Error('Playlist evidence exceeds limit');
    return { generation: sha(name), count: segments.length, frontier: segments.at(-1) ?? null,
      playlistSha256: playlist == null ? null : sha(playlist),
      playlist: playlist == null ? null : playlist.split('\n').filter((line) => /^#EXT(?:INF|M3U|VERSION|X-TARGETDURATION|X-MEDIA-SEQUENCE|X-PLAYLIST-TYPE|X-ENDLIST)/.test(line) || /^480p_seg_\d{5}\.ts$/.test(line)).join('\n') };
  });
}
function realHlsProducer() {
  for (const pid of readdirSync('/proc').filter((s) => /^\d+$/.test(s))) {
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`).toString().split('\0');
      if (args[0]?.split('/').at(-1) === 'ffmpeg' && args.includes('-hls_playlist_type') && args.includes('event') && args.some((arg) => arg.startsWith('http://127.0.0.1:43121/media/'))) return true;
    } catch { /* A process can exit while observed. */ }
  }
  return false;
}
async function runCase(chromium, name, output) {
  const caseDir = `${output}/${name}`;
  mkdirSync(caseDir, { mode: 0o700 });
  const fixtureDir = `${caseDir}/fixture`;
  const fixtureLog = `${caseDir}/fixture-private.log`;
  let browser, proc, log, failure;
  const evidence = { case: name, fullQualification: false, samples: [], events: [], requests: [], producers: [], outcome: 'failed', phase: 'fixture-ready' };
  const failureCode = (error) => error?.name === 'TimeoutError' ? 'Timeout' : error instanceof Error ? 'Error' : 'other';
  try {
    log = (await import('node:fs')).openSync(fixtureLog, 'w', 0o600);
    proc = spawn(process.execPath, ['/repo/server/node_modules/tsx/dist/cli.mjs', '/repo/scripts/android_external_player_server_fixture.mts', '--repo', '/repo', '--output', fixtureDir, '--foreground-long'], { stdio: ['ignore', log, log], env: process.env });
    await waitForFixture(proc, fixtureLog);
    const runtimeDir = JSON.parse(readFileSync(`${fixtureDir}/foreground-runtime.json`, 'utf8')).runtimeDir;
    evidence.mediaProbe = JSON.parse(readFileSync(`${fixtureDir}/media-probe.json`, 'utf8'));
    const smoke = JSON.parse(readFileSync(`${fixtureDir}/smoke-result.json`, 'utf8'));
    evidence.mediaSha256 = smoke.mediaSha256;
    evidence.webIndexSha256 = smoke.webIndexSha256;
    assert(Number(evidence.mediaProbe.format.duration) >= 599 && smoke.mediaBytes < 1_073_741_824, 'Fixture media duration or size invalid');
    evidence.phase = 'browser-launch';
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    evidence.browserVersion = browser.version();
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.origin !== 'http://127.0.0.1:43120' && u.origin !== 'http://127.0.0.1:43121') return route.abort('blockedbyclient');
      return route.continue();
    });
    await context.routeWebSocket('**/*', (ws) => ws.close());
    const page = await context.newPage();
    const pendingResponses = new Set();
    page.on('response', (response) => {
      const task = (async () => {
      try {
        const u = new URL(response.url());
        const asset = classifyResponse(u.pathname);
        const request = response.request();
        if (asset === 'direct-proxy') { boundedAppend(evidence.requests, { at: performance.now(), method: request.method(), asset, status: response.status() }); return; }
        if (asset == null) return;
        const row = { at: performance.now(), method: request.method(), asset, status: response.status(), generation: u.searchParams.has('generation') ? sha(u.searchParams.get('generation')) : null };
        if (request.method() === 'GET' && response.status() === 200) {
          const body = await response.body();
          row.bytes = body.length; row.sha256 = sha(body);
          if (asset.endsWith('.m3u8')) {
            if (body.length > 65536) throw new Error('Manifest exceeds evidence limit');
            row.endlist = body.includes(Buffer.from('#EXT-X-ENDLIST'));
            row.sanitizedBody = body.toString('utf8').split('\n').map((line) => line.split('?')[0])
              .filter((line) => /^#EXT(?:INF|M3U|VERSION|X-TARGETDURATION|X-MEDIA-SEQUENCE|X-PLAYLIST-TYPE|X-ENDLIST|X-STREAM-INF)/.test(line) || /^(?:480p\.m3u8|480p_seg_\d{5}\.ts)$/.test(line)).join('\n');
          }
        }
        boundedAppend(evidence.requests, row);
      } catch { evidence.responseError = true; }
      })();
      pendingResponses.add(task);
      void task.finally(() => pendingResponses.delete(task));
    });
    await page.addInitScript(() => {
      window.__qaEvents = [];
      window.__qaPresented = new WeakMap();
      const watched = new WeakSet();
      document.addEventListener('playing', (event) => {
        const video = event.target;
        if (!(video instanceof HTMLVideoElement) || watched.has(video) || typeof video.requestVideoFrameCallback !== 'function') return;
        watched.add(video);
        const observe = (_now, metadata) => {
          window.__qaPresented.set(video, { frames: metadata.presentedFrames, mediaTime: metadata.mediaTime });
          video.requestVideoFrameCallback(observe);
        };
        video.requestVideoFrameCallback(observe);
      }, true);
      for (const type of ['playing', 'waiting', 'stalled', 'pause', 'seeking', 'seeked', 'ended', 'error', 'emptied', 'visibilitychange']) {
        document.addEventListener(type, (e) => { if (type === 'visibilitychange' || e.target instanceof HTMLVideoElement) { if (window.__qaEvents.length < 512) window.__qaEvents.push({ type, at: performance.now() }); } }, true);
      }
    });
    evidence.phase = 'login';
    await page.goto('http://127.0.0.1:43120/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByLabel('Username').fill('fixture-owner');
    await page.getByLabel('Password').fill('fixture-owner-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    evidence.phase = 'tour';
    const skipTour = page.getByRole('button', { name: 'Skip the tour' });
    if (await skipTour.isVisible()) await skipTour.click();
    evidence.phase = 'watchlist';
    await page.getByRole('button', { name: 'Watchlist', exact: true }).first().click({ timeout: 60_000 });
    await page.getByText('Synthetic Fixture Movie', { exact: true }).first().click();
    evidence.phase = 'source';
    await page.getByText('Synthetic Fixture Movie 2026 1080p WEB-DL x264', { exact: false }).last().click({ timeout: 60_000 });
    evidence.phase = 'video';
    await page.locator('video').waitFor({ state: 'visible', timeout: 60_000 });
    if (name !== 'direct') {
      evidence.phase = 'quality';
      await page.locator('video').hover();
      await page.getByRole('button', { name: 'Playback settings', exact: true }).click();
      await page.getByText('Streaming mode', { exact: true }).waitFor();
      await page.getByRole('button', { name: '480p', exact: true }).click();
      const quality = page.getByRole('button', { name: '480p', exact: true });
      const switchDeadline = Date.now() + 90_000;
      while (Date.now() < switchDeadline && await quality.getAttribute('aria-pressed') !== 'true') await delay(500);
      assert(await quality.getAttribute('aria-pressed') === 'true', 'Optimized quality not active');
      evidence.optimizedQuality = '480p';
    }
    evidence.phase = 'firstframe';
    const startDeadline = Date.now() + 90_000;
    let first;
    while (Date.now() < startDeadline) { first = await sample(page); if (!first.paused && first.frames > 0 && first.presented?.frames > 0 && first.time > 0) break; await delay(1000); }
    assert(first && !first.paused && first.frames > 0 && first.presented?.frames > 0 && first.time > 0, 'No decoded presentation');
    const eventStart = first.eventCount;
    if (name === 'stall') writeFileSync(`${fixtureDir}/hold-segments`, 'hold\n', { mode: 0o600 });
    evidence.first = first;
    evidence.phase = 'window';
    let previous = first, stagnantSince = first.wall, detected = null;
    const deadline = first.wall + (name === 'stall' ? 180_000 : name === 'admission' ? 90_000 : 540_000);
    while (performance.now() < deadline) {
      await delay(1000);
      const current = await sample(page);
      const result = evaluateProgress(previous, current, stagnantSince, current.wall);
      boundedAppend(evidence.samples, { ...current, source: current.source });
      if (name !== 'direct' && evidence.samples.length % 2 === 0) boundedAppend(evidence.producers, { at: current.wall, ffmpegHlsRunning: realHlsProducer(), jobs: producer(runtimeDir) }, 300);
      if (result.failure) { detected = result.failure; break; }
      stagnantSince = result.stagnantSince;
      previous = current;
      if (name !== 'stall' && current.wall - first.wall >= (name === 'admission' ? 15_000 : 480_000) && current.time - first.time >= (name === 'admission' ? 15 : 480) && current.frames > first.frames && current.presented?.frames > first.presented.frames) break;
    }
    evidence.phase = 'evidence';
    await Promise.race([Promise.all([...pendingResponses]), delay(10_000).then(() => { throw new Error('Response evidence deadline'); })]);
    const allEvents = await page.evaluate(() => window.__qaEvents);
    assert(allEvents.length < 512, 'Event limit exceeded');
    evidence.events = allEvents.slice(eventStart);
    evidence.detected = detected;
    evidence.segmentHeld = existsSync(`${fixtureDir}/segment-held`);
    assert(evidence.events.length < 512, 'Event limit exceeded');
    assert(!evidence.responseError, 'Response capture failed');
    if (name === 'stall') {
      assert(existsSync(`${fixtureDir}/segment-held`) && detected === 'no-decoded-progress', 'Forced network stall was not detected');
    } else {
      const minimumMs = name === 'admission' ? 15_000 : 480_000;
      assert(!detected && validatePositiveWindow(first, evidence.samples, evidence.events, minimumMs), 'Positive window rejected');
    }
    if (name === 'direct') {
      assert(evidence.requests.some((r) => r.asset === 'direct-proxy' && r.method === 'GET' && (r.status === 200 || r.status === 206)), 'Direct proxy response missing');
      assert(!evidence.requests.some((r) => r.asset === 'index.m3u8'), 'Direct case used HLS');
    }
    if (name !== 'direct') {
      const ok = evidence.requests.filter((r) => r.method === 'GET' && r.status === 200);
      assert(ok.some((r) => r.asset === 'index.m3u8') && ok.some((r) => r.asset === '480p.m3u8') && ok.some((r) => /^480p_seg_/.test(r.asset)), 'Production HLS requests missing');
      assert(evidence.producers.some((p) => p.ffmpegHlsRunning) && evidence.producers.some((p) => p.jobs.some((j) => j.count > 0)), 'Real ffmpeg HLS producer evidence missing');
      const generations = new Set(ok.filter((r) => r.asset !== 'index.m3u8').map((r) => r.generation));
      assert(generations.size === 1 && !generations.has(null), 'HLS generation changed');
    }
    evidence.outcome = name === 'admission' ? 'admission-only' : 'passed';
  } catch (error) {
    evidence.failureCode = failureCode(error);
    failure = error;
  } finally {
    const cleanup = async (operation) => {
      try { await operation(); } catch (error) {
        evidence.cleanupFailureCode = failureCode(error);
        if (!failure) { evidence.phase = 'cleanup'; evidence.failureCode = failureCode(error); evidence.outcome = 'failed'; failure = error; }
      }
    };
    await cleanup(async () => { if (browser) await browser.close(); });
    await cleanup(async () => {
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => proc.once('exit', resolve)), delay(10_000)]);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    });
    await cleanup(async () => { if (log != null) (await import('node:fs')).closeSync(log); });
    await cleanup(async () => { rmSync(fixtureDir, { recursive: true, force: true }); rmSync(fixtureLog, { force: true }); });
    writeFileSync(`${caseDir}/result.json`, JSON.stringify(evidence, null, 2));
  }
  if (failure) throw failure;
}
async function main() {
  const output = process.env.QA_OUTPUT;
  assert(output && output.startsWith('/qa/'), 'Owned QA_OUTPUT required');
  const mode = process.env.QA_MODE;
  assert(mode === 'admission' || mode === 'full', 'Explicit QA_MODE required');
  const summary = { mode, fullQualification: false, status: 'failed' };
  try {
    const { chromium } = await import('./foreground-playback/node_modules/playwright/index.mjs');
    for (const name of mode === 'admission' ? ['admission'] : ['direct', 'hls', 'stall']) await runCase(chromium, name, output);
    summary.fullQualification = mode === 'full';
    summary.status = mode === 'full' ? 'passed' : 'admission-only';
  } finally {
    writeFileSync(`${output}/summary.json`, JSON.stringify(summary, null, 2));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--validate-evidence') {
    if (process.argv.length !== 5 || !validateEvidenceDirectory(process.argv[3], process.argv[4])) process.exitCode = 1;
  } else await main();
}
