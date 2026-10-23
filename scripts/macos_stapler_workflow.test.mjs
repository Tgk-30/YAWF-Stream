import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const release = readFileSync(new URL("../.github/workflows/web-release.yml", import.meta.url), "utf8");
const clean = readFileSync(new URL("../.github/workflows/clean-install.yml", import.meta.url), "utf8");
const ordered = (text, needles) => {
  const positions = needles.map((needle) => text.indexOf(needle));
  return positions.every((position, i) => position >= 0 && (i === 0 || position > positions[i - 1]));
};

function validRelease(text) {
  const start = text.indexOf("      - name: Notarize & staple the macOS DMG\n");
  const end = text.indexOf("  android-tv:\n", start);
  const body = text.slice(start, end);
  return start >= 0 && end > start && body.includes("set -euo pipefail")
    && ordered(body, ["xcrun notarytool submit", 'scripts/macos_stapler_retry.sh staple "$dmg"', 'scripts/macos_stapler_retry.sh validate "$dmg"', 'gh release upload "$tag" "$dmg"'])
    && body.includes('scripts/macos_stapler_retry.sh validate "$dmg"\n')
    && body.includes('STAPLER_RETRY_RECEIPT="$RUNNER_TEMP/yawf-stapler-staple.jsonl"')
    && body.includes('STAPLER_RETRY_RECEIPT="$RUNNER_TEMP/yawf-stapler-validate.jsonl"')
    && body.includes("if: always() && matrix.os == 'macos'")
    && body.includes("${{ runner.temp }}/yawf-stapler-staple.jsonl")
    && body.includes("${{ runner.temp }}/yawf-stapler-validate.jsonl")
    && !/xcrun stapler (?:staple|validate)/.test(body)
    && /android-tv:\n\s+name: Signed Android TV APK\n\s+needs: release/.test(text)
    && /finalize-release-assets:\n\s+name: Checksums and provenance\n\s+needs: \[release, android-tv, android-app-publish\]/.test(text)
    && /clean-install:\n\s+name: Verify clean installs\n\s+needs: finalize-release-assets/.test(text);
}

function validClean(text) {
  const start = text.indexOf("      - name: Install and verify DMG\n");
  const end = text.indexOf("  windows:\n", start);
  const body = text.slice(start, end);
  return start >= 0 && end > start && body.includes("set -euo pipefail")
    && ordered(body, ['codesign --verify --deep --strict --verbose=2 "$app"', 'spctl --assess --type execute --verbose=4 "$app"', 'scripts/macos_stapler_retry.sh validate "$dmg"', 'node scripts/smoke_tauri_server_bundle.mjs "$app"', 'HOME="$clean_home" "$exe"'])
    && body.includes('verification-tools/scripts/macos_stapler_retry.sh validate "$dmg"\n')
    && text.includes("      - name: Checkout pinned stapler verification tools\n")
    && text.includes("          ref: ${{ github.sha }}\n          path: verification-tools\n          sparse-checkout: scripts\n          persist-credentials: false")
    && body.includes('STAPLER_RETRY_RECEIPT="$RUNNER_TEMP/yawf-stapler-clean-install-validate.jsonl"')
    && body.includes("      - name: Preserve clean-install stapler evidence\n        if: always()")
    && body.includes("path: ${{ runner.temp }}/yawf-stapler-clean-install-validate.jsonl")
    && body.includes("          sleep 10\n")
    && !/xcrun stapler validate/.test(body);
}

test("release preserves notarization and requires final validation before upload and dependent gates", () => assert.ok(validRelease(release)));
test("installed DMGs keep independent signature, Gatekeeper, staple, server and clean-launch gates", () => assert.ok(validClean(clean)));
test("individual release-order, validation and evidence mutations are rejected", () => {
  const validation = '            /bin/bash scripts/macos_stapler_retry.sh validate "$dmg"';
  const upload = '          gh release upload "$tag" "$dmg" --clobber --repo "$GITHUB_REPOSITORY"';
  const mutants = [
    release.replace(validation, "            false"),
    release.replace('scripts/macos_stapler_retry.sh validate "$dmg"', 'scripts/macos_stapler_retry.sh validate "$dmg" || true'),
    release.replace(upload, "").replace('          STAPLER_RETRY_RECEIPT="$RUNNER_TEMP/yawf-stapler-staple.jsonl"', `${upload}\n          STAPLER_RETRY_RECEIPT="$RUNNER_TEMP/yawf-stapler-staple.jsonl"`),
    release.replace("Preserve macOS stapler evidence\n        if: always()", "Preserve macOS stapler evidence\n        if: success()"),
    release.replace("${{ runner.temp }}/yawf-stapler-validate.jsonl", "missing.jsonl"),
    release.replace("needs: [release, android-tv, android-app-publish]", "needs: release"),
    release.replace("needs: finalize-release-assets", "needs: release"),
  ];
  for (const mutant of mutants) { assert.notEqual(mutant, release); assert.ok(validRelease(release)); assert.equal(validRelease(mutant), false); }
});
test("individual clean-install validation and retained-evidence mutations are rejected", () => {
  const mutants = [
    clean.replace('scripts/macos_stapler_retry.sh validate "$dmg"', "true"),
    clean.replace('scripts/macos_stapler_retry.sh validate "$dmg"', 'scripts/macos_stapler_retry.sh validate "$dmg" || true'),
    clean.replace("          ref: ${{ github.sha }}\n          path: verification-tools", "          ref: ${{ inputs.tag }}\n          path: verification-tools"),
    clean.replace("Preserve clean-install stapler evidence\n        if: always()", "Preserve clean-install stapler evidence\n        if: success()"),
    clean.replace("path: ${{ runner.temp }}/yawf-stapler-clean-install-validate.jsonl", "path: missing.jsonl"),
    clean.replace('node scripts/smoke_tauri_server_bundle.mjs "$app"', "true"),
  ];
  for (const mutant of mutants) { assert.notEqual(mutant, clean); assert.ok(validClean(clean)); assert.equal(validClean(mutant), false); }
});
