import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../.github/workflows/android-tv-candidate.yml', import.meta.url), 'utf8');

test('TV candidate dispatch is private, branch-only and never publishes', () => {
  assert.match(source, /on:\n  workflow_dispatch:\n/);
  assert.doesNotMatch(source, /\n  (?:push|pull_request|schedule):/);
  assert.match(source, /permissions:\n  contents: read/);
  assert.match(source, /if: github\.event_name == 'workflow_dispatch' && github\.ref_type == 'branch'/);
  assert.doesNotMatch(source, /contents: write|packages: write|gh release|git push|gh api|GH_TOKEN|TAURI_SIGNING|ANDROID_APP_KEY/);
  assert.match(source, /name: android-tv-verification-candidate/);
  assert.match(source, /"published": False/);
  assert.match(source, /"runtimeProof": False/);
});

test('TV candidate tests and verifies exact signed identity before retaining bytes', () => {
  assert.match(source, /--rerun-tasks :app:testDebugUnitTest :app:lintRelease :app:assembleRelease/);
  assert.match(source, /apksigner" verify --print-certs/);
  assert.match(source, /test "\$actual" = "\$expected"/);
  assert.match(source, /test "\$\(grep -c '\^Signer #\[0-9\]\* certificate SHA-256 digest:'[^\n]+\)" = 1/);
  for (const key of ['application-id', 'version-name', 'version-code']) {
    assert.match(source, new RegExp(`manifest ${key} `));
  }
  assert.match(source, /"sourceRevision": os\.environ\["GITHUB_SHA"\]/);
  assert.match(source, /"sha256": hashlib\.sha256\(p\.read_bytes\(\)\)\.hexdigest\(\)/);
  assert.match(source, /"signerSha256": os\.environ\["SIGNER"\]/);
  assert.ok(source.indexOf('Verify candidate identity') < source.indexOf('uses: actions/upload-artifact'));
  assert.match(source, /Remove temporary signing material\n        if: always\(\)/);
  assert.match(source, /umask 077/);
});
