import { useSyncExternalStore } from "react";
import type { TVRemoteSession } from "./serverApi";

let currentSession: TVRemoteSession | null = null;
const listeners = new Set<() => void>();
const lastSequence = new Map<string, number>();

export function setTVRemoteSession(session: TVRemoteSession | null): void {
  if (currentSession?.id === session?.id) return;
  currentSession = session;
  for (const listener of listeners) listener();
}

export function getTVRemoteSession(): TVRemoteSession | null {
  return currentSession;
}

export function useTVRemoteSession(): TVRemoteSession | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getTVRemoteSession,
    () => null,
  );
}

export function acknowledgedRemoteSequence(sessionId: string): number {
  return lastSequence.get(sessionId) ?? 0;
}

export function acknowledgeRemoteSequence(
  sessionId: string,
  sequence: number,
): void {
  lastSequence.set(
    sessionId,
    Math.max(sequence, lastSequence.get(sessionId) ?? 0),
  );
}
