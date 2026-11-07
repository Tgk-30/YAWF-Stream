import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requiredBaseStages, requiredNextStages, startRuntimeService, verifyRuntimeEvents } from './runtime-service.mjs';

test('runtime observer requires an ordered, single-payload two-version transaction', () => {
  const details = { playing: { position: 1, duration: 40, width: 320, activity: true }, 'destroy-acknowledged': { actualNativePromise: true, activity: false }, seeked: { target: 3, position: 3, paused: true }, resumed: { resumedFrom: 3, position: 3.75 } };
  const events = requiredBaseStages.map((stage, index) => ({ stage, version: '1.0.0', sequence: index + 1, detail: details[stage] }));
  events.push(...requiredNextStages.map((stage, index) => ({ stage, version: '1.0.1', sequence: index + 9, detail: details[stage] })));
  const request = { path: '/update.tar.gz', sequence: 8 };
  assert.equal(verifyRuntimeEvents(events, [request], '1.0.0', '1.0.1').nextVersionPlaybackCompleted, true);
  for (const stage of requiredBaseStages) assert.throws(() => verifyRuntimeEvents(events.filter((event) => event.stage !== stage || event.version !== '1.0.0'), [request], '1.0.0', '1.0.1'));
  for (const stage of requiredNextStages) assert.throws(() => verifyRuntimeEvents(events.filter((event) => event.stage !== stage || event.version !== '1.0.1'), [request], '1.0.0', '1.0.1'));
  for (const stage of ['playing', 'destroy-acknowledged', 'seeked', 'resumed']) assert.throws(() => verifyRuntimeEvents(events.map((event) => event.stage === stage ? { ...event, detail: {} } : event), [request], '1.0.0', '1.0.1'));
  assert.throws(() => verifyRuntimeEvents(events, [{ ...request, sequence: 5 }], '1.0.0', '1.0.1'));
  assert.throws(() => verifyRuntimeEvents(events, [request, request], '1.0.0', '1.0.1'));
  assert.throws(() => verifyRuntimeEvents(events.slice(0, -1), [request], '1.0.0', '1.0.1'));
  assert.throws(() => verifyRuntimeEvents([...events, { stage: 'failed', version: '1.0.1' }], [request], '1.0.0', '1.0.1'));
});

test('disposable service confines data, rejects foreign events, and serves byte ranges', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yawf-update-observer-'));
  const mediaPath = join(directory, 'fixture.mp4'), archivePath = join(directory, 'update.tar.gz');
  await writeFile(mediaPath, 'abcdefghij'); await writeFile(archivePath, 'signed-fixture-bytes');
  const runId = randomUUID();
  const service = await startRuntimeService({ runId, mediaPath, archivePath, signature: 'test-signature', baseVersion: '1.0.0', nextVersion: '1.0.1' });
  try {
    assert.match(service.address, /^http:\/\/127\.0\.0\.1:\d+$/);
    const send = (id) => fetch(`${service.address}/events`, { method: 'POST', body: JSON.stringify({ runId: id, version: '1.0.0', stage: 'boot' }) });
    assert.equal((await send(randomUUID())).status, 400); assert.equal(service.events.length, 0);
    assert.equal((await send(runId)).status, 204); assert.equal(service.events.length, 1);
    const partial = await fetch(`${service.address}/fixture.mp4`, { headers: { Range: 'bytes=2-5' } });
    assert.equal(partial.status, 206); assert.equal(partial.headers.get('Content-Range'), 'bytes 2-5/10'); assert.equal(await partial.text(), 'cdef');
    assert.equal((await fetch(`${service.address}/fixture.mp4`, { headers: { Range: 'bytes=10-' } })).status, 416);
    assert.equal((await fetch(`${service.address}/../outside`)).status, 404);
    const manifest = await (await fetch(`${service.address}/latest.json`)).json();
    assert.equal(manifest.signature, 'test-signature'); assert.equal(manifest.url, `${service.address}/update.tar.gz`);
    assert.equal((await fetch(`${service.address}/update.tar.gz`)).status, 200);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
