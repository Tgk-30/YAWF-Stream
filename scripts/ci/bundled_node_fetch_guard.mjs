import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXPECTED_NODE = '22.23.4';
export const EXPECTED_UNDICI = '6.29.1';
export const MAX_CHILD_MS = 8000;
export const CHILD_ENV = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' });
// GHSA-xjj6-f33q-929c: reject the coding chain, then close its short response.
export const RESPONSE = 'HTTP/1.1 200 OK\r\nContent-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\nContent-Length: 100\r\nConnection: close\r\n\r\n';
export const RESPONSE_SHA256 = createHash('sha256').update(RESPONSE).digest('hex');
export const CHILD_PROBE = `
import net from 'node:net';
import { once } from 'node:events';
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const sockets = new Set();
let first, firstClosed, connectionCount = 0, requestCount = 0;
const server = net.createServer(socket => {
  if (++connectionCount > 8) throw new Error('fixture-connection-bound');
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  socket.once('data', () => {
    if (++requestCount === 1) {
      first = socket;
      firstClosed = once(socket, 'close');
      socket.write(${JSON.stringify(RESPONSE)});
      emit({ event: 'malformed', encodingCount: 6, advertisedBytes: 100, bodyBytes: 0, payloadSha256: '${RESPONSE_SHA256}' });
    } else if (requestCount === 2) {
      socket.end('HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nok');
    } else throw new Error('fixture-request-bound');
  });
});
try {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  if (server.address().address !== '127.0.0.1') throw new Error('fixture-not-loopback');
  emit({ event: 'ready', nodeVersion: process.versions.node, undiciVersion: process.versions.undici,
    platform: process.platform, architecture: process.arch, loopbackOnly: true });
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  let rejected = false;
  try {
    const response = await fetch(url, { redirect: 'error', credentials: 'omit' });
    await response.arrayBuffer();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    rejected = true;
    emit({ event: 'rejected', errorName: 'TypeError' });
  }
  if (!rejected || !first || !firstClosed) throw new Error('fixture-not-rejected');
  // PID-local handshake: the short-body EOF follows the application's catch.
  first.end();
  await firstClosed;
  const health = await fetch(url, { redirect: 'error', credentials: 'omit' });
  if (health.status !== 200 || await health.text() !== 'ok') throw new Error('fixture-health-failed');
  await new Promise(done => setTimeout(done, 100));
  emit({ event: 'alive', healthStatus: 200, healthBodyBytes: 2, drainMs: 100 });
} finally {
  const closing = new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  const socketCloses = [...sockets].map(socket => once(socket, 'close'));
  for (const socket of sockets) socket.destroy();
  await Promise.all([closing, ...socketCloses]);
  emit({ event: 'closed', connectionCount, requestCount, socketsRemaining: sockets.size });
}
`;
export const PROBE_SHA256 = createHash('sha256').update(CHILD_PROBE).digest('hex');

function exactKeys(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

export function decodeTranscript(text) {
  const result = { valid: false, complete: false, metadata: null, malformed: false, rejected: false, alive: false, closed: false };
  try {
    assert.ok(text.endsWith('\n'));
    const lines = text.slice(0, -1).split('\n');
    const order = ['ready', 'malformed', 'rejected', 'alive', 'closed'];
    assert.ok(lines.length >= 1 && lines.length <= order.length);
    for (const [index, line] of lines.entries()) {
      const event = JSON.parse(line);
      assert.equal(event.event, order[index]);
      if (index === 0) {
        exactKeys(event, ['event', 'nodeVersion', 'undiciVersion', 'platform', 'architecture', 'loopbackOnly']);
        for (const key of ['nodeVersion', 'undiciVersion']) assert.match(event[key], /^\d{1,3}\.\d{1,3}\.\d{1,3}$/);
        assert.ok(['darwin', 'linux', 'win32'].includes(event.platform));
        assert.ok(['arm64', 'x64'].includes(event.architecture));
        assert.equal(event.loopbackOnly, true);
        result.metadata = { nodeVersion: event.nodeVersion, undiciVersion: event.undiciVersion,
          platform: event.platform, architecture: event.architecture };
      } else if (index === 1) {
        assert.deepEqual(event, { event: 'malformed', encodingCount: 6, advertisedBytes: 100, bodyBytes: 0, payloadSha256: RESPONSE_SHA256 });
        result.malformed = true;
      } else if (index === 2) {
        assert.deepEqual(event, { event: 'rejected', errorName: 'TypeError' });
        result.rejected = true;
      } else if (index === 3) {
        assert.deepEqual(event, { event: 'alive', healthStatus: 200, healthBodyBytes: 2, drainMs: 100 });
        result.alive = true;
      } else {
        exactKeys(event, ['event', 'connectionCount', 'requestCount', 'socketsRemaining']);
        assert.ok(Number.isInteger(event.connectionCount) && event.connectionCount >= 2 && event.connectionCount <= 8);
        assert.equal(event.requestCount, 2);
        assert.equal(event.socketsRemaining, 0);
        result.closed = true;
      }
    }
    result.valid = true;
    result.complete = lines.length === order.length;
  } catch {
    // Invalid child data is never copied into the receipt or treated as proof.
    result.valid = false;
  }
  return result;
}

async function binaryDigest(binary) {
  const before = await lstat(binary);
  assert.ok(before.isFile() && !before.isSymbolicLink() && (before.mode & 0o111) !== 0);
  assert.ok(before.size > 0 && before.size <= 256 * 1024 * 1024);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(binary)) {
    bytes += chunk.length;
    assert.ok(bytes <= 256 * 1024 * 1024);
    hash.update(chunk);
  }
  const after = await lstat(binary);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key]);
  assert.equal(bytes, before.size);
  return hash.digest('hex');
}

async function collectChild(binary, cwd, spawnImpl, timeoutMs) {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= MAX_CHILD_MS);
  return new Promise(resolveChild => {
    let stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0;
    let timedOut = false, outputBoundExceeded = false, spawnError = false, killed = false;
    const child = spawnImpl(binary, ['--input-type=module', '-e', CHILD_PROBE],
      { cwd, env: { ...CHILD_ENV }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const stop = () => { if (!killed) { killed = true; child.kill('SIGKILL'); } };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 8192) { outputBoundExceeded = true; stop(); }
      else stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > 16384) { outputBoundExceeded = true; stop(); }
      else stderr += chunk.toString('utf8');
    });
    child.once('error', () => { spawnError = true; });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      const stderrClass = stderrBytes === 0 ? 'none'
        : stderr.includes("Unhandled 'error' event") && stderr.includes('UND_ERR_RES_CONTENT_LENGTH_MISMATCH')
          ? 'advisory-orphaned-stream' : 'unexpected';
      resolveChild({ transcript: decodeTranscript(stdout), exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: signal === null ? null : ['SIGKILL', 'SIGTERM', 'SIGABRT', 'SIGSEGV'].includes(signal) ? signal : 'other',
        timedOut, outputBoundExceeded, spawnError, stderrBytes, stderrClass });
    });
  });
}

export async function runGuard({ binary, sha256, output }, { spawnImpl = spawn, timeoutMs = MAX_CHILD_MS } = {}) {
  assert.equal(typeof binary, 'string'); assert.ok(binary.length > 0);
  assert.match(sha256, /^[a-f0-9]{64}$/);
  assert.equal(typeof output, 'string'); assert.ok(output.length > 0);
  binary = resolve(binary); output = resolve(output);
  const parent = dirname(output);
  assert.equal(await realpath(parent), parent);
  await assert.rejects(lstat(output), error => error.code === 'ENOENT');
  assert.equal(await binaryDigest(binary), sha256);
  const observation = await collectChild(binary, parent, spawnImpl, timeoutMs);
  const unchanged = await binaryDigest(binary) === sha256;
  const { transcript, ...execution } = observation;
  const versionsMatch = transcript.metadata?.nodeVersion === EXPECTED_NODE && transcript.metadata?.undiciVersion === EXPECTED_UNDICI;
  const pass = unchanged && versionsMatch && transcript.valid && transcript.complete
    && transcript.malformed && transcript.rejected && transcript.alive && transcript.closed
    && execution.exitCode === 0 && execution.signal === null && !execution.timedOut
    && !execution.outputBoundExceeded && !execution.spawnError && execution.stderrBytes === 0;
  const receipt = { schemaVersion: 1, result: pass ? 'pass' : 'fail', scope: 'isolated-loopback-bundled-fetch-only',
    advisory: 'GHSA-xjj6-f33q-929c', expectedNode: EXPECTED_NODE, expectedUndici: EXPECTED_UNDICI,
    binarySha256: sha256, probeSha256: PROBE_SHA256, payloadSha256: RESPONSE_SHA256,
    metadata: transcript.metadata, checks: { binaryUnchanged: unchanged, versionsMatch, validTranscript: transcript.valid,
      excessiveCodingShortBodyServed: transcript.malformed, fetchRejectionHandled: transcript.rejected,
      aliveAfterRejection: transcript.alive, ownedServerClosed: transcript.closed }, execution };
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return receipt;
}

export function parseArgs(args) {
  assert.equal(args.length, 6);
  const result = {};
  const names = { '--binary': 'binary', '--sha256': 'sha256', '--output': 'output' };
  for (let index = 0; index < args.length; index += 2) {
    assert.ok(Object.hasOwn(names, args[index]));
    const key = names[args[index]];
    assert.ok(key && !Object.hasOwn(result, key));
    assert.equal(typeof args[index + 1], 'string'); assert.ok(args[index + 1].length > 0);
    result[key] = args[index + 1];
  }
  assert.equal(Object.keys(result).length, 3);
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const receipt = await runGuard(parseArgs(process.argv.slice(2)));
    process.stdout.write(receipt.result === 'pass' ? 'Bundled Node fetch guard passed.\n' : 'Bundled Node fetch guard failed.\n');
    process.exitCode = receipt.result === 'pass' ? 0 : 1;
  } catch {
    process.stderr.write('Bundled Node fetch guard refused.\n');
    process.exitCode = 1;
  }
}
