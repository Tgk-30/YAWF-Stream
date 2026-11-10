import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveReleaseScope } from "./resolve_release_scope.mjs";

// The optional root selects owned, immutable workflow copies for negative
// controls. Only trusted local repository workflow source is interpreted.
const ROOT = process.env.RELEASE_SCOPE_CONTRACT_ROOT
  ? resolve(process.env.RELEASE_SCOPE_CONTRACT_ROOT) : fileURLToPath(new URL("../", import.meta.url));
const workflow = name => readFileSync(join(ROOT, ".github/workflows", name + ".yml"), "utf8");
const sources = Object.fromEntries(["web-release", "docker-image", "deb-release", "clean-install"].map(name => [name, workflow(name)]));
const TAG = "v2.3.96-web";

function blocks(text, indent, pattern = "[a-zA-Z0-9_-]+") {
  const matches = [...text.matchAll(new RegExp(`^ {${indent}}(${pattern}):[^\\S\\n]*$`, "gm"))];
  const result = {};
  for (const [index, match] of matches.entries()) {
    assert.equal(Object.hasOwn(result, match[1]), false, "Duplicate anchored block");
    result[match[1]] = text.slice(match.index + match[0].length + 1, matches[index + 1]?.index ?? text.length);
  }
  return result;
}

function jobs(name) {
  const source = sources[name];
  const start = source.indexOf("\njobs:\n");
  assert.notEqual(start, -1, "Missing jobs anchor");
  return blocks(source.slice(start + "\njobs:\n".length), 2);
}

function scalar(text, key, indent) {
  const lines = text.split("\n");
  const prefix = " ".repeat(indent) + key + ":";
  const indexes = lines.flatMap((line, index) => line.startsWith(prefix) ? [index] : []);
  assert.ok(indexes.length <= 1, "Ambiguous scalar anchor");
  if (indexes.length === 0) return undefined;
  const index = indexes[0];
  const first = lines[index].slice(prefix.length).trim();
  if (![">-", ">", "|", "|-"].includes(first)) return first;
  const parts = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() !== "" && !line.startsWith(" ".repeat(indent + 2))) break;
    parts.push(line.slice(indent + 2));
  }
  return first.startsWith("|") ? parts.join("\n").trimEnd() + "\n" : parts.map(line => line.trim()).join(" ").trim();
}

function step(job, name) {
  const headers = [...job.matchAll(/^      - (?:name: (.+)|uses: .+)$/gm)];
  const match = headers.find(value => value[1] === name);
  assert.ok(match, `Missing named step: ${name}`);
  const index = headers.indexOf(match);
  return job.slice(match.index, headers[index + 1]?.index ?? job.length);
}

const truthy = value => value !== false && value !== null && value !== undefined && value !== "" && value !== 0;
function equal(left, right) {
  if (typeof left === "string" && typeof right === "string") return left.toLowerCase() === right.toLowerCase();
  if (typeof left === typeof right) return left === right;
  const number = value => value == null || value === "" ? 0 : typeof value === "object" ? NaN : Number(value);
  return number(left) === number(right);
}

// A bounded parser for the expressions actually present in these workflows,
// not a general YAML or GitHub runner implementation. Unsupported syntax fails.
function expression(raw, context) {
  let source = raw.trim();
  if (source.startsWith("${{")) { assert.ok(source.endsWith("}}")); source = source.slice(3, -2).trim(); }
  assert.ok(source.length < 4096);
  const tokens = [];
  for (let offset = 0; offset < source.length;) {
    const rest = source.slice(offset);
    const match = /^(\s+|&&|\|\||==|!=|[!(),]|'(?:[^']|'')*'|[a-zA-Z_][a-zA-Z0-9_.-]*|[0-9]+)/.exec(rest);
    assert.ok(match, "Unsupported expression token");
    offset += match[0].length;
    if (!/^\s+$/.test(match[0])) tokens.push(match[0]);
  }
  let index = 0;
  const take = expected => { assert.equal(tokens[index++], expected, "Expression delimiter mismatch"); };
  function primary() {
    const token = tokens[index++];
    assert.notEqual(token, undefined, "Incomplete expression");
    if (token === "(") { const value = or(); take(")"); return value; }
    if (token.startsWith("'")) return token.slice(1, -1).replace(/''/g, "'");
    if (token === "true" || token === "false") return token === "true";
    if (/^[0-9]+$/.test(token)) return Number(token);
    if (tokens[index] === "(") {
      index += 1;
      const args = [];
      if (tokens[index] !== ")") { args.push(or()); while (tokens[index] === ",") { index += 1; args.push(or()); } }
      take(")");
      const results = context.ancestorResults ?? [];
      if (token === "always") { assert.equal(args.length, 0); return true; }
      if (token === "success") return context.workflowCancelled !== true && results.every(value => value === "success");
      if (token === "failure") return results.includes("failure");
      if (token === "cancelled") return context.workflowCancelled === true;
      if (token === "startsWith") return String(args[0]).toLowerCase().startsWith(String(args[1]).toLowerCase());
      assert.fail("Unsupported expression function");
    }
    return token.split(".").reduce((value, key) => value?.[key] ?? "", context);
  }
  function unary() { if (tokens[index] === "!") { index += 1; return !truthy(unary()); } return primary(); }
  function comparison() {
    let value = unary();
    while (["==", "!="].includes(tokens[index])) { const operator = tokens[index++]; const right = unary(); value = operator === "==" ? equal(value, right) : !equal(value, right); }
    return value;
  }
  function and() { let value = comparison(); while (tokens[index] === "&&") { index += 1; const right = comparison(); value = truthy(value) ? right : value; } return value; }
  function or() { let value = and(); while (tokens[index] === "||") { index += 1; const right = and(); value = truthy(value) ? value : right; } return value; }
  const result = or();
  assert.equal(index, tokens.length, "Unconsumed expression");
  return result;
}

function dependencies(job) {
  const value = scalar(job, "needs", 4);
  return value == null ? [] : value.replace(/^\[|\]$/g, "").split(",").map(name => name.trim());
}

function enabled(job, context) {
  const condition = scalar(job, "if", 4) ?? "true";
  const direct = dependencies(job);
  const ancestors = new Set();
  function visit(name) {
    if (ancestors.has(name)) return;
    ancestors.add(name);
    for (const parent of dependencies(context.workflowGraph?.[name] ?? "")) visit(parent);
  }
  for (const name of direct) visit(name);
  const ancestorResults = [...ancestors].map(name => context.needs?.[name]?.result ?? "");
  if (!/\b(?:always|success|failure|cancelled)\s*\(/.test(condition) &&
      (context.workflowCancelled === true || ancestorResults.some(result => result !== "success"))) return false;
  // GitHub exposes only a job's explicitly declared direct dependencies.
  const needs = Object.fromEntries(direct.map(name => [name, context.needs?.[name] ?? { result: "", outputs: {} }]));
  return truthy(expression(condition, { ...context, needs, ancestorResults }));
}

function context({ flag = "", event = "push", refType = "tag", refName = TAG, windows = "false", digest = "" } = {}) {
  return { github: { event_name: event, ref_type: refType, ref_name: refName, ref: `refs/${refType === "tag" ? "tags" : "heads"}/${refName}` },
    vars: { YAWF_RELEASE_DESKTOP_ONLY_TAG: flag, YAWF_RELEASE_WINDOWS: windows }, inputs: { published_image_digest: digest }, needs: {} };
}

function scope(name, ctx) {
  const block = jobs(name)["release-scope"];
  assert.ok(block, "Missing scope job");
  const runStep = step(block, "Validate and resolve scope without credentials");
  assert.equal(scalar(runStep, "run", 8), 'node scripts/resolve_release_scope.mjs --github-output "$GITHUB_OUTPUT"');
  const values = Object.fromEntries(["EVENT_NAME", "REF_TYPE", "REF_NAME", "DESKTOP_ONLY_TAG"].map(key =>
    [key, expression(scalar(runStep, "RELEASE_SCOPE_" + key, 10), ctx)]));
  try { return { result: "success", outputs: resolveReleaseScope({ eventName: values.EVENT_NAME, refType: values.REF_TYPE,
    refName: values.REF_NAME, desktopOnlyTag: values.DESKTOP_ONLY_TAG }) }; }
  catch { return { result: "failure", outputs: {} }; }
}

function allSuccess(name, ctx) {
  ctx.workflowGraph = jobs(name);
  ctx.needs = Object.fromEntries(Object.keys(ctx.workflowGraph).map(key => [key, { result: "success", outputs: {} }]));
  ctx.needs["release-scope"] = scope(name, ctx);
  return ctx;
}

function callFlags(ctx) {
  const caller = jobs("web-release")["clean-install"];
  const needs = Object.fromEntries(dependencies(caller).map(name => [name, ctx.needs[name]]));
  return Object.fromEntries(["include_android", "include_server", "include_windows"].map(key => [key, expression(scalar(caller, key, 6), { ...ctx, needs })]));
}

function defaults(entrypoint) {
  const on = sources["clean-install"].split("\npermissions:")[0];
  const input = blocks(blocks(on, 2)[entrypoint], 6);
  return Object.fromEntries(["include_android", "include_server", "include_windows"].map(key => {
    assert.equal(scalar(input[key], "type", 8), "boolean");
    const value = scalar(input[key], "default", 8); assert.ok(["true", "false"].includes(value)); return [key, value === "true"];
  }));
}

const PLATFORMS = ["darwin-aarch64", "darwin-aarch64-app", "darwin-x86_64", "darwin-x86_64-app", "linux-x86_64", "linux-x86_64-appimage", "linux-x86_64-deb"];
const DESKTOP_ASSETS = ["YAWF.Stream_2.3.96_aarch64.dmg", "YAWF.Stream_2.3.96_x64.dmg", "YAWF.Stream_2.3.96_amd64.AppImage", "YAWF.Stream_2.3.96_amd64.AppImage.sig",
  "YAWF.Stream_2.3.96_amd64.deb", "YAWF.Stream_2.3.96_amd64.deb.sig", "YAWF.Stream_aarch64.app.tar.gz", "YAWF.Stream_aarch64.app.tar.gz.sig",
  "YAWF.Stream_x64.app.tar.gz", "YAWF.Stream_x64.app.tar.gz.sig", "latest.json", "latest-macos11.json"];
const ANDROID_ASSETS = ["YAWF.Stream_Android.TV_2.3.96.apk", "YAWF.Stream_Android_2.3.96.apk"];
const WINDOWS_ASSETS = ["YAWF.Stream_2.3.96_x64_en-US.msi", "YAWF.Stream_2.3.96_x64_en-US.msi.sig", "YAWF.Stream_2.3.96_x64-setup.exe", "YAWF.Stream_2.3.96_x64-setup.exe.sig"];
const WINDOWS_PLATFORMS = ["windows-x86_64", "windows-x86_64-msi", "windows-x86_64-nsis"];

function inventory({ scoped = true, windows = false, mutate = () => {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "desktop-scope-inventory-"));
  try {
    const ctx = allSuccess("web-release", context({ flag: scoped ? TAG : "", windows: String(windows) }));
    const flags = callFlags(ctx);
    const platformNames = [...PLATFORMS, ...(windows ? WINDOWS_PLATFORMS : [])];
    const platforms = Object.fromEntries(platformNames.map(key => [key, { url: `https://example.invalid/releases/download/${TAG}/${key}`, signature: "x".repeat(64) }]));
    const fixture = { platforms, assets: [...DESKTOP_ASSETS, ...(!scoped ? ANDROID_ASSETS : []), ...(windows ? WINDOWS_ASSETS : [])], version: "2.3.96" };
    mutate(fixture);
    for (const name of fixture.assets) writeFileSync(join(directory, name), "dummy fixture only\n");
    const legacy = { version: fixture.version, platforms: Object.fromEntries(Object.entries(fixture.platforms).filter(([key]) => !key.startsWith("darwin-x86_64"))) };
    const manifest = { version: fixture.version, platforms: fixture.platforms };
    const legacyPath = join(directory, "latest.json"), macosPath = join(directory, "latest-macos11.json"), namesPath = join(directory, "names.txt");
    writeFileSync(legacyPath, JSON.stringify(legacy)); writeFileSync(macosPath, JSON.stringify(manifest)); writeFileSync(namesPath, fixture.assets.join("\n") + "\n");
    const inventoryStep = step(jobs("clean-install").manifest, "Verify updater channels and signed assets");
    const script = scalar(inventoryStep, "run", 8);
    assert.match(script, /^set -euo pipefail\n/);
    assert.doesNotMatch(script, /\b(?:gh|curl|wget|sudo|codesign|security|xcrun|docker|npm|git|ssh)\b/);
    assert.doesNotMatch(script, /require\((?!["']node:fs["'])/);
    const env = { PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? ""), TMPDIR: tmpdir() };
    const evalContext = { inputs: { ...flags, tag: TAG }, runner: { temp: directory } };
    for (const key of ["RELEASE_TAG", "INCLUDE_WINDOWS", "INCLUDE_ANDROID", "INCLUDE_SERVER"]) env[key] = String(expression(scalar(inventoryStep, key, 10), evalContext));
    Object.assign(env, { LEGACY_JSON: legacyPath, MACOS11_JSON: macosPath, ASSET_NAMES: namesPath });
    const result = spawnSync("/bin/bash", ["-c", script], { env, cwd: directory, encoding: "utf8", timeout: 5000 });
    assert.equal(result.error, undefined, "Inventory subprocess did not complete");
    return result;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("expression model preserves raw helper input while matching GH case-insensitive comparisons", () => {
  const ctx = context({ flag: "V2.3.96-WEB" });
  assert.equal(expression("'TRUE' == 'true'", ctx), true);
  assert.equal(expression("'FAILED' != 'failed'", ctx), false);
  assert.equal(expression("vars.YAWF_RELEASE_DESKTOP_ONLY_TAG", ctx), "V2.3.96-WEB");
  assert.equal(scope("web-release", ctx).result, "failure");
});

test("all release-scope jobs wire actual context and unmodified variable into the frozen helper", () => {
  for (const name of ["web-release", "docker-image", "deb-release"]) {
    const ctx = context({ flag: TAG }); const result = scope(name, ctx);
    assert.equal(result.result, "success"); assert.equal(result.outputs.desktop_only, "true");
    const block = jobs(name)["release-scope"];
    for (const key of ["desktop_only", "include_android", "include_server"]) assert.equal(scalar(block, key, 6), `\${{ steps.scope.outputs.${key} }}`);
    assert.match(block, /persist-credentials: false/);
  }
});

for (const [label, flag, scoped] of [["normal coordinated", "", false], ["exact scoped", TAG, true], ["valid nonmatching", "v2.3.95-web", false]]) {
  test(`actual release and server job gates honor ${label} helper output`, () => {
    const web = allSuccess("web-release", context({ flag }));
    assert.equal(enabled(jobs("web-release")["macos-media-runtime"], web), true);
    assert.equal(enabled(jobs("web-release").release, web), true);
    for (const key of ["android-tv", "android-app", "android-app-publish"]) assert.equal(enabled(jobs("web-release")[key], web), !scoped);
    const docker = allSuccess("docker-image", context({ flag })); assert.equal(enabled(jobs("docker-image").docker, docker), !scoped);
    const deb = allSuccess("deb-release", context({ flag }));
    for (const key of ["deb", "compose-updater-check"]) assert.equal(enabled(jobs("deb-release")[key], deb), !scoped);
  });
}

for (const mode of ["invalid config", "scope failure", "no scope outputs", "unknown scope outputs"]) {
  test(`actual publishing gates fail closed for ${mode}`, () => {
    for (const name of ["web-release", "docker-image", "deb-release"]) {
      const ctx = allSuccess(name, context({ flag: mode === "invalid config" ? "true" : TAG }));
      if (mode === "scope failure") ctx.needs["release-scope"].result = "failure";
      if (mode === "no scope outputs") ctx.needs["release-scope"].outputs = {};
      if (mode === "unknown scope outputs") ctx.needs["release-scope"].outputs.desktop_only = "unknown";
      const keys = name === "web-release" ? ["macos-media-runtime", "release", "android-tv", "android-app", "android-app-publish", "finalize-release-assets"] : name === "docker-image" ? ["docker"] : ["deb", "compose-updater-check"];
      for (const key of keys) assert.equal(enabled(jobs(name)[key], ctx), false, name + "/" + key);
      if (name === "web-release") {
        ctx.needs["finalize-release-assets"].result = "skipped";
        assert.equal(enabled(jobs(name)["clean-install"], ctx), false);
      }
      if (name === "deb-release") {
        ctx.needs.deb.result = "skipped";
        assert.equal(enabled(jobs(name)["install-check"], ctx), false);
      }
    }
  });
}

test("implicit needs success blocks dependent installers and clean verification", () => {
  for (const state of ["skipped", "failure", "cancelled"]) {
    const deb = allSuccess("deb-release", context()); deb.needs.deb.result = state;
    assert.equal(enabled(jobs("deb-release")["install-check"], deb), false);
    const web = allSuccess("web-release", context()); web.needs["finalize-release-assets"].result = state;
    assert.equal(enabled(jobs("web-release")["clean-install"], web), false);
  }
});

test("desktop clean verification rescues skipped ancestors without exposing them as direct needs", () => {
  const ctx = allSuccess("web-release", context({ flag: TAG }));
  for (const name of ["android-tv", "android-app", "android-app-publish"]) ctx.needs[name].result = "skipped";
  assert.deepEqual(dependencies(jobs("web-release")["clean-install"]), ["release-scope", "finalize-release-assets"]);
  assert.equal(enabled(jobs("web-release")["finalize-release-assets"], ctx), true);
  assert.equal(enabled(jobs("web-release")["clean-install"], ctx), true);
  const bare = jobs("web-release")["clean-install"].replace("always() && !cancelled() && ", "");
  assert.equal(enabled(bare, ctx), false);
});

test("global cancellation blocks both finalization and clean verification independently of dependency results", () => {
  const ctx = allSuccess("web-release", context({ flag: TAG }));
  ctx.needs["android-tv"].result = "skipped"; ctx.needs["android-app-publish"].result = "skipped";
  assert.equal(enabled(jobs("web-release")["finalize-release-assets"], ctx), true);
  assert.equal(enabled(jobs("web-release")["clean-install"], ctx), true);
  ctx.workflowCancelled = true;
  assert.equal(enabled(jobs("web-release")["finalize-release-assets"], ctx), false);
  assert.equal(enabled(jobs("web-release")["clean-install"], ctx), false);
  assert.equal(enabled(jobs("web-release").release, ctx), false);
});

test("manual Android branch verification runs despite skipped release and malformed unrelated flag", () => {
  const ctx = allSuccess("web-release", context({ event: "workflow_dispatch", refType: "branch", refName: "main", flag: "malformed" }));
  ctx.needs.release.result = "skipped";
  assert.equal(enabled(jobs("web-release").release, ctx), false);
  assert.equal(enabled(jobs("web-release")["android-app"], ctx), true);
  assert.equal(enabled(jobs("web-release")["android-app-publish"], ctx), false);
  ctx.needs["release-scope"].result = "failure";
  assert.equal(enabled(jobs("web-release")["android-app"], ctx), false);
});

test("manual immutable-image verifier stays independent of release scope", () => {
  const ctx = allSuccess("docker-image", context({ event: "workflow_dispatch", refType: "branch", refName: "main", flag: "malformed", digest: "sha256:" + "a".repeat(64) }));
  ctx.needs["release-scope"].result = "failure";
  assert.equal(enabled(jobs("docker-image")["verify-published"], ctx), true);
  assert.equal(enabled(jobs("docker-image").docker, ctx), false);
});

test("finalizer accepts skipped Android jobs only in explicit desktop-only scope", () => {
  for (const scoped of [true, false]) {
    for (const tv of ["success", "skipped", "failure", "cancelled"]) for (const phone of ["success", "skipped", "failure", "cancelled"]) {
      const ctx = allSuccess("web-release", context({ flag: scoped ? TAG : "" }));
      ctx.needs["android-tv"].result = tv; ctx.needs["android-app-publish"].result = phone;
      assert.equal(enabled(jobs("web-release")["finalize-release-assets"], ctx), scoped ? tv === "skipped" && phone === "skipped" : tv === "success" && phone === "success");
      for (const releaseResult of ["failure", "cancelled", "skipped"]) {
        ctx.needs.release.result = releaseResult;
        assert.equal(enabled(jobs("web-release")["finalize-release-assets"], ctx), false);
      }
      ctx.needs.release.result = "success";
      for (const scopeResult of ["failure", "cancelled", "skipped"]) {
        ctx.needs["release-scope"].result = scopeResult;
        assert.equal(enabled(jobs("web-release")["finalize-release-assets"], ctx), false);
      }
    }
  }
});

test("both clean-install entrypoints default Android/server true and Windows held", () => {
  for (const entrypoint of ["workflow_call", "workflow_dispatch"]) assert.deepEqual(defaults(entrypoint), { include_android: true, include_server: true, include_windows: false });
});

test("caller passes scoped flags while mandatory Mac/Linux and held Windows remain intact", () => {
  const clean = jobs("clean-install");
  for (const scoped of [true, false]) {
    const ctx = allSuccess("web-release", context({ flag: scoped ? TAG : "" }));
    const flags = callFlags(ctx); assert.deepEqual(flags, { include_android: !scoped, include_server: !scoped, include_windows: false });
    const child = { inputs: flags, needs: {} };
    for (const key of ["manifest", "macos", "linux"]) assert.equal(enabled(clean[key], child), true);
    for (const key of ["android-phone", "android-tv", "server-deb"]) assert.equal(enabled(clean[key], child), !scoped);
    assert.equal(enabled(clean.windows, child), false);
  }
  const release = jobs("web-release").release;
  assert.equal([...release.matchAll(/^            os: macos$/gm)].length, 2);
  assert.equal([...release.matchAll(/^            os: linux$/gm)].length, 1);
  const build = step(release, "Build, bundle, sign & release");
  for (const os of ["macos", "linux", "windows"]) {
    const ctx = context(); ctx.matrix = { os };
    assert.equal(expression(scalar(build, "if", 8), ctx), os !== "windows");
  }
  const windows = allSuccess("web-release", context({ flag: TAG, windows: "true" }));
  windows.matrix = { os: "windows" };
  assert.equal(callFlags(windows).include_windows, true);
  assert.equal(expression(scalar(build, "if", 8), windows), true);
  for (const name of ["Bundle Node runtime for Windows", "Bundle ffmpeg for Windows", "Configure Windows Authenticode signing"]) {
    const gate = scalar(step(release, name), "if", 8);
    assert.equal(expression(gate, { ...windows, vars: { ...windows.vars, YAWF_RELEASE_WINDOWS: "false" } }), false);
    assert.equal(expression(gate, windows), true);
  }
});

test("actual inventory accepts seven desktop platforms and twelve mandatory desktop asset files", () => {
  assert.equal(PLATFORMS.length, 7); assert.equal(DESKTOP_ASSETS.length, 12);
  const result = inventory(); assert.equal(result.status, 0, result.stderr);
});

test("actual inventory keeps every desktop platform and file mandatory", () => {
  for (const key of PLATFORMS) assert.notEqual(inventory({ mutate: fixture => { delete fixture.platforms[key]; } }).status, 0, key);
  for (const asset of DESKTOP_ASSETS) assert.notEqual(inventory({ mutate: fixture => { fixture.assets = fixture.assets.filter(value => value !== asset); } }).status, 0, asset);
});

test("coordinated inventory still requires both phone and TV APKs", () => {
  const normal = inventory({ scoped: false }); assert.equal(normal.status, 0, normal.stderr);
  for (const asset of ANDROID_ASSETS) assert.notEqual(inventory({ scoped: false, mutate: fixture => { fixture.assets = fixture.assets.filter(value => value !== asset); } }).status, 0);
});

test("desktop inventory rejects canonical, unknown and uppercase Android artifact leaks", () => {
  for (const asset of [...ANDROID_ASSETS, "unrelated.apk", "unknown.APK", "unknown.apk.sig", "unknown.APK.SIG"]) {
    assert.notEqual(inventory({ mutate: fixture => fixture.assets.push(asset) }).status, 0, asset);
  }
});

test("desktop inventory rejects reserved server packages and smoke/verification receipts", () => {
  for (const asset of ["debridstreamer-server_2.3.96_all.deb", "debridstreamer-server-smoke.json", "DEBRIDSTREAMER-SERVER_SMOKE.JSON",
    "yawf-server-updater_2.3.96.tar.gz", "server-update.json", "Server_2.3.96_verification.json"]) {
    assert.notEqual(inventory({ mutate: fixture => fixture.assets.push(asset) }).status, 0, asset);
  }
});

test("held Windows inventory rejects leaked channels and installers", () => {
  for (const key of WINDOWS_PLATFORMS) assert.notEqual(inventory({ mutate: fixture => { fixture.platforms[key] = fixture.platforms[PLATFORMS[0]]; } }).status, 0);
  for (const asset of [...WINDOWS_ASSETS, "Windows_notes.txt"]) assert.notEqual(inventory({ mutate: fixture => fixture.assets.push(asset) }).status, 0, asset);
});

test("explicit Windows inventory preserves the existing required channels and signed files", () => {
  const positive = inventory({ windows: true }); assert.equal(positive.status, 0, positive.stderr);
  for (const key of WINDOWS_PLATFORMS) assert.notEqual(inventory({ windows: true, mutate: fixture => { delete fixture.platforms[key]; } }).status, 0);
  for (const asset of WINDOWS_ASSETS) assert.notEqual(inventory({ windows: true, mutate: fixture => { fixture.assets = fixture.assets.filter(value => value !== asset); } }).status, 0, asset);
});

test("server tests remain mandatory for shipping desktops but do not package a held Windows channel", () => {
  const server = step(jobs("web-release").release, "Test server");
  const condition = scalar(server, "if", 8);
  assert.equal(condition, "matrix.os != 'windows' || vars.YAWF_RELEASE_WINDOWS == 'true'");
  assert.equal(scalar(server, "working-directory", 8), "server");
  assert.equal(scalar(server, "run", 8), "npm test");
  for (const os of ["macos", "linux", "windows"]) {
    for (const flag of ["", "false", "true"]) {
      assert.equal(truthy(expression(condition, {
        matrix: { os }, vars: { YAWF_RELEASE_WINDOWS: flag },
      })), os !== "windows" || flag === "true", `${os}/${flag}`);
    }
  }
});
