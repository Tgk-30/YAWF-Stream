// One cold-call latency characterization, not production or release acceptance.
import childProcess from "node:child_process";
import { appendFileSync, lstatSync, readFileSync, readdirSync, writeFileSync, writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { threadId } from "node:worker_threads";
import {
  MAX_EVENTS, classifyFailure, classifyOutput, loadObserverBinding,
  observerInvocationMatches, sanitizedEvent,
} from "./windows_native_observer_preload.mjs";

export const ORIGINAL_NATIVE_TIMEOUT_MS = 7000;
export const DIAGNOSTIC_NATIVE_TIMEOUT_MS = 15000;
const CLAIM_FILE = "cold-substitution.json";
const TERMINAL_OUTCOMES = new Set([
  "timeout", "launch_failure", "nonzero_exit", "other_failure", "json_invalid",
  "shape_mismatch", "policy_pass", "policy_fail", "policy_error",
]);
const UNAVAILABLE_OUTCOMES = new Set([
  "source_unavailable", "policy_unavailable", "instrumentation_unavailable", "recording_unavailable", "truncated",
]);
let binding = null;
try { binding = loadObserverBinding(); } catch { /* Fixed unavailable evidence below. */ }

export function characterizationBinding(expected = binding) {
  return {
    characterizationOnly: true,
    targetCase: "admin_health_audit_cap",
    originalNativeTimeoutMs: ORIGINAL_NATIVE_TIMEOUT_MS,
    effectiveDiagnosticTimeoutMs: DIAGNOSTIC_NATIVE_TIMEOUT_MS,
    originalTestTimeoutMs: 5000,
    originalHookTimeoutMs: 10000,
    diagnosticTestTimeoutMs: 30000,
    diagnosticHookTimeoutMs: 30000,
    originalScriptSHA256: /^[a-f0-9]{64}$/.test(expected?.sha256 ?? "") ? expected.sha256 : null,
  };
}

function eventValue(event, expected) {
  const coldSubstitution = event.coldSubstitution === true;
  return {
    ...characterizationBinding(expected), ...sanitizedEvent(event),
    coldSubstitution,
    coldSubstitutionCount: coldSubstitution ? 1 : 0,
    effectiveNativeTimeoutMs: coldSubstitution ? DIAGNOSTIC_NATIVE_TIMEOUT_MS : ORIGINAL_NATIVE_TIMEOUT_MS,
  };
}

export function ownedDirectory(directory, runnerTemp) {
  const output = resolve(directory);
  const parent = resolve(runnerTemp);
  const same = process.platform === "win32" ? dirname(output).toLowerCase() === parent.toLowerCase() : dirname(output) === parent;
  const stat = lstatSync(output);
  if (!same || !/^yawf-native-characterization-[a-zA-Z0-9_-]+$/.test(basename(output)) ||
      !stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Characterization directory unavailable.");
  return output;
}

// All processes/threads contend for this one exclusive slot. A loser uses the
// unchanged seven-second call; the slot is never removed or retried.
export function claimColdSubstitution(directory, expected = binding) {
  if (characterizationBinding(expected).originalScriptSHA256 == null) throw new Error("Characterization binding unavailable.");
  try {
    writeFileSync(join(directory, CLAIM_FILE), JSON.stringify({
      ...characterizationBinding(expected), coldSubstitutionCount: 1,
    }) + "\n", { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

export function createRecorder(directory, expected = binding, {
  append = appendFileSync, write = writeFileSync, fallback = line => writeSync(2, line),
} = {}) {
  const file = join(directory, `characterization-${process.pid}-${threadId}.jsonl`);
  let count = 0;
  let healthy = true;
  let truncated = false;
  let completed = false;
  const unavailable = () => {
    healthy = false;
    try { fallback(JSON.stringify(eventValue({ phase: "recorder", outcome: "recording_unavailable" }, expected)) + "\n"); } catch { /* Never replace a product result. */ }
  };
  try { write(file, "", { flag: "wx", mode: 0o600 }); } catch { unavailable(); }
  const record = event => {
    if (!healthy || count >= MAX_EVENTS || completed) return false;
    try {
      const value = count === MAX_EVENTS - 1
        ? { phase: "recorder", outcome: "truncated", truncated: true } : event;
      append(file, JSON.stringify(eventValue(value, expected)) + "\n");
      count += 1;
      truncated ||= value.truncated === true;
      return true;
    } catch { unavailable(); return false; }
  };
  record({ phase: "recorder", outcome: "ready" });
  return {
    record,
    complete() {
      if (completed) return;
      completed = true;
      try {
        write(file.replace(/\.jsonl$/, ".complete.json"), JSON.stringify({
          ...characterizationBinding(expected), healthy, truncated, recordCount: count,
        }) + "\n", { flag: "wx", mode: 0o600 });
      } catch { unavailable(); }
    },
  };
}

export function createCharacterizationObserver(original, {
  expected = binding, matches = (...args) => observerInvocationMatches(...args, expected),
  claim, record, getPolicy = () => null, now = () => performance.now(),
}) {
  const emit = value => { try { record(value); } catch { /* Postcheck rejects missing evidence. */ } };
  return function (...args) {
    let observed = false;
    let coldSubstitution = false;
    let started;
    let actual = args;
    try {
      observed = expected != null && args.length === 3 && matches(...args);
      if (observed) {
        coldSubstitution = claim();
        if (coldSubstitution) actual = [args[0], args[1], { ...args[2], timeout: DIAGNOSTIC_NATIVE_TIMEOUT_MS }];
        started = now();
        emit({ phase: "observer", outcome: "started", coldSubstitution });
      }
    } catch {
      emit({ phase: "recorder", outcome: "instrumentation_unavailable" });
      // Failure to claim cannot grant a second or unbound fifteen-second call.
    }
    const elapsed = () => started == null ? null : now() - started;
    let value;
    try { value = Reflect.apply(original, this, actual); }
    catch (error) {
      if (observed) {
        try { emit({ phase: "observer", elapsedMs: elapsed(), coldSubstitution, ...classifyFailure(error) }); }
        catch { emit({ phase: "recorder", outcome: "instrumentation_unavailable" }); }
      }
      throw error;
    }
    if (observed) {
      try {
        const elapsedMs = elapsed();
        emit({ phase: "observer", exitCode: 0, elapsedMs, coldSubstitution, ...classifyOutput(value, args[2].input, getPolicy()) });
      } catch { emit({ phase: "recorder", outcome: "instrumentation_unavailable" }); }
    }
    return value;
  };
}

// A successful check means the experiment was recorded, including a classified
// native failure. It cannot turn the actual test's failure into a pass.
export function checkEvidence(directory, runnerTemp, expected = binding) {
  const invalid = { characterizationOnly: true, valid: false, outcome: "evidence_invalid" };
  try {
    if (characterizationBinding(expected).originalScriptSHA256 == null) return invalid;
    const output = ownedDirectory(directory, runnerTemp);
    const names = readdirSync(output);
    const logs = names.filter(name => /^characterization-\d+-\d+\.jsonl$/.test(name));
    if (logs.length === 0 || names.length !== logs.length * 2 + 1 || !names.includes(CLAIM_FILE)) return invalid;
    const read = name => {
      const path = join(output, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EVENTS * 2048) throw new Error();
      return readFileSync(path, "utf8");
    };
    if (!isDeepStrictEqual(JSON.parse(read(CLAIM_FILE)), { ...characterizationBinding(expected), coldSubstitutionCount: 1 })) return invalid;
    let coldStarts = 0;
    let coldOutcomes = 0;
    let nativeInvocations = 0;
    let coldOutcome;
    for (const name of logs) {
      const rows = read(name).trim().split("\n").map(line => JSON.parse(line));
      const complete = JSON.parse(read(name.replace(/\.jsonl$/, ".complete.json")));
      if (!isDeepStrictEqual(complete, { ...characterizationBinding(expected), healthy: true, truncated: false, recordCount: rows.length }) ||
          rows.length === 0 || rows.length > MAX_EVENTS || rows[0].phase !== "recorder" || rows[0].outcome !== "ready") return invalid;
      let pending = null;
      for (const [index, row] of rows.entries()) {
        if (!isDeepStrictEqual(row, eventValue(row, expected)) || row.truncated || UNAVAILABLE_OUTCOMES.has(row.outcome)) return invalid;
        if (row.phase === "recorder") {
          if (index !== 0 || row.outcome !== "ready" || row.coldSubstitution) return invalid;
        } else if (row.outcome === "started") {
          if (pending != null) return invalid;
          pending = row;
          nativeInvocations += 1;
          if (row.coldSubstitution) coldStarts += 1;
        } else {
          if (pending == null || !TERMINAL_OUTCOMES.has(row.outcome) || pending.coldSubstitution !== row.coldSubstitution || row.elapsedMs == null) return invalid;
          pending = null;
          if (row.coldSubstitution) { coldOutcomes += 1; coldOutcome = row; }
        }
      }
      if (pending != null) return invalid;
    }
    if (coldStarts !== 1 || coldOutcomes !== 1) return invalid;
    return { characterizationOnly: true, valid: true, outcome: "evidence_complete",
      coldSubstitutionCount: coldStarts, nativeInvocationCount: nativeInvocations,
      recorderCount: logs.length, coldOutcome: coldOutcome.outcome,
      coldElapsedMs: coldOutcome.elapsedMs, policyPrivate: coldOutcome.policyPrivate };
  } catch { return invalid; }
}

if (process.env.YAWF_NATIVE_CHARACTERIZATION_DIR != null) {
  let recorder;
  try {
    const directory = ownedDirectory(process.env.YAWF_NATIVE_CHARACTERIZATION_DIR, process.env.RUNNER_TEMP);
    recorder = createRecorder(directory);
    process.once("exit", () => recorder.complete());
    if (binding == null) recorder.record({ phase: "recorder", outcome: "source_unavailable" });
    else if (process.env.YAWF_NATIVE_OBSERVER_DIR != null) recorder.record({ phase: "recorder", outcome: "instrumentation_unavailable" });
    else {
      let policy = null;
      childProcess.execFileSync = createCharacterizationObserver(childProcess.execFileSync, {
        record: recorder.record, claim: () => claimColdSubstitution(directory), getPolicy: () => policy,
      });
      syncBuiltinESMExports();
      try { policy = (await import(new URL("../server/src/privateStorage.ts", import.meta.url))).windowsStorageDescriptorIsPrivate; } catch { /* Fixed unavailable evidence below. */ }
      if (typeof policy !== "function") recorder.record({ phase: "recorder", outcome: "policy_unavailable" });
    }
  } catch {
    const event = { phase: "recorder", outcome: "instrumentation_unavailable" };
    try {
      if (recorder != null) recorder.record(event);
      else writeSync(2, JSON.stringify(eventValue(event, binding)) + "\n");
    } catch { /* Evidence postcheck fails closed; product execution is unchanged. */ }
  }
}

if (process.argv[1] != null && pathToFileURL(resolve(process.argv[1])).href === import.meta.url && process.argv[2] === "--check") {
  const result = checkEvidence(process.argv[3], process.env.RUNNER_TEMP);
  process.stdout.write(JSON.stringify(result) + "\n");
  if (!result.valid) process.exitCode = 1;
}
