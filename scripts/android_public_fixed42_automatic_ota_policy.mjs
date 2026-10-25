export const FIXED42_PROFILE = "public-fixed42-to59-initial-cancel-due-resume-v1";
export const FIXED42_EVIDENCE_SUBDIR = "fixed42-automatic-public-ota-flow";
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

export const TARGET59 = Object.freeze({
  version: "2.3.59",
  versionCode: 2_003_059,
  tag: "android-v2.3.59",
  sourceRevision: "ac885bb98b2672614beb801b5aea11eb2f98ab40",
  apkName: "YAWF.Stream_Android_2.3.59.apk",
  apkSha256: "5fe550e66658f3c9ae172c087c656d69e126af2892df05ca15e7e021594dae47",
  apkSize: 88_644_481,
  buildRun: 40_169_716_770,
  manifestSha256: "8d0f680abc7d52cd467ef79b3fd860e18c7e1dd15a7c5fd765a9d3941c974af6",
  verificationSha256: "28ccb986f613b68917a907b5dd9632c02e98185413ce9d09bc745eb564541294",
  verificationName: "Android_2.3.59_verification.json",
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
    && observation.exactUpToDate59Observed === true
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
