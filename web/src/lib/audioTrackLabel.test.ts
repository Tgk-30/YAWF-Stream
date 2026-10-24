import { describe, expect, it } from "vitest";
import {
  audioTrackLabel,
  readableAudioLanguageLabel,
} from "./audioTrackLabel";

describe("audioTrackLabel", () => {
  it("expands exact two and three letter language codes", () => {
    expect(audioTrackLabel("eng", "eng", "Audio 1")).toBe("English");
    expect(audioTrackLabel("", "fre", "Audio 2")).toBe("French");
    expect(audioTrackLabel("jpn", null, "Audio 3")).toBe("Japanese");
  });

  it("keeps region and script distinctions in code-only labels", () => {
    expect(audioTrackLabel("pt", "pt-BR", "Audio 1")).toBe("Portuguese (BR)");
    expect(readableAudioLanguageLabel("zh_Hant")).toBe("Chinese (Hant)");
  });

  it("leaves an incomplete language suffix unchanged", () => {
    expect(audioTrackLabel("en-a", "en", "Audio 1")).toBe("en-a");
  });

  it("leaves a commentary-like language suffix unchanged", () => {
    expect(audioTrackLabel("en-comment", "en", "Audio 1")).toBe("en-comment");
  });

  it("leaves malformed language separators unchanged", () => {
    expect(audioTrackLabel("en--US", "en-US", "Audio 1")).toBe("en--US");
    expect(audioTrackLabel("zh_Hant-TW", "zh-Hant-TW", "Audio 2")).toBe(
      "zh_Hant-TW",
    );
  });

  it("enriches compatible script and region codes but keeps conflicts title-first", () => {
    expect(audioTrackLabel("zh-Hant", "zh-Hant-TW", "Audio 1")).toBe(
      "Chinese (Hant-TW)",
    );
    expect(audioTrackLabel("zh-Hans", "zh-Hant-TW", "Audio 2")).toBe(
      "Chinese (Hans)",
    );
    expect(audioTrackLabel("en-US", "en-GB", "Audio 3")).toBe("English (US)");
  });

  it("preserves meaningful human titles without token matching", () => {
    expect(audioTrackLabel("English commentary 5.1", "eng", "Audio 1")).toBe(
      "English commentary 5.1",
    );
    expect(audioTrackLabel("Director channel", "eng", "Audio 2")).toBe(
      "Director channel",
    );
  });

  it("uses the numbered fallback for undetermined language metadata", () => {
    expect(audioTrackLabel("", "und", "Audio 1")).toBe("Audio 1");
    expect(audioTrackLabel("und", "und", "Audio 2")).toBe("Audio 2");
    expect(audioTrackLabel("Original", "und", "Audio 3")).toBe("Original");
    expect(audioTrackLabel("", "original", "Audio 4")).toBe("Audio 4");
  });

  it("handles whitespace and case around exact undetermined language sentinels", () => {
    expect(audioTrackLabel("", " UnD ", "Audio 1")).toBe("Audio 1");
    expect(audioTrackLabel(" UNKNOWN ", " N/A ", "Audio 2")).toBe("Audio 2");
    expect(audioTrackLabel(" Original ", " ORIGINAL ", "Audio 3")).toBe("Original");
    expect(audioTrackLabel("", " XyZ ", "Audio 4")).toBe("XyZ");
  });

  it("retains unknown metadata and uses the fallback for absent values", () => {
    expect(audioTrackLabel("xyz", "xyz", "Audio 1")).toBe("xyz");
    expect(audioTrackLabel("", "unknown language", "Audio 2")).toBe(
      "unknown language",
    );
    expect(audioTrackLabel(null, undefined, "Audio 3")).toBe("Audio 3");
  });
});
