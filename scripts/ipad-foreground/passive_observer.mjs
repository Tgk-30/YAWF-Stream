// Dormant until explicitly installed by the private iPad foreground fixture.
// Browser writes only bounded, event-triggered observations to this collector.
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const COLLECTOR_PATH = '/__ipadqa/observe';
export const SCRIPT_PATH = '/__ipadqa/observer.js';
export const MAX_BODY_BYTES = 4096;
export const MAX_RECORDS = 8192;
export const MAX_BYTES = 8 * 1024 * 1024;
const EVENTS = new Set(['arrival', 'ui-ready', 'observer-limit', 'pageshow', 'visibilitychange', 'pagehide', 'loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'firstframe', 'timeupdate', 'waiting', 'stalled', 'pause', 'seeking', 'seeked', 'ended', 'error', 'emptied']);
const FIELDS = ['at', 'bufferAhead', 'currentTime', 'document', 'event', 'frameMediaTime', 'frames', 'hidden', 'paused', 'ready', 'readyState', 'rootReady', 'rvfc', 'seeking', 'sourceLocal', 'sourceOrdinal', 'videoCount', 'videoOrdinal'];
const num = (v, max) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
const integer = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const nullableNumber = (v, max) => v === null || num(v, max);

export function validObservation(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== FIELDS.join(',')) return false;
  if (!EVENTS.has(v.event) || typeof v.document !== 'string' || !/^[a-f0-9]{32}$/.test(v.document) ||
      !num(v.at, 86_400_000) || !integer(v.videoCount, 64) || !integer(v.videoOrdinal, 64) ||
      !integer(v.sourceOrdinal, 1024) || !nullableNumber(v.currentTime, 86_400) ||
      !nullableNumber(v.bufferAhead, 86_400) || !nullableNumber(v.frameMediaTime, 86_400) ||
      !integer(v.frames, 10_000_000) || !integer(v.readyState, 4)) return false;
  if (!['hidden', 'paused', 'seeking', 'sourceLocal', 'rvfc', 'ready', 'rootReady'].every(k => typeof v[k] === 'boolean')) return false;
  if (v.videoOrdinal === 0 && (v.sourceOrdinal !== 0 || v.currentTime !== null || v.bufferAhead !== null || v.frameMediaTime !== null || v.frames !== 0 || v.readyState !== 0 || v.rvfc || v.sourceLocal || v.paused || v.seeking)) return false;
  return true;
}

export function allowedCollectorRequest(headers, origin) {
  if (!headers || typeof origin !== 'string') return false;
  const url = new URL(origin);
  return url.protocol === 'http:' && url.hostname === '127.0.0.1' && headers.host === url.host &&
    headers.origin === origin && headers['content-type'] === 'application/json' &&
    (!headers['sec-fetch-site'] || headers['sec-fetch-site'] === 'same-origin');
}

function browserObserver() {
  'use strict';
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  const videos = new WeakMap();
  let count = 0, emitted = 0;
  const limit = 4096;
  function data(video) {
    let d = videos.get(video);
    if (!d) {
      d = { ordinal: ++count, source: '', sourceOrdinal: 0, frames: 0, frameMediaTime: null, active: false, firstFrameSource: -1, lastTimeUpdate: -Infinity };
      videos.set(video, d);
    }
    const src = video.currentSrc || '';
    if (src !== d.source) { d.source = src; d.sourceOrdinal++; }
    return d;
  }
  function watchFrames(video, d) {
    if (d.active || typeof video.requestVideoFrameCallback !== 'function') return;
    d.active = true;
    video.requestVideoFrameCallback(function frame(_now, metadata) {
      if (!video.isConnected) { d.active = false; return; }
      if (Number.isSafeInteger(metadata.presentedFrames) && metadata.presentedFrames >= 0) d.frames = metadata.presentedFrames;
      if (Number.isFinite(metadata.mediaTime) && metadata.mediaTime >= 0) d.frameMediaTime = metadata.mediaTime;
      data(video);
      if (d.frames > 0 && d.frameMediaTime !== null && d.firstFrameSource !== d.sourceOrdinal) {
        d.firstFrameSource = d.sourceOrdinal;
        observe('firstframe', video);
      }
      video.requestVideoFrameCallback(frame);
    });
  }
  function observe(event, video) {
    if (emitted >= limit) return;
    if (emitted === limit - 1) event = 'observer-limit';
    const d = video ? data(video) : null;
    let sourceLocal = false, ahead = null;
    if (video) {
      try { const u = new URL(video.currentSrc); sourceLocal = u.origin === location.origin; } catch {}
      try {
        const t = video.currentTime;
        for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= t && video.buffered.end(i) >= t) ahead = Math.max(0, video.buffered.end(i) - t);
      } catch {}
    }
    const snapshot = {
      at: performance.now(), bufferAhead: ahead, currentTime: video && Number.isFinite(video.currentTime) && video.currentTime >= 0 ? video.currentTime : null,
      document: id, event, frameMediaTime: d ? d.frameMediaTime : null, frames: d ? d.frames : 0,
      hidden: document.hidden, paused: video ? video.paused : false, ready: document.readyState !== 'loading',
      rootReady: (document.getElementById('root')?.children.length ?? 0) > 0,
      readyState: video ? video.readyState : 0, rvfc: video ? typeof video.requestVideoFrameCallback === 'function' : false,
      seeking: video ? video.seeking : false, sourceLocal, sourceOrdinal: d ? d.sourceOrdinal : 0,
      videoCount: Math.min(document.querySelectorAll('video').length, 64), videoOrdinal: d ? d.ordinal : 0,
    };
    emitted++;
    fetch('/__ipadqa/observe', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', keepalive: true, body: JSON.stringify(snapshot) }).catch(() => {});
  }
  const mountObserver = new MutationObserver(() => {
    if ((document.getElementById('root')?.children.length ?? 0) > 0) {
      mountObserver.disconnect();
      observe('ui-ready', document.querySelector('video'));
    }
  });
  mountObserver.observe(document, { childList: true, subtree: true });
  for (const event of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'timeupdate', 'waiting', 'stalled', 'pause', 'seeking', 'seeked', 'ended', 'error', 'emptied']) {
    document.addEventListener(event, e => {
      if (!(e.target instanceof HTMLVideoElement) || !e.target.isConnected) return;
      const d = data(e.target);
      if (event === 'timeupdate') {
        const now = performance.now();
        if (now - d.lastTimeUpdate < 1000) return;
        d.lastTimeUpdate = now;
      }
      if (event === 'loadeddata' || event === 'playing') watchFrames(e.target, d);
      observe(event, e.target);
    }, true);
  }
  document.addEventListener('DOMContentLoaded', () => observe('arrival', document.querySelector('video')));
  document.addEventListener('visibilitychange', () => observe('visibilitychange', document.querySelector('video')));
  window.addEventListener('pageshow', () => observe('pageshow', document.querySelector('video')));
  window.addEventListener('pagehide', () => observe('pagehide', document.querySelector('video')));
}

export const OBSERVER_SCRIPT = `(${browserObserver.toString()})();\n`;
export function injectObserver(html) {
  if (typeof html !== 'string' || !html.includes('<head>') || html.includes(SCRIPT_PATH)) throw new Error('IPAD_HTML_INJECTION_REFUSED');
  return html.replace('<head>', `<head>\n<script defer src="${SCRIPT_PATH}"></script>`);
}

// Includes every entry except index.html, with path boundaries and content hashes.
// Refuse links and excessive trees instead of following paths out of the build.
export function fingerprintAssets(root) {
  const files = [];
  let bytes = 0, directories = 0;
  function visit(path, relative, depth = 0) {
    if (++directories > 2000 || depth > 32) throw new Error('IPAD_ASSET_LIMIT');
    for (const name of readdirSync(path).sort()) {
      const rel = relative ? `${relative}/${name}` : name;
      const full = join(path, name);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) throw new Error('IPAD_ASSET_SYMLINK_REFUSED');
      if (info.isDirectory()) visit(full, rel, depth + 1);
      else if (info.isFile()) {
        if (rel === 'index.html') continue;
        if (info.size > 16 * 1024 * 1024 || (bytes += info.size) > 100 * 1024 * 1024 || files.length >= 2000) throw new Error('IPAD_ASSET_LIMIT');
        files.push([rel, info.size, createHash('sha256').update(readFileSync(full)).digest('hex')]);
      } else throw new Error('IPAD_ASSET_TYPE_REFUSED');
    }
  }
  visit(root, '');
  return { count: files.length, bytes, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

export function createRecorder(output, origin, mediaOrigin) {
  const salt = randomBytes(32);
  const started = process.hrtime.bigint();
  let records = 0, bytes = 0, failed = false, producer = 0;
  const digest = value => createHash('sha256').update(salt).update(value).digest('hex');
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
  function append(kind, detail) {
    if (failed) return false;
    const line = JSON.stringify({ kind, elapsedMs: elapsed(), ...detail }) + '\n';
    const size = Buffer.byteLength(line);
    if (++records > MAX_RECORDS || bytes + size > MAX_BYTES) {
      failed = true;
      try { writeFileSync(join(output, 'ipad-observer-refused'), 'COLLECTOR_LIMIT\n', { mode: 0o600, flag: 'wx' }); } catch {}
      return false;
    }
    try { appendFileSync(join(output, 'ipad-observations.jsonl'), line, { mode: 0o600 }); bytes += size; return true; }
    catch { failed = true; try { writeFileSync(join(output, 'ipad-observer-refused'), 'COLLECTOR_IO\n', { mode: 0o600, flag: 'wx' }); } catch {} return false; }
  }
  function producerStart(args) {
    const ordinal = ++producer;
    const input = args[args.indexOf('-i') + 1] ?? '';
    let inputLocal = false;
    try { const url = new URL(input); inputLocal = url.origin === mediaOrigin && url.pathname === '/media/synthetic.mp4' && !url.search && !url.hash; } catch {}
    const dir = basename(dirname(args.at(-1) ?? ''));
    const codecIndex = args.findIndex(a => /^-c:v(?::\d+)?$/.test(a));
    const codec = codecIndex >= 0 && ['libx264', 'h264_videotoolbox', 'h264_nvenc', 'h264_qsv'].includes(args[codecIndex + 1]) ? args[codecIndex + 1] : 'other';
    append('producer-start', { ordinal, generation: /^transcode-[A-Za-z0-9_-]{1,100}$/.test(dir) ? digest(dir) : null,
      argvHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'), inputLocal, codec,
      hls: args.includes('hls'), eventPlaylist: args[args.indexOf('-hls_playlist_type') + 1] === 'event',
      segmentSeconds: args[args.indexOf('-hls_time') + 1] === '6' ? 6 : null,
      fixed480: /^(?:v:0)(?:,a:0)?(?:,s:0,sgroup:subs)?,name:480p$/.test(args[args.indexOf('-var_stream_map') + 1] ?? '') });
    return ordinal;
  }
  function response(request, reply) {
    let url;
    try { url = new URL(request.raw.url, origin); } catch { return; }
    const match = /^\/api\/stream\/([^/]+)\/(index\.m3u8|(?:1080p|720p|480p|360p)\.m3u8|(?:1080p|720p|480p|360p)_seg_(\d{5})\.ts)$/.exec(url.pathname);
    if (!match || !['GET', 'HEAD'].includes(request.method)) return;
    const generation = url.searchParams.get('generation') ?? reply.getHeader('x-yawf-hls-snapshot-generation');
    const safeGen = typeof generation === 'string' && /^transcode-[A-Za-z0-9_-]{1,100}$/.test(generation) ? digest(generation) : null;
    const header = name => { const value = reply.getHeader(name); return typeof value === 'string' && value.length <= 16 && /^[A-Za-z0-9._-]+$/.test(value) ? value : null; };
    append('hls-response', { method: request.method, status: reply.statusCode, stream: digest(match[1]), generation: safeGen,
      asset: match[2].replace(/_seg_\d{5}\.ts$/, '_segment.ts'), segment: match[3] === undefined ? null : Number(match[3]),
      quality: header('x-yawf-transcode-quality'), start: header('x-yawf-transcode-start'),
      frontier: header('x-yawf-hls-snapshot-frontier'), endlist: header('x-yawf-hls-snapshot-endlist') });
  }
  return { append, producerStart, response, get failed() { return failed; }, origin };
}

export function installObserverRoutes(app, recorder) {
  app.get(SCRIPT_PATH, async (_request, reply) => reply.header('content-type', 'text/javascript; charset=utf-8').header('cache-control', 'no-store').send(OBSERVER_SCRIPT));
  app.post(COLLECTOR_PATH, { bodyLimit: MAX_BODY_BYTES }, async (request, reply) => {
    if (!allowedCollectorRequest(request.headers, recorder.origin)) return reply.code(403).send();
    if (!validObservation(request.body)) return reply.code(400).send();
    if (!recorder.append('browser', { observation: request.body })) return reply.code(507).send();
    return reply.code(204).send();
  });
}
