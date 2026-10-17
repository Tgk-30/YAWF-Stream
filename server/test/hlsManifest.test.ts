import { describe, expect, it, vi } from "vitest";
import {
  MAX_HLS_MANIFEST_BYTES,
  rewriteHlsManifest,
  type HlsReferenceKind,
} from "../src/hlsManifest.js";

function proxyRewrite(absoluteUrl: string, kind: HlsReferenceKind): string {
  return `/proxy/${kind}?url=${encodeURIComponent(absoluteUrl)}`;
}

describe("rewriteHlsManifest", () => {
  it("rewrites relative master renditions, audio, subtitles, and I-frame playlists as manifests", () => {
    const seen: Array<[string, HlsReferenceKind]> = [];
    const input = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio/en/index"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="French",URI="../subs/fr.m3u8?forced=0"',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=86000,URI="iframes/index.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1280000,AUDIO="aac",SUBTITLES="subs"',
      "video/720p?token=abc",
      "",
    ].join("\n");

    const output = rewriteHlsManifest(
      input,
      "https://cdn.example/final/master/index.m3u8?redirected=1",
      (url, kind) => {
        seen.push([url, kind]);
        return proxyRewrite(url, kind);
      },
    );

    expect(seen).toEqual([
      ["https://cdn.example/final/master/audio/en/index", "manifest"],
      ["https://cdn.example/final/subs/fr.m3u8?forced=0", "manifest"],
      ["https://cdn.example/final/master/iframes/index.m3u8", "manifest"],
      ["https://cdn.example/final/master/video/720p?token=abc", "manifest"],
    ]);
    expect(output).toContain('DEFAULT=YES,URI="/proxy/manifest?url=');
    expect(output).toContain("\n/proxy/manifest?url=");
    expect(output.endsWith("\n")).toBe(true);
  });

  it("rewrites media assets, keys, maps, and LL-HLS references while preserving metadata", () => {
    const seen: Array<[string, HlsReferenceKind]> = [];
    const input = [
      "#EXTM3U",
      "#EXT-X-VERSION:9",
      "#EXT-X-TARGETDURATION:6",
      '#EXT-X-KEY:METHOD=AES-128,URI="../keys/key.bin?key=1",IV=0x1',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
      '#EXT-X-PART:DURATION=0.33334,URI="parts/p0.m4s",INDEPENDENT=YES',
      '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="parts/p1.m4s",BYTERANGE-START=100',
      '#EXT-X-RENDITION-REPORT:URI="../alt/live",LAST-MSN=42,LAST-PART=3',
      "#EXTINF:6.006,Title stays unchanged",
      "segments/one.ts?sig=abc",
      "#EXT-X-BYTERANGE:1000@720",
      "//media.example/two.ts",
      "#EXT-X-ENDLIST",
    ].join("\r\n");

    const output = rewriteHlsManifest(
      input,
      "https://origin.example/live/rendition/index.m3u8",
      (url, kind) => {
        seen.push([url, kind]);
        return proxyRewrite(url, kind);
      },
    );

    expect(seen).toEqual([
      ["https://origin.example/live/keys/key.bin?key=1", "asset"],
      ["https://origin.example/live/rendition/init.mp4", "asset"],
      ["https://origin.example/live/rendition/parts/p0.m4s", "asset"],
      ["https://origin.example/live/rendition/parts/p1.m4s", "asset"],
      ["https://origin.example/live/alt/live", "manifest"],
      ["https://origin.example/live/rendition/segments/one.ts?sig=abc", "asset"],
      ["https://media.example/two.ts", "asset"],
    ]);
    expect(output).toContain("#EXTINF:6.006,Title stays unchanged\r\n");
    expect(output).toContain("#EXT-X-BYTERANGE:1000@720\r\n");
    expect(output).toContain('BYTERANGE="720@0"');
    expect(output.split("\r\n")).toHaveLength(input.split("\r\n").length);
  });

  it("uses the final redirected response URL as the relative-reference base", () => {
    const rewrite = vi.fn(proxyRewrite);
    rewriteHlsManifest(
      "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nchunk.ts\n",
      "https://redirected.cdn.example/new/path/final.m3u8?from=origin",
      rewrite,
    );
    expect(rewrite).toHaveBeenCalledWith(
      "https://redirected.cdn.example/new/path/chunk.ts",
      "asset",
    );
  });

  it.each([
    ["absolute", "https://assets.example/a.ts?x=1", "https://assets.example/a.ts?x=1"],
    ["protocol relative", "//assets.example/a.ts?x=1", "https://assets.example/a.ts?x=1"],
    ["root relative", "/a.ts?x=1", "https://origin.example/a.ts?x=1"],
    ["query relative", "?part=2", "https://origin.example/live/index.m3u8?part=2"],
  ])("resolves %s URI lines", (_label, reference, expected) => {
    const rewrite = vi.fn(proxyRewrite);
    rewriteHlsManifest(
      `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n${reference}`,
      "https://origin.example/live/index.m3u8?old=1",
      rewrite,
    );
    expect(rewrite).toHaveBeenCalledWith(expected, "asset");
  });

  it.each([
    ["key", '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', "asset", false],
    ["map", '#EXT-X-MAP:URI="init.mp4"', "asset", false],
    ["session key", '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="key.bin"', "asset", true],
    ["session data", '#EXT-X-SESSION-DATA:DATA-ID="com.example",URI="meta.json"', "asset", true],
    ["audio", '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="A",URI="audio"', "manifest", true],
    ["I-frame", '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframe"', "manifest", true],
    ["part", '#EXT-X-PART:DURATION=1,URI="part.m4s"', "asset", false],
    ["preload", '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="next.m4s"', "asset", false],
    ["rendition report", '#EXT-X-RENDITION-REPORT:URI="other"', "manifest", false],
  ] as const)("classifies the %s URI attribute", (_label, line, kind, isMaster) => {
    const input = isMaster
      ? `#EXTM3U\n${line}\n#EXT-X-STREAM-INF:BANDWIDTH=2\nmain`
      : `#EXTM3U\n#EXT-X-TARGETDURATION:4\n${line}`;
    const rewrite = vi.fn(proxyRewrite);
    rewriteHlsManifest(input, "https://origin.example/live/index.m3u8", rewrite);
    expect(rewrite).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/origin\.example\/live\//), kind);
  });

  it("preserves optional audio without a URI and an unencrypted METHOD=NONE tag", () => {
    expect(rewriteHlsManifest(
      '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Muxed"\n#EXT-X-STREAM-INF:BANDWIDTH=2\nmain\n',
      "https://origin.example/master.m3u8",
      proxyRewrite,
    )).toContain('NAME="Muxed"');
    expect(rewriteHlsManifest(
      "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\na.ts\n",
      "https://origin.example/media.m3u8",
      proxyRewrite,
    )).toContain("#EXT-X-KEY:METHOD=NONE");
  });

  it("preserves spaces in attribute formatting and the absence of a final newline", () => {
    const input = '#EXTM3U\n#EXT-X-MEDIA: TYPE=AUDIO , GROUP-ID="a" , NAME="A" , URI = "audio.m3u8"\n#EXT-X-STREAM-INF: BANDWIDTH=2\nmain';
    const output = rewriteHlsManifest(input, "https://origin.example/master.m3u8", proxyRewrite);
    expect(output).toMatch(/NAME="A" , URI = "\/proxy\/manifest\?url=/);
    expect(output.endsWith("\n")).toBe(false);
  });

  it("preserves quoted commas and backslashes in non-URI attributes", () => {
    const input = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio,main",NAME="Director\\Commentary",URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2,AUDIO="audio,main",CODECS="avc1.4d401f,mp4a.40.2"',
      "main.m3u8",
    ].join("\n");
    const output = rewriteHlsManifest(
      input,
      "https://origin.example/master.m3u8",
      proxyRewrite,
    );
    expect(output).toContain('GROUP-ID="audio,main"');
    expect(output).toContain('NAME="Director\\Commentary"');
    expect(output).toContain('CODECS="avc1.4d401f,mp4a.40.2"');
  });

  it("ignores and preserves comments and blank lines before a variant URI", () => {
    const input = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=2",
      "# provider comment with URI=ignored and {$comment}=ignored",
      "",
      "child-without-extension",
    ].join("\r\n");
    const rewrite = vi.fn(proxyRewrite);
    const output = rewriteHlsManifest(
      input,
      "https://origin.example/master.m3u8",
      rewrite,
    );
    expect(rewrite).toHaveBeenCalledWith(
      "https://origin.example/child-without-extension",
      "manifest",
    );
    expect(output).toContain("# provider comment with URI=ignored and {$comment}=ignored\r\n\r\n/proxy/manifest");
  });

  it("rejects progressive media with the exact non-playlist error", () => {
    expect(() => rewriteHlsManifest(
      "not an m3u8 video payload",
      "https://origin.example/video.mp4",
      proxyRewrite,
    )).toThrowError(new Error("Not an HLS playlist."));
  });

  it.each([
    ["missing rendition URI", "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10\n"],
    ["missing BANDWIDTH", "#EXTM3U\n#EXT-X-STREAM-INF:CODECS=\"avc1\"\nchild.m3u8"],
    ["unterminated quote", '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8'],
    ["duplicate attribute", '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,TYPE=AUDIO,URI="audio.m3u8"'],
    ["unquoted URI attribute", "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=audio.m3u8"],
    ["missing subtitle URI", '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="S"'],
    ["closed captions URI", '#EXTM3U\n#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,URI="cc.m3u8"'],
    ["mixed master and media tags", "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"A\"\n#EXTINF:4,\na.ts"],
    ["bare carriage return", "#EXTM3U\r#EXT-X-ENDLIST"],
  ])("rejects malformed input: %s", (_label, input) => {
    expect(() => rewriteHlsManifest(
      input,
      "https://origin.example/master.m3u8",
      proxyRewrite,
    )).toThrow("Malformed HLS playlist.");
  });

  it.each([
    ["variable declaration", '#EXTM3U\n#EXT-X-DEFINE:NAME="host",VALUE="cdn.example"'],
    ["variable substitution", "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nhttps://{$host}/a.ts"],
    ["content steering", '#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI="steering.json"'],
    ["unknown URI-bearing tag", '#EXTM3U\n#EXT-X-NEW-TAG:RESOURCE-URI="raw.json"'],
    ["unknown URI-bearing attribute", '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="A",URI="audio",BACKUP-URI="raw.m3u8"'],
  ])("rejects unsupported URI feature: %s", (_label, input) => {
    expect(() => rewriteHlsManifest(
      input,
      "https://origin.example/master.m3u8",
      proxyRewrite,
    )).toThrow("Unsupported HLS playlist feature.");
  });

  it.each([
    ["X-ASSET-URI", 'X-ASSET-URI="https://ads.example/interstitial.m3u8"'],
    ["X-ASSET-LIST", 'X-ASSET-LIST="https://ads.example/assets.json"'],
  ])("rejects Apple interstitial %s without exposing its fetch target", (_label, asset) => {
    const rewrite = vi.fn(proxyRewrite);
    let error: Error | null = null;
    try {
      rewriteHlsManifest(
        [
          "#EXTM3U",
          "#EXT-X-TARGETDURATION:4",
          `#EXT-X-DATERANGE:ID="ad-1",CLASS="com.apple.hls.interstitial",START-DATE="2026-01-01T00:00:00Z",${asset}`,
          "#EXTINF:4,",
          "segment.ts",
        ].join("\n"),
        "https://origin.example/media.m3u8",
        rewrite,
      );
    } catch (value) {
      error = value as Error;
    }
    expect(error?.message).toBe("Unsupported HLS playlist feature.");
    expect(error?.message).not.toContain("ads.example");
    expect(rewrite).not.toHaveBeenCalled();
  });

  it("rejects an Apple interstitial class even before it declares an asset", () => {
    expect(() => rewriteHlsManifest(
      [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:4",
        '#EXT-X-DATERANGE:ID="ad-1",CLASS="com.apple.hls.interstitial",START-DATE="2026-01-01T00:00:00Z"',
        "#EXTINF:4,",
        "segment.ts",
      ].join("\n"),
      "https://origin.example/media.m3u8",
      proxyRewrite,
    )).toThrow("Unsupported HLS playlist feature.");
  });

  it.each([
    ["non-HTTP scheme", "file:///etc/passwd"],
    ["embedded credentials", "https://user:secret@origin.example/a.ts"],
    ["control character", "https://origin.example/a\t.ts"],
    ["space", "segment one.ts"],
    ["overlong", `https://origin.example/${"a".repeat(8_192)}`],
  ])("rejects an invalid %s without disclosing the reference", (_label, reference) => {
    let error: Error | null = null;
    try {
      rewriteHlsManifest(
        `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n${reference}`,
        "https://origin.example/media.m3u8",
        proxyRewrite,
      );
    } catch (value) {
      error = value as Error;
    }
    expect(error?.message).toBe("Invalid HLS playlist URI.");
    expect(error?.message).not.toContain(reference);
  });

  it("does not disclose a URI when the callback fails", () => {
    const secret = "https://origin.example/private.ts?token=secret";
    expect(() => rewriteHlsManifest(
      `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n${secret}`,
      "https://origin.example/media.m3u8",
      () => { throw new Error(`failed for ${secret}`); },
    )).toThrowError(new Error("Could not rewrite HLS playlist URI."));
  });

  it("bounds input size, rewritten size, and reference count", () => {
    expect(() => rewriteHlsManifest(
      `#EXTM3U\n#${"x".repeat(MAX_HLS_MANIFEST_BYTES)}`,
      "https://origin.example/master.m3u8",
      proxyRewrite,
    )).toThrow("HLS playlist exceeds the size limit.");

    expect(() => rewriteHlsManifest(
      "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\na.ts",
      "https://origin.example/media.m3u8",
      proxyRewrite,
    )).not.toThrow();

    const outputReferences = Array.from({ length: 10_500 }, () => "a.ts").join("\n");
    expect(() => rewriteHlsManifest(
      `#EXTM3U\n#EXT-X-TARGETDURATION:1\n${outputReferences}`,
      "https://origin.example/media.m3u8",
      () => `/${"x".repeat(200)}`,
    )).toThrow("Rewritten HLS playlist exceeds the size limit.");

    const references = Array.from({ length: 16_385 }, () => "a.ts").join("\n");
    expect(() => rewriteHlsManifest(
      `#EXTM3U\n#EXT-X-TARGETDURATION:1\n${references}`,
      "https://origin.example/media.m3u8",
      () => "/a",
    )).toThrow("HLS playlist has too many URI references.");
  });
});
