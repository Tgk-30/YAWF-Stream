import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASELINE42,
  FIXED42_EVIDENCE_SUBDIR,
  FIXED42_PROFILE,
  SIGNER_SHA256,
  TARGET74,
  UPDATER_SHA256,
} from "./android_public_fixed42_to74_automatic_ota_policy.mjs";

import { admitExactArtifact } from "./android_public_fixed42_to61_automatic_ota_admission.mjs";

export class Fixed42To74AutomaticOtaAdmissionError extends Error {}
function reject(message) { throw new Fixed42To74AutomaticOtaAdmissionError(message); }
function exact(actual, expected, label) { if (actual !== expected) reject(`${label} mismatch`); }
function exactKeys(value, expected, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\n") !== [...expected].sort().join("\n")) {
    reject(`${label} keys are not exact`);
  }
}

export function admitFixed42To74AutomaticOtaTuple(input) {
  exactKeys(input, ["baseline", "profile", "target"], "fixed42 admission input");
  exact(input.profile, FIXED42_PROFILE, "runtime profile");
  try {
    admitExactArtifact(input.baseline, BASELINE42, "baseline 2.3.42");
    admitExactArtifact(input.target, TARGET74, "target 2.3.74");
  } catch (error) {
    reject(error instanceof Error ? error.message : String(error));
  }
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
    targetVersion: TARGET74.version,
    targetVersionCode: String(TARGET74.versionCode),
    targetTag: TARGET74.tag,
    targetApkName: TARGET74.apkName,
    targetSha256: TARGET74.apkSha256,
    targetSize: String(TARGET74.apkSize),
    signerSha256: SIGNER_SHA256,
    targetSourceRevision: TARGET74.sourceRevision,
    targetManifestSha256: TARGET74.manifestSha256,
    targetVerificationSha256: TARGET74.verificationSha256,
    targetBuildRun: String(TARGET74.buildRun),
    updaterSourceSha256: UPDATER_SHA256,
    targetPublicRelease: "true",
  });
}

function main(argv) {
  if (argv.length !== 1) {
    reject("usage: node android_public_fixed42_to74_automatic_ota_admission.mjs tuple.json");
  }
  const file = path.resolve(argv[0]);
  const admitted = admitFixed42To74AutomaticOtaTuple(JSON.parse(fs.readFileSync(file, "utf8")));
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
