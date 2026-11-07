import assert from "node:assert/strict";
import test from "node:test";

import {
  Fixed42To74AutomaticOtaAdmissionError,
  admitFixed42To74AutomaticOtaTuple,
} from "./android_public_fixed42_to74_automatic_ota_admission.mjs";
import {
  BASELINE42,
  FIXED42_EVIDENCE_SUBDIR,
  FIXED42_PROFILE,
  SIGNER_SHA256,
  TARGET74,
  UPDATER_SHA256,
} from "./android_public_fixed42_to74_automatic_ota_policy.mjs";

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
    target: artifact(TARGET74),
  };
}

function mutate(label, change) {
  test(`rejects ${label}`, () => {
    const value = structuredClone(fixture());
    change(value);
    assert.throws(
      () => admitFixed42To74AutomaticOtaTuple(value),
      Fixed42To74AutomaticOtaAdmissionError,
    );
  });
}

test("admits only the exact official signed fixed 2.3.42 to 2.3.74 tuple", () => {
  const admitted = admitFixed42To74AutomaticOtaTuple(fixture());
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
    targetVersion: "2.3.74",
    targetVersionCode: "2003074",
    targetTag: "android-v2.3.74",
    targetApkName: "YAWF.Stream_Android_2.3.74.apk",
    targetSha256: TARGET74.apkSha256,
    targetSize: "88669057",
    signerSha256: SIGNER_SHA256,
    targetSourceRevision: TARGET74.sourceRevision,
    targetManifestSha256: TARGET74.manifestSha256,
    targetVerificationSha256: TARGET74.verificationSha256,
    targetBuildRun: String(TARGET74.buildRun),
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

mutate("a missing standard pending field", (v) => { delete v.target.verification.pending; });
mutate("a missing standard limits field", (v) => { delete v.target.verification.limits; });
mutate("an extra standard verification field", (v) => { v.target.verification.scope = "unexpected"; });
mutate("a malformed standard limits field", (v) => { v.target.verification.limits = null; });

import { admitFixed42To61AutomaticOtaTuple } from "./android_public_fixed42_to61_automatic_ota_admission.mjs";
import { TARGET61, FIXED42_PROFILE as PROFILE61 } from "./android_public_fixed42_to61_automatic_ota_policy.mjs";

test("42-to61 remains immutable and neither adapter accepts the other target identity", () => {
  const legacy = { profile: PROFILE61, baseline: artifact(BASELINE42), target: artifact(TARGET61) };
  assert.equal(admitFixed42To61AutomaticOtaTuple(legacy).targetVersion, "2.3.61");
  assert.throws(() => admitFixed42To61AutomaticOtaTuple({ ...fixture(), profile: PROFILE61 }));
  assert.throws(() => admitFixed42To74AutomaticOtaTuple({ ...legacy, profile: FIXED42_PROFILE }));
});
