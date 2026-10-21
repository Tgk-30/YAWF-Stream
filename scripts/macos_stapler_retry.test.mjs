import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const original = readFileSync(new URL("./macos_stapler_retry.sh", import.meta.url), "utf8");
const network = 'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."';
const lookup = "https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup";
const stdoutFor = (n) => Buffer.from([111, 117, 116, 0, 255, 48 + n, 10]);
const stderrFor = (n, diagnostic = "") => Buffer.concat([Buffer.from([101, 114, 114, 0, 254, 48 + n, 10]), Buffer.from(diagnostic)]);

function observe(source, mode, verb = "staple", preexistingReceipt = false) {
  const root = mkdtempSync(join(tmpdir(), "yawf-stapler-test-"));
  try {
    const state = join(root, "state");
    const temporary = join(root, "temporary");
    mkdirSync(state); mkdirSync(temporary);
    const command = join(root, "fake-xcrun");
    const script = join(root, "subject.sh");
    const receipt = join(root, "receipt.jsonl");
    if (preexistingReceipt) writeFileSync(receipt, "preserved sentinel\n");
    writeFileSync(command, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.FAKE_STATE;
const file = path.join(root, 'calls.json');
const calls = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
calls.push(process.argv.slice(2)); fs.writeFileSync(file, JSON.stringify(calls));
const n = calls.length;
if (n > 5) process.exit(97);
const mode = process.env.FAKE_MODE;
process.stdout.write(Buffer.from([111,117,116,0,255,48+n,10]));
process.stderr.write(Buffer.from([101,114,114,0,254,48+n,10]));
if (mode === 'success' || (n > 1 && mode !== 'exhaust')) process.exit(0);
if (mode === 'other68') { process.stderr.write('A ticket was not found.\\n'); process.exit(68); }
let network = ${JSON.stringify(network)};
let url = ${JSON.stringify(lookup)};
if (mode === 'badnetwork') network = 'NSURLErrorDomain Code=-1009 "The Internet connection appears to be offline."';
if (mode === 'badurl') url = 'https://unrelated.invalid/records/lookup';
if (mode === 'urlprefix') url += '/unrelated';
process.stderr.write(network + '\\nNSErrorFailingURLStringKey=' + url + '\\n');
process.exit(mode === 'non68' ? 23 : 68);
`);
    new Function(readFileSync(command, "utf8").replace(/^#![^\n]*\n/, ""));
    chmodSync(command, 0o755);
    assert.equal(source.split("/usr/bin/xcrun").length - 1, 1, "exactly one real command pin");
    assert.equal(source.split("/bin/sleep 2").length - 1, 1, "exactly one bounded delay");
    writeFileSync(script, source.replace("/usr/bin/xcrun", command).replace("/bin/sleep 2", "/usr/bin/true"));
    const args = [verb, "an image with spaces.dmg", "--verbose"];
    const result = spawnSync("/bin/bash", [script, ...args], {
      env: { ...process.env, RUNNER_TEMP: root, TMPDIR: temporary, STAPLER_RETRY_RECEIPT: receipt, FAKE_STATE: state, FAKE_MODE: mode },
      timeout: 30_000,
    });
    assert.equal(result.error, undefined, "bounded test process must exit");
    const calls = existsSync(join(state, "calls.json")) ? JSON.parse(readFileSync(join(state, "calls.json"), "utf8")) : [];
    const rows = existsSync(receipt) && !preexistingReceipt ? readFileSync(receipt, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    assert.deepEqual(readdirSync(temporary), [], "only owned scratch files must be cleaned up");
    if (preexistingReceipt) assert.equal(readFileSync(receipt, "utf8"), "preserved sentinel\n");
    return { ...result, calls, rows, args };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function check(source, mode, expectedStatus, expectedCalls, verb = "staple") {
  const result = observe(source, mode, verb);
  assert.equal(result.status, expectedStatus, `${mode}: original status`);
  assert.equal(result.calls.length, expectedCalls, `${mode}: invocation bound`);
  for (const args of result.calls) assert.deepEqual(args, ["stapler", ...result.args], "original argv remains separate and unchanged");
  const outputs = [], errors = [];
  for (let n = 1; n <= expectedCalls; n++) {
    outputs.push(stdoutFor(n));
    let diagnostic = "";
    if (mode !== "success" && (n === 1 || mode === "exhaust")) {
      if (mode === "other68") diagnostic = "A ticket was not found.\n";
      else {
        const fingerprint = mode === "badnetwork" ? 'NSURLErrorDomain Code=-1009 "The Internet connection appears to be offline."' : network;
        const url = mode === "badurl" ? "https://unrelated.invalid/records/lookup" : lookup + (mode === "urlprefix" ? "/unrelated" : "");
        diagnostic = `${fingerprint}\nNSErrorFailingURLStringKey=${url}\n`;
      }
    }
    errors.push(stderrFor(n, diagnostic));
  }
  assert.deepEqual(result.stdout, Buffer.concat(outputs), "stdout byte preservation");
  assert.deepEqual(result.stderr, Buffer.concat(errors), "stderr byte preservation");
  if (verb === "staple" || verb === "validate") {
    assert.equal(result.rows.length, expectedCalls, "every attempt has a compact receipt");
    assert.ok(result.rows.length <= 3);
    assert.deepEqual(result.rows.map((r) => r.attempt), Array.from({ length: expectedCalls }, (_, i) => i + 1));
    assert.equal(result.rows.at(-1).status, expectedStatus);
    assert.equal(result.rows.at(-1).outcome, expectedStatus === 0 ? "success" : mode === "exhaust" ? "exhausted" : "failure");
    assert.ok(result.rows.every((r) => r.verb === verb));
  } else assert.deepEqual(result.rows, []);
  return result;
}

test("macOS stapler preserves argv and both binary streams on immediate success", () => check(original, "success", 0, 1));
test("only the exact observed transient can recover, for both staple and validate", () => {
  for (const verb of ["staple", "validate"]) check(original, "transient", 0, 2, verb);
});
test("transient exhaustion preserves exit68 after exactly three attempts", () => check(original, "exhaust", 68, 3));
test("unclassified failures never retry", () => {
  check(original, "non68", 23, 1);
  for (const mode of ["badnetwork", "badurl", "urlprefix", "other68"]) check(original, mode, 68, 1);
});
test("unrelated stapler verbs remain one-shot passthrough", () => check(original, "non68", 23, 1, "list"));
test("receipt admission refuses to overwrite an existing file before executing", () => {
  const result = observe(original, "success", "staple", true);
  assert.equal(result.status, 2); assert.deepEqual(result.calls, []);
});

test("independent semantic mutants cannot weaken retry classification, cap, output or status", () => {
  const mutants = [
    ["non68", 23, 1, original.replace('[ "$status" -eq 68 ]', '[ "$status" -ne 0 ]')],
    ["badnetwork", 68, 1, original.replace("&& LC_ALL=C /usr/bin/grep -a -F -q -- 'NSURLErrorDomain Code=-1005 \"The network connection was lost.\"' \"$stdout_file\" \"$stderr_file\"", "&& true")],
    ["badurl", 68, 1, original.replace(/&& LC_ALL=C \/usr\/bin\/grep -a -E -q -- '[^']+' "\$stdout_file" "\$stderr_file"/, "&& true")],
    ["exhaust", 68, 3, original.replace("MAX_ATTEMPTS=3", "MAX_ATTEMPTS=4")],
    ["exhaust", 68, 3, original.replace('then exit "$status"; fi\n  /bin/sleep', 'then exit 0; fi\n  /bin/sleep')],
    ["other68", 68, 1, original.replace('then exit "$status"; fi\n  if', 'then exit 0; fi\n  if')],
    ["success", 0, 1, original.replace('/bin/cat -- "$stdout_file" || exit 74', ':')],
    ["success", 0, 1, original.replace('/bin/cat -- "$stderr_file" >&2 || exit 74', ':')],
    ["success", 0, 1, original.replace('"$XCRUN_REAL" stapler "$@" >', '"$XCRUN_REAL" stapler "$*" >')],
    ["transient", 0, 2, original.replace("transient=true", "transient=false")],
  ];
  for (const [mode, status, calls, mutant] of mutants) {
    assert.notEqual(mutant, original, "each individual mutation must bind");
    check(original, mode, status, calls);
    assert.throws(() => check(mutant, mode, status, calls), undefined, `${mode}: mutant must fail its independent oracle`);
  }
});
