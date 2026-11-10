import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveReleaseScope } from "./resolve_release_scope.mjs";

const script = fileURLToPath(new URL("./resolve_release_scope.mjs", import.meta.url));
const FAILURE = "Release scope could not be resolved.";
const TAG = "v2.3.96-web";
const release = { eventName: "push", refType: "tag", refName: TAG };
const coordinated = { desktop_only: "false", include_android: "true", include_server: "true", stable_version: "" };
const scoped = { desktop_only: "true", include_android: "false", include_server: "false", stable_version: "2.3.96" };
const attacker = ["DO", "NOT", "LOG", "PRIVATE", "VALUE"].join("_");

function rejects(input) {
  assert.throws(() => resolveReleaseScope(input), error => error.message === FAILURE && !error.message.includes(attacker));
}

function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "release-scope-"));
  try { return run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function cli(input, args = []) {
  const env = { ...process.env };
  for (const key of ["EVENT_NAME", "REF_TYPE", "REF_NAME", "DESKTOP_ONLY_TAG"]) delete env["RELEASE_SCOPE_" + key];
  for (const [key, value] of Object.entries(input)) if (value !== undefined) env["RELEASE_SCOPE_" + key] = value;
  return spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8", timeout: 5000 });
}

const releaseEnv = { EVENT_NAME: "push", REF_TYPE: "tag", REF_NAME: TAG, DESKTOP_ONLY_TAG: TAG };

test("exact matching canonical web tag selects only desktop with four string outputs", () => {
  const result = resolveReleaseScope({ ...release, desktopOnlyTag: TAG });
  assert.deepEqual(result, scoped);
  assert.deepEqual(Object.keys(result), ["desktop_only", "include_android", "include_server", "stable_version"]);
  assert.equal(Object.values(result).every(value => typeof value === "string"), true);
});

test("empty, missing or valid nonmatching flag retains coordinated web-tag release", () => {
  for (const desktopOnlyTag of [undefined, "", "v2.3.95-web", "v0.0.0-web"]) {
    assert.deepEqual(resolveReleaseScope({ ...release, desktopOnlyTag }), { ...coordinated, stable_version: "2.3.96" });
  }
});

test("plain canonical tags remain coordinated even with the equivalent web flag", () => {
  assert.deepEqual(resolveReleaseScope({ ...release, refName: "v2.3.96", desktopOnlyTag: TAG }),
    { ...coordinated, stable_version: "2.3.96" });
});

test("zero and bounded large numeric versions remain exact strings without numeric rewriting", () => {
  for (const version of ["0.0.0", "10.20.300", "9".repeat(119) + ".0.0"]) {
    const tag = `v${version}-web`;
    assert.deepEqual(resolveReleaseScope({ ...release, refName: tag, desktopOnlyTag: tag }), { ...scoped, stable_version: version });
  }
});

for (const [name, context] of [
  ["branch", { eventName: "push", refType: "branch", refName: TAG }],
  ["pull request", { eventName: "pull_request", refType: "branch", refName: "217/merge" }],
  ["manual branch", { eventName: "workflow_dispatch", refType: "branch", refName: "main" }],
  ["manual tag", { eventName: "workflow_dispatch", refType: "tag", refName: TAG }],
]) {
  test(`protected ${name} default cannot disable Android or server verification`, () => {
    for (const desktopOnlyTag of [TAG, "true", attacker + "\ninclude_android=false", "x".repeat(100_000), null, 1, {}, Symbol("scope")]) {
      assert.deepEqual(resolveReleaseScope({ ...context, desktopOnlyTag }), coordinated);
    }
    const input = { ...context, get desktopOnlyTag() { throw new Error(attacker); } };
    assert.deepEqual(resolveReleaseScope(input), coordinated);
  });
}

test("rejects malformed push tags including leading zeros, unsupported suffixes and injection", () => {
  for (const refName of ["", "2.3.96", "V2.3.96-web", "v02.3.96-web", "v2.03.96-web", "v2.3.096-web",
    "v2.3", "v2.3.96.1", "v2.3.96-WEB", "v2.3.96-beta", "v2.3.96+build", "refs/tags/v2.3.96-web",
    " v2.3.96-web", "v2.3.96-web ", TAG + "\n", TAG + "\r\n", TAG + "\t", TAG + "\0",
    TAG + "\u2028", "v２.3.96-web", "v2.٣.96-web", "v2.3.96-weЬ", "v2.3.96\u200b-web",
    "v" + "9".repeat(120) + ".0.0-web", attacker + "\ninclude_server=false"]) {
    rejects({ ...release, refName });
  }
});

test("malformed nonempty scoped flag fails a release instead of silently coordinating", () => {
  for (const desktopOnlyTag of ["true", "v2.3.96", "V2.3.96-web", "v2.3.96-WEB", "v2.03.96-web", " " + TAG,
    TAG + " ", TAG + "\n", TAG + "\u2028", TAG + "\u200b", "v２.3.96-web", "x".repeat(129), attacker]) {
    rejects({ ...release, desktopOnlyTag });
  }
});

test("rejects typed, missing and hostile context values without coercion or error reflection", () => {
  for (const input of [undefined, null, true, "push", [], {}, { ...release, eventName: undefined },
    { ...release, refType: undefined }, { ...release, refName: undefined }]) rejects(input);
  for (const key of ["eventName", "refType", "refName"]) {
    for (const value of [null, 0, true, {}, [], new String("push"), Symbol("context")]) rejects({ ...release, [key]: value });
  }
  rejects({ get eventName() { throw new Error(attacker); } });
});

test("release flag must be a primitive string and is read exactly once", () => {
  for (const desktopOnlyTag of [null, false, 1, {}, [], new String(TAG), Symbol("scope")]) rejects({ ...release, desktopOnlyTag });
  let reads = 0;
  assert.deepEqual(resolveReleaseScope({ ...release, get desktopOnlyTag() { reads += 1; return TAG; } }), scoped);
  assert.equal(reads, 1);
});

test("context case, whitespace, control characters and length are not normalized", () => {
  for (const eventName of ["Push", " push", "push ", "push\n", "push\u2028", "püsh", "a".repeat(65)]) rejects({ ...release, eventName });
  for (const refType of ["TAG", "Tag", " tag", "tag\n", ""]) rejects({ ...release, refType });
  rejects({ ...release, refType: "branch", refName: "a".repeat(257) });
  rejects({ ...release, refType: "branch", refName: "main\n" });
  assert.deepEqual(resolveReleaseScope({ ...release, refType: "branch", refName: "a".repeat(256) }), coordinated);
});

test("CLI appends exactly four allowlisted lines while preserving existing content", () => fixture(directory => {
  const output = join(directory, "github-output");
  writeFileSync(output, "existing=keep\n");
  const result = cli(releaseEnv, ["--github-output", output]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  assert.equal(readFileSync(output, "utf8"), "existing=keep\ndesktop_only=true\ninclude_android=false\ninclude_server=false\nstable_version=2.3.96\n");
}));

test("CLI JSON is optional and contains exactly the same four resolved strings", () => fixture(directory => {
  const output = join(directory, "github-output");
  const direct = cli(releaseEnv);
  assert.equal(direct.status, 0, direct.stderr); assert.deepEqual(JSON.parse(direct.stdout), scoped);
  const appended = cli(releaseEnv, ["--github-output", output, "--json"]);
  assert.equal(appended.status, 0, appended.stderr); assert.deepEqual(JSON.parse(appended.stdout), scoped);
  assert.equal(readFileSync(output, "utf8").split("\n").filter(Boolean).length, 4);
}));

test("CLI invalid releases emit no outputs and leave existing or absent output files untouched", () => fixture(directory => {
  const output = join(directory, "github-output");
  writeFileSync(output, "existing=keep\n");
  for (const env of [
    { ...releaseEnv, REF_NAME: TAG + "\ninclude_server=false" },
    { ...releaseEnv, DESKTOP_ONLY_TAG: attacker },
    { ...releaseEnv, EVENT_NAME: undefined },
    { ...releaseEnv, DESKTOP_ONLY_TAG: TAG + "\u2028" },
  ]) {
    const result = cli(env, ["--github-output", output, "--json"]);
    assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.equal(result.stderr, FAILURE + "\n");
    assert.equal(readFileSync(output, "utf8"), "existing=keep\n");
    assert.equal(result.stderr.includes(attacker), false);
  }
  const absent = join(directory, "not-created");
  assert.equal(cli({ ...releaseEnv, DESKTOP_ONLY_TAG: attacker }, ["--github-output", absent]).status, 1);
  assert.equal(existsSync(absent), false);
}));

test("CLI manual verification ignores malformed scoped env and keeps protected defaults", () => fixture(directory => {
  const output = join(directory, "github-output");
  const result = cli({ ...releaseEnv, EVENT_NAME: "workflow_dispatch", DESKTOP_ONLY_TAG: attacker + "\n" }, ["--github-output", output, "--json"]);
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), coordinated);
  assert.equal(readFileSync(output, "utf8"), "desktop_only=false\ninclude_android=true\ninclude_server=true\nstable_version=\n");
}));

test("CLI argument and filesystem errors are fixed and never expose input or output paths", () => fixture(directory => {
  const output = join(directory, attacker);
  writeFileSync(output, "existing=keep\n");
  for (const args of [["--github-output"], ["--unknown", attacker], ["--github-output", output, "--json", "--json"],
    ["--github-output", output, "--github-output", output], ["--github-output", output + "\n"],
    ["--github-output", join(directory, "absent", attacker)], ["--github-output", "x".repeat(4097)]]) {
    const result = cli(releaseEnv, args);
    assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.equal(result.stderr, FAILURE + "\n");
    assert.equal(result.stderr.includes(attacker), false); assert.equal(readFileSync(output, "utf8"), "existing=keep\n");
  }
}));
