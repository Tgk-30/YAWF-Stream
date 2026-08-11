// Holds the authenticated Server-Mode session (captured by ServerModeGate from
// /api/bootstrap and the login/setup/invite responses) so the app can read
// per-profile facts like `simpleMode` and `role` without re-fetching. In Local
// Mode the session is null and consumers fall back to local settings.

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

export interface ServerSession {
  profileId: string;
  username: string;
  displayName: string;
  role: "owner" | "admin" | "member" | "restricted";
  avatarColor?: string | null;
  simpleMode: boolean;
}

/** One viewer in the account's "who's watching" picker. */
export interface ServerProfileSummary {
  id: string;
  displayName: string;
  avatarColor: string | null;
  simpleMode: boolean;
  isDefault: boolean;
  /** Kid (maturity-capped) profile - drives the picker's "Kids" badge and the
   *  parental-lock prompt when leaving it. */
  isKid: boolean;
  /** Server-side household PIN set flag. The PIN itself is never exposed. */
  hasPin?: boolean;
  gateType?: "none" | "pin" | "password";
  /** Warn-only rolling 30-day household bandwidth status. */
  bandwidthCapBytes?: number | null;
  bandwidthUsageBytes?: number;
  bandwidthStatus?: "ok" | "approaching" | "over";
}

export interface ServerTranscodeCapabilities {
  adaptive: boolean;
  /** Supported server-optimized playback qualities. Empty on older servers. */
  qualities: Array<"auto" | "1080p" | "720p" | "480p" | "360p">;
  seekOffset: boolean;
  subtitleSidecar: boolean;
  hardwareEncoder: string;
  availableVideoEncoders: string[];
  toneMapping: boolean;
}

const NO_TRANSCODE_CAPABILITIES: ServerTranscodeCapabilities = {
  adaptive: false,
  qualities: [],
  seekOffset: false,
  subtitleSidecar: false,
  hardwareEncoder: "libx264",
  availableVideoEncoders: [],
  toneMapping: false,
};

interface ServerSessionContextValue {
  session: ServerSession | null;
  setSession: (session: ServerSession | null) => void;
  /** The account's household profiles (drives the picker). */
  profiles: ServerProfileSummary[];
  setProfiles: (profiles: ServerProfileSummary[]) => void;
  /** Whether the server can transcode (operator flag on + ffmpeg present). A
   *  static server capability captured once at bootstrap. */
  transcodeAvailable: boolean;
  transcodeCapabilities: ServerTranscodeCapabilities;
  /** Explicit operator capability. False for older servers and Local Mode. */
  directTorrentAvailable: boolean;
  /** Whether the server can supply OMDb ratings for this profile (a profile,
   *  server, or env OMDb key is configured server-side). The key itself never
   *  reaches the client - this only says the /api/omdb proxy will answer. */
  omdbProxy: boolean;
  /** Distribution tier this build targets - drives the onboarding flow. */
  buildProfile: "family" | "friends" | "public";
}

export type BuildProfile = "family" | "friends" | "public";

const ServerSessionCtx = createContext<ServerSessionContextValue>({
  session: null,
  setSession: () => {},
  profiles: [],
  setProfiles: () => {},
  transcodeAvailable: false,
  transcodeCapabilities: NO_TRANSCODE_CAPABILITIES,
  directTorrentAvailable: false,
  omdbProxy: false,
  buildProfile: "public",
});

export function ServerSessionProvider({
  initial,
  initialProfiles = [],
  initialTranscodeAvailable = false,
  initialTranscodeCapabilities = NO_TRANSCODE_CAPABILITIES,
  initialDirectTorrentAvailable = false,
  initialOmdbProxy = false,
  initialBuildProfile = "public",
  children,
}: {
  initial: ServerSession | null;
  initialProfiles?: ServerProfileSummary[];
  initialTranscodeAvailable?: boolean;
  initialTranscodeCapabilities?: ServerTranscodeCapabilities;
  initialDirectTorrentAvailable?: boolean;
  initialOmdbProxy?: boolean;
  initialBuildProfile?: BuildProfile;
  children: ReactNode;
}) {
  const [session, setSession] = useState<ServerSession | null>(initial);
  const [profiles, setProfiles] = useState<ServerProfileSummary[]>(initialProfiles);
  const set = useCallback((next: ServerSession | null) => setSession(next), []);
  const setList = useCallback(
    (next: ServerProfileSummary[]) => setProfiles(next),
    [],
  );
  return (
    <ServerSessionCtx.Provider
      value={{
        session,
        setSession: set,
        profiles,
        setProfiles: setList,
        transcodeAvailable: initialTranscodeAvailable,
        transcodeCapabilities: initialTranscodeCapabilities,
        directTorrentAvailable: initialDirectTorrentAvailable,
        omdbProxy: initialOmdbProxy,
        buildProfile: initialBuildProfile,
      }}
    >
      {children}
    </ServerSessionCtx.Provider>
  );
}

/** Whether the server advertises transcoding (Server Mode capability). */
export function useTranscodeAvailable(): boolean {
  return useContext(ServerSessionCtx).transcodeAvailable;
}

export function useTranscodeCapabilities(): ServerTranscodeCapabilities {
  return useContext(ServerSessionCtx).transcodeCapabilities;
}

export function useDirectTorrentAvailable(): boolean {
  return useContext(ServerSessionCtx).directTorrentAvailable;
}

/** Whether the server can supply OMDb ratings (Server Mode "hidden key" path). */
export function useOmdbProxy(): boolean {
  return useContext(ServerSessionCtx).omdbProxy;
}

/** The distribution tier this build targets (family|friends|public). Drives the
 *  onboarding flow. Server Mode reads it from /api/bootstrap; Local Mode falls
 *  back to the context default ("public"). */
export function useBuildProfile(): BuildProfile {
  return useContext(ServerSessionCtx).buildProfile;
}

/** The current Server-Mode session, or null in Local Mode / before sign-in. */
export function useServerSession(): ServerSession | null {
  return useContext(ServerSessionCtx).session;
}

/** Update the in-memory session (e.g. optimistic simpleMode toggle, or a
 *  profile switch). */
export function useSetServerSession(): (session: ServerSession | null) => void {
  return useContext(ServerSessionCtx).setSession;
}

/** The account's household profiles for the "who's watching" picker. */
export function useServerProfiles(): ServerProfileSummary[] {
  return useContext(ServerSessionCtx).profiles;
}

/** Replace the in-memory household profile list (after create/rename/delete). */
export function useSetServerProfiles(): (profiles: ServerProfileSummary[]) => void {
  return useContext(ServerSessionCtx).setProfiles;
}
