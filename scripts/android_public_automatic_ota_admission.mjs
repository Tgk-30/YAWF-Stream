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

  exact(verification.version, targetVersion, "verification version");
  exact(verification.sourceRevision, manifest.sourceRevision, "verification source revision");
  const buildRun = positiveInteger(verification.buildRun, "verification build run");
  exact(verification.apk?.name, targetApk, "verification APK name");
  exact(verification.apk?.sha256, apkSha256, "verification APK digest");
  exact(verification.apk?.size, apkSize, "verification APK size");
  exact(verification.certificateSha256, SIGNER, "verification signer");
  exact(verification.checks?.buildProvenance?.workflowRun, buildRun, "provenance run");
  exact(
    verification.checks?.buildProvenance?.sourceRevision,
    manifest.sourceRevision,
    "provenance source revision",
  );
  exact(verification.checks?.buildProvenance?.canonicalSignedCandidateUnchanged,
    true, "canonical signed candidate state");

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
