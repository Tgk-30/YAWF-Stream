#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const parentName = "@typescript-eslint/typescript-estree";
const parentKey = `${parentName}@8.52.0`;
const parentPath = `node_modules/${parentName}`;
const minimatchPath = `${parentPath}/node_modules/minimatch`;
const configHash = "21e6d832d9b9ed62f1e4a3e6c42560ae83a6b99d9f56596202ddea9641c0ab51";
const consumerHash = "c4e1897950f02316540978b62449f19b78c8cde820358eadec438d45ce5495c8";
const sha = (source) => createHash("sha256").update(source).digest("hex");

export function validateWebsiteToolchainOverride({ packageJson, lock, eslintSource, nodeVersion }) {
  const failures = [];
  if (JSON.stringify(packageJson.overrides) !== JSON.stringify({ [parentKey]: { minimatch: "11.0.1" } })) {
    failures.push("Only the exact estree8.52.0 development edge may override minimatch11.0.1.");
  }
  if (packageJson.scripts?.build !== "npm run check:toolchain && tsc -b && vite build && npm run check:bundle" ||
      packageJson.scripts?.["check:toolchain"] !== "node ../scripts/check_website_toolchain_override.mjs") {
    failures.push("The reviewed override guard must run before the website build.");
  }
  for (const [name, version] of [[parentPath, "8.52.0"], [minimatchPath, "11.0.1"], ["node_modules/typescript-eslint", "8.52.0"]]) {
    if (lock.packages?.[name]?.version !== version || lock.packages[name].dev !== true) {
      failures.push(`The reviewed development-only ${name} version must remain ${version}.`);
    }
  }
  if (/\b(?:projectService|allowDefaultProject)\b/.test(eslintSource) || sha(eslintSource) !== configHash) {
    failures.push("The reviewed projectService-off ESLint config changed; review the exception again.");
  }
  if (!/^v?(?:22|24)\./.test(nodeVersion)) {
    failures.push("This exception is qualified only on the reviewed Node22/24 toolchains.");
  }
  return failures;
}

export function assertProjectServiceOff(configuration) {
  // Inspect parser options only, never traverse cyclic parser/plugin objects.
  assert.ok(configuration && typeof configuration === "object", "A resolved ESLint configuration is required");
  const options = configuration.languageOptions?.parserOptions ?? {};
  assert.ok(options.projectService == null || options.projectService === false, "Unreviewed projectService configuration");
  assert.ok(!Object.hasOwn(options, "allowDefaultProject"), "Unreviewed allowDefaultProject configuration");
}

export function probeMinimatchConsumer(minimatch, consumer) {
  assert.equal(typeof minimatch, "function", "The CJS named minimatch export is required");
  const cases = [
    ["eslint.config.js", "*.js", true], [".eslintrc.js", "*.js", true],
    ["src/a.ts", "src/*.ts", true], ["nested/a.ts", "*.ts", false],
    ["src/foo.ts", "src/@(foo|bar).ts", true], ["src/no.ts", "src/@(foo|bar).ts", false],
    ["src/a.tsx", "src/*.{ts,tsx}", true], ["src/a.ts", "src/[ab].ts", true],
    ["src/c.ts", "src/[ab].ts", false], ["config/.hidden.ts", "config/*.ts", true],
    ["foo.ts", "!private.ts", true], ["private.ts", "!private.ts", false],
  ];
  for (const [file, pattern, expected] of cases) {
    assert.equal(minimatch(file, pattern, { dot: true }), expected);
    assert.equal(consumer(file, [pattern]), expected);
  }
  assert.equal(consumer("file.ts", undefined), false);
  return cases.length;
}

export async function checkWebsiteToolchainOverride(projectRoot = root) {
  const website = resolve(projectRoot, "website-app");
  const packageJson = JSON.parse(readFileSync(resolve(website, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(resolve(website, "package-lock.json"), "utf8"));
  const eslintSource = readFileSync(resolve(website, "eslint.config.js"), "utf8");
  const failures = validateWebsiteToolchainOverride({ packageJson, lock, eslintSource, nodeVersion: process.version });
  assert.deepEqual(failures, [], failures.join("\n"));
  const requireWebsite = createRequire(resolve(website, "package.json"));
  const parentPackage = requireWebsite.resolve(`${parentName}/package.json`);
  const requireParent = createRequire(parentPackage);
  const minimatchPackage = requireParent.resolve("minimatch/package.json");
  assert.equal(parentPackage, resolve(website, parentPath, "package.json"));
  assert.equal(minimatchPackage, resolve(website, minimatchPath, "package.json"));
  assert.equal(requireParent(parentPackage).version, "8.52.0");
  assert.equal(requireParent(minimatchPackage).version, "11.0.1");
  const caller = resolve(dirname(parentPackage), "dist/useProgramFromProjectService.js");
  const source = readFileSync(caller, "utf8");
  assert.equal(sha(source), consumerHash, "The reviewed actual minimatch consumer changed");
  // Execute the actual pinned CJS module with its real dependency resolution.
  // Expose its existing private pure matcher only in this in-memory build probe.
  const module = new Module(caller);
  module.filename = caller;
  module.paths = Module._nodeModulePaths(dirname(caller));
  module._compile(`${source}\nexports.contractOnlyFilePathMatchedBy = filePathMatchedBy;`, caller);
  const comparisons = probeMinimatchConsumer(requireParent("minimatch").minimatch, module.exports.contractOnlyFilePathMatchedBy);
  const { ESLint } = requireWebsite("eslint");
  const eslint = new ESLint({ cwd: website });
  assertProjectServiceOff(await eslint.calculateConfigForFile(resolve(website, "src/main.tsx")));
  return { parent: "8.52.0", minimatch: "11.0.1", node: process.version, contractCases: comparisons, projectService: false };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkWebsiteToolchainOverride();
    console.log(`Website development toolchain exception passed: ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`Website development toolchain exception refused: ${error.message}`);
    process.exitCode = 1;
  }
}
