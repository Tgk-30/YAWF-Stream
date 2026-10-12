const RELEASES_API = "https://api.github.com/repos/Tgk-30/YAWF-Stream/releases";
const RELEASES_URL = "https://github.com/Tgk-30/YAWF-Stream/releases";
export const SERVER_RELEASES_PER_PAGE = 20;
export const SERVER_RELEASE_PAGE_LIMIT = 10;
export const SERVER_RELEASE_PAGE_MAX_BYTES = 1_000_000;
export const SERVER_RELEASE_DISCOVERY_MAX_BYTES = 8_000_000;
export const SERVER_RELEASE_DISCOVERY_TIMEOUT_MS = 10_000;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-web)?$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export interface ServerReleaseAsset {
  name: string;
  url: string;
  digest: string;
  size: number;
}

export interface ServerRelease {
  version: string;
  tag: string;
  url: string;
  debian: ServerReleaseAsset;
  checksums: ServerReleaseAsset;
  updaterManifest: ServerReleaseAsset | null;
}

export type ServerReleaseCheckState = "disabled" | "current" | "available" | "unavailable";

interface GitHubAsset {
  name?: unknown;
  browser_download_url?: unknown;
  digest?: unknown;
  size?: unknown;
}

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

function parseVersion(tag: string): [number, number, number] | null {
  const match = TAG.exec(tag);
  if (match == null) return null;
  const parts = match.slice(1, 4).map(Number) as [number, number, number];
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(`v${left}`)!;
  const b = parseVersion(`v${right}`)!;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function asset(value: GitHubAsset, expectedName: string, tag: string): ServerReleaseAsset | null {
  if (
    value.name !== expectedName ||
    typeof value.browser_download_url !== "string" ||
    typeof value.digest !== "string" ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    !DIGEST.test(value.digest)
  ) return null;
  const expectedPrefix = `https://github.com/Tgk-30/YAWF-Stream/releases/download/${tag}/`;
  if (value.browser_download_url !== `${expectedPrefix}${expectedName}`) return null;
  return { name: expectedName, url: value.browser_download_url, digest: value.digest, size: value.size };
}

/** Select the greatest published stable release that carries the exact server package. */
export function selectServerRelease(input: unknown): ServerRelease | null {
  if (!Array.isArray(input)) return null;
  const candidates: ServerRelease[] = [];
  for (const raw of input) {
    if (raw == null || typeof raw !== "object") continue;
    const release = raw as GitHubRelease;
    if (release.draft !== false || release.prerelease !== false || typeof release.published_at !== "string") continue;
    if (typeof release.tag_name !== "string" || typeof release.html_url !== "string") continue;
    const tag = release.tag_name;
    const url = release.html_url;
    const parts = parseVersion(tag);
    if (parts == null || !Array.isArray(release.assets) || release.assets.length > 100) continue;
    const version = parts.join(".");
    const debName = `debridstreamer-server_${version}_all.deb`;
    if (release.html_url !== `https://github.com/Tgk-30/YAWF-Stream/releases/tag/${tag}`) continue;
    const assets = release.assets as GitHubAsset[];
    const exact = (name: string) => {
      const matches = assets.filter((item) => item.name === name);
      return matches.length === 1 ? asset(matches[0]!, name, tag) : null;
    };
    const debian = exact(debName);
    const checksums = exact("SHA256SUMS");
    if (debian == null || checksums == null) continue;
    const updaterManifest = exact("server-update.json");
    candidates.push({ version, tag, url, debian, checksums, updaterManifest });
  }
  candidates.sort((a, b) => compareVersions(b.version, a.version) || Number(a.tag.endsWith("-web")) - Number(b.tag.endsWith("-web")));
  return candidates[0] ?? null;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch {}
}

async function readReleasePage(response: Response, signal: AbortSignal): Promise<{ value: unknown; bytes: number }> {
  if (!response.ok) { await cancelResponseBody(response); throw new Error(`GitHub release lookup failed (${response.status}).`); }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > SERVER_RELEASE_PAGE_MAX_BYTES) {
    await cancelResponseBody(response);
    throw new Error("GitHub release response was too large.");
  }
  if (response.body == null) throw new Error("GitHub release response was empty.");
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let total = 0; let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > SERVER_RELEASE_PAGE_MAX_BYTES) throw new Error("GitHub release response was too large.");
      chunks.push(Buffer.from(value));
    }
    complete = true;
  } finally {
    if (!complete) { try { await reader.cancel(); } catch {} }
    reader.releaseLock();
  }
  signal.throwIfAborted();
  return { value: JSON.parse(Buffer.concat(chunks, total).toString("utf8")), bytes: total };
}

export async function fetchLatestServerRelease(fetchImpl: typeof fetch = fetch): Promise<ServerRelease | null> {
  let latest: ServerRelease | null = null; let aggregateBytes = 0;
  const signal = AbortSignal.timeout(SERVER_RELEASE_DISCOVERY_TIMEOUT_MS);
  for (let page = 1; page <= SERVER_RELEASE_PAGE_LIMIT; page += 1) {
    signal.throwIfAborted();
    const response = await fetchImpl(`${RELEASES_API}?per_page=${SERVER_RELEASES_PER_PAGE}&page=${page}`, {
      redirect: "error",
      headers: { accept: "application/vnd.github+json", "user-agent": "YAWF-Stream-Server" },
      signal,
    });
    const { value: releases, bytes } = await readReleasePage(response, signal);
    aggregateBytes += bytes;
    if (aggregateBytes > SERVER_RELEASE_DISCOVERY_MAX_BYTES) throw new Error("GitHub release discovery exceeded its aggregate size limit.");
    if (!Array.isArray(releases) || releases.length > SERVER_RELEASES_PER_PAGE) {
      throw new Error("GitHub returned invalid paginated release metadata.");
    }
    const candidate = selectServerRelease(releases);
    if (candidate != null && (latest == null || compareVersions(candidate.version, latest.version) > 0 ||
        (candidate.version === latest.version && latest.tag.endsWith("-web") && !candidate.tag.endsWith("-web")))) latest = candidate;
    if (releases.length < SERVER_RELEASES_PER_PAGE) return latest;
  }
  throw new Error("GitHub release discovery exceeded its page limit.");
}

export function serverReleaseStatus(currentVersion: string, release: ServerRelease | null, state?: ServerReleaseCheckState) {
  const available = release != null && compareVersions(release.version, currentVersion) > 0;
  return {
    currentVersion,
    latestVersion: release?.version ?? null,
    available,
    url: release?.url ?? RELEASES_URL,
    state: state ?? (available ? "available" : "current") as ServerReleaseCheckState,
    checkedAt: state === "disabled" || state === "unavailable" ? null : new Date().toISOString(),
  };
}
