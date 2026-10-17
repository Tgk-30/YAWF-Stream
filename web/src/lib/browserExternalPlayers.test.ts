// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserExternalCapability,
  browserExternalGuidance,
  browserExternalPlayerLinks,
} from "./browserExternalPlayers";

const token = "A".repeat(43);
const capability = `https://server.example/yawf/api/external-stream/session-1/${token}`;

describe("browser external-player hand-offs", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds encoded iPhone and iPad VLC and Infuse choices", () => {
    vi.stubGlobal("location", new URL("https://server.example/yawf/watch"));
    const links = browserExternalPlayerLinks(capability, "Film &\nFriends", "ios", false);

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

  it("offers Infuse in normal and standalone Mac browsers", () => {
    vi.stubGlobal("location", new URL("https://server.example/yawf/watch"));
    for (const standalone of [false, true]) {
      expect(browserExternalPlayerLinks(capability, "Film", "mac", standalone)).toEqual([
        expect.objectContaining({ id: "infuse", label: "Open in Infuse" }),
      ]);
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
  });
});
