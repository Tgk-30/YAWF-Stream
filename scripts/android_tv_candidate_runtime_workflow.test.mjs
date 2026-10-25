import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/android-tv-candidate-runtime.yml", import.meta.url),
  "utf8",
);
const historical = readFileSync(
  new URL("../.github/workflows/android-tv-runtime.yml", import.meta.url),
  "utf8",
);

const runtimeMarker = "      - name: Set up JDK, Android SDK, and isolated Gradle\n";
const classificationBlock = `          cat > "$EVIDENCE/run-1/proof-classification.txt" <<'EOF'\n` +
  `          classification=private-production-signed-candidate-fixture-proof\n` +
  `          publishedTvProof=false\n` +
  `          releaseAssetProof=false\n` +
  `          EOF\n`;

function assertCandidateContract(source) {
  assert.match(source, /on:\n  workflow_dispatch:\n/);
  assert.match(source, /push:\n    branches:\n      - codex\/qa-platform-release-2326\n    paths:\n      - \.github\/workflows\/android-tv-candidate-runtime\.yml/);
  assert.doesNotMatch(source, /\n  (?:pull_request|schedule):/);
  assert.match(source, /permissions:\n  contents: read\n  actions: read/);
  assert.match(source, /timeout-minutes: 45/);
  assert.match(source, /if: github\.repository == 'Tgk-30\/YAWF-Stream' && github\.actor == 'Tgk-30' && github\.ref_type == 'branch' && \(github\.event_name == 'workflow_dispatch' \|\| \(github\.event_name == 'push' && github\.ref == 'refs\/heads\/codex\/qa-platform-release-2326'\)\)/);
  assert.doesNotMatch(source, /contents:\s*write|packages:\s*write|secrets\.|GH_TOKEN|gh\s+(?:api|release)|git\s+push/);

  for (const literal of [
    'TV_CANDIDATE_RUN_ID: "39857029554"',
    "TV_CANDIDATE_ARTIFACT: android-tv-verification-candidate",
    "TV_BINDING_FILENAME: candidate-binding.json",
    "TV_SOURCE_REVISION: e7e2b7796684bf437bb10fdc9fc51263a8ba016a",
    "TV_APK_FILENAME: YAWF.Stream_Android.TV_2.3.31.apk",
    "TV_APK_SHA256: 140a1ab89af1a16f6da2a72f1d561693b5b715fe3cd6dfb13c4f16899f6ab332",
    'TV_APK_SIZE: "5057032"',
    "TV_SIGNER_SHA256: 6d8ec5466423e10e5c751132bb0f6a6ddf95a8d9f3378772d7809fce616eec1e",
    "TV_PACKAGE: com.yawf.stream.tv",
    "TV_VERSION_NAME: 2.3.31",
    'TV_VERSION_CODE: "20331"',
    'TV_MIN_SDK: "23"',
    'TV_TARGET_SDK: "36"',
    "SYSTEM_IMAGE_PACKAGE: system-images;android-36;android-tv;x86_64",
    'SYSTEM_IMAGE_REVISION: "4"',
  ]) assert.ok(source.includes(literal), `missing fixed candidate binding: ${literal}`);

  assert.match(source, /uses: actions\/download-artifact@v4[\s\S]*name: \$\{\{ env\.TV_CANDIDATE_ARTIFACT \}\}[\s\S]*github-token: \$\{\{ github\.token \}\}[\s\S]*run-id: \$\{\{ env\.TV_CANDIDATE_RUN_ID \}\}/);
  assert.equal((source.match(/actions\/download-artifact@v4/g) ?? []).length, 1);
  assert.match(source, /assert binding == expected, binding/);
  for (const key of [
    "'classification': 'private-signed-tv-candidate'",
    "'sourceRevision': env['TV_SOURCE_REVISION']",
    "'buildRunId': int(env['TV_CANDIDATE_RUN_ID'])",
    "'version': env['TV_VERSION_NAME']",
    "'versionCode': int(env['TV_VERSION_CODE'])",
    "'package': env['TV_PACKAGE']",
    "'sha256': env['TV_APK_SHA256']",
    "'size': int(env['TV_APK_SIZE'])",
    "'signerSha256': env['TV_SIGNER_SHA256']",
    "'published': False",
    "'runtimeProof': False",
  ]) assert.ok(source.includes(key), `candidate-binding.json must bind ${key}`);
  assert.match(source, /cmp "\$RUNNER_TEMP\/expected-candidate-files\.txt" "\$RUNNER_TEMP\/candidate-files\.txt"/);
  assert.match(source, /sha256sum -c -/);
  assert.match(source, /apksigner" verify --print-certs/);
  for (const field of ["application-id", "version-name", "version-code", "min-sdk", "target-sdk"]) {
    assert.match(source, new RegExp(`apkanalyzer manifest ${field}`));
  }

  const download = source.indexOf("Download exact private signed candidate artifact");
  const binding = source.indexOf("Validate exact candidate binding and bytes before emulator setup");
  const identity = source.indexOf("Verify exact package version SDK and signer before emulator setup");
  const image = source.indexOf("Admit exact official Android TV API 36 image revision");
  const transaction = source.indexOf("Run one fresh owned Android TV transaction");
  assert.ok(download >= 0 && download < binding && binding < identity && identity < image && image < transaction);

  assert.doesNotMatch(source, /--validate-static-transport|tv-signed-static-transport|TV_RELEASE_ID|TV_ASSET_ID|TV_RELEASE_TAG/);
  assert.match(source, /--apk "candidate\/\$TV_APK_FILENAME"/);
  assert.match(source, /classification=private-production-signed-candidate-fixture-proof/);
  assert.match(source, /publishedTvProof=false/);
  assert.doesNotMatch(source, /classification=published|publishedTvProof=true|releaseAssetProof=true/);
}

function assertHistoricalRuntimeBodyPreserved(source) {
  const historicalStart = historical.indexOf(runtimeMarker);
  const candidateStart = source.indexOf(runtimeMarker);
  assert.ok(historicalStart >= 0 && candidateStart >= 0);
  const expected = historical.slice(historicalStart);
  const actual = source.slice(candidateStart)
    .replace(classificationBlock, "")
    .replace("name: android-tv-candidate-runtime-evidence", "name: android-tv-signed-runtime-evidence");
  assert.equal(actual, expected);
}

test("private TV31 runtime workflow is owner-only read-only and bootstrap-scoped", () => {
  assertCandidateContract(workflow);
});

test("candidate binding and complete APK identity precede emulator image setup", () => {
  assertCandidateContract(workflow);
  assert.ok(workflow.indexOf("assert binding == expected, binding") < workflow.indexOf("Admit exact official Android TV API 36 image revision"));
  assert.ok(workflow.indexOf('test "$(apkanalyzer manifest target-sdk "$apk")" = "$TV_TARGET_SDK"') < workflow.indexOf("Admit exact official Android TV API 36 image revision"));
});

test("historical API36 fixture harness media and cleanup runtime body is unchanged", () => {
  assertHistoricalRuntimeBodyPreserved(workflow);
});

for (const [name, mutate] of [
  ["outer provisioning budget", (s) => s.replace("timeout-minutes: 45", "timeout-minutes: 35")],
  ["candidate run", (s) => s.replace("39857029554", "39857029553")],
  ["candidate source", (s) => s.replace("e7e2b7796684bf437bb10fdc9fc51263a8ba016a", "0".repeat(40))],
  ["APK hash", (s) => s.replace("140a1ab89af1a16f6da2a72f1d561693b5b715fe3cd6dfb13c4f16899f6ab332", "0".repeat(64))],
  ["APK size", (s) => s.replace('TV_APK_SIZE: "5057032"', 'TV_APK_SIZE: "1"')],
  ["signer", (s) => s.replace("6d8ec5466423e10e5c751132bb0f6a6ddf95a8d9f3378772d7809fce616eec1e", "0".repeat(64))],
  ["version", (s) => s.replace("TV_VERSION_NAME: 2.3.31", "TV_VERSION_NAME: 2.3.29")],
  ["binding equality", (s) => s.replace("assert binding == expected, binding", "assert expected.items() <= binding.items(), binding")],
  ["artifact run binding", (s) => s.replace("run-id: ${{ env.TV_CANDIDATE_RUN_ID }}", "run-id: ${{ github.run_id }}")],
  ["published classification", (s) => s.replace("publishedTvProof=false", "publishedTvProof=true")],
  ["system image revision", (s) => s.replace('SYSTEM_IMAGE_REVISION: "4"', 'SYSTEM_IMAGE_REVISION: "3"')],
]) {
  test(`rejects mutated ${name}`, () => {
    const mutant = mutate(workflow);
    assert.notEqual(mutant, workflow);
    assert.throws(() => assertCandidateContract(mutant));
  });
}

for (const [name, mutate] of [
  ["harness build", (s) => s.replace(":app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest", ":app:assembleDebugAndroidTest")],
  ["runtime APK hash admission", (s) => s.replace('            --apk-sha256 "$TV_APK_SHA256" --apk-size "$TV_APK_SIZE" \\\n', "")],
  ["failure capture ordering", (s) => s.replace("if [ \"$result\" -ne 0 ]; then capture_failure; fi\n            cleanup", "cleanup\n            if [ \"$result\" -ne 0 ]; then capture_failure; fi")],
  ["owned emulator cleanup", (s) => s.replace('timeout 10s adb -s "$EMULATOR_SERIAL" emu kill || true', "true")],
]) {
  test(`rejects changed historical runtime body: ${name}`, () => {
    const mutant = mutate(workflow);
    assert.notEqual(mutant, workflow);
    assert.throws(() => assertHistoricalRuntimeBodyPreserved(mutant));
  });
}
