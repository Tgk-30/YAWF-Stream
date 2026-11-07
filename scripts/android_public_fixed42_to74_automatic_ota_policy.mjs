export {
  BASELINE42, SIGNER_SHA256, UPDATER_SHA256,
  firstEnableCancellationIsBounded, automaticOfferIsFromDistinctLaterReturn,
  fourMarkersAreReadOnlyAfterInstall,
} from "./android_public_fixed42_to61_automatic_ota_policy.mjs";

export const FIXED42_PROFILE = "public-fixed42-to74-initial-cancel-due-resume-v1";
export const FIXED42_EVIDENCE_SUBDIR = "fixed42-to74-automatic-public-ota-flow";

export const TARGET74 = Object.freeze({
  version: "2.3.74",
  versionCode: 2_003_074,
  tag: "android-v2.3.74",
  sourceRevision: "6eff963227ef58adc508c35abb56c58a615a8a96",
  apkName: "YAWF.Stream_Android_2.3.74.apk",
  apkSha256: "d6eda3e15aca6005ea9be32b793339cd22469b4802b39326f3ee9ab17b47b7ae",
  apkSize: 88_669_057,
  buildRun: 42_365_613_314,
  manifestSha256: "0493b4ba62722d38b7223648d6c2ca4423d8f6934df735316f17da7285491984",
  verificationSha256: "c74413a7a4a0591df1407b9483d00e98f1919b538c1fbb6b009439121a750130",
  verificationName: "Android_2.3.74_verification.json",
  checksumsSha256: "4bc1283984e9d3c8573414a8aff08a7a651e8e04354492e8cbde7c6aa6c6bdaa",
});


export function postInstallInspectionIsBounded(observation) {
  return observation != null
    && observation.automaticOfferOrdinal >= 1
    && Number.isSafeInteger(observation.automaticOfferOrdinal)
    && observation.postInstallInspectionOrdinal > observation.automaticOfferOrdinal
    && Number.isSafeInteger(observation.postInstallInspectionOrdinal)
    && observation.postInstallManualInspectionChecks === 1
    && observation.preOfferManualDiscoveries === 0
    && observation.exactUpToDate74Observed === true
    && observation.weeklyOnAfterUpdate === true
    && observation.postInstallNativeOkClosures === 1
    && observation.postInstallNativeCancelClosures === 0;
}

