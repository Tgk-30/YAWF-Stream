import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflow = readFileSync(
  join(root, ".github/workflows/android-runtime-check.yml"),
  "utf8",
);

test("pins the exact verification artifact while retaining the published channel", () => {
  assert.match(workflow, /CANDIDATE_RUN_ID: "39360393490"/);
  assert.match(workflow, /CANDIDATE_SOURCE_SHA: d9f19d0c3522751d2ef5edfdcf32affabf59c893/);
  assert.match(workflow, /CANDIDATE_APK_SHA256: c4c9050540a702ee902a9109b726b38dca6ef77998b1ad8af24636a5171b7cf5/);
  assert.match(workflow, /name: android-phone-verification-candidate/);
  assert.match(workflow, /CANDIDATE_VERSION: 2\.3\.25/);
  assert.match(workflow, /CANDIDATE_VERSION_CODE: "2003025"/);
  assert.match(workflow, /PUBLISHED_ANDROID_VERSION: 2\.3\.21/);
});

test("verifies the pinned APK and production invariants before generating local metadata", () => {
  const pinnedHashCheck = workflow.indexOf(
    `printf '%s  %s\\n' "$CANDIDATE_APK_SHA256" "$CANDIDATE_APK" | sha256sum -c -`,
  );
  const manifestBuild = workflow.indexOf(
    "node candidate-source/scripts/build_android_update_manifest.mjs",
  );
  const productionVerification = workflow.indexOf(
    "python3 candidate-source/scripts/verify_android_apk.py",
  );
  assert.ok(pinnedHashCheck >= 0);
  assert.ok(productionVerification > pinnedHashCheck);
  assert.ok(manifestBuild > productionVerification);
});

test("generates explicitly local verification metadata from the pinned candidate source", () => {
  assert.match(
    workflow,
    /name: Verify exact APK and signer with local verification metadata/,
  );
  assert.match(
    workflow,
    /local_metadata_dir="\$\(pwd\)\/\$EVIDENCE\/local-generated-verification-metadata"/,
  );
  assert.match(
    workflow,
    /node candidate-source\/scripts\/build_android_update_manifest\.mjs[\s\S]*--apk "\$CANDIDATE_APK"[\s\S]*--version "\$CANDIDATE_VERSION"[\s\S]*--source "\$CANDIDATE_SOURCE_SHA"[\s\S]*--output "\$local_metadata_dir\/android-update\.json"/,
  );
  assert.match(workflow, /classification=locally-generated-runtime-verification-metadata/);
  assert.match(workflow, /releaseAsset=false/);
  assert.match(workflow, /otaPublicationEvidence=false/);
  assert.doesNotMatch(workflow, /candidate\/android-update\.json/);
});

test("checks local metadata while retaining package version source and signer gates", () => {
  assert.match(
    workflow,
    /sha256sum -c "\$local_metadata_dir\/SHA256SUMS"/,
  );
  assert.match(
    workflow,
    /Path\(os\.environ\["LOCAL_METADATA_DIR"\]\) \/ "android-update\.json"/,
  );
  assert.match(workflow, /manifest\["sourceRevision"\] == os\.environ\["CANDIDATE_SOURCE_SHA"\]/);
  assert.match(workflow, /manifest\["apk"\]\["sha256"\] == os\.environ\["CANDIDATE_APK_SHA256"\]/);
  assert.match(workflow, /apkanalyzer manifest application-id "\$CANDIDATE_APK"/);
  assert.match(workflow, /apkanalyzer manifest version-name "\$CANDIDATE_APK"/);
  assert.match(workflow, /apkanalyzer manifest version-code "\$CANDIDATE_APK"/);
  assert.match(workflow, /candidate-source\/scripts\/verify_android_apk\.py/);
  assert.match(workflow, /--certificate-pin candidate-source\/web\/src-tauri\/SIGNING_CERT_SHA256/);
});
