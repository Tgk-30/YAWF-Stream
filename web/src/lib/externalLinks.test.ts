// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isTauriMock = vi.fn(() => true);
const openExternalURL = vi.fn();
vi.mock("./tauri", () => ({
  isTauri: () => isTauriMock(),
  openExternalURL: (url: string) => openExternalURL(url),
}));

import { installExternalLinkHandler } from "./externalLinks";

// The handler installs a single document-level listener the first time it is
// called; a module-level guard makes repeat calls no-ops. So install once and
// drive behavior through the mocks.
installExternalLinkHandler();

function clickAnchor(href: string, init: MouseEventInit = {}) {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  a.textContent = "link";
  document.body.append(a);
  a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
  a.remove();
}

describe("installExternalLinkHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isTauriMock.mockReturnValue(true);
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("routes an external https link through the opener under Tauri", () => {
    clickAnchor("https://www.themoviedb.org/settings/api");
    expect(openExternalURL).toHaveBeenCalledWith("https://www.themoviedb.org/settings/api");
  });

  it("routes an http link too", () => {
    clickAnchor("http://example.com/x");
    expect(openExternalURL).toHaveBeenCalledWith("http://example.com/x");
  });

  it("ignores in-app (non-http) hrefs like fragments", () => {
    clickAnchor("#section");
    expect(openExternalURL).not.toHaveBeenCalled();
  });

  it("does nothing in a plain browser (native link handles it)", () => {
    isTauriMock.mockReturnValue(false);
    clickAnchor("https://real-debrid.com/apitoken");
    expect(openExternalURL).not.toHaveBeenCalled();
  });

  it("ignores anchors whose click was already handled", () => {
    const a = document.createElement("a");
    a.href = "https://example.com/handled";
    a.textContent = "handled";
    document.body.append(a);

    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    event.preventDefault();
    a.dispatchEvent(event);

    expect(openExternalURL).not.toHaveBeenCalled();
    a.remove();
  });

  it("only installs one delegated listener even when called twice", () => {
    clickAnchor("https://www.themoviedb.org/settings/api");
    expect(openExternalURL).toHaveBeenCalledTimes(1);

    installExternalLinkHandler();
    openExternalURL.mockClear();
    clickAnchor("https://www.themoviedb.org/settings/api");
    expect(openExternalURL).toHaveBeenCalledTimes(1);
  });

  it("routes modified clicks too under Tauri (no new-tab in the desktop webview)", () => {
    // In a browser Cmd/Ctrl-click opens a new tab, but the Tauri webview has no
    // such concept - the click would otherwise be swallowed and do nothing, so
    // it must still reach the OS browser.
    clickAnchor("https://alldebrid.com/apikeys", { metaKey: true });
    expect(openExternalURL).toHaveBeenCalledWith("https://alldebrid.com/apikeys");
  });
});
