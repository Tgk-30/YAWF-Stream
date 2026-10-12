// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, isTauriMock, deviceKindMock, assertNetworkAllowedMock, isRequestExemptMock } =
  vi.hoisted(() => ({
    invokeMock: vi.fn(),
    isTauriMock: vi.fn(() => true),
    deviceKindMock: vi.fn(() => "android"),
    assertNetworkAllowedMock: vi.fn(),
    isRequestExemptMock: vi.fn(() => false),
  }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("./tauri", () => ({ isTauri: isTauriMock }));
vi.mock("./platform", () => ({ deviceKind: deviceKindMock }));
vi.mock("./networkPolicy", () => ({
  assertNetworkAllowed: assertNetworkAllowedMock,
  isRequestExempt: isRequestExemptMock,
}));

import {
  isAndroidExternalPlayerEligible,
  openAndroidExternalPlayer,
} from "./androidExternalPlayer";

type RuntimeMarkers = typeof globalThis & {
  __YAWF_TAURI_ANDROID__?: boolean;
  __YAWF_TAURI_MOBILE__?: boolean;
};

const runtimeMarkers = globalThis as RuntimeMarkers;

describe("Android external player bridge", () => {
  beforeEach(() => {
    vi.stubGlobal("location", new URL("tauri://localhost/"));
    invokeMock.mockReset().mockResolvedValue(
      "Player chooser opened. Select a video app to continue.",
    );
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    assertNetworkAllowedMock.mockReset();
    isRequestExemptMock.mockReset().mockReturnValue(false);
    delete runtimeMarkers.__YAWF_TAURI_ANDROID__;
    delete runtimeMarkers.__YAWF_TAURI_MOBILE__;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete runtimeMarkers.__YAWF_TAURI_ANDROID__;
    delete runtimeMarkers.__YAWF_TAURI_MOBILE__;
  });

  it("invokes the Android chooser with a canonical HTTP(S) stream URL", async () => {
    await expect(
      openAndroidExternalPlayer("https://media.example", () => true),
    ).resolves.toBe("Player chooser opened. Select a video app to continue.");

    expect(assertNetworkAllowedMock).toHaveBeenCalledWith(
      "streaming",
      "Android external player",
    );
    expect(invokeMock).toHaveBeenCalledWith("mobile_open_external_player", {
      url: "https://media.example/",
    });
  });

  it("rejects non-network, credentialed, and oversized links before native invoke", async () => {
    for (const url of [
      "file:///sdcard/movie.mp4",
      "https://user:secret@media.example/movie.mp4",
      `https://media.example/movie?${"x".repeat(8 * 1024)}`,
    ]) {
      await expect(openAndroidExternalPlayer(url, () => true)).rejects.toThrow(
        "not a valid HTTP(S) URL",
      );
    }
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("requires the local Android app and preserves exempt network policy", async () => {
    runtimeMarkers.__YAWF_TAURI_MOBILE__ = true;
    deviceKindMock.mockReturnValue("ios");
    await expect(
      openAndroidExternalPlayer("https://media.example/movie.mp4", () => true),
    ).rejects.toThrow("bundled Android app");
    expect(invokeMock).not.toHaveBeenCalled();

    deviceKindMock.mockReturnValue("android");
    isRequestExemptMock.mockReturnValue(true);
    await openAndroidExternalPlayer("http://127.0.0.1:43110/movie.mp4", () => true);
    expect(assertNetworkAllowedMock).not.toHaveBeenCalled();
  });

  it("uses the Android WebView marker when the user agent looks desktop", async () => {
    deviceKindMock.mockReturnValue("desktop");
    runtimeMarkers.__YAWF_TAURI_ANDROID__ = true;

    await expect(
      openAndroidExternalPlayer("https://media.example/movie.mp4", () => true),
    ).resolves.toBe("Player chooser opened. Select a video app to continue.");
    expect(invokeMock).toHaveBeenCalledWith("mobile_open_external_player", {
      url: "https://media.example/movie.mp4",
    });
  });

  it("rejects a remote page even when Android markers and a valid target remain", async () => {
    deviceKindMock.mockReturnValue("desktop");
    runtimeMarkers.__YAWF_TAURI_ANDROID__ = true;
    vi.stubGlobal("location", new URL("https://server.example/watch"));

    expect(isAndroidExternalPlayerEligible()).toBe(false);
    await expect(
      openAndroidExternalPlayer("https://media.example/movie.mp4", () => true),
    ).rejects.toThrow("bundled Android app");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("accepts only the bundled Tauri document origins", () => {
    runtimeMarkers.__YAWF_TAURI_ANDROID__ = true;
    deviceKindMock.mockReturnValue("desktop");
    for (const page of [
      "tauri://localhost/",
      "tauri://localhost/watch/episode",
      "http://tauri.localhost/",
      "http://tauri.localhost:80/watch/episode",
    ]) {
      vi.stubGlobal("location", new URL(page));
      expect(isAndroidExternalPlayerEligible(), page).toBe(true);
    }
    for (const page of [
      "http://localhost/",
      "http://tauri.localhost:8080/",
      "https://tauri.localhost/",
      "https://server.example/",
    ]) {
      vi.stubGlobal("location", new URL(page));
      expect(isAndroidExternalPlayerEligible(), page).toBe(false);
    }
  });

  it("checks current source ownership before invoke and after completion", async () => {
    let owned = false;
    await expect(
      openAndroidExternalPlayer("https://media.example/old.mp4", () => owned),
    ).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();

    owned = true;
    const replacedBeforeInvoke = openAndroidExternalPlayer(
      "https://media.example/replaced.mp4",
      () => owned,
    );
    owned = false;
    await expect(replacedBeforeInvoke).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();

    let resolveInvoke!: (value: string) => void;
    invokeMock.mockReturnValue(new Promise<string>((resolve) => { resolveInvoke = resolve; }));
    owned = true;
    const result = openAndroidExternalPlayer(
      "https://media.example/current.mp4",
      () => owned,
    );
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    owned = false;
    resolveInvoke("Player chooser opened. Select a video app to continue.");
    await expect(result).resolves.toBeNull();
  });

  it("does not report a false frontend timeout while native dispatch is pending", async () => {
    vi.useFakeTimers();
    let resolveInvoke!: (value: string) => void;
    invokeMock.mockReturnValue(new Promise<string>((resolve) => {
      resolveInvoke = resolve;
    }));
    let settled = false;
    const result = openAndroidExternalPlayer(
      "https://media.example/private-stream-marker",
      () => true,
    );
    void result.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);

    resolveInvoke("Player chooser opened. Select a video app to continue.");
    await expect(result).resolves.toBe(
      "Player chooser opened. Select a video app to continue.",
    );
  });

  it("sanitizes native chooser rejection details", async () => {
    invokeMock.mockRejectedValue(new Error("private-stream-marker native detail"));
    const error = await openAndroidExternalPlayer(
      "https://media.example/private-stream-marker",
      () => true,
    ).then(
      () => null,
      (value: unknown) => value,
    );

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected chooser failure");
    expect(error.message).toBe("The Android player chooser could not be opened.");
    expect(error.message).not.toContain("private-stream-marker");
  });
});
