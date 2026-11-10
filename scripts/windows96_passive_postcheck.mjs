// Passive diagnostic only. No retry, deadline substitution or release verdict.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAX_EVENTS, loadObserverBinding, sanitizedEvent } from "./windows_native_observer_preload.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const TARGET_NAME = "DebridStreamer server disk-backed admin health caps the admin health audit-event count at 10,000";
export const REFERENCE_REVISION = "887ae66714d1352e66be203cd837a3de0c12f036";
const PURPOSE = "cold_native_observer_total";
const EXPECTED = {
  storageSHA256: "5efcee5df2815c7949376cd730f4d59ddb518c944d8fb8bf71453624562bd40d",
  storageBlob: "b3dfbe8f1481690f0ca1a987629e6f15feb253b8",
  appTestSHA256: "953b32d65362307fd8307b191b6e2209ee28c35e8b947781f391f50119b6e8c2",
  appTestBlob: "28d0936e4e0498fe46250cbf6b2e26ab4fc1b2a9",
  passiveSHA256: "459dc520b733ce9f2043b9f7d9940634c3983315dd432f65a8107d4ed1b07982",
  passiveTestsSHA256: "d1df05116f64decd6e0c6b1e5c7219ae0796a568591a963e5fb7455735c08631",
};
const PREFIX = "windows96-passive-";
const actualRuntime = () => ({ nodeVersion: process.version, platform: process.platform, arch: process.arch });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const blob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const base = () => ({ diagnosticOnly: true, purpose: PURPOSE });
const numeric = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;

export function inspectSource(read = readFileSync) {
  const storage = read(join(ROOT, "server/src/privateStorage.ts"));
  const app = read(join(ROOT, "server/test/app.test.ts"));
  const values = {
    storageSHA256: hash(storage), storageBlob: blob(storage), appTestSHA256: hash(app), appTestBlob: blob(app),
    passiveSHA256: hash(read(join(ROOT, "scripts/windows_native_observer_preload.mjs"))),
    passiveTestsSHA256: hash(read(join(ROOT, "scripts/windows_native_observer_preload.test.mjs"))),
  };
  if (!isDeepStrictEqual(values, EXPECTED)) throw new Error("Passive source binding failed.");
  const native = loadObserverBinding(storage.toString("utf8"));
  if (native == null) throw new Error("Passive native binding unavailable.");
  return { ...values, nativeScriptSHA256: native.sha256,
    postcheckSHA256: hash(read(fileURLToPath(import.meta.url))) };
}

export function createBinding(sourceRevision, runtime = actualRuntime(), read = readFileSync) {
  if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? "") || runtime.nodeVersion !== "v24.22.2" ||
      runtime.platform !== "win32" || runtime.arch !== "x64") throw new Error("Passive runtime binding failed.");
  return { ...base(), sourceRevision, productReferenceRevision: REFERENCE_REVISION,
    ...runtime, ...inspectSource(read), nativeTimeoutMs: 7000,
    testTimeoutOverridden: false, hookTimeoutOverridden: false, expectedReaders: 2 };
}

export function summarizeTest(report) {
  const invalid = { ...base(), valid: false, testOutcome: "unavailable", passed: null, failed: null, pending: null, total: null };
  try {
    if (!Array.isArray(report.testResults) || report.testResults.length !== 1) return invalid;
    const assertions = report.testResults[0].assertionResults;
    if (!Array.isArray(assertions)) return invalid;
    const selected = assertions.filter(value => value.fullName === TARGET_NAME);
    const active = assertions.filter(value => value.status === "passed" || value.status === "failed");
    if (selected.length !== 1 || active.length !== 1 || active[0] !== selected[0]) return invalid;
    if (assertions.some(value => !["passed", "failed", "pending", "skipped"].includes(value.status))) return invalid;
    const passed = selected[0].status === "passed" ? 1 : 0;
    const failed = 1 - passed;
    const pending = assertions.length - 1;
    if (report.numPassedTests !== passed || report.numFailedTests !== failed || report.numPendingTests !== pending ||
        report.numTotalTests !== assertions.length || report.success !== (passed === 1)) return invalid;
    return { ...base(), valid: true, testOutcome: passed ? "passed" : "failed", passed, failed, pending, total: assertions.length };
  } catch { return invalid; }
}

// Inspect a bounded sliding window, then discard raw process output. Only this
// fixed marker flag is retained, including markers split across stream chunks.
export function unavailableScanner() {
  let tail = "";
  let unavailable = false;
  return {
    consume(chunk) {
      const text = tail + chunk.toString("utf8");
      if (text.includes('"outcome":"recording_unavailable"')) unavailable = true;
      tail = text.slice(-64);
    },
    unavailable: () => unavailable,
  };
}

export function reporterCollector(limit = 16_777_216) {
  let chunks = [];
  let size = 0;
  let overflow = false;
  let result;
  return {
    consume(chunk) {
      if (overflow || result != null) return;
      if (size + chunk.length > limit) { overflow = true; chunks = []; return; }
      chunks.push(Buffer.from(chunk));
      size += chunk.length;
    },
    finish() {
      if (result != null) return result;
      let summary = summarizeTest(null);
      let reporterClass = overflow ? 2 : 1;
      if (!overflow) {
        try {
          summary = summarizeTest(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
          reporterClass = summary.valid ? 0 : 3;
        } catch { /* Fixed parse class only, never the parser's raw error. */ }
      }
      chunks = [];
      result = { reporterClass, summary };
      return result;
    },
  };
}

function regularJSON(path, maxBytes = 1_048_576) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error("Passive evidence unavailable.");
  return JSON.parse(readFileSync(path, "utf8"));
}
const save = (temp, name, value, flag = "wx") => writeFileSync(join(temp, PREFIX + name), JSON.stringify(value) + "\n", { flag, mode: 0o600 });
const load = (temp, name) => regularJSON(join(temp, PREFIX + name));

function ownedDirectory(directory, temp) {
  const output = resolve(directory);
  const parent = resolve(temp);
  const same = process.platform === "win32" ? dirname(output).toLowerCase() === parent.toLowerCase() : dirname(output) === parent;
  const stat = lstatSync(output);
  if (!same || !/^yawf-native-observer-[a-zA-Z0-9_-]+$/.test(basename(output)) ||
      !stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Passive directory unavailable.");
  return output;
}

function validSummary(value) {
  if (!value || value.valid !== true || !["passed", "failed"].includes(value.testOutcome) || !numeric(value.pending)) return false;
  return isDeepStrictEqual(value, { ...base(), valid: true, testOutcome: value.testOutcome,
    passed: value.testOutcome === "passed" ? 1 : 0, failed: value.testOutcome === "failed" ? 1 : 0,
    pending: value.pending, total: value.pending + 1 });
}

function terminalValid(row) {
  if (row.phase !== "observer" || row.elapsedMs == null) return false;
  if (["timeout", "launch_failure", "nonzero_exit", "other_failure"].includes(row.outcome)) {
    if ([row.jsonValid, row.requestCount, row.descriptorCount, row.countMatches, row.identityMatches, row.policyPrivate].some(value => value !== null)) return false;
    if (row.outcome === "timeout") return row.timeoutClass === 1 && row.launchClass === 0;
    if (row.outcome === "launch_failure") return row.timeoutClass === 0 && row.launchClass > 0;
    return row.timeoutClass === 0 && row.launchClass === 0 && (row.outcome === "nonzero_exit" ? row.exitCode != null && row.exitCode !== 0 : row.exitCode == null || row.exitCode === 0);
  }
  if (row.exitCode !== 0 || row.timeoutClass !== 0 || row.launchClass !== 0) return false;
  if (row.outcome === "json_invalid") return isDeepStrictEqual(row, sanitizedEvent({
    phase: "observer", outcome: "json_invalid", elapsedMs: row.elapsedMs, exitCode: 0, jsonValid: false,
  }));
  if (row.outcome === "shape_mismatch") return row.jsonValid === true && row.policyPrivate === null &&
    numeric(row.requestCount) && row.requestCount > 0 && (row.descriptorCount === null || numeric(row.descriptorCount)) &&
    row.countMatches === (row.descriptorCount === row.requestCount) && row.identityMatches === false;
  if (!["policy_pass", "policy_fail", "policy_error"].includes(row.outcome)) return false;
  return row.jsonValid === true && numeric(row.requestCount) && row.requestCount > 0 && row.descriptorCount === row.requestCount &&
    row.countMatches === true && row.identityMatches === true && row.policyPrivate === (row.outcome === "policy_error" ? null : row.outcome === "policy_pass");
}

export function checkEvidence({ directory, temp, binding, runStatus, testSummary, sourceRevision, runtime = actualRuntime() }) {
  const invalid = { ...base(), valid: false, outcome: "evidence_invalid" };
  try {
    if (!isDeepStrictEqual(binding, createBinding(sourceRevision, runtime)) || !validSummary(testSummary)) return invalid;
    if (typeof runStatus.stderrPresent !== "boolean" || !isDeepStrictEqual(runStatus, { ...base(), childExitCode: runStatus.childExitCode,
      signalClass: 0, launchClass: 0, recorderUnavailable: false, reporterClass: 0, stderrPresent: runStatus.stderrPresent }) || !numeric(runStatus.childExitCode) ||
      (runStatus.childExitCode === 0) !== (testSummary.testOutcome === "passed")) return invalid;
    const output = ownedDirectory(directory, temp);
    const names = readdirSync(output);
    if (names.length !== 2 || names.some(name => !/^observer-\d+-0\.jsonl$/.test(name))) return invalid;
    let starts = 0;
    let finishes = 0;
    let terminal;
    for (const name of names) {
      const path = join(output, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EVENTS * 2048) return invalid;
      const text = readFileSync(path, "utf8");
      if (!text.endsWith("\n")) return invalid;
      const rows = text.trimEnd().split("\n").map(line => JSON.parse(line));
      if (rows.length === 0 || rows.length > MAX_EVENTS || !isDeepStrictEqual(rows[0], sanitizedEvent({ phase: "recorder", outcome: "ready" }))) return invalid;
      let pending = false;
      for (const [index, row] of rows.entries()) {
        if (!isDeepStrictEqual(row, sanitizedEvent(row)) || row.truncated) return invalid;
        if (index === 0) continue;
        if (isDeepStrictEqual(row, sanitizedEvent({ phase: "observer", outcome: "started" }))) {
          if (pending) return invalid;
          pending = true;
          starts += 1;
        } else {
          if (!pending || !terminalValid(row)) return invalid;
          pending = false;
          finishes += 1;
          terminal = row;
        }
      }
      if (pending) return invalid;
    }
    if (starts !== 1 || finishes !== 1) return invalid;
    return { ...base(), valid: true, outcome: "evidence_complete", releaseQualification: false,
      readerCount: names.length, observerInvocationCount: starts, terminal, testSummary };
  } catch { return invalid; }
}

export async function runPassiveTest({ temp, sourceRevision, runtime = actualRuntime(), spawnImpl = spawn }) {
  const binding = createBinding(sourceRevision, runtime);
  if (!isDeepStrictEqual(load(temp, "binding.json"), binding)) throw new Error("Passive binding changed.");
  save(temp, "invocation.json", { ...base(), invocationCount: 1 });
  const directory = mkdtempSync(join(temp, "yawf-native-observer-"));
  save(temp, "locator.json", { directoryName: basename(directory) });
  const options = { ...process.env, YAWF_NATIVE_OBSERVER_DIR: directory,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(join(ROOT, "scripts/windows_native_observer_preload.mjs")).href}`.trim() };
  delete options.YAWF_NATIVE_CHARACTERIZATION_DIR;
  const scanner = unavailableScanner();
  const reporter = reporterCollector();
  let stderrPresent = false;
  let launchClass = 0;
  const child = spawnImpl(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "test/app.test.ts", "-t", `^${TARGET_NAME}$`,
    "--maxWorkers=1", "--no-file-parallelism", "--reporter=json"],
  { cwd: join(ROOT, "server"), env: options, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { scanner.consume(chunk); reporter.consume(chunk); });
  child.stderr.on("data", chunk => { stderrPresent ||= chunk.length > 0; scanner.consume(chunk); });
  child.on("error", error => { launchClass = new Map([["ENOENT", 1], ["EACCES", 2], ["ENOEXEC", 3], ["ENOTDIR", 4], ["EPERM", 5]]).get(error?.code) ?? 6; });
  const [code, signal] = await new Promise(resolveClose => child.once("close", (code, signal) => resolveClose([code, signal])));
  const { reporterClass, summary: testSummary } = reporter.finish();
  const runStatus = { ...base(), childExitCode: numeric(code) ? code : null,
    signalClass: signal == null ? 0 : signal === "SIGTERM" ? 1 : signal === "SIGKILL" ? 2 : 3,
    launchClass, recorderUnavailable: scanner.unavailable(), reporterClass, stderrPresent };
  save(temp, "run-status.json", runStatus);
  save(temp, "test-summary.json", testSummary);
  return numeric(code) && code <= 255 ? code : 1;
}

async function main() {
  const [mode, sourceRevision] = process.argv.slice(2);
  const temp = process.env.RUNNER_TEMP;
  if (mode === "--validate-source") {
    process.stdout.write(JSON.stringify({ ...base(), sourceMatchesReference: true, ...inspectSource() }) + "\n");
    return;
  }
  if (mode === "--bind") save(temp, "binding.json", createBinding(sourceRevision));
  else if (mode === "--run") process.exitCode = await runPassiveTest({ temp, sourceRevision });
  else if (mode === "--check") {
    let result = { ...base(), valid: false, outcome: "evidence_invalid" };
    try {
      const locator = load(temp, "locator.json");
      if (Object.keys(locator).join(",") !== "directoryName" || !/^yawf-native-observer-[a-zA-Z0-9_-]+$/.test(locator.directoryName)) throw new Error();
      if (!isDeepStrictEqual(load(temp, "invocation.json"), { ...base(), invocationCount: 1 })) throw new Error();
      result = checkEvidence({ directory: join(temp, locator.directoryName), temp, sourceRevision,
        binding: load(temp, "binding.json"), runStatus: load(temp, "run-status.json"), testSummary: load(temp, "test-summary.json") });
    } catch { /* Missing metadata is an invalid experiment, not a green test. */ }
    save(temp, "postcheck.json", result);
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.valid) process.exitCode = 1;
  } else throw new Error("Passive mode unavailable.");
}

if (process.argv[1] != null && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); }
  catch { process.stdout.write(JSON.stringify({ ...base(), valid: false, outcome: "diagnostic_unavailable" }) + "\n"); process.exitCode = 1; }
}
