import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  initialMpegTsVideoPresentationTimestamp,
  readInitialMpegTsVideoPresentationTimestamp,
} from "../src/transcodeTsClock.js";

const CLOCK_WRAP = 2 ** 33;

function timestampBytes(timestamp: number): number[] {
  const value = ((timestamp % CLOCK_WRAP) + CLOCK_WRAP) % CLOCK_WRAP;
  return [
    0x20 | ((Math.floor(value / 2 ** 30) & 0x07) << 1) | 1,
    Math.floor(value / 2 ** 22) & 0xff,
    ((Math.floor(value / 2 ** 15) & 0x7f) << 1) | 1,
    Math.floor(value / 2 ** 7) & 0xff,
    ((value & 0x7f) << 1) | 1,
  ];
}

function pesPacket(streamId: number, timestamp: number, pid: number): Buffer {
  const packet = Buffer.alloc(188, 0xff);
  packet[0] = 0x47;
  packet[1] = 0x40 | ((pid >>> 8) & 0x1f);
  packet[2] = pid & 0xff;
  packet[3] = 0x10;
  packet.set([
    0, 0, 1, streamId, 0, 0, 0x80, 0x80, 5,
    ...timestampBytes(timestamp),
  ], 4);
  return packet;
}

describe("generated MPEG-TS clock", () => {
  it("uses the first video presentation clock instead of a leading audio encoder timestamp", () => {
    const segment = Buffer.concat([
      pesPacket(0xe0, 576_000, 0x100),
      pesPacket(0xc0, 574_080, 0x101),
      pesPacket(0xe0, 575_500, 0x100),
    ]);
    expect(initialMpegTsVideoPresentationTimestamp(segment)).toBe(575_500);
  });

  it("supports video-only output and timestamps around the 33-bit wrap", () => {
    expect(initialMpegTsVideoPresentationTimestamp(
      pesPacket(0xe0, 576_000, 0x100),
    )).toBe(576_000);
    expect(initialMpegTsVideoPresentationTimestamp(Buffer.concat([
      pesPacket(0xe0, 100, 0x100),
      pesPacket(0xe0, CLOCK_WRAP - 50, 0x100),
    ]))).toBe(CLOCK_WRAP - 50);
  });

  it("fails closed for audio-only, malformed, and oversized input", () => {
    expect(initialMpegTsVideoPresentationTimestamp(
      pesPacket(0xc0, 574_080, 0x101),
    )).toBeNull();
    const malformed = pesPacket(0xe0, 576_000, 0x100);
    malformed[0] = 0;
    expect(initialMpegTsVideoPresentationTimestamp(malformed)).toBeNull();
    const invalidTimestamp = pesPacket(0xe0, 576_000, 0x100);
    invalidTimestamp[4 + 9] = 0;
    expect(initialMpegTsVideoPresentationTimestamp(invalidTimestamp)).toBeNull();
    const invalidAdaptation = pesPacket(0xe0, 576_000, 0x100);
    invalidAdaptation[3] = 0;
    expect(initialMpegTsVideoPresentationTimestamp(invalidAdaptation)).toBeNull();
    expect(initialMpegTsVideoPresentationTimestamp(
      Buffer.alloc(2 * 1024 * 1024 + 1),
    )).toBeNull();
  });

  it("reads only the bounded local segment and returns its clock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yawf-ts-clock-"));
    const path = join(dir, "480p_seg_00000.ts");
    try {
      await writeFile(path, Buffer.concat([
        pesPacket(0xe0, 576_000, 0x100),
        pesPacket(0xc0, 574_080, 0x101),
      ]));
      expect(await readInitialMpegTsVideoPresentationTimestamp(path)).toBe(576_000);
      expect(await readInitialMpegTsVideoPresentationTimestamp(join(dir, "missing.ts"))).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
