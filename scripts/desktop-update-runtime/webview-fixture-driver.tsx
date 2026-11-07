import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getVersion } from "@tauri-apps/api/app";
import { VideoPlayer } from "../../web/src/components/VideoPlayer";
import { UpdateBanner } from "../../web/src/components/UpdateBanner";
import { getPlayerMounted, getUpdateInstallationActive } from "../../web/src/lib/attention";
import { checkForUpdates, UpdateDeferredError } from "../../web/src/lib/updater";
import runtimeConfig from "./runtime-config.json";

export const READER_TYPE = "wkwebview-html5";
const PLAYBACK_TIMEOUT_MS = 25_000;
const EVENT_TIMEOUT_MS = 5_000;
const INSTALL_TIMEOUT_MS = 180_000;
interface RuntimeConfig { baseUrl: string; baseVersion: string; nextVersion: string; runId: string }

export function validateWebviewConfig(value: unknown): RuntimeConfig {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid runtime configuration.");
  const config = value as Record<string, unknown>;
  if (Object.keys(config).sort().join(",") !== "baseUrl,baseVersion,nextVersion,runId") throw new Error("Unexpected runtime configuration fields.");
  if (typeof config.baseUrl !== "string") throw new Error("Missing fixture URL.");
  const url = new URL(config.baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || !url.port || url.pathname !== "/" || url.search || url.hash) throw new Error("Expected a plain loopback origin.");
  const semver = /^(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})$/;
  if (typeof config.baseVersion !== "string" || typeof config.nextVersion !== "string" || !semver.test(config.baseVersion) || !semver.test(config.nextVersion)) throw new Error("Invalid native versions.");
  const before = config.baseVersion.split(".").map(Number), after = config.nextVersion.split(".").map(Number);
  const different = before.findIndex((part, index) => part !== after[index]);
  if (different < 0 || after[different]! <= before[different]!) throw new Error("Expected a newer native version.");
  if (typeof config.runId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(config.runId)) throw new Error("Invalid runtime correlation identifier.");
  return { baseUrl: url.origin, baseVersion: config.baseVersion, nextVersion: config.nextVersion, runId: config.runId };
}
export function sanitizeWebviewFailure(value: unknown): string {
  const text = value instanceof Error ? value.message : "Unknown runtime failure.";
  return text.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]").replace(/https?:\/\/[^\s]+/gi, "[url]")
    .replace(/(?:\/(?:Users|home|Volumes|private|tmp)\/|[A-Za-z]:\\)[^\s]+/g, "[path]")
    .replace(/(?:token|password|secret|signature|key)\s*[:=]\s*\S+/gi, "[redacted]").replace(/[^\x20-\x7e]/g, " ").slice(0, 180);
}
export function mediaSnapshot(video: HTMLVideoElement | null) {
  const finite = (value: number | undefined) => value != null && Number.isFinite(value) ? value : null;
  return { position: finite(video?.currentTime), duration: finite(video?.duration), width: finite(video?.videoWidth),
    paused: video?.paused ?? null, seeking: video?.seeking ?? null, muted: video?.muted ?? null,
    connected: video?.isConnected ?? false, readyState: video?.readyState ?? null, networkState: video?.networkState ?? null, errorCode: video?.error?.code ?? null };
}
const sleep = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
async function waitFor(stage: string, predicate: () => boolean, timeoutMs = PLAYBACK_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return; await sleep(50); }
  throw new Error(`${stage} timed out waiting for actual WKWebView state.`);
}
function playerButton(label: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`.player [aria-label="${label}"]`);
  if (button == null || button.disabled) throw new Error(`Actual player control unavailable: ${label}.`);
  return button;
}

async function runWebviewFixture(config: RuntimeConfig, close: () => void, status: (value: string) => void) {
  let version = "unknown", stage = "native-version", eventCount = 0;
  let video: HTMLVideoElement | null = null;
  const emit = async (name: string, detail?: Record<string, unknown>) => {
    stage = name; status(name);
    if (++eventCount > 24) throw new Error("Runtime event budget exceeded.");
    const controller = new AbortController(), timer = window.setTimeout(() => controller.abort(), EVENT_TIMEOUT_MS);
    try {
      const response = await fetch(`${config.baseUrl}/events`, { method: "POST", credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: config.runId, readerType: READER_TYPE, stage: name, version, ...(detail == null ? {} : { detail }) }) });
      if (!response.ok) throw new Error(`Runtime observer rejected event (${response.status}).`);
    } finally { window.clearTimeout(timer); }
  };
  const wait = async (name: string, predicate: () => boolean) => { stage = name; status(name); await waitFor(name, predicate); };
  const closeReader = async () => {
    await emit("close-requested", { activity: getPlayerMounted() });
    playerButton("Close player").click();
    await wait("actual-react-reader-close", () => video != null && !video.isConnected && !getPlayerMounted() && video.paused);
    const stoppedAt = video!.currentTime;
    await sleep(300);
    if (Math.abs(video!.currentTime - stoppedAt) > 0.1) throw new Error("Detached HTML5 reader clock still advanced.");
    await emit("reader-unmounted", { actualReactClose: true, activity: getPlayerMounted(), mediaConnected: video!.isConnected, mediaPaused: video!.paused, clockStopped: true });
  };
  try {
    version = await getVersion();
    if (version !== config.baseVersion && version !== config.nextVersion) throw new Error("Unexpected native version.");
    await emit("boot", { nativeVersionVerified: true, reader: READER_TYPE });
    await wait("actual-html5-player-mount", () => { video = document.querySelector<HTMLVideoElement>("video.player-video"); return video != null; });
    await wait("actual-html5-playing-progress", () => video!.error != null || (video!.currentTime >= 0.75 && Number.isFinite(video!.duration) && video!.duration >= 8 && !video!.paused && video!.videoWidth > 0));
    if (video!.error != null) throw new Error(`HTML5 media failed with code ${video!.error.code}.`);
    if (!video!.muted || !getPlayerMounted()) throw new Error("Actual muted reader lacks playback ownership.");
    await emit("playing", { ...mediaSnapshot(video), activity: getPlayerMounted() });
    playerButton("Pause").click();
    await wait("actual-html5-pause", () => video!.paused);
    const pausedAt = video!.currentTime; await sleep(300);
    if (Math.abs(video!.currentTime - pausedAt) > 0.1) throw new Error("Paused HTML5 clock still advanced.");
    if (version === config.baseVersion) {
      // Banner owns the eventual manual installation. An independent real
      // PendingUpdate tests paused admission, then disposes its unused offer.
      stage = "paused-update-admission"; status(stage);
      const candidate = await checkForUpdates();
      if (candidate.status !== "available" || candidate.update.version !== config.nextVersion || candidate.update.currentVersion !== config.baseVersion) throw new Error("Expected exact next native update.");
      let deferred = false;
      try { await candidate.update.install(); }
      catch (error) { if (!(error instanceof UpdateDeferredError)) throw error; deferred = true; }
      finally { await candidate.update.close?.(); }
      if (!deferred || !video!.paused || !getPlayerMounted() || getUpdateInstallationActive()) throw new Error("Paused reader did not defer physical update admission.");
      await emit("paused-update-deferred", { paused: video!.paused, activity: getPlayerMounted(), deferredByProduction: true, automaticQueueTested: false });
      await wait("actual-banner-offer", () => document.querySelector<HTMLButtonElement>(".update-banner-install")?.textContent?.trim() === "Install");
      await closeReader();
      await emit("install-requested", { nextVersion: config.nextVersion, activity: getPlayerMounted(), actualBannerAction: true });
      const install = document.querySelector<HTMLButtonElement>(".update-banner-install");
      if (install == null || install.disabled || install.textContent?.trim() !== "Install") throw new Error("Actual Banner install control unavailable.");
      install.click();
      stage = "actual-banner-install-and-relaunch"; status(stage);
      await waitFor(stage, () => false, INSTALL_TIMEOUT_MS);
      throw new Error("The old process did not exit and relaunch.");
    }
    await emit("paused", { ...mediaSnapshot(video) });
    const seekFrom = video!.currentTime, target = seekFrom < 20 ? seekFrom + 10 : seekFrom - 10;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: seekFrom < 20 ? "l" : "j", bubbles: true }));
    await wait("actual-html5-seek", () => video!.paused && !video!.seeking && Math.abs(video!.currentTime - target) <= 0.35);
    await emit("seeked", { target, seekFrom, position: video!.currentTime, paused: video!.paused });
    const resumedFrom = video!.currentTime;
    playerButton("Play").click();
    await wait("actual-html5-resume", () => !video!.paused && video!.currentTime >= resumedFrom + 0.5);
    await emit("resumed", { position: video!.currentTime, resumedFrom });
    await closeReader();
    if (getUpdateInstallationActive()) throw new Error("New process retained old installation admission.");
    await emit("completed", { nativeVersionVerified: true, playPauseSeekResume: true, actualReactClose: true });
  } catch (error) {
    const message = `${stage}: ${sanitizeWebviewFailure(error)}`.slice(0, 240); status(`failed: ${message}`);
    try { await emit("failed", { message, media: mediaSnapshot(video), activity: getPlayerMounted(), installation: getUpdateInstallationActive() }); } catch { /* Missing completion remains a host failure. */ }
    close();
  }
}

function FixtureApp() {
  const [config] = useState(() => validateWebviewConfig(runtimeConfig));
  const [reader, setReader] = useState(true), [status, setStatus] = useState("starting");
  useEffect(() => { void runWebviewFixture(config, () => setReader(false), setStatus); }, [config]);
  return <>
    <UpdateBanner autoCheck autoInstall={false} nativeCompatibilityFloor="2.3.6" />
    {reader && <VideoPlayer url={`${config.baseUrl}/fixture.mp4`} title="Actual WKWebView fixture" kind="webview" engine="webview-direct" useBuiltInPlayer={false}
      initialHandoffState={{ paused: false, muted: true, volume: 0, playbackRate: 1 }} onClose={() => setReader(false)} />}
    <main style={{ position: "fixed", left: 16, top: 16, zIndex: 1000, background: "#111", color: "white", padding: 12 }}>
      <h1>Disposable actual WKWebView updater lane</h1><p role="status" data-runtime-stage={status}>{status}</p>
      <p>Manual Banner install. No MPV, issued-native-command, automatic queue or physical output claim.</p>
    </main>
  </>;
}
document.body.style.margin = "0";
const root = document.getElementById("root") ?? document.body.appendChild(document.createElement("div"));
createRoot(root).render(<FixtureApp />);
