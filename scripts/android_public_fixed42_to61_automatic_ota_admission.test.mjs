import assert from "node:assert/strict";
import test from "node:test";

import {
  Fixed42To61AutomaticOtaAdmissionError,
  admitFixed42To61AutomaticOtaTuple,
} from "./android_public_fixed42_to61_automatic_ota_admission.mjs";
import {
  BASELINE42,
  FIXED42_EVIDENCE_SUBDIR,
  FIXED42_PROFILE,
  SIGNER_SHA256,
  TARGET61,
  UPDATER_SHA256,
} from "./android_public_fixed42_to61_automatic_ota_policy.mjs";

const CHECKSUMS_SHA = "c".repeat(64);

function artifact(pin) {
  const observed = {
    apkSha256: pin.apkSha256,
    apkSize: pin.apkSize,
    manifestSha256: pin.manifestSha256,
    manifestSize: 431,
    verificationSha256: pin.verificationSha256,
    verificationSize: 2_431,
    checksumsSha256: pin.checksumsSha256 ?? CHECKSUMS_SHA,
    checksumsSize: 271,
  };
  const asset = (name, digest, size) => ({
    name,
    state: "uploaded",
    url: `https://github.com/Tgk-30/YAWF-Stream/releases/download/${pin.tag}/${name}`,
    digest: `sha256:${digest}`,
    size,
  });
  return {
    release: {
      tagName: pin.tag,
      isDraft: false,
      isPrerelease: false,
      publishedAt: "2026-10-24T12:34:56Z",
      targetCommitish: pin.sourceRevision,
      assets: [
        asset(pin.apkName, observed.apkSha256, observed.apkSize),
        asset("android-update.json", observed.manifestSha256, observed.manifestSize),
        asset(pin.verificationName, observed.verificationSha256, observed.verificationSize),
        asset("SHA256SUMS", observed.checksumsSha256, observed.checksumsSize),
      ],
    },
    manifest: {
      schemaVersion: 1,
      version: pin.version,
      versionCode: pin.versionCode,
      packageName: "com.tgk30.debridstreamer",
      sourceRevision: pin.sourceRevision,
      apk: { name: pin.apkName, sha256: pin.apkSha256, size: pin.apkSize },
    },
    verification: {
      version: pin.version,
      sourceRevision: pin.sourceRevision,
      buildRun: pin.buildRun,
      apk: { name: pin.apkName, sha256: pin.apkSha256, size: pin.apkSize },
      certificateSha256: SIGNER_SHA256,
      checks: {
        buildProvenance: {
          workflowRun: pin.buildRun,
          sourceRevision: pin.sourceRevision,
          canonicalSignedCandidateUnchanged: true,
        },
      },
      pending: ["runtime OTA is not proven by publication metadata"],
      limits: ["physical-device behavior is not claimed"],
    },
    checksums: [
      `${pin.apkSha256}  ${pin.apkName}`,
      `${pin.manifestSha256}  android-update.json`,
      `${pin.verificationSha256}  ${pin.verificationName}`,
      "",
    ].join("\n"),
    updaterSourceSha256: UPDATER_SHA256,
    observed,
  };
}

function fixture() {
  return {
    profile: FIXED42_PROFILE,
    baseline: artifact(BASELINE42),
    target: artifact(TARGET61),
  };
}

function mutate(label, change) {
  test(`rejects ${label}`, () => {
    const value = structuredClone(fixture());
    change(value);
    assert.throws(
      () => admitFixed42To61AutomaticOtaTuple(value),
      Fixed42To61AutomaticOtaAdmissionError,
    );
  });
}

test("admits only the exact official signed fixed 2.3.42 to 2.3.61 tuple", () => {
  const admitted = admitFixed42To61AutomaticOtaTuple(fixture());
  assert.deepEqual(admitted, {
    profile: FIXED42_PROFILE,
    evidenceSubdir: FIXED42_EVIDENCE_SUBDIR,
    otaMode: FIXED42_PROFILE,
    baselineVersion: "2.3.42",
    baselineVersionCode: "2003042",
    baselineTag: "android-v2.3.42",
    baselineApkName: "YAWF.Stream_Android_2.3.42.apk",
    baselineSha256: BASELINE42.apkSha256,
    baselineSize: "88583041",
    baselineSourceRevision: BASELINE42.sourceRevision,
    baselineManifestSha256: BASELINE42.manifestSha256,
    baselineVerificationSha256: BASELINE42.verificationSha256,
    baselineBuildRun: String(BASELINE42.buildRun),
    targetVersion: "2.3.61",
    targetVersionCode: "2003061",
    targetTag: "android-v2.3.61",
    targetApkName: "YAWF.Stream_Android_2.3.61.apk",
    targetSha256: TARGET61.apkSha256,
    targetSize: "88640385",
    signerSha256: SIGNER_SHA256,
    targetSourceRevision: TARGET61.sourceRevision,
    targetManifestSha256: TARGET61.manifestSha256,
    targetVerificationSha256: TARGET61.verificationSha256,
    targetBuildRun: String(TARGET61.buildRun),
    updaterSourceSha256: UPDATER_SHA256,
    targetPublicRelease: "true",
  });
});

mutate("a different profile", (v) => { v.profile = "automatic-initial-cancel-due-resume"; });
mutate("an arbitrary baseline version", (v) => { v.baseline.manifest.version = "2.3.41"; });
mutate("an arbitrary target source", (v) => { v.target.release.targetCommitish = "0".repeat(40); });
mutate("a draft baseline", (v) => { v.baseline.release.isDraft = true; });
mutate("an absent target publication time", (v) => { v.target.release.publishedAt = ""; });
mutate("a duplicate baseline APK asset", (v) => { v.baseline.release.assets.push(v.baseline.release.assets[0]); });
mutate("a non-official target asset URL", (v) => { v.target.release.assets[0].url = "https://example.test/a.apk"; });
mutate("a baseline APK asset digest mismatch", (v) => { v.baseline.release.assets[0].digest = `sha256:${"0".repeat(64)}`; });
mutate("a target manifest byte hash mismatch", (v) => { v.target.observed.manifestSha256 = "0".repeat(64); });
mutate("a target verification byte hash mismatch", (v) => { v.target.observed.verificationSha256 = "0".repeat(64); });
mutate("a target checksum-list byte hash mismatch", (v) => { v.target.observed.checksumsSha256 = "0".repeat(64); });
mutate("a baseline verification signer mismatch", (v) => { v.baseline.verification.certificateSha256 = "0".repeat(64); });
mutate("a target provenance run mismatch", (v) => { v.target.verification.checks.buildProvenance.workflowRun += 1; });
mutate("a baseline provenance source mismatch", (v) => { v.baseline.verification.checks.buildProvenance.sourceRevision = "0".repeat(40); });
mutate("a non-canonical signed target", (v) => { v.target.verification.checks.buildProvenance.canonicalSignedCandidateUnchanged = false; });
mutate("different updater source bytes", (v) => { v.target.updaterSourceSha256 = "0".repeat(64); });
mutate("an incomplete target checksum set", (v) => { v.target.checksums = v.target.checksums.split("\n").slice(0, 2).join("\n"); });
mutate("an extra unadmitted input key", (v) => { v.overrideBaseline = "2.3.27"; });
