import { describe, expect, it } from "vitest";
import {
  isTranscodeAssetName,
  rewriteGeneratedWebVttForTimeline,
  rewriteTranscodeManifest,
} from "../src/transcodeHls.js";

describe("transcode HLS assets", () => {
  it("generation-binds the subtitle playlist and its exact WebVTT segments", () => {
    const master = [
      "#EXTM3U",
      "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"Embedded\",DEFAULT=YES,URI=\"480p_subtitles.m3u8\"",
      "#EXT-X-STREAM-INF:BANDWIDTH=1800000,SUBTITLES=\"subs\"",
      "480p.m3u8",
      "",
    ].join("\n");
    expect(rewriteTranscodeManifest(master, "transcode-a b")).toContain(
      'URI="480p_subtitles.m3u8?generation=transcode-a%20b"',
    );
    expect(rewriteTranscodeManifest(master, "transcode-a b")).toContain(
      "480p.m3u8?generation=transcode-a%20b",
    );

    const subtitles = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:6",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXTINF:6.000000,",
      "480p0.vtt",
      "#EXTINF:6.000000,",
      "480p1.vtt",
      "",
    ].join("\n");
    const rewritten = rewriteTranscodeManifest(subtitles, "transcode-a b");
    expect(rewritten).toContain("#EXT-X-PLAYLIST-TYPE:EVENT");
    expect(rewritten).toContain("#EXT-X-START:TIME-OFFSET=0,PRECISE=YES");
    expect(rewritten).toContain("480p0.vtt?generation=transcode-a%20b");
    expect(rewritten).toContain("480p1.vtt?generation=transcode-a%20b");
  });

  it("does not rewrite lookalike, remote, or already attributed URIs", () => {
    const manifest = [
      "#EXTM3U",
      "subtitles.vtt",
      "480p_subtitles.m3u8?other=1",
      "480p100000.vtt",
      "https://cdn.example/480p_subtitles.m3u8",
      "#EXT-X-MEDIA:TYPE=SUBTITLES,URI=\"https://cdn.example/480p_subtitles.m3u8\"",
      "",
    ].join("\n");
    expect(rewriteTranscodeManifest(manifest, "g")).toBe(manifest);
  });

  it.each([
    "1080p.m3u8",
    "360p_seg_00000.ts",
    "seg_99999.ts",
    "480p_subtitles.m3u8",
    "1080p0.vtt",
    "480p14400.vtt",
  ])("admits the exact generated asset %s", (asset) => {
    expect(isTranscodeAssetName(asset)).toBe(true);
  });

  it.each([
    "subtitles.vtt",
    "subtitles.m3u8",
    "subtitles0.vtt",
    "480p.vtt",
    "480p100000.vtt",
    "480p0.vtt?generation=x",
    "../subtitles.m3u8",
    "subtitle.m3u8",
    "720p_seg_0000.ts",
  ])("rejects the non-generated asset %s", (asset) => {
    expect(isTranscodeAssetName(asset)).toBe(false);
  });

  it("retains expired, overlapping and future cues for client-side clock mapping and expiry", () => {
    const segment = [
      "WEBVTT", "",
      "00:01.000 --> 00:04.000", "Expired", "",
      "00:04.000 --> 00:07.500 align:start", "Overlapping", "",
      "00:13.250 --> 00:17.000", "Future", "",
    ].join("\n");
    expect(rewriteGeneratedWebVttForTimeline(segment)).toBe(
      segment.replace("WEBVTT\n", "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:0\n"),
    );
  });

  it.each(["\n", "\r\n", "\r"])("preserves cue bytes and settings with newline %j", (newline) => {
    const segment = [
      "WEBVTT", "Language: en", "", "cue-id",
      "00:06.000  -->\t00:09.000 align:start position:20%",
      "<v Narrator>payload --> unchanged &amp; café", "second line", "",
    ].join(newline);
    const rewritten = rewriteGeneratedWebVttForTimeline(segment);
    expect(rewritten).toBe(segment.replace(
      `WEBVTT${newline}`,
      `WEBVTT${newline}X-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:0${newline}`,
    ));
  });

  it("keeps positive-origin source cue timestamps and metadata byte-identical", () => {
    const segment = [
      "WEBVTT", "", "NOTE a --> b is not a cue", "", "STYLE", "::cue { color: lime; }", "",
      "00:06.000 --> 00:09.000", "First cue", "",
      "00:12.000 --> 00:15.000", "Second cue", "",
    ].join("\n");
    expect(rewriteGeneratedWebVttForTimeline(segment)).toBe(
      segment.replace("WEBVTT\n", "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:0\n"),
    );
  });

  it.each(["WEBVTT", "WEBVTT\n", "WEBVTT\r\n"])("maps the empty growing segment %j before a late cue exists", (segment) => {
    const newline = segment.endsWith("\r\n") ? "\r\n" : "\n";
    expect(rewriteGeneratedWebVttForTimeline(segment)).toBe(
      `WEBVTT${newline}X-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:0${newline}${newline}`,
    );
  });

  it.each([
    ["missing signature", "not VTT", /not WebVTT/],
    ["missing header separator", "WEBVTT\n00:01.000 --> 00:02.000\nCue\n", /not WebVTT/],
    ["unsupported", "WEBVTT\n\nsoon --> later\nCue\n", /unsupported timestamp/],
    ["invalid seconds", "WEBVTT\n\n00:60.000 --> 01:02.000\nCue\n", /invalid timestamp/],
    ["reversed", "WEBVTT\n\n00:03.000 --> 00:02.000\nCue\n", /invalid timestamp/],
    ["overflow", "WEBVTT\n\n9999999999999:00:00.000 --> 9999999999999:00:01.000\nCue\n", /invalid timestamp/],
  ])("fails closed on %s generated WebVTT", (_label, segment, message) => {
    expect(() => rewriteGeneratedWebVttForTimeline(segment as string)).toThrow(message as RegExp);
  });

  it.each([
    "X-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:0",
    "X-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:450000",
    " x-timestamp-map = malformed",
  ])("rejects a conflicting generated map %s", (map) => {
    expect(() => rewriteGeneratedWebVttForTimeline(
      `WEBVTT\n${map}\n\n00:01.000 --> 00:02.000\nCue\n`,
    )).toThrow(/already has a timestamp map/);
  });

  it.each([
    "X-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:0",
    "X-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:450000",
    " x-timestamp-map = malformed",
  ])("preserves literal map-looking cue payload %s", (payload) => {
    const segment = `WEBVTT\r\n\r\n00:01.000 --> 00:04.000\r\n${payload}\r\n`;
    let rewritten = "";
    expect(() => {
      rewritten = rewriteGeneratedWebVttForTimeline(segment);
    }).not.toThrow();
    expect(rewritten).toBe(segment.replace(
      "WEBVTT\r\n",
      "WEBVTT\r\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:0\r\n",
    ));
  });
});
