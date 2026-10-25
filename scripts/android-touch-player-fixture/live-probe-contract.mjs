import assert from "node:assert/strict";

export const MAX_LIVE_PROBE_RECEIPT_BYTES = 1024 * 1024;
const ENGLISH_LABEL = "Synthetic English 440 Hz tone";
const JAPANESE_LABEL = "Synthetic Japanese 880 Hz tone";
const FAILURE_REASONS = Object.freeze({
  "ffprobe.version.execution": "ffprobe version command did not complete successfully",
  "ffprobe.version.parse": "ffprobe version output did not contain a bounded version identifier",
  "ffprobe.live.execution": "ffprobe media inspection did not complete successfully",
  "ffprobe.live.json": "ffprobe media inspection did not return valid JSON",
  "streams.count": "live probe must contain exactly three streams",
  "streams.video.count": "live probe must contain exactly one video stream",
  "video.codecType": "video stream codec type must be video",
  "video.codecName": "video stream codec must be H.264",
  "video.width": "video width must be 320",
  "video.height": "video height must be 180",
  "video.frameRate": "video frame rate must be 30/1",
  "streams.audio.count": "live probe must contain exactly two audio streams",
  "audio.eng.count": "live probe must contain exactly one English audio stream",
  "audio.eng.codecType": "English stream codec type must be audio",
  "audio.eng.codecName": "English stream codec must be AAC",
  "audio.eng.sampleRate": "English stream sample rate must be 48000 Hz",
  "audio.eng.channels": "English stream must contain one channel",
  "audio.eng.channelLayout": "English stream channel layout must be mono",
  "audio.eng.language": "English stream language must be eng",
  "audio.eng.default": "English stream must be the default audio track",
  "audio.eng.label": "present English track label must match the pinned synthetic label",
  "audio.jpn.count": "live probe must contain exactly one Japanese audio stream",
  "audio.jpn.codecType": "Japanese stream codec type must be audio",
  "audio.jpn.codecName": "Japanese stream codec must be AAC",
  "audio.jpn.sampleRate": "Japanese stream sample rate must be 48000 Hz",
  "audio.jpn.channels": "Japanese stream must contain one channel",
  "audio.jpn.channelLayout": "Japanese stream channel layout must be mono",
  "audio.jpn.language": "Japanese stream language must be jpn",
  "audio.jpn.default": "Japanese stream must not be the default audio track",
  "audio.jpn.label": "present Japanese track label must match the pinned synthetic label",
  "format.duration": "container duration must be exactly 30 seconds",
});

const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
const literal = (value, allowed) => typeof value === "string" && allowed.includes(value) ? value : null;
const decimal = (value) => {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= 1_000_000 ? value : null;
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,9})?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed <= 1_000_000 ? parsed : null;
};
const rate = (value) => typeof value === "string" && /^(?:0|[1-9][0-9]{0,5})\/(?:0|[1-9][0-9]{0,5})$/.test(value) ? value : null;
const labelState = (value, expected) => value == null ? "absent" : value === expected ? "expected" : "unexpected";

function sanitizeStream(stream, position) {
  const value = stream != null && typeof stream === "object" && !Array.isArray(stream) ? stream : {};
  const language = literal(value.tags?.language, ["eng", "jpn"]);
  const expectedLabel = language === "eng" ? ENGLISH_LABEL : language === "jpn" ? JAPANESE_LABEL : null;
  return {
    position,
    index: integer(value.index, 0, 1024),
    codecType: literal(value.codec_type, ["video", "audio"]),
    codecName: literal(value.codec_name, ["h264", "aac"]),
    codecTag: literal(value.codec_tag_string, ["avc1", "mp4a"]),
    width: integer(value.width, 1, 100_000),
    height: integer(value.height, 1, 100_000),
    frameRate: rate(value.r_frame_rate),
    sampleRate: integer(decimal(value.sample_rate), 1, 1_000_000),
    channels: integer(value.channels, 1, 64),
    channelLayout: literal(value.channel_layout, ["mono", "stereo"]),
    language,
    labelState: labelState(value.tags?.name, expectedLabel),
    default: integer(value.disposition?.default, 0, 1),
  };
}

function failure(field, actual) {
  return { field, reason: FAILURE_REASONS[field], actual };
}

function checkStream(failures, prefix, stream, expected) {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (stream?.[key] !== expectedValue) failures.push(failure(`${prefix}.${key}`, stream?.[key] ?? null));
  }
}

export function sanitizeFfprobeVersion(stdout) {
  if (typeof stdout !== "string" || stdout.length > 64 * 1024) return null;
  const firstLine = stdout.split(/\r?\n/, 1)[0];
  const match = /^ffprobe version ([A-Za-z0-9.+_~:-]{1,128})(?:\s|$)/.exec(firstLine);
  return match == null ? null : { tool: "ffprobe", version: match[1] };
}

export function evaluateLiveProbe(raw) {
  const source = raw != null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rawStreams = Array.isArray(source.streams) ? source.streams : [];
  const live = {
    streams: rawStreams.slice(0, 4).map(sanitizeStream),
    format: { durationSeconds: decimal(source.format?.duration) },
  };
  const failures = [];
  if (rawStreams.length !== 3) failures.push(failure("streams.count", integer(rawStreams.length, 0, 1_000_000)));
  const videos = live.streams.filter((stream) => stream.codecType === "video");
  if (videos.length !== 1) failures.push(failure("streams.video.count", videos.length));
  checkStream(failures, "video", videos[0], {
    codecType: "video", codecName: "h264", width: 320, height: 180, frameRate: "30/1",
  });
  const audios = live.streams.filter((stream) => stream.codecType === "audio");
  if (audios.length !== 2) failures.push(failure("streams.audio.count", audios.length));
  for (const [language, defaultValue] of [["eng", 1], ["jpn", 0]]) {
    const matches = audios.filter((stream) => stream.language === language);
    if (matches.length !== 1) failures.push(failure(`audio.${language}.count`, matches.length));
    const stream = matches[0];
    checkStream(failures, `audio.${language}`, stream, {
      codecType: "audio", codecName: "aac", sampleRate: 48000, channels: 1,
      channelLayout: "mono", language, default: defaultValue,
    });
    if (stream?.labelState === "unexpected") failures.push(failure(`audio.${language}.label`, "unexpected"));
  }
  if (live.format.durationSeconds !== 30) failures.push(failure("format.duration", live.format.durationSeconds));
  return { ok: failures.length === 0, live, failures };
}

export function buildLiveProbeReceipt({ admitted, versionResult, liveResult, parsedLive }) {
  const failures = [];
  const version = versionResult?.ok === true ? sanitizeFfprobeVersion(versionResult.stdout) : null;
  if (versionResult?.ok !== true) failures.push(failure("ffprobe.version.execution", null));
  else if (version == null) failures.push(failure("ffprobe.version.parse", null));

  let evaluation = null;
  if (liveResult?.ok !== true) failures.push(failure("ffprobe.live.execution", null));
  else if (parsedLive == null) failures.push(failure("ffprobe.live.json", null));
  else {
    evaluation = evaluateLiveProbe(parsedLive);
    failures.push(...evaluation.failures);
  }

  const receipt = {
    schemaVersion: 1,
    admitted,
    ffprobe: version,
    live: evaluation?.live ?? null,
    validation: { ok: failures.length === 0, failedFields: failures },
  };
  const encoded = `${JSON.stringify(receipt, null, 2)}\n`;
  assert.ok(Buffer.byteLength(encoded) <= MAX_LIVE_PROBE_RECEIPT_BYTES, "Sanitized live-probe receipt exceeds 1 MiB.");
  return { receipt, encoded };
}
