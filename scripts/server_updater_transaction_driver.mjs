#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { parseUpdateManifest, recoverRegisteredJournalForTest, runRegisteredCandidateForTest } from "../deploy/updater/yawf-server-update.mjs";

assert.equal(process.getuid?.(), 0, "transaction driver must run as root in isolated CI");
const [digest, sourceRevision, fault = "none"] = process.argv.slice(2);
const candidateVersion = JSON.parse(readFileSync(new URL("../server/package.json", import.meta.url), "utf8")).version;
assert.match(digest ?? "", /^sha256:[a-f0-9]{64}$/);
assert.match(sourceRevision ?? "", /^[a-f0-9]{40}$/);
assert.match(candidateVersion, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.ok(new Set(["none", "after-health", "stop", "snapshot", "interrupt", "recover"]).has(fault));
const candidate = parseUpdateManifest({
  schemaVersion: 1,
  version: candidateVersion,
  sourceRevision,
  image: { repository: "ghcr.io/tgk-30/yawf-stream", digest },
  debian: { name: `debridstreamer-server_${candidateVersion}_all.deb`, sha256: "0".repeat(64), size: 1 },
}, candidateVersion);
const options = { now: new Date("2026-10-12T04:00:00.000Z") };
if (fault === "recover") {
  await recoverRegisteredJournalForTest();
  process.exit(0);
}
if (fault === "stop") options.stop = true;
if (fault === "snapshot") options.snapshot = true;
if (fault === "interrupt") options.interruptAfterSnapshot = true;
let faultReached = false;
if (fault === "after-health") options.afterHealth = async (id) => {
  execFileSync("docker", ["exec", id, "node", "-e", "const f=require('fs'),{DatabaseSync}=require('node:sqlite');f.writeFileSync('/data/injected-post-install-mutation','must-rollback');let d=new DatabaseSync('/data/debridstreamer.sqlite');let v=d.prepare('PRAGMA user_version').get().user_version;d.exec(`PRAGMA user_version = ${v+1}`);d.close()"]);
  const policy = JSON.parse(readFileSync("/etc/yawf-server-updater/config.json", "utf8"));
  writeFileSync(policy.envPath, "UPDATER_INJECTED_ENV_MUTATION=must-rollback\n");
  faultReached = true;
  throw new Error("Injected post-health failure.");
};
await runRegisteredCandidateForTest(candidate, options);
if (fault === "after-health") assert.equal(faultReached, true, "post-health rollback fault was not reached");
