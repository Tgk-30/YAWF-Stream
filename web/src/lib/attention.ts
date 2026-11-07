// Park unattended UI work when the window is not frontmost or input has gone
// idle: unlike Chrome, this app has animated surfaces that otherwise keep
// compositing when nobody is looking at them.

import { useSyncExternalStore } from "react";

export const IDLE_MS = 5 * 60_000;

interface AttentionGate {
  unfocused: boolean;
  inputIdle: boolean;
  resyncIdle: () => void;
}

const attentionGates = new Set<AttentionGate>();
const attentionListeners = new Set<() => void>();
const playerMountListeners = new Set<() => void>();
const updateInstallationListeners = new Set<() => void>();
let updateInstallationActive = false;
let idleGateSuppressed = false;
let playerMounts = 0;
let readerWork = 0;
let attentionParked = false;

function publishAttention(): void {
  const next = [...attentionGates].some((gate) => gate.unfocused || gate.inputIdle);
  if (next === attentionParked) return;
  attentionParked = next;
  attentionListeners.forEach((listener) => listener());
}

/** Subscribe React surfaces that need to park JavaScript-driven loops too. */
export function subscribeAttention(listener: () => void): () => void {
  attentionListeners.add(listener);
  return () => attentionListeners.delete(listener);
}

/** True while the window is unfocused or the user has not interacted recently. */
export function getAttentionParked(): boolean {
  return attentionParked;
}

export function useAttentionParked(): boolean {
  return useSyncExternalStore(subscribeAttention, getAttentionParked, getAttentionParked);
}

/** Keep input-idle from firing while any mounted player may be playing video. */
export function setIdleGateSuppressed(suppressed: boolean): void {
  if (idleGateSuppressed === suppressed) return;
  idleGateSuppressed = suppressed;
  attentionGates.forEach((gate) => gate.resyncIdle());
}

/** Track mounted players without adding playback state to the application store. */
export function registerPlayerMount(): () => void {
  playerMounts += 1;
  playerMountListeners.forEach((listener) => listener());
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    playerMounts = Math.max(0, playerMounts - 1);
    playerMountListeners.forEach((listener) => listener());
  };
}

function subscribePlayerMount(listener: () => void): () => void {
  playerMountListeners.add(listener);
  return () => playerMountListeners.delete(listener);
}

export function getPlayerMounted(): boolean {
  return playerMounts > 0 || readerWork > 0;
}

/** Admission is synchronous, but callers acquire only from committed effects. */
export function tryRegisterPlayerMount(): (() => void) | null {
  return updateInstallationActive ? null : registerPlayerMount();
}

/** Native work remains an activity owner until its exact acknowledgement. */
export function tryAcquireReaderWork(): (() => void) | null {
  if (updateInstallationActive) return null;
  readerWork += 1;
  playerMountListeners.forEach((listener) => listener());
  let released = false;
  return () => {
    if (released) return;
    released = true;
    readerWork -= 1;
    playerMountListeners.forEach((listener) => listener());
  };
}

/** Hold through the non-cancellable native install and process restart. */
export function tryAcquireUpdateInstallation(): (() => void) | null {
  if (updateInstallationActive || getPlayerMounted()) return null;
  updateInstallationActive = true;
  updateInstallationListeners.forEach((listener) => listener());
  let released = false;
  return () => {
    if (released) return;
    released = true;
    updateInstallationActive = false;
    updateInstallationListeners.forEach((listener) => listener());
  };
}

function subscribeUpdateInstallation(listener: () => void): () => void {
  updateInstallationListeners.add(listener);
  return () => updateInstallationListeners.delete(listener);
}

export function getUpdateInstallationActive(): boolean {
  return updateInstallationActive;
}

export function useUpdateInstallationActive(): boolean {
  return useSyncExternalStore(subscribeUpdateInstallation, getUpdateInstallationActive, getUpdateInstallationActive);
}

export function usePlayerMounted(): boolean {
  return useSyncExternalStore(subscribePlayerMount, getPlayerMounted, getPlayerMounted);
}

export function installAttentionGate(doc: Document = document, win: Window = window): () => void {
  let idleTimer: number | undefined;
  let lastPointerReset = -Infinity;
  const gate: AttentionGate = {
    unfocused: false,
    inputIdle: false,
    resyncIdle: () => {},
  };

  const applyFocus = (unfocused: boolean) => {
    if (unfocused) {
      doc.documentElement.dataset.unfocused = "";
    } else {
      delete doc.documentElement.dataset.unfocused;
    }
    if (gate.unfocused === unfocused) return;
    gate.unfocused = unfocused;
    publishAttention();
  };

  const applyInputIdle = (inputIdle: boolean) => {
    if (inputIdle) {
      doc.documentElement.dataset.inputIdle = "";
    } else {
      delete doc.documentElement.dataset.inputIdle;
    }
    if (gate.inputIdle === inputIdle) return;
    gate.inputIdle = inputIdle;
    publishAttention();
  };

  const clearIdleTimer = () => {
    if (idleTimer == null) return;
    win.clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const armIdle = () => {
    clearIdleTimer();
    if (idleGateSuppressed) return;
    idleTimer = win.setTimeout(() => {
      idleTimer = undefined;
      if (!idleGateSuppressed) applyInputIdle(true);
    }, IDLE_MS);
  };

  const resetIdle = () => {
    applyInputIdle(false);
    armIdle();
  };

  const onPointerMove = () => {
    const now = Date.now();
    if (now - lastPointerReset < 1000) return;
    lastPointerReset = now;
    resetIdle();
  };
  const onInput = () => resetIdle();
  const apply = () => {
    applyFocus(!doc.hasFocus());
    resetIdle();
  };

  gate.resyncIdle = () => {
    applyInputIdle(false);
    armIdle();
  };
  const onBlur = () => applyFocus(true);
  const onFocus = () => applyFocus(false);
  attentionGates.add(gate);
  apply();
  win.addEventListener("blur", onBlur);
  win.addEventListener("focus", onFocus);
  win.addEventListener("pointermove", onPointerMove, { passive: true });
  win.addEventListener("pointerdown", onInput, { passive: true });
  win.addEventListener("wheel", onInput, { passive: true });
  win.addEventListener("keydown", onInput, { passive: true });

  return () => {
    clearIdleTimer();
    attentionGates.delete(gate);
    win.removeEventListener("blur", onBlur);
    win.removeEventListener("focus", onFocus);
    win.removeEventListener("pointermove", onPointerMove);
    win.removeEventListener("pointerdown", onInput);
    win.removeEventListener("wheel", onInput);
    win.removeEventListener("keydown", onInput);
    delete doc.documentElement.dataset.unfocused;
    delete doc.documentElement.dataset.inputIdle;
    publishAttention();
  };
}
