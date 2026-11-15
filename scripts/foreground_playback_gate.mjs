import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, rmSync, writeFileSync } from 'node:fs';
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
  if (sanitizePublicBrowserBootstrap(summary.publicBrowserBootstrap)?.outcome !== 'passed') return false;
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

const FAILURE_JPEG_LIMIT = 512 * 1024;
const UI_STATE_KEYS = ['dialogCount', 'inputCount', 'ready', 'skipTourVisible', 'videoCount', 'watchlistButtonCount', 'watchlistVisible'];
const UI_MASK = 'input,textarea,select,code,pre,[contenteditable],[role="textbox"],iframe,[data-private],[data-sensitive],[class*="password" i],[class*="token" i],[class*="secret" i],[class*="credential" i],[id*="password" i],[id*="token" i],[name*="secret" i],[aria-label*="password" i],[aria-label*="token" i],[autocomplete]';

export function sanitizeUiFailureDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'schemaVersion,screenshot,state' || value.schemaVersion !== 1 ||
      !value.state || typeof value.state !== 'object' || Array.isArray(value.state) ||
      Object.keys(value.state).sort().join(',') !== UI_STATE_KEYS.join(',')) return null;
  for (const key of ['dialogCount', 'inputCount', 'videoCount', 'watchlistButtonCount']) {
    if (!Number.isSafeInteger(value.state[key]) || value.state[key] < 0 || value.state[key] > 99) return null;
  }
  for (const key of ['ready', 'skipTourVisible', 'watchlistVisible']) if (typeof value.state[key] !== 'boolean') return null;
  const shot = value.screenshot;
  if (shot !== null && (!shot || typeof shot !== 'object' || Array.isArray(shot) ||
      Object.keys(shot).sort().join(',') !== 'bytes,filename,sha256' || shot.filename !== 'failure.jpg' ||
      !Number.isSafeInteger(shot.bytes) || shot.bytes < 1 || shot.bytes > FAILURE_JPEG_LIMIT ||
      typeof shot.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(shot.sha256))) return null;
  return { schemaVersion: 1, state: { ...value.state }, screenshot: shot === null ? null : { ...shot } };
}

export function isBoundedViewportJpeg(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > FAILURE_JPEG_LIMIT ||
      bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return false;
  let pos = 2;
  let validFrame = false;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos++] !== 0xff) return false;
    while (bytes[pos] === 0xff) pos += 1;
    const marker = bytes[pos++];
    if (marker === 0xd9 || marker === undefined) return false;
    if (pos + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(pos);
    if (length < 2 || pos + length > bytes.length) return false;
    if (marker === 0xda) return validFrame && length >= 6 && pos + length < bytes.length - 2;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 11) return false;
      const components = bytes[pos + 7];
      if (![1, 3, 4].includes(components) || length !== 8 + 3 * components ||
          bytes.readUInt16BE(pos + 3) !== 720 || bytes.readUInt16BE(pos + 5) !== 1280) return false;
      validFrame = true;
    }
    pos += length;
  }
  return false;
}

export async function captureFailureUi(page, caseDir) {
  if (!page || page.isClosed() || new URL(page.url()).origin !== 'http://127.0.0.1:43120') return null;
  const viewport = page.viewportSize();
  if (!viewport || viewport.width !== 1280 || viewport.height !== 720) return null;
  const watchlist = page.getByRole('button', { name: 'Watchlist', exact: true });
  const skip = page.getByRole('button', { name: 'Skip the tour' });
  const count = async (locator) => Math.min(99, await locator.count());
  const state = {
    dialogCount: await count(page.getByRole('dialog')),
    inputCount: await count(page.locator('input,textarea,select')),
    ready: await page.evaluate(() => document.readyState === 'complete'),
    skipTourVisible: await skip.first().isVisible(),
    videoCount: await count(page.locator('video')),
    watchlistButtonCount: await count(watchlist),
    watchlistVisible: await watchlist.first().isVisible(),
  };
  let screenshot = null;
  try {
    const bytes = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: false, timeout: 5000, mask: [page.locator(UI_MASK)], maskColor: '#000000' });
    if (isBoundedViewportJpeg(bytes)) {
      screenshot = { filename: 'failure.jpg', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      if (!sanitizeUiFailureDiagnostic({ schemaVersion: 1, state, screenshot })) return null;
      writeFileSync(`${caseDir}/failure.jpg`, bytes, { flag: 'wx', mode: 0o600 });
    }
  } catch { screenshot = null; }
  return sanitizeUiFailureDiagnostic({ schemaVersion: 1, state, screenshot });
}

// Both files are read through no-follow descriptors and copied only for a failed case.
function readGuardedBytes(path, limit) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size < 1 || info.size > limit) return null;
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return null;
      offset += count;
    }
    return bytes;
  } catch { return null; }
  finally { if (fd != null) closeSync(fd); }
}

export function copyFailureScreenshot(caseDir, evidenceDir, name) {
  if (!['admission', 'direct', 'hls', 'stall'].includes(name)) return false;
  try {
    const receiptBytes = readGuardedBytes(`${caseDir}/result.json`, EVIDENCE_LIMIT);
    const bytes = readGuardedBytes(`${caseDir}/failure.jpg`, FAILURE_JPEG_LIMIT);
    if (!receiptBytes || !bytes) return false;
    const receipt = JSON.parse(receiptBytes.toString('utf8'));
    const diag = sanitizeUiFailureDiagnostic(receipt.uiDiagnostic);
    if (receipt.case !== name || receipt.outcome !== 'failed' || receipt.fullQualification !== false || !diag?.screenshot ||
        !isBoundedViewportJpeg(bytes) || diag.screenshot.bytes !== bytes.length ||
        diag.screenshot.sha256 !== createHash('sha256').update(bytes).digest('hex')) return false;
    let total = bytes.length + 512;
    for (const item of readdirSync(evidenceDir)) {
      const info = lstatSync(`${evidenceDir}/${item}`);
      if (!info.isFile() || info.isSymbolicLink()) return false;
      total += info.size;
      if (total > EVIDENCE_LIMIT) return false;
    }
    writeFileSync(`${evidenceDir}/failure-${name}.jpg`, bytes, { flag: 'wx', mode: 0o600 });
    return true;
  } catch { return false; }
}

export function classifyResponse(path) {
  const match = /^\/api\/stream\/[^/]+\/(index\.m3u8|480p\.m3u8|480p_seg_\d{5}\.ts)$/.exec(path);
  if (match) return match[1];
  return /^\/api\/stream\/[^/]+$/.test(path) ? 'direct-proxy' : null;
}

const PUBLIC_BOOTSTRAP_MESSAGE_LIMIT = 16 * 1024;
const PUBLIC_BROWSER_ENV = Object.freeze({
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/tmp', TMPDIR: '/qa/tmp',
  PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
});

export function sanitizePublicBrowserBootstrap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'errorMessage,fullQualification,messageTruncated,outcome,phase,schemaVersion,scope' ||
      value.schemaVersion !== 1 || value.scope !== 'public-browser-bootstrap-before-fixture' || value.fullQualification !== false ||
      typeof value.messageTruncated !== 'boolean') return null;
  if (value.outcome === 'passed' ? (value.phase !== 'complete' || value.errorMessage !== null || value.messageTruncated !== false) :
      value.outcome !== 'failed' || !['launch', 'close'].includes(value.phase) || typeof value.errorMessage !== 'string' ||
        Buffer.byteLength(value.errorMessage, 'utf8') > PUBLIC_BOOTSTRAP_MESSAGE_LIMIT) return null;
  return { schemaVersion: 1, scope: 'public-browser-bootstrap-before-fixture', fullQualification: false, outcome: value.outcome,
    phase: value.phase, errorMessage: value.errorMessage, messageTruncated: value.messageTruncated };
}

export async function runPublicBrowserBootstrap(chromium) {
  const report = { schemaVersion: 1, scope: 'public-browser-bootstrap-before-fixture', fullQualification: false,
    outcome: 'failed', phase: 'launch', errorMessage: null, messageTruncated: false };
  try {
    const browser = await chromium.launch({ headless: true, chromiumSandbox: true, env: { ...PUBLIC_BROWSER_ENV } });
    report.phase = 'close';
    await browser.close();
    report.phase = 'complete'; report.outcome = 'passed';
  } catch (error) {
    // Raw message permission is confined to this closed-environment, no-context,
    // pre-fixture control. Never read a stack or serialize an environment.
    let message = 'Public bootstrap error message unavailable';
    try { if (error instanceof Error && typeof error.message === 'string') message = error.message; } catch { }
    const bytes = Buffer.from(message.slice(0, PUBLIC_BOOTSTRAP_MESSAGE_LIMIT), 'utf8');
    let end = Math.min(bytes.length, PUBLIC_BOOTSTRAP_MESSAGE_LIMIT);
    while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    report.errorMessage = bytes.subarray(0, end).toString('utf8');
    report.messageTruncated = report.errorMessage !== message;
  }
  const safe = sanitizePublicBrowserBootstrap(report);
  if (!safe) throw new Error('Invalid public bootstrap report');
  return safe;
}

export async function runCasesAfterPublicBootstrap(chromium, mode, output, summary, executeCase = runCase) {
  summary.publicBrowserBootstrap = await runPublicBrowserBootstrap(chromium);
  if (summary.publicBrowserBootstrap.outcome !== 'passed') throw new Error('Public browser bootstrap failed before fixture');
  for (const name of mode === 'admission' ? ['admission'] : ['direct', 'hls', 'stall']) await executeCase(chromium, name, output);
}

// Actual-app browser diagnostics are categorical only. Never retain its exception or logs.
const BROWSER_LAUNCH_MESSAGE_LIMIT = 64 * 1024;
const BROWSER_LAUNCH_FACTS = [
  'namespace-denied', 'sandbox-unavailable', 'executable-missing', 'launch-enoent', 'dependency-missing',
  'process-exited', 'process-crashed', 'target-closed', 'timeout', 'public-cause-marker', 'unclassified',
];
const BROWSER_SIGNALS = [
  'SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGIO', 'SIGKILL',
  'SIGPIPE', 'SIGPOLL', 'SIGPROF', 'SIGPWR', 'SIGQUIT', 'SIGSEGV', 'SIGSTKFLT', 'SIGSTOP', 'SIGSYS', 'SIGTERM', 'SIGTRAP',
  'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGUSR1', 'SIGUSR2', 'SIGVTALRM', 'SIGWINCH', 'SIGXCPU', 'SIGXFSZ',
];
const BROWSER_CRASH_SIGNALS = ['SIGSEGV', 'SIGABRT', 'SIGILL', 'SIGTRAP', 'SIGBUS', 'SIGFPE', 'SIGSYS', 'SIGQUIT'];
const BROWSER_MARKERS = ['namespaceFailure', 'sandboxFailure', 'checkFailure', 'operationNotPermitted',
  'crashpadDatabaseRequired', 'crashpadDatabaseInitializationFailed', 'readOnlyFileSystem'];
const emptyBrowserMarkers = () => Object.fromEntries(BROWSER_MARKERS.map((name) => [name, false]));

function browserMarkerLines(text) {
  return text.split(/\r?\n/).map((line) => {
    // Public Chromium logger prefixes, both file.cc(line) and file.cc:line.
    const cpp = /^([ \t]*(?:-[ \t]+)?(?:\[pid=\d+\]\[err\][ \t]*)?)\[(?:\d{1,12}:){0,3}(?:\d{4}\/\d{6}\.\d{1,9}:)?(?:INFO|WARNING|ERROR|FATAL|VERBOSE\d):[A-Za-z0-9_./-]{1,200}(?:\(\d{1,8}\)|:\d{1,8})\][ \t]*/.exec(line);
    const normalized = cpp ? cpp[1] + line.slice(cpp[0].length) : line;
    return { normalized, body: normalized.replace(/^[ \t]*(?:-[ \t]+)?(?:\[pid=\d+\]\[err\][ \t]*)?/, ''),
      logged: cpp != null || /^[ \t]*(?:-[ \t]+)?\[pid=\d+\]\[err\]/.test(line) };
  });
}

export function sanitizeBrowserLaunchDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'exitCode,facts,markers,schemaVersion,signals' || value.schemaVersion !== 1 ||
      !Array.isArray(value.facts) || value.facts.length === 0 || value.facts.length > BROWSER_LAUNCH_FACTS.length ||
      value.facts.some((fact, index) => !BROWSER_LAUNCH_FACTS.includes(fact) || value.facts.indexOf(fact) !== index) ||
      (value.facts.includes('unclassified') && value.facts.length !== 1) ||
      (value.exitCode !== null && (!value.facts.includes('process-exited') || !Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255)) ||
      !Array.isArray(value.signals) || value.signals.length > BROWSER_SIGNALS.length ||
      value.signals.some((signal, index) => !BROWSER_SIGNALS.includes(signal) || value.signals.indexOf(signal) !== index) ||
      (value.signals.length > 0 && !value.facts.includes('process-exited')) ||
      value.facts.includes('process-crashed') !== value.signals.some((signal) => BROWSER_CRASH_SIGNALS.includes(signal)) ||
      !value.markers || typeof value.markers !== 'object' || Array.isArray(value.markers) ||
      Object.keys(value.markers).sort().join(',') !== [...BROWSER_MARKERS].sort().join(',') ||
      BROWSER_MARKERS.some((name) => typeof value.markers[name] !== 'boolean')) return null;
  return { schemaVersion: 1, facts: [...value.facts], exitCode: value.exitCode, signals: [...value.signals],
    markers: Object.fromEntries(BROWSER_MARKERS.map((name) => [name, value.markers[name]])) };
}

export function classifyBrowserLaunchFailure(error) {
  const fallback = { schemaVersion: 1, facts: ['unclassified'], exitCode: null, signals: [], markers: emptyBrowserMarkers() };
  try {
    if (!(error instanceof Error) || typeof error.message !== 'string' || Buffer.byteLength(error.message, 'utf8') > BROWSER_LAUNCH_MESSAGE_LIMIT) return fallback;
    const text = error.message;
    const lines = browserMarkerLines(text), markerText = lines.map((line) => line.normalized).join('\n');
    const markers = {
      namespaceFailure: lines.some(({ body }) => /^Failed to move to new (?:PID )?namespace:/i.test(body)),
      sandboxFailure: false,
      checkFailure: lines.some(({ body }) => /^Check failed:/i.test(body)),
      operationNotPermitted: lines.some(({ body, logged }) => (logged || /^(?:Failed to move to new |Check failed:|Operation not permitted\b|EPERM\b)/i.test(body)) &&
        /(?:^|[: \t])(?:Operation not permitted|EPERM)(?=[ \t:(,.)]|$)|\berrno[ \t]*=[ \t]*1\b/i.test(body)),
      crashpadDatabaseRequired: lines.some(({ body }) => /^(?:[^ \t]{1,256}\/)?(?:chrome_)?crashpad_handler:[ \t]*--database is required\b/.test(body)),
      crashpadDatabaseInitializationFailed: lines.some(({ body }) => /^Failed to initialize (?:a )?Crashpad database\b|^Failed to initialize database for Crashpad\b/i.test(body)),
      readOnlyFileSystem: lines.some(({ body, logged }) => (logged || /^(?:mkdir:|open:|Read-only file system\b|EROFS\b)/i.test(body)) &&
        /(?:^|[: \t])(?:Read-only file system|EROFS)(?=[ \t:(,.)]|$)/i.test(body)),
    };
    const facts = [];
    if (/^(?:[ \t]*-[ \t]+)?[ \t]*(?:\[pid=\d+\]\[err\][ \t]*)?Failed to move to new namespace:[^\r\n]{0,2048}(?:Operation not permitted|EPERM|errno[ \t]*=[ \t]*1\b)/mi.test(markerText)) facts.push('namespace-denied');
    if (lines.some(({ body }) => /^No usable sandbox!/i.test(body)) || /^[ \t]*(?:browserType\.launch:[ \t]*)?(?:[║|][ \t]*)?Chromium sandboxing failed!(?:[ \t]*[║|])?[ \t]*$/m.test(markerText)) facts.push('sandbox-unavailable');
    markers.sandboxFailure = facts.includes('sandbox-unavailable');
    if (/^browserType\.launch: Executable doesn't exist at\b/m.test(text)) facts.push('executable-missing');
    if (error.code === 'ENOENT') facts.push('launch-enoent');
    if (/Host system is missing dependencies to run browsers|error while loading shared libraries:/i.test(text)) facts.push('dependency-missing');
    const exits = [...text.matchAll(/^[ \t]*(?:-[ \t]+)?(?:\[pid=\d+\][ \t]*)?<process did exit: exitCode=(\d{1,3}|null), signal=(null|SIG[A-Z0-9]+)>/gm)];
    let exitCode = null;
    const signals = [...new Set(exits.map((match) => match[2]).filter((signal) => BROWSER_SIGNALS.includes(signal)))];
    if (exits.length) {
      facts.push('process-exited');
      const codes = exits.map((match) => match[1] === 'null' ? null : Number(match[1]));
      if (codes.every((code) => Number.isSafeInteger(code) && code >= 0 && code <= 255 && code === codes[0])) exitCode = codes[0];
      if (signals.some((signal) => BROWSER_CRASH_SIGNALS.includes(signal))) facts.push('process-crashed');
    }
    if (/^browserType\.launch: Target page, context or browser has been closed/m.test(text)) facts.push('target-closed');
    if (error.name === 'TimeoutError') facts.push('timeout');
    if (facts.length === 0) facts.push(BROWSER_MARKERS.some((name) => markers[name]) ? 'public-cause-marker' : 'unclassified');
    return sanitizeBrowserLaunchDiagnostic({ schemaVersion: 1, facts, exitCode, signals, markers }) ?? fallback;
  } catch { return fallback; }
}

export function parseKernelUsernsFlag(text) {
  return ['0', '1', '0\n', '1\n'].includes(text) ? Number(text[0]) : null;
}

function readKernelFlagText(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(descriptor).isFile()) return null;
    const buffer = Buffer.alloc(4);
    return buffer.subarray(0, readSync(descriptor, buffer, 0, buffer.length, 0)).toString('utf8');
  } catch { return null; }
  finally { if (descriptor != null) { try { closeSync(descriptor); } catch { /* No raw filesystem errors. */ } } }
}

export function sanitizeBrowserPrerequisiteDiagnostic(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report) ||
      Object.keys(report).sort().join(',') !== 'exitCode,kernelFlags,outcome,schemaVersion,scope,signal' ||
      report.schemaVersion !== 1 || report.scope !== 'user-pid-namespace-only' ||
      !['exited', 'signaled', 'spawn-error', 'timed-out', 'unobserved'].includes(report.outcome) ||
      !report.kernelFlags || typeof report.kernelFlags !== 'object' || Array.isArray(report.kernelFlags) ||
      Object.keys(report.kernelFlags).sort().join(',') !== 'apparmorRestrictUnprivilegedUserns,unprivilegedUsernsClone' ||
      Object.values(report.kernelFlags).some((flag) => flag !== null && flag !== 0 && flag !== 1)) return null;
  if (report.outcome === 'exited' ? (!Number.isSafeInteger(report.exitCode) || report.exitCode < 0 || report.exitCode > 255 || report.signal !== null) :
      report.outcome === 'signaled' ? (report.exitCode !== null || !BROWSER_SIGNALS.includes(report.signal)) :
      (report.exitCode !== null || report.signal !== null)) return null;
  return { schemaVersion: 1, scope: 'user-pid-namespace-only', outcome: report.outcome, exitCode: report.exitCode, signal: report.signal,
    kernelFlags: { unprivilegedUsernsClone: report.kernelFlags.unprivilegedUsernsClone,
      apparmorRestrictUnprivilegedUserns: report.kernelFlags.apparmorRestrictUnprivilegedUserns } };
}

// One failure-only prerequisite observation in the existing non-networked
// container. Its result neither establishes crash causality nor qualifies UI.
export function collectBrowserPrerequisites(spawnProbe = spawn, readFlag = readKernelFlagText) {
  const flag = (path) => { try { return parseKernelUsernsFlag(readFlag(path)); } catch { return null; } };
  const kernelFlags = {
    unprivilegedUsernsClone: flag('/proc/sys/kernel/unprivileged_userns_clone'),
    apparmorRestrictUnprivilegedUserns: flag('/proc/sys/kernel/apparmor_restrict_unprivileged_userns'),
  };
  return new Promise((resolve) => {
    let child, settled = false;
    const finish = (outcome, exitCode = null, signal = null) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const base = { schemaVersion: 1, scope: 'user-pid-namespace-only', kernelFlags };
      resolve(sanitizeBrowserPrerequisiteDiagnostic({ ...base, outcome, exitCode, signal }) ??
        { ...base, outcome: 'unobserved', exitCode: null, signal: null });
    };
    const timer = setTimeout(() => {
      finish('timed-out');
      try { child?.kill('SIGKILL'); } catch { /* Killing an exited owned probe needs no raw error. */ }
    }, 3_000);
    try {
      child = spawnProbe('/usr/bin/unshare', ['--user', '--map-root-user', '--pid', '--fork', '/usr/bin/true'], { stdio: 'ignore' });
      child.once('error', () => finish('spawn-error'));
      child.once('exit', (code, signal) => finish(code !== null ? 'exited' : 'signaled', code, signal));
    } catch { finish('spawn-error'); }
  });
}

const FIXTURE_STATUS_LIMIT = 2048;
const FIXTURE_PRIVATE_LOG_LIMIT = 64 * 1024;
const FIXTURE_STAGES = new Set([
  'input-check', 'media-preflight', 'mp4-generation', 'static-hls-generation', 'media-probe', 'media-output-check',
  'long-mp4-generation', 'long-media-probe',
  'runtime-init', 'media-listen', 'server-build', 'seed-owner', 'seed-credentials', 'seed-settings', 'seed-watchlist',
  'smoke-media', 'smoke-addon', 'smoke-outbound', 'smoke-login', 'smoke-bootstrap', 'smoke-watchlist',
  'smoke-discover', 'smoke-detail', 'smoke-streams', 'smoke-resolve', 'smoke-proxy-full', 'smoke-proxy-range',
  'smoke-external-full', 'smoke-external-range', 'smoke-web', 'smoke-receipt', 'server-listen', 'ready',
]);
const FIXTURE_FAILURES = new Set([
  'input-missing', 'input-invalid', 'ffmpeg-execution', 'ffmpeg-exit', 'ffmpeg-filter-missing', 'font-missing',
  'probe-execution', 'probe-exit', 'probe-json', 'probe-streams', 'probe-codecs', 'media-layout', 'media-file',
  'http-status', 'csrf-missing', 'smoke-assertion', 'json-response', 'unclassified-error',
]);

export function sanitizeFixtureDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'childExitCode,failureCode,schemaVersion,stage,status' ||
      value.schemaVersion !== 1 || !FIXTURE_STAGES.has(value.stage) ||
      !['running', 'refused', 'ready'].includes(value.status)) return null;
  if (value.status === 'refused') {
    if (!FIXTURE_FAILURES.has(value.failureCode) ||
        (value.childExitCode !== null && (!['ffmpeg-exit', 'probe-exit'].includes(value.failureCode) ||
          !Number.isSafeInteger(value.childExitCode) || value.childExitCode < 1 || value.childExitCode > 255))) return null;
  } else if (value.failureCode !== null || value.childExitCode !== null ||
      (value.status === 'ready') !== (value.stage === 'ready')) return null;
  return { schemaVersion: 1, stage: value.stage, status: value.status, failureCode: value.failureCode, childExitCode: value.childExitCode };
}

// Hints only when the fixture failed before its status file existed. Never copy
// exception messages, frames, paths, URLs or arbitrary error names into evidence.
export function classifyFixtureBootstrapLog(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > FIXTURE_PRIVATE_LOG_LIMIT) return 'bootstrap-unclassified';
  for (const [code, classification] of [
    ['ERR_MODULE_NOT_FOUND', 'bootstrap-module-not-found'], ['MODULE_NOT_FOUND', 'bootstrap-module-not-found'],
    ['ERR_UNKNOWN_FILE_EXTENSION', 'bootstrap-file-extension'], ['ERR_REQUIRE_ESM', 'bootstrap-require-esm'],
    ['ERR_DLOPEN_FAILED', 'bootstrap-native-module-load'],
  ]) {
    if (new RegExp(`^(?:Error|TypeError) \\[${code}\\]:|^  code: '${code}',?\\r?$`, 'm').test(text)) return classification;
  }
  for (const [name, classification] of [
    ['SyntaxError', 'bootstrap-syntax-error'], ['ReferenceError', 'bootstrap-reference-error'],
    ['TypeError', 'bootstrap-type-error'], ['RangeError', 'bootstrap-range-error'],
  ]) if (new RegExp(`^${name}:`, 'm').test(text)) return classification;
  return 'bootstrap-unclassified';
}

function readBoundedRegular(path, limit, tail = false) {
  let descriptor;
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()) return { kind: 'invalid' };
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(descriptor);
    if (!info.isFile() || (!tail && (info.size < 1 || info.size > limit))) return { kind: 'invalid' };
    const offset = tail ? Math.max(0, info.size - limit) : 0;
    const buffer = Buffer.alloc(tail ? Math.min(limit, info.size) : limit + 1);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, offset);
    if (!tail && bytes > limit) return { kind: 'invalid' };
    let text = buffer.subarray(0, bytes).toString('utf8');
    if (offset > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    return { kind: 'read', text };
  } catch (error) {
    return { kind: error?.code === 'ENOENT' ? 'missing' : 'invalid' };
  } finally {
    if (descriptor != null) { try { closeSync(descriptor); } catch { /* No raw filesystem errors in evidence. */ } }
  }
}

export function collectFixtureDiagnostic(fixtureDirectory, privateLog, observedExitCode) {
  const fixtureExitCode = Number.isSafeInteger(observedExitCode) && observedExitCode >= 0 && observedExitCode <= 255 ? observedExitCode : null;
  const status = readBoundedRegular(`${fixtureDirectory}/foreground-fixture-status.json`, FIXTURE_STATUS_LIMIT);
  if (status.kind === 'read') {
    try {
      const value = JSON.parse(status.text);
      const safe = sanitizeFixtureDiagnostic(value);
      if (safe && status.text === `${JSON.stringify(value)}\n`) return { source: 'status-file', ...safe, fixtureExitCode };
    } catch { /* An invalid diagnostic is not trusted and is never retained. */ }
  }
  if (status.kind !== 'missing') {
    return { source: 'invalid-status', schemaVersion: 1, stage: 'unavailable', status: 'unavailable', failureCode: 'status-invalid', childExitCode: null, fixtureExitCode };
  }
  const log = readBoundedRegular(privateLog, FIXTURE_PRIVATE_LOG_LIMIT, true);
  return { source: log.kind === 'read' ? 'bootstrap-log' : 'unavailable', schemaVersion: 1, stage: 'bootstrap', status: 'unavailable',
    failureCode: classifyFixtureBootstrapLog(log.kind === 'read' ? log.text : ''), childExitCode: null, fixtureExitCode };
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
  let browser, proc, log, failure, page;
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
    try {
      browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    } catch (error) {
      evidence.browserLaunchDiagnostic = classifyBrowserLaunchFailure(error);
      evidence.browserPrerequisites = await collectBrowserPrerequisites();
      throw error;
    }
    evidence.browserVersion = browser.version();
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    await context.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.origin !== 'http://127.0.0.1:43120' && u.origin !== 'http://127.0.0.1:43121') return route.abort('blockedbyclient');
      return route.continue();
    });
    await context.routeWebSocket('**/*', (ws) => ws.close());
    page = await context.newPage();
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
    try {
      const diagnostic = await captureFailureUi(page, caseDir);
      if (diagnostic) evidence.uiDiagnostic = diagnostic;
    } catch { /* Never retain browser error text or replace the original failure. */ }
  } finally {
    const cleanup = async (operation) => {
      try { await operation(); } catch (error) {
        evidence.cleanupFailureCode = failureCode(error);
        if (!failure) { evidence.phase = 'cleanup'; evidence.failureCode = failureCode(error); evidence.outcome = 'failed'; failure = error; }
      }
    };
    await cleanup(async () => { evidence.fixtureDiagnostic = collectFixtureDiagnostic(fixtureDir, fixtureLog, proc?.exitCode); });
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
    await runCasesAfterPublicBootstrap(chromium, mode, output, summary);
    summary.fullQualification = mode === 'full';
    summary.status = mode === 'full' ? 'passed' : 'admission-only';
  } finally {
    writeFileSync(`${output}/summary.json`, JSON.stringify(summary, null, 2));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--copy-failure-screenshot') {
    if (process.argv.length !== 6 || !copyFailureScreenshot(process.argv[3], process.argv[4], process.argv[5])) process.exitCode = 1;
  } else if (process.argv[2] === '--validate-evidence') {
    if (process.argv.length !== 5 || !validateEvidenceDirectory(process.argv[3], process.argv[4])) process.exitCode = 1;
  } else await main();
}
