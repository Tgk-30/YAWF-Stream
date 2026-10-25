export const FIXED42_PROFILE = "public-fixed42-to61-initial-cancel-due-resume-v1";
export const FIXED42_EVIDENCE_SUBDIR = "fixed42-to61-automatic-public-ota-flow";
export const SIGNER_SHA256 = "233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a";
export const UPDATER_SHA256 = "129df15e095ed5ce8933d17ab9a0329da79244e14ac046df18c3fad32e01163d";

export const BASELINE42 = Object.freeze({
  version: "2.3.42",
  versionCode: 2_003_042,
  tag: "android-v2.3.42",
  sourceRevision: "ae9b35f8513c9f7e203508f2c95f1f99d77ddcf5",
  apkName: "YAWF.Stream_Android_2.3.42.apk",
  apkSha256: "3e1f72c2d1214b491fb505b5ea85ccc507d2478288066ff9cf846c5924d1805c",
  apkSize: 88_583_041,
  buildRun: 40_025_606_020,
  manifestSha256: "26fedf40c35011ecf3edaa29462c18f04301dafae7dd9e3808e1ea1e2a3001a8",
  verificationSha256: "a87360645d7700f7c2ff9a99629d714b7d126fbe5d66a9a2e44a10baad42c4dc",
  verificationName: "Android_2.3.42_verification.json",
});

export const TARGET61 = Object.freeze({
  version: "2.3.61",
  versionCode: 2_003_061,
  tag: "android-v2.3.61",
  sourceRevision: "e2dee689276610ffb1685a6f47ac37f183f35a7e",
  apkName: "YAWF.Stream_Android_2.3.61.apk",
  apkSha256: "a4696ab0533cdc99e3f5e373031d89e58a6cd8f6742a9107085220765bb5b247",
  apkSize: 88_640_385,
  buildRun: 40_238_512_551,
  manifestSha256: "8828c76dd0696c7b70d548fcfdbb4657076825c5b40e5fa81b2ce1dd23be9815",
  verificationSha256: "25afa6bca5261b02a0372eb0fc88934573ae2bce0091bd526007f963fe5b26b2",
  verificationName: "Android_2.3.61_verification.json",
  checksumsSha256: "46ab6b40b63ea787feb33215df993d99898d023e4371b986b79d4eb1ac94e1a8",
});

function exactBoolean(value) {
  return typeof value === "boolean";
}

function exactNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function firstEnableCancellationIsBounded(observation) {
  return observation != null
    && exactBoolean(observation.checkingTitleObserved)
    && observation.checkingTitleObserved
    && exactBoolean(observation.checkingMessageObserved)
    && observation.checkingMessageObserved
    && exactBoolean(observation.cancelObserved)
    && observation.cancelObserved
    && exactBoolean(observation.terminalResultExcludedBeforeCancel)
    && observation.terminalResultExcludedBeforeCancel
    && observation.cancelSelections === 1
    && exactBoolean(observation.cancelWon)
    && observation.cancelWon
    && observation.settledResultExclusionSamples >= 3
    && Number.isSafeInteger(observation.settledResultExclusionSamples);
}

export function automaticOfferIsFromDistinctLaterReturn(observation) {
  return observation != null
    && observation.preOfferManualDiscoveries === 0
    && exactNonNegativeInteger(observation.triggerReturnOrdinal)
    && observation.triggerReturnOrdinal >= 1
    && observation.deferredOfferReturnOrdinal === observation.triggerReturnOrdinal + 1
    && observation.offerAbsentSameForeground === true
    && observation.deferredExactOfferObserved === true
    && observation.weeklyOnAtDeferredOffer === true;
}

export function postInstallInspectionIsBounded(observation) {
  return observation != null
    && observation.automaticOfferOrdinal >= 1
    && Number.isSafeInteger(observation.automaticOfferOrdinal)
    && observation.postInstallInspectionOrdinal > observation.automaticOfferOrdinal
    && Number.isSafeInteger(observation.postInstallInspectionOrdinal)
    && observation.postInstallManualInspectionChecks === 1
    && observation.preOfferManualDiscoveries === 0
    && observation.exactUpToDate61Observed === true
    && observation.weeklyOnAfterUpdate === true
    && observation.postInstallNativeOkClosures === 1
    && observation.postInstallNativeCancelClosures === 0;
}

export function fourMarkersAreReadOnlyAfterInstall(observation) {
  return observation != null
    && observation.profileNameSetTextActions === 1
    && observation.profileNamePostInstallSetTextActions === 0
    && observation.profileImmediateExact === true
    && observation.profileCloseReopenExact === true
    && observation.profilePersistedWarm === true
    && observation.appearancePersistedWarm === true
    && observation.watchlistPersistedWarm === true
    && observation.folderPersistedWarm === true
    && observation.profilePersistedAfterTaskRelaunch === true
    && observation.appearancePersistedAfterTaskRelaunch === true
    && observation.watchlistPersistedAfterTaskRelaunch === true
    && observation.folderPersistedAfterTaskRelaunch === true;
}
