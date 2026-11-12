// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { bindServerHlsAudio, boundServerHlsAudioIndex } from "./serverHlsAudioBinding";

const url = "https://server.example/api/stream/owned/index.m3u8?quality=480p";
const manifest = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="avc1.42e01e,mp4a.40.2"\n480p.m3u8?generation=transcode-owned\n';
function fixture() {
  globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
  const context = { owner: "owned", identity: {}, url, quality: "480p" as const, start: 0 };
  const headers = new Headers({ "x-yawf-transcode-quality": "480p", "x-yawf-transcode-start": "0", "x-yawf-transcode-audio": "5" });
  const binding = bindServerHlsAudio(context, manifest, headers)!;
  const current = { ...context, target: binding?.target ?? null };
  const inventory = { owner: context.owner, tracks: [{ index: 0 }, { index: 5 }] };
  const native = [{ enabled: true, language: "und", label: "" }];
  return { context, headers, binding, current, inventory, native };
}
afterEach(() => { delete globalThis.__DEBRIDSTREAMER_SERVER_URL__; });

describe("current muxed server audio attestation", () => {
  it.each([0, 5, 31])("retains canonical audio%s without requiring published snapshot lead", index => {
    const p = fixture(); p.headers.set("x-yawf-transcode-audio", String(index));
    const binding = bindServerHlsAudio(p.context, manifest, p.headers);
    expect(binding?.index).toBe(index); expect(Object.isFrozen(binding)).toBe(true);
  });
  it.each(["quality", "start", "audio"])("rejects missing %s header", field => {
    const p = fixture(); p.headers.delete(`x-yawf-transcode-${field}`);
    expect(bindServerHlsAudio(p.context, manifest, p.headers)).toBeNull();
  });
  it.each(["-1", "32", "01", "1.0", "5, 5", "", "NaN"])("rejects noncanonical audio %s", audio => {
    const p = fixture(); p.headers.set("x-yawf-transcode-audio", audio);
    expect(bindServerHlsAudio(p.context, manifest, p.headers)).toBeNull();
  });
  it.each([
    ["quality", "360p"], ["start", "1"], ["start", "0.0"],
  ])("rejects mismatched %s=%s", (field, value) => {
    const p = fixture(); p.headers.set(`x-yawf-transcode-${field}`, value);
    expect(bindServerHlsAudio(p.context, manifest, p.headers)).toBeNull();
  });
  it.each(["&quality=480p", "&start=0&start=0", "&audio=5&audio=5", "&audio=0", "&start=9"])("rejects ambiguous/mismatched query %s", suffix => {
    const p = fixture(); expect(bindServerHlsAudio({ ...p.context, url: url + suffix }, manifest, p.headers)).toBeNull();
  });
  it.each([
    ["external owner URL", manifest, "https://other.example/api/stream/owned/index.m3u8?quality=480p"],
    ["video-only CODECS", manifest.replace(",mp4a.40.2", ""), url],
    ["missing CODECS", manifest.replace(',CODECS="avc1.42e01e,mp4a.40.2"', ""), url],
    ["AUDIO group", manifest.replace("#EXT-X-STREAM-INF:", '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a"\n#EXT-X-STREAM-INF:'), url],
    ["AUDIO attribute", manifest.replace("BANDWIDTH=1000", 'AUDIO="a",BANDWIDTH=1000'), url],
    ["two variants", manifest + '#EXT-X-STREAM-INF:BANDWIDTH=2000\n360p.m3u8?generation=transcode-owned\n', url],
    ["second URI", manifest + "other.m3u8\n", url],
    ["iframe URI", manifest + '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000,URI="other.m3u8"\n', url],
    ["duplicate CODECS", manifest.replace('CODECS="', 'CODECS="mp4a.40.2",CODECS="'), url],
    ["wrong child quality", manifest.replace("480p.m3u8", "360p.m3u8"), url],
    ["nonadjacent child", manifest.replace("\n480p.m3u8", "\n#comment\n480p.m3u8"), url],
    ["invalid generation", manifest.replace("transcode-owned", "other"), url],
  ])("rejects %s", (_name, body, source) => {
    const p = fixture(); expect(bindServerHlsAudio({ ...p.context, url: source }, body, p.headers)).toBeNull();
  });
  it("rejects advertised generation different from actual child", () => {
    const p = fixture(); p.headers.set("x-yawf-hls-snapshot-generation", "transcode-other");
    expect(bindServerHlsAudio(p.context, manifest, p.headers)).toBeNull();
  });
  it.each(["owner", "identity", "url", "quality", "start", "target"])("refuses stale current %s", field => {
    const p = fixture();
    const values = { owner: "other", identity: {}, url: url + "&audio=5", quality: "360p", start: 1, target: p.current.target + "x" };
    if (field === "owner") p.inventory.owner = "other";
    expect(boundServerHlsAudioIndex(p.binding, { ...p.current, [field]: values[field as keyof typeof values] }, p.inventory, p.native)).toBeNull();
  });
  it.each(["owner", "missing index", "duplicate index", "generation"])("refuses stale or ambiguous %s", field => {
    const p = fixture();
    if (field === "owner") p.inventory.owner = "other";
    if (field === "missing index") p.inventory.tracks = [{ index: 0 }];
    if (field === "duplicate index") p.inventory.tracks.push({ index: 5 });
    const binding = field === "generation" ? { ...p.binding, generation: "transcode-other" } : p.binding;
    expect(boundServerHlsAudioIndex(binding, p.current, p.inventory, p.native)).toBeNull();
  });
  it.each(["", "und"])("accepts only unavailable native language '%s'", language => {
    const p = fixture(); p.native[0].language = language;
    expect(boundServerHlsAudioIndex(p.binding, p.current, p.inventory, p.native)).toBe(5);
  });
  it.each(["English", "Commentary", "Japanese Main"])("refuses meaningful label %s", label => {
    const p = fixture(); p.native[0].label = label;
    expect(boundServerHlsAudioIndex(p.binding, p.current, p.inventory, p.native)).toBeNull();
  });
  it.each(["en", "fr", "invalid-language"])("does not override native language %s", language => {
    const p = fixture(); p.native[0].language = language;
    expect(boundServerHlsAudioIndex(p.binding, p.current, p.inventory, p.native)).toBeNull();
  });
  it.each(["zero enabled", "two enabled", "second disabled", "empty"])("refuses %s native selection", scenario => {
    const p = fixture();
    if (scenario === "zero enabled") p.native[0].enabled = false;
    if (scenario === "two enabled" || scenario === "second disabled") p.native.push({ ...p.native[0], enabled: scenario === "two enabled" });
    if (scenario === "empty") p.native = [];
    expect(boundServerHlsAudioIndex(p.binding, p.current, p.inventory, p.native)).toBeNull();
  });
});
