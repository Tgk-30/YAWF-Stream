// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { containerFullscreenExit, containerFullscreenRequest, ipadSafariPageUrl } from "./playerFullscreen";

describe("player fullscreen policy", () => {
  it("selects standard first and binds request and exit to the public owner", () => {
    const standard = vi.fn(), prefixed = vi.fn();
    const element = Object.assign(document.createElement("section"), { requestFullscreen: standard, webkitRequestFullscreen: prefixed });
    containerFullscreenRequest(element)?.();
    expect(standard.mock.instances[0]).toBe(element); expect(prefixed).not.toHaveBeenCalled();
    const doc = { exitFullscreen: standard, webkitExitFullscreen: prefixed } as unknown as Document;
    containerFullscreenExit(doc)?.(); expect(standard.mock.instances[1]).toBe(doc);
  });
  it("uses prefixed request and exit only without standard methods", () => {
    const prefixed = vi.fn();
    const element = Object.assign(document.createElement("section"), { requestFullscreen: undefined, webkitRequestFullscreen: prefixed });
    containerFullscreenRequest(element)?.(); expect(prefixed.mock.instances[0]).toBe(element);
    const doc = { webkitExitFullscreen: prefixed } as unknown as Document;
    containerFullscreenExit(doc)?.(); expect(prefixed.mock.instances[1]).toBe(doc);
    expect(containerFullscreenRequest(document.createElement("section"))).toBeNull();
    expect(containerFullscreenExit({} as Document)).toBeNull();
  });
  const ipad = { userAgent: "iPad", platform: "iPad", maxTouchPoints: 5 };
  it.each(["http://server.example/yawf/watch?session=omit#secret", "https://user:password@server.example/yawf/watch?cap=omit#secret"])("strips capabilities and userinfo from same page %s", href => {
    const page = new URL(href);
    expect(ipadSafariPageUrl(page, ipad, true, true)).toBe(`${page.origin}/yawf/watch`);
  });
  it.each(["javascript:alert(1)", "file:///app/index.html", "data:text/plain,hello", "tauri://localhost/"])("rejects non-HTTP page %s", href => {
    expect(ipadSafariPageUrl(new URL(href), ipad, true, true)).toBeNull();
  });
  it("rejects foreign or malformed location identity and non-browser surfaces", () => {
    expect(ipadSafariPageUrl({ href: "https://foreign.example/", origin: "https://server.example" }, ipad, true, true)).toBeNull();
    expect(ipadSafariPageUrl({ href: "not a URL", origin: "https://server.example" }, ipad, true, true)).toBeNull();
    expect(ipadSafariPageUrl(new URL("https://server.example/"), ipad, true, false)).toBeNull();
  });
});
