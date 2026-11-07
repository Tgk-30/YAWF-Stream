import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getVersion } from "@tauri-apps/api/app";
import { getPlayerMounted, getUpdateInstallationActive } from "../../web/src/lib/attention";
import { createRenderPlayerSession, type MpvObservableProperty } from "../../web/src/lib/renderPlayer";
import { checkForUpdates, UpdateDeferredError, type PendingUpdate } from "../../web/src/lib/updater";
import runtimeConfig from "./runtime-config.json";

export interface RuntimeConfig { baseUrl: string; baseVersion: string; nextVersion: string; runId: string }
export const BASE_STAGES = ["boot", "playing", "paused-update-deferred", "destroy-requested", "destroy-update-deferred", "destroy-acknowledged", "install-requested"] as const;
const NATIVE_TIMEOUT_MS = 25_000;
const EVENT_TIMEOUT_MS = 5_000;
const INSTALL_TIMEOUT_MS = 180_000;
const DIAGNOSTIC_TIMEOUT_MS = 2_000;

export function validateRuntimeConfig(value: unknown): RuntimeConfig {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid runtime configuration.");
  const config = value as Record<string, unknown>;
  if (Object.keys(config).sort().join(",") !== "baseUrl,baseVersion,nextVersion,runId") throw new Error("Unexpected runtime configuration fields.");
  if (typeof config.baseUrl !== "string") throw new Error("Missing fixture URL.");
  const url = new URL(config.baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || !url.port || url.pathname !== "/" || url.search || url.hash) throw new Error("Fixture URL must be a plain loopback HTTP origin.");
  const semver = /^(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})$/;
  if (typeof config.baseVersion !== "string" || typeof config.nextVersion !== "string" || !semver.test(config.baseVersion) || !semver.test(config.nextVersion) || config.baseVersion === config.nextVersion) throw new Error("Invalid distinct native versions.");
  const before = config.baseVersion.split(".").map(Number), after = config.nextVersion.split(".").map(Number);
  const different = before.findIndex((part, index) => part !== after[index]);
  if (different < 0 || after[different]! <= before[different]!) throw new Error("The next native version must be newer.");
  if (typeof config.runId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(config.runId)) throw new Error("Invalid runtime correlation identifier.");
  return { baseUrl: url.origin, baseVersion: config.baseVersion, nextVersion: config.nextVersion, runId: config.runId };
}
export function sanitizeFailure(value: unknown): string {
  const text = value instanceof Error ? value.message : "Unknown runtime failure.";
  return text.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]").replace(/https?:\/\/[^\s]+/gi, "[url]")
    .replace(/(?:\/(?:Users|home|Volumes|private|tmp)\/|[A-Za-z]:\\)[^\s]+/g, "[path]")
    .replace(/(?:token|password|secret|signature|key)\s*[:=]\s*\S+/gi, "[redacted]").replace(/[^\x20-\x7e]/g, " ").slice(0, 180);
}
export function bounded<T>(operation: Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${stage} timed out.`)), timeoutMs);
    void operation.then((value) => { window.clearTimeout(timer); resolve(value); }, (error: unknown) => { window.clearTimeout(timer); reject(error); });
  });
}
interface NativeClock { position: number | null; duration: number | null; paused: boolean | null; seeking: boolean | null; width: number | null }
export function observedClock() {
  const state: NativeClock = { position: null, duration: null, paused: null, seeking: null, width: null };
  const listeners = new Set<() => void>();
  const allowedNames = new Set(["time-pos", "duration", "pause", "seeking", "video-params/w", "dwidth", "end-file"]);
  let eventCount = 0;
  const propertyEventCounts: Record<string, number> = {};
  const recentEvents: string[] = [];
  const recentErrors: Array<{ name: "end-file"; error: boolean; code: number | null }> = [];
  return {
    state,
    snapshot() {
      return { ...state, eventCount, propertyEventCounts: { ...propertyEventCounts }, recentEvents: [...recentEvents], recentErrors: recentErrors.map((error) => ({ ...error })) };
    },
    event(event: { name: string; data: unknown }) {
      // Native values can contain source/device strings. Retain only fixed
      // property names, finite clock values and the bridge's numeric end code.
      const name = allowedNames.has(event.name) ? event.name : "other";
      eventCount += 1;
      propertyEventCounts[name] = (propertyEventCounts[name] ?? 0) + 1;
      recentEvents.push(name); if (recentEvents.length > 12) recentEvents.shift();
      if (name === "end-file" && event.data != null && typeof event.data === "object") {
        const data = event.data as Record<string, unknown>;
        recentErrors.push({ name, error: data.error === true, code: typeof data.code === "number" && Number.isSafeInteger(data.code) ? data.code : null });
        if (recentErrors.length > 4) recentErrors.shift();
      }
      if (event.name === "time-pos" && typeof event.data === "number" && Number.isFinite(event.data)) state.position = event.data;
      if (event.name === "duration" && typeof event.data === "number" && Number.isFinite(event.data)) state.duration = event.data;
      if (event.name === "pause" && typeof event.data === "boolean") state.paused = event.data;
      if (event.name === "seeking" && typeof event.data === "boolean") state.seeking = event.data;
      if ((event.name === "video-params/w" || event.name === "dwidth") && typeof event.data === "number" && Number.isFinite(event.data)) state.width = event.data;
      listeners.forEach((listener) => listener());
    },
    wait(predicate: (snapshot: NativeClock) => boolean, stage: string) {
      return new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => { listeners.delete(check); reject(new Error(`${stage} timed out waiting for actual native events.`)); }, NATIVE_TIMEOUT_MS);
        const check = () => { if (!predicate(state)) return; window.clearTimeout(timer); listeners.delete(check); resolve(); };
        listeners.add(check); check();
      });
    },
  };
}
export function summarizeAudioDevices(value: unknown) {
  if (!Array.isArray(value)) return { status: "unexpected-shape" as const };
  let automaticDevicePresent = false, coreAudioDeviceCount = 0;
  for (const device of value) {
    if (device == null || typeof device !== "object") continue;
    const name = (device as Record<string, unknown>).name;
    if (name === "auto") automaticDevicePresent = true;
    if (typeof name === "string" && name.startsWith("coreaudio/")) coreAudioDeviceCount += 1;
  }
  // Device names/descriptions can contain personal identifiers. Counts are
  // diagnostic only: never select a device or alter the fixture's audio path.
  return { status: "observed" as const, deviceCount: value.length, automaticDevicePresent, coreAudioDeviceCount };
}
const OBSERVED: readonly MpvObservableProperty[] = [["time-pos", "double", "none"], ["duration", "double", "none"], ["pause", "flag"], ["seeking", "flag"], ["video-params/w", "int64", "none"], ["dwidth", "int64", "none"]];

async function runFixture(config: RuntimeConfig, status: (value: string) => void) {
  let version = "unknown", stage = "native-version", eventCount = 0;
  const session = createRenderPlayerSession(), clock = observedClock();
  let unlisten: (() => void) | undefined, destroyed = false;
  const step = async <T,>(name: string, operation: () => Promise<T>, timeoutMs = NATIVE_TIMEOUT_MS) => {
    stage = name; status(name); return bounded(operation(), timeoutMs, name);
  };
  const emit = async (name: string, detail?: Record<string, unknown>) => {
    if (++eventCount > 32) throw new Error("Runtime event budget exceeded.");
    const controller = new AbortController(), timer = window.setTimeout(() => controller.abort(), EVENT_TIMEOUT_MS);
    try {
      const response = await fetch(`${config.baseUrl}/events`, { method: "POST", credentials: "omit", cache: "no-store", redirect: "error", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ runId: config.runId, stage: name, version, ...(detail == null ? {} : { detail }) }) });
      if (!response.ok) throw new Error(`Runtime observer rejected event (${response.status}).`);
    } finally { window.clearTimeout(timer); }
  };
  const closeReader = async () => {
    await step("native-destroy", () => session.destroy()); destroyed = true; unlisten?.(); unlisten = undefined;
    if (getPlayerMounted()) throw new Error("Native activity remained after acknowledged destroy.");
  };
  const requireDeferred = async (candidate: PendingUpdate, name: string) => {
    try { await bounded(candidate.install(), NATIVE_TIMEOUT_MS, name); }
    catch (error) { if (error instanceof UpdateDeferredError) return; throw error; }
    throw new Error(`${name} was not deferred by production updater admission.`);
  };
  try {
    version = await step("native-version", getVersion);
    if (version !== config.baseVersion && version !== config.nextVersion) throw new Error("Unexpected native application version.");
    await emit("boot", { nativeVersionVerified: true, reader: "actual-render-session" });
    await step("native-init-and-load", () => session.init({ initialOptions: { "keep-open": "yes", terminal: "no" }, observedProperties: OBSERVED }, async () => {
      unlisten = await session.observeProperties(OBSERVED, clock.event);
      await session.setProperty("mute", true);
      await session.setProperty("pause", true);
      await session.command("loadfile", [`${config.baseUrl}/fixture.mp4`]);
      await session.setProperty("pause", false);
    }));
    await step("actual-playing-progress", () => clock.wait((value) => value.position != null && value.position >= 0.75 && value.duration != null && value.paused === false && (value.width ?? 0) > 0, "native-playing"));
    if ((clock.state.duration ?? 0) < 8) throw new Error("The media fixture must be at least eight seconds long.");
    if (!getPlayerMounted()) throw new Error("Actual native reader work was not registered.");
    await emit("playing", { position: clock.state.position, duration: clock.state.duration, width: clock.state.width, activity: getPlayerMounted() });
    await step("native-pause-command", () => session.setProperty("pause", true));
    await step("native-pause-observation", () => clock.wait((value) => value.paused === true, "native-pause"));
    if (!getPlayerMounted()) throw new Error("A paused native reader lost activity ownership.");
    if (version === config.baseVersion) {
      const result = await step("signed-native-feed-check", () => checkForUpdates());
      if (result.status !== "available" || result.update.version !== config.nextVersion || result.update.currentVersion !== config.baseVersion) throw new Error("Expected exact next-version signed native candidate.");
      const candidate = result.update;
      await step("paused-update-admission", () => requireDeferred(candidate, "paused-update-admission"));
      await emit("paused-update-deferred", { paused: clock.state.paused, activity: getPlayerMounted(), deferredByProduction: true, payloadCheck: "host-observed" });
      // Actual production promises, issued in one JavaScript turn. No awaited
      // POST or synthetic delay may separate destruction and update admission.
      stage = "destroy-with-issued-command"; status(stage);
      let commandAcknowledged = false, destroyAcknowledged = false;
      const command = bounded(session.setProperty("pause", true).then(() => { commandAcknowledged = true; }), NATIVE_TIMEOUT_MS, "issued-native-command");
      void command.catch(() => {});
      const destruction = bounded(session.destroy().then(() => { destroyAcknowledged = true; }), NATIVE_TIMEOUT_MS, "native-destroy-acknowledgement");
      void destruction.catch(() => {});
      const atRequest = { commandAcknowledgedAtRequest: commandAcknowledged, destroyAcknowledgedAtRequest: destroyAcknowledged, activityAtRequest: getPlayerMounted() };
      const deferredUpdate = requireDeferred(candidate, "destroy-update-admission");
      void deferredUpdate.catch(() => {});
      await emit("destroy-requested", atRequest);
      await deferredUpdate;
      await emit("destroy-update-deferred", { deferredByProduction: true, payloadCheck: "host-observed" });
      await command; await destruction;
      destroyed = true; unlisten?.(); unlisten = undefined;
      if (!destroyAcknowledged || getPlayerMounted()) throw new Error("Native teardown did not acknowledge and release activity.");
      await emit("destroy-acknowledged", { actualNativePromise: true, activity: getPlayerMounted() });
      stage = "actual-native-install-and-relaunch"; status(stage);
      await emit("install-requested", { nextVersion: config.nextVersion, activity: getPlayerMounted() });
      await bounded(candidate.install(), INSTALL_TIMEOUT_MS, stage);
      // A returned IPC promise is not evidence of a process restart. Only the
      // next real native boot, verified by the host, may report completed.
      await bounded(new Promise<void>(() => {}), 15_000, "await-real-process-relaunch");
      throw new Error("The old native process did not exit.");
    }
    await emit("paused", { paused: clock.state.paused, position: clock.state.position });
    const seekFrom = clock.state.position!;
    const target = seekFrom < 3 ? 5 : 1;
    await step("native-seek-command", () => session.command("seek", [target, "absolute"]));
    await step("native-seek-observation", () => clock.wait((value) => value.paused === true && value.position != null && Math.abs(value.position - target) <= 0.35 && value.seeking !== true, "native-seek"));
    await emit("seeked", { target, seekFrom, position: clock.state.position, paused: clock.state.paused });
    const resumedFrom = clock.state.position!;
    await step("native-resume-command", () => session.setProperty("pause", false));
    await step("native-resume-observation", () => clock.wait((value) => value.paused === false && value.position != null && value.position >= resumedFrom + 0.5, "native-resume"));
    await emit("resumed", { position: clock.state.position, resumedFrom });
    await emit("destroy-requested", { activity: getPlayerMounted() });
    await closeReader();
    await emit("destroy-acknowledged", { actualNativePromise: true, activity: getPlayerMounted() });
    if (getUpdateInstallationActive()) throw new Error("The next process unexpectedly retained old installation admission.");
    await emit("completed", { nativeVersionVerified: true, playPauseSeekResume: true, actualDestroyAcknowledged: true });
    status("completed");
  } catch (error) {
    const message = `${stage}: ${sanitizeFailure(error)}`.slice(0, 240); status(`failed: ${message}`);
    const diagnostic = { nativeClock: clock.snapshot(), activity: getPlayerMounted(), installation: getUpdateInstallationActive() };
    let audioDevices: ReturnType<typeof summarizeAudioDevices> | { status: "unavailable"; message: string } = { status: "unavailable", message: "Native reader already destroyed." };
    if (!destroyed) {
      try { audioDevices = summarizeAudioDevices(await bounded(session.getProperty("audio-device-list"), DIAGNOSTIC_TIMEOUT_MS, "diagnostic-audio-devices")); }
      catch (diagnosticError) { audioDevices = { status: "unavailable", message: sanitizeFailure(diagnosticError) }; }
    }
    try { await emit("failed", { message, diagnostic: { ...diagnostic, audioDevices } }); } catch { /* The host independently rejects missing/invalid completion. */ }
    if (!destroyed) {
      try { await bounded(session.destroy(), NATIVE_TIMEOUT_MS, "failed-run-native-cleanup"); unlisten?.(); } catch { /* Unknown lifetime is never reported as acknowledged. */ }
    }
  }
}
function FixtureApp() {
  const [status, setStatus] = useState("starting");
  useEffect(() => {
    let mounted = true;
    try { const config = validateRuntimeConfig(runtimeConfig); void runFixture(config, (value) => { if (mounted) setStatus(value); }); }
    catch (error) { setStatus(`failed: configuration: ${sanitizeFailure(error)}`); }
    return () => { mounted = false; };
  }, []);
  return <main style={{ position: "fixed", inset: "16px auto auto 16px", maxWidth: 720, padding: 16, background: "rgba(0,0,0,.78)", color: "white", font: "16px system-ui", borderRadius: 8 }}>
    <h1 style={{ margin: "0 0 8px", fontSize: 20 }}>Disposable desktop updater runtime</h1>
    <p role="status" aria-live="polite" data-runtime-stage={status}>{status}</p>
    <p style={{ fontSize: 12 }}>Actual native rendering and signed updater calls. Host process, bytes and HTTP observations remain separate evidence.</p>
  </main>;
}
document.documentElement.style.background = "transparent";
document.body.style.background = "transparent";
document.body.style.margin = "0";
const root = document.getElementById("root") ?? document.body.appendChild(document.createElement("div"));
createRoot(root).render(<FixtureApp />);
