// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserExternalCapability,
  browserExternalGuidance,
  browserExternalFileHint,
  browserExternalPlayerLinks,
} from "./browserExternalPlayers";

const token = "A".repeat(43);
const capability = `https://server.example/yawf/api/external-stream/session-1/${token}`;

describe("browser external-player hand-offs", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds encoded iPhone and iPad VLC and Infuse choices", () => {
    vi.stubGlobal("location", new URL("https://server.example/yawf/watch"));
    const links = browserExternalPlayerLinks(
      capability,
      "Film &\nFriends",
      "ios",
      false,
      "video-file",
    );

    expect(links).toEqual([
      expect.objectContaining({
        id: "vlc",
        href: `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(capability)}`,
      }),
      expect.objectContaining({
        id: "infuse",
        href: `infuse://x-callback-url/play?url=${encodeURIComponent(capability)}&filename=Film%20%26%20Friends`,
      }),
    ]);
  });

  it.each(["hls-playlist", "unknown"] as const)(
    "keeps iOS VLC available for %s originals while suppressing Infuse",
    (originalHint) => {
      vi.stubGlobal("location", new URL("https://server.example/yawf/watch"));

      expect(
        browserExternalPlayerLinks(capability, "Film", "ios", false, originalHint),
      ).toEqual([
        expect.objectContaining({
          id: "vlc",
          href: `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(capability)}`,
        }),
      ]);
    },
  );

  it("builds a bounded Android VLC intent in normal and standalone browsers", () => {
    vi.stubGlobal("location", new URL("https://server.example/yawf/watch"));
    const expectedHref =
      `intent://server.example/yawf/api/external-stream/session-1/${token}` +
      "#Intent;scheme=https;package=org.videolan.vlc;type=video/*;end";

    for (const standalone of [false, true]) {
      expect(browserExternalPlayerLinks(capability, "Film", "android", standalone)).toEqual([
        expect.objectContaining({ id: "vlc", href: expectedHref }),
      ]);
    }
  });

  it("builds the exact bounded IINA URI without title or mpv query parameters", () => {
    vi.stubGlobal("location", new URL("https://server.example/yawf/watch"));
    const [iina] = browserExternalPlayerLinks(
      capability,
      "Film & mpv-options=--script=/tmp/nope",
      "mac",
      false,
      "unknown",
    );

    expect(iina).toEqual(expect.objectContaining({
      id: "iina",
      href: `iina://open?url=${encodeURIComponent(capability)}&new_window=1`,
    }));
    const query = new URL(iina.href).searchParams;
    expect([...query.keys()]).toEqual(["url", "new_window"]);
    expect(query.get("url")).toBe(capability);
    expect(query.get("new_window")).toBe("1");
    expect(iina.href).not.toContain("Film");
    expect(iina.href).not.toContain("mpv-options");
  });

  it.each([false, true])(
    "offers IINA and Infuse for progressive originals in standalone=%s Mac browsers",
    (standalone) => {
      vi.stubGlobal("location", new URL("https://server.example/yawf/watch"));
      expect(
        browserExternalPlayerLinks(capability, "Film", "mac", standalone, "video-file"),
      ).toEqual([
        expect.objectContaining({ id: "iina", label: "Open in IINA" }),
        expect.objectContaining({ id: "infuse", label: "Open in Infuse" }),
      ]);
    },
  );

  it.each([false, true])(
    "offers only IINA for HLS originals in standalone=%s Mac browsers",
    (standalone) => {
      vi.stubGlobal("location", new URL("https://server.example/yawf/watch"));
      expect(
        browserExternalPlayerLinks(capability, "Film", "mac", standalone, "hls-playlist"),
      ).toEqual([
        expect.objectContaining({ id: "iina", label: "Open in IINA" }),
      ]);
    },
  );

  it.each([false, true])(
    "defaults unknown originals to IINA only in standalone=%s Mac browsers",
    (standalone) => {
      vi.stubGlobal("location", new URL("https://server.example/yawf/watch"));
      expect(browserExternalPlayerLinks(capability, "Film", "mac", standalone)).toEqual([
        expect.objectContaining({ id: "iina", label: "Open in IINA" }),
      ]);
    },
  );

  it.each(["m3u", "m3u8"])("classifies original .%s playlists as HLS", (suffix) => {
    expect(browserExternalFileHint(` Film.${suffix.toUpperCase()} `)).toBe("hls-playlist");
  });

  it.each([
    "mp4", "m4v", "mov", "mkv", "avi", "webm", "ts", "m2ts", "mts",
    "mpg", "mpeg", "wmv", "flv", "ogv", "3gp",
  ])("classifies original .%s files as progressive", (suffix) => {
    expect(browserExternalFileHint(`Film.${suffix.toUpperCase()}`)).toBe("video-file");
  });

  it.each([
    ["query-suffixed filename", "movie.mp4?download=1"],
    ["extensionless capability", "extensionless-capability"],
    ["trailing suffix", "playlist.m3u8.txt"],
    ["empty filename", ""],
    ["null filename", null],
    ["undefined filename", undefined],
  ])("keeps %s original metadata unknown", (_label, sourceFileName) => {
    expect(browserExternalFileHint(sourceFileName)).toBe("unknown");
  });

  it("describes Mac IINA as direct and Infuse as an unverified filename hint", () => {
    vi.stubGlobal("location", new URL("https://server.example/yawf/watch"));
    for (const standalone of [false, true]) {
      expect(browserExternalGuidance("mac", standalone)).toContain("IINA 1.4.4 or newer");
      expect(browserExternalGuidance("mac", standalone)).toContain(
        "playback compatibility is not verified",
      );
    }
  });

  it("keeps Windows on an honest playlist or copy-link fallback", () => {
    vi.stubGlobal("location", new URL("https://server.example/yawf/watch"));
    for (const standalone of [false, true]) {
      expect(browserExternalPlayerLinks(capability, "Film", "windows", standalone)).toEqual([]);
      expect(browserExternalGuidance("windows", standalone)).toContain(
        "cannot reliably launch a specific desktop player",
      );
    }
  });

  it.each([
    ["provider URL", "https://provider.example/video.mkv"],
    ["protected proxy", "https://server.example/yawf/api/stream/session-1"],
    ["cross-origin capability", `https://other.example/yawf/api/external-stream/session-1/${token}`],
    ["capability with query", `${capability}?authorization=secret`],
    ["short token", "https://server.example/yawf/api/external-stream/session-1/short"],
  ])("rejects %s rather than leaking it to another app", (_label, rawUrl) => {
    vi.stubGlobal("location", new URL("https://server.example/yawf/watch"));
    expect(browserExternalCapability(rawUrl)).toBeNull();
    expect(browserExternalPlayerLinks(rawUrl, "Film", "ios", true)).toEqual([]);
    expect(
      browserExternalPlayerLinks(rawUrl, "Film", "mac", true, "video-file"),
    ).toEqual([]);
  });
});
