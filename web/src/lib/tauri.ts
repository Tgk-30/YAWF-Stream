// Thin bridge to the Tauri desktop shell.
//
// The app runs BOTH as a plain web app (in a browser, `npm run dev`) and inside
// the Tauri webview (the desktop build). This module detects which environment
// we're in and exposes the one native command the player needs:
// `open_in_external_player` (defined in src-tauri/src/lib.rs), used to hand an
// MKV/HEVC direct link to a native player (VLC/mpv/IINA) the webview can't decode.
//
// In a plain browser there is no Tauri runtime, so `isTauri()` is false and the
// player falls back to an "open externally" note instead of invoking.

import { assertNetworkAllowed, isRequestExempt } from "./networkPolicy";
import { deviceKind } from "./platform";

/** True when running inside the Tauri webview. Tauri v2 injects
 * `__TAURI_INTERNALS__` on the window; we also tolerate the older flag. */
/**
 * Tauri on a platform that actually registers the desktop-only commands.
 *
 * isTauri() is true on Android too, but lib.rs compiles player, keychain,
 * server_host and downloads out on mobile and the mobile capability does not
 * grant them, so calling one there fails with a bare "not allowed by ACL" that
 * the UI cannot explain. Gate every desktop-only command on this instead.
 */
export function isDesktopTauri(): boolean {
  if (!isTauri()) return false;
  const w = window as unknown as Record<string, unknown>;
  if (w.__YAWF_TAURI_MOBILE__ === true) return false;

  // The marker above is authoritative for current mobile packages. Keep the
  // user-agent fallback for already-installed mobile builds while using the
  // shared platform classifier as a positive desktop allowlist.
  const ua = navigator.userAgent.toLowerCase();
  if (/android|iphone|ipad|ipod|; wv\)/.test(ua)) return false;
  return ["mac", "windows", "linux", "desktop"].includes(deviceKind());
}

export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return "__TAURI_INTERNALS__" in w || "__TAURI__" in w;
}

/** Open a direct stream URL in a native external player via the Rust command.
 * Resolves to the command's status string. Throws if not running under Tauri
 * (callers should gate on `isDesktopTauri()` first) or if the command fails. */
export async function openInExternalPlayer(
  url: string,
  preferred?: string | null,
  streamAuthorization?: string | null,
): Promise<string> {
  if (/^https?:\/\//i.test(url) && !isRequestExempt(url)) {
    assertNetworkAllowed("streaming", "external player");
  }
  if (!isDesktopTauri()) {
    throw new Error("External-player handoff is available only in the desktop app.");
  }
  // Imported dynamically so the browser bundle never tries to resolve the Tauri
  // runtime at module-eval time (it's only present in the desktop webview).
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("open_in_external_player", {
    url,
    preferred: preferred != null && preferred.length > 0 ? preferred : null,
    streamAuthorization: streamAuthorization ?? null,
  });
}

/** Reveal a completed local download in Finder, Explorer, or the Linux file
 * manager. This is desktop-only, so browser callers safely no-op. */
export async function revealInFileManager(path: string): Promise<void> {
  if (!isDesktopTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("reveal_in_file_manager", { path });
}

export interface AppInstallInfo {
  os: "macos" | "windows" | "linux";
  format: "macos-app" | "windows" | "linux-appimage" | "linux-deb" | "unknown";
  appBundlePath: string | null;
  appimagePath: string | null;
}

/** Desktop-only install metadata for accurate uninstall instructions. */
export async function getAppInstallInfo(): Promise<AppInstallInfo> {
  if (!isTauri()) {
    throw new Error("Not running under Tauri - no desktop installation information is available.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AppInstallInfo>("app_install_info");
}

/** The external media players actually installed on this machine (from the Rust
 * detector). Empty outside Tauri. Drives the Settings picker so it only offers
 * real choices. */
export async function listExternalPlayers(): Promise<string[]> {
  if (!isDesktopTauri()) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string[]>("list_external_players");
  } catch {
    return [];
  }
}

export interface TunnelToolInfo {
  installed: boolean;
  version: string | null;
  detail: string | null;
}

export interface TunnelTools {
  cloudflared: TunnelToolInfo;
  tailscale: TunnelToolInfo;
}

function noTunnelTools(): TunnelTools {
  return {
    cloudflared: { installed: false, version: null, detail: null },
    tailscale: { installed: false, version: null, detail: null },
  };
}

/** Detect locally-installed Cloudflare Tunnel and Tailscale clients. This is
 * desktop-host-only: a browser cannot inspect the machine hosting the server. */
export async function detectTunnelTools(): Promise<TunnelTools> {
  if (!isDesktopTauri()) return noTunnelTools();
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<TunnelTools>("detect_tunnel_tools");
  } catch {
    return noTunnelTools();
  }
}

// DLNA casting bridge. The TV fetches the public debrid stream directly; the
// desktop app only discovers renderers and sends UPnP control messages.

export interface CastDevice {
  id: string;
  name: string;
  avControlUrl: string;
  renderingControlUrl: string | null;
  location: string;
}

export interface CastStatus {
  state: string;
  positionSecs: number;
  durationSecs: number;
}

export type CastAction = "play" | "pause" | "stop" | "seek";

function requireTauriCasting(): void {
  if (!isTauri()) {
    throw new Error("Not running under Tauri - no LAN casting available.");
  }
}

export async function castDiscover(timeoutMs = 2500): Promise<CastDevice[]> {
  requireTauriCasting();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CastDevice[]>("cast_discover", { timeoutMs });
}

export async function castLoad(
  device: CastDevice,
  url: string,
  title: string,
  subtitleUrl?: string | null,
): Promise<void> {
  requireTauriCasting();
  if (/^https?:\/\//i.test(url) && !isRequestExempt(url)) {
    assertNetworkAllowed("streaming", "DLNA cast");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("cast_load", {
    args: {
      device,
      url,
      title,
      subtitleUrl: subtitleUrl ?? null,
    },
  });
}

export async function castControl(
  device: CastDevice,
  action: CastAction,
  positionSecs?: number | null,
): Promise<void> {
  requireTauriCasting();
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("cast_control", {
    args: {
      device,
      action,
      positionSecs: positionSecs ?? null,
    },
  });
}

export async function castStatus(device: CastDevice): Promise<CastStatus> {
  requireTauriCasting();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CastStatus>("cast_status", { device });
}

export async function castSetVolume(
  device: CastDevice,
  level: number,
): Promise<void> {
  requireTauriCasting();
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("cast_set_volume", {
    args: { device, level: Math.max(0, Math.min(100, Math.round(level))) },
  });
}

/** Result of {@link playWithMpv}: whether mpv attempted in-window embedding and
 * a human-readable status. On macOS `embedded` being true does NOT guarantee the
 * video rendered inside the app window - mpv often falls back to its own window
 * (the `--wid` embedding caveat, documented in src-tauri/src/player.rs). */
export interface MpvPlayResult {
  embedded: boolean;
  status: string;
}

function requireDesktopTauri(feature: string): void {
  if (!isDesktopTauri()) {
    throw new Error(`${feature} is available only in the desktop app.`);
  }
}

/** Play a direct stream URL with the bundled mpv sidecar (Phase 3 P1).
 *
 * This is the primary lossless / non-Real-Debrid MKV path: mpv is shipped with
 * the app and fully controlled over IPC (pause/seek/position/stop), unlike the
 * raw VLC hand-off (which relies on a user-installed VLC). Throws if not under
 * Tauri or if the sidecar isn't bundled / fails to spawn - callers should fall
 * back to {@link openInExternalPlayer} (VLC) in that case. */
export async function playWithMpv(
  url: string,
  streamAuthorization?: string | null,
): Promise<MpvPlayResult> {
  if (/^https?:\/\//i.test(url) && !isRequestExempt(url)) {
    assertNetworkAllowed("streaming", "mpv");
  }
  if (!isDesktopTauri()) {
    throw new Error("Bundled mpv is available only in the desktop app.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<MpvPlayResult>("mpv_play", {
    url,
    streamAuthorization: streamAuthorization ?? null,
  });
}

/** Pause the bundled-mpv playback. */
export async function mpvPause(): Promise<void> {
  requireDesktopTauri("Bundled mpv");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("mpv_pause");
}

/** Resume the bundled-mpv playback. */
export async function mpvResume(): Promise<void> {
  requireDesktopTauri("Bundled mpv");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("mpv_resume");
}

/** Seek the bundled-mpv playback to an absolute position (seconds). */
export async function mpvSeek(seconds: number): Promise<void> {
  requireDesktopTauri("Bundled mpv");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("mpv_seek", { seconds });
}

/** Current bundled-mpv playback position in seconds (0 if not yet known). */
export async function mpvGetPosition(): Promise<number> {
  requireDesktopTauri("Bundled mpv");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("mpv_get_position");
}

/** Stop bundled-mpv playback and kill the process. */
export async function mpvStop(): Promise<void> {
  requireDesktopTauri("Bundled mpv");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("mpv_stop");
}

export interface DesktopServerStatus {
  available: boolean;
  running: boolean;
  url: string | null;
  urls: string[];
  lan_urls: string[];
  share_url: string | null;
  setup_url: string | null;
  setup_token: string | null;
  port: number;
  detail: string;
  server_entry: string | null;
  web_dist: string | null;
}

export async function desktopServerStatus(): Promise<DesktopServerStatus> {
  requireDesktopTauri("Desktop server supervision");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DesktopServerStatus>("desktop_server_status");
}

export async function startDesktopServer(): Promise<DesktopServerStatus> {
  requireDesktopTauri("Desktop server supervision");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DesktopServerStatus>("desktop_server_start");
}

export async function stopDesktopServer(): Promise<DesktopServerStatus> {
  requireDesktopTauri("Desktop server supervision");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DesktopServerStatus>("desktop_server_stop");
}

export async function openExternalURL(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

// Downloads native bridge. Keep this region separate from the existing player
// and desktop-server bindings because the downloads UI owns all orchestration.

interface DownloadStartArgs {
  jobId: string;
  url: string;
  headers?: Record<string, string>;
  destPath: string;
  resumeFromExisting?: boolean;
  reserveOutputCopy?: boolean;
}

interface TranscodeStartArgs {
  jobId: string;
  inputPath: string;
  outputPath: string;
  keepAudioLangs: string[];
  keepSubLangs: string[];
  profile: "remux" | "h265";
}

interface DownloadProgress {
  jobId: string;
  phase: "downloading" | "optimizing" | "completed" | "failed" | "canceled";
  bytesDone: number;
  bytesTotal: number | null;
  speedBps?: number;
  error?: string;
  outputPath?: string;
}

export async function downloadStart(args: DownloadStartArgs): Promise<void> {
  requireDesktopTauri("Downloads");
  if (/^https?:\/\//i.test(args.url) && !isRequestExempt(args.url)) {
    assertNetworkAllowed("streaming", "download");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("download_start", { args });
}

export async function downloadPause(jobId: string): Promise<void> {
  requireDesktopTauri("Downloads");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("download_pause", { jobId });
}

export async function downloadResume(jobId: string): Promise<void> {
  requireDesktopTauri("Downloads");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("download_resume", { jobId });
}

export async function downloadCancel(jobId: string): Promise<void> {
  requireDesktopTauri("Downloads");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("download_cancel", { jobId });
}

/** Idempotently abort any native download or transcode registered for this id. */
export async function downloadForceStop(jobId: string): Promise<void> {
  requireDesktopTauri("Downloads");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("download_force_stop", { jobId });
}

export async function transcodeStart(args: TranscodeStartArgs): Promise<void> {
  requireDesktopTauri("Downloads");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("transcode_start", { args });
}

export async function transcodeCancel(jobId: string): Promise<void> {
  requireDesktopTauri("Downloads");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("transcode_cancel", { jobId });
}

export async function downloadsFfmpegAvailable(): Promise<boolean> {
  requireDesktopTauri("Downloads");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("downloads_ffmpeg_available");
}

export async function downloadsDefaultDir(): Promise<string> {
  requireDesktopTauri("Downloads");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("downloads_default_dir");
}

export async function downloadsAvailableSpace(path: string): Promise<number> {
  requireDesktopTauri("Downloads");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("downloads_available_space", { path });
}

export async function downloadDeleteFile(path: string): Promise<void> {
  requireDesktopTauri("Downloads");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("download_delete_file", { path });
}

export async function listenDownloadProgress(
  listener: (progress: DownloadProgress) => void,
): Promise<() => void> {
  requireDesktopTauri("Downloads");
  const { listen } = await import("@tauri-apps/api/event");
  return listen<DownloadProgress>("download-progress", (event) => {
    listener(event.payload);
  });
}
