import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as runtimeHarness from "./server_database_lease_docker_runtime.mjs";
import {
  BASELINE_IMAGE,
  BASELINE_SOURCE,
  BASELINE_VERSION,
  DockerCommandError,
  DockerCommandRunner,
  DockerApi,
  ResourceLedger,
  ROLE_LABEL,
  RUNTIME_LABEL,
  admitImageIdentity,
  assertCrossNamespace,
  assertOwnedLabels,
  assertReceiptPath,
  assertRestartIdentity,
  classifyBaselineRestart,
  classifyBusyExit,
  validateRuntimeEnvironment,
  waitBounded,
} from "./server_database_lease_docker_runtime.mjs";

const sourceRevision = "6".repeat(40);
const imageId = `sha256:${"a".repeat(64)}`;
const containerOne = "b".repeat(64);
const containerTwo = "c".repeat(64);
const sourceUrl = "https://github.com/Tgk-30/YAWF-Stream";

function admittedEnv(overrides = {}) {
  return {
    DS_DATABASE_LEASE_DOCKER_RUNTIME: "1",
    CI: "true",
    GITHUB_ACTIONS: "true",
    RUNNER_OS: "Linux",
    GITHUB_REPOSITORY: "Tgk-30/YAWF-Stream",
    GITHUB_ACTOR: "Tgk-30",
    GITHUB_REPOSITORY_OWNER: "Tgk-30",
    GITHUB_SHA: sourceRevision,
    GITHUB_RUN_ID: "1234",
    GITHUB_RUN_ATTEMPT: "2",
    RUNNER_TEMP: "/home/runner/work/_temp",
    ...overrides,
  };
}

function imageInfo({ id = imageId, user = "node", revision = sourceRevision, version = "2.3.64", source = sourceUrl, repoDigests = [] } = {}) {
  return {
    Id: id,
    RepoDigests: repoDigests,
    Config: {
      User: user,
      Labels: {
        "org.opencontainers.image.revision": revision,
        "org.opencontainers.image.version": version,
        "org.opencontainers.image.source": source,
      },
    },
  };
}

function executableProbeCodeForFixture({ procRoot, databasePath, healthUrl }) {
  if (typeof runtimeHarness.buildRuntimeStateProbeCode === "function") {
    return runtimeHarness.buildRuntimeStateProbeCode({ procRoot, databasePath, healthUrl });
  }
  const source = readFileSync(new URL("./server_database_lease_docker_runtime.mjs", import.meta.url), "utf8");
  const match = /const RUNTIME_STATE_CODE = String\.raw`([\s\S]*?)`;/u.exec(source);
  assert.ok(match, "frozen predecessor probe source was not found");
  return match[1]
    .replace("fetch('http://127.0.0.1:43110/api/health')", `fetch(${JSON.stringify(healthUrl)})`)
    .replace("fs.readdirSync('/proc')", `fs.readdirSync(${JSON.stringify(procRoot)})`)
    .replace("fs.readFileSync('/proc/'+pid+'/cmdline','utf8')", `fs.readFileSync(${JSON.stringify(`${procRoot}/`)}+pid+'/cmdline','utf8')`)
    .replace("const dbPath='/data/debridstreamer.sqlite'", `const dbPath=${JSON.stringify(databasePath)}`);
}

function runProbeFixture(processes) {
  const root = mkdtempSync(join(tmpdir(), "yawf-runtime-probe-"));
  try {
    const procRoot = join(root, "proc");
    mkdirSync(procRoot);
    const marker = "controlled-runtime-marker";
    const databasePath = join(root, "debridstreamer.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE runtime_lease_marker(id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    database.prepare("INSERT INTO runtime_lease_marker(id,value) VALUES(1,?)").run(marker);
    database.close();
    writeFileSync(`${databasePath}.server.lock`, "controlled-lease", { mode: 0o600 });
    for (const processFixture of processes) {
      const processRoot = join(procRoot, String(processFixture.pid));
      mkdirSync(processRoot);
      symlinkSync(processFixture.executable, join(processRoot, "exe"));
      writeFileSync(join(processRoot, "cmdline"), Buffer.from(`${processFixture.argv.join("\0")}\0`));
    }
    const healthUrl = `data:application/json,${encodeURIComponent(JSON.stringify({ ok: true, ready: true, version: "2.3.64" }))}`;
    const code = executableProbeCodeForFixture({ procRoot, databasePath, healthUrl });
    return spawnSync(process.execPath, ["-e", code, marker], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function realApplication(pid, script = "server/dist/index.cjs") {
  return { pid, executable: process.execPath, argv: ["node", script] };
}

function assertProbeProcessCountFailure(result) {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^RuntimeProbeProcessCountError$/m);
  assert.equal(result.stdout, "");
}

test("runtime admission is explicit, owner-bound, source-bound, and Linux-only", () => {
  assert.deepEqual(validateRuntimeEnvironment(admittedEnv()), {
    repository: "Tgk-30/YAWF-Stream",
    actor: "Tgk-30",
    sourceRevision,
    runId: "1234",
    runAttempt: "2",
    runnerTemp: "/home/runner/work/_temp",
  });

  for (const mutation of [
    { DS_DATABASE_LEASE_DOCKER_RUNTIME: "0" }, { CI: "false" }, { GITHUB_ACTIONS: "false" },
    { RUNNER_OS: "macOS" }, { GITHUB_REPOSITORY: "fork/YAWF-Stream" }, { GITHUB_ACTOR: "contributor" },
    { GITHUB_SHA: "main" }, { GITHUB_RUN_ID: "0" }, { GITHUB_RUN_ATTEMPT: "" }, { RUNNER_TEMP: "relative" },
  ]) {
    assert.throws(() => validateRuntimeEnvironment(admittedEnv(mutation)));
  }
});

test("receipt output is confined to the disposable runner directory", () => {
  assert.equal(
    assertReceiptPath("/home/runner/work/_temp/evidence/receipt.json", "/home/runner/work/_temp"),
    "/home/runner/work/_temp/evidence/receipt.json",
  );
  assert.throws(() => assertReceiptPath("/home/runner/work/receipt.json", "/home/runner/work/_temp"));
  assert.throws(() => assertReceiptPath("/home/runner/work/_temp-other/receipt.json", "/home/runner/work/_temp"));
});

test("production probe ignores docker-init argv and selects the real node child", () => {
  const fakeBin = mkdtempSync(join(tmpdir(), "yawf-runtime-bin-"));
  const fakeInit = join(fakeBin, "docker-init");
  writeFileSync(fakeInit, "fixture");
  try {
    const result = runProbeFixture([
      { pid: 1, executable: fakeInit, argv: ["/sbin/docker-init", "--", "node", "server/dist/index.cjs"] },
      realApplication(7),
    ]);
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    assert.equal(state.guestPid, 7);
    assert.deepEqual(state.health, { ok: true, ready: true, version: "2.3.64" });
    assert.equal(state.marker.matches, true);
    assert.match(state.marker.sha256, /^[a-f0-9]{64}$/);
    assert.match(state.lease.sha256, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("production probe rejects a node helper whose -e source names the app script", () => {
  assertProbeProcessCountFailure(runProbeFixture([
    { pid: 9, executable: process.execPath, argv: ["node", "-e", "const text='server/dist/index.cjs'"] },
  ]));
});

test("production probe rejects an app argv under the wrong executable", () => {
  assertProbeProcessCountFailure(runProbeFixture([
    { pid: 11, executable: "/bin/sh", argv: ["sh", "server/dist/index.cjs"] },
  ]));
});

test("production probe rejects multiple real application nodes", () => {
  assertProbeProcessCountFailure(runProbeFixture([realApplication(12), realApplication(13, "/app/server/dist/index.cjs")]));
});

test("production probe rejects an absent real application node", () => {
  assertProbeProcessCountFailure(runProbeFixture([]));
});

test("receipt stage and completed proofs survive a later sanitized failure", () => {
  const receipt = { runtime: { stage: "image-admission", completedStages: [], proofs: {} } };
  runtimeHarness.beginRuntimeStage(receipt, "candidate-pid1-owner");
  runtimeHarness.completeRuntimeStage(receipt, "candidate-pid1-owner", {
    guestPid: 1,
    health: { ok: true, ready: true, version: "2.3.64" },
    lease: { sha256: "a".repeat(64) },
  });
  runtimeHarness.beginRuntimeStage(receipt, "candidate-init-owner");
  runtimeHarness.recordRuntimeFailure(receipt, new Error("private diagnostic must not persist"));
  assert.equal(receipt.runtime.stage, "candidate-init-owner");
  assert.deepEqual(receipt.runtime.completedStages, ["candidate-pid1-owner"]);
  assert.equal(receipt.runtime.proofs["candidate-pid1-owner"].guestPid, 1);
  assert.deepEqual(receipt.failure, { name: "Error", phase: "candidate-init-owner" });
  assert.doesNotMatch(JSON.stringify(receipt), /private diagnostic/);
  assert.throws(() => runtimeHarness.beginRuntimeStage(receipt, "unbounded-private-stage"));
});

test("public lease proof omits raw producer text and hex", () => {
  const runtime = readFileSync(new URL("./server_database_lease_docker_runtime.mjs", import.meta.url), "utf8");
  assert.match(runtime, /"candidate-post-kill", \{\s+exitCode:[^\n]+\s+lease: publicLeaseProof\(killedLease\)/);
  assert.doesNotMatch(runtime, /"candidate-post-kill", \{\s+exitCode:[^\n]+\s+lease: killedLease/);
  const proof = runtimeHarness.publicLeaseProof({
    sha256: "b".repeat(64),
    size: 8192,
    uid: 1000,
    gid: 1000,
    mode: "600",
    text: "raw lease payload",
    hex: "726177206c65617365207061796c6f6164",
  });
  assert.deepEqual(proof, {
    sha256: "b".repeat(64),
    size: 8192,
    uid: 1000,
    gid: 1000,
    mode: "600",
  });
  assert.equal("text" in proof, false);
  assert.equal("hex" in proof, false);
});

test("candidate image admission requires immutable identity, OCI binding, and non-root user", () => {
  assert.deepEqual(admitImageIdentity(imageInfo(), {
    kind: "candidate", imageId, sourceRevision, version: "2.3.64",
  }), {
    imageId, user: "node", sourceRevision, version: "2.3.64", source: sourceUrl,
  });

  for (const mutation of [
    { id: "yawf:latest" }, { user: "root" }, { revision: "7".repeat(40) },
    { version: "2.3.63" }, { source: "https://github.com/fork/YAWF-Stream" },
  ]) {
    assert.throws(() => admitImageIdentity(imageInfo(mutation), {
      kind: "candidate", imageId, sourceRevision, version: "2.3.64",
    }));
  }
  assert.throws(() => admitImageIdentity(imageInfo(), {
    kind: "candidate", imageId: `sha256:${"d".repeat(64)}`, sourceRevision, version: "2.3.64",
  }));
});

test("baseline admission is exact and digest-pinned", () => {
  const baselineId = `sha256:${"e".repeat(64)}`;
  const info = imageInfo({
    id: baselineId,
    revision: BASELINE_SOURCE,
    version: BASELINE_VERSION,
    repoDigests: [BASELINE_IMAGE],
  });
  assert.equal(admitImageIdentity(info, {
    kind: "baseline", reference: BASELINE_IMAGE, sourceRevision: BASELINE_SOURCE, version: BASELINE_VERSION,
  }).imageId, baselineId);
  assert.throws(() => admitImageIdentity(info, {
    kind: "baseline", reference: "ghcr.io/tgk-30/yawf-stream:2.3.63", sourceRevision: BASELINE_SOURCE, version: BASELINE_VERSION,
  }));
  assert.throws(() => admitImageIdentity({ ...info, RepoDigests: [] }, {
    kind: "baseline", reference: BASELINE_IMAGE, sourceRevision: BASELINE_SOURCE, version: BASELINE_VERSION,
  }));
});

test("Docker runner bounds commands, propagates failures, and does not disclose captured output", () => {
  let invocation;
  const runner = new DockerCommandRunner((command, args, options) => {
    invocation = { command, args, options };
    return { status: 23, signal: null, stdout: "private-output", stderr: "private-error" };
  });
  assert.throws(() => runner.run(["inspect", "opaque"], { timeoutMs: 987 }), (error) => {
    assert.ok(error instanceof DockerCommandError);
    assert.equal(error.status, 23);
    assert.doesNotMatch(error.message, /private-output|private-error|opaque/);
    return true;
  });
  assert.equal(invocation.command, "docker");
  assert.equal(invocation.options.timeout, 987);
  assert.equal(invocation.options.stdio[0], "ignore");
  assert.equal(runner.run(["inspect"], { timeoutMs: 1, allowFailure: true }).status, 23);
  assert.throws(() => runner.run(["inspect"], { timeoutMs: 0 }));
});

test("Docker logs preserve stderr and wire one actual PID1 marker into busy classification", () => {
  let capturedArgs;
  const runner = new DockerCommandRunner((command, args, options) => {
    assert.equal(command, "docker");
    assert.equal(args[0], "logs");
    assert.equal(args.at(-1), containerOne);
    capturedArgs = args;
    return spawnSync(process.execPath, ["-e", [
      "process.stdout.write('YAWF_RUNTIME_GUEST_PID=1\\n')",
      "process.stderr.write('The YAWF Stream database is already open\\n')",
    ].join(";")], options);
  });
  const streams = new DockerApi(runner).logs(containerOne);
  assert.equal(streams.stdout, "YAWF_RUNTIME_GUEST_PID=1");
  assert.equal(streams.stderr, "The YAWF Stream database is already open");
  assert.deepEqual(capturedArgs, ["logs", "--tail", "200", containerOne]);
  assert.deepEqual(runtimeHarness.classifyPid1ContenderExit({
    containerInfo: { HostConfig: { PidMode: "", Init: false }, State: { ExitCode: 1 } },
    streams,
  }), { exitCode: 1, guestPid: 1, classification: "database-lease-busy" });

  for (const mutation of [
    { streams: { stdout: "", stderr: streams.stderr, combined: streams.stderr } },
    { streams: { stdout: `${streams.stdout}\n${streams.stdout}`, stderr: streams.stderr, combined: `${streams.stdout}\n${streams.stdout}\n${streams.stderr}` } },
    { streams: { stdout: "YAWF_RUNTIME_GUEST_PID=2", stderr: streams.stderr, combined: `YAWF_RUNTIME_GUEST_PID=2\n${streams.stderr}` } },
    { containerInfo: { HostConfig: { PidMode: "host", Init: false }, State: { ExitCode: 1 } } },
    { containerInfo: { HostConfig: { PidMode: "", Init: true }, State: { ExitCode: 1 } } },
    { containerInfo: { HostConfig: { PidMode: "", Init: false }, State: {} } },
  ]) {
    assert.throws(() => runtimeHarness.classifyPid1ContenderExit({
      containerInfo: { HostConfig: { PidMode: "", Init: false }, State: { ExitCode: 1 } },
      streams,
      ...mutation,
    }));
  }
});

test("Docker inspection maps only exact not-found output to absence", () => {
  const result = (stderr, status = 1, stdout = "") => ({ status, signal: null, stdout, stderr });
  const missingContainer = new DockerApi({ run: () => result(`Error: No such container: ${containerOne}`, 1, "[]") });
  assert.equal(missingContainer.inspectContainer(containerOne, true), null);
  const missingVolume = new DockerApi({ run: () => result("Error: get owned-volume: no such volume") });
  assert.equal(missingVolume.inspectVolume("owned-volume", true), null);

  for (const stderr of [
    "permission denied while connecting to the Docker daemon socket",
    "Cannot connect to the Docker daemon",
    `Error: No such container: ${containerOne}\nunexpected trailing diagnostic`,
  ]) {
    const api = new DockerApi({ run: () => result(stderr) });
    assert.throws(() => api.inspectContainer(containerOne, true), DockerCommandError);
  }
  const suspiciousStdout = new DockerApi({ run: () => result(`Error: No such container: ${containerOne}`, 1, "unexpected") });
  assert.throws(() => suspiciousStdout.inspectContainer(containerOne, true), DockerCommandError);
});

test("bounded polling accepts success and rejects an expired probe", async () => {
  let checks = 0;
  let time = 0;
  const result = await waitBounded({
    label: "success", timeoutMs: 20, intervalMs: 5,
    probe: () => ++checks,
    accept: (value) => value === 3,
    now: () => time,
    sleep: async (ms) => { time += ms; },
  });
  assert.equal(result, 3);
  assert.equal(checks, 3);

  checks = 0;
  time = 0;
  await assert.rejects(waitBounded({
    label: "failure", timeoutMs: 10, intervalMs: 4,
    probe: () => ++checks,
    accept: () => false,
    now: () => time,
    sleep: async (ms) => { time += ms; },
  }), /within 10ms/);
  assert.equal(checks, 3);
});

test("cross-namespace and same-container restart proofs reject identity and PID mutants", () => {
  const proof = { ownerId: containerOne, contenderId: containerTwo, ownerGuestPid: 1, contenderGuestPid: 1, ownerPidMode: "", contenderPidMode: "" };
  assert.doesNotThrow(() => assertCrossNamespace(proof));
  for (const mutation of [
    { contenderId: containerOne }, { ownerGuestPid: 9 }, { contenderGuestPid: 4 },
    { ownerPidMode: "host" }, { contenderPidMode: "container:owner" },
  ]) assert.throws(() => assertCrossNamespace({ ...proof, ...mutation }));
  assert.doesNotThrow(() => assertRestartIdentity(containerOne, containerOne));
  assert.throws(() => assertRestartIdentity(containerOne, containerTwo));
});

test("busy and negative baseline classifications require the exact observed failure", () => {
  assert.deepEqual(classifyBusyExit({ exitCode: 1, logs: "Database is already open by another process", guestPid: 1 }), {
    exitCode: 1, guestPid: 1, classification: "database-lease-busy",
  });
  assert.equal(classifyBaselineRestart({
    exitCode: 1, logs: "database is already open", lockText: "1\n", guestPid: 1,
  }).classification, "baseline-stale-pid1-lock-reproduced");
  for (const mutation of [
    { exitCode: 0 }, { logs: "generic startup timeout" }, { lockText: "2\n" }, { guestPid: 2 },
  ]) assert.throws(() => classifyBaselineRestart({
    exitCode: 1, logs: "database is already open", lockText: "1\n", guestPid: 1, ...mutation,
  }));
});

test("cleanup removes only exact labeled IDs and preserves control until cleanup", async () => {
  const runLabel = "123-1-deadbeef";
  const ledger = new ResourceLedger(runLabel);
  ledger.addVolume("control-volume", "owned-control-volume");
  ledger.addContainer("control-container", "owned-control-container", containerOne);
  const calls = [];
  const container = { Config: { Labels: { [RUNTIME_LABEL]: runLabel, [ROLE_LABEL]: "control-container" } }, State: { Running: true } };
  const volume = { Labels: { [RUNTIME_LABEL]: runLabel, [ROLE_LABEL]: "control-volume" } };
  const api = {
    inspectContainer: (id) => { assert.equal(id, containerOne); return container; },
    inspectVolume: (name) => { assert.equal(name, "owned-control-volume"); return volume; },
    stop: (id) => calls.push(["stop", id]),
    removeContainer: (id) => calls.push(["remove-container", id]),
    removeVolume: (name) => calls.push(["remove-volume", name]),
  };
  const receipt = await ledger.cleanup(api);
  assert.deepEqual(calls, [["stop", containerOne], ["remove-container", containerOne], ["remove-volume", "owned-control-volume"]]);
  assert.equal(receipt.errors.length, 0);
});

test("cleanup refuses a resource whose ownership label changed", async () => {
  const ledger = new ResourceLedger("expected");
  ledger.addContainer("candidate-owner", "owned-name", containerOne);
  let removed = false;
  await assert.rejects(ledger.cleanup({
    inspectContainer: () => ({ Config: { Labels: { [RUNTIME_LABEL]: "foreign", [ROLE_LABEL]: "candidate-owner" } }, State: { Running: false } }),
    removeContainer: () => { removed = true; },
  }), /cleanup was incomplete/);
  assert.equal(removed, false);
  assert.equal(ledger.cleanupReceipt.errors[0].id, containerOne);
});

test("cleanup treats Docker daemon inspection failure as failure, not absence", async () => {
  const ledger = new ResourceLedger("expected");
  ledger.addContainer("candidate-owner", "owned-name", containerOne);
  let removed = false;
  const api = new DockerApi({
    run: () => ({
      status: 1,
      signal: null,
      stdout: "",
      stderr: "permission denied while connecting to the Docker daemon socket",
    }),
  });
  api.removeContainer = () => { removed = true; };
  await assert.rejects(ledger.cleanup(api), (error) => {
    assert.match(error.message, /cleanup was incomplete/);
    assert.ok(error.cause instanceof DockerCommandError);
    return true;
  });
  assert.equal(removed, false);
  assert.equal(ledger.cleanupReceipt.containers.length, 0);
  assert.equal(ledger.cleanupReceipt.errors[0].error, "DockerCommandError");
});

test("workflow registers validation broadly but admits real runtime only for owner dispatch", () => {
  const workflow = readFileSync(new URL("../.github/workflows/server-database-lease-runtime.yml", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("./server_database_lease_docker_runtime.mjs", import.meta.url), "utf8");
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.doesNotMatch(workflow, /packages:\s*write|docker\/login-action|docker\s+(?:system\s+)?prune|--pid[= ]host|\/var\/run\/docker\.sock/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /github\.repository == 'Tgk-30\/YAWF-Stream'/);
  assert.match(workflow, /github\.actor == github\.repository_owner/);
  assert.match(workflow, /node-version:\s*["']?24/);
  assert.match(workflow, /org\.opencontainers\.image\.revision/);
  assert.match(workflow, /org\.opencontainers\.image\.version/);
  assert.match(workflow, /org\.opencontainers\.image\.source/);
  assert.match(workflow, /docker image inspect/);
  assert.match(workflow, /actions\/upload-artifact@/);
  assert.match(runtime, new RegExp(BASELINE_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(runtime, /docker\s+(?:system\s+)?prune|--pid[= ]host|\/var\/run\/docker\.sock/);
  assert.equal((runtime.match(/classifyPid1ContenderExit\(\{ containerInfo:/g) ?? []).length, 2);
  assert.doesNotMatch(runtime, /classifyBusyExit\(\{[^}]*guestPid:\s*1/s);
  assert.match(runtime, /runtime: \{ stage: "image-admission", completedStages: \[\], proofs: \{\} \}/);
  assert.match(runtime, /beginRuntimeStage\(receipt, "candidate-init-owner"\);\s+const initOwner/);
  assert.match(runtime, /completed: false,[\s\S]*await runCandidate\(/);
  assert.match(runtime, /recordRuntimeFailure\(receipt, error\)/);
  assert.doesNotMatch(runtime, /receipt\.failure[\s\S]{0,120}error\.message/);
});

test("owned-label admission rejects role and run mutations", () => {
  const resource = { Labels: { [RUNTIME_LABEL]: "run", [ROLE_LABEL]: "role" } };
  assert.doesNotThrow(() => assertOwnedLabels(resource, "run", "role"));
  assert.throws(() => assertOwnedLabels(resource, "other", "role"));
  assert.throws(() => assertOwnedLabels(resource, "run", "other"));
});
