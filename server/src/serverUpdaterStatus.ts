import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

export interface ServerUpdaterStatus {
  supported: boolean;
  installType: "docker-compose" | "unsupported";
  enabled: boolean;
  state: "unregistered" | "disabled" | "idle" | "checking" | "deferred" | "updating" | "updated" | "rolled_back" | "failed";
  currentVersion: string | null;
  candidateVersion: string | null;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  detail: string;
}

const DEFAULT_STATUS = "/run/yawf-server-updater/status.json";
const STATES = new Set(["unregistered", "disabled", "idle", "checking", "deferred", "updating", "updated", "rolled_back", "failed"]);
const STATUS_KEYS = ["schemaVersion", "supported", "installType", "enabled", "state", "currentVersion", "candidateVersion", "lastCheckedAt", "lastChangedAt", "detail"];
const DETAILS = [
  /^Registered\. Automatic server updates are off\.$/,
  /^Automatic server updates are (?:off|enabled for 03:00-05:00 UTC)\.$/,
  /^Waiting for the 03:00-05:00 UTC maintenance window\.$/,
  /^Playback activity could not be verified safely; the update was deferred\.$/,
  /^Active playback is in progress; the update was deferred\.$/,
  /^Version \d+\.\d+\.\d+ is inhibited after a failed update\. Run enable to retry\.$/,
  /^Installing server \d+\.\d+\.\d+\.$/,
  /^Update \d+\.\d+\.\d+ failed and the previous server was restored\.$/,
  /^Update \d+\.\d+\.\d+ failed before the data snapshot; the previous server was restarted\.$/,
  /^Update recovery needs operator attention; the journal was retained and server data was not restored without a verified stop\.$/,
  /^The running server changed or playback activity could not be rechecked safely; the update was deferred\.$/,
  /^Active playback began while the candidate downloaded; the update was deferred\.$/,
  /^The running server no longer matches its registration; register it again before updating\.$/,
  /^An interrupted pre-install update check was recovered without changing server data\.$/,
  /^Server \d+\.\d+\.\d+ installed successfully\.$/,
  /^Checking the stable server release channel\.$/,
  /^The stable release check failed\. Inspect host service logs\.$/,
  /^Candidate image download or provenance verification failed\.$/,
  /^The server is up to date\.$/,
  /^Server \d+\.\d+\.\d+ is available\.$/,
];

function exactKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).sort().join("\0") === [...STATUS_KEYS].sort().join("\0");
}

function timestamp(value: unknown): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > 32 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

export function parseServerUpdaterStatus(value: unknown): ServerUpdaterStatus | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const detail = typeof record.detail === "string" ? record.detail : null;
  if (record.schemaVersion !== 1 || record.supported !== true || record.installType !== "docker-compose" ||
      typeof record.enabled !== "boolean" || typeof record.state !== "string" || !STATES.has(record.state) ||
      detail == null || detail.length > 200 || !DETAILS.some((pattern) => pattern.test(detail)) || !exactKeys(record)) return null;
  const nullable = (input: unknown, pattern?: RegExp): string | null | undefined =>
    input == null ? null : typeof input === "string" && input.length <= 128 && (pattern == null || pattern.test(input)) ? input : undefined;
  const currentVersion = nullable(record.currentVersion, /^\d+\.\d+\.\d+$/);
  const candidateVersion = nullable(record.candidateVersion, /^\d+\.\d+\.\d+$/);
  const lastCheckedAt = timestamp(record.lastCheckedAt); const lastChangedAt = timestamp(record.lastChangedAt);
  if (currentVersion === undefined || candidateVersion === undefined || lastCheckedAt === undefined || lastChangedAt === undefined) return null;
  return {
    supported: true, installType: "docker-compose", enabled: record.enabled, state: record.state as ServerUpdaterStatus["state"],
    currentVersion, candidateVersion, lastCheckedAt, lastChangedAt, detail,
  };
}

export function readServerUpdaterStatus(path = DEFAULT_STATUS): ServerUpdaterStatus {
  const unsupported: ServerUpdaterStatus = {
    supported: false, installType: "unsupported", enabled: false, state: "unregistered",
    currentVersion: null, candidateVersion: null, lastCheckedAt: null, lastChangedAt: null,
    detail: "Automatic server installation is unavailable on this host.",
  };
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: Buffer;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 64 * 1024) return unsupported;
      raw = readFileSync(fd);
    } finally { closeSync(fd); }
    return parseServerUpdaterStatus(JSON.parse(raw.toString("utf8"))) ?? unsupported;
  } catch {
    return unsupported;
  }
}
