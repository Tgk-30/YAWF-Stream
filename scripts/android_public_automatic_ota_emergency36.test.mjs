import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { admitAutomaticPublicTuple, AutomaticPublicOtaAdmissionError } from "./android_public_automatic_ota_admission.mjs";

const fixtureUrl = new URL("../fixtures/public36/automatic-admission-input.json", import.meta.url);
const fixture = () => JSON.parse(fs.readFileSync(fixtureUrl, "utf8"));

function setPath(value, path, replacement) {
  const parts = path.split(".");
  let owner = value;
  for (const part of parts.slice(0, -1)) owner = owner[part];
  owner[parts.at(-1)] = replacement;
}

function rejectMutation(label, mutate) {
  const value = fixture();
  mutate(value);
  assert.throws(
    () => admitAutomaticPublicTuple(value),
    AutomaticPublicOtaAdmissionError,
    label,
  );
}

test("exact retained public 2.3.36 emergency receipt produces the immutable automatic binding", () => {
  const admitted = admitAutomaticPublicTuple(fixture());
  assert.deepEqual(admitted, {
    evidenceSubdir: "automatic-public-ota-flow",
    otaMode: "automatic-initial-cancel-due-resume",
    baselineVersion: "2.3.27",
    baselineVersionCode: "2003027",
    baselineSha256: "f3e983929db9fb32ed42b9779d94f2f8492c1cf4fae3e0cd29eee91a9492e0eb",
    baselineSize: "88558465",
    targetVersion: "2.3.36",
    targetVersionCode: "2003036",
    targetApkName: "YAWF.Stream_Android_2.3.36.apk",
    targetSha256: "b6109604b1bc0bb7db87ed79402da7356011caab48833ac2d07eb4cede4dfe11",
    targetSize: "88578945",
    signerSha256: "233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a",
    targetSourceRevision: "b9f51773232fa546ed3a95ec3e9169780f7df244",
    targetManifestSha256: "82cf99df55ebc766da645f16ac76d7dd7f5f7d06671cdc78d65318595e326b95",
    targetVerificationSha256: "fa7eb7dc02f30594ceceb03a8c86aa2ccde35ed6228c2b243b83ecae44667d1c",
    targetBuildRun: "39917780677",
    targetPublicRelease: "true",
  });
});

test("every emergency receipt field and key-set invariant rejects an individual mutant", () => {
  const replacements = {
    "verification.schemaVersion": 2,
    "verification.version": "2.3.37",
    "verification.versionCode": 2003037,
    "verification.packageName": "com.example.private",
    "verification.sourceRevision": "0".repeat(40),
    "verification.exactSourceCiRun": 39917164435,
    "verification.producerRun": 39917780678,
    "verification.signerSha256": "0".repeat(64),
    "verification.offlineSignatureManifestAbiPayloadAndAlignment": "pending",
    "verification.verifiedAt": "2026-10-23T07:55:44.000000+00:00",
    "verification.scope": "different scope",
    "verification.apk.name": "different.apk",
    "verification.apk.sha256": "0".repeat(64),
    "verification.apk.size": 88578946,
    "verification.nativeRuntime.abi": "x86_64",
    "verification.nativeRuntime.api": 35,
    "verification.nativeRuntime.automaticOtaTransactionProven": true,
    "verification.nativeRuntime.completeSetupAndNativeManualUpdater": "pending",
    "verification.nativeRuntime.exactInstalledApkHash": "pending",
    "verification.nativeRuntime.freshOwnedEmulator": false,
    "verification.nativeRuntime.passed": false,
    "verification.nativeRuntime.physicalDeviceProof": true,
    "verification.nativeRuntime.webviewMajor": 132,
    "verification.episodeVerification.allPlatformVerificationComplete": true,
    "verification.episodeVerification.canonicalGuideAndSourceRegressionTests": "pending",
    "verification.episodeVerification.productionServer36Tybw17E1FileDecode": "pending",
    "verification.episodeVerification.standaloneConfiguredGuideRuntime": "passed",
  };
  for (const [path, replacement] of Object.entries(replacements)) {
    rejectMutation(path, (value) => setPath(value, path, replacement));
  }

  const topKeys = Object.keys(fixture().verification);
  for (const key of topKeys) {
    rejectMutation(`missing verification.${key}`, (value) => { delete value.verification[key]; });
  }
  rejectMutation("unexpected emergency top-level key", (value) => {
    value.verification.unexpected = true;
  });
  rejectMutation("hybrid emergency and standard schema", (value) => {
    value.verification.buildRun = value.verification.producerRun;
    value.verification.certificateSha256 = value.verification.signerSha256;
    value.verification.checks = { buildProvenance: {
      workflowRun: value.verification.producerRun,
      sourceRevision: value.verification.sourceRevision,
      canonicalSignedCandidateUnchanged: true,
    }};
  });
  for (const [objectPath, extraKey] of [
    ["verification.apk", "unexpected"],
    ["verification.nativeRuntime", "unexpected"],
    ["verification.episodeVerification", "unexpected"],
  ]) {
    rejectMutation(`${objectPath}.${extraKey}`, (value) => {
      setPath(value, `${objectPath}.${extraKey}`, true);
    });
  }
});

test("public release, source, asset hash and publication state remain exact for emergency 2.3.36", () => {
  const mutations = {
    "draft": (value) => { value.release.isDraft = true; },
    "prerelease": (value) => { value.release.isPrerelease = true; },
    "publication timestamp": (value) => { value.release.publishedAt = "2026-10-23T08:00:40Z"; },
    "release source": (value) => { value.release.targetCommitish = "0".repeat(40); },
    "manifest source": (value) => { value.manifest.sourceRevision = "0".repeat(40); },
    "manifest versionCode": (value) => { value.manifest.versionCode = 2003037; },
    "APK digest": (value) => { value.manifest.apk.sha256 = "0".repeat(64); },
    "APK size": (value) => { value.manifest.apk.size++; },
    "manifest asset digest": (value) => {
      value.release.assets.find((asset) => asset.name === "android-update.json").digest = `sha256:${"0".repeat(64)}`;
    },
    "verification asset digest": (value) => {
      value.release.assets.find((asset) => asset.name === "Android_2.3.36_verification.json").digest = `sha256:${"0".repeat(64)}`;
    },
    "verification asset URL": (value) => {
      value.release.assets.find((asset) => asset.name === "Android_2.3.36_verification.json").url = "https://example.invalid/private.json";
    },
    "verification upload state": (value) => {
      value.release.assets.find((asset) => asset.name === "Android_2.3.36_verification.json").state = "new";
    },
  };
  for (const [label, mutate] of Object.entries(mutations)) rejectMutation(label, mutate);
});

test("old standard verification schema remains admitted without using emergency aliases", () => {
  const value = fixture();
  value.verification = {
    version: value.manifest.version,
    sourceRevision: value.manifest.sourceRevision,
    buildRun: 39917780677,
    apk: structuredClone(value.manifest.apk),
    certificateSha256: "233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a",
    checks: { buildProvenance: {
      workflowRun: 39917780677,
      sourceRevision: value.manifest.sourceRevision,
      canonicalSignedCandidateUnchanged: true,
    }},
  };
  const admitted = admitAutomaticPublicTuple(value);
  assert.equal(admitted.targetBuildRun, "39917780677");
});
