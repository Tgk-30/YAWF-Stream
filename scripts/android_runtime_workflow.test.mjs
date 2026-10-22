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
const api30RuntimeStart = workflow.indexOf("  api30-runtime:");
const api30GuideStart = workflow.indexOf("  api30-stock-webview-guide:");
assert.ok(api30RuntimeStart >= 0 && api30GuideStart > api30RuntimeStart);
const api30Runtime = workflow.slice(api30RuntimeStart, api30GuideStart);

const otaPolicyMutationCommand =
  'python3 scripts/android-runtime-instrumentation/ota_policy_mutation_check.py \\\n' +
  '            | tee "$EVIDENCE/ota-policy-mutations.json"';

function validateOtaPolicyMutationGate(source) {
  const failures = [];
  const generalPolicy = source.indexOf(
    "python3 scripts/android-runtime-instrumentation/policy_mutation_check.py",
  );
  const otaPolicy = source.indexOf(otaPolicyMutationCommand);
  const gradle = source.indexOf("          gradle \\");
  if (generalPolicy < 0) failures.push("general policy mutation gate is missing");
  if (otaPolicy < 0) failures.push("exact OTA policy mutation gate is missing");
  if ((source.match(/ota_policy_mutation_check\.py/g) ?? []).length !== 1) {
    failures.push("OTA policy mutation gate must occur exactly once");
  }
  if (!(generalPolicy < otaPolicy && otaPolicy < gradle)) {
    failures.push("OTA policy mutation gate must follow general policy mutants and precede Gradle");
  }
  return failures;
}

test("pins the exact verification artifact while retaining the published channel", () => {
  assert.match(api30Runtime, /CANDIDATE_RUN_ID: "39834571270"/);
  assert.match(api30Runtime, /CANDIDATE_SOURCE_SHA: 72bd21cf466d495349617bc3fab7a1ec59687c84/);
  assert.match(api30Runtime, /CANDIDATE_APK_SHA256: 5029ad310fb15a93c2e2c29cb814e6a0c2dde2d2b0cfb239402553c77097c058/);
  assert.match(api30Runtime, /name: android-phone-verification-candidate/);
  assert.match(api30Runtime, /CANDIDATE_VERSION: 2\.3\.30/);
  assert.match(api30Runtime, /CANDIDATE_VERSION_CODE: "2003030"/);
  assert.match(api30Runtime, /PUBLISHED_ANDROID_VERSION: 2\.3\.27/);
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

test("runs OTA policy baselines and mutants before Gradle", () => {
  assert.deepEqual(validateOtaPolicyMutationGate(workflow), []);

  const omission = workflow.replace(otaPolicyMutationCommand, "");
  assert.notDeepEqual(validateOtaPolicyMutationGate(omission), []);

  const wrongScript = workflow.replace(
    "ota_policy_mutation_check.py",
    "ota_policy_assertions_only.py",
  );
  assert.notDeepEqual(validateOtaPolicyMutationGate(wrongScript), []);

  const reordered = workflow
    .replace(otaPolicyMutationCommand + "\n", "")
    .replace("          gradle \\", "          gradle \\\n" + otaPolicyMutationCommand);
  assert.notDeepEqual(validateOtaPolicyMutationGate(reordered), []);
});
