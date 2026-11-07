import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureConfig, fixtureIdentifier, pinnedMedia, runMacosQualification } from './run_macos.mjs';

test('native fixture cannot be mistaken for or configure the production updater', () => {
  const inputs = { version: '2.3.101', publicKey: 'test-only-public-key', baseUrl: 'http://127.0.0.1:12345', frontend: '/test/frontend', frameworks: ['/test/libmpv.2.dylib'] };
  const config = fixtureConfig(inputs);
  assert.equal(config.identifier, fixtureIdentifier); assert.notEqual(config.identifier, 'com.tgk30.debridstreamer');
  assert.equal(config.bundle.createUpdaterArtifacts, false); assert.deepEqual(config.bundle.resources, []);
  assert.equal(config.plugins.updater.pubkey, inputs.publicKey); assert.deepEqual(config.plugins.updater.endpoints, [`${inputs.baseUrl}/latest.json`]);
  for (const baseUrl of ['https://example.com', 'http://localhost:12345', 'http://192.168.1.1:12345', 'http://127.0.0.1:12345/path', 'http://a:b@127.0.0.1:12345', 'http://127.0.0.1:12345/?key=value', 'http://127.0.0.1:12345/#fragment']) assert.throws(() => fixtureConfig({ ...inputs, baseUrl }));
  assert.throws(() => fixtureConfig({ ...inputs, version: '2.3.76' }));
  assert.equal(Object.keys(pinnedMedia).length, 2);
  for (const item of Object.values(pinnedMedia)) assert.match(item.sha256, /^[0-9a-f]{64}$/);
});

test('qualification refuses the user workstation before creating fixtures', async () => {
  const original = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = 'false';
  try { await assert.rejects(runMacosQualification(), /disposable GitHub macOS runner/); }
  finally { if (original === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = original; }
});
