import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASELINE42,
  FIXED42_EVIDENCE_SUBDIR,
  FIXED42_PROFILE,
  SIGNER_SHA256,
  TARGET61,
  UPDATER_SHA256,
} from "./android_public_fixed42_to61_automatic_ota_policy.mjs";

const OWNER = "Tgk-30";
const REPOSITORY = "YAWF-Stream";
const PACKAGE = "com.tgk30.debridstreamer";
const MANIFEST_NAME = "android-update.json";
const CHECKSUMS_NAME = "SHA256SUMS";
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const STANDARD_VERIFICATION_KEYS = Object.freeze([
  "apk", "buildRun", "certificateSha256", "checks", "limits", "pending",
  "sourceRevision", "version",
]);

export class Fixed42To61AutomaticOtaAdmissionError extends Error {}

function reject(message) {
  throw new Fixed42To61AutomaticOtaAdmissionError(message);
}

function exact(actual, expected, label) {
  if (actual !== expected) reject(`${label} mismatch`);
}

function exactKeys(value, keys, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    reject(`${label} is invalid`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    reject(`${label} keys are not exact`);
  }
}

function exactDigest(value, expected, label) {
  if (typeof value !== "string" || !SHA256.test(value)) reject(`${label} is invalid`);
  exact(value, expected, label);
}

function exactPositiveInteger(value, expected, label) {
  if (!Number.isSafeInteger(value) || value <= 0) reject(`${label} is invalid`);
  exact(value, expected, label);
}

function exactPublicAsset(assets, pin, name, observedSha256, observedSize) {
  const matches = assets.filter((asset) => asset?.name === name);
  if (matches.length !== 1) reject(`${pin.version} ${name} must appear exactly once`);
  const asset = matches[0];
  exactKeys(asset, ["digest", "name", "size", "state", "url"], `${pin.version} ${name} asset`);
  exact(asset.state, "uploaded", `${pin.version} ${name} upload state`);
  exact(
    asset.url,
    `https://github.com/${OWNER}/${REPOSITORY}/releases/download/${pin.tag}/${name}`,
    `${pin.version} ${name} public URL`,
  );
  exact(asset.digest, `sha256:${observedSha256}`, `${pin.version} ${name} asset digest`);
  exact(asset.size, observedSize, `${pin.version} ${name} asset size`);
}

function parseExactChecksums(text, pin, observed) {
  if (typeof text !== "string" || text.length === 0 || text.length > 16 * 1024) {
    reject(`${pin.version} SHA256SUMS is invalid`);
  }
  const parsed = new Map();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    if (match == null || parsed.has(match[2])) reject(`${pin.version} SHA256SUMS row is invalid`);
    parsed.set(match[2], match[1]);
  }
  const expected = new Map([
    [pin.apkName, pin.apkSha256],
    [MANIFEST_NAME, observed.manifestSha256],
    [pin.verificationName, observed.verificationSha256],
  ]);
  if (parsed.size !== expected.size) reject(`${pin.version} SHA256SUMS asset set is not exact`);
  for (const [name, digest] of expected) exact(parsed.get(name), digest, `${pin.version} ${name} checksum`);
}

function admitExactArtifact(artifact, pin, label) {
  exactKeys(
    artifact,
    ["checksums", "manifest", "observed", "release", "updaterSourceSha256", "verification"],
    label,
  );
  const { release, manifest, verification, observed } = artifact;
  exactKeys(release, ["assets", "isDraft", "isPrerelease", "publishedAt", "tagName", "targetCommitish"], `${label} release`);
  exact(release.tagName, pin.tag, `${label} release tag`);
  exact(release.isDraft, false, `${label} draft state`);
  exact(release.isPrerelease, false, `${label} prerelease state`);
  if (typeof release.publishedAt !== "string" || !ISO_INSTANT.test(release.publishedAt)) {
    reject(`${label} publication timestamp is absent or invalid`);
  }
  exact(release.targetCommitish, pin.sourceRevision, `${label} release source`);
  if (!Array.isArray(release.assets) || release.assets.length > 200) reject(`${label} release assets are invalid`);

  exactKeys(
    observed,
    ["apkSha256", "apkSize", "checksumsSha256", "checksumsSize", "manifestSha256", "manifestSize", "verificationSha256", "verificationSize"],
    `${label} observed bytes`,
  );
  exactDigest(observed.apkSha256, pin.apkSha256, `${label} observed APK digest`);
  exactPositiveInteger(observed.apkSize, pin.apkSize, `${label} observed APK size`);
  exactDigest(observed.manifestSha256, pin.manifestSha256, `${label} observed manifest digest`);
  exactDigest(observed.verificationSha256, pin.verificationSha256, `${label} observed verification digest`);
  if (!Number.isSafeInteger(observed.manifestSize) || observed.manifestSize <= 0 || observed.manifestSize > 16 * 1024) {
    reject(`${label} observed manifest size is invalid`);
  }
  if (!Number.isSafeInteger(observed.verificationSize) || observed.verificationSize <= 0 || observed.verificationSize > 64 * 1024) {
    reject(`${label} observed verification size is invalid`);
  }
  if (!Number.isSafeInteger(observed.checksumsSize) || observed.checksumsSize <= 0 || observed.checksumsSize > 16 * 1024) {
    reject(`${label} observed checksums size is invalid`);
  }
  if (typeof observed.checksumsSha256 !== "string" || !SHA256.test(observed.checksumsSha256)) {
    reject(`${label} observed checksums digest is invalid`);
  }
  if (pin.checksumsSha256 != null) {
    exactDigest(observed.checksumsSha256, pin.checksumsSha256, `${label} observed checksums digest`);
  }

  exactPublicAsset(release.assets, pin, pin.apkName, observed.apkSha256, observed.apkSize);
  exactPublicAsset(release.assets, pin, MANIFEST_NAME, observed.manifestSha256, observed.manifestSize);
  exactPublicAsset(
    release.assets,
    pin,
    pin.verificationName,
    observed.verificationSha256,
    observed.verificationSize,
  );
  exactPublicAsset(
    release.assets,
    pin,
    CHECKSUMS_NAME,
    observed.checksumsSha256,
    observed.checksumsSize,
  );

  exactKeys(manifest, ["apk", "packageName", "schemaVersion", "sourceRevision", "version", "versionCode"], `${label} manifest`);
  exact(manifest.schemaVersion, 1, `${label} manifest schema`);
  exact(manifest.version, pin.version, `${label} manifest version`);
  exact(manifest.versionCode, pin.versionCode, `${label} manifest versionCode`);
  exact(manifest.packageName, PACKAGE, `${label} manifest package`);
  exact(manifest.sourceRevision, pin.sourceRevision, `${label} manifest source`);
  exactKeys(manifest.apk, ["name", "sha256", "size"], `${label} manifest APK`);
  exact(manifest.apk.name, pin.apkName, `${label} manifest APK name`);
  exact(manifest.apk.sha256, pin.apkSha256, `${label} manifest APK digest`);
  exact(manifest.apk.size, pin.apkSize, `${label} manifest APK size`);

  exactKeys(verification, STANDARD_VERIFICATION_KEYS, `${label} verification`);
  exact(verification.version, pin.version, `${label} verification version`);
  exact(verification.sourceRevision, pin.sourceRevision, `${label} verification source`);
  exactPositiveInteger(verification.buildRun, pin.buildRun, `${label} verification build run`);
  exactKeys(verification.apk, ["name", "sha256", "size"], `${label} verification APK`);
  exact(verification.apk.name, pin.apkName, `${label} verification APK name`);
  exact(verification.apk.sha256, pin.apkSha256, `${label} verification APK digest`);
  exact(verification.apk.size, pin.apkSize, `${label} verification APK size`);
  exact(verification.certificateSha256, SIGNER_SHA256, `${label} verification signer`);
  if (verification.checks == null || typeof verification.checks !== "object" || Array.isArray(verification.checks)) {
    reject(`${label} verification checks are invalid`);
  }
  exact(verification.checks?.buildProvenance?.workflowRun, pin.buildRun, `${label} provenance run`);
  exact(verification.checks?.buildProvenance?.sourceRevision, pin.sourceRevision, `${label} provenance source`);
  exact(verification.checks?.buildProvenance?.canonicalSignedCandidateUnchanged, true, `${label} canonical candidate state`);
  for (const field of ["pending", "limits"]) {
    if (!Array.isArray(verification[field]) || verification[field].length > 32
        || verification[field].some((entry) => typeof entry !== "string" || entry.length === 0)) {
      reject(`${label} verification ${field} is invalid`);
    }
  }

  exact(artifact.updaterSourceSha256, UPDATER_SHA256, `${label} updater source digest`);
  parseExactChecksums(artifact.checksums, pin, observed);
}

export function admitFixed42To61AutomaticOtaTuple(input) {
  exactKeys(input, ["baseline", "profile", "target"], "fixed42 admission input");
  exact(input.profile, FIXED42_PROFILE, "runtime profile");
  admitExactArtifact(input.baseline, BASELINE42, "baseline 2.3.42");
  admitExactArtifact(input.target, TARGET61, "target 2.3.61");
  if (input.baseline.updaterSourceSha256 !== input.target.updaterSourceSha256) {
    reject("baseline and target updater sources are not byte-identical");
  }

  return Object.freeze({
    profile: FIXED42_PROFILE,
    evidenceSubdir: FIXED42_EVIDENCE_SUBDIR,
    otaMode: FIXED42_PROFILE,
    baselineVersion: BASELINE42.version,
    baselineVersionCode: String(BASELINE42.versionCode),
    baselineTag: BASELINE42.tag,
    baselineApkName: BASELINE42.apkName,
    baselineSha256: BASELINE42.apkSha256,
    baselineSize: String(BASELINE42.apkSize),
    baselineSourceRevision: BASELINE42.sourceRevision,
    baselineManifestSha256: BASELINE42.manifestSha256,
    baselineVerificationSha256: BASELINE42.verificationSha256,
    baselineBuildRun: String(BASELINE42.buildRun),
    targetVersion: TARGET61.version,
    targetVersionCode: String(TARGET61.versionCode),
    targetTag: TARGET61.tag,
    targetApkName: TARGET61.apkName,
    targetSha256: TARGET61.apkSha256,
    targetSize: String(TARGET61.apkSize),
    signerSha256: SIGNER_SHA256,
    targetSourceRevision: TARGET61.sourceRevision,
    targetManifestSha256: TARGET61.manifestSha256,
    targetVerificationSha256: TARGET61.verificationSha256,
    targetBuildRun: String(TARGET61.buildRun),
    updaterSourceSha256: UPDATER_SHA256,
    targetPublicRelease: "true",
  });
}

function main(argv) {
  if (argv.length !== 1) {
    reject("usage: node android_public_fixed42_to61_automatic_ota_admission.mjs tuple.json");
  }
  const file = path.resolve(argv[0]);
  const admitted = admitFixed42To61AutomaticOtaTuple(JSON.parse(fs.readFileSync(file, "utf8")));
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
