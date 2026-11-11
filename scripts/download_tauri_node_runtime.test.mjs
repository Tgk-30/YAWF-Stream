import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { DEFAULT_NODE_RUNTIME_VERSION, MACOS_NODE_RUNTIME_VERSION } from "./desktop_node_runtime_policy.mjs";

// Optional paths select owned static copies for causal controls, never execution.
const downloader = readFileSync(process.env.NODE_RUNTIME_DOWNLOADER_SOURCE
  ?? new URL("./download_tauri_node_runtime.mjs", import.meta.url), "utf8");
const workflow = readFileSync(process.env.NODE_RUNTIME_WORKFLOW_SOURCE
  ?? new URL("../.github/workflows/web-release.yml", import.meta.url), "utf8");
const ci = readFileSync(process.env.NODE_RUNTIME_CI_SOURCE
  ?? new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function selection(hostVersion, override, platform = "linux-x64", policyDefault = DEFAULT_NODE_RUNTIME_VERSION) {
  const root = downloader.indexOf('const root = join(dirname(fileURLToPath(import.meta.url)), "..");');
  assert.notEqual(root, -1);
  const start = downloader.indexOf("\n", root) + 1;
  const end = downloader.indexOf("const cacheDir =", start);
  assert.ok(end > start);
  // Execute the actual selection/validation preamble, stopping before any I/O.
  const preamble = downloader.slice(start, end);
  assert.doesNotMatch(preamble, /mkdirSync|download\(|execFileSync|\bget\(/);
  const errors = [];
  const context = { DEFAULT_NODE_RUNTIME_VERSION: policyDefault, join,
    process: { versions: { node: hostVersion }, env: { NODE_RUNTIME_VERSION: override },
      argv: ["node", "downloader", platform], exit(code) { throw new Error(`downloader-exit-${code}`); } },
    console: { error(...parts) { errors.push(parts.join(" ")); } } };
  const run = () => vm.runInNewContext(preamble + "\nversion;", context, { timeout: 1000 });
  return { run, errors };
}

test("downloader default is the shared patched runtime, independent of host Node and target platform", () => {
  for (const host of ["24.17.0", "24.22.2", "24.99.0", "22.23.4", "26.1.0"])
    for (const platform of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win-x64", "win-arm64"])
      assert.equal(selection(host, undefined, platform).run(), "24.22.2");
  assert.equal(selection("24.99.0", undefined, "linux-x64", "24.88.99").run(), "24.88.99");
  assert.match(downloader, /import \{ DEFAULT_NODE_RUNTIME_VERSION \} from "\.\/desktop_node_runtime_policy\.mjs";/);
  assert.doesNotMatch(downloader, /process\.versions\.node|currentNodeVersion|defaultNodeRuntimeVersion/);
});

test("downloader keeps nullish defaults and validated explicit overrides before download preparation", () => {
  for (const override of [undefined, null]) assert.equal(selection("24.99.0", override).run(), "24.22.2");
  for (const platform of ["darwin-arm64", "linux-x64", "win-x64"]) {
    assert.equal(selection("24.99.0", "v22.23.4", platform).run(), "22.23.4");
    assert.equal(selection("24.99.0", "24.22.2", platform).run(), "24.22.2");
    for (const bad of ["", "latest", "22.23", "22;echo unsafe", "V22.23.4", "22.23.4-rc.1", " 22.23.4"]) {
      const selected = selection("24.99.0", bad, platform);
      assert.throws(selected.run, /downloader-exit-1/);
      assert.ok(selected.errors.includes("Expected a plain semver version such as 24.22.2."));
    }
  }
});

test("standard macOS Bundle Node runtime step pins the shared Mac policy explicitly", () => {
  const matches = [...workflow.matchAll(/^      - name: Bundle Node runtime \(macOS\)\n((?: {8}[^\n]*\n)+)/gm)];
  assert.equal(matches.length, 1, "Expected exactly one standard macOS Node step");
  const block = matches[0][1];
  assert.ok(block.includes("        if: matrix.os == 'macos'\n"));
  const pins = [...block.matchAll(/^          NODE_RUNTIME_VERSION: "([^"]+)"$/gm)];
  assert.equal(pins.length, 1, "Expected exactly one explicit Node pin");
  assert.equal(pins[0][1], MACOS_NODE_RUNTIME_VERSION);
  assert.ok(block.includes("        run: node scripts/download_tauri_node_runtime.mjs ${{ matrix.node_runtime }}\n"));
});

test("macos-node-compatibility CI job pins the shared Mac policy", () => {
  const jobs = [...ci.matchAll(/^  macos-node-compatibility:\n((?: {4}[^\n]*\n|\n)+)/gm)];
  assert.equal(jobs.length, 1, "Expected exactly one Mac Node compatibility job");
  const setups = [...jobs[0][1].matchAll(/^      - uses: actions\/setup-node@v4\n        with:\n          node-version: "([^"]+)"\n/gm)];
  assert.equal(setups.length, 1, "Expected exactly one explicit compatibility Node pin");
  assert.equal(setups[0][1], MACOS_NODE_RUNTIME_VERSION);
});
