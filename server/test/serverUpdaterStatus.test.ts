import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseServerUpdaterStatus, readServerUpdaterStatus } from "../src/serverUpdaterStatus.js";

const root = join(tmpdir(), `yawf-updater-status-${process.pid}`);
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("server updater status adapter", () => {
  it("reads only bounded redacted host status", () => {
    mkdirSync(root, { recursive: true });
    const path = join(root, "status.json");
    const value = { schemaVersion: 1, supported: true, installType: "docker-compose", enabled: true,
      state: "deferred", currentVersion: "2.3.9", candidateVersion: "2.3.10", lastCheckedAt: "2026-10-12T12:00:00.000Z",
      lastChangedAt: "2026-10-12T12:00:00.000Z", detail: "Active playback is in progress; the update was deferred." };
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    expect(parseServerUpdaterStatus(value)).toMatchObject({ supported: true, enabled: true, state: "deferred", currentVersion: "2.3.9" });
    if (process.getuid?.() === 0) expect(readServerUpdaterStatus(path)).toMatchObject({ supported: true });
  });

  it("reports unsupported for missing, malformed, or symlinked state", () => {
    mkdirSync(root, { recursive: true });
    expect(readServerUpdaterStatus(join(root, "missing"))).toMatchObject({ supported: false, state: "unregistered" });
    const target = join(root, "target"); writeFileSync(target, "{}"); symlinkSync(target, join(root, "link"));
    expect(readServerUpdaterStatus(join(root, "link"))).toMatchObject({ supported: false });
    expect(parseServerUpdaterStatus({ schemaVersion: 1, supported: true, installType: "docker-compose", enabled: true,
      state: "failed", currentVersion: null, candidateVersion: null, lastCheckedAt: null, lastChangedAt: null,
      detail: "secret=do-not-render" })).toBeNull();
  });
});
