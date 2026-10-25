import assert from "node:assert/strict";
import test from "node:test";

import {
  automaticOfferIsFromDistinctLaterReturn,
  firstEnableCancellationIsBounded,
  fourMarkersAreReadOnlyAfterInstall,
  postInstallInspectionIsBounded,
} from "./android_public_fixed42_automatic_ota_policy.mjs";

function acceptedEnable() {
  return {
    checkingTitleObserved: true,
    checkingMessageObserved: true,
    cancelObserved: true,
    terminalResultExcludedBeforeCancel: true,
    cancelSelections: 1,
    cancelWon: true,
    settledResultExclusionSamples: 3,
  };
}

function acceptedOffer() {
  return {
    preOfferManualDiscoveries: 0,
    triggerReturnOrdinal: 1,
    deferredOfferReturnOrdinal: 2,
    offerAbsentSameForeground: true,
    deferredExactOfferObserved: true,
    weeklyOnAtDeferredOffer: true,
  };
}

function acceptedInspection() {
  return {
    automaticOfferOrdinal: 8,
    postInstallInspectionOrdinal: 19,
    postInstallManualInspectionChecks: 1,
    preOfferManualDiscoveries: 0,
    exactUpToDate59Observed: true,
    weeklyOnAfterUpdate: true,
    postInstallNativeOkClosures: 1,
    postInstallNativeCancelClosures: 0,
  };
}

function acceptedMarkers() {
  return {
    profileNameSetTextActions: 1,
    profileNamePostInstallSetTextActions: 0,
    profileImmediateExact: true,
    profileCloseReopenExact: true,
    profilePersistedWarm: true,
    appearancePersistedWarm: true,
    watchlistPersistedWarm: true,
    folderPersistedWarm: true,
    profilePersistedAfterTaskRelaunch: true,
    appearancePersistedAfterTaskRelaunch: true,
    watchlistPersistedAfterTaskRelaunch: true,
    folderPersistedAfterTaskRelaunch: true,
  };
}

test("first Enable cancellation requires exact progress, one Cancel, and settled result exclusion", () => {
  assert.equal(firstEnableCancellationIsBounded(acceptedEnable()), true);
  for (const [key, value] of [
    ["checkingTitleObserved", false],
    ["checkingMessageObserved", false],
    ["cancelObserved", false],
    ["terminalResultExcludedBeforeCancel", false],
    ["cancelSelections", 0],
    ["cancelSelections", 2],
    ["cancelWon", false],
    ["settledResultExclusionSamples", 2],
  ]) {
    assert.equal(firstEnableCancellationIsBounded({ ...acceptedEnable(), [key]: value }), false, key);
  }
});

test("automatic offer requires no pre-offer manual discovery and a distinct later launcher return", () => {
  assert.equal(automaticOfferIsFromDistinctLaterReturn(acceptedOffer()), true);
  for (const [key, value] of [
    ["preOfferManualDiscoveries", 1],
    ["triggerReturnOrdinal", 0],
    ["deferredOfferReturnOrdinal", 1],
    ["deferredOfferReturnOrdinal", 3],
    ["offerAbsentSameForeground", false],
    ["deferredExactOfferObserved", false],
    ["weeklyOnAtDeferredOffer", false],
  ]) {
    assert.equal(automaticOfferIsFromDistinctLaterReturn({ ...acceptedOffer(), [key]: value }), false, key);
  }
});

test("postinstall inspection is later, exactly once, exact up-to-date, weekly on, and closes once with OK", () => {
  assert.equal(postInstallInspectionIsBounded(acceptedInspection()), true);
  for (const [key, value] of [
    ["postInstallInspectionOrdinal", 7],
    ["postInstallManualInspectionChecks", 0],
    ["postInstallManualInspectionChecks", 2],
    ["preOfferManualDiscoveries", 1],
    ["exactUpToDate59Observed", false],
    ["weeklyOnAfterUpdate", false],
    ["postInstallNativeOkClosures", 0],
    ["postInstallNativeOkClosures", 2],
    ["postInstallNativeCancelClosures", 1],
  ]) {
    assert.equal(postInstallInspectionIsBounded({ ...acceptedInspection(), [key]: value }), false, key);
  }
});

test("four local markers require one preinstall profile write and read-only postinstall phases", () => {
  assert.equal(fourMarkersAreReadOnlyAfterInstall(acceptedMarkers()), true);
  for (const key of Object.keys(acceptedMarkers())) {
    const value = key.endsWith("Actions") ? (key.includes("PostInstall") ? 1 : 0) : false;
    assert.equal(fourMarkersAreReadOnlyAfterInstall({ ...acceptedMarkers(), [key]: value }), false, key);
  }
});
