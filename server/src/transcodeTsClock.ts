import { open } from "node:fs/promises";

const MPEG_TS_PACKET_BYTES = 188;
const MPEG_TS_CLOCK_WRAP = 2 ** 33;
const MAX_CLOCK_SCAN_BYTES = 2 * 1024 * 1024;

function decodePresentationTimestamp(data: Uint8Array, offset: number): number | null {
  if (offset + 5 > data.byteLength) return null;
  const first = data[offset]!;
  const second = data[offset + 1]!;
  const third = data[offset + 2]!;
  const fourth = data[offset + 3]!;
  const fifth = data[offset + 4]!;
  const prefix = first >>> 4;
  if (
    (prefix !== 2 && prefix !== 3) ||
    (first & 1) !== 1 ||
    (third & 1) !== 1 ||
    (fifth & 1) !== 1
  ) {
    return null;
  }
  return (
    ((first & 0x0e) >>> 1) * 2 ** 30 +
    second * 2 ** 22 +
    ((third & 0xfe) >>> 1) * 2 ** 15 +
    fourth * 2 ** 7 +
    ((fifth & 0xfe) >>> 1)
  );
}

function normalizeClockNear(value: number, reference: number): number {
  let normalized = value;
  while (normalized - reference > MPEG_TS_CLOCK_WRAP / 2) {
    normalized -= MPEG_TS_CLOCK_WRAP;
  }
  while (normalized - reference < -MPEG_TS_CLOCK_WRAP / 2) {
    normalized += MPEG_TS_CLOCK_WRAP;
  }
  return normalized;
}

/** Read the first video presentation clock from a generated H.264 MPEG-TS
 * segment for subtitle readiness validation. WebVTT and MPEG-TS retain their
 * shared output clock; this value is not used to rebase subtitle cues. The
 * scan is local and bounded, and malformed video output fails closed. */
export function initialMpegTsVideoPresentationTimestamp(
  data: Uint8Array,
): number | null {
  if (
    data.byteLength < MPEG_TS_PACKET_BYTES ||
    data.byteLength > MAX_CLOCK_SCAN_BYTES
  ) {
    return null;
  }
  let reference: number | null = null;
  let earliest: number | null = null;
  let foundVideo = false;

  for (
    let packetOffset = 0;
    packetOffset + MPEG_TS_PACKET_BYTES <= data.byteLength;
    packetOffset += MPEG_TS_PACKET_BYTES
  ) {
    if (data[packetOffset] !== 0x47) return null;
    const second = data[packetOffset + 1]!;
    const fourth = data[packetOffset + 3]!;
    if ((second & 0x80) !== 0) return null;
    if ((second & 0x40) === 0) continue;

    const adaptationControl = (fourth >>> 4) & 0x03;
    if (adaptationControl === 0) return null;
    if (adaptationControl === 2) continue;
    let payloadOffset = packetOffset + 4;
    if (adaptationControl === 3) {
      const adaptationLength = data[payloadOffset]!;
      payloadOffset += adaptationLength + 1;
    }
    const packetEnd = packetOffset + MPEG_TS_PACKET_BYTES;
    if (payloadOffset + 14 > packetEnd) continue;
    if (
      data[payloadOffset] !== 0 ||
      data[payloadOffset + 1] !== 0 ||
      data[payloadOffset + 2] !== 1
    ) {
      continue;
    }

    const streamId = data[payloadOffset + 3]!;
    const video = streamId >= 0xe0 && streamId <= 0xef;
    if (!video) continue;
    const flags = data[payloadOffset + 7]!;
    if ((flags & 0x80) === 0) return null;
    const headerLength = data[payloadOffset + 8]!;
    if (headerLength < 5 || payloadOffset + 9 + headerLength > packetEnd) {
      return null;
    }
    const timestamp = decodePresentationTimestamp(data, payloadOffset + 9);
    if (timestamp == null) return null;
    foundVideo = true;
    if (reference == null) reference = timestamp;
    const normalized = normalizeClockNear(timestamp, reference);
    earliest = earliest == null ? normalized : Math.min(earliest, normalized);
  }

  if (!foundVideo || earliest == null) return null;
  return ((earliest % MPEG_TS_CLOCK_WRAP) + MPEG_TS_CLOCK_WRAP) % MPEG_TS_CLOCK_WRAP;
}

export async function readInitialMpegTsVideoPresentationTimestamp(
  path: string,
): Promise<number | null> {
  let file;
  try {
    file = await open(path, "r");
    const stat = await file.stat();
    const length = Math.min(stat.size, MAX_CLOCK_SCAN_BYTES);
    if (length < MPEG_TS_PACKET_BYTES) return null;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(buffer, 0, length, 0);
    return initialMpegTsVideoPresentationTimestamp(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => {});
  }
}
