import test from "node:test";
import assert from "node:assert/strict";

import {
  buildNativeStageReceipt,
  validateNativeReceipt,
} from "./android_foreground_playback_receipt.mjs";

const hash = character => character.repeat(64);

function nativeReceipt({ mode = "admission", playbackCase = "direct" } = {}) {
  const required = mode === "full" ? 480_000 : 15_000;
  const count = mode === "full" ? 5 : 2;
  return {
    schemaVersion: 1,
    scope: "ordinary-android-phone-foreground-playback",
    outcome: "native-window-observed",
    failureClass: null,
    finalPhase: "native-observation-complete",
    mode,
    playbackCase,
    productPackage: "com.tgk30.debridstreamer",
    fixture: "bounded-loopback-server-mode",
    windowRequiredMs: required,
    windowObservedMs: required + 250,
    testObservedMs: required + 30_000,
    sourceSelectedThroughOrdinaryUi: true,
    quality480SelectedThroughOrdinaryUi: playbackCase === "hls",
    readOnlyDetailsOpenedBeforeWindow: true,
    noPlaybackStateInputDuringWindow: true,
    externalPlayerUsed: false,
    instrumentationWebViewAccessUsed: false,
    serverPassiveObserverUsed: true,
    privateStateRead: false,
    stage2ObserverAbiIntegrated: false,
    manualBurnedClockReviewRequired: true,
    fullQualification: false,
    anchors: Array.from({ length: count }, (_, index) => ({
      ordinal: index + 1,
      elapsedMs: Math.round(required * index / (count - 1)) + (index === count - 1 ? 250 : 0),
      file: `anchor-${String(index + 1).padStart(2, "0")}-${mode}-${playbackCase}.png`,
      sha256: hash(String((index + 1) % 10)),
    })),
    samples: Array.from({ length: count }, (_, index) => ({
      elapsedMs: Math.round(required * index / (count - 1)) + (index === count - 1 ? 250 : 0),
      decodedFrames: 100 + index * 120,
      bufferHealthSeconds: 24.5,
      playerOwned: true,
      detailsVisible: true,
    })),
  };
}

test("native admission receipt remains explicitly unintegrated and non-qualifying", () => {
  const result = buildNativeStageReceipt(nativeReceipt());
  assert.equal(result.outcome, "observer-abi-unintegrated");
  assert.equal(result.hostedAdmission, false);
  assert.equal(result.fullQualification, false);
  assert.equal(result.observerIntegrationStatus, "stage2-schema-and-sealed-window-required");
  assert.equal(result.missingTelemetryNeverCountsAsStagnation, true);
  assert.equal(result.ordinaryHtmlProvenanceIsNotAccepted, true);
});

test("full native HLS receipt still cannot qualify without the Stage 2 ABI", () => {
  const result = buildNativeStageReceipt(nativeReceipt({ mode: "full", playbackCase: "hls" }));
  assert.equal(result.native.observedMs, 480_250);
  assert.equal(result.native.playbackCase, "hls");
  assert.equal(result.hostedAdmission, false);
  assert.equal(result.fullQualification, false);
  assert.ok(result.missingObserverFields.includes("directResponseLedger"));
  assert.ok(result.missingObserverFields.includes("sealedDocumentSourceWallWindow"));
});

test("native validator rejects a receipt that self-declares full qualification", () => {
  const receipt = nativeReceipt();
  receipt.fullQualification = true;
  assert.throws(() => validateNativeReceipt(receipt), /fullQualification/);
});

test("native validator rejects a false claim that server observer ABI was integrated", () => {
  const receipt = nativeReceipt();
  receipt.stage2ObserverAbiIntegrated = true;
  assert.throws(() => validateNativeReceipt(receipt), /stage2ObserverAbiIntegrated/);
});

test("native validator distinguishes server observation from instrumentation WebView access", () => {
  const receipt = nativeReceipt();
  receipt.instrumentationWebViewAccessUsed = true;
  assert.throws(() => validateNativeReceipt(receipt), /instrumentationWebViewAccessUsed/);
  receipt.instrumentationWebViewAccessUsed = false;
  receipt.serverPassiveObserverUsed = false;
  assert.throws(() => validateNativeReceipt(receipt), /serverPassiveObserverUsed/);
});

test("native validator rejects insufficient real-time duration", () => {
  const receipt = nativeReceipt({ mode: "full", playbackCase: "hls" });
  receipt.windowObservedMs = 479_999;
  assert.throws(() => validateNativeReceipt(receipt), /windowObservedMs/);
});

test("native validator rejects missing 480p ordinary UI selection", () => {
  const receipt = nativeReceipt({ playbackCase: "hls" });
  receipt.quality480SelectedThroughOrdinaryUi = false;
  assert.throws(() => validateNativeReceipt(receipt), /quality480SelectedThroughOrdinaryUi/);
});

test("native validator rejects playback input inside the measured window", () => {
  const receipt = nativeReceipt();
  receipt.noPlaybackStateInputDuringWindow = false;
  assert.throws(() => validateNativeReceipt(receipt), /noPlaybackStateInputDuringWindow/);
});

test("native validator rejects backward decoded-frame samples", () => {
  const receipt = nativeReceipt();
  receipt.samples[1].decodedFrames = 99;
  assert.throws(() => validateNativeReceipt(receipt), /moved backwards/);
});

test("native validator rejects repeated screenshot content", () => {
  const receipt = nativeReceipt();
  receipt.anchors[1].sha256 = receipt.anchors[0].sha256;
  assert.throws(() => validateNativeReceipt(receipt), /frame progress/);
});

test("native validator rejects unexpected fields instead of carrying private data", () => {
  const receipt = nativeReceipt();
  receipt.rawUrl = "not-allowed";
  assert.throws(() => validateNativeReceipt(receipt), /unsupported field/);
});
