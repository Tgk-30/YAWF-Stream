// Diagnostic classification only, never storage acceptance or a retry. The
// original observer, arguments, options, return value and thrown error survive.
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { threadId } from "node:worker_threads";

export const MAX_EVENTS = 256;
const MAX_BUFFER = 256_000;
const POLICY_URL = new URL("../server/src/privateStorage.ts", import.meta.url);
const PHASES = new Set(["recorder", "observer"]);
const OUTCOMES = new Set([
  "ready", "source_unavailable", "policy_unavailable", "instrumentation_unavailable",
  "recording_unavailable", "truncated", "started", "timeout", "launch_failure",
  "nonzero_exit", "other_failure", "json_invalid", "shape_mismatch", "policy_pass",
  "policy_fail", "policy_error",
]);
const OS_ENVIRONMENT = new Set([
  "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "TEMP", "TMP", "USERPROFILE",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA", "LOCALAPPDATA", "APPDATA",
]);

// Read this checkout's exact static literal once. Include the newline before its
// closing backtick, which is part of String.raw's actual PowerShell input.
export function loadObserverBinding(source = readFileSync(POLICY_URL, "utf8")) {
  const prefix = "const DESCRIPTOR_OBSERVER = String.raw`";
  const start = source.indexOf(prefix);
  const end = source.indexOf("\n`;", start + prefix.length);
  if (start < 0 || end < start || source.indexOf(prefix, start + 1) !== -1) return null;
  const script = source.slice(start + prefix.length, end + 1);
  if (script.includes("`") || script.includes("${")) return null;
  const bytes = Buffer.from(script, "utf16le");
  return Object.freeze({
    encoded: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

let binding = null;
try { binding = loadObserverBinding(); } catch { /* Report only a fixed enum below. */ }

export function observerInvocationMatches(file, args, options, expected = binding, env = process.env) {
  if (expected == null) return false;
  const powershell = win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (file !== powershell || !Array.isArray(args) || args.length !== 5 ||
      args[0] !== "-NoLogo" || args[1] !== "-NoProfile" || args[2] !== "-NonInteractive" ||
      args[3] !== "-EncodedCommand" || args[4] !== expected.encoded) return false;
  if (options == null || Object.keys(options).sort().join(",") !== "encoding,env,input,maxBuffer,stdio,timeout,windowsHide" ||
      options.encoding !== "utf8" || options.timeout !== 7000 || options.maxBuffer !== MAX_BUFFER ||
      options.windowsHide !== true || typeof options.input !== "string" ||
      !Array.isArray(options.stdio) || options.stdio.length !== 3 || options.stdio.some(value => value !== "pipe")) return false;
  const expectedEnv = Object.fromEntries(Object.entries(env).filter(([key]) => OS_ENVIRONMENT.has(key.toUpperCase()))
    .map(([key, value]) => [key.toUpperCase(), value]));
  expectedEnv.PSModulePath = win32.join(win32.dirname(powershell), "Modules");
  return options.env != null && Object.keys(options.env).length === Object.keys(expectedEnv).length &&
    Object.entries(expectedEnv).every(([key, value]) => options.env[key] === value);
}

const integer = value => Number.isSafeInteger(value) && Math.abs(value) <= 0xffffffff ? value : null;
const boolean = value => typeof value === "boolean" ? value : null;

// Explicit allowlist, not redaction: no raw observer or error object reaches
// JSON.stringify, even if an instrumentation caller supplies extra properties.
export function sanitizedEvent(event) {
  return {
    diagnosticOnly: true,
    phase: PHASES.has(event.phase) ? event.phase : "recorder",
    outcome: OUTCOMES.has(event.outcome) ? event.outcome : "instrumentation_unavailable",
    elapsedMs: Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0
      ? Math.round(Math.min(event.elapsedMs, 86_400_000) * 1000) / 1000 : null,
    exitCode: integer(event.exitCode),
    // timeoutClass: 0 none, 1 ETIMEDOUT. launchClass: 0 none,
    // 1 ENOENT, 2 EACCES, 3 ENOEXEC, 4 ENOTDIR, 5 EPERM.
    timeoutClass: [0, 1].includes(event.timeoutClass) ? event.timeoutClass : 0,
    launchClass: [0, 1, 2, 3, 4, 5].includes(event.launchClass) ? event.launchClass : 0,
    jsonValid: boolean(event.jsonValid),
    requestCount: integer(event.requestCount),
    descriptorCount: integer(event.descriptorCount),
    countMatches: boolean(event.countMatches),
    identityMatches: boolean(event.identityMatches),
    policyPrivate: boolean(event.policyPrivate),
    truncated: event.truncated === true,
  };
}

export function createBoundedRecorder(appendLine, unavailable) {
  let count = 0;
  let failed = false;
  return event => {
    if (failed || count >= MAX_EVENTS) return;
    try {
      const value = count === MAX_EVENTS - 1
        ? { phase: "recorder", outcome: "truncated", truncated: true } : event;
      appendLine(`${JSON.stringify(sanitizedEvent(value))}\n`);
      count += 1;
    } catch {
      failed = true;
      try { unavailable(`${JSON.stringify(sanitizedEvent({ phase: "recorder", outcome: "recording_unavailable" }))}\n`); } catch { /* Never change product behavior. */ }
    }
  };
}

export function createFileRecorder(directory, runnerTemp) {
  const fallback = line => writeSync(2, line);
  let file;
  try {
    const output = resolve(directory);
    const parent = resolve(runnerTemp);
    const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (!samePath(dirname(output), parent) || !/^yawf-native-observer-[a-zA-Z0-9_-]+$/.test(output.slice(dirname(output).length + 1)) ||
        !lstatSync(output).isDirectory() || lstatSync(output).isSymbolicLink()) throw new Error();
    file = join(output, `observer-${process.pid}-${threadId}.jsonl`);
    // One exclusive recorder per process and worker thread. Never reuse a log.
    writeFileSync(file, "", { flag: "wx", mode: 0o600 });
  } catch {
    const record = createBoundedRecorder(() => { throw new Error(); }, fallback);
    record({ phase: "recorder", outcome: "ready" });
    return record;
  }
  return createBoundedRecorder(line => appendFileSync(file, line), fallback);
}

export function classifyFailure(error) {
  const timeoutClass = error?.code === "ETIMEDOUT" ? 1 : 0;
  const launchClass = new Map([["ENOENT", 1], ["EACCES", 2], ["ENOEXEC", 3], ["ENOTDIR", 4], ["EPERM", 5]])
    .get(error?.code) ?? 0;
  const exitCode = integer(error?.status);
  return {
    outcome: timeoutClass ? "timeout" : launchClass ? "launch_failure" :
      exitCode != null && exitCode !== 0 ? "nonzero_exit" : "other_failure",
    timeoutClass, launchClass, exitCode,
  };
}

export function classifyOutput(output, input, policy) {
  let descriptors;
  try {
    if (typeof output !== "string" || output.length > MAX_BUFFER) throw new Error();
    descriptors = JSON.parse(output.replace(/^\uFEFF/, "").trim());
  } catch { return { outcome: "json_invalid", jsonValid: false }; }
  const summary = { jsonValid: true, descriptorCount: Array.isArray(descriptors) ? descriptors.length : null };
  let requests;
  try {
    if (input.length > 4 * MAX_BUFFER) throw new Error();
    requests = JSON.parse(input);
    if (!Array.isArray(requests)) throw new Error();
  } catch { return { ...summary, outcome: "shape_mismatch" }; }
  summary.requestCount = requests.length;
  summary.countMatches = Array.isArray(descriptors) && descriptors.length === requests.length;
  summary.identityMatches = summary.countMatches && descriptors.every((value, id) =>
    value != null && value.id === id && value.kind === requests[id]?.kind);
  if (!summary.countMatches || !summary.identityMatches) return { ...summary, outcome: "shape_mismatch" };
  if (typeof policy !== "function") return { ...summary, outcome: "policy_unavailable" };
  try {
    // The real source helper is the only policy implementation. The booleans
    // describe that helper, not a second product acceptance decision.
    summary.policyPrivate = descriptors.every(value => policy(value) === true);
    return { ...summary, outcome: summary.policyPrivate ? "policy_pass" : "policy_fail" };
  } catch { return { ...summary, outcome: "policy_error" }; }
}

export function createExecFileSyncObserver(original, {
  matches = observerInvocationMatches, record, getPolicy = () => null, now = () => performance.now(),
}) {
  const emit = value => { try { record(value); } catch { /* Recorder cannot change execution. */ } };
  return function (...args) {
    let observed = false;
    let started;
    try {
      observed = args.length === 3 && matches(...args);
      if (observed) {
        started = now();
        emit({ phase: "observer", outcome: "started" });
      }
    } catch { /* A recognition failure must still invoke the original once. */ }
    const elapsed = () => started == null ? null : now() - started;
    let value;
    try {
      value = Reflect.apply(original, this, args);
    } catch (error) {
      if (observed) {
        try { emit({ phase: "observer", elapsedMs: elapsed(), ...classifyFailure(error) }); }
        catch { emit({ phase: "recorder", outcome: "instrumentation_unavailable" }); }
      }
      throw error;
    }
    if (observed) {
      try {
        const elapsedMs = elapsed();
        emit({ phase: "observer", exitCode: 0, elapsedMs, ...classifyOutput(value, args[2].input, getPolicy()) });
      } catch { emit({ phase: "recorder", outcome: "instrumentation_unavailable" }); }
    }
    return value;
  };
}

// NODE_OPTIONS is set only for the owned full-suite process, and inherited by
// its Node fixture children and workers. The native process env stays untouched.
if (process.env.YAWF_NATIVE_OBSERVER_DIR != null) {
  const record = createFileRecorder(process.env.YAWF_NATIVE_OBSERVER_DIR, process.env.RUNNER_TEMP);
  record({ phase: "recorder", outcome: "ready" });
  if (binding == null) {
    record({ phase: "recorder", outcome: "source_unavailable" });
  } else {
    let policy = null;
    try {
      childProcess.execFileSync = createExecFileSyncObserver(childProcess.execFileSync, { record, getPolicy: () => policy });
      syncBuiltinESMExports();
      try { policy = (await import(POLICY_URL.href)).windowsStorageDescriptorIsPrivate; } catch { /* Fixed enum below. */ }
      if (typeof policy !== "function") record({ phase: "recorder", outcome: "policy_unavailable" });
    } catch {
      record({ phase: "recorder", outcome: "instrumentation_unavailable" });
    }
  }
}
