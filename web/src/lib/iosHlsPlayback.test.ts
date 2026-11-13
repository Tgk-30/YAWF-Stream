import { describe, expect, it } from "vitest";
import {
  IOS_HLS_COMPATIBILITY_MIME,
  iosHlsPlaybackRoute,
  normalizeIosHlsPlaybackMode,
  supportsStandardIosHlsMse,
  type IosHlsCapabilityScope,
} from "./iosHlsPlayback";

function scope(overrides: Partial<IosHlsCapabilityScope> = {}): IosHlsCapabilityScope {
  class StandardMediaSource {}
  Object.assign(StandardMediaSource, {
    isTypeSupported: (mime: string) => mime === IOS_HLS_COMPATIBILITY_MIME,
  });
  return {
    MediaSource: StandardMediaSource as unknown as IosHlsCapabilityScope["MediaSource"],
    ManagedMediaSource: class ManagedMediaSource {},
    SourceBuffer: { prototype: { appendBuffer() {}, remove() {} } },
    ...overrides,
  };
}

describe("iPad HLS playback policy", () => {
  it("normalizes every absent, stale, or poisoned value to native", () => {
    expect(normalizeIosHlsPlaybackMode("compatibility")).toBe("compatibility");
    for (const value of [undefined, null, "managed", "mse", true, 1]) {
      expect(normalizeIosHlsPlaybackMode(value)).toBe("native");
    }
  });

  it("admits only an independent standard constructor with H264/AAC and SourceBuffer operations", () => {
    const admitted = scope();
    expect(supportsStandardIosHlsMse(admitted)).toBe(true);
    expect(supportsStandardIosHlsMse({ ...admitted, ManagedMediaSource: admitted.MediaSource })).toBe(false);
    expect(supportsStandardIosHlsMse({ ...admitted, MediaSource: undefined })).toBe(false);
    expect(supportsStandardIosHlsMse({ ...admitted, SourceBuffer: { prototype: { remove() {} } } })).toBe(false);
    class UnsupportedMediaSource {}
    Object.assign(UnsupportedMediaSource, { isTypeSupported: () => false });
    expect(supportsStandardIosHlsMse({ ...admitted, MediaSource: UnsupportedMediaSource as never })).toBe(false);
    class ThrowingMediaSource {}
    Object.assign(ThrowingMediaSource, { isTypeSupported: () => { throw new Error("unsupported"); } });
    expect(supportsStandardIosHlsMse({ ...admitted, MediaSource: ThrowingMediaSource as never })).toBe(false);
  });

  it("keeps native as default and falls back to it when standard MSE is unavailable", () => {
    expect(iosHlsPlaybackRoute({ mode: "native", nativePlayable: true, scope: scope() })).toBe("native");
    expect(iosHlsPlaybackRoute({ mode: "compatibility", nativePlayable: true, scope: scope() })).toBe("compatibility");
    expect(iosHlsPlaybackRoute({ mode: "compatibility", nativePlayable: true, scope: {} })).toBe("native");
    expect(iosHlsPlaybackRoute({ mode: "compatibility", nativePlayable: false, scope: {} })).toBe("unsupported");
  });
});
