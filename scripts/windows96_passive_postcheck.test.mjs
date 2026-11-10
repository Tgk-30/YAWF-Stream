import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createFileRecorder, sanitizedEvent } from "./windows_native_observer_preload.mjs";
import { TARGET_NAME, checkEvidence, createBinding, inspectSource, reporterCollector, runPassiveTest, summarizeTest, unavailableScanner } from "./windows96_passive_postcheck.mjs";

const runtime = { nodeVersion: "v24.22.2", platform: "win32", arch: "x64" };
const sourceRevision = "a".repeat(40);
const secret = ["NEVER", "SERIALIZE", "private-path", "SID", "token", "https://example.invalid"].join("_");
const base = { diagnosticOnly: true, purpose: "cold_native_observer_total" };
const ready = () => sanitizedEvent({ phase: "recorder", outcome: "ready" });
const started = () => sanitizedEvent({ phase: "observer", outcome: "started" });
const terminal = () => sanitizedEvent({ phase: "observer", outcome: "policy_pass", elapsedMs: 7063.125, exitCode: 0,
  jsonValid: true, requestCount: 7, descriptorCount: 7, countMatches: true, identityMatches: true, policyPrivate: true });

function report(passed = true) {
  return { success: passed, numPassedTests: passed ? 1 : 0, numFailedTests: passed ? 0 : 1,
    numPendingTests: 1, numTotalTests: 2, raw: secret, testResults: [{ name: secret, assertionResults: [
      { fullName: TARGET_NAME, status: passed ? "passed" : "failed", failureMessages: [secret] },
      { fullName: secret, status: "skipped" },
    ] }] };
}

function writeRows(directory, name, rows) {
  writeFileSync(join(directory, name), rows.map(row => JSON.stringify(row) + "\n").join(""));
}

function evidence(directory, temp = tmpdir()) {
  writeRows(directory, "observer-100-0.jsonl", [ready()]);
  writeRows(directory, "observer-101-0.jsonl", [ready(), started(), terminal()]);
  return { directory, temp, sourceRevision, runtime, binding: createBinding(sourceRevision, runtime),
    runStatus: { ...base, childExitCode: 0, signalClass: 0, launchClass: 0, recorderUnavailable: false, reporterClass: 0, stderrPresent: false },
    testSummary: summarizeTest(report()) };
}

function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "yawf-native-observer-"));
  try { return run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("binds exact887 file SHA256s, Git blobs, frozen passive module, native script and runtime", () => {
  const binding = createBinding(sourceRevision, runtime);
  assert.equal(binding.productReferenceRevision, "887ae66714d1352e66be203cd837a3de0c12f036");
  assert.equal(binding.storageBlob, "b3dfbe8f1481690f0ca1a987629e6f15feb253b8");
  assert.equal(binding.appTestBlob, "28d0936e4e0498fe46250cbf6b2e26ab4fc1b2a9");
  assert.equal(binding.passiveSHA256, "459dc520b733ce9f2043b9f7d9940634c3983315dd432f65a8107d4ed1b07982");
  assert.equal(binding.nativeScriptSHA256, "0615dd99d91ed1883f3c6c502922b2ea345708b077676854628d5955d9f7dacc");
  assert.equal(binding.nativeTimeoutMs, 7000);
  assert.equal(binding.testTimeoutOverridden, false);
  assert.equal(binding.hookTimeoutOverridden, false);
  assert.equal(binding.nodeVersion, "v24.22.2");
});

test("rejects altered source or passive bytes and an unfrozen runtime", () => {
  for (const suffix of ["privateStorage.ts", "app.test.ts", "windows_native_observer_preload.mjs", "windows_native_observer_preload.test.mjs"]) {
    assert.throws(() => inspectSource(path => {
      const bytes = readFileSync(path);
      return String(path).endsWith(suffix) ? Buffer.concat([bytes, Buffer.from("\n")]) : bytes;
    }), /source binding failed/);
  }
  assert.throws(() => createBinding(sourceRevision, { ...runtime, nodeVersion: "v24.17.0" }), /runtime binding failed/);
  assert.throws(() => createBinding(sourceRevision, { ...runtime, platform: "linux" }), /runtime binding failed/);
});

test("extracts only scalar counts and fixed case status from private Vitest JSON", () => {
  for (const passed of [true, false]) {
    const value = summarizeTest(report(passed));
    assert.equal(value.valid, true);
    assert.equal(value.testOutcome, passed ? "passed" : "failed");
    assert.equal(value.total, 2);
    assert.equal(JSON.stringify(value).includes(secret), false);
  }
});

test("rejects missing, extra or inconsistent executed test cases", () => {
  const malformed = [null, {}, { ...report(), numPassedTests: 2 }, { ...report(), success: false }];
  const extra = report(); extra.testResults[0].assertionResults[1].status = "passed"; malformed.push(extra);
  const missing = report(); missing.testResults[0].assertionResults[0].fullName = secret; malformed.push(missing);
  for (const value of malformed) {
    const result = summarizeTest(value);
    assert.equal(result.valid, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("detects split unavailable markers while retaining no raw output", () => {
  const scanner = unavailableScanner();
  scanner.consume(Buffer.from(secret + '{"outcome":"record'));
  scanner.consume(Buffer.from('ing_unavailable"}' + secret));
  assert.equal(scanner.unavailable(), true);
  assert.equal(JSON.stringify(scanner).includes(secret), false);
});

test("consumes bounded reporter JSON in memory and exposes only allowlisted summary", () => {
  const collector = reporterCollector();
  const bytes = Buffer.from(JSON.stringify(report()));
  collector.consume(bytes.subarray(0, 17)); collector.consume(bytes.subarray(17));
  const value = collector.finish();
  assert.equal(value.reporterClass, 0);
  assert.equal(value.summary.valid, true);
  assert.equal(JSON.stringify(value).includes(secret), false);
  assert.equal(collector.finish(), value);
});

for (const [kind, payload, limit, expected] of [
  ["invalid JSON", secret, 1024, 1], ["extra bytes", JSON.stringify(report()) + secret, 4096, 1],
  ["oversize", JSON.stringify(report()), 64, 2], ["invalid schema", JSON.stringify({ raw: secret }), 4096, 3],
]) {
  test(`rejects reporter ${kind} with a fixed class and no raw data`, () => {
    const collector = reporterCollector(limit);
    collector.consume(Buffer.from(payload));
    const value = collector.finish();
    assert.equal(value.reporterClass, expected);
    assert.equal(value.summary.valid, false);
    assert.equal(JSON.stringify(value).includes(secret), false);
  });
}

test("accepts exactly two ready readers and one completed original-deadline observer", () => fixture(directory => {
  const result = checkEvidence(evidence(directory));
  assert.equal(result.valid, true);
  assert.equal(result.releaseQualification, false);
  assert.equal(result.observerInvocationCount, 1);
  assert.equal(result.terminal.elapsedMs, 7063.125);
  assert.equal(result.terminal.policyPrivate, true);
}));

for (const [outcome, fields] of [
  ["timeout", { timeoutClass: 1 }], ["launch_failure", { launchClass: 1 }],
  ["nonzero_exit", { exitCode: 23 }], ["other_failure", {}],
  ["json_invalid", { exitCode: 0, jsonValid: false }],
  ["shape_mismatch", { exitCode: 0, jsonValid: true, requestCount: 7, descriptorCount: 6, countMatches: false, identityMatches: false }],
  ["policy_fail", { exitCode: 0, jsonValid: true, requestCount: 7, descriptorCount: 7, countMatches: true, identityMatches: true, policyPrivate: false }],
  ["policy_error", { exitCode: 0, jsonValid: true, requestCount: 7, descriptorCount: 7, countMatches: true, identityMatches: true }],
]) {
  test(`retains classified ${outcome} without calling a failed test green`, () => fixture(directory => {
    const args = evidence(directory);
    args.testSummary = summarizeTest(report(false)); args.runStatus.childExitCode = 1;
    writeRows(directory, "observer-101-0.jsonl", [ready(), started(), sanitizedEvent({ phase: "observer", outcome, elapsedMs: 7063, ...fields })]);
    const result = checkEvidence(args);
    assert.equal(result.valid, true);
    assert.equal(result.terminal.outcome, outcome);
    assert.equal(result.testSummary.testOutcome, "failed");
    assert.equal(result.releaseQualification, false);
  }));
}

for (const kind of ["missing reader", "extra reader", "missing ready", "missing start", "missing outcome", "extra invocation", "unavailable", "truncated", "raw field", "bad identity", "invented JSON count"]) {
  test(`rejects ${kind} and serializes only a fixed invalid outcome`, () => fixture(directory => {
    const args = evidence(directory);
    let rows = [ready(), started(), terminal()];
    if (kind === "missing reader") rmSync(join(directory, "observer-100-0.jsonl"));
    if (kind === "extra reader") writeRows(directory, "observer-102-0.jsonl", [ready()]);
    if (kind === "missing ready") rows.shift();
    if (kind === "missing start") rows.splice(1, 1);
    if (kind === "missing outcome") rows.pop();
    if (kind === "extra invocation") rows.push(started(), terminal());
    if (kind === "unavailable") rows.push(sanitizedEvent({ phase: "recorder", outcome: "recording_unavailable" }));
    if (kind === "truncated") rows.push(sanitizedEvent({ phase: "recorder", outcome: "truncated", truncated: true }));
    if (kind === "raw field") rows[2].stderr = secret;
    if (kind === "bad identity") rows[2].identityMatches = false;
    if (kind === "invented JSON count") rows[2] = sanitizedEvent({ phase: "observer", outcome: "json_invalid", elapsedMs: 7,
      exitCode: 0, jsonValid: false, descriptorCount: 7 });
    writeRows(directory, "observer-101-0.jsonl", rows);
    const result = checkEvidence(args);
    assert.equal(result.valid, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }));
}

test("rejects unavailable streams, altered binding or mismatched process/test exit", () => fixture(directory => {
  const args = evidence(directory);
  args.runStatus.recorderUnavailable = true; assert.equal(checkEvidence(args).valid, false);
  args.runStatus.recorderUnavailable = false; args.runStatus.childExitCode = 1; assert.equal(checkEvidence(args).valid, false);
  args.runStatus.childExitCode = 0; args.binding.nativeTimeoutMs = 15000; assert.equal(checkEvidence(args).valid, false);
}));

test("runs the exact case once without timeout flags, drains raw output and preserves failure", async () => {
  const temp = mkdtempSync(join(tmpdir(), "passive-runner-"));
  let calls = 0;
  try {
    writeFileSync(join(temp, "windows96-passive-binding.json"), JSON.stringify(createBinding(sourceRevision, runtime)));
    const spawnImpl = (_file, args, options) => {
      calls += 1;
      assert.equal(args.includes(`^${TARGET_NAME}$`), true);
      assert.equal(args.some(arg => /testTimeout|hookTimeout/.test(arg)), false);
      assert.equal(args.some(arg => arg.startsWith("--outputFile")), false);
      assert.equal(options.env.YAWF_NATIVE_CHARACTERIZATION_DIR, undefined);
      assert.match(options.env.NODE_OPTIONS, /windows_native_observer_preload\.mjs$/);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify(report(false)));
        child.stderr.write(secret + '{"outcome":"recording_unavailable"}');
        child.emit("close", 1, null);
      });
      return child;
    };
    assert.equal(await runPassiveTest({ temp, sourceRevision, runtime, spawnImpl }), 1);
    assert.equal(calls, 1);
    assert.equal(readdirSync(temp).some(name => /raw|stdout|stderr|transcript/.test(name)), false);
    await assert.rejects(runPassiveTest({ temp, sourceRevision, runtime, spawnImpl }), error => error.code === "EEXIST");
    assert.equal(calls, 1);
    for (const file of ["run-status.json", "test-summary.json", "invocation.json"]) {
      assert.equal(readFileSync(join(temp, "windows96-passive-" + file), "utf8").includes(secret), false);
    }
    assert.equal(JSON.parse(readFileSync(join(temp, "windows96-passive-run-status.json"), "utf8")).recorderUnavailable, true);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

for (const finished of [true, false]) {
  test(`terminated fork worker leaves ${finished ? "complete" : "unfinished"} scalar evidence without exit finalization`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "yawf-native-observer-"));
    const recorder = createFileRecorder(directory, tmpdir()); recorder({ phase: "recorder", outcome: "ready" });
    const source = `import { createFileRecorder } from ${JSON.stringify(new URL("./windows_native_observer_preload.mjs", import.meta.url).href)};
      process.once("message", data => { const record = createFileRecorder(data.directory, data.temp);
        for (const row of data.rows) record(row); process.send("ready"); setInterval(() => {}, 60000); });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const closed = once(child, "close", { signal: AbortSignal.timeout(10_000) }); void closed.catch(() => {});
    try {
      const readyEvent = once(child, "message", { signal: AbortSignal.timeout(5000) });
      child.send({ directory, temp: tmpdir(), rows: finished ? [ready(), started(), terminal()] : [ready(), started()] });
      assert.equal((await readyEvent)[0], "ready"); child.kill("SIGKILL"); await closed;
      const args = { directory, temp: tmpdir(), sourceRevision, runtime, binding: createBinding(sourceRevision, runtime),
        runStatus: { ...base, childExitCode: 0, signalClass: 0, launchClass: 0, recorderUnavailable: false, reporterClass: 0, stderrPresent: false }, testSummary: summarizeTest(report()) };
      assert.equal(checkEvidence(args).valid, finished);
      assert.equal(readdirSync(directory).length, 2);
    } finally {
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
      await closed; rmSync(directory, { recursive: true, force: true });
    }
  });
}
