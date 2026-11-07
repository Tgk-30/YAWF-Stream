// @vitest-environment jsdom
// Real Banner -> PendingUpdate -> attention -> VideoPlayer integration. Only
// native plugin APIs and browser media/HTTP boundaries are synthetic here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Suspense } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { UpdateBanner } from "./UpdateBanner";
import { VideoPlayer } from "./VideoPlayer";
import { getPlayerMounted, getUpdateInstallationActive } from "../lib/attention";

const native = vi.hoisted(() => ({
  check: vi.fn(),
  getVersion: vi.fn(),
  invoke: vi.fn(),
  relaunch: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: native.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: native.relaunch }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: native.getVersion }));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: native.invoke,
}));

function deferred<T>() {
  let settled = false;
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Cleanup may reject a native promise before the API has consumed it.
  void promise.catch(() => {});
  return {
    promise,
    resolve: (value: T) => { if (!settled) { settled = true; resolve(value); } },
    reject: (error: Error) => { if (!settled) { settled = true; reject(error); } },
  };
}

type MediaState = { paused: boolean; readyState: number };
let media = new WeakMap<HTMLMediaElement, MediaState>();
let createdVideos: HTMLVideoElement[] = [];
function mediaState(element: HTMLMediaElement): MediaState {
  let state = media.get(element);
  if (state == null) { state = { paused: true, readyState: 0 }; media.set(element, state); }
  return state;
}

function Suspender({ hidden, pending }: { hidden: boolean; pending: Promise<void> }) {
  if (hidden) throw pending;
  return null;
}

type Reader = { id: string; title: string; native?: boolean };
function Fixture({ readers, hidden, pending, automatic, onClose }: {
  readers: Reader[]; hidden: boolean; pending: Promise<void>; automatic: boolean;
  onClose: (id: string) => void;
}) {
  return <>
    <UpdateBanner autoCheck autoInstall={automatic} nativeCompatibilityFloor="2.3.6" />
    <Suspense fallback={<div>Connected reader temporarily hidden</div>}>
      {readers.map((reader) => <VideoPlayer key={reader.id}
        url={`https://media.example/${reader.id}.mp4`} title={reader.title}
        kind="webview" engine={reader.native ? "native-mpv" : "webview-direct"} useBuiltInPlayer={false}
        onClose={() => onClose(reader.id)} />)}
      <Suspender hidden={hidden} pending={pending} />
    </Suspense>
  </>;
}

function scenario(initial: Reader[] = []) {
  const download = deferred<void>();
  const installation = deferred<void>();
  const suspension = deferred<void>();
  const update = {
    version: "9.9.9", currentVersion: "2.3.75", body: "Integration fixture update",
    download: vi.fn(async (progress: (event: {
      event: "Started" | "Progress" | "Finished";
      data: { contentLength?: number; chunkLength?: number };
    }) => void) => {
      progress({ event: "Started", data: { contentLength: 100 } });
      await download.promise;
      progress({ event: "Progress", data: { chunkLength: 100 } });
      progress({ event: "Finished", data: {} });
    }),
    install: vi.fn(() => installation.promise),
    close: vi.fn(async () => {}),
  };
  const offer = deferred<typeof update>();
  native.check.mockReturnValue(offer.promise);
  let readers = initial;
  let hidden = false;
  let automatic = true;
  const tree = () => <Fixture readers={readers} hidden={hidden} pending={suspension.promise}
    automatic={automatic} onClose={(id) => { readers = readers.filter((item) => item.id !== id); commit(); }} />;
  const view = render(tree());
  function commit() { view.rerender(tree()); }
  return {
    update, download, installation,
    open: (reader: Reader) => { readers = [...readers, reader]; commit(); },
    hide: (value: boolean) => { hidden = value; commit(); },
    offer: async () => {
      await waitFor(() => expect(native.check).toHaveBeenCalledTimes(1));
      await act(async () => { offer.resolve(update); });
    },
    finishDownload: async () => { await act(async () => { download.resolve(); }); },
    failInstall: async () => {
      await act(async () => { installation.reject(new Error("Synthetic native install failure")); });
      await waitFor(() => expect(getUpdateInstallationActive()).toBe(false));
    },
    dispose: async (applied = false) => {
      // Normal policy/reader-close and physical-failure paths, never a reset of
      // attention or updater internals. Keep Banner mounted through rejection.
      automatic = false; hidden = false; readers = []; commit();
      await act(async () => {
        offer.resolve(update); suspension.resolve(); download.resolve();
        installation.reject(new Error("Synthetic native install cleanup"));
      });
      if (applied) expect(getUpdateInstallationActive()).toBe(true);
      else await waitFor(() => expect(getUpdateInstallationActive()).toBe(false));
      await act(async () => { await Promise.resolve(); });
      view.unmount();
      await act(async () => { await Promise.resolve(); });
      if (applied) expect(getUpdateInstallationActive()).toBe(true);
    },
  };
}

let current: ReturnType<typeof scenario> | null = null;
// Only the final, successfully applied update retains exclusion for the rest of
// this isolated test-file process. A relaunch mock cannot terminate the worker.
let terminalApplied = false;
const a = { id: "reader-a", title: "Reader A" };
const b = { id: "reader-b", title: "Reader B" };
function pane(reader: Reader) {
  return screen.getByRole("dialog", { name: `Playing ${reader.title}`, hidden: true });
}
function video(reader: Reader): HTMLVideoElement {
  const element = pane(reader).querySelector<HTMLVideoElement>("video.player-video");
  if (element == null) throw new Error("Real webview reader was not mounted");
  return element;
}
async function ready(reader: Reader, paused = false) {
  const element = video(reader);
  mediaState(element).readyState = HTMLMediaElement.HAVE_ENOUGH_DATA;
  fireEvent.loadedMetadata(element);
  fireEvent.canPlay(element);
  await waitFor(() => expect(element.paused).toBe(false));
  element.currentTime = 42;
  fireEvent.timeUpdate(element);
  if (paused) fireEvent.click(within(pane(reader)).getByRole("button", { name: "Pause", hidden: true }));
  expect(element.paused).toBe(paused);
  return element;
}
function close(reader: Reader) {
  fireEvent.click(within(pane(reader)).getByRole("button", { name: "Close player", hidden: true }));
}
async function waiting() {
  await screen.findByText(/Close all players and wait for playback to finish stopping\. If it cannot finish, reopen the app before updating\./);
}

beforeEach(() => {
  expect(getPlayerMounted()).toBe(false);
  expect(getUpdateInstallationActive()).toBe(false);
  localStorage.clear();
  media = new WeakMap(); createdVideos = [];
  native.check.mockReset(); native.getVersion.mockResolvedValue("2.3.75");
  native.invoke.mockReset(); native.invoke.mockRejectedValue(new Error("Unexpected native media activation"));
  native.relaunch.mockReset(); native.relaunch.mockRejectedValue(new Error("Unexpected process restart"));
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected HTTP request"); }));
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X)");
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) { return mediaState(this).paused; });
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockImplementation(function (this: HTMLMediaElement) { return mediaState(this).readyState; });
  vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(600);
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    mediaState(this).paused = false;
    this.dispatchEvent(new Event("play")); this.dispatchEvent(new Event("playing"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    mediaState(this).paused = true; this.dispatchEvent(new Event("pause"));
  });
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((...args: Parameters<typeof document.createElement>) => {
    const element = create(...args);
    if (element instanceof HTMLVideoElement) createdVideos.push(element);
    return element;
  });
});

afterEach(async () => {
  try { await current?.dispose(terminalApplied); }
  finally {
    current = null;
    vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear();
  }
  expect(getPlayerMounted()).toBe(false);
  expect(getUpdateInstallationActive()).toBe(terminalApplied);
});

describe("real desktop updater and webview reader admission", () => {
  it.each([false, true])("defers automatic download/apply for paused=%s readers until the last real close", async (paused) => {
    current = scenario([a, b]);
    const first = await ready(a, paused); const second = await ready(b, paused);
    await current.offer(); await waiting();
    expect(current.update.download).not.toHaveBeenCalled(); expect(current.update.install).not.toHaveBeenCalled();
    close(a);
    expect(getPlayerMounted()).toBe(true); expect(video(b)).toBe(second);
    expect(second.currentTime).toBe(42); expect(second.paused).toBe(paused);
    expect(first.isConnected).toBe(false);
    expect(current.update.download).not.toHaveBeenCalled();
    close(b);
    await waitFor(() => expect(current!.update.download).toHaveBeenCalledTimes(1));
    await current.finishDownload();
    await waitFor(() => expect(current!.update.install).toHaveBeenCalledTimes(1));
    expect(native.check).toHaveBeenCalledTimes(1); expect(native.relaunch).not.toHaveBeenCalled();
  });

  it("reuses completed download bytes after a new actual reader defers physical apply", async () => {
    current = scenario(); await current.offer();
    await waitFor(() => expect(current!.update.download).toHaveBeenCalledTimes(1));
    current.open(a); const element = await ready(a);
    await current.finishDownload(); await waiting();
    expect(current.update.install).not.toHaveBeenCalled(); expect(getPlayerMounted()).toBe(true);
    expect(video(a)).toBe(element); expect(element.currentTime).toBe(42); expect(element.paused).toBe(false);
    close(a);
    await waitFor(() => expect(current!.update.install).toHaveBeenCalledTimes(1));
    expect(current.update.download).toHaveBeenCalledTimes(1); expect(native.check).toHaveBeenCalledTimes(1);
  });

  it("mounts only an honest placeholder while a physical install promise is held", async () => {
    current = scenario(); await current.offer(); await current.finishDownload();
    await waitFor(() => expect(current!.update.install).toHaveBeenCalledTimes(1));
    expect(getUpdateInstallationActive()).toBe(true);
    const created = createdVideos.length;
    current.open(a);
    expect(screen.getByText(/Playback will be available after restart/)).toBeInTheDocument();
    expect(document.querySelector("video.player-video")).toBeNull(); expect(createdVideos).toHaveLength(created);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled(); expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled(); expect(getPlayerMounted()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Close player" }));
    expect(screen.queryByText(/Playback will be available after restart/)).toBeNull();
    expect(getUpdateInstallationActive()).toBe(true);
  });

  it("allows the same blocked reader to start after physical installation fails", async () => {
    current = scenario(); await current.offer(); await current.finishDownload();
    await waitFor(() => expect(current!.update.install).toHaveBeenCalledTimes(1));
    current.open(a); expect(document.querySelector("video.player-video")).toBeNull();
    await current.failInstall(); await screen.findByText("Update failed");
    await waitFor(() => expect(getPlayerMounted()).toBe(true));
    const element = await ready(a);
    expect(element.paused).toBe(false); expect(native.invoke).not.toHaveBeenCalled();
    expect(native.relaunch).not.toHaveBeenCalled(); expect(current.update.install).toHaveBeenCalledTimes(1);
    close(a); expect(getPlayerMounted()).toBe(false);
  });

  it("keeps a connected active reader protected through forced Suspense hide and reveal", async () => {
    current = scenario([a]); const element = await ready(a);
    await current.offer(); await waiting();
    current.hide(true);
    expect(screen.getByText("Connected reader temporarily hidden")).toBeInTheDocument();
    expect(element.isConnected).toBe(true); expect(getPlayerMounted()).toBe(true);
    await act(async () => { await Promise.resolve(); });
    expect(current.update.download).not.toHaveBeenCalled(); expect(current.update.install).not.toHaveBeenCalled();
    current.hide(false);
    expect(video(a)).toBe(element); expect(element.currentTime).toBe(42); expect(element.paused).toBe(false);
    close(a);
    await waitFor(() => expect(current!.update.download).toHaveBeenCalledTimes(1));
    await current.finishDownload(); await waitFor(() => expect(current!.update.install).toHaveBeenCalledTimes(1));
  });

  it("waits for an issued native start and its exact stop acknowledgement after real reader close", async () => {
    const started = deferred<{ embedded: boolean; status: string }>();
    const stopped = deferred<void>();
    const reader = { ...a, native: true };
    const commands = () => native.invoke.mock.calls.map(([command]) => command);
    native.invoke.mockImplementation((command: string) => {
      if (command === "mpv_play") return started.promise;
      if (command === "mpv_stop") return stopped.promise;
      throw new Error(`Unexpected native command: ${command}`);
    });
    current = scenario([reader]);
    try {
      await waitFor(() => expect(commands()).toEqual(["mpv_play"]));
      await current.offer(); await waiting();
      close(reader);
      expect(screen.queryByRole("dialog", { name: "Playing Reader A" })).toBeNull();
      expect(getPlayerMounted()).toBe(true);
      expect(current.update.download).not.toHaveBeenCalled();
      expect(current.update.install).not.toHaveBeenCalled();
      expect(commands()).toEqual(["mpv_play"]);
      await act(async () => { started.resolve({ embedded: false, status: "Late native start" }); });
      await waitFor(() => expect(commands()).toEqual(["mpv_play", "mpv_stop"]));
      await waiting();
      expect(getPlayerMounted()).toBe(true);
      expect(current.update.download).not.toHaveBeenCalled();
      expect(current.update.install).not.toHaveBeenCalled();
      await act(async () => { stopped.resolve(); });
      await waitFor(() => expect(current!.update.download).toHaveBeenCalledTimes(1));
      expect(getPlayerMounted()).toBe(false);
      await current.finishDownload();
      await waitFor(() => expect(current!.update.install).toHaveBeenCalledTimes(1));
      expect(commands()).toEqual(["mpv_play", "mpv_stop"]);
      expect(native.check).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => { started.resolve({ embedded: false, status: "Closed" }); stopped.resolve(); });
    }
  });

  // Deliberately final: installed bytes cannot be rolled back by closing Banner.
  it("retries only relaunch after native apply succeeds and retains reader exclusion", async () => {
    const restart = deferred<void>();
    try {
      native.relaunch.mockRejectedValueOnce(new Error("Synthetic restart failure"))
        .mockImplementationOnce(() => restart.promise);
      current = scenario(); await current.offer(); await current.finishDownload();
      await waitFor(() => expect(current!.update.install).toHaveBeenCalledTimes(1));
      await act(async () => { current!.installation.resolve(); });
      await waitFor(() => expect(native.relaunch).toHaveBeenCalledTimes(1));
      // Set only after the actual mocked apply fulfilled and relaunch was issued.
      terminalApplied = true;
      await screen.findByText(/Restart is required to finish\. The installed update will not be downloaded or applied again\./);
      expect(getUpdateInstallationActive()).toBe(true);
      const created = createdVideos.length;
      current.open(a);
      expect(screen.getByText(/Playback will be available after restart/)).toBeInTheDocument();
      expect(document.querySelector("video.player-video")).toBeNull();
      expect(createdVideos).toHaveLength(created); expect(native.invoke).not.toHaveBeenCalled();
      expect(getPlayerMounted()).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Restart app" }));
      await waitFor(() => expect(native.relaunch).toHaveBeenCalledTimes(2));
      expect(current.update.download).toHaveBeenCalledTimes(1);
      expect(current.update.install).toHaveBeenCalledTimes(1);
      expect(native.check).toHaveBeenCalledTimes(1);
      expect(getUpdateInstallationActive()).toBe(true);
      await act(async () => { restart.resolve(); });
      expect(getUpdateInstallationActive()).toBe(true);
      expect(document.querySelector("video.player-video")).toBeNull();
      expect(createdVideos).toHaveLength(created); expect(native.invoke).not.toHaveBeenCalled();
      expect(getPlayerMounted()).toBe(false);
      expect(current.update.download).toHaveBeenCalledTimes(1);
      expect(current.update.install).toHaveBeenCalledTimes(1);
      expect(native.relaunch).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByRole("button", { name: "Close player" }));
      expect(screen.queryByText(/Playback will be available after restart/)).toBeNull();
      expect(getUpdateInstallationActive()).toBe(true);
    } finally {
      await act(async () => { restart.resolve(); });
    }
  });
});
