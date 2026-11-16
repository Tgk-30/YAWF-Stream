#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_NATIVE_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_FILE = /^anchor-[0-9]{2}-(?:admission|full)-(?:direct|hls)\.png$/;
const NATIVE_KEYS = new Set([
  "schemaVersion", "scope", "outcome", "failureClass", "finalPhase", "mode",
  "playbackCase", "productPackage", "fixture", "windowRequiredMs", "windowObservedMs",
  "testObservedMs", "sourceSelectedThroughOrdinaryUi", "quality480SelectedThroughOrdinaryUi",
  "readOnlyDetailsOpenedBeforeWindow", "noPlaybackStateInputDuringWindow", "externalPlayerUsed",
  "instrumentationWebViewAccessUsed", "serverPassiveObserverUsed", "privateStateRead",
  "stage2ObserverAbiIntegrated", "manualBurnedClockReviewRequired", "fullQualification",
  "anchors", "samples",
]);

function refusal(code, message) {
  const error = new Error(message);
  error.code = code;
  error.safeMessage = true;
  return error;
}
function object(value, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw refusal("schema", `${label} must be an object`);
  }
  return value;
}
function allowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw refusal("schema", `${label} contains an unsupported field`);
  }
}
function exactBoolean(value, expected, label) {
  if (value !== expected) throw refusal("schema", `${label} must be ${expected}`);
}
function finiteNumber(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw refusal("schema", `${label} is outside its bounded numeric range`);
  }
  return value;
}
function safeRegularText(path, limit, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > limit) {
    throw refusal("unsafe-file", `${label} must be a bounded regular non-symlink file`);
  }
  return readFileSync(path, "utf8");
}

export function validateNativeReceipt(input) {
  const receipt = object(input, "native receipt");
  allowedKeys(receipt, NATIVE_KEYS, "native receipt");
  if (receipt.schemaVersion !== 1
      || receipt.scope !== "ordinary-android-phone-foreground-playback"
      || receipt.outcome !== "native-window-observed" || receipt.failureClass !== null
      || receipt.productPackage !== "com.tgk30.debridstreamer"
      || receipt.fixture !== "bounded-loopback-server-mode") {
    throw refusal("native-outcome", "Native receipt identity or outcome is invalid");
  }
  if (!new Set(["admission", "full"]).has(receipt.mode)
      || !new Set(["direct", "hls"]).has(receipt.playbackCase)) {
    throw refusal("native-mode", "Native mode or playback case is unsupported");
  }
  const requiredMs = receipt.mode === "full" ? 480_000 : 15_000;
  const expectedAnchors = receipt.mode === "full" ? 5 : 2;
  if (receipt.windowRequiredMs !== requiredMs) {
    throw refusal("native-duration", "Native required duration does not match its mode");
  }
  const observedMs = finiteNumber(receipt.windowObservedMs, requiredMs,
    requiredMs + (receipt.mode === "full" ? 30_000 : 15_000), "windowObservedMs");
  exactBoolean(receipt.sourceSelectedThroughOrdinaryUi, true, "sourceSelectedThroughOrdinaryUi");
  exactBoolean(receipt.quality480SelectedThroughOrdinaryUi, receipt.playbackCase === "hls",
    "quality480SelectedThroughOrdinaryUi");
  exactBoolean(receipt.readOnlyDetailsOpenedBeforeWindow, true, "readOnlyDetailsOpenedBeforeWindow");
  exactBoolean(receipt.noPlaybackStateInputDuringWindow, true, "noPlaybackStateInputDuringWindow");
  exactBoolean(receipt.externalPlayerUsed, false, "externalPlayerUsed");
  exactBoolean(receipt.instrumentationWebViewAccessUsed, false, "instrumentationWebViewAccessUsed");
  exactBoolean(receipt.serverPassiveObserverUsed, true, "serverPassiveObserverUsed");
  exactBoolean(receipt.privateStateRead, false, "privateStateRead");
  exactBoolean(receipt.stage2ObserverAbiIntegrated, false, "stage2ObserverAbiIntegrated");
  exactBoolean(receipt.manualBurnedClockReviewRequired, true, "manualBurnedClockReviewRequired");
  exactBoolean(receipt.fullQualification, false, "fullQualification");
  if (!Array.isArray(receipt.anchors) || receipt.anchors.length !== expectedAnchors
      || !Array.isArray(receipt.samples) || receipt.samples.length !== expectedAnchors) {
    throw refusal("native-anchors", "Native receipt has the wrong bounded anchor or sample count");
  }
  let previousAnchor = -1;
  let previousFrames = -1;
  let firstFrames = null;
  let lastFrames = null;
  const screenshotHashes = new Set();
  for (let index = 0; index < expectedAnchors; index += 1) {
    const anchor = object(receipt.anchors[index], `anchor ${index + 1}`);
    const sample = object(receipt.samples[index], `sample ${index + 1}`);
    allowedKeys(anchor, new Set(["ordinal", "elapsedMs", "file", "sha256"]), `anchor ${index + 1}`);
    allowedKeys(sample, new Set([
      "elapsedMs", "decodedFrames", "bufferHealthSeconds", "playerOwned", "detailsVisible",
    ]), `sample ${index + 1}`);
    const expectedFile = `anchor-${String(index + 1).padStart(2, "0")}-${receipt.mode}-${receipt.playbackCase}.png`;
    if (anchor.ordinal !== index + 1 || anchor.file !== expectedFile || !SAFE_FILE.test(anchor.file)
        || typeof anchor.sha256 !== "string" || !SHA256.test(anchor.sha256)) {
      throw refusal("native-anchor", `Native anchor ${index + 1} identity is invalid`);
    }
    screenshotHashes.add(anchor.sha256);
    const anchorElapsed = finiteNumber(anchor.elapsedMs, 0, observedMs + 2_000,
      `anchor ${index + 1} elapsedMs`);
    const sampleElapsed = finiteNumber(sample.elapsedMs, 0, observedMs + 2_000,
      `sample ${index + 1} elapsedMs`);
    if (anchorElapsed < previousAnchor || Math.abs(anchorElapsed - sampleElapsed) > 5_000) {
      throw refusal("native-order", "Native anchors or samples are not monotonic and co-located");
    }
    previousAnchor = anchorElapsed;
    const frames = finiteNumber(sample.decodedFrames, 0, Number.MAX_SAFE_INTEGER,
      `sample ${index + 1} decodedFrames`);
    finiteNumber(sample.bufferHealthSeconds, 0, 7_200,
      `sample ${index + 1} bufferHealthSeconds`);
    exactBoolean(sample.playerOwned, true, `sample ${index + 1} playerOwned`);
    exactBoolean(sample.detailsVisible, true, `sample ${index + 1} detailsVisible`);
    if (!Number.isSafeInteger(frames) || frames < previousFrames) {
      throw refusal("native-frames", "Decoded-frame samples moved backwards or were not integers");
    }
    previousFrames = frames;
    if (firstFrames == null) firstFrames = frames;
    lastFrames = frames;
  }
  if (receipt.anchors[0].elapsedMs > 5_000 || receipt.anchors.at(-1).elapsedMs < requiredMs
      || screenshotHashes.size < 2 || lastFrames - firstFrames < (receipt.mode === "full" ? 60 : 5)) {
    throw refusal("native-progress", "Native anchors do not span the required window with frame progress");
  }
  return { mode: receipt.mode, playbackCase: receipt.playbackCase, observedMs,
    anchorCount: expectedAnchors, decodedFrameDelta: lastFrames - firstFrames };
}

export function validateAnchorFiles(receiptInput, evidenceDirectory) {
  const receipt = object(receiptInput, "native receipt");
  const directory = resolve(evidenceDirectory);
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw refusal("unsafe-file", "Evidence directory must be a real directory");
  }
  let bytes = 0;
  for (const raw of receipt.anchors ?? []) {
    const anchor = object(raw, "native anchor");
    if (typeof anchor.file !== "string" || !SAFE_FILE.test(anchor.file)) {
      throw refusal("native-anchor", "Native anchor file name is unsafe");
    }
    const path = resolve(directory, anchor.file);
    if (!path.startsWith(`${directory}/`)) throw refusal("unsafe-file", "Native anchor escaped its directory");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 8 * 1024 * 1024) {
      throw refusal("unsafe-file", "Native anchor must be a bounded regular non-symlink file");
    }
    bytes += stat.size;
    if (bytes > 40 * 1024 * 1024) throw refusal("size", "Native anchors exceed their aggregate bound");
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actual !== anchor.sha256) throw refusal("native-anchor", "Native anchor hash did not match its receipt");
  }
  return { files: receipt.anchors.length, bytes };
}

export function buildNativeStageReceipt(nativeReceipt, nativeAnchors = null) {
  const native = validateNativeReceipt(nativeReceipt);
  return {
    schemaVersion: 1,
    scope: "android-foreground-playback-native-ui-stage",
    outcome: "observer-abi-unintegrated",
    hostedAdmission: false,
    fullQualification: false,
    pauseCauseEstablished: false,
    native,
    nativeAnchors,
    observerIntegrationStatus: "stage2-schema-and-sealed-window-required",
    missingObserverFields: [
      "schemaVersion", "sequence", "totalFrames", "rate", "error", "standalone",
      "sourceKind", "oneWayStreamReference", "generationReference", "directResponseLedger",
      "sealedDocumentSourceWallWindow",
    ],
    missingTelemetryNeverCountsAsStagnation: true,
    ordinaryHtmlProvenanceIsNotAccepted: true,
    manualBurnedClockReviewRequired: true,
    heldSegmentNegativeControlRequiredSeparately: true,
  };
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--native", "--evidence-dir", "--output"]).has(key) || value == null) {
      throw refusal("arguments", "Expected native, evidence-directory, and output paths");
    }
    result[key.slice(2)] = value;
  }
  if (argv.length !== 6 || result.native == null || result["evidence-dir"] == null || result.output == null) {
    throw refusal("arguments", "Expected exactly --native, --evidence-dir, and --output paths");
  }
  return result;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const nativeText = safeRegularText(resolve(args.native), MAX_NATIVE_BYTES, "native receipt");
  let nativeReceipt;
  try { nativeReceipt = JSON.parse(nativeText); }
  catch { throw refusal("native-json", "Native receipt is not JSON"); }
  const anchors = validateAnchorFiles(nativeReceipt, args["evidence-dir"]);
  const result = buildNativeStageReceipt(nativeReceipt, anchors);
  const encoded = `${JSON.stringify(result, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > MAX_OUTPUT_BYTES) throw refusal("output-size", "Output exceeded its bound");
  const outputPath = resolve(args.output);
  writeFileSync(outputPath, encoded, { mode: 0o600, flag: "wx" });
  process.stdout.write(`${JSON.stringify({ outcome: result.outcome, hostedAdmission: false,
    fullQualification: false, output: basename(outputPath) })}\n`);
  return result;
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    const code = error?.safeMessage === true ? error.code : "refused";
    const message = error?.safeMessage === true ? error.message : "validation refused";
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  }
}
