import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { admitHostedRunner, admitOwnedPath, bundleManifest, patchXCTestRun, pathsOverlap, validateReceipt } from "./controller.mjs";

const admitted = { CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "macOS", RUNNER_ARCH: "ARM64", RUNNER_TEMP: "/Users/runner/work/_temp", HOME: "/Users/runner" };
const runtime = { platform: "darwin", arch: "arm64", machine: "arm64", type: "Darwin", kernelRelease: "24.6.0", macOSVersion: "15.7.1", username: "runner", homedir: "/Users/runner", homedirRealpath: "/Users/runner", uid: 501, processUid: 501 };

test("runner admission accepts only the intended hosted arm runner", () => {
  assert.doesNotThrow(() => admitHostedRunner(admitted, runtime));
});

for (const [name, mutation] of Object.entries({
  ci: { CI: "false" }, actions: { GITHUB_ACTIONS: "false" }, environment: { RUNNER_ENVIRONMENT: "self-hosted" },
  declaredOS: { RUNNER_OS: "Linux" }, declaredArch: { RUNNER_ARCH: "X64" }, temp: { RUNNER_TEMP: "/tmp" }, home: { HOME: "/Users/local-user" },
})) test(`runner admission rejects fake environment: ${name}`, () => assert.throws(() => admitHostedRunner({ ...admitted, ...mutation }, runtime)));

for (const [name, mutation] of Object.entries({
  platform: { platform: "linux" }, osType: { type: "Linux" }, processArch: { arch: "x64" }, machine: { machine: "x86_64" },
  macOS: { macOSVersion: "26.1" }, kernel: { kernelRelease: "25.1.0" }, username: { username: "local-user" },
  accountHome: { homedir: "/Users/local-user" }, accountHomeLink: { homedirRealpath: "/private/Users/runner" }, uid: { uid: 502 }, processUid: { processUid: 502 },
})) test(`runner admission rejects actual runtime mismatch despite matching environment: ${name}`, () => assert.throws(() => admitHostedRunner(admitted, { ...runtime, ...mutation })));

test("owned path admission rejects paths outside runner temp", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mac-ota-owned-")));
  const inside = path.join(root, "inside");
  await mkdir(inside);
  assert.equal(await admitOwnedPath(path.join(inside, "file"), root), path.join(await realpath(inside), "file"));
  await assert.rejects(admitOwnedPath(path.join(os.tmpdir(), "outside", "file"), root));
  const linked = path.join(inside, "linked");
  await symlink("/Applications", linked);
  await assert.rejects(admitOwnedPath(linked, root));
});

test("owned path admission rejects an ancestor symlink even when it resolves inside the owned root", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mac-ota-ancestor-")));
  const physical = path.join(root, "physical");
  const alias = path.join(root, "alias");
  await mkdir(physical);
  await symlink(physical, alias);
  await assert.rejects(admitOwnedPath(path.join(alias, "candidate"), root), /symlinked ancestor/);
});

test("xctestrun patch targets only the XCTest runner environment", () => {
  const input = { __xctestrun_metadata__: { FormatVersion: 2 }, MacOTARuntimeTests: { EnvironmentVariables: { KEEP: "yes" }, UITargetAppPath: "" } };
  const result = patchXCTestRun(input, { YAWF_OTA_CONFIG_PATH: "/runner/temp/config" });
  assert.deepEqual(result.MacOTARuntimeTests.EnvironmentVariables, { KEEP: "yes", YAWF_OTA_CONFIG_PATH: "/runner/temp/config" });
  assert.equal(result.MacOTARuntimeTests.UITargetAppEnvironmentVariables, undefined);
  assert.throws(() => patchXCTestRun({ MacOTARuntimeTests: { UITargetAppEnvironmentVariables: { SECRET: "no" } } }, {}));
  assert.throws(() => patchXCTestRun({ MacOTARuntimeTests: { UITargetAppPath: "/Applications/YAWF Stream.app" } }, {}));
  assert.throws(() => patchXCTestRun({ A: {}, B: {} }, {}));

  const modern = { __xctestrun_metadata__: { FormatVersion: 2 }, TestConfigurations: [{ TestTargets: [{ BlueprintName: "MacOTARuntimeTests" }] }] };
  const modernResult = patchXCTestRun(modern, { CI: "true" });
  assert.deepEqual(modernResult.TestConfigurations[0].TestTargets[0].EnvironmentVariables, { CI: "true" });
});

test("xctestrun patch strips only the exact Xcode-generated target environment", () => {
  const generated = {
    APP_DISTRIBUTOR_ID_OVERRIDE: "com.apple.AppStore",
    DYLD_FRAMEWORK_PATH: "__TESTROOT__/Release",
    DYLD_LIBRARY_PATH: "__TESTROOT__/Release",
    XCODE_SCHEME_NAME: "MacOTARuntime",
    __XCODE_BUILT_PRODUCTS_DIR_PATHS: "__TESTROOT__/Release",
    __XPC_DYLD_FRAMEWORK_PATH: "__TESTROOT__/Release",
    __XPC_DYLD_LIBRARY_PATH: "__TESTROOT__/Release",
  };
  const document = { MacOTARuntimeTests: { UITargetAppEnvironmentVariables: { ...generated } } };
  const result = patchXCTestRun(document, { CI: "true" });
  assert.equal(result.MacOTARuntimeTests.UITargetAppEnvironmentVariables, undefined);
  assert.deepEqual(result.MacOTARuntimeTests.EnvironmentVariables, { CI: "true" });
  assert.throws(() => patchXCTestRun({ MacOTARuntimeTests: { UITargetAppEnvironmentVariables: { ...generated, DYLD_LIBRARY_PATH: "/tmp/injected" } } }, {}));
  assert.throws(() => patchXCTestRun({ MacOTARuntimeTests: { UITargetAppEnvironmentVariables: { ...generated, TOKEN: "forbidden" } } }, {}));
});

test("bundle manifest is content and mode sensitive and rejects symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mac-ota-manifest-"));
  await writeFile(path.join(root, "a"), "one", { mode: 0o600 });
  const first = await bundleManifest(root);
  await writeFile(path.join(root, "a"), "two", { mode: 0o600 });
  assert.notEqual(await bundleManifest(root), first);
  await symlink("a", path.join(root, "alias"));
  await assert.rejects(bundleManifest(root));
});

test("reference and candidate paths must be disjoint trees", () => {
  assert.equal(pathsOverlap("/runner/candidate.app", "/runner/reference.app"), false);
  assert.equal(pathsOverlap("/runner/candidate.app", "/runner/candidate.app"), true);
  assert.equal(pathsOverlap("/runner/candidate.app", "/runner/candidate.app/reference"), true);
  assert.equal(pathsOverlap("/runner/candidate.app/nested", "/runner/candidate.app"), true);
});

test("receipt requires an exact relaunch, path, state, and normal quit", () => {
  const expected = { appPath: "/runner/temp/YAWF Stream.app", executablePath: "/runner/temp/YAWF Stream.app/Contents/MacOS/debridstreamer" };
  const receipt = {
    appPath: expected.appPath, beforePID: 10, afterPID: 11,
    beforeExecutablePath: expected.executablePath, afterExecutablePath: expected.executablePath,
    beforeVersion: "2.3.96", afterVersion: "2.3.102", profileName: "OTA Runner",
    density: "Compact", watchlistTitle: "Inception", normalQuitObserved: true,
    preInstallReopenUsed: false,
  };
  assert.doesNotThrow(() => validateReceipt(receipt, expected));
  for (const mutation of [
    { afterPID: 10 }, { appPath: "/Applications/YAWF Stream.app" }, { afterVersion: "2.3.96" },
    { afterExecutablePath: "/Applications/YAWF Stream.app/Contents/MacOS/debridstreamer" },
    { profileName: "You" }, { density: "Comfortable" }, { watchlistTitle: "Other" }, { preInstallReopenUsed: "false" }, { normalQuitObserved: false },
  ]) assert.throws(() => validateReceipt({ ...receipt, ...mutation }, expected));
});
