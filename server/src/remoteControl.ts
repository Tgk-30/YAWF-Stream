import { createHash, randomBytes, randomInt } from "node:crypto";

export const REMOTE_PAIRING_TTL_MS = 15 * 60_000;
export const REMOTE_SESSION_TTL_MS = 12 * 60 * 60_000;
export const REMOTE_COMMAND_LIMIT = 100;

export type RemoteCommandType =
  | "play"
  | "pause"
  | "seek-relative"
  | "seek-absolute"
  | "volume"
  | "mute"
  | "fullscreen"
  | "next"
  | "close";

export interface RemoteCommand {
  sequence: number;
  type: RemoteCommandType;
  value?: number | boolean;
  createdAt: string;
}

export interface RemotePlaybackState {
  title: string | null;
  subtitle: string | null;
  playing: boolean;
  positionSeconds: number;
  durationSeconds: number | null;
  volume: number;
  muted: boolean;
  updatedAt: string;
}

interface RemoteSession {
  id: string;
  viewerProfileId: string;
  pairingCodeHash: string;
  controllerTokenHash: string | null;
  controllerName: string | null;
  createdAt: number;
  pairingExpiresAt: number;
  expiresAt: number;
  nextSequence: number;
  commands: RemoteCommand[];
  state: RemotePlaybackState;
}

export interface RemoteSessionViewer {
  id: string;
  pairingCode: string;
  pairingExpiresAt: string;
  expiresAt: string;
}

export interface RemoteSessionController {
  id: string;
  controllerToken: string;
  expiresAt: string;
  state: RemotePlaybackState;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function timestamp(value: number): string {
  return new Date(value).toISOString();
}

function emptyState(now: number): RemotePlaybackState {
  return {
    title: null,
    subtitle: null,
    playing: false,
    positionSeconds: 0,
    durationSeconds: null,
    volume: 1,
    muted: false,
    updatedAt: timestamp(now),
  };
}

export class RemoteControlRegistry {
  private readonly sessions = new Map<string, RemoteSession>();

  constructor(private readonly now: () => number = Date.now) {}

  private sweep(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }

  private uniquePairingCode(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const codeHash = digest(code);
      const collision = [...this.sessions.values()].some(
        (session) =>
          session.pairingExpiresAt > this.now() &&
          session.pairingCodeHash === codeHash,
      );
      if (!collision) return code;
    }
    throw new Error("Could not allocate a remote pairing code.");
  }

  create(viewerProfileId: string): RemoteSessionViewer {
    this.sweep();
    const now = this.now();
    const id = randomBytes(18).toString("base64url");
    const pairingCode = this.uniquePairingCode();
    const session: RemoteSession = {
      id,
      viewerProfileId,
      pairingCodeHash: digest(pairingCode),
      controllerTokenHash: null,
      controllerName: null,
      createdAt: now,
      pairingExpiresAt: now + REMOTE_PAIRING_TTL_MS,
      expiresAt: now + REMOTE_SESSION_TTL_MS,
      nextSequence: 1,
      commands: [],
      state: emptyState(now),
    };
    this.sessions.set(id, session);
    return {
      id,
      pairingCode,
      pairingExpiresAt: timestamp(session.pairingExpiresAt),
      expiresAt: timestamp(session.expiresAt),
    };
  }

  pair(pairingCode: string, controllerName: string | null): RemoteSessionController | null {
    this.sweep();
    const now = this.now();
    const codeHash = digest(pairingCode);
    const session = [...this.sessions.values()].find(
      (candidate) =>
        candidate.pairingExpiresAt > now &&
        candidate.pairingCodeHash === codeHash,
    );
    if (session == null) return null;

    const controllerToken = randomBytes(32).toString("base64url");
    session.controllerTokenHash = digest(controllerToken);
    session.controllerName = controllerName;
    // A code is single-use. Clearing its hash also makes a paired TV disappear
    // from code lookup immediately, even before pairingExpiresAt.
    session.pairingCodeHash = "";
    session.pairingExpiresAt = now;
    return {
      id: session.id,
      controllerToken,
      expiresAt: timestamp(session.expiresAt),
      state: session.state,
    };
  }

  viewerSnapshot(
    id: string,
    viewerProfileId: string,
    afterSequence = 0,
  ): {
    paired: boolean;
    controllerName: string | null;
    expiresAt: string;
    state: RemotePlaybackState;
    commands: RemoteCommand[];
  } | null {
    this.sweep();
    const session = this.sessions.get(id);
    if (session == null || session.viewerProfileId !== viewerProfileId) return null;
    return {
      paired: session.controllerTokenHash != null,
      controllerName: session.controllerName,
      expiresAt: timestamp(session.expiresAt),
      state: session.state,
      commands: session.commands.filter(
        (command) => command.sequence > afterSequence,
      ),
    };
  }

  controllerSnapshot(
    id: string,
    controllerToken: string,
  ): {
    expiresAt: string;
    state: RemotePlaybackState;
  } | null {
    this.sweep();
    const session = this.sessions.get(id);
    if (
      session == null ||
      session.controllerTokenHash == null ||
      digest(controllerToken) !== session.controllerTokenHash
    ) {
      return null;
    }
    return {
      expiresAt: timestamp(session.expiresAt),
      state: session.state,
    };
  }

  updateState(
    id: string,
    viewerProfileId: string,
    state: Omit<RemotePlaybackState, "updatedAt">,
  ): RemotePlaybackState | null {
    this.sweep();
    const session = this.sessions.get(id);
    if (session == null || session.viewerProfileId !== viewerProfileId) return null;
    session.state = {
      ...state,
      updatedAt: timestamp(this.now()),
    };
    return session.state;
  }

  enqueue(
    id: string,
    controllerToken: string,
    command: Omit<RemoteCommand, "sequence" | "createdAt">,
  ): RemoteCommand | null {
    this.sweep();
    const session = this.sessions.get(id);
    if (
      session == null ||
      session.controllerTokenHash == null ||
      digest(controllerToken) !== session.controllerTokenHash
    ) {
      return null;
    }
    const queued: RemoteCommand = {
      ...command,
      sequence: session.nextSequence,
      createdAt: timestamp(this.now()),
    };
    session.nextSequence += 1;
    session.commands.push(queued);
    if (session.commands.length > REMOTE_COMMAND_LIMIT) {
      session.commands.splice(0, session.commands.length - REMOTE_COMMAND_LIMIT);
    }
    return queued;
  }

  remove(id: string, viewerProfileId: string): boolean {
    const session = this.sessions.get(id);
    if (session == null || session.viewerProfileId !== viewerProfileId) return false;
    this.sessions.delete(id);
    return true;
  }
}
