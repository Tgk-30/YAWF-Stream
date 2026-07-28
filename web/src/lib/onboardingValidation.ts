// Live key validation for the first-run wizard. Both checks construct
// throwaway clients - nothing here persists anything; the wizard saves once
// at the end via updateSettings.

import { TMDBService } from "../services/metadata/TMDBService";
import { TMDBError } from "../services/metadata/types";
import { buildDebridService, type DebridTokenEntry } from "../data/settings";
import { assertNetworkAllowed } from "./networkPolicy";

type TmdbTestResult = "ok" | "unauthorized" | "network";

/** One GET /search/multi with the candidate key. */
export async function testTmdbKey(key: string): Promise<TmdbTestResult> {
  try {
    await new TMDBService(key.trim()).search("test", null, 1);
    return "ok";
  } catch (err) {
    // 401 = bad key; 429 means the key REACHED TMDB (a rate-limited key is a
    // working key); anything else is network/CORS, not the key's fault.
    if (err instanceof TMDBError && err.kind === "unauthorized") return "unauthorized";
    if (err instanceof TMDBError && err.kind === "rateLimited") return "ok";
    return "network";
  }
}

type OmdbTestResult = "ok" | "unauthorized" | "network";

/** One title lookup with the candidate key. OMDb answers HTTP 200/401 with a
 *  JSON body either way and sends permissive CORS headers, so a plain browser
 *  can genuinely distinguish a bad key from a network failure. */
export async function testOmdbKey(key: string): Promise<OmdbTestResult> {
  try {
    // This validator uses raw fetch (not the gated OMDBService), so it must
    // enforce the network gate itself. In Offline mode "ratings" is blocked, so
    // the key is never sent off the device; report it as unverifiable.
    assertNetworkAllowed("ratings", "OMDb key test");
  } catch {
    return "network";
  }
  try {
    const res = await fetch(
      `https://www.omdbapi.com/?apikey=${encodeURIComponent(key.trim())}&i=tt0111161`,
    );
    if (res.status === 401) return "unauthorized";
    const json: { Response?: string; Error?: string } = await res.json();
    if (json.Response === "True") return "ok";
    if (typeof json.Error === "string" && /key/i.test(json.Error)) {
      return "unauthorized";
    }
    // Reached OMDb and the key wasn't rejected - treat other API quirks
    // (e.g. temporary lookup errors) as a working key.
    return "ok";
  } catch {
    return "network";
  }
}

/** true = verified. false = rejected OR unreachable - validateToken() is a
 *  catch-all boolean, so callers must hedge their copy (and offer a
 *  save-without-testing path: debrid hosts are CORS-blocked in plain
 *  browsers, where a valid token still fails this check). */
export async function testDebridToken(entry: DebridTokenEntry): Promise<boolean> {
  const service = buildDebridService(entry);
  if (service == null) return false;
  try {
    return await service.validateToken();
  } catch {
    return false;
  }
}
