import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

export const requiredBaseStages = ['boot', 'playing', 'paused-update-deferred', 'destroy-requested', 'destroy-update-deferred', 'destroy-acknowledged', 'install-requested'];
export const requiredNextStages = ['boot', 'playing', 'paused', 'seeked', 'resumed', 'destroy-requested', 'destroy-acknowledged', 'completed'];

export function verifyRuntimeEvents(events, requests, baseVersion, nextVersion) {
  const base = events.filter((event) => event.version === baseVersion);
  let previous = -1;
  for (const stage of requiredBaseStages) {
    const index = base.findIndex((event) => event.stage === stage);
    if (index <= previous) throw new Error(`Missing or out-of-order base event: ${stage}`);
    previous = index;
  }
  if (events.some((event) => event.stage === 'failed')) throw new Error('Native frontend reported failure');
  const reboot = events.find((event) => event.version === nextVersion && event.stage === 'boot');
  const completed = events.find((event) => event.version === nextVersion && event.stage === 'completed');
  const acknowledged = base.find((event) => event.stage === 'destroy-acknowledged');
  const installation = base.find((event) => event.stage === 'install-requested');
  const payload = requests.filter((request) => request.path === '/update.tar.gz');
  if (!reboot || !completed || completed.sequence <= reboot.sequence || reboot.sequence <= installation.sequence) throw new Error('No ordered next-version native playback completion');
  const next = events.filter((event) => event.version === nextVersion);
  previous = -1;
  for (const stage of requiredNextStages) {
    const index = next.findIndex((event) => event.stage === stage);
    if (index <= previous) throw new Error(`Missing or out-of-order next-version event: ${stage}`);
    previous = index;
  }
  const seek = next.find((event) => event.stage === 'seeked').detail;
  const resume = next.find((event) => event.stage === 'resumed').detail;
  const duration = next.find((event) => event.stage === 'playing').detail?.duration;
  if (!seek || !Number.isFinite(seek.position) || !Number.isFinite(seek.target) || !Number.isFinite(seek.seekFrom) || seek.target < 0 || seek.target >= duration || Math.abs(seek.target - seek.seekFrom) < 1 || Math.abs(seek.position - seek.target) > 0.35 || seek.paused !== true) throw new Error('No actual changed-position paused native seek observation');
  if (!resume || !Number.isFinite(resume.position) || !Number.isFinite(resume.resumedFrom) || Math.abs(resume.resumedFrom - seek.position) > 0.35 || resume.position < resume.resumedFrom + 0.5) throw new Error('No actual advancing native resume observation');
  for (const event of events.filter((event) => event.stage === 'playing')) {
    if (!(event.detail?.position >= 0.75 && event.detail?.duration >= 8 && event.detail?.width > 0 && event.detail?.activity === true)) throw new Error('Native playback observation is incomplete');
  }
  for (const event of events.filter((event) => event.stage === 'destroy-acknowledged')) {
    if (event.detail?.actualNativePromise !== true || event.detail?.activity !== false) throw new Error('Native destruction acknowledgement is incomplete');
  }
  if (payload.length !== 1 || payload[0].sequence <= acknowledged.sequence || payload[0].sequence <= installation.sequence) throw new Error('Payload was requested before native destruction, or more than once');
  return { baseStages: requiredBaseStages, nextStages: requiredNextStages, nextVersionBoot: true, nextVersionPlaybackCompleted: true, payloadRequests: payload.length };
}

/** Loopback-only, disposable media/feed observer. It has no production data. */
export async function startRuntimeService({ runId, mediaPath, archivePath, signature, baseVersion, nextVersion }) {
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Expected a fresh UUID correlation identifier');
  const events = [], requests = [];
  let sequence = 0, address;
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Cache-Control', 'no-store');
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
      if (request.method === 'POST' && url.pathname === '/events') {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 8192) { response.writeHead(413).end(); return; }
        }
        const event = JSON.parse(body);
        if (event.runId !== runId || ![baseVersion, nextVersion].includes(event.version) || !/^[a-z][a-z0-9-]{0,63}$/.test(event.stage) || events.length >= 128) { response.writeHead(400).end(); return; }
        events.push({ ...event, sequence: ++sequence, observedAt: new Date().toISOString() });
        response.writeHead(204).end(); return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      requests.push({ path: url.pathname, method: request.method, sequence: ++sequence, observedAt: new Date().toISOString(), range: request.headers.range ?? null });
      if (requests.length > 2048) throw new Error('Fixture request budget exceeded');
      if (url.pathname === '/latest.json') {
        const currentSignature = typeof signature === 'function' ? signature() : signature;
        if (!currentSignature) { response.writeHead(503).end(); return; }
        const manifest = { version: nextVersion, notes: 'Disposable native installer fixture, not a public release', pub_date: '2026-11-07T00:00:00Z', url: `${address}/update.tar.gz`, signature: currentSignature };
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(manifest)); return;
      }
      const file = url.pathname === '/fixture.mp4' ? mediaPath : url.pathname === '/update.tar.gz' ? archivePath : null;
      if (!file) { response.writeHead(404).end(); return; }
      const { size } = await stat(file);
      let start = 0, end = size - 1;
      if (request.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
        if (!match || Number(match[1]) >= size || (match[2] && Number(match[2]) < Number(match[1]))) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
        start = Number(match[1]); end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
        response.statusCode = 206;
        response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      }
      response.setHeader('Accept-Ranges', 'bytes');
      response.setHeader('Content-Type', file === mediaPath ? 'video/mp4' : 'application/gzip');
      response.setHeader('Content-Length', end - start + 1);
      if (request.method === 'HEAD') { response.end(); return; }
      const stream = createReadStream(file, { start, end });
      response.on('close', () => stream.destroy());
      stream.on('error', (error) => response.destroy(error));
      stream.pipe(response);
    } catch (error) { response.writeHead(500).end(String(error.message).slice(0, 300)); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  address = `http://127.0.0.1:${server.address().port}`;
  return { address, events, requests, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}
