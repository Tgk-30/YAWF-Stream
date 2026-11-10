import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { windowsStorageDescriptorIsPrivate } from "../server/src/privateStorage.ts";
import {
  MAX_EVENTS, classifyFailure, classifyOutput, createBoundedRecorder,
  createExecFileSyncObserver, loadObserverBinding, observerInvocationMatches, sanitizedEvent,
} from "./windows_native_observer_preload.mjs";

const preload = new URL("./windows_native_observer_preload.mjs", import.meta.url);
const binding = loadObserverBinding();
const env = { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\private-runner" };
const powershell = win32.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const secret = ["NEVER", "SERIALIZE", "private-path", "SID", "token", "https://example.invalid"].join("_");

function invocation() {
  return [powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", binding.encoded], {
    input: JSON.stringify([{ id: 0, kind: "file", path: secret }]),
    encoding: "utf8", timeout: 7000, maxBuffer: 256_000, windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { SYSTEMROOT: env.SystemRoot, USERPROFILE: env.USERPROFILE,
      PSModulePath: win32.join(win32.dirname(powershell), "Modules") },
  }];
}

function descriptor(overrides = {}) {
  return {
    id: 0, kind: "file", currentSid: "S-1-5-21-1234", ownerSid: "S-1-5-21-1234",
    trustedInstallerSid: null, directory: false, reparse: false, daclPresent: true, daclNull: false,
    rawAceTypes: [0], rules: [{ sid: "S-1-5-21-1234", allow: true, rights: 3,
      inheritOnly: false, objectInherit: false, containerInherit: false, noPropagate: false }],
    ...overrides,
  };
}

function harness(original, extras = {}) {
  const events = [];
  let clock = 100;
  const wrapped = createExecFileSyncObserver(original, {
    matches: (...args) => observerInvocationMatches(...args, binding, env),
    getPolicy: () => windowsStorageDescriptorIsPrivate,
    record: event => events.push(sanitizedEvent(event)),
    now: () => { const value = clock; clock += 8.125; return value; },
    ...extras,
  });
  return { wrapped, events };
}

test("binds the exact source literal including its final newline and UTF-16 hash", () => {
  const source = readFileSync(new URL("../server/src/privateStorage.ts", import.meta.url), "utf8");
  const script = source.match(/const DESCRIPTOR_OBSERVER = String\.raw`([\s\S]*?)`;/)[1];
  assert.equal(binding.encoded, Buffer.from(script, "utf16le").toString("base64"));
  assert.equal(binding.sha256, createHash("sha256").update(Buffer.from(script, "utf16le")).digest("hex"));
  assert.equal(loadObserverBinding("unrelated source"), null);
  assert.equal(loadObserverBinding(source + source), null);
  assert.equal(loadObserverBinding(source.replace("$ErrorActionPreference", "${unbound}")), null);
});

test("recognizes only the unchanged script, exact executable, flags, options and environment", () => {
  assert.equal(observerInvocationMatches(...invocation(), binding, env), true);
  const changes = [
    args => { args[0] = "powershell.exe"; },
    args => { args[0] = "C:\\elsewhere\\powershell.exe"; },
    args => { args[1][0] = "-nologo"; },
    args => { args[1].push("extra"); },
    args => { args[1][4] = Buffer.from("unrelated command", "utf16le").toString("base64"); },
    args => { args[1][4] = binding.encoded + "\n"; },
    args => { args[2].timeout = 7001; },
    args => { args[2].maxBuffer += 1; },
    args => { args[2].encoding = "buffer"; },
    args => { args[2].windowsHide = false; },
    args => { args[2].stdio[2] = "inherit"; },
    args => { args[2].shell = true; },
    args => { args[2].input = Buffer.from("[]"); },
    args => { args[2].env.PSModulePath = "untrusted"; },
    args => { args[2].env.EXTRA = secret; },
  ];
  for (const change of changes) {
    const args = invocation();
    change(args);
    let calls = 0;
    const { wrapped, events } = harness(() => { calls += 1; return secret; });
    assert.equal(observerInvocationMatches(...args, binding, env), false);
    assert.equal(wrapped(...args), secret);
    assert.equal(calls, 1);
    assert.deepEqual(events, []);
  }
  const { wrapped, events } = harness(() => secret);
  assert.equal(wrapped(...invocation(), { encoded: binding.encoded }), secret);
  assert.deepEqual(events, []);
});

test("passes the same original arguments, receiver and return value exactly once", () => {
  const args = invocation();
  const receiver = { owned: true };
  const value = new String(JSON.stringify([descriptor()]));
  let calls = 0;
  const { wrapped, events } = harness(function (...actual) {
    calls += 1;
    assert.equal(this, receiver);
    assert.equal(actual[0], args[0]);
    assert.equal(actual[1], args[1]);
    assert.equal(actual[2], args[2]);
    return value;
  });
  assert.equal(wrapped.apply(receiver, args), value);
  assert.equal(calls, 1);
  assert.equal(args[2].timeout, 7000);
  assert.equal(events[0].outcome, "started");
  assert.equal(events[1].outcome, "json_invalid");
  assert.equal(events[1].elapsedMs, 8.125);
});

test("uses the production policy helper and emits only aggregate booleans and counts", () => {
  const output = "\uFEFF" + JSON.stringify([descriptor({ unused: secret })]) + "\n";
  const { wrapped, events } = harness(() => output);
  assert.equal(wrapped(...invocation()), output);
  assert.equal(events[1].outcome, "policy_pass");
  assert.equal(events[1].jsonValid, true);
  assert.equal(events[1].countMatches, true);
  assert.equal(events[1].identityMatches, true);
  assert.equal(events[1].policyPrivate, true);
  assert.equal(events[1].descriptorCount, 1);
  assert.equal(events[1].requestCount, 1);
  const encoded = JSON.stringify(events);
  for (const forbidden of [secret, "S-1-5", "private-runner", "GetFileSecurityW", binding.encoded]) {
    assert.equal(encoded.includes(forbidden), false);
  }
});

for (const [name, output, outcome, jsonValid] of [
  ["malformed JSON", secret, "json_invalid", false],
  ["oversized JSON", " ".repeat(256_001), "json_invalid", false],
  ["non-array JSON", "{}", "shape_mismatch", true],
  ["wrong count", "[]", "shape_mismatch", true],
  ["wrong identity", JSON.stringify([descriptor({ id: 1 })]), "shape_mismatch", true],
  ["wrong kind", JSON.stringify([descriptor({ kind: "ancestor" })]), "shape_mismatch", true],
  ["null descriptor", "[null]", "shape_mismatch", true],
  ["policy rejection", JSON.stringify([descriptor({ reparse: true })]), "policy_fail", true],
]) {
  test(`classifies ${name} without changing a successful original return`, () => {
    const { wrapped, events } = harness(() => output);
    assert.equal(wrapped(...invocation()), output);
    assert.equal(events[1].outcome, outcome);
    assert.equal(events[1].jsonValid, jsonValid);
    assert.equal(events[1].exitCode, 0);
  });
}

test("separates unavailable policy and policy exceptions from native execution", () => {
  const output = JSON.stringify([descriptor()]);
  const input = invocation()[2].input;
  assert.equal(classifyOutput(output, input, null).outcome, "policy_unavailable");
  assert.equal(classifyOutput(output, input, () => { throw new Error(secret); }).outcome, "policy_error");
  assert.equal(classifyOutput(output, secret, windowsStorageDescriptorIsPrivate).outcome, "shape_mismatch");
});

for (const [code, status, outcome, timeoutClass, launchClass] of [
  ["ETIMEDOUT", null, "timeout", 1, 0],
  ["ENOENT", null, "launch_failure", 0, 1],
  ["EACCES", null, "launch_failure", 0, 2],
  ["ENOEXEC", null, "launch_failure", 0, 3],
  ["ENOTDIR", null, "launch_failure", 0, 4],
  ["EPERM", null, "launch_failure", 0, 5],
  [secret, 23, "nonzero_exit", 0, 0],
  [secret, null, "other_failure", 0, 0],
]) {
  test(`preserves the same thrown object for ${outcome} class ${timeoutClass}/${launchClass}`, () => {
    const error = Object.assign(new Error(secret), { code, status, stdout: secret, stderr: secret,
      command: secret, env: { secret } });
    let calls = 0;
    const { wrapped, events } = harness(() => { calls += 1; throw error; });
    assert.throws(() => wrapped(...invocation()), actual => actual === error);
    assert.equal(calls, 1);
    assert.equal(events[1].outcome, outcome);
    assert.equal(events[1].timeoutClass, timeoutClass);
    assert.equal(events[1].launchClass, launchClass);
    assert.equal(events[1].exitCode, status);
    assert.equal(JSON.stringify(events).includes(secret), false);
  });
}

test("records thrown primitives and hostile error getters without substituting an error", () => {
  assert.equal(classifyFailure(null).outcome, "other_failure");
  const error = { get code() { throw new Error(secret); } };
  const { wrapped, events } = harness(() => { throw error; });
  assert.throws(() => wrapped(...invocation()), actual => actual === error);
  assert.equal(events[1].outcome, "instrumentation_unavailable");
});

test("logging, timer, recognition and policy lookup failures cannot replace original results", () => {
  const value = JSON.stringify([descriptor()]);
  const error = new Error(secret);
  for (const extras of [
    { record: () => { throw new Error(secret); } },
    { now: () => { throw new Error(secret); } },
    { matches: () => { throw new Error(secret); } },
    { getPolicy: () => { throw new Error(secret); } },
  ]) {
    let calls = 0;
    const { wrapped } = harness(() => { calls += 1; return value; }, extras);
    assert.equal(wrapped(...invocation()), value);
    assert.equal(calls, 1);
    const throwing = harness(() => { throw error; }, extras).wrapped;
    assert.throws(() => throwing(...invocation()), actual => actual === error);
  }
});

test("serializes a fixed allowlist, finite monotonic duration and no extra object properties", () => {
  const event = sanitizedEvent({ phase: secret, outcome: secret, elapsedMs: Infinity, exitCode: secret,
    timeoutClass: secret, launchClass: secret, descriptor: secret, stderr: secret, input: secret,
    policyPrivate: secret, jsonValid: secret });
  assert.equal(event.phase, "recorder");
  assert.equal(event.outcome, "instrumentation_unavailable");
  assert.equal(event.elapsedMs, null);
  assert.equal(event.exitCode, null);
  assert.equal(JSON.stringify(event).includes(secret), false);
  assert.equal(sanitizedEvent({ elapsedMs: -1 }).elapsedMs, null);
});

test("caps each process/thread at 256 records with an explicit final truncation record", () => {
  const lines = [];
  const record = createBoundedRecorder(line => lines.push(line), assert.fail);
  for (let i = 0; i < MAX_EVENTS * 2; i += 1) record({ phase: "observer", outcome: "started", stdin: secret });
  assert.equal(lines.length, 256);
  assert.equal(lines.slice(0, -1).every(line => JSON.parse(line).truncated === false), true);
  assert.equal(JSON.parse(lines.at(-1)).truncated, true);
  assert.equal(JSON.parse(lines.at(-1)).outcome, "truncated");
  assert.equal(lines.join("").includes(secret), false);
});

test("exposes an unavailable recorder once, without retrying writes or leaking the error", () => {
  let calls = 0;
  const unavailable = [];
  const record = createBoundedRecorder(() => { calls += 1; throw new Error(secret); }, line => unavailable.push(line));
  record({ phase: "recorder", outcome: "ready" });
  record({ phase: "observer", outcome: "started" });
  assert.equal(calls, 1);
  assert.equal(unavailable.length, 1);
  assert.equal(JSON.parse(unavailable[0]).outcome, "recording_unavailable");
  assert.equal(unavailable[0].includes(secret), false);
  const doublyBroken = createBoundedRecorder(() => { throw new Error(secret); }, () => { throw new Error(secret); });
  assert.doesNotThrow(() => doublyBroken({ phase: "recorder", outcome: "ready" }));
});

test("NODE_OPTIONS preload follows actual Node children and workers and syncs ESM exports", () => {
  const directory = mkdtempSync(join(tmpdir(), "yawf-native-observer-"));
  try {
    const childCode = 'import cp, { execFileSync } from "node:child_process"; process.stdout.write(JSON.stringify(cp.execFileSync === execFileSync && execFileSync.name === ""));';
    const source = `
      import cp, { execFileSync, spawnSync } from "node:child_process";
      import { Worker } from "node:worker_threads";
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(childCode)}], { encoding: "utf8" });
      if (child.status !== 0 || child.stdout !== "true") process.exit(71);
      const worker = new Worker('import { parentPort } from "node:worker_threads"; import cp from "node:child_process"; parentPort.postMessage(cp.execFileSync.name === "");', { eval: true });
      const synced = await new Promise((resolve, reject) => { worker.on("message", resolve); worker.on("error", reject); });
      await new Promise(resolve => worker.on("exit", resolve));
      process.stdout.write(JSON.stringify({ main: cp.execFileSync === execFileSync && execFileSync.name === "", worker: synced }));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8", timeout: 10_000,
      env: { ...process.env, RUNNER_TEMP: tmpdir(), YAWF_NATIVE_OBSERVER_DIR: directory,
        NODE_OPTIONS: `--import=${preload.href}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { main: true, worker: true });
    const files = readdirSync(directory);
    assert.equal(files.length, 3);
    assert.equal(files.every(file => /^observer-\d+-\d+\.jsonl$/.test(file)), true);
    for (const file of files) {
      const events = readFileSync(join(directory, file), "utf8").trim().split("\n").map(JSON.parse);
      assert.deepEqual(events.map(event => event.outcome), ["ready"]);
      assert.equal(events[0].diagnosticOnly, true);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("invalid output ownership exposes unavailability but does not break the original process", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", 'process.stdout.write("unchanged")'], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, RUNNER_TEMP: tmpdir(), YAWF_NATIVE_OBSERVER_DIR: join(tmpdir(), secret),
      NODE_OPTIONS: `--import=${preload.href}` },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "unchanged");
  const events = result.stderr.trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map(event => event.outcome), ["recording_unavailable"]);
  assert.equal(result.stderr.includes(secret), false);
});
