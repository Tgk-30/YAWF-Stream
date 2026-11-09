#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PIN = Object.freeze({
  source: '71ac64423a00df601d35142c2bbae774cff3037b', run: '42643241753', artifactId: '13687171562',
  sha256: 'c25114fe2e6a6e61923162177348c98154733ff0d37bb556698c20c98716adb1',
  bytes: 88705921, version: '2.3.91', code: '2003091',
  signer: '233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a',
  image: 'system-images;android-36;google_apis;x86_64', serial: 'emulator-5554',
  avd: 'yawf-private91-more-api36', gpu: 'swiftshader_indirect', guestCores: 4, guestMemoryMiB: 4096,
  fixture: 'bf7e5b5852addbec5ceb9160def48eb4832462924bd8e4073cdce1f67540d157',
  prefix: 'a499d5e87cdc480d38e353ca2b7b877b2c42fb8218424febb241257834db4fb0',
});
const PRODUCT = 'com.tgk30.debridstreamer';
const HARNESS = 'com.yawf.runtimeinstrumentation';
const CLASS = `${HARNESS}.RuntimePlayer91MoreFlowTest`;
const MAX_BYTES = 8 * 1024 * 1024;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const hash = (data) => createHash('sha256').update(data).digest('hex');
const fail = (message) => { throw new Error(message); };
const requireTrue = (value, message) => { if (!value) fail(message); };

export function sanitize(value) {
  return String(value).replace(/(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]*/gi, '[redacted-header]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, '[redacted-bearer]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/(?:authorization|cookie|ds_session|ds_csrf|bearer|\/api\/(?:external-)?stream\/)[^\s"'<>]*/gi, '[redacted-sensitive]')
    .replace(/fixture-owner-password|fixture-owner/g, '[synthetic-identity]');
}

export function validateEnvironment(env) {
  requireTrue(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
    && env.RUNNER_OS === 'Linux' && env.RUNNER_ARCH === 'X64', 'Official hosted Linux X64 runner required');
  for (const [key, expected] of Object.entries({ CANDIDATE_SOURCE_SHA: PIN.source, CANDIDATE_RUN_ID: PIN.run,
    CANDIDATE_APK_SHA256: PIN.sha256, CANDIDATE_ARTIFACT_ID: PIN.artifactId, CANDIDATE_VERSION: PIN.version, CANDIDATE_VERSION_CODE: PIN.code,
    SYSTEM_IMAGE_PACKAGE: PIN.image, AVD_NAME: PIN.avd, EMULATOR_SERIAL: PIN.serial, EMULATOR_GPU: PIN.gpu })) {
    requireTrue(env[key] === expected, `Fixed ${key} mismatch`);
  }
  requireTrue(env.CANDIDATE_APK === 'candidate/YAWF.Stream_Android_2.3.91.apk', 'Fixed APK path mismatch');
  requireTrue(env.CANDIDATE_ARTIFACT === 'android-phone-verification-candidate', 'Fixed artifact mismatch');
}

export function validateHostResources(host) {
  requireTrue(Number.isSafeInteger(host.availableCPUs) && host.availableCPUs >= 4
    && Number.isSafeInteger(host.memoryBytes) && host.memoryBytes >= 8 * 1024 ** 3,
  'Hosted profile requires at least four available CPUs and eight GiB RAM');
}
export function validateCatalog(text) {
  const rows = text.split(/\r?\n/).map((line) => line.split('|').map((part) => part.trim()));
  requireTrue(rows.some((row) => row.length >= 3 && row[0] === PIN.image && /^\d+(?:\.\d+)*$/.test(row[1])),
    'The exact stable official image package was not listed');
}

export function cpuSnapshot(text) {
  const match = /^cpu\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(\d+))?/m.exec(text);
  requireTrue(match, 'Missing aggregate guest CPU counters');
  const values = match.slice(1).map((value) => Number(value || 0));
  requireTrue(values.every(Number.isSafeInteger), 'Unsafe guest CPU counters');
  return { total: values.reduce((a, b) => a + b, 0), iowait: values[4] };
}
export function iowaitPercent(before, after) {
  const total = after.total - before.total;
  const wait = after.iowait - before.iowait;
  requireTrue(total > 0 && wait >= 0 && wait <= total, 'Invalid guest CPU interval');
  return wait * 100 / total;
}
export function validateGuest({ sdk, abi, hardware, pageSize, webview }) {
  requireTrue(sdk === '36' && abi === 'x86_64' && hardware === 'ranchu' && pageSize === '4096', 'Guest identity mismatch');
  const provider = /Current WebView package \(name, version\): \((com\.(?:google\.android\.webview|android\.webview)), (\d+(?:\.\d+){3})\)/.exec(webview);
  requireTrue(provider && Number(provider[2].split('.')[0]) >= 90, 'Actual WebView provider/version is not admitted');
  return { package: provider[1], version: provider[2] };
}
export function parseInstalledAPKPaths(text) {
  requireTrue(typeof text === 'string' && Buffer.byteLength(text) <= 65536, 'Bounded installed APK metadata required');
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  requireTrue(lines.length >= 1 && lines.length <= 8, 'One to eight installed provider APKs required');
  const paths = lines.map((line) => {
    requireTrue(line.startsWith('package:'), 'Unexpected installed APK metadata line');
    const path = line.slice(8);
    requireTrue(path.length <= 4096 && /^\/(?:data\/app|product|system|system_ext)\//.test(path)
      && path.endsWith('.apk') && path.slice(1).split('/').every((part) =>
        /^[A-Za-z0-9._~+=-]{1,255}$/.test(part) && !part.includes('..') && part !== '.'),
    'Unsafe installed provider APK path');
    return path;
  });
  requireTrue(new Set(paths).size === paths.length, 'Duplicate installed provider APK path');
  return paths;
}
export function parseAPKHashOutput(text, expectedPath) {
  parseInstalledAPKPaths(`package:${expectedPath}\n`);
  const match = typeof text === 'string' && /^([a-f0-9]{64}) {1,2}([^\r\n]+)\r?\n?$/.exec(text);
  requireTrue(match && match[0] === text && match[2] === expectedPath, 'Exact installed APK hash output required');
  return match[1];
}
export function validateLauncher(text) {
  requireTrue(/(?:mResumedActivity|topResumedActivity)[^\n]*(?:com\.google\.android\.apps\.nexuslauncher\/[^\s}]+|com\.android\.launcher3\/[^\s}]+)/.test(text),
    'A responsive admitted launcher was not resumed');
}
export function validateJUnit(text) {
  requireTrue(/\bOK \(1 test\)/.test(text) && /INSTRUMENTATION_CODE:\s*-1\b/.test(text), 'Exactly one completed passing JUnit test required');
  requireTrue(!/FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed|INSTRUMENTATION_STATUS_CODE:\s*-\d|\b(?:ignored|skipped)\b/i.test(text), 'JUnit failure or skipped test observed');
}
export function validateReceipt(receipt) {
  requireTrue(receipt.schemaVersion === 1 && receipt.profile === 'private91-hosted-more' && receipt.outcome === 'PASS'
    && receipt.phase === 'complete' && receipt.sourceClicks === 1 && receipt.explicitSourceRow === true,
  'The exact successful explicit-source case was not completed');
  requireTrue(Number.isInteger(receipt.clockBeforeSeconds) && receipt.clockBeforeSeconds > 0
    && Number.isInteger(receipt.clockAfterSeconds) && receipt.clockAfterSeconds >= receipt.clockBeforeSeconds + 1 && receipt.clockAfterSeconds < 30, 'No bounded nonzero playback-clock advance');
  validateNativeMenuEvidence(receipt, false);
}

export function validateMenuOnlyReceipt(receipt) {
  requireTrue(receipt.schemaVersion === 1 && receipt.profile === 'private91-hosted-menu-only' && receipt.outcome === 'PASS'
    && receipt.phase === 'complete' && receipt.sourceClicks === 1 && receipt.explicitSourceRow === true,
  'The exact menu-only explicit-source case was not completed');
  requireTrue(receipt.menuOnlyQualified === true && receipt.clockProgressQualified === false
    && receipt.playbackContinuityQualified === false && receipt.clockBeforeSeconds === -1 && receipt.clockAfterSeconds === -1,
  'Menu-only cannot claim clock progress or playback continuity');
  requireTrue(receipt.initialClockObservationCount === 1, 'One passive initial clock AX observation required');
  validateNativeMenuEvidence(receipt, true);
  validate91Acquisition(receipt);
}


export function validate91Acquisition(receipt) {
  const reveals = receipt.inputs.filter(input=>input.role==='reveal');
  const more = receipt.inputs.filter(input=>input.role==='more');
  requireTrue(reveals.length===1 && more.length===1 && receipt.moreWindowLimitMs===1200, 'Exactly one reveal and More with fixed1200ms window required');
  const lastSource=receipt.inputs.findIndex(input=>input.role==='explicit-source');
  requireTrue(lastSource>=0 && receipt.inputs.filter(input=>input.role==='explicit-source').length===1
    && receipt.inputs.slice(lastSource).map(input=>input.role).join(',')==='explicit-source,reveal,more', 'No extra or hidden post-source actions admitted');
  const observations=receipt.chromeAbsenceObservations;
  requireTrue(Array.isArray(observations) && observations.length>=2 && observations.length<=64
    && observations.every((sample,index)=>Number.isSafeInteger(sample.uptimeMs) && sample.uptimeMs>=0
      && typeof sample.visible==='boolean' && sample.cacheRefreshed===true && (!index || sample.uptimeMs>observations[index-1].uptimeMs))
    && observations.slice(-2).every(sample=>sample.visible===false)
    && observations.at(-1).uptimeMs<=reveals[0].eventUptimeMs[0], 'Two consecutive fresh chrome-absent observations required');
  const up=reveals[0].eventUptimeMs[2], down=more[0].eventUptimeMs[0];
  requireTrue(receipt.chromeRevealUpUptimeMs===up && Number.isSafeInteger(receipt.moreAcquisitionStartedUptimeMs)
    && Number.isSafeInteger(receipt.moreAcquiredUptimeMs) && receipt.moreAcquisitionStartedUptimeMs>=up
    && receipt.moreAcquiredUptimeMs>=receipt.moreAcquisitionStartedUptimeMs && receipt.moreAcquiredUptimeMs<=down,
    'Stale More acquisition is not admitted');
  const a=receipt.moreAcquisition;
  requireTrue(a && a.rootPackageMatches===true && a.playerPackageMatches===true && a.targetPackageMatches===true
    && a.playerCount===1 && a.targetCount===1 && a.clearCacheCount===1 && a.activeRootCount===1,
    'One exact owned root/player/More snapshot required');
  requireTrue(Number.isSafeInteger(a.rootWindowId) && a.rootWindowId>=0 && a.playerWindowId===a.rootWindowId
    && a.targetWindowId===a.rootWindowId && Number.isSafeInteger(a.targetIdentity), 'Acquired window/identity mismatch');
  requireTrue(Number.isSafeInteger(a.nodesVisited) && a.nodesVisited>=1 && a.nodesVisited<=512
    && Number.isSafeInteger(a.maxDepth) && a.maxDepth>=0 && a.maxDepth<=32
    && Number.isSafeInteger(a.ancestorDistance) && a.ancestorDistance>=0 && a.ancestorDistance<=6,
    'Acquisition traversal/ancestor bound exceeded');
  const validRect=r=>Array.isArray(r) && r.length===4 && r.every(Number.isSafeInteger)
    && r[0]>=0 && r[1]>=0 && r[2]>r[0] && r[3]>r[1];
  const inside=(outer,inner)=>inner[0]>=outer[0] && inner[1]>=outer[1] && inner[2]<=outer[2] && inner[3]<=outer[3];
  requireTrue(validRect(a.rootBounds) && validRect(a.playerBounds) && validRect(a.targetBounds)
    && Number.isSafeInteger(a.screenWidth) && Number.isSafeInteger(a.screenHeight)
    && a.rootBounds[2]<=a.screenWidth && a.rootBounds[3]<=a.screenHeight
    && inside(a.rootBounds,a.playerBounds) && inside(a.playerBounds,a.targetBounds)
    && JSON.stringify(a.targetBounds)===JSON.stringify(more[0].targetBounds), 'Copied target bounds escaped owned root/player');
  requireTrue(reveals[0].foregroundAfterUptimeMs===receipt.moreAcquiredUptimeMs
    && reveals[0].x>=a.rootBounds[0] && reveals[0].x<a.rootBounds[2]
    && reveals[0].y>=a.rootBounds[1] && reveals[0].y<a.rootBounds[3], 'Shared root did not prove post-reveal foreground');
  requireTrue(receipt.moreDownAttemptUptimeMs===down && down-up>=0 && down-up<=1200, 'Actual More DOWN exceeded1200ms since reveal UP');
}

export function validateUpdateConsentTail(input) {
  const tail = input.setupTail;
  requireTrue(input.role === 'setup' && input.upAcknowledged === true && input.streamMayRemain === false &&
    tail?.action === 'UPDATE_NOT_NOW_TO_WELCOME' && tail.phase === 'launch' && tail.sourceClicks === 0 && tail.declineOrdinal === 1 &&
    tail.ok === true && tail.maximumMs === 2000 && tail.maximumSamples === 20 &&
    tail.upUptimeMs === input.eventUptimeMs?.[2], 'Exact released launch-consent tail required');
  const up = tail.upUptimeMs;
  requireTrue(Number.isSafeInteger(up) && Number.isSafeInteger(tail.screenWidth) && tail.screenWidth > 0 && tail.screenWidth <= 16384 &&
    Number.isSafeInteger(tail.screenHeight) && tail.screenHeight > 0 && tail.screenHeight <= 16384 &&
    Array.isArray(tail.observations) && tail.observations.length >= 2 && tail.observations.length <= 20, 'Bounded tail snapshots required');
  let first = -1, stable = 0, previousKey = null, previousAt = up - 1, completed = false;
  for (const [index, observation] of tail.observations.entries()) {
    const o = observation;
    requireTrue(!completed && Number.isSafeInteger(o.uptimeMs) && o.uptimeMs > previousAt && o.uptimeMs >= up && o.uptimeMs - up <= 2000 &&
      typeof o.rootAvailable === 'boolean' && typeof o.ownerValid === 'boolean' && typeof o.oldPrompt === 'boolean' && o.unexpected === false &&
      [o.dialogs, o.titles, o.skips, o.nexts].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1), 'Tail snapshot invalid, stale, duplicate or unexpected');
    previousAt = o.uptimeMs;
    if (o.rootAvailable) {
      requireTrue(o.ownerValid === true && Number.isSafeInteger(o.rootWindowId) && o.rootWindowId >= 0 &&
        Array.isArray(o.rootBounds) && o.rootBounds.length === 4 && o.rootBounds.every(Number.isSafeInteger) &&
        o.rootBounds[0] >= 0 && o.rootBounds[1] >= 0 && o.rootBounds[2] > o.rootBounds[0] && o.rootBounds[3] > o.rootBounds[1] &&
        o.rootBounds[2] <= tail.screenWidth && o.rootBounds[3] <= tail.screenHeight &&
        o.rootKey === [o.rootWindowId, ...o.rootBounds].join(','), 'Exact owned visible tail root required');
    } else requireTrue(o.ownerValid === false && o.rootWindowId === -1 && o.rootBounds === null && o.rootKey === null &&
      !o.oldPrompt && o.dialogs + o.titles + o.skips + o.nexts === 0, 'Null-root observation must not fabricate landmarks');
    const ready = o.rootAvailable && !o.oldPrompt && o.dialogs === 1 && o.titles === 1 && o.skips === 1 && o.nexts === 1;
    if (!ready) { first = -1; stable = 0; previousKey = null; continue; }
    if (o.rootKey !== previousKey) { first = o.uptimeMs; stable = 1; previousKey = o.rootKey; } else stable++;
    completed = stable >= 2 && o.uptimeMs - first >= 100;
    if (completed) requireTrue(index === tail.observations.length - 1, 'No tail queries after successful stabilization');
  }
  requireTrue(completed && tail.firstStableUptimeMs === first && tail.lastStableUptimeMs === previousAt &&
    Number.isSafeInteger(tail.finishedUptimeMs) && tail.finishedUptimeMs >= previousAt && tail.finishedUptimeMs - up <= 2000,
  'Two stable Welcome snapshots within the original tail deadline required');
}

function validateNativeMenuEvidence(receipt, menuOnly) {
  requireTrue(receipt.uniqueMenu === true && receipt.menuHeading === true && receipt.singleUiAutomationOwner === true,
    'Actual unique menu semantic proof required');
  requireTrue(Array.isArray(receipt.menuBounds) && receipt.menuBounds.length === 4
    && receipt.menuBounds.every(Number.isSafeInteger) && receipt.menuBounds[0] >= 0 && receipt.menuBounds[1] >= 0
    && receipt.menuBounds[2] > receipt.menuBounds[0] && receipt.menuBounds[3] > receipt.menuBounds[1], 'Invalid menu bounds');
  requireTrue(Array.isArray(receipt.inputs) && receipt.inputs.length > 0 && receipt.inputs.length <= 20, 'Bounded native input proofs required');
  for (const input of receipt.inputs) {
    requireTrue(Array.isArray(input.targetBounds) && input.targetBounds.length === 4
      && input.targetBounds.every(Number.isFinite) && input.targetBounds[0] >= 0 && input.targetBounds[1] >= 0
      && Number.isFinite(input.x) && Number.isFinite(input.y) && input.x >= input.targetBounds[0] && input.x < input.targetBounds[2]
      && input.y >= input.targetBounds[1] && input.y < input.targetBounds[3], 'Native target escaped fresh measured bounds');
    requireTrue(input.ok === true && input.tool === 'finger' && input.toolType === 1 && input.durationMs === 100 && input.steps === 2
      && input.foregroundTargetBefore === true && input.foregroundTargetAfter === true
      && input.downAdmitted === true && input.downInjectionAttempted === true && input.downAcknowledged === true && input.upAcknowledged === true
      && input.streamMayRemain === false && input.cancelAcknowledged === false, 'Native input release/foreground/UP proof failed');
    requireTrue(Array.isArray(input.eventUptimeMs) && input.eventUptimeMs.length === 3 && input.eventUptimeMs.every(Number.isSafeInteger)
      && input.eventUptimeMs[0] >= input.downUptimeMs && input.eventUptimeMs[1] >= input.eventUptimeMs[0]
      && input.eventUptimeMs[2] >= input.eventUptimeMs[1] + 1 && input.eventUptimeMs[2] - input.downUptimeMs >= 100
      && input.eventUptimeMs[2] - input.downUptimeMs < 2000, 'Actual MotionEvent timing proof failed');
  }
  const consentTails = receipt.inputs.filter(input => Object.hasOwn(input, 'setupTail'));
  requireTrue(consentTails.length <= 1, 'Only one exact native consent tail is admitted');
  for (const input of consentTails) validateUpdateConsentTail(input);
  const more = receipt.inputs.filter((input) => input.role === 'more');
  const reveal = receipt.inputs.filter((input) => input.role === 'reveal');
  requireTrue(more.length === 1 && reveal.length <= (menuOnly ? 1 : 2), 'One More activation and at most two clock-epoch reveals required');
  requireTrue(receipt.chromeRevealCount === reveal.length && receipt.chromeRevealPerformed === (reveal.length > 0), 'Reveal count must match actual input proofs');
  const epochs = reveal.map((input) => input.observationEpoch);
  for (const input of reveal) requireTrue(Math.abs(input.x - (input.targetBounds[0] + (input.targetBounds[2] - input.targetBounds[0]) * 0.5)) < 0.01
    && Math.abs(input.y - (input.targetBounds[1] + (input.targetBounds[3] - input.targetBounds[1]) * 0.32)) < 0.01,
  'Reveal must use the safe measured video point, not the center transport');
  requireTrue(epochs.every((epoch) => (menuOnly ? ['menu-only'] : ['clock-before', 'clock-after']).includes(epoch))
    && new Set(epochs).size === epochs.length, 'Only distinct clock observation epochs may reveal');
  if (!menuOnly && reveal.length === 2) requireTrue(epochs[0] === 'clock-before' && epochs[1] === 'clock-after'
    && reveal[1].eventUptimeMs[0] - reveal[0].eventUptimeMs[2] >= 2200, 'Clock observation epochs require the real bounded interval');
  let playerInputStarted = false;
  for (const input of receipt.inputs) {
    requireTrue(['setup', 'explicit-source', 'reveal', 'more'].includes(input.role), 'Unknown native input role');
    if (input.role !== 'reveal') requireTrue(!Object.hasOwn(input, 'observationEpoch'), 'Only actual reveal inputs may claim clock epochs');
    requireTrue(!(playerInputStarted && input.role === 'setup'), 'Post-source player inputs cannot be hidden as setup');
    if (input.role !== 'setup') playerInputStarted = true;
  }
  if (reveal.length) {
    const last = reveal.at(-1);
    requireTrue(more[0].eventUptimeMs[0] - last.eventUptimeMs[2] >= 0
      && more[0].eventUptimeMs[0] - last.eventUptimeMs[2] < 3200, 'More DOWN missed auto-hide window');
  }

}

export function ownedDirectory(path, parent, fresh = false) {
  requireTrue(isAbsolute(path) && resolve(path) === path && path !== parent && !relative(parent, path).startsWith('..'), 'Directory escaped its owned root');
  if (fresh) requireTrue(!existsSync(path), 'Owned output must be fresh');
  requireTrue(realpathSync(parent) === parent && lstatSync(parent).isDirectory(), 'Canonical parent required');
  let cursor = parent;
  for (const component of relative(parent, path).split('/')) {
    cursor = join(cursor, component);
    if (existsSync(cursor)) requireTrue(!lstatSync(cursor).isSymbolicLink() && lstatSync(cursor).isDirectory(), 'Symlink or nondirectory component refused');
    else mkdirSync(cursor, { mode: 0o700 });
  }
  requireTrue(lstatSync(path).isDirectory() && realpathSync(path) === path, 'Canonical nonsymlink directory required');
  return path;
}
function command(binary, args, { cwd, env, timeout = 30_000, limit = MAX_BYTES, input } = {}) {
  const child = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const chunks = [];
  let size = 0;
  let overflow = false;
  let timedOut = false;
  let stoppingKill;
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    stoppingKill ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
  };
  child.stdin.on('error', () => {}); child.stdin.end(input || '');
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
  const killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeout + 2_000);
  const collect = (data) => { size += data.length; if (size <= limit) chunks.push(data); else { overflow = true; stop(); } };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const done = new Promise((resolveDone) => {
    child.once('error', () => resolveDone({ code: -1, failure: 'SPAWN', output: '' }));
    child.once('close', (code, signal) => resolveDone({ code, signal, failure: timedOut ? 'TIMEOUT' : overflow ? 'OUTPUT_BOUND' : null,
      output: Buffer.concat(chunks).toString('utf8') }));
  }).finally(() => { clearTimeout(timer); clearTimeout(killTimer); clearTimeout(stoppingKill); });
  return { child, done, stop, output: () => Buffer.concat(chunks).toString('utf8') };
}
async function run(binary, args, options) {
  const result = await command(binary, args, options).done;
  requireTrue(result.code === 0 && !result.failure, 'Owned command failed');
  return result.output;
}
async function portFree(port) {
  const listening = await new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => { socket.destroy(); done(true); });
  });
  requireTrue(!listening, 'Required owned loopback port is already listening');
}

export function parseRuntimeMode(args) {
  requireTrue(Array.isArray(args) && (args.length === 0 || (args.length === 1 && args[0] === 'menu-only')), 'Unexpected runtime driver arguments');
  return 'menu-only';
}

async function main(mode = 'menu-only') {
  requireTrue(mode === 'menu-only', 'Only the finite91 menu-only gate is admitted');
  const menuOnly = true;
  validateEnvironment(process.env);
  const repo = realpathSync(process.cwd());
  const temp = realpathSync(process.env.RUNNER_TEMP || fail('RUNNER_TEMP is required'));
  requireTrue(temp !== '/' && !repo.startsWith(temp + '/') && !temp.startsWith(repo + '/'), 'Separate runner temp root required');
  const evidence = ownedDirectory(resolve(process.env.EVIDENCE), repo, true);
  const root = ownedDirectory(join(temp, 'yawf-private91-more'), temp, true);
  const source = join(repo, 'candidate-source');
  const apk = join(repo, process.env.CANDIDATE_APK);
  const result = { schemaVersion: 1, outcome: 'FAIL', scope: 'DIAGNOSTIC_RAW_SDK_GEOMETRY_ONLY_NOT_PRODUCT_QUALIFICATION', diagnosticOnly: true, productQualified: false, source: PIN.source,
    menuOnlyQualified: false, clockProgressQualified: false, playbackContinuityQualified: false,
    APKsha256: PIN.sha256, guest: null, iowait: [], junit: null, menu: false, decodedImageReviewRequired: true,
    bundledPlaybackClaimed: false, cleanup: {} };
  const save = (name, value) => writeFileSync(join(evidence, name), sanitize(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'));
  let emulator, fixture;
  let bootAt;
  let logcat;
  let signalFailure = false;
  const adb = (args, options) => run('adb', ['-s', PIN.serial, ...args], options);
  const onSignal = () => { signalFailure = true; emulator?.stop(); fixture?.stop(); logcat?.stop(); };
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
  try {
    requireTrue((await run('git', ['-C', source, 'rev-parse', 'HEAD'])).trim() === PIN.source, 'Fixture checkout source mismatch');
    requireTrue(statSync(apk).size === PIN.bytes && hash(readFileSync(apk)) === PIN.sha256, 'Exact production APK mismatch');
    requireTrue(hash(readFileSync(join(source, 'scripts/android_external_player_server_fixture.mts'))) === PIN.fixture, 'Unmodified tracked fixture mismatch');
    save('fixture-source.json', { source: PIN.source, helperSHA256: PIN.fixture,
      frontendIndexSHA256: hash(readFileSync(join(source, 'web/dist/index.html'))), backendExecution: 'source app.ts via tsx, not CJS' });
    const assets = readdirSync(join(source, 'web/dist/assets')).filter((name) => /^VideoPlayer-[A-Za-z0-9_-]+\.js$/.test(name));
    requireTrue(assets.length === 1, 'Exactly one compiled source91 player required');
    save('fixture-player.json', { filename: assets[0], sha256: hash(readFileSync(join(source, 'web/dist/assets', assets[0]))) });
    save('runner.json', { imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion, node: process.version });
    const hostResources = { availableCPUs: availableParallelism(), logicalCPUs: cpus().length, memoryBytes: totalmem() };
    save('host-resources-before-boot.json', hostResources);
    validateHostResources(hostResources);
    save('configured-guest-before-boot.json', { cores: PIN.guestCores, memoryMiB: PIN.guestMemoryMiB,
      image: PIN.image, GPU: PIN.gpu, profile: 'hosted-api36-4c4g' });
    result.hostResources = hostResources;
    result.configuredGuest = { cores: PIN.guestCores, memoryMiB: PIN.guestMemoryMiB };
    save('apk-static.txt', await run('python3', [join(source, 'scripts/verify_android_apk.py'), '--apk', apk,
      '--version', PIN.version, '--certificate-pin', join(source, 'web/src-tauri/SIGNING_CERT_SHA256'), '--sdk', process.env.ANDROID_HOME], { timeout: 120_000 }));
    requireTrue(readFileSync(join(source, 'web/src-tauri/SIGNING_CERT_SHA256'), 'utf8').trim().replaceAll(':', '').toLowerCase() === PIN.signer, 'Production signer pin mismatch');
    const manifest = await run('apkanalyzer', ['manifest', 'print', apk]);
    requireTrue(/android:versionCode="2003091"/.test(manifest) && /android:versionName="2\.3\.91"/.test(manifest), 'Manifest version/code mismatch');
    save('apk-manifest.xml', manifest);
    save('adb-start-server.txt', await run('adb', ['start-server']));
    const devicesBeforeRun = await run('adb', ['devices']);
    save('adb-preexisting-devices.txt', devicesBeforeRun);
    requireTrue(devicesBeforeRun.trim() === 'List of devices attached', 'Existing device present before owned run');
    for (const port of [43120, 43121, 5554, 5555]) await portFree(port);
    requireTrue(statSync('/dev/kvm').isCharacterDevice(), 'KVM character device required');
    save('acceleration.txt', await run('emulator', ['-accel-check']));
    requireTrue(/KVM[^\n]*(?:installed and usable|is usable)/i.test(readFileSync(join(evidence, 'acceleration.txt'), 'utf8')), 'Usable KVM acceleration required');
    for (const [key, name] of Object.entries({ ANDROID_USER_HOME: 'android-user', ANDROID_EMULATOR_HOME: 'emulator', ANDROID_AVD_HOME: 'avd', TMPDIR: 'tmp' })) {
      process.env[key] = ownedDirectory(join(root, name), root, true);
    }
    const imageDir = join(process.env.ANDROID_HOME, 'system-images/android-36/google_apis/x86_64');
    for (const name of ['source.properties', 'package.xml']) save(`image-${name}.sha256`, hash(readFileSync(join(imageDir, name))));
    const fixtureOutput = join(root, 'fixture');
    fixture = command(process.execPath, [join(source, 'server/node_modules/tsx/dist/cli.mjs'),
      join(source, 'scripts/android_external_player_server_fixture.mts'), '--repo', source, '--output', fixtureOutput], { timeout: 20 * 60_000 });
    const fixtureDeadline = Date.now() + 180_000;
    while (!fixture.output().includes('[fixture] READY server-mode-ui loopback')) {
      requireTrue(fixture.child.exitCode === null && fixture.child.signalCode === null && Date.now() < fixtureDeadline && !signalFailure, 'Owned fixture readiness failed');
      await sleep(300);
    }
    save('fixture-smoke.json', JSON.parse(readFileSync(join(fixtureOutput, 'smoke-result.json'), 'utf8')));
    save('avd-create.txt', await run('avdmanager', ['create', 'avd', '--name', PIN.avd, '--package', PIN.image, '--device', 'pixel',
      '--path', join(process.env.ANDROID_AVD_HOME, PIN.avd)], { timeout: 30_000, input: 'no\n' }));
    save('emulator-version.txt', await run('emulator', ['-version']));
    save('owned-avd-config.sha256', hash(readFileSync(join(process.env.ANDROID_AVD_HOME, PIN.avd, 'config.ini'))));
    bootAt = Date.now(); result.bootUTC = new Date(bootAt).toISOString();
    emulator = command('emulator', ['-avd', PIN.avd, '-port', '5554', '-accel', 'on', '-gpu', PIN.gpu,
      '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot', '-camera-back', 'none', '-camera-front', 'none',
      '-cores', String(PIN.guestCores), '-memory', String(PIN.guestMemoryMiB)], { timeout: 12 * 60_000 });
    result.ownedEmulatorPID = emulator.child.pid; result.ownedFixturePID = fixture.child.pid;
    const bootDeadline = bootAt + 300_000;
    while (true) {
      requireTrue(emulator.child.exitCode === null && emulator.child.signalCode === null && Date.now() < bootDeadline && !signalFailure, 'Owned emulator boot admission failed');
      const state = await command('adb', ['-s', PIN.serial, 'shell', 'getprop', 'sys.boot_completed'], { timeout: 5_000 }).done;
      if (state.code === 0 && state.output.trim() === '1') break;
      await sleep(2000);
    }
    requireTrue((await adb(['emu', 'avd', 'name'])).split(/\r?\n/)[0] === PIN.avd, 'Owned AVD name mismatch');
    const getprop = async (key) => (await adb(['shell', 'getprop', key])).trim();
    const identity = { sdk: await getprop('ro.build.version.sdk'), abi: await getprop('ro.product.cpu.abi'),
      hardware: await getprop('ro.hardware'), pageSize: (await adb(['shell', 'getconf', 'PAGE_SIZE'])).trim(),
      webview: await adb(['shell', 'dumpsys', 'webviewupdate']) };
    const webview = validateGuest(identity);
    result.guest = { ...identity, webview }; save('guest.json', result.guest);
    save('guest-cpu-online.txt', await adb(['shell', 'cat', '/sys/devices/system/cpu/online']));
    save('guest-meminfo.txt', await adb(['shell', 'cat', '/proc/meminfo']));
    logcat = command('adb', ['-s', PIN.serial, 'logcat', '-v', 'threadtime'], { timeout: 12 * 60_000 });
    await adb(['shell', 'input', 'keyevent', '3']);
    const initialCPU = await adb(['shell', 'cat', '/proc/stat']);
    save('readiness-initial-cpu.txt', initialCPU);
    let previous = cpuSnapshot(initialCPU);
    for (let interval = 0; interval < 2; interval++) {
      await sleep(30_000);
      const rawCPU = await adb(['shell', 'cat', '/proc/stat']);
      save(`readiness-${interval}-cpu.txt`, rawCPU);
      const rawEvents = await adb(['logcat', '-b', 'events', '-d', '-v', 'brief']);
      save(`readiness-${interval}-events.txt`, rawEvents);
      const rawLauncher = await adb(['shell', 'dumpsys', 'activity', 'activities']);
      save(`readiness-${interval}-launcher.txt`, rawLauncher);
      const current = cpuSnapshot(rawCPU);
      const wait = iowaitPercent(previous, current); previous = current;
      result.iowait.push({ atUTC: new Date().toISOString(), percent: wait });
      requireTrue(wait < 10, 'Strict guest IO admission failed');
      requireTrue(!/\bam_anr\b/.test(rawEvents), 'Current boot ANR observed');
      validateLauncher(rawLauncher);
    }
    const installedWebview = await adb(['shell', 'pm', 'path', webview.package]);
    save('webview-package-paths.txt', installedWebview);
    const providerPaths = parseInstalledAPKPaths(installedWebview);
    const providerAPKs = [];
    for (const path of providerPaths) {
      const output = await adb(['shell', 'sha256sum', path]);
      save(`webview-apk-${providerAPKs.length}-sha256.txt`, output);
      providerAPKs.push({ path, sha256: parseAPKHashOutput(output, path) });
    }
    save('webview-apks.json', { ...webview, APKs: providerAPKs });
    for (const port of [43120, 43121]) await adb(['reverse', `tcp:${port}`, `tcp:${port}`]);
    for (const path of [apk, join(repo, 'scripts/android-runtime-instrumentation/app/build/outputs/apk/debug/app-debug.apk'),
      join(repo, 'scripts/android-runtime-instrumentation/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')]) {
      save(`install-${hash(path).slice(0, 8)}.txt`, await adb(['install', path], { timeout: 90_000 }));
    }
    const base = /^package:(\/data\/app\/[^\r\n]+\/base\.apk)\r?\n?$/.exec(await adb(['shell', 'pm', 'path', PRODUCT]));
    requireTrue(base, 'Installed base APK path mismatch');
    const installed = (await adb(['shell', 'sha256sum', base[1]])).split(/\s+/)[0];
    requireTrue(installed === PIN.sha256, 'Installed product bytes mismatch');
    save('installed.json', { sha256: installed, version: PIN.version, versionCode: PIN.code });
    const instrumentation = await command('adb', ['-s', PIN.serial, 'shell', 'am', 'instrument', '-w', '-r',
      '-e', 'class', `${CLASS}#${menuOnly ? 'production91OpensMoreMenuOnlyWithNativeFinger' : 'production91OpensMoreWithNativeFinger'}`, '-e', 'evidenceSubdir', 'player91-more', `${HARNESS}.test/androidx.test.runner.AndroidJUnitRunner`], { timeout: Math.min(360_000, Math.max(1, bootAt + 12 * 60_000 - Date.now() - 60_000)) }).done;
    save('instrumentation.txt', instrumentation.output);
    requireTrue(instrumentation.code === 0 && !instrumentation.failure, 'Bounded instrumentation command failed');
    // Collect the receipt and screenshots even when JUnit itself reports failure.
    await collectUi();
    validateJUnit(instrumentation.output);
    const receipt = JSON.parse(readFileSync(join(evidence, 'ui/receipt.json'), 'utf8'));
    if (menuOnly) validateMenuOnlyReceipt(receipt); else validateReceipt(receipt);
    requireTrue(readdirSync(join(evidence, 'ui')).some((name) => /^\d{2}-more-open\.png$/.test(name)), 'Actual More screenshot missing');
    const runtimeEvents = await adb(['logcat', '-b', 'events', '-d', '-v', 'brief']);
    save('runtime-events.txt', runtimeEvents);
    requireTrue(!/\bam_anr\b/.test(runtimeEvents), 'Runtime current boot ANR observed');
    result.junit = { pass: 1, fail: 0, skip: 0 }; result.menu = true;
    result.menuOnlyQualified = false; result.clockProgressQualified = false;
    result.outcome = 'DIAGNOSTIC_COMPLETED_MENU_OBSERVED_NOT_PRODUCT_PASS';
  } catch (error) {
    result.error = sanitize(error.message).slice(0, 300);
    if (emulator) {
      await collectUi().catch(() => {});
      for (const [name, args] of [['failure-logcat.txt', ['logcat', '-d', '-t', '10000', '-v', 'threadtime']],
        ['failure-activity.txt', ['shell', 'dumpsys', 'activity', 'lastanr']], ['failure-window.txt', ['shell', 'dumpsys', 'window', 'windows']]]) {
        const read = await command('adb', ['-s', PIN.serial, ...args], { timeout: 10_000 }).done;
        save(name, read.output);
      }
      const png = command('adb', ['-s', PIN.serial, 'exec-out', 'screencap', '-p'], { timeout: 10_000 });
      // Binary screenshot collection uses its own bounded pipe; never UTF-8 re-encodes a PNG.
      const chunks = []; let bytes = 0;
      png.child.stdout.removeAllListeners('data');
      png.child.stdout.on('data', (data) => { bytes += data.length; if (bytes <= MAX_BYTES) chunks.push(data); else png.stop(); });
      const read = await png.done;
      if (read.code === 0 && bytes > 0 && bytes <= MAX_BYTES) writeFileSync(join(evidence, 'failure-native.png'), Buffer.concat(chunks));
    }
  } finally {
    if (logcat) { logcat.stop(); const closed = await logcat.done; save('native-logcat.txt', closed.output); result.cleanup.logcatClosed = true; }
    if (emulator) {
      for (const port of [43120, 43121]) await command('adb', ['-s', PIN.serial, 'reverse', '--remove', `tcp:${port}`], { timeout: 5000 }).done;
      await command('adb', ['-s', PIN.serial, 'emu', 'kill'], { timeout: 5000 }).done;
      const graceful = await Promise.race([emulator.done, sleep(5_000).then(() => null)]);
      if (!graceful) emulator.stop();
      const closed = graceful || await emulator.done; save('emulator.txt', closed.output);
      result.cleanup.emulator = { code: closed.code, signal: closed.signal, closed: true };
      const deletion = await command('avdmanager', ['delete', 'avd', '--name', PIN.avd], { timeout: 10_000 }).done;
      save('owned-avd-delete.txt', deletion.output);
      result.cleanup.ownedAVDDeleted = deletion.code === 0 && !existsSync(join(process.env.ANDROID_AVD_HOME, PIN.avd));
    }
    if (fixture) { fixture.stop(); const closed = await fixture.done; save('fixture.txt', closed.output); result.cleanup.fixture = { code: closed.code, signal: closed.signal, closed: true }; }
    result.cleanup.portsFree = true;
    for (const port of [43120, 43121, 5554, 5555]) { try { await portFree(port); } catch { result.cleanup.portsFree = false; } }
    result.cleanup.adbEmpty = (await command('adb', ['devices'], { timeout: 5000 }).done).output.trim() === 'List of devices attached';
    save('FINAL.json', result);
    process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal);
  }
  requireTrue(!signalFailure && result.outcome === (menuOnly ? 'PASS_MENU_ONLY_NO_CLOCK_OR_CONTINUITY_CLAIM' : 'PASS_MORE_ONLY_IMAGE_REVIEW_REQUIRED') && result.cleanup.portsFree && result.cleanup.adbEmpty && result.cleanup.ownedAVDDeleted
    && result.cleanup.emulator?.code === 0 && result.cleanup.fixture?.code === 0, 'Private91 More case did not satisfy all gates');

  async function collectUi() {
    const names = (await adb(['exec-out', 'run-as', HARNESS, 'ls', '-1', 'files/player91-more'], { timeout: 10_000 })).trim().split(/\r?\n/);
    requireTrue(names.length > 0 && names.length <= 24 && names.every((name) => /^(?:receipt\.json|initial-clock-ax\.json|\d{2}-[a-z-]+\.(?:png|xml))$/.test(name)), 'Unexpected bounded UI evidence files');
    const out = join(evidence, 'ui'); mkdirSync(out, { recursive: true });
    for (const name of names) {
      const item = command('adb', ['-s', PIN.serial, 'exec-out', 'run-as', HARNESS, 'cat', `files/player91-more/${name}`], { timeout: 10_000 });
      const chunks = []; let bytes = 0;
      item.child.stdout.removeAllListeners('data');
      item.child.stdout.on('data', (data) => { bytes += data.length; if (bytes <= MAX_BYTES) chunks.push(data); else item.stop(); });
      const read = await item.done;
      requireTrue(read.code === 0 && bytes > 0 && bytes <= MAX_BYTES, 'Owned UI artifact exceeded its bound');
      const data = Buffer.concat(chunks);
      writeFileSync(join(out, name), name.endsWith('.png') ? data : sanitize(data.toString('utf8')));
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'catalog' && process.argv.length === 4) validateCatalog(readFileSync(process.argv[3], 'utf8'));
    else await main(parseRuntimeMode(process.argv.slice(2)));
  } catch (error) { console.error(sanitize(error.message)); process.exitCode = 1; }
}
