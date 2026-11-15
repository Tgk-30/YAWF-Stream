#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const maxOutputBytes = 4 * 1024 * 1024;
const queueSource = "web/src/store/progressWriteQueue.ts";
const remoteTest = "src/storage/RemoteStore.test.ts";
const remoteSuite = "RemoteStore progress-only history timeout";
const cases = [
  {
    id: "remote-deadline",
    source: queueSource,
    from: "const PROGRESS_HISTORY_TIMEOUT_MS = 10_000;",
    to: "const PROGRESS_HISTORY_TIMEOUT_MS = 11_000;",
    test: remoteTest,
    suite: remoteSuite,
    title: "aborts a stalled queued progress PUT at 10 seconds and advances without changing ordinary history PUTs",
  },
  {
    id: "active-cancellation",
    source: queueSource,
    from: "if (this.active?.job.generation === generation) this.active.controller.abort();",
    to: "if (this.active?.job.generation === generation) void 0;",
    test: remoteTest,
    suite: remoteSuite,
    title: "aborts promptly when its owning profile generation is cancelled",
  },
  {
    id: "already-aborted-transport",
    source: "web/src/storage/RemoteStore.ts",
    from: "if (signal?.aborted) {",
    to: "if (false && signal?.aborted) {",
    test: remoteTest,
    suite: remoteSuite,
    title: "does not dispatch a history PUT with an already-aborted progress signal",
  },
  {
    id: "pending-cancellation",
    source: queueSource,
    from: "if (job.generation === generation) this.pending.delete(key);",
    to: "if (job.generation === generation) void 0;",
    test: remoteTest,
    suite: remoteSuite,
    title: "does not dispatch queued progress cancelled before its turn",
  },
  {
    id: "local-timeout-isolation",
    source: queueSource,
    from: "write: (signal, snapshot) => remote\n        ? withProgressWriteTimeout",
    to: "write: (signal, snapshot) => true\n        ? withProgressWriteTimeout",
    test: "src/store/AppStore.test.tsx",
    suite: "recordResume",
    title: "keeps Local Mode progress unbounded and passes no transport signal",
  },
  {
    id: "profile-drain-deadline",
    source: queueSource,
    from: "const PROFILE_PROGRESS_DRAIN_TIMEOUT_MS = 12_000;",
    to: "const PROFILE_PROGRESS_DRAIN_TIMEOUT_MS = 13_000;",
    test: "src/store/AppStore.test.tsx",
    suite: "reloadProfileData",
    title: "bounds the profile drain at 12 seconds while remote progress times out and advances",
  },
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function requireOnce(source, needle, label) {
  const index = source.indexOf(needle);
  assert.ok(index >= 0 && source.indexOf(needle, index + 1) === -1,
    `${label} must occur exactly once`);
  return index;
}

function runSelected(testCase, phase, caseReport, directory) {
  const fullName = `${testCase.suite} ${testCase.title}`;
  const resultPath = join(directory, `${testCase.id}-${phase}.json`);
  const result = caseReport[phase] = { report: resultPath, valid: false };
  const child = spawnSync(process.execPath, [
    join(root, "web/node_modules/vitest/vitest.mjs"),
    "run", testCase.test,
    "--testNamePattern", `^${escapeRegex(fullName)}$`,
    "--maxWorkers=1", "--no-file-parallelism",
    "--reporter=json", `--outputFile=${resultPath}`,
  ], {
    cwd: join(root, "web"),
    env: { ...process.env, TMPDIR: directory, NO_COLOR: "1", FORCE_COLOR: "0" },
    encoding: "utf8",
    timeout: 40_000,
    killSignal: "SIGKILL",
    maxBuffer: maxOutputBytes,
  });
  result.exitCode = child.status;
  result.signal = child.signal;
  result.processError = child.error?.code ?? null;
  result.stdoutTail = (child.stdout ?? "").slice(-2_048);
  result.stderrTail = (child.stderr ?? "").slice(-2_048);
  assert.equal(child.error, undefined, `${phase} process failed or exceeded its bounds`);
  assert.equal(child.signal, null, `${phase} process terminated by signal`);
  assert.equal(child.status, phase === "positive" ? 0 : 1, `${phase} exit code`);
  assert.ok(!/Unhandled Errors|Unhandled Rejection|Uncaught Exception|FATAL ERROR|Worker exited unexpectedly/i
    .test(`${child.stdout ?? ""}\n${child.stderr ?? ""}`), `${phase} runtime failure`);
  assert.ok(statSync(resultPath).size <= maxOutputBytes, `${phase} JSON exceeds its bound`);
  const bytes = readFileSync(resultPath);
  result.reportSha256 = sha256(bytes);
  const json = JSON.parse(bytes.toString("utf8"));
  assert.ok(Array.isArray(json.testResults) && json.testResults.length === 1,
    `${phase} must report exactly one test file`);
  const file = json.testResults[0];
  assert.equal(resolve(file.name), join(root, "web", testCase.test), `${phase} test file`);
  assert.equal(file.message, "", `${phase} must not have a file-level failure`);
  assert.ok(Array.isArray(file.assertionResults), `${phase} assertions are missing`);
  const selected = file.assertionResults.filter((test) => test.fullName === fullName);
  assert.equal(selected.length, 1, `${phase} must identify exactly one target assertion`);
  const executed = file.assertionResults.filter((test) => test.status === "passed" || test.status === "failed");
  assert.equal(executed.length, 1, `${phase} must execute only the target assertion`);
  assert.equal(executed[0], selected[0], `${phase} executed the wrong assertion`);
  const positive = phase === "positive";
  assert.equal(json.numPassedTests, positive ? 1 : 0, `${phase} passed count`);
  assert.equal(json.numFailedTests, positive ? 0 : 1, `${phase} failed count`);
  assert.equal(json.success, positive, `${phase} success flag`);
  assert.equal(file.status, positive ? "passed" : "failed", `${phase} file status`);
  assert.equal(selected[0].status, positive ? "passed" : "failed", `${phase} target status`);
  const failures = selected[0].failureMessages;
  assert.ok(Array.isArray(failures), `${phase} failure messages are missing`);
  if (positive) {
    assert.equal(failures.length, 0, "positive target must have no failures");
  } else {
    assert.ok(failures.length > 0 && failures.every((message) =>
      typeof message === "string" && /(?:^|\n)AssertionError:/.test(message) &&
      !/Test timed out|Hook timed out|Timeout of \d+ms exceeded/i.test(message)),
    "mutant must fail an assertion, not crash or time out");
  }
  result.selected = { fullName, status: selected[0].status, duration: selected[0].duration };
  result.numPassedTests = json.numPassedTests;
  result.numFailedTests = json.numFailedTests;
  result.valid = true;
}

function main() {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "this source-mutating check is CI-only");
  assert.equal(process.argv.length, 2, "this check accepts no arguments or mutation paths");
  assert.ok(process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP),
    "RUNNER_TEMP must be an absolute writable directory");
  const runnerTemp = realpathSync(process.env.RUNNER_TEMP);
  assert.ok(statSync(runnerTemp).isDirectory(), "RUNNER_TEMP must be a directory");
  // Creating and writing here verifies the runner's owned temporary storage.
  const directory = mkdtempSync(join(runnerTemp, "progress-write-regressions-"));
  const reportPath = join(runnerTemp, "progress-write-regressions.json");
  const paths = [...new Set(cases.flatMap((testCase) => [testCase.source, `web/${testCase.test}`]))];
  const originals = new Map(paths.map((path) => [path, readFileSync(join(root, path))]));
  const sourceHashes = () => Object.fromEntries(paths.map((path) =>
    [path, sha256(readFileSync(join(root, path)))]));
  const originalHashes = sourceHashes();
  const assertRestored = () => {
    for (const [path, bytes] of originals) {
      assert.ok(readFileSync(join(root, path)).equals(bytes), `${path} differs from its original bytes`);
    }
    assert.deepEqual(sourceHashes(), originalHashes, "source hashes must be restored");
  };
  const report = {
    schemaVersion: 1,
    scope: "SELECTED_SOURCE_REGRESSION_CAUSALITY_NOT_RUNTIME_OR_RELEASE_PROOF",
    source: process.env.GITHUB_SHA ?? null,
    node: process.version,
    startedAt: new Date().toISOString(),
    plannedCases: cases.length,
    originalHashes,
    cases: [],
    success: false,
  };
  const saveReport = () => writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  saveReport();
  try {
    for (const testCase of cases) {
      const caseReport = {
        id: testCase.id, source: testCase.source,
        fullName: `${testCase.suite} ${testCase.title}`, restored: false,
      };
      report.cases.push(caseReport);
      const path = join(root, testCase.source);
      const original = originals.get(testCase.source);
      let mutationAttempted = false;
      try {
        assertRestored();
        requireOnce(readFileSync(join(root, "web", testCase.test), "utf8"),
          `it("${testCase.title}",`, `${testCase.id} test title`);
        runSelected(testCase, "positive", caseReport, directory);
        assertRestored();
        // Re-read immediately before this one fixed mutation, never accept a
        // path or replacement from command-line arguments or the environment.
        const source = readFileSync(path, "utf8");
        assert.ok(Buffer.from(source).equals(original), `${testCase.id} source changed`);
        const index = requireOnce(source, testCase.from, `${testCase.id} source needle`);
        const mutated = Buffer.from(source.slice(0, index) + testCase.to + source.slice(index + testCase.from.length));
        assert.ok(!mutated.equals(original), `${testCase.id} mutation changed no bytes`);
        caseReport.originalSha256 = sha256(original);
        caseReport.mutantSha256 = sha256(mutated);
        mutationAttempted = true;
        writeFileSync(path, mutated);
        assert.equal(sha256(readFileSync(path)), caseReport.mutantSha256, `${testCase.id} mutation hash`);
        runSelected(testCase, "mutant", caseReport, directory);
      } catch (error) {
        caseReport.failure = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        if (mutationAttempted) writeFileSync(path, original);
        assertRestored();
        caseReport.restored = true;
        caseReport.restoredSha256 = sha256(readFileSync(path));
        saveReport();
      }
    }
    report.success = true;
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    report.completedAt = new Date().toISOString();
    report.finalHashes = sourceHashes();
    saveReport();
    console.log(`Progress regression report: ${reportPath}`);
  }
  console.log(`ok   progress write causal checks: ${cases.length} positives and ${cases.length} rejected mutants`);
}

try {
  main();
} catch (error) {
  console.error(`fail ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
