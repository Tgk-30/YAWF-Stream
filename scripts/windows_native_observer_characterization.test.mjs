import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { windowsStorageDescriptorIsPrivate } from "../server/src/privateStorage.ts";
import { loadObserverBinding, observerInvocationMatches } from "./windows_native_observer_preload.mjs";
import {
  characterizationBinding, checkEvidence, claimColdSubstitution, createCharacterizationObserver, createRecorder,
} from "./windows_native_observer_characterization.mjs";

const moduleURL = new URL("./windows_native_observer_characterization.mjs", import.meta.url);
const binding = loadObserverBinding();
const env = { SystemRoot: "C:\\Windows" };
const powershell = win32.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const secret = ["NEVER", "SERIALIZE", "private-path", "SID", "token", "https://example.invalid"].join("_");
const input = JSON.stringify([{ id: 0, kind: "file", path: secret }]);
const output = JSON.stringify([{ id: 0, kind: "file", currentSid: "S-1-5-21-1234", ownerSid: "S-1-5-21-1234",
  trustedInstallerSid: null, directory: false, reparse: false, daclPresent: true, daclNull: false,
  rawAceTypes: [0], rules: [{ sid: "S-1-5-21-1234", allow: true, rights: 3,
    inheritOnly: false, objectInherit: false, containerInherit: false, noPropagate: false }], unused: secret }]);

function invocation() {
  return [powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", binding.encoded], {
    input, encoding: "utf8", timeout: 7000, maxBuffer: 256_000, windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { SYSTEMROOT: env.SystemRoot, PSModulePath: win32.join(win32.dirname(powershell), "Modules") },
  }];
}

function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "yawf-native-characterization-"));
  try { return run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function harness(directory, original = () => output, extras = {}) {
  const recorder = createRecorder(directory);
  let clock = 100;
  const wrapped = createCharacterizationObserver(original, {
    record: recorder.record, claim: () => claimColdSubstitution(directory),
    getPolicy: () => windowsStorageDescriptorIsPrivate,
    matches: (...args) => observerInvocationMatches(...args, binding, env),
    now: () => { const value = clock; clock += 11.75; return value; },
    ...extras,
  });
  return { wrapped, recorder };
}

function rows(directory) {
  const name = readdirSync(directory).find(name => name.endsWith(".jsonl"));
  return readFileSync(join(directory, name), "utf8").trim().split("\n").map(JSON.parse);
}

test("records explicit characterization-only source and original/diagnostic budgets", () => {
  const metadata = characterizationBinding();
  assert.equal(metadata.characterizationOnly, true);
  assert.equal(metadata.originalNativeTimeoutMs, 7000);
  assert.equal(metadata.effectiveDiagnosticTimeoutMs, 15000);
  assert.equal(metadata.originalTestTimeoutMs, 5000);
  assert.equal(metadata.originalHookTimeoutMs, 10000);
  assert.equal(metadata.diagnosticTestTimeoutMs, 30000);
  assert.equal(metadata.diagnosticHookTimeoutMs, 30000);
  assert.equal(metadata.originalScriptSHA256, binding.sha256);
});

test("strictly recognizes the original seven-second invocation before cloning anything", () => fixture(directory => {
  let claims = 0;
  const calls = [];
  const { wrapped, recorder } = harness(directory, (...args) => { calls.push(args); return output; },
    { claim: () => { claims += 1; return true; } });
  for (const change of [
    args => { args[0] = "powershell.exe"; },
    args => { args[1][4] += "x"; },
    args => { args[2].timeout = 15000; },
    args => { args[2].env.EXTRA = secret; },
    args => { args[2].maxBuffer += 1; },
    args => { args.push({ encoded: binding.encoded }); },
  ]) {
    const args = invocation();
    change(args);
    assert.equal(wrapped(...args), output);
    assert.equal(calls.at(-1)[2], args[2]);
  }
  recorder.complete();
  assert.equal(claims, 0);
  assert.deepEqual(rows(directory).map(row => row.outcome), ["ready"]);
  assert.equal(checkEvidence(directory, tmpdir()).valid, false);
}));

test("clones only one deadline globally, preserves caller options, receiver, arguments and result", () => fixture(directory => {
  const args = invocation();
  Object.freeze(args[1]); Object.freeze(args[2].env); Object.freeze(args[2].stdio); Object.freeze(args[2]);
  const receiver = { owned: true };
  const calls = [];
  const value = new String(output);
  const { wrapped, recorder } = harness(directory, function (...actual) {
    assert.equal(this, receiver);
    calls.push(actual);
    return value;
  });
  assert.equal(wrapped.apply(receiver, args), value);
  assert.equal(wrapped.apply(receiver, args), value);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], args[0]); assert.equal(calls[0][1], args[1]);
  assert.notEqual(calls[0][2], args[2]);
  assert.deepEqual(calls[0][2], { ...args[2], timeout: 15000 });
  assert.equal(calls[1][2], args[2]);
  assert.equal(args[2].timeout, 7000);
  recorder.complete();
  const result = checkEvidence(directory, tmpdir());
  assert.equal(result.valid, true);
  assert.equal(result.coldSubstitutionCount, 1);
  assert.equal(result.nativeInvocationCount, 2);
  assert.equal(result.coldElapsedMs, 11.75);
}));

for (const [code, status, outcome] of [["ETIMEDOUT", null, "timeout"], ["ENOENT", null, "launch_failure"],
  [secret, 29, "nonzero_exit"], [secret, null, "other_failure"]]) {
  test(`preserves the same thrown error for classified ${outcome}, without retry`, () => fixture(directory => {
    const error = Object.assign(new Error(secret), { code, status, stdout: secret, stderr: secret });
    let calls = 0;
    const { wrapped, recorder } = harness(directory, () => { calls += 1; throw error; });
    assert.throws(() => wrapped(...invocation()), actual => actual === error);
    assert.equal(calls, 1);
    recorder.complete();
    const result = checkEvidence(directory, tmpdir());
    assert.equal(result.valid, true);
    assert.equal(result.coldOutcome, outcome);
    assert.equal(rows(directory).at(-1).exitCode, status);
    assert.equal(JSON.stringify(rows(directory)).includes(secret), false);
  }));
}

test("classifies actual production policy and JSON failure without replacing original output", () => fixture(directory => {
  const { wrapped, recorder } = harness(directory);
  assert.equal(wrapped(...invocation()), output);
  recorder.complete();
  const result = checkEvidence(directory, tmpdir());
  assert.equal(result.valid, true);
  assert.equal(result.coldOutcome, "policy_pass");
  assert.equal(result.policyPrivate, true);
  for (const file of readdirSync(directory)) {
    const text = readFileSync(join(directory, file), "utf8");
    for (const forbidden of [secret, "S-1-5", "GetFileSecurityW", binding.encoded, "powershell.exe"]) {
      assert.equal(text.includes(forbidden), false);
    }
  }
  assert.equal(rows(directory).at(-1).descriptorCount, 1);
}));

test("never substitutes an unavailable binding and fails the evidence postcheck", () => fixture(directory => {
  let claims = 0;
  let options;
  const { wrapped, recorder } = harness(directory, (_file, _args, actual) => { options = actual; return output; },
    { expected: null, claim: () => { claims += 1; return true; } });
  const args = invocation();
  assert.equal(wrapped(...args), output);
  assert.equal(options, args[2]);
  assert.equal(claims, 0);
  recorder.complete();
  assert.equal(checkEvidence(directory, tmpdir()).valid, false);
  assert.equal(checkEvidence(directory, tmpdir(), null).valid, false);
}));

test("claim failure keeps the original native deadline and makes evidence invalid", () => fixture(directory => {
  let options;
  const { wrapped, recorder } = harness(directory, (_file, _args, actual) => { options = actual; return output; },
    { claim: () => { throw new Error(secret); } });
  const args = invocation();
  assert.equal(wrapped(...args), output);
  assert.equal(options, args[2]);
  recorder.complete();
  assert.equal(checkEvidence(directory, tmpdir()).valid, false);
}));

test("unavailable recorder cannot replace results or errors, and postcheck rejects it", () => fixture(directory => {
  const unavailable = [];
  const recorder = createRecorder(directory, binding, {
    append: () => { throw new Error(secret); }, fallback: line => unavailable.push(line),
  });
  const error = new Error(secret);
  const options = { record: recorder.record, claim: () => claimColdSubstitution(directory),
    matches: (...args) => observerInvocationMatches(...args, binding, env) };
  assert.equal(createCharacterizationObserver(() => output, options)(...invocation()), output);
  assert.throws(() => createCharacterizationObserver(() => { throw error; }, options)(...invocation()), actual => actual === error);
  recorder.complete();
  assert.equal(checkEvidence(directory, tmpdir()).valid, false);
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].includes(secret), false);
}));

test("caps recorder output at 256 records with explicit truncation and invalid postcheck", () => fixture(directory => {
  const recorder = createRecorder(directory);
  for (let i = 0; i < 600; i += 1) recorder.record({ phase: "observer", outcome: "started", stderr: secret });
  recorder.complete();
  const events = rows(directory);
  assert.equal(events.length, 256);
  assert.equal(events.at(-1).outcome, "truncated");
  assert.equal(events.at(-1).truncated, true);
  assert.equal(JSON.stringify(events).includes(secret), false);
  assert.equal(checkEvidence(directory, tmpdir()).valid, false);
}));

for (const missing of ["claim", "completion", "native outcome", "binding"]) {
  test(`postcheck rejects missing ${missing} without raw error serialization`, () => fixture(directory => {
    const { wrapped, recorder } = harness(directory);
    wrapped(...invocation()); recorder.complete();
    const files = readdirSync(directory);
    if (missing === "claim") rmSync(join(directory, "cold-substitution.json"));
    if (missing === "completion") rmSync(join(directory, files.find(name => name.endsWith(".complete.json"))));
    if (missing === "native outcome") {
      const name = files.find(name => name.endsWith(".jsonl"));
      writeFileSync(join(directory, name), rows(directory).slice(0, -1).map(row => JSON.stringify(row) + "\n").join(""));
    }
    if (missing === "binding") writeFileSync(join(directory, "cold-substitution.json"), JSON.stringify({ raw: secret }));
    const result = checkEvidence(directory, tmpdir());
    assert.equal(result.valid, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }));
}

test("postcheck rejects more than one attempted cold substitution", () => fixture(directory => {
  claimColdSubstitution(directory);
  const { wrapped, recorder } = harness(directory, () => output, { claim: () => true });
  wrapped(...invocation()); wrapped(...invocation()); recorder.complete();
  assert.equal(checkEvidence(directory, tmpdir()).valid, false);
}));

test("hostile timer, logger and error getters never replace the original result", () => fixture(directory => {
  const error = { get code() { throw new Error(secret); } };
  const { wrapped, recorder } = harness(directory, () => { throw error; }, { now: () => { throw new Error(secret); } });
  assert.throws(() => wrapped(...invocation()), actual => actual === error);
  recorder.complete();
  assert.equal(checkEvidence(directory, tmpdir()).valid, false);
  const pass = createCharacterizationObserver(() => output, { claim: () => false,
    matches: () => true, record: () => { throw new Error(secret); } });
  assert.equal(pass(...invocation()), output);
}));

test("one exclusive global claim wins across actual concurrent worker threads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "yawf-native-characterization-"));
  const workers = [];
  try {
    const source = `import { parentPort, workerData } from "node:worker_threads";
      import { claimColdSubstitution } from ${JSON.stringify(moduleURL.href)};
      parentPort.once("message", () => parentPort.postMessage(claimColdSubstitution(workerData)));
      parentPort.postMessage("ready");`;
    const runs = Array.from({ length: 2 }, () => {
      const worker = new Worker(new URL("data:text/javascript," + encodeURIComponent(source)), { workerData: directory });
      workers.push(worker);
      const closed = new Promise((resolve, reject) => { worker.once("exit", resolve); worker.once("error", reject); });
      const result = new Promise((resolve, reject) => { worker.on("message", value => { if (value === "ready") worker.postMessage("claim"); else resolve(value); }); worker.once("error", reject); });
      return { result, closed };
    });
    const results = await Promise.all(runs.map(run => run.result));
    await Promise.all(runs.map(run => run.closed));
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal(claimColdSubstitution(directory), false);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { claimColdSubstitution } from ${JSON.stringify(moduleURL.href)}; process.stdout.write(JSON.stringify(claimColdSubstitution(process.argv[1])));`, directory],
    { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "false");
    assert.equal(JSON.parse(readFileSync(join(directory, "cold-substitution.json"), "utf8")).coldSubstitutionCount, 1);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("opt-in preload follows Node children/workers, records completion, and leaves old mode absent", () => fixture(directory => {
  const source = `import { spawnSync } from "node:child_process"; import { Worker } from "node:worker_threads";
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", ""], { encoding: "utf8" });
    if (child.status !== 0) process.exit(71);
    const worker = new Worker('import { parentPort } from "node:worker_threads"; parentPort.postMessage(true);', { eval: true });
    await new Promise((resolve, reject) => { worker.once("exit", resolve); worker.once("error", reject); });
    process.stdout.write(JSON.stringify(process.env.YAWF_NATIVE_OBSERVER_DIR == null));`;
  const childEnv = { ...process.env, RUNNER_TEMP: tmpdir(), YAWF_NATIVE_CHARACTERIZATION_DIR: directory,
    NODE_OPTIONS: `--import=${moduleURL.href}` };
  delete childEnv.YAWF_NATIVE_OBSERVER_DIR;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 10_000, env: childEnv });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "true");
  assert.equal(readdirSync(directory).filter(name => name.endsWith(".jsonl")).length, 3);
  assert.equal(readdirSync(directory).filter(name => name.endsWith(".complete.json")).length, 3);
  assert.equal(checkEvidence(directory, tmpdir()).valid, false);
}));
