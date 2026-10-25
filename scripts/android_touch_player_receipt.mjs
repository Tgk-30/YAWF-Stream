import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_TRUE = [
  "nativeUiAutomationOnly",
  "firstDecodeClockAdvanced",
  "centralPauseResume",
  "pausedBackForward",
  "twoRealAudioTracksObserved",
  "japaneseSelectionPersistedAfterHandoff",
  "normalHlsMetadataReady",
  "nativeDoubleTapInjectionUsed",
  "doubleTapGestureTimingValid",
  "doubleTapPlayerSafetyVerified",
  "doubleTapPointOutsideActionableControls",
  "pausedSideDoubleTapSingleSeek",
  "portraitLandscapePortrait",
  "audioSelectionPersistedAcrossOrientation",
  "playbackActionsRailScrolled",
  "playbackSettingsOpened",
  "externalPlayerActionReachable",
  "playbackSettingsCloseUsed",
  "pausedJapanesePreservedAfterPlaybackSettings",
];

export function validateTouchPlayerEvidence(ui, server) {
  assert.equal(ui?.schemaVersion, 1);
  assert.equal(ui?.outcome, "passed");
  assert.equal(ui?.fixture, "exact-multiaudio-real-server-transcoder-proxy");
  assert.equal(ui?.evidenceStatus, "provisional");
  assert.equal(ui?.decodedPlaybackClaimed, false);
  assert.equal(ui?.manualDecodedPlaybackReviewRequired, true);
  assert.deepEqual(ui?.manualDecodedPlaybackReviewCaptureLabels,
    ["playing-clock-initial", "playing-clock-advanced"]);
  assert.equal(ui?.manualGestureReviewRequired, true);
  assert.deepEqual(ui?.manualGestureReviewCaptureLabels,
    ["before-side-double-tap", "after-side-double-tap"]);
  assert.equal(ui?.checks?.webViewInjectionUsed, false);
  assert.equal(ui?.checks?.privatePreferencesUsed, false);
  assert.equal(ui?.checks?.permissionGrantUsed, false);
  assert.equal(ui?.strictSeekSemanticObserved, true);
  assert.equal(ui?.checks?.strictSeekSemanticObserved, true);
  assert.equal(typeof ui?.nativeSeekRangeObserved, "boolean");
  assert.equal(ui?.checks?.nativeSeekRangeObserved, ui.nativeSeekRangeObserved);
  const observationBasis = ui?.playbackClockObservationBasis;
  assert.equal(ui?.checks?.playbackClockObservationBasis, observationBasis);
  assert.ok([
    "native-seekbar-aria-valuetext",
    "native-seekbar-range-plus-aria-valuetext",
  ].includes(observationBasis));
  assert.equal(ui.nativeSeekRangeObserved,
    observationBasis === "native-seekbar-range-plus-aria-valuetext");
  assert.equal(ui?.nativeDoubleTapInjectionUsed, true);
  assert.equal(ui?.doubleTapObservationBasis,
    "uiautomation-motion-event-source-touchscreen-uptime");
  assert.equal(ui?.checks?.doubleTapObservationBasis, ui.doubleTapObservationBasis);
  for (const key of REQUIRED_TRUE) assert.equal(ui.checks[key], true, key);
  assert.ok(Number.isInteger(ui.checks.pausedClockBeforeResumeSeconds));
  assert.ok(ui.checks.pausedClockBeforeResumeSeconds >= 0
    && ui.checks.pausedClockBeforeResumeSeconds <= 5);
  assert.ok(Number.isInteger(ui.checks.touchScrubDeltaSeconds));
  assert.ok(ui.checks.touchScrubDeltaSeconds >= 3 && ui.checks.touchScrubDeltaSeconds <= 25);
  const preAudioSwitch = ui.checks.preAudioSwitchAbsolutePositionSeconds;
  const postHandoff = ui.checks.postHandoffAbsolutePositionSeconds;
  assert.ok(Number.isInteger(preAudioSwitch) && preAudioSwitch > 0 && preAudioSwitch <= 30);
  assert.ok(Number.isInteger(postHandoff) && postHandoff > 0 && postHandoff <= 30);
  assert.ok(Math.abs(postHandoff - preAudioSwitch) <= 1);
  const preRotation = ui.checks.preRotationAbsolutePositionSeconds;
  const postRotation = ui.checks.postRotationAbsolutePositionSeconds;
  assert.ok(Number.isInteger(preRotation) && preRotation > 0 && preRotation <= 30);
  assert.ok(Number.isInteger(postRotation) && postRotation > 0 && postRotation <= 30);
  assert.ok(Math.abs(postRotation - preRotation) <= 1);

  const eventTimes = [
    ui.checks.doubleTapFirstDownUptimeMs,
    ui.checks.doubleTapFirstUpUptimeMs,
    ui.checks.doubleTapSecondDownUptimeMs,
    ui.checks.doubleTapSecondUpUptimeMs,
  ];
  for (const value of eventTimes) assert.ok(Number.isSafeInteger(value) && value >= 0);
  assert.ok(eventTimes[0] < eventTimes[1]
    && eventTimes[1] < eventTimes[2] && eventTimes[2] < eventTimes[3]);
  assert.ok(eventTimes[1] - eventTimes[0] <= 100);
  assert.ok(eventTimes[2] - eventTimes[1] <= 200);
  assert.ok(eventTimes[3] - eventTimes[2] <= 100);
  assert.equal(ui.checks.doubleTapUpToUpGapMs, eventTimes[3] - eventTimes[1]);
  assert.ok(ui.checks.doubleTapUpToUpGapMs <= 320);
  assert.ok(Number.isInteger(ui.checks.doubleTapPointXPx) && ui.checks.doubleTapPointXPx > 0);
  assert.ok(Number.isInteger(ui.checks.doubleTapPointYPx) && ui.checks.doubleTapPointYPx > 0);
  assert.ok(Number.isInteger(ui.checks.pausedSideDoubleTapDeltaSeconds));
  assert.ok(ui.checks.pausedSideDoubleTapDeltaSeconds >= 9
    && ui.checks.pausedSideDoubleTapDeltaSeconds <= 11);
  assert.equal(ui.checks.externalPlayerActionLaunched, false);
  assert.ok(Number.isInteger(ui.checks.playbackActionsRailPanAttempts)
    && ui.checks.playbackActionsRailPanAttempts >= 1
    && ui.checks.playbackActionsRailPanAttempts <= 4);
  assert.ok(Number.isInteger(ui.checks.playbackSettingsVerticalPanAttempts)
    && ui.checks.playbackSettingsVerticalPanAttempts >= 0
    && ui.checks.playbackSettingsVerticalPanAttempts <= 4);
  assert.ok(Number.isInteger(ui.checks.playbackSettingsUpwardPanAttempts)
    && ui.checks.playbackSettingsUpwardPanAttempts >= 0
    && ui.checks.playbackSettingsUpwardPanAttempts <= 4);
  assert.ok(Number.isInteger(ui.checks.playbackActionsRailReturnPanAttempts)
    && ui.checks.playbackActionsRailReturnPanAttempts >= 0
    && ui.checks.playbackActionsRailReturnPanAttempts <= 4);

  const dimensions = [
    "initialPortraitWidthPx", "initialPortraitHeightPx",
    "portraitBeforeOrientationWidthPx", "portraitBeforeOrientationHeightPx",
    "landscapeWidthPx", "landscapeHeightPx",
    "portraitReturnWidthPx", "portraitReturnHeightPx",
  ];
  for (const key of dimensions) assert.ok(Number.isInteger(ui.checks[key]) && ui.checks[key] > 0, key);
  assert.ok(ui.checks.initialPortraitHeightPx > ui.checks.initialPortraitWidthPx);
  assert.ok(ui.checks.portraitBeforeOrientationHeightPx > ui.checks.portraitBeforeOrientationWidthPx);
  assert.ok(ui.checks.landscapeWidthPx > ui.checks.landscapeHeightPx);
  assert.equal(ui.checks.portraitReturnWidthPx, ui.checks.portraitBeforeOrientationWidthPx);
  assert.equal(ui.checks.portraitReturnHeightPx, ui.checks.portraitBeforeOrientationHeightPx);

  assert.equal(server?.schemaVersion, 1);
  assert.equal(server?.droppedEntries, 0);
  assert.ok(Array.isArray(server?.events));
  assert.ok(server.events.length > 0 && server.events.length <= server.maxEntries);
  const events = server.events;
  assert.ok(events.some((event) => event.phase === "live" && event.route === "proxy" && [200, 206].includes(event.status)
    && event.contentType === "video-mp4"));
  assert.ok(events.some((event) => event.phase === "live" && event.route === "audio-inventory" && event.status === 200));
  // The scrubber exposes floor(displayed absolute time) through aria-valuenow,
  // while serverApi floors the same paused absolute HTMLMediaElement clock for
  // the `start` query. The retained selected-audio request must therefore use
  // that exact source-derived second, never zero or an unrelated HLS request.
  const selectedAudioHls = events.find((event) => event.phase === "live" && event.route === "hls-manifest"
    && event.status === 200 && event.audio === 1 && event.playbackDecision === "transcode"
    && Number.isInteger(event.start) && event.start > 0 && event.start === preAudioSwitch);
  assert.ok(selectedAudioHls, "selected-audio HLS start did not match the pre-switch absolute clock");
  assert.ok(events.some((event) => event.phase === "live" && event.route === "hls-asset" && event.status === 200
    && ["hls", "video-mp2t"].includes(event.contentType) && event.sequence > selectedAudioHls.sequence));
  for (let index = 0; index < events.length; index += 1) {
    assert.equal(events[index].sequence, index + 1);
    assert.ok(Number.isInteger(events[index].elapsedMs) && events[index].elapsedMs >= 0);
    assert.ok(["GET", "HEAD"].includes(events[index].method));
    assert.ok(["smoke", "live"].includes(events[index].phase));
  }
  return {
    schemaVersion: 1,
    outcome: "provisional",
    decodedPlaybackClaimed: false,
    manualDecodedPlaybackReviewRequired: true,
    playbackClockObservationBasis: observationBasis,
    nativeSeekRangeObserved: ui.nativeSeekRangeObserved,
    nativeDoubleTapInjectionUsed: true,
    doubleTapObservationBasis: ui.doubleTapObservationBasis,
    manualGestureReviewRequired: true,
    playbackActionsRailScrolled: true,
    externalPlayerActionReachable: true,
    externalPlayerActionLaunched: false,
    uiChecks: REQUIRED_TRUE.length + 16,
    serverEvents: events.length,
    realProxyObserved: true,
    realAudioInventoryObserved: true,
    realSelectedAudioHlsObserved: true,
    selectedAudioHlsStartSeconds: selectedAudioHls.start,
    preAudioSwitchAbsolutePositionSeconds: preAudioSwitch,
    postHandoffAbsolutePositionSeconds: postHandoff,
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--ui", "--server", "--output"].includes(key) || value == null || value.startsWith("--")) {
      throw new Error("Usage: android_touch_player_receipt.mjs --ui <receipt> --server <receipt> --output <receipt>");
    }
    if (values[key] != null) throw new Error(`Duplicate ${key}`);
    values[key] = value;
  }
  for (const key of ["--ui", "--server", "--output"]) {
    if (values[key] == null) throw new Error(`Missing ${key}`);
  }
  return values;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseArgs(process.argv.slice(2));
  const result = validateTouchPlayerEvidence(
    JSON.parse(readFileSync(resolve(args["--ui"]), "utf8")),
    JSON.parse(readFileSync(resolve(args["--server"]), "utf8")),
  );
  writeFileSync(resolve(args["--output"]), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log("Touch-player runtime receipts passed the provisional schema gate; decoded playback still requires manual PNG review.");
}
