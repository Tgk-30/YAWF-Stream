#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BASELINE_IMAGE = "ghcr.io/tgk-30/yawf-stream@sha256:dff4fb19338e1f2325abd05df683eb9150d9b7ec1d8cdfebdcc7051d78070507";
export const BASELINE_SOURCE = "30a1fffaef00f3d1e1d6f092490d757d15c205fa";
export const BASELINE_VERSION = "2.3.63";
export const RUNTIME_LABEL = "com.yawf.database-lease-runtime.run";
export const ROLE_LABEL = "com.yawf.database-lease-runtime.role";
export const EXPECTED_REPOSITORY = "Tgk-30/YAWF-Stream";
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const HEALTH_TIMEOUT_MS = 30_000;
export const EXIT_TIMEOUT_MS = 15_000;
const IMAGE_SOURCE = `https://github.com/${EXPECTED_REPOSITORY}`;
const ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export class DockerCommandError extends Error {
  constructor(args, status, signal = null) {
    super(`docker ${args[0] ?? "command"} failed (status=${status ?? "null"}, signal=${signal ?? "none"})`);
    this.name = "DockerCommandError";
    this.args = [...args];
    this.status = status;
    this.signal = signal;
  }
}

export class DockerCommandRunner {
  constructor(spawn = spawnSync) {
    this.spawn = spawn;
  }

  run(args, { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, allowFailure = false } = {}) {
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "docker command timeout must be positive and bounded");
    const result = this.spawn("docker", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error != null) throw new DockerCommandError(args, result.status, result.signal);
    const outcome = {
      status: result.status,
      signal: result.signal,
      stdout: String(result.stdout ?? "").trim(),
      stderr: String(result.stderr ?? "").trim(),
    };
    if (outcome.status !== 0 && !allowFailure) {
      throw new DockerCommandError(args, outcome.status, outcome.signal);
    }
    return outcome;
  }
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} was not valid JSON`, { cause: error });
  }
}

export class DockerApi {
  constructor(runner = new DockerCommandRunner()) {
    this.runner = runner;
  }

  inspectImage(reference) {
    const output = this.runner.run(["image", "inspect", "--format", "{{json .}}", reference]).stdout;
    return parseJson(output, "docker image inspection");
  }

  pull(reference) {
    this.runner.run(["pull", "--platform", "linux/amd64", reference], { timeoutMs: 300_000 });
  }

  inspectContainer(reference, allowMissing = false) {
    const result = this.runner.run(["container", "inspect", "--format", "{{json .}}", reference], {
      allowFailure: allowMissing,
    });
    if (result.status !== 0) {
      if (allowMissing && isExactDockerNotFound("container", reference, result)) return null;
      throw new DockerCommandError(["container", "inspect"], result.status, result.signal);
    }
    return parseJson(result.stdout, "docker container inspection");
  }

  inspectVolume(reference, allowMissing = false) {
    const result = this.runner.run(["volume", "inspect", "--format", "{{json .}}", reference], {
      allowFailure: allowMissing,
    });
    if (result.status !== 0) {
      if (allowMissing && isExactDockerNotFound("volume", reference, result)) return null;
      throw new DockerCommandError(["volume", "inspect"], result.status, result.signal);
    }
    return parseJson(result.stdout, "docker volume inspection");
  }

  assertNameAbsent(kind, name) {
    const current = kind === "container"
      ? this.inspectContainer(name, true)
      : this.inspectVolume(name, true);
    assert.equal(current, null, `${kind} name collision: ${name}`);
  }

  createVolume(name, labels) {
    this.assertNameAbsent("volume", name);
    const args = ["volume", "create"];
    for (const [key, value] of Object.entries(labels)) args.push("--label", `${key}=${value}`);
    args.push(name);
    const result = this.runner.run(args).stdout;
    assert.equal(result, name, "docker created an unexpected volume name");
    return name;
  }

  createContainer(args) {
    const nameIndex = args.indexOf("--name");
    assert.ok(nameIndex >= 0 && args[nameIndex + 1], "container create requires an exact name");
    this.assertNameAbsent("container", args[nameIndex + 1]);
    const id = this.runner.run(["create", ...args]).stdout;
    assert.match(id, CONTAINER_ID_PATTERN, "docker create did not return a full immutable container ID");
    return id;
  }

  start(id, attach = false) {
    return this.runner.run(["start", ...(attach ? ["--attach"] : []), id], {
      timeoutMs: attach ? 60_000 : DEFAULT_COMMAND_TIMEOUT_MS,
    }).stdout;
  }

  exec(id, args, timeoutMs = 10_000) {
    return this.runner.run(["exec", id, ...args], { timeoutMs }).stdout;
  }

  logs(id) {
    const result = this.runner.run(["logs", "--tail", "200", id]);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      combined: [result.stdout, result.stderr].filter(Boolean).join("\n"),
    };
  }

  kill(id) {
    this.runner.run(["kill", "--signal", "KILL", id]);
  }

  stop(id) {
    this.runner.run(["stop", "--time", "10", id], { timeoutMs: 20_000 });
  }

  removeContainer(id) {
    this.runner.run(["rm", id]);
  }

  removeVolume(name) {
    this.runner.run(["volume", "rm", name]);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isExactDockerNotFound(kind, reference, result) {
  if (result.status !== 1 || result.signal != null || !["", "[]"].includes(result.stdout)) return false;
  const escaped = escapeRegExp(reference);
  const patterns = kind === "container"
    ? [
        new RegExp(`^Error: No such (?:container|object): ${escaped}$`),
        new RegExp(`^Error response from daemon: No such container: ${escaped}$`),
      ]
    : [
        new RegExp(`^Error: No such volume: ${escaped}$`),
        new RegExp(`^Error(?::| response from daemon:) get ${escaped}: no such volume$`),
      ];
  return patterns.some((pattern) => pattern.test(result.stderr));
}

export function validateRuntimeEnvironment(env) {
  assert.equal(env.DS_DATABASE_LEASE_DOCKER_RUNTIME, "1", "disposable Docker runtime opt-in is required");
  assert.equal(env.CI, "true", "runtime requires CI=true");
  assert.equal(env.GITHUB_ACTIONS, "true", "runtime requires GitHub Actions");
  assert.equal(env.RUNNER_OS, "Linux", "runtime requires a fresh GitHub-hosted Linux runner");
  assert.equal(env.GITHUB_REPOSITORY, EXPECTED_REPOSITORY, "runtime repository is not admitted");
  assert.equal(env.GITHUB_ACTOR, env.GITHUB_REPOSITORY_OWNER, "runtime caller must be the repository owner");
  assert.match(env.GITHUB_SHA ?? "", REVISION_PATTERN, "runtime source revision is invalid");
  assert.match(env.GITHUB_RUN_ID ?? "", /^[1-9]\d*$/, "runtime run ID is invalid");
  assert.match(env.GITHUB_RUN_ATTEMPT ?? "", /^[1-9]\d*$/, "runtime run attempt is invalid");
  assert.ok((env.RUNNER_TEMP ?? "").startsWith("/"), "runner temp must be an absolute disposable path");
  return {
    repository: env.GITHUB_REPOSITORY,
    actor: env.GITHUB_ACTOR,
    sourceRevision: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    runnerTemp: env.RUNNER_TEMP,
  };
}

export function assertReceiptPath(receiptPath, runnerTemp) {
  const root = `${resolve(runnerTemp)}/`;
  const receipt = resolve(receiptPath);
  assert.ok(receipt.startsWith(root), "runtime receipt must stay inside the disposable runner temp directory");
  return receipt;
}

export function admitImageIdentity(info, expected) {
  assert.match(info.Id ?? "", ID_PATTERN, `${expected.kind} image ID is not immutable`);
  assert.equal(info.Config?.User, "node", `${expected.kind} image must run as non-root node`);
  const labels = info.Config?.Labels ?? {};
  assert.equal(labels["org.opencontainers.image.revision"], expected.sourceRevision, `${expected.kind} source label mismatch`);
  assert.equal(labels["org.opencontainers.image.version"], expected.version, `${expected.kind} version label mismatch`);
  assert.equal(labels["org.opencontainers.image.source"], IMAGE_SOURCE, `${expected.kind} source URL label mismatch`);
  if (expected.reference != null) {
    assert.match(expected.reference, /^ghcr\.io\/tgk-30\/yawf-stream@sha256:[a-f0-9]{64}$/, "published image is not canonical and digest-pinned");
    assert.ok((info.RepoDigests ?? []).includes(expected.reference), `${expected.kind} digest is not present in image metadata`);
  } else {
    assert.equal(expected.imageId, info.Id, `${expected.kind} local image ID changed before runtime`);
  }
  return {
    imageId: info.Id,
    user: info.Config.User,
    sourceRevision: labels["org.opencontainers.image.revision"],
    version: labels["org.opencontainers.image.version"],
    source: labels["org.opencontainers.image.source"],
  };
}

export function assertOwnedLabels(resource, runLabel, role) {
  const labels = resource?.Config?.Labels ?? resource?.Labels ?? {};
  assert.equal(labels[RUNTIME_LABEL], runLabel, "resource runtime ownership label mismatch");
  assert.equal(labels[ROLE_LABEL], role, "resource role ownership label mismatch");
}

export function assertCrossNamespace({ ownerId, contenderId, ownerGuestPid, contenderGuestPid, ownerPidMode, contenderPidMode }) {
  assert.notEqual(ownerId, contenderId, "owner and contender must be separate containers");
  assert.equal(ownerPidMode ?? "", "", "owner must use Docker's private PID namespace");
  assert.equal(contenderPidMode ?? "", "", "contender must use Docker's private PID namespace");
  assert.equal(ownerGuestPid, 1, "PID1 owner did not run the production node process as PID 1");
  assert.equal(contenderGuestPid, 1, "PID1 contender did not run the production node process as PID 1");
}

export function assertRestartIdentity(beforeId, afterId) {
  assert.match(beforeId, CONTAINER_ID_PATTERN);
  assert.equal(afterId, beforeId, "restart replaced the container instead of restarting the same identity");
}

export function classifyBusyExit({ exitCode, logs, guestPid }) {
  assert.ok(Number.isInteger(exitCode) && exitCode > 0, "database contender did not report a nonzero exit code");
  assert.equal(guestPid, 1, "database contender was not PID 1");
  assert.match(logs, /database is already open/i, "database contender did not fail because the lease was held");
  return { exitCode, guestPid, classification: "database-lease-busy" };
}

export function parseGuestPidMarker(streams) {
  const output = `${streams.stdout ?? ""}\n${streams.stderr ?? ""}`;
  assert.ok(output.length <= 4 * 1024 * 1024, "container logs exceeded the bounded capture size");
  const matches = output
    .split(/\r?\n/)
    .map((line) => /^YAWF_RUNTIME_GUEST_PID=([1-9]\d*)$/.exec(line))
    .filter((match) => match != null);
  assert.equal(matches.length, 1, "expected exactly one guest PID marker in actual container logs");
  const guestPid = Number(matches[0][1]);
  assert.ok(Number.isSafeInteger(guestPid), "guest PID marker was outside the safe integer range");
  return guestPid;
}

export function classifyPid1ContenderExit({ containerInfo, streams }) {
  assert.equal(containerInfo?.HostConfig?.PidMode ?? "", "", "contender must use a private PID namespace");
  assert.equal(containerInfo?.HostConfig?.Init ?? false, false, "PID1 contender must not use Docker init");
  return classifyBusyExit({
    exitCode: containerInfo?.State?.ExitCode,
    logs: streams.combined,
    guestPid: parseGuestPidMarker(streams),
  });
}

export function classifyBaselineRestart({ exitCode, logs, lockText, guestPid }) {
  assert.equal(lockText, "1\n", "baseline did not retain the stale PID1 lock payload");
  const busy = classifyBusyExit({ exitCode, logs, guestPid });
  return { ...busy, classification: "baseline-stale-pid1-lock-reproduced" };
}

export async function waitBounded({ probe, accept, timeoutMs, intervalMs = 250, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), label }) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, `${label} timeout must be positive`);
  assert.ok(Number.isSafeInteger(intervalMs) && intervalMs > 0, `${label} interval must be positive`);
  const deadline = now() + timeoutMs;
  let lastError = null;
  do {
    try {
      const value = await probe();
      if (accept(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  } while (now() < deadline);
  throw new Error(`${label} did not complete within ${timeoutMs}ms`, lastError == null ? undefined : { cause: lastError });
}

export class ResourceLedger {
  constructor(runLabel) {
    this.runLabel = runLabel;
    this.containers = [];
    this.volumes = [];
    this.cleanupReceipt = { containers: [], volumes: [], errors: [] };
  }

  addContainer(role, name, id) {
    assert.match(id, CONTAINER_ID_PATTERN);
    this.containers.push({ role, name, id, removed: false });
  }

  addVolume(role, name) {
    this.volumes.push({ role, name, removed: false });
  }

  async cleanup(api) {
    let firstCleanupError = null;
    for (const item of [...this.containers].reverse()) {
      if (item.removed) continue;
      try {
        const current = api.inspectContainer(item.id, true);
        if (current == null) {
          item.removed = true;
          this.cleanupReceipt.containers.push({ role: item.role, id: item.id, status: "already-absent" });
          continue;
        }
        assertOwnedLabels(current, this.runLabel, item.role);
        let stopped = false;
        if (current.State?.Running === true) {
          api.stop(item.id);
          stopped = true;
        }
        api.removeContainer(item.id);
        item.removed = true;
        this.cleanupReceipt.containers.push({ role: item.role, id: item.id, stopped, removed: true });
      } catch (error) {
        firstCleanupError ??= error;
        this.cleanupReceipt.errors.push({ kind: "container", role: item.role, id: item.id, error: error instanceof Error ? error.name : "Error" });
      }
    }
    for (const item of [...this.volumes].reverse()) {
      if (item.removed) continue;
      try {
        const current = api.inspectVolume(item.name, true);
        if (current == null) {
          item.removed = true;
          this.cleanupReceipt.volumes.push({ role: item.role, name: item.name, status: "already-absent" });
          continue;
        }
        assertOwnedLabels(current, this.runLabel, item.role);
        api.removeVolume(item.name);
        item.removed = true;
        this.cleanupReceipt.volumes.push({ role: item.role, name: item.name, removed: true });
      } catch (error) {
        firstCleanupError ??= error;
        this.cleanupReceipt.errors.push({ kind: "volume", role: item.role, name: item.name, error: error instanceof Error ? error.name : "Error" });
      }
    }
    if (this.cleanupReceipt.errors.length > 0) {
      throw new Error("owned Docker resource cleanup was incomplete", { cause: firstCleanupError });
    }
    return this.cleanupReceipt;
  }
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    assert.ok(name?.startsWith("--") && value != null, `invalid argument near ${name ?? "end"}`);
    assert.equal(values.has(name), false, `duplicate argument: ${name}`);
    values.set(name, value);
  }
  for (const name of values.keys()) {
    assert.ok(["--candidate-image", "--expected-version", "--expected-source", "--receipt"].includes(name), `unknown argument: ${name}`);
  }
  const candidateImage = values.get("--candidate-image");
  const expectedVersion = values.get("--expected-version");
  const expectedSource = values.get("--expected-source");
  const receipt = values.get("--receipt");
  assert.match(candidateImage ?? "", ID_PATTERN, "candidate image must be an immutable local image ID");
  assert.match(expectedVersion ?? "", VERSION_PATTERN, "candidate version is invalid");
  assert.match(expectedSource ?? "", REVISION_PATTERN, "candidate source revision is invalid");
  assert.ok(receipt?.startsWith("/"), "receipt path must be absolute");
  return { candidateImage, expectedVersion, expectedSource, receipt };
}

function labels(runLabel, role) {
  return { [RUNTIME_LABEL]: runLabel, [ROLE_LABEL]: role };
}

function labeledArgs(runLabel, role) {
  return Object.entries(labels(runLabel, role)).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

function baseContainerArgs({ runLabel, role, name, volume, image, readOnlyVolume = false, init = false, pidProof = null, command = null }) {
  const args = [
    "--name", name,
    ...labeledArgs(runLabel, role),
    "--network", "none",
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--mount", `type=volume,source=${volume},target=/data${readOnlyVolume ? ",readonly" : ""}`,
  ];
  if (init) args.push("--init");
  if (pidProof != null) args.push("--entrypoint", "/bin/sh");
  if (command?.entrypoint != null) args.push("--entrypoint", command.entrypoint);
  args.push(image);
  if (pidProof === "always") {
    args.push("-c", "printf 'YAWF_RUNTIME_GUEST_PID=%s\\n' \"$$\"; exec node server/dist/index.cjs");
  } else if (pidProof === "restart") {
    args.push("-c", "p=/data/.yawf-runtime-baseline-started; if [ -e \"$p\" ]; then printf 'YAWF_RUNTIME_GUEST_PID=%s\\n' \"$$\"; else : > \"$p\"; fi; exec node server/dist/index.cjs");
  } else if (command?.args != null) {
    args.push(...command.args);
  }
  return args;
}

function containerIdentity(info) {
  return {
    id: info.Id,
    running: info.State?.Running === true,
    status: info.State?.Status,
    exitCode: info.State?.ExitCode,
    hostPid: info.State?.Pid,
    pidMode: info.HostConfig?.PidMode ?? "",
    init: info.HostConfig?.Init === true,
    networkMode: info.HostConfig?.NetworkMode,
  };
}

async function runtimeStateProbeMain(config) {
  const fs = require("fs");
  const crypto = require("crypto");
  const path = require("path");
  const { DatabaseSync } = require("node:sqlite");
  const expected = process.argv[1];
  const health = await fetch(config.healthUrl).then(async (response) => {
    if (!response.ok) throw new Error(`health ${response.status}`);
    return response.json();
  });
  const self = process.pid;
  const pids = fs.readdirSync(config.procRoot).filter((value) => /^\d+$/.test(value)).map(Number);
  const apps = [];
  for (const pid of pids) {
    if (pid === self) continue;
    try {
      const root = `${config.procRoot}/${pid}`;
      const executable = fs.readlinkSync(`${root}/exe`);
      const argv = fs.readFileSync(`${root}/cmdline`).toString("utf8").split("\0");
      const script = argv[1];
      if (
        path.basename(executable) === "node" &&
        (script === "server/dist/index.cjs" || script === "/app/server/dist/index.cjs")
      ) {
        apps.push(pid);
      }
    } catch {
      // Processes can exit while /proc is being inspected.
    }
  }
  if (apps.length !== 1) {
    const error = new Error("expected exactly one production node application process");
    error.name = "RuntimeProbeProcessCountError";
    throw error;
  }
  const leasePath = `${config.databasePath}.server.lock`;
  const database = new DatabaseSync(config.databasePath, { readOnly: true });
  database.exec("PRAGMA query_only=ON");
  const row = database.prepare("SELECT value FROM runtime_lease_marker WHERE id=1").get();
  database.close();
  if (row?.value !== expected) throw new Error("marker mismatch");
  const stat = (target) => {
    const value = fs.statSync(target);
    return { uid: value.uid, gid: value.gid, mode: (value.mode & 0o777).toString(8), size: value.size };
  };
  const lease = fs.readFileSync(leasePath);
  process.stdout.write(JSON.stringify({
    health: { ok: health.ok, ready: health.ready, version: health.version },
    guestPid: apps[0],
    marker: { matches: true, sha256: crypto.createHash("sha256").update(row.value).digest("hex") },
    database: stat(config.databasePath),
    lease: { ...stat(leasePath), sha256: crypto.createHash("sha256").update(lease).digest("hex") },
  }));
}

export function buildRuntimeStateProbeCode({
  procRoot = "/proc",
  databasePath = "/data/debridstreamer.sqlite",
  healthUrl = "http://127.0.0.1:43110/api/health",
} = {}) {
  assert.ok(procRoot.startsWith("/"), "probe proc root must be absolute");
  assert.ok(databasePath.startsWith("/"), "probe database path must be absolute");
  assert.ok(
    healthUrl.startsWith("http://127.0.0.1:") || healthUrl.startsWith("data:application/json,"),
    "probe health URL must be loopback HTTP or an inline test fixture",
  );
  const config = JSON.stringify({ procRoot, databasePath, healthUrl });
  return `(${runtimeStateProbeMain.toString()})(${config}).catch((error)=>{process.stderr.write(error.name+'\\n');process.exit(1)});`;
}

const RUNTIME_STATE_CODE = buildRuntimeStateProbeCode();

const LEASE_STATE_CODE = String.raw`
const fs=require('fs'),crypto=require('crypto');const p='/data/debridstreamer.sqlite.server.lock',b=fs.readFileSync(p),s=fs.statSync(p);process.stdout.write(JSON.stringify({sha256:crypto.createHash('sha256').update(b).digest('hex'),size:s.size,uid:s.uid,gid:s.gid,mode:(s.mode&0o777).toString(8),text:b.toString('utf8'),hex:b.toString('hex')}));`;

const SEED_CODE = String.raw`
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/debridstreamer.sqlite');db.exec('CREATE TABLE runtime_lease_marker(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)');db.prepare('INSERT INTO runtime_lease_marker(id,value) VALUES(1,?)').run(process.argv[1]);db.close();`;

function createTrackedContainer(api, ledger, spec) {
  let id;
  try {
    id = api.createContainer(baseContainerArgs(spec));
  } catch (error) {
    // A bounded Docker CLI call can fail after the daemon created the object.
    // Recover only an exact-label match so cleanup never adopts a collision.
    try {
      const current = api.inspectContainer(spec.name, true);
      if (current != null) {
        assertOwnedLabels(current, spec.runLabel, spec.role);
        assert.match(current.Id ?? "", CONTAINER_ID_PATTERN);
        ledger.addContainer(spec.role, spec.name, current.Id);
      }
    } catch {
      // Preserve the original create failure. A foreign or uninspectable name
      // is deliberately not eligible for cleanup.
    }
    throw error;
  }
  ledger.addContainer(spec.role, spec.name, id);
  const info = api.inspectContainer(id);
  assertOwnedLabels(info, spec.runLabel, spec.role);
  assert.equal(info.HostConfig?.NetworkMode, "none", "container network must be disabled");
  assert.equal(info.HostConfig?.PidMode ?? "", "", "container must use a private PID namespace");
  assert.equal(info.Config?.User, "node", "container must run as non-root node");
  return { id, info };
}

function createTrackedVolume(api, ledger, runLabel, role, name) {
  let created;
  try {
    created = api.createVolume(name, labels(runLabel, role));
  } catch (error) {
    try {
      const current = api.inspectVolume(name, true);
      if (current != null) {
        assertOwnedLabels(current, runLabel, role);
        ledger.addVolume(role, name);
      }
    } catch {
      // Preserve the original create failure and never adopt foreign labels.
    }
    throw error;
  }
  ledger.addVolume(role, created);
  assertOwnedLabels(api.inspectVolume(created), runLabel, role);
  return created;
}

function runOneShot(api, ledger, spec) {
  const created = createTrackedContainer(api, ledger, spec);
  api.start(created.id, true);
  const info = api.inspectContainer(created.id);
  assert.equal(info.State?.Running, false, `${spec.role} helper did not exit`);
  assert.equal(info.State?.ExitCode, 0, `${spec.role} helper failed`);
  return created.id;
}

async function waitForState(api, id, marker) {
  return waitBounded({
    label: "production health",
    timeoutMs: HEALTH_TIMEOUT_MS,
    probe: () => {
      const raw = api.exec(id, ["node", "-e", RUNTIME_STATE_CODE, marker], 8_000);
      return parseJson(raw, "runtime state");
    },
    accept: (state) => state.health?.ok === true && state.health?.ready === true,
  });
}

async function waitForExit(api, id) {
  return waitBounded({
    label: "container exit",
    timeoutMs: EXIT_TIMEOUT_MS,
    probe: () => api.inspectContainer(id),
    accept: (info) => info.State?.Running === false,
  });
}

function assertState(state, expectedVersion, marker, expectedPid) {
  assert.deepEqual(state.health, { ok: true, ready: true, version: expectedVersion });
  assert.equal(state.marker.matches, true);
  assert.equal(state.marker.sha256, createHash("sha256").update(marker).digest("hex"));
  if (expectedPid === 1) assert.equal(state.guestPid, 1);
  else assert.ok(state.guestPid > 1, "--init owner did not move node below PID 1");
  assert.equal(state.lease.mode, "600");
}

function assertPersistentState(before, after) {
  assert.equal(after.marker.sha256, before.marker.sha256, "marker changed across lifecycle");
  assert.equal(after.lease.sha256, before.lease.sha256, "lease bytes changed across lifecycle");
  for (const field of ["uid", "gid", "mode"]) {
    assert.equal(after.database[field], before.database[field], `database ${field} changed`);
    assert.equal(after.lease[field], before.lease[field], `lease ${field} changed`);
  }
}

function stoppedLeaseState(api, ledger, { runLabel, role, name, volume, image }) {
  const id = runOneShot(api, ledger, {
    runLabel,
    role,
    name,
    volume,
    image,
    readOnlyVolume: true,
    command: { entrypoint: "node", args: ["-e", LEASE_STATE_CODE] },
  });
  const logs = api.logs(id);
  assert.equal(logs.stderr, "", "stopped lease helper wrote unexpected stderr");
  return parseJson(logs.stdout, "stopped lease state");
}

export function publicLeaseProof(lease) {
  return {
    sha256: lease.sha256,
    size: lease.size,
    uid: lease.uid,
    gid: lease.gid,
    mode: lease.mode,
  };
}

function assertControl(api, id, volume, runLabel, marker) {
  const container = api.inspectContainer(id);
  assertOwnedLabels(container, runLabel, "control-container");
  assert.equal(container.State?.Running, true, "unrelated control container was disturbed");
  const storedVolume = api.inspectVolume(volume);
  assertOwnedLabels(storedVolume, runLabel, "control-volume");
  const storedMarker = api.exec(id, ["node", "-e", "const fs=require('fs'),crypto=require('crypto'),p='/data/control-marker',b=fs.readFileSync(p);process.stdout.write(JSON.stringify({matches:b.toString()===process.argv[1],sha256:crypto.createHash('sha256').update(b).digest('hex')}))", marker]);
  const proof = parseJson(storedMarker, "control marker");
  assert.equal(proof.matches, true, "unrelated control volume marker changed");
  return { containerId: id, volume, running: true, preserved: true, marker: proof };
}

export const PUBLIC_RUNTIME_STAGES = Object.freeze([
  "image-admission",
  "control-initial",
  "baseline-runtime",
  "candidate-seed",
  "candidate-pid1-owner",
  "candidate-first-contender",
  "candidate-post-kill",
  "candidate-restart",
  "candidate-normal-stop",
  "candidate-init-owner",
  "candidate-second-contender",
  "candidate-complete",
  "control-final",
]);

export function beginRuntimeStage(receipt, stage) {
  assert.ok(PUBLIC_RUNTIME_STAGES.includes(stage), "runtime stage is not public and bounded");
  receipt.runtime.stage = stage;
}

export function completeRuntimeStage(receipt, stage, proof) {
  assert.equal(receipt.runtime.stage, stage, "completed runtime stage was not active");
  assert.equal(receipt.runtime.completedStages.includes(stage), false, "runtime stage completed twice");
  receipt.runtime.completedStages.push(stage);
  receipt.runtime.proofs[stage] = proof;
}

export function recordRuntimeFailure(receipt, error) {
  receipt.failure = {
    name: error instanceof Error ? error.name : "Error",
    phase: receipt.runtime.stage,
  };
}

async function runCandidate(api, ledger, context, imageId, marker, names, receipt) {
  beginRuntimeStage(receipt, "candidate-seed");
  const volume = createTrackedVolume(api, ledger, context.runLabel, "candidate-volume", names.candidateVolume);
  runOneShot(api, ledger, {
    runLabel: context.runLabel,
    role: "candidate-seed",
    name: names.candidateSeed,
    volume,
    image: imageId,
    command: { entrypoint: "node", args: ["-e", SEED_CODE, marker] },
  });
  completeRuntimeStage(receipt, "candidate-seed", { volume, seeded: true });

  beginRuntimeStage(receipt, "candidate-pid1-owner");
  const owner = createTrackedContainer(api, ledger, {
    runLabel: context.runLabel,
    role: "candidate-pid1-owner",
    name: names.candidateOwner,
    volume,
    image: imageId,
  });
  api.start(owner.id);
  const initial = await waitForState(api, owner.id, marker);
  assertState(initial, context.expectedVersion, marker, 1);
  const ownerIdentity = containerIdentity(api.inspectContainer(owner.id));
  completeRuntimeStage(receipt, "candidate-pid1-owner", {
    containerId: owner.id,
    guestPid: initial.guestPid,
    health: initial.health,
    data: initial.marker,
    lease: initial.lease,
    database: initial.database,
  });

  beginRuntimeStage(receipt, "candidate-first-contender");
  const contender = createTrackedContainer(api, ledger, {
    runLabel: context.runLabel,
    role: "candidate-pid1-contender-one",
    name: names.candidateContenderOne,
    volume,
    image: imageId,
    pidProof: "always",
  });
  api.start(contender.id);
  const contenderExit = await waitForExit(api, contender.id);
  const contenderLogs = api.logs(contender.id);
  const contenderBusy = classifyPid1ContenderExit({ containerInfo: contenderExit, streams: contenderLogs });
  assertCrossNamespace({
    ownerId: owner.id,
    contenderId: contender.id,
    ownerGuestPid: initial.guestPid,
    contenderGuestPid: contenderBusy.guestPid,
    ownerPidMode: ownerIdentity.pidMode,
    contenderPidMode: contenderExit.HostConfig?.PidMode,
  });
  assertState(await waitForState(api, owner.id, marker), context.expectedVersion, marker, 1);
  completeRuntimeStage(receipt, "candidate-first-contender", contenderBusy);

  beginRuntimeStage(receipt, "candidate-post-kill");
  api.kill(owner.id);
  const killed = await waitForExit(api, owner.id);
  assert.equal(killed.State?.ExitCode, 137, "owned candidate SIGKILL did not produce exit 137");
  const killedLease = stoppedLeaseState(api, ledger, {
    runLabel: context.runLabel,
    role: "candidate-post-kill-inspector",
    name: names.candidatePostKillInspector,
    volume,
    image: imageId,
  });
  assert.equal(killedLease.sha256, initial.lease.sha256, "SIGKILL changed persistent lease bytes");
  completeRuntimeStage(receipt, "candidate-post-kill", {
    exitCode: killed.State?.ExitCode,
    lease: publicLeaseProof(killedLease),
  });

  beginRuntimeStage(receipt, "candidate-restart");
  const beforeRestartId = owner.id;
  api.start(owner.id);
  const restarted = await waitForState(api, owner.id, marker);
  assertRestartIdentity(beforeRestartId, api.inspectContainer(owner.id).Id);
  assertState(restarted, context.expectedVersion, marker, 1);
  assertPersistentState(initial, restarted);
  completeRuntimeStage(receipt, "candidate-restart", {
    containerId: owner.id,
    sameIdentity: true,
    guestPid: restarted.guestPid,
    health: restarted.health,
    data: restarted.marker,
    lease: restarted.lease,
  });

  beginRuntimeStage(receipt, "candidate-normal-stop");
  api.stop(owner.id);
  const normallyStopped = await waitForExit(api, owner.id);
  assert.equal(normallyStopped.State?.ExitCode, 0, "normal candidate stop failed");
  completeRuntimeStage(receipt, "candidate-normal-stop", { exitCode: normallyStopped.State?.ExitCode });

  beginRuntimeStage(receipt, "candidate-init-owner");
  const initOwner = createTrackedContainer(api, ledger, {
    runLabel: context.runLabel,
    role: "candidate-init-owner",
    name: names.candidateInitOwner,
    volume,
    image: imageId,
    init: true,
  });
  api.start(initOwner.id);
  const initState = await waitForState(api, initOwner.id, marker);
  assertState(initState, context.expectedVersion, marker, "non-pid1");
  assertPersistentState(initial, initState);
  const initIdentity = containerIdentity(api.inspectContainer(initOwner.id));
  assert.equal(initIdentity.init, true, "non-PID1 owner did not use Docker init");
  completeRuntimeStage(receipt, "candidate-init-owner", {
    containerId: initOwner.id,
    guestPid: initState.guestPid,
    health: initState.health,
    data: initState.marker,
    lease: initState.lease,
  });

  beginRuntimeStage(receipt, "candidate-second-contender");
  const pid1Contender = createTrackedContainer(api, ledger, {
    runLabel: context.runLabel,
    role: "candidate-pid1-contender-two",
    name: names.candidateContenderTwo,
    volume,
    image: imageId,
    pidProof: "always",
  });
  api.start(pid1Contender.id);
  const pid1Exit = await waitForExit(api, pid1Contender.id);
  const pid1Busy = classifyPid1ContenderExit({ containerInfo: pid1Exit, streams: api.logs(pid1Contender.id) });
  assert.notEqual(initOwner.id, pid1Contender.id);
  assert.equal(initIdentity.pidMode, "");
  assert.equal(pid1Exit.HostConfig?.PidMode ?? "", "");
  assert.ok(initState.guestPid > 1);
  assert.equal(pid1Busy.guestPid, 1);
  assertState(await waitForState(api, initOwner.id, marker), context.expectedVersion, marker, "non-pid1");
  api.stop(initOwner.id);
  await waitForExit(api, initOwner.id);
  completeRuntimeStage(receipt, "candidate-second-contender", pid1Busy);

  const result = {
    volume,
    initial: { guestPid: initial.guestPid, health: initial.health, data: initial.marker, lease: initial.lease, database: initial.database },
    separatePidNamespaces: contenderBusy,
    sameContainerRestart: { containerId: owner.id, sameIdentity: true, health: restarted.health, guestPid: restarted.guestPid, data: restarted.marker, lease: restarted.lease },
    initOwner: { containerId: initOwner.id, guestPid: initState.guestPid, pid1Contender: pid1Busy, health: initState.health },
  };
  beginRuntimeStage(receipt, "candidate-complete");
  completeRuntimeStage(receipt, "candidate-complete", { completed: true });
  return result;
}

async function runBaseline(api, ledger, context, imageId, names) {
  const volume = createTrackedVolume(api, ledger, context.runLabel, "baseline-volume", names.baselineVolume);
  const owner = createTrackedContainer(api, ledger, {
    runLabel: context.runLabel,
    role: "baseline-pid1-owner",
    name: names.baselineOwner,
    volume,
    image: imageId,
    pidProof: "restart",
  });
  api.start(owner.id);
  const initial = await waitBounded({
    label: "baseline health",
    timeoutMs: HEALTH_TIMEOUT_MS,
    probe: () => parseJson(api.exec(owner.id, ["node", "-e", "const fs=require('fs');if(!fs.readFileSync('/proc/1/cmdline','utf8').includes('server/dist/index.cjs'))throw Error('node app is not pid1');fetch('http://127.0.0.1:43110/api/health').then(async r=>process.stdout.write(JSON.stringify({health:await r.json(),guestPid:1})))"]), "baseline health"),
    accept: (state) => state.health?.ok === true && state.health?.ready === true && state.health?.version === BASELINE_VERSION && state.guestPid === 1,
  });
  const runningInfo = containerIdentity(api.inspectContainer(owner.id));
  assert.equal(runningInfo.init, false);
  const initialLease = parseJson(api.exec(owner.id, ["node", "-e", LEASE_STATE_CODE]), "baseline lease");
  assert.equal(initialLease.text, "1\n", "baseline lock was not the PID1 text format");

  api.kill(owner.id);
  const killed = await waitForExit(api, owner.id);
  assert.equal(killed.State?.ExitCode, 137);
  const stoppedLease = stoppedLeaseState(api, ledger, {
    runLabel: context.runLabel,
    role: "baseline-post-kill-inspector",
    name: names.baselineInspector,
    volume,
    image: imageId,
  });
  assert.equal(stoppedLease.sha256, initialLease.sha256, "baseline SIGKILL changed the stale lock bytes");

  const beforeRestartId = owner.id;
  api.start(owner.id);
  const failed = await waitForExit(api, owner.id);
  assertRestartIdentity(beforeRestartId, failed.Id);
  const logs = api.logs(owner.id);
  const classification = classifyBaselineRestart({
    exitCode: failed.State?.ExitCode,
    logs: logs.combined,
    lockText: stoppedLease.text,
    guestPid: parseGuestPidMarker(logs),
  });
  return {
    volume,
    imageId,
    initialHealth: { ok: initial.health.ok, ready: initial.health.ready, version: initial.health.version },
    guestPid: initial.guestPid,
    lease: { sha256: initialLease.sha256, size: initialLease.size, mode: initialLease.mode, uid: initialLease.uid, gid: initialLease.gid },
    sameContainerRestart: { containerId: owner.id, sameIdentity: true, ...classification },
  };
}

function namesFor(runLabel) {
  const prefix = `yawf-lease-${runLabel}`;
  const entries = {
    controlVolume: `${prefix}-control-v`, controlContainer: `${prefix}-control-c`,
    baselineVolume: `${prefix}-baseline-v`, baselineOwner: `${prefix}-baseline-owner`, baselineInspector: `${prefix}-baseline-inspect`,
    candidateVolume: `${prefix}-candidate-v`, candidateSeed: `${prefix}-seed`, candidateOwner: `${prefix}-owner`,
    candidateContenderOne: `${prefix}-contender-one`, candidatePostKillInspector: `${prefix}-post-kill`,
    candidateInitOwner: `${prefix}-init-owner`, candidateContenderTwo: `${prefix}-contender-two`,
  };
  for (const name of Object.values(entries)) assert.match(name, /^[a-z0-9][a-z0-9_.-]{0,127}$/);
  return entries;
}

function writeReceipt(path, receipt) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export async function runRuntime({ options, env = process.env, api = new DockerApi() }) {
  const admitted = validateRuntimeEnvironment(env);
  assert.equal(options.expectedSource, admitted.sourceRevision, "candidate source must equal the checked-out caller SHA");
  const receiptPath = assertReceiptPath(options.receipt, admitted.runnerTemp);
  const suffix = randomBytes(4).toString("hex");
  const runLabel = `${admitted.runId}-${admitted.runAttempt}-${suffix}`;
  const names = namesFor(runLabel);
  const ledger = new ResourceLedger(runLabel);
  const receipt = {
    schemaVersion: 1,
    classification: "isolated-github-hosted-linux-docker-database-lease-runtime",
    repository: admitted.repository,
    sourceRevision: options.expectedSource,
    version: options.expectedVersion,
    runId: admitted.runId,
    runAttempt: admitted.runAttempt,
    candidate: null,
    baseline: null,
    control: null,
    runtime: { stage: "image-admission", completedStages: [], proofs: {} },
    cleanup: null,
    ok: false,
  };
  let primaryError = null;
  try {
    beginRuntimeStage(receipt, "image-admission");
    const candidateInfo = api.inspectImage(options.candidateImage);
    const candidateIdentity = admitImageIdentity(candidateInfo, {
      kind: "candidate",
      imageId: options.candidateImage,
      sourceRevision: options.expectedSource,
      version: options.expectedVersion,
    });
    api.pull(BASELINE_IMAGE);
    const baselineInfo = api.inspectImage(BASELINE_IMAGE);
    const baselineIdentity = admitImageIdentity(baselineInfo, {
      kind: "baseline",
      reference: BASELINE_IMAGE,
      sourceRevision: BASELINE_SOURCE,
      version: BASELINE_VERSION,
    });
    completeRuntimeStage(receipt, "image-admission", {
      candidateImageId: candidateIdentity.imageId,
      baselineImageId: baselineIdentity.imageId,
    });

    beginRuntimeStage(receipt, "control-initial");
    const controlVolume = createTrackedVolume(api, ledger, runLabel, "control-volume", names.controlVolume);
    const controlMarker = `unrelated-control-${admitted.runId}-${admitted.runAttempt}-${suffix}`;
    const control = createTrackedContainer(api, ledger, {
      runLabel,
      role: "control-container",
      name: names.controlContainer,
      volume: controlVolume,
      image: options.candidateImage,
      command: { entrypoint: "node", args: ["-e", "const fs=require('fs');fs.writeFileSync('/data/control-marker',process.argv[1],{flag:'wx'});setInterval(()=>{},60000)", controlMarker] },
    });
    api.start(control.id);
    receipt.control = await waitBounded({
      label: "control container",
      timeoutMs: EXIT_TIMEOUT_MS,
      probe: () => assertControl(api, control.id, controlVolume, runLabel, controlMarker),
      accept: (proof) => proof.marker?.matches === true,
    });
    completeRuntimeStage(receipt, "control-initial", receipt.control);

    const context = { runLabel, expectedVersion: options.expectedVersion };
    beginRuntimeStage(receipt, "baseline-runtime");
    receipt.baseline = {
      reference: BASELINE_IMAGE,
      sourceRevision: baselineIdentity.sourceRevision,
      version: baselineIdentity.version,
      ...(await runBaseline(api, ledger, context, baselineIdentity.imageId, names)),
    };
    completeRuntimeStage(receipt, "baseline-runtime", {
      guestPid: receipt.baseline.guestPid,
      initialHealth: receipt.baseline.initialHealth,
      sameContainerRestart: receipt.baseline.sameContainerRestart,
      lease: receipt.baseline.lease,
    });
    const marker = `database-lease-runtime-${admitted.runId}-${admitted.runAttempt}-${suffix}`;
    receipt.candidate = {
      imageId: candidateIdentity.imageId,
      sourceRevision: candidateIdentity.sourceRevision,
      version: candidateIdentity.version,
      user: candidateIdentity.user,
      completed: false,
    };
    Object.assign(
      receipt.candidate,
      await runCandidate(api, ledger, context, candidateIdentity.imageId, marker, names, receipt),
      { completed: true },
    );
    beginRuntimeStage(receipt, "control-final");
    receipt.control = assertControl(api, control.id, controlVolume, runLabel, controlMarker);
    completeRuntimeStage(receipt, "control-final", receipt.control);
    receipt.ok = true;
  } catch (error) {
    primaryError = error;
    recordRuntimeFailure(receipt, error);
  } finally {
    try {
      receipt.cleanup = await ledger.cleanup(api);
    } catch (error) {
      receipt.cleanup = ledger.cleanupReceipt;
      if (primaryError == null) primaryError = error;
      else receipt.cleanup.preservedPrimaryFailure = true;
    }
    receipt.ok = primaryError == null && receipt.ok === true;
    writeReceipt(receiptPath, receipt);
  }
  if (primaryError != null) throw primaryError;
  return receipt;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const receipt = await runRuntime({ options });
  process.stdout.write(`${JSON.stringify({ ok: receipt.ok, classification: receipt.classification, receipt: options.receipt })}\n`);
}

const invoked = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.name : "Error"}: Docker database lease runtime failed\n`);
    process.exitCode = 1;
  });
}
