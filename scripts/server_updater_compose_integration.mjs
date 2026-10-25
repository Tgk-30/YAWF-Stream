#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseUpdateManifest } from "../deploy/updater/yawf-server-update.mjs";

const repo = resolve(new URL("..", import.meta.url).pathname);
const candidateVersion = JSON.parse(readFileSync(join(repo, "server/package.json"), "utf8")).version;
assert.match(candidateVersion, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const candidateParts = candidateVersion.split(".").map(Number);
const failureVersion = `${candidateParts[0]}.${candidateParts[1]}.${candidateParts[2] + 1}`;
process.umask(0o077);
const args = process.argv.slice(2);
const digestIndex = args.indexOf("--candidate-digest");
const revisionIndex = args.indexOf("--source-revision");
const actualCandidateDigest = digestIndex >= 0 ? args[digestIndex + 1] : null;
const actualSourceRevision = revisionIndex >= 0 ? args[revisionIndex + 1] : null;
const actualMode = actualCandidateDigest != null || actualSourceRevision != null;
const root = actualMode ? `/var/lib/yawf-server-updater-ci/${process.pid}` : mkdtempSync(join(tmpdir(), "yawf-compose-updater-"));
if (actualMode) mkdirSync(root, { recursive: true, mode: 0o700 });
const project = `yawfupdater${process.pid}`;
const compose = join(root, "compose.yml");
const override = join(root, "override.yml");
const environment = join(root, ".env");
const backup = join(root, "backup");
mkdirSync(backup, { mode: 0o700 });

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}
function docker(...args) { return run("docker", args); }
function fileHash(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function composeRun(...args) { return docker("compose", "--project-name", project, "--project-directory", root, "--file", compose, "--file", override, ...args); }
function productionTransaction(digest, revision, fault) {
  return run("/usr/bin/flock", ["-n", "/run/yawf-server-updater/operation.lock", process.execPath,
    join(repo, "scripts/server_updater_transaction_driver.mjs"), digest, revision, fault]);
}
function image(name, version, ready = true) {
  const dir = join(root, name); mkdirSync(dir);
  writeFileSync(join(dir, "server.mjs"), `
import http from "node:http"; import fs from "node:fs";
fs.mkdirSync("/data",{recursive:true}); if(!fs.existsSync("/data/account.json"))fs.writeFileSync("/data/account.json",JSON.stringify({owner:"kept",settings:{theme:"midnight"}}));
http.createServer((q,r)=>{if(q.url==="/api/health"){r.setHeader("content-type","application/json");r.end(JSON.stringify({ok:true,ready:${ready},version:"${version}"}))}else{r.statusCode=404;r.end()}}).listen(43110,"0.0.0.0");
`);
  writeFileSync(join(dir, "Dockerfile"), "FROM node:24-bookworm-slim\nRUN mkdir -p /data /app && chown -R node:node /data /app\nCOPY --chown=node:node server.mjs /app/server.mjs\nVOLUME [\"/data\"]\nUSER node\nCMD [\"node\",\"/app/server.mjs\"]\n");
  docker("build", "--quiet", "--tag", `yawf-updater-fixture:${name}`, dir);
  return docker("image", "inspect", "--format", "{{.Id}}", `yawf-updater-fixture:${name}`);
}
function writeOverride(imageId) { writeFileSync(override, `services:\n  debridstreamer:\n    image: ${imageId}\n`); }
function container(service) { return composeRun("ps", "--quiet", service); }
function retainedContainer(service) {
  const ids = composeRun("ps", "--all", "--quiet", service).split(/\s+/).filter(Boolean);
  assert.equal(ids.length, 1, `expected exactly one retained ${service} container`);
  assert.match(ids[0], /^[a-f0-9]{12,64}$/);
  return ids[0];
}
function health() { return JSON.parse(docker("exec", container("debridstreamer"), "node", "-e", "fetch('http://127.0.0.1:43110/api/health').then(r=>r.text()).then(process.stdout.write.bind(process.stdout))")); }
async function waitHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { const value = health(); if (value.ok === true) return value; } catch {}
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("Fixture service did not become healthy.");
}
function volumeCopy(imageId, mode) {
  const source = mode === "copy" ? "/data" : "/backup/data";
  const destination = mode === "copy" ? "/backup/data" : "/data";
  docker("run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--cap-add", "CHOWN", "--security-opt", "no-new-privileges:true", "--user", "0:0",
    "--mount", `type=volume,source=${project}_data,target=/data${mode === "copy" ? ",readonly" : ""}`,
    "--mount", `type=bind,source=${backup},target=/backup`,
    "--mount", `type=bind,source=${join(repo, "deploy/updater/volume-copy.mjs")},target=/updater/volume-copy.mjs,readonly`,
    "--entrypoint", "node", imageId, "/updater/volume-copy.mjs", mode, source, destination);
}

try {
  if (actualCandidateDigest != null || actualSourceRevision != null) {
    assert.match(actualCandidateDigest ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(actualSourceRevision ?? "", /^[a-f0-9]{40}$/);
    const baselineDigest = "sha256:53db8ee061db988ff7aa8cdf69a71da92ee74b908aed2bcb367d78818218ba21";
    const baseline = `ghcr.io/tgk-30/yawf-stream@${baselineDigest}`;
    const candidate = `ghcr.io/tgk-30/yawf-stream@${actualCandidateDigest}`;
    parseUpdateManifest({ schemaVersion: 1, version: candidateVersion, sourceRevision: actualSourceRevision,
      image: { repository: "ghcr.io/tgk-30/yawf-stream", digest: actualCandidateDigest },
      debian: { name: `debridstreamer-server_${candidateVersion}_all.deb`, sha256: "0".repeat(64), size: 1 } }, candidateVersion);
    docker("pull", baseline); docker("pull", candidate);
    const publishedRevision = docker("image", "inspect", "--format", "{{ index .Config.Labels \"org.opencontainers.image.revision\" }}", candidate);
    assert.equal(publishedRevision, actualSourceRevision, "candidate source label does not match the requested revision");
    writeFileSync(compose, `name: ${project}\nservices:\n  debridstreamer:\n    image: ${baseline}\n    env_file: [.env]\n    volumes: [data:/data]\n  sentinel:\n    image: ${baseline}\n    command: [\"node\",\"-e\",\"setInterval(()=>{},100000)\"]\nvolumes:\n  data:\n`);
    writeFileSync(environment, "DS_SERVER_SECRET_KEY=fixture-secret-at-least-32-bytes-long\nDS_SERVER_SETUP_TOKEN=fixture-setup-token\nDS_SERVER_COOKIE_SECURE=false\nDS_SERVER_UPDATE_CHECK=false\nDS_SERVER_ENABLE_TRANSCODE=false\nDS_SERVER_LOGGER=false\n"); chmodSync(environment, 0o600);
    writeOverride(baseline); composeRun("up", "--detach");
    const oldHealth = await waitHealth(); assert.equal(oldHealth.ok, true);
    const sentinel = container("sentinel");
    const setup = `fetch('http://127.0.0.1:43110/api/auth/setup-owner',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'owner-password',displayName:'Owner',setupToken:'fixture-setup-token'})}).then(async r=>{if(!r.ok)throw Error(await r.text());process.stdout.write('created')})`;
    assert.equal(docker("exec", container("debridstreamer"), "node", "-e", setup), "created");
    docker("exec", container("debridstreamer"), "node", "-e", "require('fs').writeFileSync('/data/updater-account-settings-marker','owner:midnight')");
    docker("exec", container("debridstreamer"), "node", "-e", "require('fs').writeFileSync('/data/updater-private-fixture','private',{mode:0o600})");
    docker("exec", container("debridstreamer"), "node", "-e", "require('fs').writeFileSync('/data/updater-readonly-fixture',Buffer.alloc((64*1024*3)+17,0x5a),{mode:0o400})");
    const originalOwner = docker("exec", container("debridstreamer"), "node", "-e", "let s=require('fs').statSync('/data/debridstreamer.sqlite');process.stdout.write(`${s.uid}:${s.gid}`)");
    const originalReadonly = docker("exec", container("debridstreamer"), "node", "-e", "const f=require('fs'),c=require('crypto'),p='/data/updater-readonly-fixture',s=f.statSync(p);process.stdout.write(`${s.uid}:${s.gid}:${(s.mode&0o777).toString(8)}:${c.createHash('sha256').update(f.readFileSync(p)).digest('hex')}`)");
    const originalSchemaVersion = docker("exec", container("debridstreamer"), "node", "-e", "const{DatabaseSync}=require('node:sqlite');let d=new DatabaseSync('/data/debridstreamer.sqlite',{readOnly:true});process.stdout.write(String(d.prepare('PRAGMA user_version').get().user_version));d.close()");
    const originalEnvironmentHash = fileHash(environment);

    run("/usr/local/sbin/yawf-server-update", ["register", compose]);
    productionTransaction(actualCandidateDigest, actualSourceRevision, "after-health");
    await waitHealth();
    assert.equal(docker("inspect", "--format", "{{.Config.Image}}", container("debridstreamer")), baseline);
    assert.match(docker("exec", container("debridstreamer"), "cat", "/data/updater-account-settings-marker"), /owner:midnight/);
    assert.equal(docker("exec", container("debridstreamer"), "node", "-e", "let s=require('fs').statSync('/data/updater-private-fixture');process.stdout.write(`${s.uid}:${s.gid}:${(s.mode&0o777).toString(8)}`)"), `${originalOwner}:600`);
    assert.equal(docker("exec", container("debridstreamer"), "node", "-e", "const f=require('fs'),c=require('crypto'),p='/data/updater-readonly-fixture',s=f.statSync(p);process.stdout.write(`${s.uid}:${s.gid}:${(s.mode&0o777).toString(8)}:${c.createHash('sha256').update(f.readFileSync(p)).digest('hex')}`)"), originalReadonly);
    const mutation = spawnSync("docker", ["exec", container("debridstreamer"), "test", "-e", "/data/injected-post-install-mutation"]);
    assert.notEqual(mutation.status, 0, "post-install data mutation survived rollback");
    assert.equal(container("sentinel"), sentinel);
    assert.equal(fileHash(environment), originalEnvironmentHash, "opaque environment file was not restored byte-for-byte");
    assert.match(readFileSync(environment, "utf8"), /fixture-setup-token/);
    assert.equal(docker("exec", container("debridstreamer"), "node", "-e", "let s=require('fs').statSync('/data/debridstreamer.sqlite');process.stdout.write(`${s.uid}:${s.gid}`)"), originalOwner);
    assert.equal(docker("exec", container("debridstreamer"), "node", "-e", "const{DatabaseSync}=require('node:sqlite');let d=new DatabaseSync('/data/debridstreamer.sqlite',{readOnly:true});process.stdout.write(String(d.prepare('PRAGMA user_version').get().user_version));d.close()"), originalSchemaVersion);
    const rollbackPolicy = JSON.parse(readFileSync("/etc/yawf-server-updater/config.json", "utf8"));
    const rollbackStatus = JSON.parse(readFileSync("/var/lib/yawf-server-updater/public/status.json", "utf8"));
    assert.equal(rollbackPolicy.inhibitedVersion, candidateVersion, "post-health rollback did not inhibit the failed candidate");
    assert.equal(rollbackStatus.state, "rolled_back", "post-health fault did not complete a production rollback");
    assert.equal(rollbackStatus.candidateVersion, candidateVersion);
    assert.equal(existsSync("/var/lib/yawf-server-updater/journal.json"), false, "post-health rollback retained its journal");
    docker("exec", container("debridstreamer"), "node", "-e", "const{DatabaseSync}=require('node:sqlite');let d=new DatabaseSync('/data/debridstreamer.sqlite');d.exec('CREATE TABLE updater_rollback_probe(value TEXT)');d.prepare('INSERT INTO updater_rollback_probe VALUES (?)').run('writable');d.close()");
    composeRun("restart", "debridstreamer"); await waitHealth();
    assert.equal(docker("exec", container("debridstreamer"), "node", "-e", "const{DatabaseSync}=require('node:sqlite');let d=new DatabaseSync('/data/debridstreamer.sqlite',{readOnly:true});process.stdout.write(d.prepare('SELECT value FROM updater_rollback_probe').get().value);d.close()"), "writable");

    // An unexpired, non-revoked fixture stream must defer before image pull or
    // service stop. It uses only the isolated database's existing fixture profile.
    run("/usr/local/sbin/yawf-server-update", ["register", compose]);
    docker("exec", container("debridstreamer"), "node", "-e", "const{DatabaseSync}=require('node:sqlite');let d=new DatabaseSync('/data/debridstreamer.sqlite');let p=d.prepare('SELECT id FROM profiles ORDER BY id LIMIT 1').get().id;d.prepare('INSERT INTO stream_sessions(id,profile_id,encrypted_upstream_url,created_at,expires_at) VALUES (?,?,?,?,?)').run('updater-active-fixture',p,'fixture','2026-10-12T03:00:00.000Z','2099-01-01T00:00:00.000Z');d.close()");
    const activeContainer = container("debridstreamer");
    productionTransaction(actualCandidateDigest, actualSourceRevision, "none");
    assert.equal(container("debridstreamer"), activeContainer, "active playback did not defer the update");
    const activeStatus = JSON.parse(readFileSync("/var/lib/yawf-server-updater/public/status.json", "utf8"));
    assert.equal(activeStatus.state, "deferred");
    assert.match(activeStatus.detail, /Active playback/);
    docker("exec", container("debridstreamer"), "node", "-e", "const{DatabaseSync}=require('node:sqlite');let d=new DatabaseSync('/data/debridstreamer.sqlite');d.prepare('DELETE FROM stream_sessions WHERE id=?').run('updater-active-fixture');d.close()");

    // Production transaction fault paths must leave live data untouched and
    // bring the exact baseline back without ever entering volume restore.
    for (const fault of ["stop", "snapshot"]) {
      run("/usr/local/sbin/yawf-server-update", ["register", compose]);
      docker("exec", container("debridstreamer"), "node", "-e", `require('fs').writeFileSync('/data/${fault}-failure-marker','untouched')`);
      productionTransaction(actualCandidateDigest, actualSourceRevision, fault);
      await waitHealth();
      assert.equal(docker("inspect", "--format", "{{.Config.Image}}", container("debridstreamer")), baseline);
      assert.equal(docker("exec", container("debridstreamer"), "cat", `/data/${fault}-failure-marker`), "untouched");
      assert.equal(container("sentinel"), sentinel);
      const failedPolicy = JSON.parse(readFileSync("/etc/yawf-server-updater/config.json", "utf8"));
      const failedStatus = JSON.parse(readFileSync("/var/lib/yawf-server-updater/public/status.json", "utf8"));
      const journalPending = existsSync("/var/lib/yawf-server-updater/journal.json");
      process.stdout.write(JSON.stringify({ diagnostic: "pre-snapshot-fault", fault, state: failedStatus.state,
        inhibited: failedPolicy.inhibitedVersion === candidateVersion, journalPending }) + "\n");
      assert.equal(failedStatus.state, "failed", `${fault} fault did not report pre-snapshot failure`);
      assert.equal(failedStatus.candidateVersion, candidateVersion);
      assert.equal(failedPolicy.inhibitedVersion, candidateVersion, `${fault} fault did not inhibit the candidate`);
      assert.equal(journalPending, false, `${fault} fault retained a pending journal`);
    }
    run("/usr/local/sbin/yawf-server-update", ["register", compose]);
    docker("exec", container("debridstreamer"), "node", "-e", "require('fs').writeFileSync('/data/interrupted-marker','recover-me')");
    productionTransaction(actualCandidateDigest, actualSourceRevision, "interrupt");
    const interruptedContainer = retainedContainer("debridstreamer");
    const interruptedRunning = docker("inspect", "--format", "{{.State.Running}}", interruptedContainer);
    const interruptedStatus = docker("inspect", "--format", "{{.State.Status}}", interruptedContainer);
    const journalPath = "/var/lib/yawf-server-updater/journal.json";
    const policyPath = "/etc/yawf-server-updater/config.json";
    const interruptedJournal = JSON.parse(readFileSync(journalPath, "utf8"));
    const interruptedPolicy = JSON.parse(readFileSync(policyPath, "utf8"));
    const expectedRegistration = {
      composeFile: interruptedPolicy.composeFile,
      projectName: interruptedPolicy.projectName,
      volumeName: interruptedPolicy.volumeName,
      envPath: interruptedPolicy.envPath,
    };
    const registrationMatches = JSON.stringify(interruptedJournal.registration) === JSON.stringify(expectedRegistration);
    process.stdout.write(JSON.stringify({ diagnostic: "interrupted-transaction", phase: interruptedJournal.phase,
      containerStatus: interruptedStatus, running: interruptedRunning === "true", registrationMatches }) + "\n");
    assert.equal(interruptedRunning, "false", "interrupted fixture retained a running service container");
    assert.equal(interruptedStatus, "exited", "interrupted fixture did not retain an exited service container");
    assert.equal(interruptedJournal.phase, "snapshotted", "interrupted fixture did not retain a snapshotted journal");
    assert.deepEqual(interruptedJournal.registration, expectedRegistration, "interrupted journal was not bound to the current registration");
    assert.throws(() => run("/usr/local/sbin/yawf-server-update", ["register", compose]), /pending update journal/);
    productionTransaction(actualCandidateDigest, actualSourceRevision, "recover");
    assert.equal(existsSync(journalPath), false, "successful interrupted recovery retained the update journal");
    await waitHealth();
    assert.equal(docker("exec", container("debridstreamer"), "cat", "/data/interrupted-marker"), "recover-me");
    assert.equal(docker("inspect", "--format", "{{.Config.Image}}", container("debridstreamer")), baseline);

    // Complete the production transaction once without a fault. This proves
    // policy/status advancement and persistence on the actual candidate image.
    // Keep a separate stopped fixture snapshot solely to return this isolated
    // CI stack to its older baseline after the successful update assertion.
    composeRun("stop", "debridstreamer");
    copyFileSync(environment, join(backup, "successful-update-environment"));
    volumeCopy(baseline, "copy");
    composeRun("up", "--detach", "--no-deps", "debridstreamer");
    await waitHealth();
    run("/usr/local/sbin/yawf-server-update", ["register", compose]);
    productionTransaction(actualCandidateDigest, actualSourceRevision, "none");
    const successfulHealth = await waitHealth();
    assert.deepEqual({ ok: successfulHealth.ok, ready: successfulHealth.ready, version: successfulHealth.version }, { ok: true, ready: true, version: candidateVersion });
    const successfulPolicy = JSON.parse(readFileSync("/etc/yawf-server-updater/config.json", "utf8"));
    const successfulStatus = JSON.parse(readFileSync("/var/lib/yawf-server-updater/public/status.json", "utf8"));
    assert.equal(successfulPolicy.currentDigest, actualCandidateDigest);
    assert.equal(successfulPolicy.currentVersion, candidateVersion);
    assert.equal(successfulStatus.state, "updated");
    assert.equal(successfulStatus.currentVersion, candidateVersion);
    assert.equal(docker("exec", container("debridstreamer"), "node", "-e", "const{DatabaseSync}=require('node:sqlite');let d=new DatabaseSync('/data/debridstreamer.sqlite',{readOnly:true});process.stdout.write(d.prepare('SELECT value FROM updater_rollback_probe').get().value);d.close()"), "writable");
    assert.equal(container("sentinel"), sentinel);
    const publicDirectory = lstatSync("/var/lib/yawf-server-updater/public");
    const publicStatus = lstatSync("/var/lib/yawf-server-updater/public/status.json");
    assert.equal(`${publicDirectory.uid}:${(publicDirectory.mode & 0o777).toString(8)}`, "0:755", "public status directory is not root-owned mode 0755");
    assert.equal(`${publicStatus.uid}:${(publicStatus.mode & 0o777).toString(8)}`, "0:644", "public status file is not root-owned mode 0644");
    const nonRootStatus = JSON.parse(docker("run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true", "--user", "node",
      "--mount", "type=bind,source=/var/lib/yawf-server-updater/public,target=/updater-status,readonly",
      "--entrypoint", "node", candidate, "-e",
      "const f=require('fs');let value=JSON.parse(f.readFileSync('/updater-status/status.json','utf8'));let writeBlocked=false;try{f.writeFileSync('/updater-status/probe','no')}catch{writeBlocked=true}process.stdout.write(JSON.stringify({uid:process.getuid(),state:value.state,currentVersion:value.currentVersion,writeBlocked}))"));
    assert.ok(nonRootStatus.uid > 0, "status readability probe unexpectedly ran as root");
    assert.deepEqual({ state: nonRootStatus.state, currentVersion: nonRootStatus.currentVersion, writeBlocked: nonRootStatus.writeBlocked },
      { state: "updated", currentVersion: candidateVersion, writeBlocked: true });

    // Test-fixture reset only: deliberately return the isolated stack to the
    // immutable baseline and its stopped pre-success data/environment snapshot,
    // then register that observed baseline before drift QA.
    composeRun("stop", "debridstreamer");
    writeOverride(baseline);
    volumeCopy(baseline, "restore");
    copyFileSync(join(backup, "successful-update-environment"), environment);
    composeRun("up", "--detach", "--no-deps", "debridstreamer");
    await waitHealth();
    run("/usr/local/sbin/yawf-server-update", ["register", compose]);

    // A manual immutable redeploy after registration belongs to the operator.
    // The updater must detect policy drift without stopping or restoring it.
    writeOverride(candidate);
    composeRun("up", "--detach", "--no-deps", "debridstreamer");
    await waitHealth();
    docker("exec", container("debridstreamer"), "node", "-e", "require('fs').writeFileSync('/data/manual-redeploy-marker','preserve-newer')");
    const manualContainer = container("debridstreamer");
    productionTransaction(actualCandidateDigest, actualSourceRevision, "none");
    assert.equal(container("debridstreamer"), manualContainer, "registration drift stopped or recreated the operator deployment");
    assert.equal(docker("inspect", "--format", "{{.Config.Image}}", manualContainer), candidate);
    assert.equal(docker("exec", manualContainer, "cat", "/data/manual-redeploy-marker"), "preserve-newer");
    assert.equal(container("sentinel"), sentinel);
    process.stdout.write(JSON.stringify({ ok: true, mode: "actual-published-images", version: candidateVersion, digest: actualCandidateDigest,
      source: actualSourceRevision, baselineDigest, candidateDigest: actualCandidateDigest,
      sourceRevision: actualSourceRevision, digestVerified: true, sourceVerified: true,
      candidateHealthVerified: true, injectedRollbackVerified: true,
      activePlaybackDeferred: true, successfulUpdateVerified: true, stopFailureVerified: true,
      snapshotFailureVerified: true, interruptedRecoveryVerified: true,
      registrationDriftPreserved: true, ownershipAndDatabaseWriteVerified: true, otherServicePreserved: true,
      protectedFilesPreserved: true, umask077PublicStatusVerified: true, nonRootReadOnlyStatusVerified: true }) + "\n");
    process.exitCode = 0;
  } else {
  const oldImage = image("old", "2.3.8"); const newImage = image("new", candidateVersion); const badImage = image("bad", failureVersion, false);
  writeFileSync(compose, `services:\n  debridstreamer:\n    image: ${oldImage}\n    env_file: [.env]\n    volumes: [data:/data]\n  sentinel:\n    image: ${oldImage}\n    command: [\"node\",\"-e\",\"setInterval(()=>{},100000)\"]\nvolumes:\n  data:\n`);
  writeFileSync(environment, "OPAQUE_SECRET=not-printed\n"); chmodSync(environment, 0o600); writeOverride(oldImage);
  composeRun("up", "--detach");
  assert.equal(health().version, "2.3.8");
  const sentinel = container("sentinel");
  docker("exec", container("debridstreamer"), "node", "-e", "require('fs').writeFileSync('/data/private-key','secret',{mode:0o600})");
  docker("exec", container("debridstreamer"), "node", "-e", "require('fs').writeFileSync('/data/protected-payload',Buffer.alloc((64*1024*3)+17,0x5a),{mode:0o400})");
  const syntheticOwner = docker("exec", container("debridstreamer"), "node", "-e", "let s=require('fs').statSync('/data/private-key');process.stdout.write(`${s.uid}:${s.gid}`)");
  const syntheticProtected = docker("exec", container("debridstreamer"), "node", "-e", "const f=require('fs'),c=require('crypto'),p='/data/protected-payload',s=f.statSync(p);process.stdout.write(`${s.uid}:${s.gid}:${(s.mode&0o777).toString(8)}:${c.createHash('sha256').update(f.readFileSync(p)).digest('hex')}`)");

  composeRun("stop", "debridstreamer"); copyFileSync(environment, join(backup, "environment")); volumeCopy(oldImage, "copy");
  writeOverride(newImage); composeRun("up", "--detach", "--no-deps", "debridstreamer");
  assert.deepEqual(health(), { ok: true, ready: true, version: candidateVersion });
  assert.equal(container("sentinel"), sentinel, "service-only upgrade replaced another stack service");
  assert.match(docker("exec", container("debridstreamer"), "cat", "/data/account.json"), /midnight/);

  rmSync(backup, { recursive: true, force: true }); mkdirSync(backup, { mode: 0o700 });
  composeRun("stop", "debridstreamer"); copyFileSync(environment, join(backup, "environment")); volumeCopy(newImage, "copy");
  writeOverride(badImage); composeRun("up", "--detach", "--no-deps", "debridstreamer");
  assert.equal(health().ready, false, "failure fixture unexpectedly passed readiness");
  composeRun("stop", "debridstreamer"); writeOverride(newImage); volumeCopy(newImage, "restore"); copyFileSync(join(backup, "environment"), environment);
  composeRun("up", "--detach", "--no-deps", "debridstreamer");
  assert.deepEqual(health(), { ok: true, ready: true, version: candidateVersion });
  assert.equal(container("sentinel"), sentinel);
  assert.match(readFileSync(environment, "utf8"), /OPAQUE_SECRET/);
  assert.match(docker("exec", container("debridstreamer"), "cat", "/data/account.json"), /"owner":"kept"/);
  assert.equal(docker("exec", container("debridstreamer"), "node", "-e", "let s=require('fs').statSync('/data/private-key');process.stdout.write(`${s.uid}:${s.gid}:${(s.mode&0o777).toString(8)}`)"), `${syntheticOwner}:600`);
  assert.equal(docker("exec", container("debridstreamer"), "node", "-e", "const f=require('fs'),c=require('crypto'),p='/data/protected-payload',s=f.statSync(p);process.stdout.write(`${s.uid}:${s.gid}:${(s.mode&0o777).toString(8)}:${c.createHash('sha256').update(f.readFileSync(p)).digest('hex')}`)"), syntheticProtected);
  process.stdout.write(JSON.stringify({ ok: true, mode: "transaction-primitive", version: candidateVersion, digest: newImage,
    source: "generated-user-node-fixtures", upgraded: candidateVersion, rollbackFrom: failureVersion,
    fixtureDigestVerified: true, fixtureSourceVerified: true, ownershipPreserved: true,
    protectedFilesPreserved: true, otherServicePreserved: true }) + "\n");
  }
} finally {
  try { composeRun("down", "--volumes", "--remove-orphans"); } catch {}
  for (const tag of ["old", "new", "bad"]) try { docker("image", "rm", "--force", `yawf-updater-fixture:${tag}`); } catch {}
  rmSync(root, { recursive: true, force: true });
}
