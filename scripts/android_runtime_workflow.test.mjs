import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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
const api30Guide = workflow.slice(api30GuideStart);

const candidatePins = {
  CANDIDATE_RUN_ID: "40238512551",
  CANDIDATE_RUN_WORKFLOW_ID: "387280245",
  CANDIDATE_RUN_HEAD_BRANCH: "codex/touch-dialog-ux61",
  CANDIDATE_SOURCE_SHA: "e2dee689276610ffb1685a6f47ac37f183f35a7e",
  CANDIDATE_APK_SHA256: "a4696ab0533cdc99e3f5e373031d89e58a6cd8f6742a9107085220765bb5b247",
  CANDIDATE_APK_SIZE: "88640385",
  CANDIDATE_RELEASE_ID: "423712065",
  CANDIDATE_RELEASE_TAG: "android-v2.3.61",
  CANDIDATE_RELEASE_NAME: "YAWF Stream Android 2.3.61: player recovery",
  CANDIDATE_RELEASE_PUBLISHED_AT: "2026-10-25T23:00:52Z",
  CANDIDATE_TAG_OBJECT_SHA: "c86f5788a8ae2984aca4087101d7b98532cb0c30",
  CANDIDATE_APK_ASSET_ID: "676347366",
  CANDIDATE_APK_ASSET_NAME: "YAWF.Stream_Android_2.3.61.apk",
  CANDIDATE_MANIFEST_ASSET_ID: "676347367",
  CANDIDATE_MANIFEST_ASSET_NAME: "android-update.json",
  CANDIDATE_MANIFEST_SHA256: "8828c76dd0696c7b70d548fcfdbb4657076825c5b40e5fa81b2ce1dd23be9815",
  CANDIDATE_MANIFEST_SIZE: "348",
  CANDIDATE_VERIFICATION_ASSET_ID: "676359185",
  CANDIDATE_VERIFICATION_ASSET_NAME: "Android_2.3.61_verification.json",
  CANDIDATE_VERIFICATION_SHA256: "25afa6bca5261b02a0372eb0fc88934573ae2bce0091bd526007f963fe5b26b2",
  CANDIDATE_VERIFICATION_SIZE: "4411",
  CANDIDATE_CHECKSUMS_ASSET_ID: "676359184",
  CANDIDATE_CHECKSUMS_ASSET_NAME: "SHA256SUMS",
  CANDIDATE_CHECKSUMS_SHA256: "46ab6b40b63ea787feb33215df993d99898d023e4371b986b79d4eb1ac94e1a8",
  CANDIDATE_CHECKSUMS_SIZE: "282",
  CANDIDATE_CERT_SHA256: "233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a",
  CANDIDATE_VERSION: "2.3.61",
  CANDIDATE_VERSION_CODE: "2003061",
};

const exactYamlPins = [
  'CANDIDATE_RUN_ID: "40238512551"',
  'CANDIDATE_RUN_WORKFLOW_ID: "387280245"',
  "CANDIDATE_RUN_HEAD_BRANCH: codex/touch-dialog-ux61",
  "CANDIDATE_SOURCE_SHA: e2dee689276610ffb1685a6f47ac37f183f35a7e",
  "CANDIDATE_APK_SHA256: a4696ab0533cdc99e3f5e373031d89e58a6cd8f6742a9107085220765bb5b247",
  'CANDIDATE_APK_SIZE: "88640385"',
  'CANDIDATE_RELEASE_ID: "423712065"',
  "CANDIDATE_RELEASE_TAG: android-v2.3.61",
  'CANDIDATE_RELEASE_NAME: "YAWF Stream Android 2.3.61: player recovery"',
  'CANDIDATE_RELEASE_PUBLISHED_AT: "2026-10-25T23:00:52Z"',
  "CANDIDATE_TAG_OBJECT_SHA: c86f5788a8ae2984aca4087101d7b98532cb0c30",
  'CANDIDATE_APK_ASSET_ID: "676347366"',
  "CANDIDATE_APK_ASSET_NAME: YAWF.Stream_Android_2.3.61.apk",
  'CANDIDATE_MANIFEST_ASSET_ID: "676347367"',
  "CANDIDATE_MANIFEST_SHA256: 8828c76dd0696c7b70d548fcfdbb4657076825c5b40e5fa81b2ce1dd23be9815",
  'CANDIDATE_VERIFICATION_ASSET_ID: "676359185"',
  "CANDIDATE_VERIFICATION_SHA256: 25afa6bca5261b02a0372eb0fc88934573ae2bce0091bd526007f963fe5b26b2",
  'CANDIDATE_CHECKSUMS_ASSET_ID: "676359184"',
  "CANDIDATE_CHECKSUMS_SHA256: 46ab6b40b63ea787feb33215df993d99898d023e4371b986b79d4eb1ac94e1a8",
  "CANDIDATE_CERT_SHA256: 233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a",
  "CANDIDATE_VERSION: 2.3.61",
  'CANDIDATE_VERSION_CODE: "2003061"',
  "CANDIDATE_APK: candidate/YAWF.Stream_Android_2.3.61.apk",
  "CANDIDATE_MANIFEST: candidate/android-update.json",
  "CANDIDATE_VERIFICATION: candidate/Android_2.3.61_verification.json",
  "CANDIDATE_CHECKSUMS: candidate/SHA256SUMS",
];

function publicAdmissionPython(job) {
  const start = job.indexOf("- name: Download and admit exact public current release candidate");
  const end = job.indexOf("- name: Set up JDK 17");
  assert.ok(start >= 0 && end > start, "public candidate admission step is missing");
  const block = job.slice(start, end);
  const scripts = [...block.matchAll(/python3 - <<'PY'\n([\s\S]*?)\n          PY/g)]
    .map((match) => match[1].replace(/^          /gm, ""));
  assert.equal(scripts.length, 2, "public candidate admission must have two exact Python phases");
  return scripts;
}

function validateCandidateDelivery(job) {
  for (const pin of exactYamlPins) assert.ok(job.includes(pin), `missing ${pin}`);
  const download = job.indexOf("- name: Download and admit exact public current release candidate");
  const setup = job.indexOf("- name: Set up JDK 17");
  assert.ok(download >= 0 && setup > download);
  assert.match(job, /https:\/\/api\.github\.com\/repos\/\$GITHUB_REPOSITORY/);
  assert.match(job, /https:\/\/github\.com\/\$GITHUB_REPOSITORY\/releases\/download\/\$CANDIDATE_RELEASE_TAG/);
  assert.match(job, /--proto '=https' --proto-redir '=https'/);
  assert.match(job, /--max-filesize "\$CANDIDATE_APK_SIZE"/);
  for (const [value, target] of [
    ["CANDIDATE_APK_SHA256", "CANDIDATE_APK"],
    ["CANDIDATE_MANIFEST_SHA256", "CANDIDATE_MANIFEST"],
    ["CANDIDATE_VERIFICATION_SHA256", "CANDIDATE_VERIFICATION"],
    ["CANDIDATE_CHECKSUMS_SHA256", "CANDIDATE_CHECKSUMS"],
  ]) {
    assert.ok(
      job.includes(`printf '%s  %s\\n' "$${value}" "$${target}" | sha256sum --check -`),
      `missing ${value} byte check`,
    );
  }
  assert.doesNotMatch(job, /CANDIDATE_DRAFT|candidate_source|actions\/download-artifact|GH_TOKEN|authenticated draft|private-historical-signed-fixture/);
  assert.doesNotMatch(job, /39857024891|23587726b3ad4f2a82f4a89bd568f6c9680c1ea2a7680d41eb4b0a5475e614b3|YAWF\.Stream_Android_2\.3\.31\.apk/);
  assert.doesNotMatch(job, /continue-on-error/);

  const [metadata, assets] = publicAdmissionPython(job);
  for (const literal of [
    'release.get("id") == release_id',
    'release.get("draft") is False and release.get("prerelease") is False',
    'set(observed_assets) == set(expected_assets)',
    'asset.get("browser_download_url") ==',
    'run.get("head_sha") == source',
    'run.get("workflow_id") == int(os.environ["CANDIDATE_RUN_WORKFLOW_ID"])',
    'tag.get("object", {}).get("sha") == source',
    '"classification=official-public-current-platform-runtime-fixture"',
    '"legacy31CompatibilityEvidence=false"',
    '"automaticOtaEvidence=false"',
  ]) assert.ok(metadata.includes(literal), `metadata admission missing ${literal}`);
  for (const literal of [
    'manifest["version"] == version',
    'manifest["sourceRevision"] == source',
    'verification["buildRun"] == int(os.environ["CANDIDATE_RUN_ID"])',
    'verification["certificateSha256"] == os.environ["CANDIDATE_CERT_SHA256"]',
    '"canonicalSignedCandidateUnchanged": True',
    'read_text().splitlines() == expected_sums',
  ]) assert.ok(assets.includes(literal), `asset admission missing ${literal}`);
}

function publicFixture() {
  const asset = (name, id, size, digest, contentType) => ({
    id,
    name,
    size,
    digest: `sha256:${digest}`,
    state: "uploaded",
    content_type: contentType,
    browser_download_url: `https://github.com/Tgk-30/YAWF-Stream/releases/download/android-v2.3.61/${name}`,
    uploader: { login: "Tgk-30" },
  });
  return {
    release: {
      id: 423712065,
      tag_name: "android-v2.3.61",
      name: "YAWF Stream Android 2.3.61: player recovery",
      draft: false,
      prerelease: false,
      published_at: "2026-10-25T23:00:52Z",
      target_commitish: "main",
      immutable: false,
      assets: [
        asset(candidatePins.CANDIDATE_APK_ASSET_NAME, 676347366, 88640385, candidatePins.CANDIDATE_APK_SHA256, "application/vnd.android.package-archive"),
        asset(candidatePins.CANDIDATE_MANIFEST_ASSET_NAME, 676347367, 348, candidatePins.CANDIDATE_MANIFEST_SHA256, "application/json"),
        asset(candidatePins.CANDIDATE_VERIFICATION_ASSET_NAME, 676359185, 4411, candidatePins.CANDIDATE_VERIFICATION_SHA256, "application/json"),
        asset(candidatePins.CANDIDATE_CHECKSUMS_ASSET_NAME, 676359184, 282, candidatePins.CANDIDATE_CHECKSUMS_SHA256, "application/octet-stream"),
      ],
    },
    run: {
      id: 40238512551,
      workflow_id: 387280245,
      name: "android-release",
      path: ".github/workflows/android-release.yml",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      run_attempt: 1,
      head_sha: candidatePins.CANDIDATE_SOURCE_SHA,
      head_branch: candidatePins.CANDIDATE_RUN_HEAD_BRANCH,
      repository: { full_name: "Tgk-30/YAWF-Stream" },
      head_repository: { full_name: "Tgk-30/YAWF-Stream" },
    },
    tagRef: {
      ref: "refs/tags/android-v2.3.61",
      object: { type: "tag", sha: candidatePins.CANDIDATE_TAG_OBJECT_SHA },
    },
    tag: {
      tag: "android-v2.3.61",
      object: { type: "commit", sha: candidatePins.CANDIDATE_SOURCE_SHA },
    },
    manifest: {
      schemaVersion: 1,
      version: "2.3.61",
      versionCode: 2003061,
      packageName: "com.tgk30.debridstreamer",
      sourceRevision: candidatePins.CANDIDATE_SOURCE_SHA,
      apk: {
        name: candidatePins.CANDIDATE_APK_ASSET_NAME,
        sha256: candidatePins.CANDIDATE_APK_SHA256,
        size: 88640385,
      },
    },
    verification: {
      version: "2.3.61",
      sourceRevision: candidatePins.CANDIDATE_SOURCE_SHA,
      buildRun: 40238512551,
      apk: {
        name: candidatePins.CANDIDATE_APK_ASSET_NAME,
        sha256: candidatePins.CANDIDATE_APK_SHA256,
        size: 88640385,
      },
      certificateSha256: candidatePins.CANDIDATE_CERT_SHA256,
      checks: {
        buildProvenance: {
          workflowRun: 40238512551,
          sourceRevision: candidatePins.CANDIDATE_SOURCE_SHA,
          canonicalSignedCandidateUnchanged: true,
        },
        actualApkVersionCode: 2003061,
      },
    },
    checksums: [
      `${candidatePins.CANDIDATE_APK_SHA256}  ${candidatePins.CANDIDATE_APK_ASSET_NAME}`,
      `${candidatePins.CANDIDATE_MANIFEST_SHA256}  ${candidatePins.CANDIDATE_MANIFEST_ASSET_NAME}`,
      `${candidatePins.CANDIDATE_VERIFICATION_SHA256}  ${candidatePins.CANDIDATE_VERIFICATION_ASSET_NAME}`,
    ].join("\n") + "\n",
  };
}

function runPublicAdmission(mutate = () => {}) {
  const fixture = publicFixture();
  mutate(fixture);
  const directory = mkdtempSync(join(tmpdir(), "yawf-public61-candidate-admission-"));
  const evidence = join(directory, "evidence");
  mkdirSync(evidence);
  writeFileSync(join(evidence, "public-release.json"), JSON.stringify(fixture.release));
  writeFileSync(join(evidence, "producer-run.json"), JSON.stringify(fixture.run));
  writeFileSync(join(evidence, "tag-ref.json"), JSON.stringify(fixture.tagRef));
  writeFileSync(join(evidence, "tag-object.json"), JSON.stringify(fixture.tag));
  const env = {
    ...process.env,
    ...candidatePins,
    GITHUB_REPOSITORY: "Tgk-30/YAWF-Stream",
    EVIDENCE: evidence,
    CANDIDATE_MANIFEST: join(directory, "android-update.json"),
    CANDIDATE_VERIFICATION: join(directory, "Android_2.3.61_verification.json"),
    CANDIDATE_CHECKSUMS: join(directory, "SHA256SUMS"),
  };
  const [metadataPython, assetPython] = publicAdmissionPython(api30Runtime);
  try {
    const metadata = spawnSync("python3", ["-c", metadataPython], { encoding: "utf8", env });
    if (metadata.status !== 0) return { metadata, assets: null, evidence: "" };
    writeFileSync(env.CANDIDATE_MANIFEST, JSON.stringify(fixture.manifest));
    writeFileSync(env.CANDIDATE_VERIFICATION, JSON.stringify(fixture.verification));
    writeFileSync(env.CANDIDATE_CHECKSUMS, fixture.checksums);
    const assets = spawnSync("python3", ["-c", assetPython], { encoding: "utf8", env });
    return {
      metadata,
      assets,
      evidence: readFileSync(join(evidence, "candidate-delivery.txt"), "utf8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

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

test("pins the exact current public 61 candidate and same public channel", () => {
  validateCandidateDelivery(api30Runtime);
  validateCandidateDelivery(api30Guide);
  assert.match(api30Runtime, /PUBLISHED_ANDROID_VERSION: 2\.3\.61/);
  assert.match(api30Runtime, /verificationScope=current-public-api30/);
  assert.match(api30Guide, /verificationScope=current-public-api30/);
  assert.doesNotMatch(workflow, /CANDIDATE_VERSION: 2\.3\.31|PUBLISHED_ANDROID_VERSION: 2\.3\.27/);
});

test("keeps identical fail-closed public metadata and asset admission in both API30 jobs", () => {
  const runtimeScripts = publicAdmissionPython(api30Runtime);
  const guideScripts = publicAdmissionPython(api30Guide);
  assert.deepEqual(runtimeScripts, guideScripts);
  assert.equal(
    (workflow.match(/- name: Download and admit exact public current release candidate/g) ?? []).length,
    2,
  );
});

test("executes the exact public metadata and asset-content admission phases", () => {
  const result = runPublicAdmission();
  assert.equal(result.metadata.status, 0, result.metadata.stderr);
  assert.equal(result.assets.status, 0, result.assets.stderr);
  assert.match(result.evidence, /classification=official-public-current-platform-runtime-fixture/);
  assert.match(result.evidence, /delivery=canonical-public-release/);
  assert.match(result.evidence, /publicReleaseVerified=true/);
  assert.match(result.evidence, /currentPlatformVerification=true/);
  assert.match(result.evidence, /legacy31CompatibilityEvidence=false/);
  assert.match(result.evidence, /automaticOtaEvidence=false/);
  assert.match(result.evidence, /assetBytesVerified=true/);
  assert.match(result.evidence, /releaseMetadataVerified=true/);
});

test("fails closed on public release, producer, tag, and asset inventory changes", () => {
  for (const [name, mutate, expected] of [
    ["draft release", (fixture) => { fixture.release.draft = true; }, /Public release state changed/],
    ["extra asset", (fixture) => { fixture.release.assets.push({ name: "extra" }); }, /Public asset inventory changed/],
    ["APK digest", (fixture) => { fixture.release.assets[0].digest = `sha256:${"0".repeat(64)}`; }, /Public asset .* digest changed/],
    ["producer source", (fixture) => { fixture.run.head_sha = "0".repeat(40); }, /Producer source changed/],
    ["tag source", (fixture) => { fixture.tag.object.sha = "0".repeat(40); }, /Annotated tag source changed/],
  ]) {
    const result = runPublicAdmission(mutate);
    assert.notEqual(result.metadata.status, 0, name);
    assert.match(result.metadata.stderr, expected, name);
    assert.equal(result.assets, null, name);
  }
});

test("fails closed on manifest, verification, signer, and checksums changes", () => {
  for (const [name, mutate, expected] of [
    ["manifest source", (fixture) => { fixture.manifest.sourceRevision = "0".repeat(40); }, /AssertionError/],
    ["verification run", (fixture) => { fixture.verification.buildRun = 1; }, /AssertionError/],
    ["certificate", (fixture) => { fixture.verification.certificateSha256 = "0".repeat(64); }, /AssertionError/],
    ["checksums", (fixture) => { fixture.checksums = "unexpected\n"; }, /AssertionError/],
  ]) {
    const result = runPublicAdmission(mutate);
    assert.equal(result.metadata.status, 0, result.metadata.stderr);
    assert.notEqual(result.assets.status, 0, name);
    assert.match(result.assets.stderr, expected, name);
  }
});

for (const [name, mutate] of [
  ["release id", (value) => value.replaceAll('CANDIDATE_RELEASE_ID: "423712065"', 'CANDIDATE_RELEASE_ID: "1"')],
  ["APK asset id", (value) => value.replaceAll('CANDIDATE_APK_ASSET_ID: "676347366"', 'CANDIDATE_APK_ASSET_ID: "1"')],
  ["source", (value) => value.replaceAll(candidatePins.CANDIDATE_SOURCE_SHA, "0".repeat(40))],
  ["public state", (value) => value.replaceAll('release.get("draft") is False', 'release.get("draft") is True')],
  ["classification", (value) => value.replaceAll("classification=official-public-current-platform-runtime-fixture", "classification=private-fixture")],
  ["automatic OTA boundary", (value) => value.replaceAll("automaticOtaEvidence=false", "automaticOtaEvidence=true")],
  ["download hash", (value) => value.replaceAll("sha256sum --check -", 'sha256sum "$CANDIDATE_APK"')],
  ["authenticated private access", (value) => value.replaceAll("shell: bash\n        run:", "shell: bash\n        env:\n          GH_TOKEN: ${{ github.token }}\n        run:")],
]) {
  test(`rejects mutated public candidate ${name}`, () => {
    const changed = mutate(workflow);
    assert.notEqual(changed, workflow);
    const runtimeStart = changed.indexOf("  api30-runtime:");
    const guideStart = changed.indexOf("  api30-stock-webview-guide:");
    assert.throws(() => validateCandidateDelivery(changed.slice(runtimeStart, guideStart)));
  });
}

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
  assert.match(workflow, /candidateClassification=official-public-current-platform-runtime-fixture/);
  assert.match(workflow, /releaseAssetSource=canonical-public-release/);
  assert.match(workflow, /runtimeScope=current-platform/);
  assert.match(workflow, /automaticOtaEvidence=false/);
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
