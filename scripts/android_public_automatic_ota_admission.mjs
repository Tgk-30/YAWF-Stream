import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "Tgk-30";
const REPOSITORY = "YAWF-Stream";
const PACKAGE = "com.tgk30.debridstreamer";
const BASELINE_VERSION = "2.3.27";
const BASELINE_VERSION_CODE = 2_003_027;
const BASELINE_SHA256 = "f3e983929db9fb32ed42b9779d94f2f8492c1cf4fae3e0cd29eee91a9492e0eb";
const BASELINE_SIZE = 88_558_465;
const MINIMUM_TARGET_VERSION_CODE = 2_003_031;
const MANIFEST = "android-update.json";
const SIGNER = "233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a";
const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const STANDARD_VERIFICATION_KEYS = Object.freeze([
  "apk", "buildRun", "certificateSha256", "checks", "sourceRevision", "version",
]);
const EMERGENCY_VERIFICATION_KEYS = Object.freeze([
  "apk", "episodeVerification", "exactSourceCiRun", "nativeRuntime",
  "offlineSignatureManifestAbiPayloadAndAlignment", "packageName", "producerRun",
  "schemaVersion", "scope", "signerSha256", "sourceRevision", "verifiedAt",
  "version", "versionCode",
]);
const EMERGENCY_ONLY_VERIFICATION_KEYS = Object.freeze([
  "episodeVerification", "exactSourceCiRun", "nativeRuntime",
  "offlineSignatureManifestAbiPayloadAndAlignment", "producerRun", "signerSha256",
]);
const EMERGENCY_36 = Object.freeze({
  version: "2.3.36",
  versionCode: 2_003_036,
  sourceRevision: "b9f51773232fa546ed3a95ec3e9169780f7df244",
  producerRun: 39_917_780_677,
  exactSourceCiRun: 39_917_164_434,
  apkSha256: "b6109604b1bc0bb7db87ed79402da7356011caab48833ac2d07eb4cede4dfe11",
  apkSize: 88_578_945,
  manifestSha256: "82cf99df55ebc766da645f16ac76d7dd7f5f7d06671cdc78d65318595e326b95",
  verificationSha256: "fa7eb7dc02f30594ceceb03a8c86aa2ccde35ed6228c2b243b83ecae44667d1c",
  publishedAt: "2026-10-23T08:00:39Z",
  verifiedAt: "2026-10-23T07:55:43.417811+00:00",
});

export class AutomaticPublicOtaAdmissionError extends Error {}

function reject(message) {
  throw new AutomaticPublicOtaAdmissionError(message);
}

function exact(actual, expected, label) {
  if (actual !== expected) reject(`${label} mismatch`);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) reject(`${label} is invalid`);
  return value;
}

function lowerDigest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) reject(`${label} is invalid`);
  return value;
}

function exactKeys(value, expected, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    reject(`${label} is invalid`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    reject(`${label} keys are not exact`);
  }
}

function exactObject(actual, expected, label) {
  exactKeys(actual, Object.keys(expected), label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    exact(actual[key], expectedValue, `${label} ${key}`);
  }
}

function admitStandardVerification(verification, expected) {
  exact(verification.version, expected.version, "verification version");
  exact(verification.sourceRevision, expected.sourceRevision, "verification source revision");
  const buildRun = positiveInteger(verification.buildRun, "verification build run");
  exact(verification.apk?.name, expected.apk.name, "verification APK name");
  exact(verification.apk?.sha256, expected.apk.sha256, "verification APK digest");
  exact(verification.apk?.size, expected.apk.size, "verification APK size");
  exact(verification.certificateSha256, SIGNER, "verification signer");
  exact(verification.checks?.buildProvenance?.workflowRun, buildRun, "provenance run");
  exact(
    verification.checks?.buildProvenance?.sourceRevision,
    expected.sourceRevision,
    "provenance source revision",
  );
  exact(
    verification.checks?.buildProvenance?.canonicalSignedCandidateUnchanged,
    true,
    "canonical signed candidate state",
  );
  return buildRun;
}

function admitEmergency36Verification(verification, expected, release, hashes) {
  exactKeys(verification, EMERGENCY_VERIFICATION_KEYS, "emergency verification");
  exact(verification.version, EMERGENCY_36.version, "emergency verification version");
  exact(verification.versionCode, EMERGENCY_36.versionCode, "emergency verification versionCode");
  exact(verification.packageName, PACKAGE, "emergency verification package");
  exact(verification.sourceRevision, EMERGENCY_36.sourceRevision, "emergency verification source");
  exact(verification.producerRun, EMERGENCY_36.producerRun, "emergency producer run");
  exact(verification.exactSourceCiRun, EMERGENCY_36.exactSourceCiRun, "emergency source CI run");
  exact(verification.signerSha256, SIGNER, "emergency verification signer");
  exact(verification.schemaVersion, 1, "emergency verification schema");
  exact(verification.verifiedAt, EMERGENCY_36.verifiedAt, "emergency verification time");
  exact(
    verification.scope,
    "Emergency canonical episode-guide and continuation-identity fix. Separate from pending player stabilization37.",
    "emergency verification scope",
  );
  exact(
    verification.offlineSignatureManifestAbiPayloadAndAlignment,
    "passed verify_android_apk.py",
    "emergency offline signature state",
  );
  exactObject(verification.apk, expected.apk, "emergency verification APK");
  exactObject(verification.nativeRuntime, {
    abi: "arm64-v8a",
    api: 36,
    automaticOtaTransactionProven: false,
    completeSetupAndNativeManualUpdater: "pass",
    exactInstalledApkHash: "pass",
    freshOwnedEmulator: true,
    passed: true,
    physicalDeviceProof: false,
    webviewMajor: 133,
  }, "emergency native runtime");
  exactObject(verification.episodeVerification, {
    allPlatformVerificationComplete: false,
    canonicalGuideAndSourceRegressionTests: "passed exact source CI",
    productionServer36Tybw17E1FileDecode: "The Blood Warfare,524decodedframes,0dropped",
    standaloneConfiguredGuideRuntime: "not run without metadata credential in account-free emulator",
  }, "emergency episode verification");

  exact(expected.version, EMERGENCY_36.version, "emergency manifest version");
  exact(expected.versionCode, EMERGENCY_36.versionCode, "emergency manifest versionCode");
  exact(expected.sourceRevision, EMERGENCY_36.sourceRevision, "emergency manifest source");
  exact(expected.apk.sha256, EMERGENCY_36.apkSha256, "emergency APK digest");
  exact(expected.apk.size, EMERGENCY_36.apkSize, "emergency APK size");
  exact(release.publishedAt, EMERGENCY_36.publishedAt, "emergency publication time");
  exact(hashes.manifestSha256, EMERGENCY_36.manifestSha256, "emergency manifest asset digest");
  exact(
    hashes.verificationSha256,
    EMERGENCY_36.verificationSha256,
    "emergency verification asset digest",
  );
  return positiveInteger(verification.producerRun, "emergency producer run");
}

function versionCodeFor(version) {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 999)) {
    reject("manifest version components are invalid");
  }
  return parts[0] * 1_000_000 + parts[1] * 1_000 + parts[2];
}

function officialAssetUrl(value, tagName, name) {
  const expected = `https://github.com/${OWNER}/${REPOSITORY}/releases/download/${tagName}/${name}`;
  exact(value, expected, `${name} public URL`);
}

function exactAsset(assets, tagName, name) {
  const matches = assets.filter((asset) => asset?.name === name);
  if (matches.length !== 1) reject(`${name} must appear exactly once`);
  const asset = matches[0];
  exact(asset.state, "uploaded", `${name} upload state`);
  officialAssetUrl(asset.url, tagName, name);
  return asset;
}

/**
 * Preparation-only structural admission for caller-supplied release objects.
 * This does not prove downloaded bytes or APK signatures. Before dispatching the driver,
 * the host must independently download the public assets, hash their bytes, run apksigner,
 * and bind those observed values to this returned instrumentation tuple.
 */
export function admitAutomaticPublicTuple(input) {
  if (input == null || typeof input !== "object") reject("admission input is absent");
  const { release, manifest, verification } = input;
  if (release == null || manifest == null || verification == null) {
    reject("release, manifest and verification are required");
  }

  if (typeof manifest.version !== "string" || !VERSION.test(manifest.version)) {
    reject("manifest version is invalid");
  }
  const targetVersion = manifest.version;
  const targetTag = `android-v${targetVersion}`;
  const targetApk = `YAWF.Stream_Android_${targetVersion}.apk`;
  const verificationName = `Android_${targetVersion}_verification.json`;
  exact(release.tagName, targetTag, "release tag");
  exact(release.isDraft, false, "release draft state");
  exact(release.isPrerelease, false, "release prerelease state");
  if (typeof release.publishedAt !== "string" || release.publishedAt.length === 0) {
    reject("release publication is absent");
  }
  if (!Array.isArray(release.assets)) reject("release assets are absent");
  const apkAsset = exactAsset(release.assets, targetTag, targetApk);
  const manifestAsset = exactAsset(release.assets, targetTag, MANIFEST);
  const verificationAsset = exactAsset(release.assets, targetTag, verificationName);

  exact(manifest.schemaVersion, 1, "manifest schema");
  const versionCode = positiveInteger(manifest.versionCode, "manifest versionCode");
  exact(versionCode, versionCodeFor(targetVersion), "manifest versionCode mapping");
  if (versionCode < MINIMUM_TARGET_VERSION_CODE) {
    reject("manifest versionCode must follow the immutable 2.3.30 release");
  }
  exact(manifest.packageName, PACKAGE, "manifest package");
  if (!REVISION.test(manifest.sourceRevision ?? "")) reject("manifest source revision is invalid");
  exact(release.targetCommitish, manifest.sourceRevision, "release target source revision");
  exact(manifest.apk?.name, targetApk, "manifest APK name");
  const apkSha256 = lowerDigest(manifest.apk?.sha256, "manifest APK digest");
  if (apkSha256 === BASELINE_SHA256) reject("target APK digest equals baseline");
  const apkSize = positiveInteger(manifest.apk?.size, "manifest APK size");

  exact(apkAsset.digest, `sha256:${apkSha256}`, "APK asset digest");
  exact(apkAsset.size, apkSize, "APK asset size");
  const manifestSha256 = lowerDigest(
    String(manifestAsset.digest ?? "").replace(/^sha256:/, ""),
    "manifest asset digest",
  );
  const verificationSha256 = lowerDigest(
    String(verificationAsset.digest ?? "").replace(/^sha256:/, ""),
    "verification asset digest",
  );

  const expectedVerification = {
    version: targetVersion,
    versionCode,
    sourceRevision: manifest.sourceRevision,
    apk: { name: targetApk, sha256: apkSha256, size: apkSize },
  };
  const verificationKeys = Object.keys(verification).sort();
  let buildRun;
  if (verificationKeys.join("\0") === [...EMERGENCY_VERIFICATION_KEYS].sort().join("\0")) {
    buildRun = admitEmergency36Verification(
      verification,
      expectedVerification,
      release,
      { manifestSha256, verificationSha256 },
    );
  } else if (EMERGENCY_ONLY_VERIFICATION_KEYS.some((key) => Object.hasOwn(verification, key))) {
    reject("emergency verification schema is not exact");
  } else if (STANDARD_VERIFICATION_KEYS.every((key) => Object.hasOwn(verification, key))) {
    buildRun = admitStandardVerification(verification, expectedVerification);
  } else {
    reject("verification schema is not recognized");
  }

  return Object.freeze({
    evidenceSubdir: "automatic-public-ota-flow",
    otaMode: "automatic-initial-cancel-due-resume",
    baselineVersion: BASELINE_VERSION,
    baselineVersionCode: String(BASELINE_VERSION_CODE),
    baselineSha256: BASELINE_SHA256,
    baselineSize: String(BASELINE_SIZE),
    targetVersion,
    targetVersionCode: String(versionCode),
    targetApkName: targetApk,
    targetSha256: apkSha256,
    targetSize: String(apkSize),
    signerSha256: SIGNER,
    targetSourceRevision: manifest.sourceRevision,
    targetManifestSha256: manifestSha256,
    targetVerificationSha256: verificationSha256,
    targetBuildRun: String(buildRun),
    targetPublicRelease: "true",
  });
}

function main(argv) {
  if (argv.length !== 1) reject("usage: node android_public_automatic_ota_admission.mjs tuple.json");
  const file = path.resolve(argv[0]);
  const admitted = admitAutomaticPublicTuple(JSON.parse(fs.readFileSync(file, "utf8")));
  process.stdout.write(`${JSON.stringify(admitted, null, 2)}\n`);
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
