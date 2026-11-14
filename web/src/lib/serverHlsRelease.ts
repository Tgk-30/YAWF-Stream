import { serverHlsLeaseTarget } from "./serverApi";
import { readCsrfToken } from "./serverSession";

export interface ServerHlsLeaseIdentity {
  target: string;
  sessionId: string;
  generation: string;
}

/** Reuse the master-derived trust boundary before mutating one exact job. */
export function serverHlsLeaseIdentity(target: string): ServerHlsLeaseIdentity | null {
  try {
    const parsed = new URL(target);
    const master = new URL("index.m3u8", parsed).href;
    const child = `${parsed.pathname.split("/").pop()}${parsed.search}`;
    if (serverHlsLeaseTarget(master, `#EXTM3U\n${child}\n`) !== target) return null;
    const match = /\/api\/stream\/([A-Za-z0-9_-]{1,120})\/(?:1080p|720p|480p|360p)\.m3u8$/.exec(parsed.pathname);
    const generation = parsed.searchParams.get("generation");
    if (match == null || generation == null) return null;
    return { target, sessionId: match[1]!, generation };
  } catch {
    return null;
  }
}

/** Release only a detached reader's exact generation, never its raw grant. */
export async function releaseServerHlsGeneration(target: string, signal: AbortSignal): Promise<void> {
  const identity = serverHlsLeaseIdentity(target);
  if (identity == null) throw new Error("Untrusted stream cleanup target.");
  const csrf = readCsrfToken();
  if (csrf == null || csrf.length === 0) throw new Error("Sign in again before replacing this stream.");
  const url = new URL(target);
  url.pathname = url.pathname.replace(/\/(?:1080p|720p|480p|360p)\.m3u8$/, "/transcode/release");
  url.search = "";
  const response = await fetch(url.href, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    redirect: "error",
    headers: { "content-type": "application/json", "x-csrf-token": csrf },
    body: JSON.stringify({ generation: identity.generation }),
    signal,
  });
  if (!response.ok) {
    throw Object.assign(new Error("The previous stream could not be safely stopped."), { status: response.status });
  }
  const text = await response.text();
  let result: unknown;
  try { result = text.length <= 4096 ? JSON.parse(text) : null; } catch { result = null; }
  if (response.status !== 200 || result == null || typeof result !== "object" || !("ok" in result) || result.ok !== true) {
    throw new Error("The server did not confirm that the previous stream stopped.");
  }
}

