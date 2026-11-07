import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureConfig, fixtureIdentifier, pinnedMedia, prepareLinkerDirectory, runMacosQualification } from './run_macos.mjs';

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

test('native qualification is triggered by the production admission and IPC dependencies', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/desktop-update-runtime.yml', import.meta.url), 'utf8');
  for (const path of ['web/src/lib/attention.ts', 'web/src/lib/updater.ts', 'web/src/lib/renderPlayer.ts', 'web/src/lib/tauri.ts', 'web/src/components/VideoPlayer.tsx', 'web/src/components/EmbeddedPlayer.tsx', 'web/src/components/UpdateBanner.tsx', 'web/src-tauri/src/**', 'web/src-tauri/entitlements.plist', 'web/src-tauri/tauri*.conf.json', 'web/src-tauri/capabilities/**', 'web/src-tauri/permissions/**', 'web/src-tauri/Cargo.lock', 'web/package-lock.json']) assert.ok(workflow.includes(`      - '${path}'`), `Missing native regression trigger for ${path}`);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /contents: write/);
});

test('development linker alias does not mutate the verified runtime bundle', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yawf-update-linker-'));
  try {
    const frameworks = join(workspace, 'verified-runtime'); await mkdir(frameworks);
    const mpv = join(frameworks, 'libmpv.2.dylib'); await writeFile(mpv, 'unchanged-runtime-fixture');
    const linker = await prepareLinkerDirectory(workspace, mpv);
    assert.equal(await readlink(join(linker, 'libmpv.dylib')), mpv);
    assert.equal(await readFile(join(linker, 'libmpv.dylib'), 'utf8'), 'unchanged-runtime-fixture');
    assert.deepEqual(await readdir(frameworks), ['libmpv.2.dylib']);
    assert.equal(await readFile(mpv, 'utf8'), 'unchanged-runtime-fixture');
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
