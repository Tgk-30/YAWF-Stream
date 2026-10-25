#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildLiveProbeReceipt, evaluateLiveProbe, MAX_LIVE_PROBE_RECEIPT_BYTES, sanitizeFfprobeVersion } from "./live-probe-contract.mjs";

const englishLabel = "Synthetic English 440 Hz tone";
const japaneseLabel = "Synthetic Japanese 880 Hz tone";
const baseline = ({ names = true } = {}) => ({
  streams: [
    { index: 0, codec_type: "video", codec_name: "h264", codec_tag_string: "avc1", width: 320, height: 180, r_frame_rate: "30/1", tags: { language: "und", path: "/private/video" } },
    { index: 1, codec_type: "audio", codec_name: "aac", codec_tag_string: "mp4a", sample_rate: "48000", channels: 1, channel_layout: "mono", disposition: { default: 1 }, tags: { language: "eng", ...(names ? { name: englishLabel } : {}), token: "secret" } },
    { index: 2, codec_type: "audio", codec_name: "aac", codec_tag_string: "mp4a", sample_rate: "48000", channels: 1, channel_layout: "mono", disposition: { default: 0 }, tags: { language: "jpn", ...(names ? { name: japaneseLabel } : {}), url: "https://private.invalid" } },
  ],
  format: { duration: "30.000000", filename: "/private/media.mp4", url: "https://private.invalid/media", token: "secret" },
});

const clone = (value) => structuredClone(value);
const fields = (result) => result.failures.map((entry) => entry.field);

test("accepts old ffprobe output with no optional track names", () => {
  const result = evaluateLiveProbe(baseline({ names: false }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.live.streams.filter((stream) => stream.codecType === "audio").map((stream) => stream.labelState), ["absent", "absent"]);
});

test("accepts newer ffprobe output with exact pinned synthetic names", () => {
  const result = evaluateLiveProbe(baseline());
  assert.equal(result.ok, true);
  assert.deepEqual(result.live.streams.filter((stream) => stream.codecType === "audio").map((stream) => stream.labelState), ["expected", "expected"]);
});

test("rejects a present nonmatching track name without serializing it", () => {
  const value = baseline();
  value.streams[1].tags.name = "/private/token-bad-label";
  const result = evaluateLiveProbe(value);
  assert.equal(result.ok, false);
  assert.ok(fields(result).includes("audio.eng.label"));
  assert.equal(JSON.stringify(result).includes("private/token"), false);
});

const mandatoryMutants = [
  ["streams.count", (value) => value.streams.pop()],
  ["streams.video.count", (value) => { value.streams[0].codec_type = "audio"; }],
  ["video.codecName", (value) => { value.streams[0].codec_name = "vp9"; }],
  ["video.width", (value) => { value.streams[0].width = 321; }],
  ["video.height", (value) => { value.streams[0].height = 181; }],
  ["video.frameRate", (value) => { value.streams[0].r_frame_rate = "30000/1001"; }],
  ["streams.audio.count", (value) => { value.streams[2].codec_type = "video"; }],
  ["audio.eng.count", (value) => { value.streams[1].tags.language = "fra"; }],
  ["audio.eng.codecName", (value) => { value.streams[1].codec_name = "opus"; }],
  ["audio.eng.sampleRate", (value) => { value.streams[1].sample_rate = "44100"; }],
  ["audio.eng.channels", (value) => { value.streams[1].channels = 2; }],
  ["audio.eng.channelLayout", (value) => { value.streams[1].channel_layout = "stereo"; }],
  ["audio.eng.default", (value) => { value.streams[1].disposition.default = 0; }],
  ["audio.jpn.count", (value) => { value.streams[2].tags.language = "eng"; }],
  ["audio.jpn.codecName", (value) => { value.streams[2].codec_name = "mp3"; }],
  ["audio.jpn.sampleRate", (value) => { value.streams[2].sample_rate = "96000"; }],
  ["audio.jpn.channels", (value) => { value.streams[2].channels = 0; }],
  ["audio.jpn.channelLayout", (value) => { value.streams[2].channel_layout = "stereo"; }],
  ["audio.jpn.default", (value) => { value.streams[2].disposition.default = 1; }],
  ["format.duration", (value) => { value.format.duration = "29.999000"; }],
];

for (const [field, mutate] of mandatoryMutants) {
  test(`fails closed for mandatory field ${field}`, () => {
    const value = clone(baseline());
    mutate(value);
    const result = evaluateLiveProbe(value);
    assert.equal(result.ok, false);
    assert.ok(fields(result).includes(field), `${field}: ${JSON.stringify(result.failures)}`);
  });
}

const unavailableMandatoryFacts = [
  ["video codec type", "video.codecType", (value) => { delete value.streams[0].codec_type; }],
  ["video codec", "video.codecName", (value) => { delete value.streams[0].codec_name; }],
  ["video width", "video.width", (value) => { delete value.streams[0].width; }],
  ["video height", "video.height", (value) => { delete value.streams[0].height; }],
  ["video frame rate", "video.frameRate", (value) => { delete value.streams[0].r_frame_rate; }],
  ["English codec type", "audio.eng.codecType", (value) => { delete value.streams[1].codec_type; }],
  ["English language", "audio.eng.language", (value) => { delete value.streams[1].tags.language; }],
  ["English codec", "audio.eng.codecName", (value) => { delete value.streams[1].codec_name; }],
  ["English sample rate", "audio.eng.sampleRate", (value) => { delete value.streams[1].sample_rate; }],
  ["English channels", "audio.eng.channels", (value) => { delete value.streams[1].channels; }],
  ["English channel layout", "audio.eng.channelLayout", (value) => { delete value.streams[1].channel_layout; }],
  ["English default disposition", "audio.eng.default", (value) => { delete value.streams[1].disposition.default; }],
  ["Japanese codec type", "audio.jpn.codecType", (value) => { delete value.streams[2].codec_type; }],
  ["Japanese language", "audio.jpn.language", (value) => { delete value.streams[2].tags.language; }],
  ["Japanese codec", "audio.jpn.codecName", (value) => { delete value.streams[2].codec_name; }],
  ["Japanese sample rate", "audio.jpn.sampleRate", (value) => { delete value.streams[2].sample_rate; }],
  ["Japanese channels", "audio.jpn.channels", (value) => { delete value.streams[2].channels; }],
  ["Japanese channel layout", "audio.jpn.channelLayout", (value) => { delete value.streams[2].channel_layout; }],
  ["Japanese default disposition", "audio.jpn.default", (value) => { delete value.streams[2].disposition.default; }],
  ["duration", "format.duration", (value) => { delete value.format.duration; }],
];

for (const [description, field, mutate] of unavailableMandatoryFacts) {
  test(`fails closed when ${description} is unavailable`, () => {
    const value = clone(baseline());
    mutate(value);
    const result = evaluateLiveProbe(value);
    assert.equal(result.ok, false);
    assert.ok(fields(result).includes(field), `${field}: ${JSON.stringify(result.failures)}`);
  });
}

test("fails closed for unknown mandatory scalar types", () => {
  const value = baseline();
  value.streams[0].width = "320";
  value.streams[1].sample_rate = "token";
  value.streams[2].disposition.default = "0";
  value.format.duration = "file:///private/media";
  const result = evaluateLiveProbe(value);
  for (const field of ["video.width", "audio.eng.sampleRate", "audio.jpn.default", "format.duration"]) assert.ok(fields(result).includes(field));
  assert.doesNotMatch(JSON.stringify(result), /token|file:|private\/media/);
});

test("sanitizes version and emits a bounded path-free receipt before failure", () => {
  assert.deepEqual(sanitizeFfprobeVersion("ffprobe version 6.1.1-3ubuntu5 Copyright private\nconfiguration: /private/path"), { tool: "ffprobe", version: "6.1.1-3ubuntu5" });
  const live = baseline();
  live.streams[2].tags.name = "https://private.invalid/token";
  const { receipt, encoded } = buildLiveProbeReceipt({
    admitted: { mp4Sha256: "e".repeat(64), streamsSha256: "3".repeat(64) },
    versionResult: { ok: true, stdout: "ffprobe version 6.1.1-3ubuntu5 Copyright private\nconfiguration: /private/path" },
    liveResult: { ok: true },
    parsedLive: live,
  });
  assert.equal(receipt.validation.ok, false);
  assert.ok(receipt.validation.failedFields.some((entry) => entry.field === "audio.jpn.label"));
  assert.ok(Buffer.byteLength(encoded) <= MAX_LIVE_PROBE_RECEIPT_BYTES);
  assert.doesNotMatch(encoded, /private|https?:|token|filename|url|configuration/);
});

test("records sanitized execution and parse failures without raw stderr", () => {
  const { receipt, encoded } = buildLiveProbeReceipt({
    admitted: { mp4Sha256: "e".repeat(64) },
    versionResult: { ok: false, stdout: "", stderr: "/private/token" },
    liveResult: { ok: true, stderr: "https://private.invalid" },
    parsedLive: null,
  });
  assert.equal(receipt.validation.ok, false);
  assert.deepEqual(receipt.validation.failedFields.map((entry) => entry.field), ["ffprobe.version.execution", "ffprobe.live.json"]);
  assert.doesNotMatch(encoded, /private|https?:|token|stderr/);
});

test("production fixture persists the sanitized receipt before throwing validation failures", () => {
  const source = readFileSync(new URL("../android_touch_player_server_fixture.mts", import.meta.url), "utf8");
  const build = source.indexOf("const { receipt, encoded } = buildLiveProbeReceipt(");
  const write = source.indexOf("writeFileSync(MEDIA_PROBE_PATH, encoded, { mode: 0o600, flag: \"wx\" });", build);
  const reject = source.indexOf("if (!receipt.validation.ok)", write);
  assert.ok(build >= 0 && write > build && reject > write);
  assert.match(source, /spawnSync\("ffprobe", \["-version"\]/);
  assert.doesNotMatch(source, /JSON\.stringify\(\{ admitted, live \}/);
});
