import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PINS } from './admit_desktop96_recovery.mjs';
const text = readFileSync(new URL('../../.github/workflows/web-release.yml', import.meta.url), 'utf8');
const source = '2edc189a33539bf1742435590810fb84aa653ce5';
const start = text.indexOf('  release:\n'), end = text.indexOf('  finalize-release-assets:\n', start);
const release = text.slice(start, end);
const headers = [...release.matchAll(/^      - name: (.+)$/gm)];
const steps = Object.fromEntries(headers.map((m, i) => [m[1], release.slice(m.index, headers[i + 1]?.index ?? release.length).trimEnd()]));
const frozen = {
  "Build, bundle, sign & release": "8d84341617774b73e0ceba014ee56e14a3ce9a0ed5aa477ef8f7f4afba65c29b",
  "Validate updater signing secret": "7ad8d36d55cefd002ae9b96ffacdc1ec1fef24a1480e1cfbed27d9b1cb1c753a",
  "Validate macOS signing secrets": "1cab63303e3101155cc9c57ccda9504c0e0acf97b0b1e0316f85424a8f94aed8",
  "Import Developer ID certificate": "759c7b14511c4016f5124bf00b9b4aabea3737fa033172c349a7f468b4fcca3e",
  "Bundle libmpv + deps (native arch) and sign them": "14c3cab02f9c96eafafae497a19c9488da859a5ebe0e0e4479534d8aaa7789d8",
  "Sign bundled ffmpeg (macOS)": "891b036b401ce036dbbd809e0d3d2c5b80079917fcda45ed4a04ca65c78da1f4",
  "Test frontend": "43be8bce33b21b40bfa5f5bcd656e056fe9730ec83fc5f1e215da250a18a80a4",
  "Test server": "6c2d4167dba6f1cc54b84257d9221cb6b216347bc2e021cc92f8a036fe00a282",
  "Smoke desktop server resources": "6ba4beb25bf7b0c8002cca3a7a1db3e714dc51e8ed95a93df7b047073d929880",
  "Verify macOS bundle deployment minima": "e01a9d0a70d7d8e75f9f8992edf1e022719be4b651f93d38a94bf7dfc5f74a1e",
  "Notarize & staple the macOS DMG": "83c3fe16f760024d2bba2d5e64162b9b3967e5d01f1978fe520eeef91b204e78"
};
for (const [name, hash] of Object.entries(frozen)) test(`retains frozen release gate: ${name}`, () => {
  assert.equal(createHash('sha256').update(steps[name]).digest('hex'), hash);
});
test('manual fixed owner and branch only, no tag or branch push build', () => {
  const trigger = text.slice(text.indexOf('on:'), text.indexOf('permissions:'));
  assert.equal(trigger.trim(), 'on:\n  workflow_dispatch:');
  assert.match(text, /if: github.event_name == 'workflow_dispatch' && github.repository == 'Tgk-30\/YAWF-Stream' && github.actor == 'Tgk-30' && github.ref == 'refs\/heads\/codex\/desktop96-recovery'/);
  assert.match(text, /cancel-in-progress: false/);
});
test('source, tag and clean-install gates are immutable, all shipping desktop platforms required', () => {
  assert.equal((text.match(new RegExp(`ref: ${source}`, 'g')) ?? []).length, 2);
  assert.match(text, new RegExp(`clean-install.yml@${source}`));
  assert.match(text, /tagName: v2\.3\.96-web/); assert.match(text, /tag: v2\.3\.96-web/);
  for (const platform of ['macos-15', 'macos-15-intel', 'ubuntu-24.04']) assert.ok(release.includes(`- platform: ${platform}\n`));
  assert.doesNotMatch(release, /- platform: windows-/);
  assert.doesNotMatch(text, /^  macos-media-runtime:/m);
  assert.match(text, /include_windows: \$\{\{ vars.YAWF_RELEASE_WINDOWS == 'true' \}\}/);
  for (const channel of ['android','server']) assert.match(text, new RegExp(`include_${channel}: false`));
});
test('archive pin admission precedes extraction, natural smoke precedes certificate import', () => {
  const names = headers.map(x => x[1]);
  assert.ok(names.indexOf('Verify and extract archived macOS media transport') < names.indexOf('Retest natural media runtime after artifact transport'));
  assert.ok(names.indexOf('Retest natural media runtime after artifact transport') < names.indexOf('Import Developer ID certificate'));
  const s = steps['Verify and extract archived macOS media transport'];
  assert.ok(s.indexOf('validate_desktop96_media_recovery.py') < s.indexOf('tar -xzf'));
  assert.match(s, /--arch "\$MEDIA_ARCH" --sha256 "\$MEDIA_SHA256"/);
  assert.match(steps['Fetch verified source-built macOS media runtime'], /artifact-ids: \$\{\{ matrix.media_artifact \}\}/);
  assert.match(steps['Fetch verified source-built macOS media runtime'], /run-id: \$\{\{ matrix.media_run \}\}/);
});
test('finalization and clean-install cannot skip failed or cancelled ancestors', () => {
  assert.equal((text.match(/if: always\(\) && !cancelled\(\) && needs.release-scope.result == 'success' && needs.(release|finalize-release-assets).result == 'success'/g) ?? []).length, 2);
  assert.match(text, /needs: \[release-scope, release\]/);
  assert.match(text, /needs: \[release-scope, finalize-release-assets\]/);
});

test('native archive and API artifact pins cannot drift between admission and consumers', () => {
  assert.match(release, /needs: release-scope/);
  assert.match(release, /if: needs.release-scope.result == 'success'/);
  const native = arch => {
    const key = `            media_arch: ${arch}\n`;
    const a = release.indexOf(key); assert.ok(a > 0);
    return release.slice(a, release.indexOf('            rust_target:', a));
  };
  const arm = native('arm64'), intel = native('x86_64');
  for (const [body, run, artifact, sha] of [[arm, PINS.originalRun, PINS.armArtifact, PINS.armArchiveSha256], [intel, PINS.intelRun, PINS.intelArtifact, PINS.intelArchiveSha256]]) {
    assert.ok(body.includes(`media_run: ${run}\n`)); assert.ok(body.includes(`media_artifact: ${artifact}\n`)); assert.ok(body.includes(`media_sha256: ${sha}\n`));
  }
});

// Preserve the original out-of-scope security policy byte-for-byte. These jobs
// require desktop_only=false; admission emits only true and trigger is manual.
const heldChannelJobs = {
  "android-tv": "8cb898db162742923914d39316e4767ac41ec6bdf947b1a969ed1eee7a211d7c",
  "android-app": "2c4c48e19a85dbd4f8dbef1dee565ef0033cb72a2286c045c7c73100d3ba4de3",
  "android-app-publish": "d2fcb76e71368664c35093da9f5c8d8d649d5418a140f1e9a1cd946672a8a6ca"
};
for (const [name, hash] of Object.entries(heldChannelJobs)) test(`preserves disabled security baseline: ${name}`, () => {
  const a = text.indexOf(`  ${name}:\n`); assert.ok(a > 0);
  const next = /^  [a-zA-Z0-9-]+:\n/m.exec(text.slice(a + 1));
  const body = text.slice(a, next ? a + 1 + next.index : text.length).trimEnd();
  assert.equal(createHash('sha256').update(body).digest('hex'), hash);
  assert.ok(body.includes("needs.release-scope.outputs.desktop_only == 'false'"));
});
