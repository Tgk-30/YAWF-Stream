import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { admitHostedRunner, admitOwnedPath, bundleManifest, loadReceiptAttachment, patchXCTestRun, pathsOverlap, validateReceipt } from "./controller.mjs";

const admitted = { CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "macOS", RUNNER_ARCH: "ARM64", RUNNER_TEMP: "/Users/runner/work/_temp", HOME: "/Users/runner" };
const runtime = { platform: "darwin", arch: "arm64", machine: "arm64", type: "Darwin", kernelRelease: "24.6.0", macOSVersion: "15.7.1", username: "runner", homedir: "/Users/runner", homedirRealpath: "/Users/runner", uid: 501, processUid: 501 };
const receiptFileName = "12345678-1234-1234-1234-1234567890AB.json";
const testIdentifier = "MacOTARuntimeTests/testPublic96To102ThroughNormalUpdaterUI()";
const testIdentifierURL = "test://com.apple.xcode/MacOTARuntime/MacOTARuntimeTests/MacOTARuntimeTests/testPublic96To102ThroughNormalUpdaterUI";

async function makeAttachmentFixture() {
  const runnerTemp = await realpath(await mkdtemp(path.join(os.tmpdir(), "mac-ota-attachment-")));
  const exportRoot = path.join(runnerTemp, "attachments");
  await mkdir(exportRoot);
  const receipt = { beforePID: 10, afterPID: 11, normalQuitObserved: true };
  const attachment = {
    configurationName: "Test Scheme Action", deviceId: "device-hash", deviceName: "My Mac",
    exportedFileName: receiptFileName, isAssociatedWithFailure: false,
    suggestedHumanReadableName: "MacOTARuntimeReceipt_0_ABCDEFAB-1234-5678-9ABC-ABCDEFABCDEF.json", timestamp: 1,
  };
  const manifest = [{ testIdentifier, testIdentifierURL, attachments: [
    { ...attachment, exportedFileName: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA.mp4", suggestedHumanReadableName: "Screen Recording.mp4" },
    attachment,
  ] }];
  await writeFile(path.join(exportRoot, receiptFileName), JSON.stringify(receipt));
  await writeFile(path.join(exportRoot, "manifest.json"), JSON.stringify(manifest));
  return { runnerTemp, exportRoot, receipt, attachment, manifest };
}

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

test("attachment receipt requires exact testcase and named bounded JSON", async () => {
  const fixture = await makeAttachmentFixture();
  const loaded = await loadReceiptAttachment(fixture.exportRoot, fixture.runnerTemp);
  assert.deepEqual(loaded.receipt, fixture.receipt);
  assert.equal(loaded.exportedFileName, receiptFileName);
  assert.match(loaded.sha256, /^[0-9a-f]{64}$/);
});

test("attachment receipt rejects a different testcase identity", async () => {
  const fixture = await makeAttachmentFixture();
  fixture.manifest[0].testIdentifier = "OtherTests/testOther()";
  await writeFile(path.join(fixture.exportRoot, "manifest.json"), JSON.stringify(fixture.manifest));
  await assert.rejects(loadReceiptAttachment(fixture.exportRoot, fixture.runnerTemp), /testcase identity/);
});

test("attachment receipt rejects ambiguous exact names", async () => {
  const fixture = await makeAttachmentFixture();
  fixture.manifest[0].attachments.push({ ...fixture.attachment, exportedFileName: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB.json" });
  await writeFile(path.join(fixture.exportRoot, "manifest.json"), JSON.stringify(fixture.manifest));
  await assert.rejects(loadReceiptAttachment(fixture.exportRoot, fixture.runnerTemp), /exactly one named/);
});

test("attachment receipt rejects path traversal", async () => {
  const fixture = await makeAttachmentFixture();
  fixture.manifest[0].attachments[1].exportedFileName = "../receipt.json";
  await writeFile(path.join(fixture.exportRoot, "manifest.json"), JSON.stringify(fixture.manifest));
  await assert.rejects(loadReceiptAttachment(fixture.exportRoot, fixture.runnerTemp), /unsafe exported/);
});

test("attachment receipt rejects a file at the size bound", async () => {
  const fixture = await makeAttachmentFixture();
  await writeFile(path.join(fixture.exportRoot, receiptFileName), Buffer.alloc(64 * 1024));
  await assert.rejects(loadReceiptAttachment(fixture.exportRoot, fixture.runnerTemp), /bounds invalid/);
});

test("Swift source retains actual machine gates and uses an XCTest attachment", async () => {
  const source = await readFile(new URL("./MacOTARuntimeTests/MacOTARuntimeTests.swift", import.meta.url), "utf8");
  assert.match(source, /getpwuid\(uid\)/);
  assert.match(source, /majorVersion == 15/);
  assert.match(source, /kernelRelease\(\)\?\.hasPrefix\("24\."\)/);
  assert.doesNotMatch(source, /environment\["HOME"\]/);
  assert.match(source, /XCTAttachment\(data:/);
  assert.match(source, /attachment\.lifetime = \.keepAlways/);
  assert.doesNotMatch(source, /Data\.write|writeReceipt/);
});

function swiftSection(source, start, end) {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin + start.length);
  assert.ok(begin >= 0 && finish > begin, `Missing Swift section: ${start}`);
  return source.slice(begin, finish);
}

function assertTitleAwareQueries(source) {
  const named = swiftSection(source, "private func named(", "private func findUniqueStaticText(");
  assert.match(named, /"title == %@ OR label == %@", name, name/);
  assert.match(source, /let welcomeQuery = named\(app\.groups, "Welcome"\)/);
  assert.match(source, /uniqueHittable\(named\(welcome\.buttons, "Skip"\)/);
  const quick = swiftSection(source, "private func completeQuickSetup(", "private func seedCompactDensity(");
  assert.match(quick, /\(title CONTAINS %@ AND title CONTAINS %@\) OR \(label CONTAINS %@ AND label CONTAINS %@\)/);
  assert.match(quick, /"Quick setup", quickSetupCopy, "Quick setup", quickSetupCopy/);
  assert.match(quick, /Start with public sources without adding your own keys now\. Catalog and playback limits are explained before continuing\./);
  assert.match(quick, /checkBoxes\.matching\(NSPredicate\(format: "title CONTAINS %@ OR label CONTAINS %@"/);
  assert.doesNotMatch(source, /app\.buttons\["Quick setup"\]/);
  const installing = swiftSection(source, "private func textPrefixExists(", "private func captureInitialPublicAttributes(");
  assert.match(installing, /"title BEGINSWITH %@ OR label BEGINSWITH %@", prefix, prefix/);
  assert.match(installing, /allElementsBoundByIndex\.prefix\(128\)/);
  assert.match(installing, /\(\$0\.value as\? String\)\?\.hasPrefix\(prefix\) == true/);
}

function assertPersonaCaptureWithoutRedundantStatic(source) {
  const welcome = swiftSection(source, "private func dismissInitialWelcome(", "private func completeQuickSetup(");
  assert.match(welcome, /uniqueStaticText\(app\.staticTexts, text: "How do you want to use YAWF Stream\?", timeout: 60\)\s*capturePhase\("02-persona-choice", in: app\)/);
  assert.doesNotMatch(welcome, /uniqueStaticText\(app\.staticTexts, text: "Quick setup"/);
  const quick = swiftSection(source, "private func completeQuickSetup(", "private func seedCompactDensity(");
  assert.match(quick, /let quickSetup = try uniqueHittable\(/);
  assert.match(quick, /\(title CONTAINS %@ AND title CONTAINS %@\) OR \(label CONTAINS %@ AND label CONTAINS %@\)/);
  assert.match(quick, /"Quick setup", quickSetupCopy, "Quick setup", quickSetupCopy/);
}

function assertStaticTextContract(source) {
  const exact = swiftSection(source, "private func findUniqueStaticText(", "private func uniqueStaticText(");
  assert.match(exact, /for attribute in \["title", "label", "value"\]/);
  assert.match(exact, /NSPredicate\(format: "%K == %@", attribute, text\)/);
  assert.match(exact, /guard count <= 1 else \{\s*throw AdmissionError\.refused/);
  assert.match(exact, /if count == 1, matches\.firstMatch\.exists \{ return matches\.firstMatch \}/);
  assert.ok(exact.indexOf("guard count <= 1") < exact.indexOf("return matches.firstMatch"));
  assert.doesNotMatch(exact, /CONTAINS|BEGINSWITH/);
}

function assertInitialAttributeProbe(source) {
  const flow = swiftSection(source, "func testPublic96To102ThroughNormalUpdaterUI()", "private func dismissInitialWelcome(");
  assert.ok(flow.indexOf("captureInitialPublicAttributes(in: activeApp)") >= 0);
  assert.ok(flow.indexOf("captureInitialPublicAttributes(in: activeApp)") < flow.indexOf("try dismissInitialWelcome(in: activeApp)"));
  const probe = swiftSection(source, "private func captureInitialPublicAttributes(", "private func uniqueHittable(");
  assert.match(probe, /let welcome = named\(app\.groups, "Welcome"\)\.firstMatch/);
  assert.match(probe, /guard welcome\.waitForExistence\(timeout: 30\) else \{ return \}/);
  assert.match(probe, /guard let snapshot = try\? welcome\.snapshot\(\) else \{ return \}/);
  assert.equal((probe.match(/\.snapshot\(/g) ?? []).length, 1);
  assert.match(probe, /func visit\(_ element: any XCUIElementSnapshot, depth: Int\)/);
  assert.match(probe, /guard depth <= 32, visited < 512 else \{ return \}/);
  assert.match(probe, /visited \+= 1/);
  assert.match(probe, /buttons\.count < 20/);
  assert.match(probe, /texts\.count < 20/);
  assert.match(probe, /for child in element\.children \{\s*visit\(child, depth: depth \+ 1\)/);
  assert.match(probe, /visit\(snapshot, depth: 0\)/);
  assert.doesNotMatch(probe, /allElementsBoundByIndex|element\(boundBy:|app\.buttons|app\.staticTexts/);
  for (const attribute of ["title", "label", "value"]) assert.match(probe, new RegExp(`"${attribute}"\\s*:`));
  assert.match(probe, /element\.title\.prefix\(512\)/);
  assert.match(probe, /element\.label\.prefix\(512\)/);
  assert.match(probe, /element\.value \?\? ""\)\.prefix\(512\)/);
  assert.match(probe, /data\.count <= 64_000/);
  assert.match(probe, /attachment\.name = "MacOTARuntime-initial-public-attributes"/);
  assert.match(probe, /attachment\.lifetime = \.keepAlways/);
}

function assertPreservedValueQueries(source) {
  const profile = swiftSection(source, "private func seedProfileName(", "private func seedWatchlist(");
  assert.match(profile, /app\.textFields\.matching\(NSPredicate\(format: "value == %@", "You"\)\)/);
  const persisted = swiftSection(source, "private func assertProfileName(", "private func assertWatchlist(");
  assert.match(persisted, /app\.textFields\.matching\(NSPredicate\(format: "value == %@", name\)\)/);
  assert.match(persisted, /\(compact\.value as\? String\)\?\.lowercased\(\)/);
  assert.match(persisted, /\(compact\.value as\? NSNumber\)\?\.boolValue == true/);
}

test("Swift source follows title-aware AX first-run queries with bounded phase evidence", async () => {
  const source = await readFile(new URL("./MacOTARuntimeTests/MacOTARuntimeTests.swift", import.meta.url), "utf8");
  assertTitleAwareQueries(source);
  assertPersonaCaptureWithoutRedundantStatic(source);
  assert.match(source, /How do you want to use YAWF Stream\?/);
  for (const phase of ["01-initial-welcome", "02-persona-choice", "03-quick-privacy", "04-postsetup-tour", "05-update-offer", "06-postupdate-state"]) {
    assert.match(source, new RegExp(`capturePhase\\("${phase}"`));
  }
  assert.match(source, /debugDescription\.prefix\(64_000\)/);
  assert.match(source, /XCTAttachment\(screenshot:/);
});

test("Swift static text uses exact title then label then value and refuses ambiguity", async () => {
  assertStaticTextContract(await readFile(new URL("./MacOTARuntimeTests/MacOTARuntimeTests.swift", import.meta.url), "utf8"));
});

test("Swift bounded public attribute probe precedes the first required UI selector", async () => {
  assertInitialAttributeProbe(await readFile(new URL("./MacOTARuntimeTests/MacOTARuntimeTests.swift", import.meta.url), "utf8"));
});

test("Swift title-aware naming does not replace editable or selected-state value assertions", async () => {
  assertPreservedValueQueries(await readFile(new URL("./MacOTARuntimeTests/MacOTARuntimeTests.swift", import.meta.url), "utf8"));
});

test("Swift AX source contracts independently reject critical selector regressions", async () => {
  // Source-contract mutations, not XCTest execution or simulated UI proof.
  const source = await readFile(new URL("./MacOTARuntimeTests/MacOTARuntimeTests.swift", import.meta.url), "utf8");
  const controls = [
    ["redundant standalone Quick setup", assertPersonaCaptureWithoutRedundantStatic, 'capturePhase("02-persona-choice", in: app)', '_ = try uniqueStaticText(app.staticTexts, text: "Quick setup", timeout: 30)\n        capturePhase("02-persona-choice", in: app)'],
    ["title naming", assertTitleAwareQueries, 'title == %@ OR label == %@', 'label == %@'],
    ["Quick title and copy", assertTitleAwareQueries, '(title CONTAINS %@ AND title CONTAINS %@)', '(title CONTAINS %@)'],
    ["Installing value", assertTitleAwareQueries, '($0.value as? String)?.hasPrefix(prefix) == true', 'false'],
    ["title priority", assertStaticTextContract, '["title", "label", "value"]', '["label", "title", "value"]'],
    ["value fallback", assertStaticTextContract, '["title", "label", "value"]', '["title", "label"]'],
    ["exact text", assertStaticTextContract, '%K == %@', '%K CONTAINS %@'],
    ["ambiguous static text", assertStaticTextContract, 'guard count <= 1 else', 'guard count <= 2 else'],
    ["unique return", assertStaticTextContract, 'if count == 1, matches.firstMatch.exists', 'if count > 0, matches.firstMatch.exists'],
    ["probe before selector", assertInitialAttributeProbe, 'captureInitialPublicAttributes(in: activeApp)', 'captureInitialPublicAttributesAfterSelectors(in: activeApp)'],
    ["bounded probe", assertInitialAttributeProbe, 'data.count <= 64_000', 'data.count <= 640_000'],
    ["no live diagnostic index list", assertInitialAttributeProbe, 'var visited = 0', 'var visited = 0; let live = app.buttons.allElementsBoundByIndex'],
    ["profile value", assertPreservedValueQueries, '"value == %@", "You"', '"label == %@", "You"'],
    ["persisted value", assertPreservedValueQueries, '"value == %@", name', '"title == %@", name'],
  ];
  for (const [label, check, before, after] of controls) {
    assert.ok(source.includes(before), `${label}: mutation anchor`);
    assert.throws(() => check(source.replace(before, after)), { name: "AssertionError" }, label);
  }
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
