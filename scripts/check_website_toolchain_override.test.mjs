import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertProjectServiceOff, probeMinimatchConsumer, validateWebsiteToolchainOverride } from "./check_website_toolchain_override.mjs";

// Pure fixtures and repository text only: no website node_modules are imported.
function fixture() {
  return {
    packageJson: {
      overrides: { "@typescript-eslint/typescript-estree@8.52.0": { minimatch: "11.0.1" } },
      scripts: { build: "npm run check:toolchain && tsc -b && vite build && npm run check:bundle", "check:toolchain": "node ../scripts/check_website_toolchain_override.mjs" },
    },
    lock: { packages: {
      "node_modules/@typescript-eslint/typescript-estree": { version: "8.52.0", dev: true },
      "node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch": { version: "11.0.1", dev: true },
      "node_modules/typescript-eslint": { version: "8.52.0", dev: true },
    } },
    eslintSource: readFileSync(new URL("../website-app/eslint.config.js", import.meta.url), "utf8"),
    nodeVersion: "v22.23.4",
  };
}

test("accepts only the reviewed exact development override on Node22/24", () => {
  const value = fixture();
  assert.deepEqual(validateWebsiteToolchainOverride(value), []);
  value.nodeVersion = "v24.22.2";
  assert.deepEqual(validateWebsiteToolchainOverride(value), []);
});

for (const [name, mutate] of [
  ["global minimatch", v => { v.packageJson.overrides = { minimatch: "11.0.1" }; }],
  ["unversioned parent", v => { v.packageJson.overrides = { "@typescript-eslint/typescript-estree": { minimatch: "11.0.1" } }; }],
  ["additional override", v => { v.packageJson.overrides.other = "1.0.0"; }],
  ["floating minimatch", v => { v.packageJson.overrides["@typescript-eslint/typescript-estree@8.52.0"].minimatch = "^11.0.1"; }],
  ["parent drift", v => { v.lock.packages["node_modules/@typescript-eslint/typescript-estree"].version = "8.72.2"; }],
  ["root parent drift", v => { v.lock.packages["node_modules/typescript-eslint"].version = "8.72.2"; }],
  ["resolved minimatch drift", v => { v.lock.packages["node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch"].version = "9.0.9"; }],
  ["production edge", v => { v.lock.packages["node_modules/@typescript-eslint/typescript-estree"].dev = false; }],
  ["production minimatch", v => { v.lock.packages["node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch"].dev = false; }],
  ["missing lock node", v => { delete v.lock.packages["node_modules/@typescript-eslint/typescript-estree"]; }],
  ["removed build gate", v => { v.packageJson.scripts.build = "tsc -b && vite build && npm run check:bundle"; }],
  ["gate after build", v => { v.packageJson.scripts.build = "tsc -b && vite build && npm run check:toolchain && npm run check:bundle"; }],
  ["changed gate command", v => { v.packageJson.scripts["check:toolchain"] = "echo pass"; }],
  ["projectService config", v => { v.eslintSource += "\nconst parserOptions = { projectService: true }"; }],
  ["allowDefaultProject config", v => { v.eslintSource += "\nconst parserOptions = { allowDefaultProject: ['*.ts'] }"; }],
  ["other config drift", v => { v.eslintSource += "\n// requires a fresh scoped review"; }],
  ["unreviewed Node18", v => { v.nodeVersion = "v18.20.0"; }],
  ["unreviewed Node26", v => { v.nodeVersion = "v26.5.0"; }],
]) {
  test(`refuses ${name}`, () => {
    const value = fixture(); mutate(value);
    assert.ok(validateWebsiteToolchainOverride(value).length > 0);
  });
}

test("refuses resolved project-service settings without traversing plugins", () => {
  assert.throws(() => assertProjectServiceOff(undefined));
  assert.doesNotThrow(() => assertProjectServiceOff({ languageOptions: { parserOptions: {} } }));
  assert.doesNotThrow(() => assertProjectServiceOff({ languageOptions: { parserOptions: { projectService: false } } }));
  for (const parserOptions of [{ projectService: true }, { projectService: { allowDefaultProject: ["*.ts"] } }, { allowDefaultProject: [] }]) {
    assert.throws(() => assertProjectServiceOff({ languageOptions: { parserOptions } }));
  }
});

test("consumer probe refuses missing named function, nonboolean and broken dot behavior", () => {
  assert.throws(() => probeMinimatchConsumer(undefined, () => false));
  assert.throws(() => probeMinimatchConsumer(() => "true", () => true));
  assert.throws(() => probeMinimatchConsumer(() => false, () => false));
});
