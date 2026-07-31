// Unit tests for the Tauri IPC bridge (src/lib/tauri.ts).
//
// The module runs in two worlds: a plain browser (no Tauri runtime, isTauri()
// false) and the desktop Tauri webview (isTauri() true, dynamic imports resolve
// to the real plugin runtime). The vitest env here is "node" (no window), so
// isTauri() is false by default; we flip it by stubbing `window` with the
// __TAURI_INTERNALS__ flag, and we mock the dynamically-imported Tauri modules.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the dynamically-imported Tauri runtime modules. Each exported fn from
// tauri.ts that hits a native command does `await import("@tauri-apps/api/core")`
// and calls invoke(); we capture those calls here.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const listenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

const openUrlMock = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrlMock(...args),
}));

import {
  isDesktopTauri,
  isTauri,
  listExternalPlayers,
  openInExternalPlayer,
  playWithMpv,
  mpvPause,
  mpvResume,
  mpvSeek,
  mpvGetPosition,
  mpvStop,
  desktopServerStatus,
  detectTunnelTools,
  startDesktopServer,
  stopDesktopServer,
  openExternalURL,
  getAppInstallInfo,
  revealInFileManager,
  downloadStart,
  transcodeStart,
  transcodeCancel,
  downloadsFfmpegAvailable,
  downloadsDefaultDir,
  downloadsAvailableSpace,
  downloadDeleteFile,
  downloadCancel,
  downloadPause,
  downloadResume,
  downloadForceStop,
  listenDownloadProgress,
  castDiscover,
  castLoad,
  castControl,
  castStatus,
  castSetVolume,
  type CastDevice,
  type DesktopServerStatus,
  type MpvPlayResult,
} from "./tauri";
import * as networkPolicy from "./networkPolicy";

/** Put a fake Tauri window in place so isTauri() returns true. */
function enterTauri(): void {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
}

function enterAndroidTauri(): void {
  enterTauri();
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36",
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  openUrlMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("isTauri", () => {
  it("is false in a node env with no window", () => {
    expect(isTauri()).toBe(false);
  });

  it("is false for a bare window without any Tauri flag", () => {
    vi.stubGlobal("window", {});
    expect(isTauri()).toBe(false);
  });

  it("is true when __TAURI_INTERNALS__ is injected (Tauri v2)", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    expect(isTauri()).toBe(true);
  });

  it("is true when the legacy __TAURI__ flag is present", () => {
    vi.stubGlobal("window", { __TAURI__: {} });
    expect(isTauri()).toBe(true);
  });
});

describe("isDesktopTauri", () => {
  it("is false in the Android Tauri webview", () => {
    enterAndroidTauri();
    expect(isDesktopTauri()).toBe(false);
  });

  it("is true in a desktop Tauri webview", () => {
    enterTauri();
    expect(isDesktopTauri()).toBe(true);
  });
});

describe("detectTunnelTools", () => {
  it("returns an absent-tools result in a browser without invoking Tauri", async () => {
    await expect(detectTunnelTools()).resolves.toEqual({
      cloudflared: { installed: false, version: null, detail: null },
      tailscale: { installed: false, version: null, detail: null },
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("invokes the native detector in Tauri", async () => {
    enterTauri();
    const tools = {
      cloudflared: { installed: true, version: "cloudflared 2026.1.0", detail: null },
      tailscale: { installed: true, version: "1.82.0", detail: "connected" },
    };
    invokeMock.mockResolvedValue(tools);

    await expect(detectTunnelTools()).resolves.toEqual(tools);
    expect(invokeMock).toHaveBeenCalledWith("detect_tunnel_tools");
  });

  it("falls back to no tunnel tools when detect fails", async () => {
    enterTauri();
    invokeMock.mockRejectedValue(new Error("rust bridge missing"));

    await expect(detectTunnelTools()).resolves.toEqual({
      cloudflared: { installed: false, version: null, detail: null },
      tailscale: { installed: false, version: null, detail: null },
    });
  });

  it("does not invoke the desktop detector on Android", async () => {
    enterAndroidTauri();
    await expect(detectTunnelTools()).resolves.toEqual({
      cloudflared: { installed: false, version: null, detail: null },
      tailscale: { installed: false, version: null, detail: null },
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("external players bridge", () => {
  it("returns an absent list outside Tauri", async () => {
    await expect(listExternalPlayers()).resolves.toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("falls back to no players when discovery fails", async () => {
    enterTauri();
    invokeMock.mockRejectedValue(new Error("rust bridge missing"));

    await expect(listExternalPlayers()).resolves.toEqual([]);
  });

  it("does not invoke desktop player discovery on Android", async () => {
    enterAndroidTauri();
    await expect(listExternalPlayers()).resolves.toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("getAppInstallInfo", () => {
  it("throws when not running under Tauri", async () => {
    await expect(getAppInstallInfo()).rejects.toThrow(
      /no desktop installation information is available\./,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("returns native installation details in Tauri", async () => {
    enterTauri();
    const info = {
      os: "linux" as const,
      format: "linux-deb" as const,
      appBundlePath: null,
      appimagePath: null,
    };
    invokeMock.mockResolvedValue(info);

    await expect(getAppInstallInfo()).resolves.toEqual(info);
    expect(invokeMock).toHaveBeenCalledWith("app_install_info");
  });

  it("keeps app_install_info available on Android", async () => {
    enterAndroidTauri();
    invokeMock.mockResolvedValue({
      os: "linux",
      format: "unknown",
      appBundlePath: null,
      appimagePath: null,
    });

    await getAppInstallInfo();
    expect(invokeMock).toHaveBeenCalledWith("app_install_info");
  });
});

describe("revealInFileManager", () => {
  it("does nothing outside Tauri", async () => {
    await revealInFileManager("/tmp/file");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("invokes reveal_in_file_manager when available", async () => {
    enterTauri();
    invokeMock.mockResolvedValue(undefined);

    await revealInFileManager("/tmp/file");
    expect(invokeMock).toHaveBeenCalledWith("reveal_in_file_manager", {
      path: "/tmp/file",
    });
  });

  it("does not invoke reveal_in_file_manager on Android", async () => {
    enterAndroidTauri();
    await revealInFileManager("/tmp/file");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("openInExternalPlayer", () => {
  it("throws when not running under Tauri (no invoke)", async () => {
    await expect(openInExternalPlayer("http://x/file.mkv")).rejects.toThrow(
      /only in the desktop app/,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not invoke the desktop command on Android", async () => {
    enterAndroidTauri();
    await expect(openInExternalPlayer("http://x/file.mkv")).rejects.toThrow(
      /only in the desktop app/,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("invokes open_in_external_player with the url and returns status", async () => {
    enterTauri();
    invokeMock.mockResolvedValue("opened");
    const status = await openInExternalPlayer("http://x/file.mkv");
    expect(status).toBe("opened");
    expect(invokeMock).toHaveBeenCalledWith("open_in_external_player", {
      url: "http://x/file.mkv",
      preferred: null,
      streamAuthorization: null,
    });
  });

  it("forwards a preferred player when given", async () => {
    enterTauri();
    invokeMock.mockResolvedValue("Opened in IINA");
    await openInExternalPlayer("http://x/file.mkv", "IINA");
    expect(invokeMock).toHaveBeenCalledWith("open_in_external_player", {
      url: "http://x/file.mkv",
      preferred: "IINA",
      streamAuthorization: null,
    });
  });

  it("passes playback authorization separately from the URL", async () => {
    enterTauri();
    invokeMock.mockResolvedValue("opened");
    const authorization = `Bearer ${"A".repeat(43)}`;
    await openInExternalPlayer("https://x/stream", "VLC", authorization);
    expect(invokeMock).toHaveBeenCalledWith("open_in_external_player", {
      url: "https://x/stream",
      preferred: "VLC",
      streamAuthorization: authorization,
    });
  });

  it("checks the network gate before opening remote links", async () => {
    const spy = vi.spyOn(networkPolicy, "assertNetworkAllowed");
    enterTauri();
    invokeMock.mockResolvedValue("opened");

    await expect(openInExternalPlayer("https://cdn.example/file.mkv")).resolves.toBe("opened");
    expect(spy).toHaveBeenCalledWith("streaming", "external player");
  });

  it("does not check the network gate for loopback links", async () => {
    const spy = vi.spyOn(networkPolicy, "assertNetworkAllowed");
    enterTauri();
    invokeMock.mockResolvedValue("opened");

    await expect(openInExternalPlayer("http://127.0.0.1:8787/file.mkv")).resolves.toBe("opened");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("playWithMpv", () => {
  it("throws when not running under Tauri", async () => {
    await expect(playWithMpv("http://x/file.mkv")).rejects.toThrow(
      /only in the desktop app/,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not invoke bundled mpv on Android", async () => {
    enterAndroidTauri();
    await expect(playWithMpv("http://x/file.mkv")).rejects.toThrow(
      /only in the desktop app/,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("invokes mpv_play and returns the MpvPlayResult", async () => {
    enterTauri();
    const result: MpvPlayResult = { embedded: true, status: "playing" };
    invokeMock.mockResolvedValue(result);
    await expect(playWithMpv("http://x/file.mkv")).resolves.toEqual(result);
    expect(invokeMock).toHaveBeenCalledWith("mpv_play", {
      url: "http://x/file.mkv",
      streamAuthorization: null,
    });
  });

  it("passes playback authorization separately from the URL", async () => {
    enterTauri();
    invokeMock.mockResolvedValue({ embedded: false, status: "playing" });
    const authorization = `Bearer ${"A".repeat(43)}`;
    await playWithMpv("https://x/stream", authorization);
    expect(invokeMock).toHaveBeenCalledWith("mpv_play", {
      url: "https://x/stream",
      streamAuthorization: authorization,
    });
  });

  it("checks the network gate before mpv playback", async () => {
    const spy = vi.spyOn(networkPolicy, "assertNetworkAllowed");
    enterTauri();
    invokeMock.mockResolvedValue({ embedded: true, status: "playing" });

    await playWithMpv("https://cdn.example/file.mkv");
    expect(spy).toHaveBeenCalledWith("streaming", "mpv");
  });
});

describe("mpv control commands", () => {
  beforeEach(() => {
    enterTauri();
  });

  it("mpvPause invokes mpv_pause", async () => {
    invokeMock.mockResolvedValue(undefined);
    await mpvPause();
    expect(invokeMock).toHaveBeenCalledWith("mpv_pause");
  });

  it("mpvResume invokes mpv_resume", async () => {
    invokeMock.mockResolvedValue(undefined);
    await mpvResume();
    expect(invokeMock).toHaveBeenCalledWith("mpv_resume");
  });

  it("mpvSeek invokes mpv_seek with the seconds payload", async () => {
    invokeMock.mockResolvedValue(undefined);
    await mpvSeek(42);
    expect(invokeMock).toHaveBeenCalledWith("mpv_seek", { seconds: 42 });
  });

  it("mpvGetPosition invokes mpv_get_position and returns the position", async () => {
    invokeMock.mockResolvedValue(12.5);
    await expect(mpvGetPosition()).resolves.toBe(12.5);
    expect(invokeMock).toHaveBeenCalledWith("mpv_get_position");
  });

  it("mpvStop invokes mpv_stop", async () => {
    invokeMock.mockResolvedValue(undefined);
    await mpvStop();
    expect(invokeMock).toHaveBeenCalledWith("mpv_stop");
  });

  it("does not invoke any bundled mpv control on Android", async () => {
    enterAndroidTauri();
    await expect(mpvPause()).rejects.toThrow(/only in the desktop app/);
    await expect(mpvResume()).rejects.toThrow(/only in the desktop app/);
    await expect(mpvSeek(42)).rejects.toThrow(/only in the desktop app/);
    await expect(mpvGetPosition()).rejects.toThrow(/only in the desktop app/);
    await expect(mpvStop()).rejects.toThrow(/only in the desktop app/);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("DLNA cast IPC bridge", () => {
  const device: CastDevice = {
    id: "uuid:tv-1",
    name: "Living Room TV",
    avControlUrl: "http://10.0.0.10/av",
    renderingControlUrl: "http://10.0.0.10/volume",
    location: "http://10.0.0.10/device.xml",
  };

  it("guards every cast command outside Tauri", async () => {
    await expect(castDiscover()).rejects.toThrow(/Not running under Tauri/);
    await expect(
      castLoad(device, "https://cdn.example/movie.mkv", "Movie"),
    ).rejects.toThrow(/Not running under Tauri/);
    await expect(castControl(device, "pause")).rejects.toThrow(
      /Not running under Tauri/,
    );
    await expect(castStatus(device)).rejects.toThrow(/Not running under Tauri/);
    await expect(castSetVolume(device, 50)).rejects.toThrow(
      /Not running under Tauri/,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("uses the typed native command payloads", async () => {
    enterTauri();
    invokeMock
      .mockResolvedValueOnce([device])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        state: "PLAYING",
        positionSecs: 12,
        durationSecs: 120,
      })
      .mockResolvedValueOnce(undefined);

    await expect(castDiscover(1800)).resolves.toEqual([device]);
    await castLoad(
      device,
      "https://cdn.example/movie.mkv",
      "Movie & More",
      "https://cdn.example/movie.srt",
    );
    await castControl(device, "seek", 42);
    await expect(castStatus(device)).resolves.toEqual({
      state: "PLAYING",
      positionSecs: 12,
      durationSecs: 120,
    });
    await castSetVolume(device, 101);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "cast_discover", {
      timeoutMs: 1800,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "cast_load", {
      args: {
        device,
        url: "https://cdn.example/movie.mkv",
        title: "Movie & More",
        subtitleUrl: "https://cdn.example/movie.srt",
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "cast_control", {
      args: { device, action: "seek", positionSecs: 42 },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "cast_status", { device });
    expect(invokeMock).toHaveBeenNthCalledWith(5, "cast_set_volume", {
      args: { device, level: 100 },
    });
  });

  it("passes a null subtitleUrl when one is not provided", async () => {
    enterTauri();
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValue(undefined);

    await castLoad(device, "https://cdn.example/movie.mkv", "No Subtitle");

    expect(invokeMock).toHaveBeenCalledWith("cast_load", {
      args: {
        device,
        url: "https://cdn.example/movie.mkv",
        title: "No Subtitle",
        subtitleUrl: null,
      },
    });
  });

  it("keeps all cast commands available on Android", async () => {
    enterAndroidTauri();
    invokeMock
      .mockResolvedValueOnce([device])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        state: "PLAYING",
        positionSecs: 12,
        durationSecs: 120,
      })
      .mockResolvedValueOnce(undefined);

    await castDiscover();
    await castLoad(device, "https://cdn.example/movie.mkv", "Movie");
    await castControl(device, "play");
    await castStatus(device);
    await castSetVolume(device, 50);
    expect(invokeMock).toHaveBeenCalledTimes(5);
  });
});

describe("download IPC bridge", () => {
  beforeEach(() => {
    enterTauri();
  });

  it("invokes start, cancel, and force-stop with the contract payloads", async () => {
    invokeMock.mockResolvedValue(undefined);
    await downloadStart({
      jobId: "job-1",
      url: "https://cdn.example/file",
      destPath: "/Downloads/file.mkv",
    });
    await downloadCancel("job-1");
    await downloadForceStop("job-1");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "download_start", {
      args: {
        jobId: "job-1",
        url: "https://cdn.example/file",
        destPath: "/Downloads/file.mkv",
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "download_cancel", { jobId: "job-1" });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "download_force_stop", { jobId: "job-1" });
  });

  it("starts and cancels transcodes with the contract payloads", async () => {
    invokeMock.mockResolvedValue(undefined);
    await transcodeStart({
      jobId: "job-transcode",
      inputPath: "/tmp/input.mkv",
      outputPath: "/tmp/output.mkv",
      keepAudioLangs: ["eng", "spa"],
      keepSubLangs: ["eng"],
      profile: "h265",
    });
    await transcodeCancel("job-transcode");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "transcode_start", {
      args: {
        jobId: "job-transcode",
        inputPath: "/tmp/input.mkv",
        outputPath: "/tmp/output.mkv",
        keepAudioLangs: ["eng", "spa"],
        keepSubLangs: ["eng"],
        profile: "h265",
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "transcode_cancel", { jobId: "job-transcode" });
  });

  it("invokes pause and resume commands", async () => {
    invokeMock.mockResolvedValue(undefined);
    await downloadPause("job-1");
    await downloadResume("job-1");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "download_pause", { jobId: "job-1" });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "download_resume", { jobId: "job-1" });
  });

  it("queries ffmpeg availability and default directory", async () => {
    invokeMock.mockResolvedValueOnce(true).mockResolvedValueOnce("/Downloads");

    await expect(downloadsFfmpegAvailable()).resolves.toBe(true);
    await expect(downloadsDefaultDir()).resolves.toBe("/Downloads");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "downloads_ffmpeg_available");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "downloads_default_dir");
  });

  it("forwards download-progress payloads and returns the native unlisten function", async () => {
    const unlisten = vi.fn();
    let nativeListener!: (event: { payload: unknown }) => void;
    listenMock.mockImplementation(async (_eventName: string, listener: typeof nativeListener) => {
      nativeListener = listener;
      return unlisten;
    });
    const listener = vi.fn();
    await expect(listenDownloadProgress(listener)).resolves.toBe(unlisten);
    expect(listenMock).toHaveBeenCalledWith("download-progress", expect.any(Function));

    const payload = {
      jobId: "job-1",
      phase: "downloading" as const,
      bytesDone: 1_048_576,
      bytesTotal: 2_097_152,
      speedBps: 1_048_576,
    };
    nativeListener({ payload });
    expect(listener).toHaveBeenCalledWith(payload);
  });

  it("checks the streaming gate for remote downloads", async () => {
    const spy = vi.spyOn(networkPolicy, "assertNetworkAllowed");
    invokeMock.mockResolvedValue(undefined);

    await downloadStart({
      jobId: "job-remote",
      url: "https://cdn.example/file.mkv",
      destPath: "/Downloads/file.mkv",
    });

    expect(spy).toHaveBeenCalledWith("streaming", "download");
  });

  it("does not check the streaming gate for loopback downloads", async () => {
    const spy = vi.spyOn(networkPolicy, "assertNetworkAllowed");
    invokeMock.mockResolvedValue(undefined);

    await downloadStart({
      jobId: "job-loopback",
      url: "http://127.0.0.1:8787/file.mkv",
      destPath: "/Downloads/file.mkv",
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it("does not invoke any download or transcode bridge on Android", async () => {
    enterAndroidTauri();
    const startArgs = {
      jobId: "job-android",
      url: "https://cdn.example/file",
      destPath: "/Downloads/file.mkv",
    };
    const transcodeArgs = {
      jobId: "job-android",
      inputPath: "/tmp/input.mkv",
      outputPath: "/tmp/output.mkv",
      keepAudioLangs: ["eng"],
      keepSubLangs: ["eng"],
      profile: "remux" as const,
    };

    await expect(downloadStart(startArgs)).rejects.toThrow(/only in the desktop app/);
    await expect(downloadPause("job-android")).rejects.toThrow(/only in the desktop app/);
    await expect(downloadResume("job-android")).rejects.toThrow(/only in the desktop app/);
    await expect(downloadCancel("job-android")).rejects.toThrow(/only in the desktop app/);
    await expect(downloadForceStop("job-android")).rejects.toThrow(/only in the desktop app/);
    await expect(transcodeStart(transcodeArgs)).rejects.toThrow(/only in the desktop app/);
    await expect(transcodeCancel("job-android")).rejects.toThrow(/only in the desktop app/);
    await expect(downloadsFfmpegAvailable()).rejects.toThrow(/only in the desktop app/);
    await expect(downloadsDefaultDir()).rejects.toThrow(/only in the desktop app/);
    await expect(downloadsAvailableSpace("/Downloads")).rejects.toThrow(
      /only in the desktop app/,
    );
    await expect(downloadDeleteFile("/Downloads/file.mkv")).rejects.toThrow(
      /only in the desktop app/,
    );
    await expect(listenDownloadProgress(() => {})).rejects.toThrow(
      /only in the desktop app/,
    );
    expect(invokeMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
  });
});

describe("desktop server supervisor commands", () => {
  const status: DesktopServerStatus = {
    available: true,
    running: true,
    url: "http://127.0.0.1:8787",
    urls: ["http://127.0.0.1:8787"],
    lan_urls: [],
    share_url: null,
    setup_url: null,
    setup_token: null,
    port: 8787,
    detail: "running",
    server_entry: null,
    web_dist: null,
  };

  it("desktopServerStatus throws when not under Tauri", async () => {
    await expect(desktopServerStatus()).rejects.toThrow(/only in the desktop app/);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("desktopServerStatus invokes desktop_server_status and returns it", async () => {
    enterTauri();
    invokeMock.mockResolvedValue(status);
    await expect(desktopServerStatus()).resolves.toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("desktop_server_status");
  });

  it("startDesktopServer throws when not under Tauri", async () => {
    await expect(startDesktopServer()).rejects.toThrow(/only in the desktop app/);
  });

  it("startDesktopServer invokes desktop_server_start", async () => {
    enterTauri();
    invokeMock.mockResolvedValue(status);
    await expect(startDesktopServer()).resolves.toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("desktop_server_start");
  });

  it("stopDesktopServer throws when not under Tauri", async () => {
    await expect(stopDesktopServer()).rejects.toThrow(/only in the desktop app/);
  });

  it("stopDesktopServer invokes desktop_server_stop", async () => {
    enterTauri();
    invokeMock.mockResolvedValue(status);
    await expect(stopDesktopServer()).resolves.toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("desktop_server_stop");
  });

  it("does not invoke desktop server supervision on Android", async () => {
    enterAndroidTauri();
    await expect(desktopServerStatus()).rejects.toThrow(/only in the desktop app/);
    await expect(startDesktopServer()).rejects.toThrow(/only in the desktop app/);
    await expect(stopDesktopServer()).rejects.toThrow(/only in the desktop app/);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("openExternalURL", () => {
  it("uses the Tauri opener plugin when under Tauri", async () => {
    enterTauri();
    openUrlMock.mockResolvedValue(undefined);
    await openExternalURL("https://example.com");
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com");
  });

  it("falls back to window.open in a plain browser", async () => {
    const windowOpen = vi.fn();
    vi.stubGlobal("window", { open: windowOpen });
    await openExternalURL("https://example.com");
    expect(windowOpen).toHaveBeenCalledWith(
      "https://example.com",
      "_blank",
      "noopener,noreferrer",
    );
    expect(openUrlMock).not.toHaveBeenCalled();
  });

  it("keeps the opener plugin available on Android", async () => {
    enterAndroidTauri();
    openUrlMock.mockResolvedValue(undefined);
    await openExternalURL("https://example.com");
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com");
  });
});
