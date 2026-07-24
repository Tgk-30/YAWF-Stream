// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasAndroidTVBridge,
  startAndroidTVPlayback,
  stopAndroidTVPlayback,
} from "./androidTV";

describe("Android TV bridge", () => {
  afterEach(() => {
    delete window.YawfAndroidTV;
  });

  it("hands a secret-bearing request directly to the native bridge as JSON", () => {
    const play = vi.fn();
    const stop = vi.fn();
    window.YawfAndroidTV = { play, stop };
    const request = {
      url: "https://server.example/api/stream/session/index.m3u8",
      title: "Film",
      subtitle: null,
      startPositionSeconds: 42,
      authorization: "Bearer short-lived",
      audioLanguage: "en",
      subtitleLanguage: "ar",
      subtitlesEnabled: true,
    };

    expect(hasAndroidTVBridge()).toBe(true);
    expect(startAndroidTVPlayback(request)).toBe(true);
    expect(JSON.parse(play.mock.calls[0]![0])).toEqual(request);
    stopAndroidTVPlayback();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("degrades safely when the bridge is absent or rejects the request", () => {
    expect(startAndroidTVPlayback({
      url: "https://server.example/video",
      title: "Film",
      subtitle: null,
      startPositionSeconds: 0,
      authorization: null,
      audioLanguage: null,
      subtitleLanguage: null,
      subtitlesEnabled: false,
    })).toBe(false);
    window.YawfAndroidTV = {
      play: () => {
        throw new Error("Activity closed");
      },
      stop: vi.fn(),
    };
    expect(startAndroidTVPlayback({
      url: "https://server.example/video",
      title: "Film",
      subtitle: null,
      startPositionSeconds: 0,
      authorization: null,
      audioLanguage: null,
      subtitleLanguage: null,
      subtitlesEnabled: false,
    })).toBe(false);
  });
});
