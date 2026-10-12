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
  isAndroidAppUiContext,
  isAndroidExternalPlayerEligible,
  isAndroidServerExternalPlayerEligible,
  openAndroidExternalPlayer,
  openAndroidServerExternalPlayer,
} from "./androidExternalPlayer";

type RuntimeMarkers = typeof globalThis & {
  __YAWF_TAURI_ANDROID__?: boolean;
  __YAWF_TAURI_MOBILE__?: boolean;
  __YAWF_NATIVE_SAFE_AREA__?: unknown;
  __YAWF_SERVER_PLAYER__?: unknown;
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
    delete runtimeMarkers.__YAWF_NATIVE_SAFE_AREA__;
    delete runtimeMarkers.__YAWF_SERVER_PLAYER__;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete runtimeMarkers.__YAWF_TAURI_ANDROID__;
    delete runtimeMarkers.__YAWF_TAURI_MOBILE__;
    delete runtimeMarkers.__YAWF_NATIVE_SAFE_AREA__;
    delete runtimeMarkers.__YAWF_SERVER_PLAYER__;
  });

  it("detects the read-only Android provider without invoking its inset getter", () => {
    isTauriMock.mockReturnValue(false);
    deviceKindMock.mockReturnValue("desktop");
    const getInsets = vi.fn(() => '{"top":0,"right":0,"bottom":0,"left":0}');
    runtimeMarkers.__YAWF_NATIVE_SAFE_AREA__ = { getInsets };

    expect(isAndroidAppUiContext()).toBe(true);
    expect(getInsets).not.toHaveBeenCalled();
    expect(isAndroidExternalPlayerEligible()).toBe(false);
  });

  it("does not classify an ordinary desktop page as Android app UI", () => {
    isTauriMock.mockReturnValue(false);
    deviceKindMock.mockReturnValue("desktop");
    runtimeMarkers.__YAWF_NATIVE_SAFE_AREA__ = { getInsets: "not a function" };

    expect(isAndroidAppUiContext()).toBe(false);
  });

  it("retains the existing native Tauri Android UI context", () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");

    expect(isAndroidAppUiContext()).toBe(true);
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

  function installServerPlayerBridge() {
    const listeners = new Set<(event: { data: unknown }) => void>();
    const bridge = {
      postMessage: vi.fn(),
      addEventListener: vi.fn((type: string, listener: (event: { data: unknown }) => void) => {
        if (type === "message") listeners.add(listener);
      }),
      removeEventListener: vi.fn((type: string, listener: (event: { data: unknown }) => void) => {
        if (type === "message") listeners.delete(listener);
      }),
    };
    runtimeMarkers.__YAWF_SERVER_PLAYER__ = bridge;
    return {
      bridge,
      deliver(message: Record<string, string>) {
        for (const listener of [...listeners]) {
          listener({ data: JSON.stringify(message) });
        }
      },
      listenerCount: () => listeners.size,
    };
  }

  it("enables the origin-attested Server Mode bridge without Tauri or a mobile user agent", () => {
    isTauriMock.mockReturnValue(false);
    deviceKindMock.mockReturnValue("desktop");
    vi.stubGlobal("location", new URL("https://server.example/yawf/watch"));
    installServerPlayerBridge();
    const token = "A".repeat(43);

    expect(isAndroidAppUiContext()).toBe(true);
    expect(isAndroidExternalPlayerEligible()).toBe(false);
    expect(isAndroidServerExternalPlayerEligible(
      `https://server.example/yawf/api/external-stream/session-1/${token}`,
    )).toBe(true);
  });

  it("accepts canonical IPv6 origins with default and explicit nondefault ports", () => {
    isTauriMock.mockReturnValue(false);
    deviceKindMock.mockReturnValue("desktop");
    installServerPlayerBridge();
    const token = "V".repeat(43);
    for (const [page, target] of [
      [
        "https://[2001:db8::1]/watch",
        `https://[2001:db8::1]/api/external-stream/session-1/${token}`,
      ],
      [
        "http://[::1]:8080/yawf/watch",
        `http://[::1]:8080/yawf/api/external-stream/session-1/${token}`,
      ],
    ]) {
      vi.stubGlobal("location", new URL(page));
      expect(isAndroidServerExternalPlayerEligible(target), target).toBe(true);
    }
  });

  it("rejects remote capability confusion before posting to the native bridge", async () => {
    isTauriMock.mockReturnValue(false);
    deviceKindMock.mockReturnValue("desktop");
    vi.stubGlobal("location", new URL("https://server.example/yawf/watch"));
    const { bridge } = installServerPlayerBridge();
    const token = "A".repeat(43);
    const invalid = [
      `https://other.example/yawf/api/external-stream/session-1/${token}`,
      `https://server.example/yawf/api/external-stream/session-1/${token}?download=1`,
      `https://server.example/yawf/api/external-stream/session-1/${token}#fragment`,
      `https://user:password@server.example/yawf/api/external-stream/session-1/${token}`,
      `https://server.example/yawf/api/external-stream/%2e%2e/${token}`,
      `https://server.example/yawf/api/external-stream/session-1/short`,
      `http://server.example/yawf/api/external-stream/session-1/${token}`,
    ];

    for (const candidate of invalid) {
      expect(isAndroidServerExternalPlayerEligible(candidate), candidate).toBe(false);
      await expect(openAndroidServerExternalPlayer(
        candidate,
        () => true,
        new AbortController().signal,
        vi.fn(),
      )).rejects.toThrow("chooser is unavailable");
    }
    expect(bridge.postMessage).not.toHaveBeenCalled();
  });

  it("applies the existing network policy before posting a remote request", async () => {
    isTauriMock.mockReturnValue(false);
    deviceKindMock.mockReturnValue("desktop");
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    const { bridge } = installServerPlayerBridge();
    assertNetworkAllowedMock.mockImplementation(() => {
      throw new Error("blocked by network policy");
    });

    await expect(openAndroidServerExternalPlayer(
      `https://server.example/api/external-stream/session-1/${"P".repeat(43)}`,
      () => true,
      new AbortController().signal,
      vi.fn(),
    )).rejects.toThrow("blocked by network policy");
    expect(assertNetworkAllowedMock).toHaveBeenCalledWith(
      "streaming",
      "Android external player",
    );
    expect(bridge.postMessage).not.toHaveBeenCalled();
  });

  it("completes the native challenge on the original provider before reporting success", async () => {
    isTauriMock.mockReturnValue(false);
    deviceKindMock.mockReturnValue("desktop");
    vi.stubGlobal("location", new URL("https://server.example/yawf/watch"));
    const { bridge, deliver, listenerCount } = installServerPlayerBridge();
    const token = "B".repeat(43);
    const controller = new AbortController();
    const onHandoff = vi.fn();
    const pending = openAndroidServerExternalPlayer(
      `https://server.example/yawf/api/external-stream/session-1/${token}`,
      () => true,
      controller.signal,
      onHandoff,
    );
    await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledTimes(1));
    const first = JSON.parse(bridge.postMessage.mock.calls[0][0] as string) as {
      action: string;
      requestId: string;
      url: string;
    };
    expect(first).toMatchObject({
      action: "open",
      url: `https://server.example/yawf/api/external-stream/session-1/${token}`,
    });
    expect(listenerCount()).toBe(1);

    deliver({ type: "pending", requestId: first.requestId });
    expect(onHandoff).not.toHaveBeenCalled();
    const challenge = "ab".repeat(32);
    deliver({ type: "confirm", requestId: first.requestId, challenge });
    expect(onHandoff).toHaveBeenCalledTimes(1);
    expect(JSON.parse(bridge.postMessage.mock.calls[1][0] as string)).toEqual({
      action: "open",
      requestId: first.requestId,
      challenge,
    });
    deliver({ type: "success", requestId: first.requestId });

    await expect(pending).resolves.toBe("External player opened.");
    expect(listenerCount()).toBe(0);
  });

  it("cancels the owned native request when its source lifetime ends", async () => {
    isTauriMock.mockReturnValue(false);
    deviceKindMock.mockReturnValue("desktop");
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    const { bridge, listenerCount } = installServerPlayerBridge();
    const controller = new AbortController();
    const pending = openAndroidServerExternalPlayer(
      `https://server.example/api/external-stream/session-1/${"C".repeat(43)}`,
      () => true,
      controller.signal,
      vi.fn(),
    );
    await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledTimes(1));
    const first = JSON.parse(bridge.postMessage.mock.calls[0][0] as string) as {
      requestId: string;
    };

    controller.abort();

    await expect(pending).resolves.toBeNull();
    expect(JSON.parse(bridge.postMessage.mock.calls[1][0] as string)).toEqual({
      action: "cancel",
      requestId: first.requestId,
    });
    expect(listenerCount()).toBe(0);
  });

  it("does not acknowledge a confirmation after JavaScript ownership is lost", async () => {
    isTauriMock.mockReturnValue(false);
    deviceKindMock.mockReturnValue("desktop");
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    const { bridge, deliver } = installServerPlayerBridge();
    let owned = true;
    const onHandoff = vi.fn();
    const pending = openAndroidServerExternalPlayer(
      `https://server.example/api/external-stream/session-1/${"D".repeat(43)}`,
      () => owned,
      new AbortController().signal,
      onHandoff,
    );
    await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledTimes(1));
    const first = JSON.parse(bridge.postMessage.mock.calls[0][0] as string) as {
      requestId: string;
    };
    owned = false;
    deliver({
      type: "confirm",
      requestId: first.requestId,
      challenge: "ef".repeat(32),
    });

    await expect(pending).resolves.toBeNull();
    expect(onHandoff).not.toHaveBeenCalled();
    expect(JSON.parse(bridge.postMessage.mock.calls[1][0] as string)).toEqual({
      action: "cancel",
      requestId: first.requestId,
    });
  });

  it("rechecks ownership after the handoff callback before acknowledging", async () => {
    isTauriMock.mockReturnValue(false);
    deviceKindMock.mockReturnValue("desktop");
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    const { bridge, deliver } = installServerPlayerBridge();
    let owned = true;
    const pending = openAndroidServerExternalPlayer(
      `https://server.example/api/external-stream/session-1/${"F".repeat(43)}`,
      () => owned,
      new AbortController().signal,
      () => { owned = false; },
    );
    await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledTimes(1));
    const first = JSON.parse(bridge.postMessage.mock.calls[0][0] as string) as {
      requestId: string;
    };
    deliver({
      type: "confirm",
      requestId: first.requestId,
      challenge: "12".repeat(32),
    });

    await expect(pending).resolves.toBeNull();
    expect(JSON.parse(bridge.postMessage.mock.calls[1][0] as string)).toEqual({
      action: "cancel",
      requestId: first.requestId,
    });
  });

  it("reports native cancel separately and sanitizes native errors", async () => {
    isTauriMock.mockReturnValue(false);
    deviceKindMock.mockReturnValue("desktop");
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    const installed = installServerPlayerBridge();
    const target = `https://server.example/api/external-stream/session-1/${"E".repeat(43)}`;
    const cancelled = openAndroidServerExternalPlayer(
      target,
      () => true,
      new AbortController().signal,
      vi.fn(),
    );
    await vi.waitFor(() => expect(installed.bridge.postMessage).toHaveBeenCalledTimes(1));
    const cancelId = JSON.parse(installed.bridge.postMessage.mock.calls[0][0] as string)
      .requestId as string;
    installed.deliver({ type: "cancelled", requestId: cancelId });
    await expect(cancelled).resolves.toBe("External player request canceled.");

    const failed = openAndroidServerExternalPlayer(
      target,
      () => true,
      new AbortController().signal,
      vi.fn(),
    );
    await vi.waitFor(() => expect(installed.bridge.postMessage).toHaveBeenCalledTimes(2));
    const errorId = JSON.parse(installed.bridge.postMessage.mock.calls.at(-1)![0] as string)
      .requestId as string;
    installed.deliver({
      type: "error",
      requestId: errorId,
      detail: "private-capability-marker",
    });
    await expect(failed).rejects.toThrow("Android player chooser could not be opened");
  });
});
