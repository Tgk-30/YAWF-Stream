import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./smoke_tauri_server_bundle.mjs", import.meta.url), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function cleanupBlock(value) {
  const match = value.match(/  } finally \{\n([\s\S]*?)\n  }\n}\n\nmain\(\)/);
  assert.ok(match, "smoke cleanup finally block is missing");
  return match[1];
}

function cleanupOptions(value) {
  const block = cleanupBlock(value);
  const match = block.match(/rmSync\(tempRoot,\s*(\{[\s\S]*?\})\s*\);/);
  assert.ok(match, "bounded temp-root removal is missing");
  return Function(`"use strict"; return (${match[1]});`)();
}

function validateCleanup(value) {
  const block = cleanupBlock(value);
  assert.equal((block.match(/rmSync\(tempRoot/g) ?? []).length, 1);
  const childStop = block.indexOf("await childExit;");
  const removal = block.indexOf("rmSync(tempRoot");
  assert.ok(childStop >= 0 && removal > childStop);
  assert.deepEqual(cleanupOptions(value), {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

function executableCleanup(value) {
  return new AsyncFunction(
    "exitStatus",
    "child",
    "childExit",
    "rmSync",
    "tempRoot",
    cleanupBlock(value),
  );
}

test("waits for child stop before bounded Windows-safe temp cleanup", async () => {
  validateCleanup(source);
  const events = [];
  const runCleanup = executableCleanup(source);
  const childExit = Promise.resolve().then(() => events.push("stopped"));
  await runCleanup(
    null,
    { kill: () => events.push("kill") },
    childExit,
    (path, options) => {
      events.push("remove");
      assert.equal(path, "fixture-root");
      assert.deepEqual(options, cleanupOptions(source));
    },
    "fixture-root",
  );
  assert.deepEqual(events, ["kill", "stopped", "remove"]);
});

test("propagates a terminal cleanup failure after the bounded retries", async () => {
  const failure = Object.assign(new Error("still locked"), { code: "EPERM" });
  const events = [];
  const runCleanup = executableCleanup(source);
  await assert.rejects(
    runCleanup(
      { code: 0, signal: null },
      { kill: () => assert.fail("completed child must not be killed again") },
      Promise.resolve().then(() => events.push("stopped")),
      () => {
        events.push("remove");
        throw failure;
      },
      "fixture-root",
    ),
    (error) => error === failure,
  );
  assert.deepEqual(events, ["stopped", "remove"]);
});

for (const [name, mutate] of [
  ["retry removal", (value) => value.replace("maxRetries: 5", "maxRetries: 0")],
  ["retry delay removal", (value) => value.replace("retryDelay: 100", "retryDelay: 0")],
  [
    "cleanup before child stop",
    (value) => value.replace(
      "    await childExit;\n    rmSync(tempRoot, {",
      "    rmSync(tempRoot, {",
    ),
  ],
]) {
  test(`rejects ${name}`, () => {
    const changed = mutate(source);
    assert.notEqual(changed, source);
    assert.throws(() => validateCleanup(changed));
  });
}
