import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const MP4_SHA256 = "e07908225929030752333173d91669819b3412e159e710655bc7413ef3625e7c";
export const FRAMES_SHA256 = "cc7cdcd2fae760d1e574139a30ea7e143ff83e51a7c845016698259f32eaceaa";
export const STREAMS_SHA256 = "3d1761127480df586c9103faf82c885197b15ae893c580bf1acccc30ce7ff469";
export const VIDEO_ELEMENTARY_SHA256 = "48ef438908342b6df028b4ce63b700fbdcff9be05f7082cf7faa0d21ac0a14ee";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function boxes(bytes, start = 0, end = bytes.length) {
  const result = [];
  for (let offset = start; offset < end;) {
    assert.ok(offset + 8 <= end, "Truncated MP4 box");
    let size = bytes.readUInt32BE(offset), header = 8;
    if (size === 1) {
      assert.ok(offset + 16 <= end);
      size = Number(bytes.readBigUInt64BE(offset + 8));
      header = 16;
    }
    if (size === 0) size = end - offset;
    assert.ok(Number.isSafeInteger(size) && size >= header && offset + size <= end, "Invalid MP4 box length");
    result.push({ type: bytes.toString("ascii", offset + 4, offset + 8), start: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}

function child(bytes, parent, name) {
  const found = boxes(bytes, parent.start, parent.end).filter((box) => box.type === name);
  assert.equal(found.length, 1, name);
  return found[0];
}

export function inspectMp4(bytes) {
  const moov = boxes(bytes).find((box) => box.type === "moov");
  assert.ok(moov, "MP4 movie metadata required");
  const mvhd = child(bytes, moov, "mvhd"), version = bytes[mvhd.start];
  assert.ok([0, 1].includes(version));
  const scale = bytes.readUInt32BE(mvhd.start + (version === 0 ? 12 : 20));
  const ticks = version === 0 ? bytes.readUInt32BE(mvhd.start + 16) : Number(bytes.readBigUInt64BE(mvhd.start + 24));
  assert.ok(scale > 0 && Number.isSafeInteger(ticks));
  const tracks = boxes(bytes, moov.start, moov.end).filter((box) => box.type === "trak").map((trak) => {
    const mdia = child(bytes, trak, "mdia"), hdlr = child(bytes, mdia, "hdlr");
    const handler = bytes.toString("ascii", hdlr.start + 8, hdlr.start + 12);
    const minf = child(bytes, mdia, "minf"), stbl = child(bytes, minf, "stbl"), stsd = child(bytes, stbl, "stsd");
    const sample = boxes(bytes, stsd.start + 8, stsd.end);
    assert.equal(sample.length, 1);
    return {
      handler,
      codec: sample[0].type,
      ...(handler === "vide" ? {
        width: bytes.readUInt16BE(sample[0].start + 24),
        height: bytes.readUInt16BE(sample[0].start + 26),
      } : {}),
    };
  });
  return { durationSeconds: ticks / scale, tracks };
}

function validateProbeReceipt(streamsBytes) {
  const receipt = JSON.parse(streamsBytes);
  assert.equal(receipt.format.nb_streams, 3);
  assert.equal(receipt.format.start_time, "0.000000");
  assert.equal(receipt.format.duration, "30.000000");
  assert.match(receipt.format.format_name, /(?:^|,)mp4(?:,|$)/);
  assert.equal(receipt.streams.length, 3);

  const [video, english, japanese] = receipt.streams;
  assert.deepEqual({
    index: video.index,
    codecName: video.codec_name,
    codecType: video.codec_type,
    codecTag: video.codec_tag_string,
    width: video.width,
    height: video.height,
    frameRate: video.avg_frame_rate,
    timeBase: video.time_base,
    startTime: video.start_time,
    duration: video.duration,
    frames: video.nb_frames,
  }, {
    index: 0, codecName: "h264", codecType: "video", codecTag: "avc1", width: 320, height: 180,
    frameRate: "30/1", timeBase: "1/30000", startTime: "0.000000", duration: "30.000000", frames: "900",
  });

  const audioFacts = [english, japanese].map((stream) => ({
    index: stream.index,
    codecName: stream.codec_name,
    codecType: stream.codec_type,
    codecTag: stream.codec_tag_string,
    sampleRate: stream.sample_rate,
    channels: stream.channels,
    channelLayout: stream.channel_layout,
    startTime: stream.start_time,
    duration: stream.duration,
    language: stream.tags?.language,
    label: stream.tags?.name,
    default: stream.disposition?.default,
  }));
  assert.deepEqual(audioFacts, [
    {
      index: 1, codecName: "aac", codecType: "audio", codecTag: "mp4a", sampleRate: "48000", channels: 1,
      channelLayout: "mono", startTime: "0.000000", duration: "30.000000", language: "eng",
      label: "Synthetic English 440 Hz tone", default: 1,
    },
    {
      index: 2, codecName: "aac", codecType: "audio", codecTag: "mp4a", sampleRate: "48000", channels: 1,
      channelLayout: "mono", startTime: "0.000000", duration: "30.000000", language: "jpn",
      label: "Synthetic Japanese 880 Hz tone", default: 0,
    },
  ]);
  return audioFacts;
}

export function validateMediaBytes(bytes, framesBytes, streamsBytes) {
  assert.equal(sha(bytes), MP4_SHA256, "Exact synthetic multiaudio MP4 bytes required");
  assert.equal(sha(framesBytes), FRAMES_SHA256, "Exact retained ffprobe video-frame receipt required");
  assert.equal(sha(streamsBytes), STREAMS_SHA256, "Exact retained ffprobe stream receipt required");
  const facts = inspectMp4(bytes);
  assert.equal(facts.durationSeconds, 30);
  assert.deepEqual(facts.tracks, [
    { handler: "vide", codec: "avc1", width: 320, height: 180 },
    { handler: "soun", codec: "mp4a" },
    { handler: "soun", codec: "mp4a" },
  ]);
  const frames = JSON.parse(framesBytes).frames;
  assert.equal(frames.length, 900);
  const keyframesSeconds = frames.filter((frame) => frame.key_frame === 1).map((frame) => Number(frame.best_effort_timestamp_time));
  assert.deepEqual(keyframesSeconds, [0, 10, 20]);
  const audio = validateProbeReceipt(streamsBytes);
  return {
    ...facts,
    videoTracks: 1,
    audioTracks: 2,
    audio,
    frameCount: 900,
    keyframesSeconds,
    mp4Sha256: MP4_SHA256,
    framesSha256: FRAMES_SHA256,
    streamsSha256: STREAMS_SHA256,
    sourceVideoElementarySha256: VIDEO_ELEMENTARY_SHA256,
    metadataMethod: "pure MP4 metadata parser plus retained pinned-ffprobe video-frame and stream receipts",
  };
}

export function assertAdmittedMedia(here) {
  assert.deepEqual(readdirSync(join(here, "media")), ["synthetic.mp4"]);
  const media = join(here, "media", "synthetic.mp4");
  const frames = join(here, "media-probe-frames.json");
  const streams = join(here, "media-probe-streams.json");
  for (const path of [media, frames, streams]) assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
  return validateMediaBytes(readFileSync(media), readFileSync(frames), readFileSync(streams));
}

export function copyAdmittedMedia(here, destination) {
  const facts = assertAdmittedMedia(here);
  mkdirSync(destination, { mode: 0o700 });
  copyFileSync(join(here, "media", "synthetic.mp4"), join(destination, "synthetic.mp4"));
  assert.equal(sha(readFileSync(join(destination, "synthetic.mp4"))), MP4_SHA256);
  return facts;
}
