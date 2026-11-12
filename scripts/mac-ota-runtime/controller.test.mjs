import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

function assertSettingsCategoryContract(source) {
  for (const [start, end, category] of [
    ["private func seedCompactDensity(", "private func seedProfileName(", "Appearance"],
    ["private func seedProfileName(", "private func seedWatchlist(", "Profiles"],
    ["private func assertProfileName(", "private func assertCompactDensity(", "Profiles"],
    ["private func assertCompactDensity(", "private func assertWatchlist(", "Appearance"],
  ]) {
    const phase = swiftSection(source, start, end);
    assert.ok(phase.includes(`try selectSettingsCategory("${category}", in: app)`));
    assert.ok(!phase.includes(`try clickUniqueButton("${category}", in: app)`));
  }
  const select = swiftSection(source, "private func selectSettingsCategory(", "private func seedCompactDensity(");
  assert.match(select, /guard \["Appearance", "Profiles"\]\.contains\(category\) else/);
  assert.equal((select.match(/uniqueHittable\(named\(app\.popUpButtons, "SETTINGS CATEGORY"\)/g) ?? []).length, 2);
  assert.match(select, /uniqueHittable\(named\(app\.menuItems, category\)/);
  assert.ok(select.indexOf("picker.click()") < select.indexOf('capturePhase("settings-category-'));
  assert.ok(select.indexOf('capturePhase("settings-category-') < select.indexOf("let option ="));
  assert.ok(select.indexOf("let option =") < select.indexOf("option.click()"));
  assert.match(select, /\(selected\.value as\? String\) == category/);
  assert.doesNotMatch(select, /setValue|typeText|evaluateJavaScript|app\.buttons/);
}

function assertCompactCheckBoxContract(source) {
  for (const [start, end] of [
    ["private func seedCompactDensity(", "private func seedProfileName("],
    ["private func assertCompactDensity(", "private func assertWatchlist("],
  ]) {
    const phase = swiftSection(source, start, end);
    assert.match(phase, /uniqueExisting\(named\(app\.groups, "Appearance styles"\)/);
    assert.match(phase, /uniqueHittable\(named\(styles\.checkBoxes, "Apply Compact control style"\)/);
    assert.doesNotMatch(phase, /named\(app\.buttons, "Apply Compact control style"/);
  }
  const seed = swiftSection(source, "private func seedCompactDensity(", "private func seedProfileName(");
  assert.match(seed, /compact\.click\(\)/);
  const persisted = swiftSection(source, "private func assertCompactDensity(", "private func assertWatchlist(");
  assert.match(persisted, /stringValue == "1"/);
  assert.match(persisted, /XCTAssertTrue\(pressed,/);
}

function assertSplitNoticeContract(source) {
  const pure = source.split("// HOST_UPDATE_NOTICE_BEGIN")[1].split("// HOST_UPDATE_NOTICE_END")[0];
  assert.match(pure, /let parts = \["Update v", expectedVersion, " available"\]/);
  assert.match(pure, /node\.children\.indices\.filter/);
  assert.match(pure, /Set\(textIndices\.flatMap \{ \$0 \}\)\.count == 3/);
  assert.match(pure, /installIndices\.count == 1, dismissIndices\.count == 1, installIndices\[0\] != dismissIndices\[0\]/);
  assert.match(pure, /guard matches\.count <= 1 else \{ throw NoticeWitnessError\.ambiguousNotice \}/);
  assert.match(pure, /depth <= 32, visited < 1024/);
  assert.match(pure, /window\.frame\.contains\(node\.frame\)/);
  const query = swiftSection(source, "private func findUpdateOffer(", "private func textPrefixExists(");
  assert.equal((query.match(/app\.snapshot\(\)/g) ?? []).length, 1);
  assert.match(query, /element\.children\.map/);
  assert.match(query, /depth <= 32, visited < 1024/);
  assert.match(query, /prefix\(512\)/);
  assert.match(query, /capturePhase\("update-offer-query-refused", in: app\)/);
  assert.doesNotMatch(query, /allElementsBoundByIndex|firstMatch|value\(forKey/);
  const flow = swiftSection(source, "var preInstallReopenUsed = false", "install.click()");
  assert.ok(flow.indexOf('capturePhase("update-offer-before-first-query"') < flow.indexOf("findUpdateOffer("));
  assert.equal((flow.match(/timeout: 180/g) ?? []).length, 2);
  assert.match(flow, /guard let notice = try findUpdateOffer\(in: activeApp, expectedVersion: config\.expectedAfterVersion, timeout: 15\)/);
  assert.match(flow, /named\(activeApp\.buttons, "Install"\)\.count == 1, install\.isHittable/);
  assert.match(flow, /notice\.frame\.contains\(installFrame\), notice\.windowFrame\.contains\(installFrame\)/);
  assert.match(flow, /installFrame == notice\.installFrame/);
  assert.doesNotMatch(flow, /findUniqueStaticText|uniqueStaticText|Update v\\\(/);
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

function assertFreshHostedClipboardSeed(source) {
  const profile = swiftSection(source, "private func seedProfileName(", "private func seedWatchlist(");
  assert.ok(profile.indexOf("runtimeAdmissionRefusal(environment: ProcessInfo.processInfo.environment)") >= 0);
  assert.ok(profile.indexOf("runtimeAdmissionRefusal(environment: ProcessInfo.processInfo.environment)") < profile.indexOf("NSPasteboard.general"));
  assert.match(profile, /let clearedChangeCount = clipboard\.clearContents\(\)/);
  assert.match(profile, /guard clearedChangeCount > 0, clipboard\.changeCount == clearedChangeCount/);
  assert.match(profile, /clipboard\.types\?\.isEmpty \?\? true/);
  assert.match(profile, /defer \{ _ = clipboard\.clearContents\(\) \}/);
  assert.equal((profile.match(/clipboard\.setString\(/g) ?? []).length, 1);
  assert.match(profile, /guard clipboard\.setString\("OTA Runner", forType: \.string\),\s*clipboard\.string\(forType: \.string\) == "OTA Runner" else/);
  assert.ok(profile.indexOf('clipboard.setString("OTA Runner"') < profile.indexOf('clipboard.string(forType: .string)'));
  assert.equal((profile.match(/app\.typeKey\("v", modifierFlags: \.command\)/g) ?? []).length, 1);
  assert.doesNotMatch(profile, /typeText|readObjects|pasteboardItems|restoreClipboard|previousClipboard/);
  assert.match(profile, /capturePhase\("profile-name-after-paste", in: app\)/);
}

function assertScopedWatchlistToggle(source) {
  const seed = swiftSection(source, "private func seedWatchlist(", "private func assertProfileName(");
  assert.match(seed, /let toggleRoles = \[NSNumber\(value: XCUIElement\.ElementType\.button\.rawValue\), NSNumber\(value: XCUIElement\.ElementType\.checkBox\.rawValue\)\]/);
  assert.match(seed, /detailQuery\.firstMatch\.descendants\(matching: \.any\)\.matching\(NSPredicate\(format: "elementType IN %@", toggleRoles\)\)/);
  assert.match(seed, /uniqueHittable\(named\(detailActions, "Watchlist"\)/);
  assert.match(seed, /uniqueHittable\(named\(detailActions, "In watchlist"\)/);
  assert.equal((seed.match(/detailButton\.click\(\)/g) ?? []).length, 1);
  assert.match(seed, /XCTAssertTrue\(selectedValue == "1" \|\| selectedValue == "true"/);
  assert.doesNotMatch(seed, /named\(detailQuery\.firstMatch\.buttons, "(?:In watchlist|Watchlist)"/);
}

function assertPreservedValueQueries(source) {
  const profile = swiftSection(source, "private func seedProfileName(", "private func seedWatchlist(");
  assert.match(profile, /uniqueHittable\(named\(app\.textFields, "NAME"\)/);
  assert.match(profile, /guard name == "OTA Runner", \(field\.value as\? String\) == "You"/);
  assert.match(profile, /uniqueExisting\(app\.windows,/);
  assert.match(profile, /!fieldFrame\.isNull, !fieldFrame\.isInfinite, fieldFrame\.width > 0, fieldFrame\.height > 0/);
  assert.match(profile, /!windowFrame\.isNull, !windowFrame\.isInfinite, windowFrame\.width > 0, windowFrame\.height > 0/);
  assert.match(profile, /windowFrame\.contains\(fieldFrame\)/);
  assert.match(profile, /field\.coordinate\(withNormalizedOffset: CGVector\(dx: 0\.5, dy: 0\.5\)\)\.click\(\)/);
  assert.match(profile, /app\.typeKey\("a", modifierFlags: \.command\)/);
  assert.match(profile, /app\.typeKey\("v", modifierFlags: \.command\)/);
  assert.doesNotMatch(profile, /app\.typeText\(/);
  assert.match(profile, /guard waitUntil\(timeout: 10, condition: \{ \(field\.value as\? String\) == name \}\) else/);
  assert.ok(profile.indexOf('app.activate()') < profile.indexOf('capturePhase("profile-name-before-center"'));
  assert.ok(profile.indexOf('capturePhase("profile-name-before-center"') < profile.indexOf('let field ='));
  assert.ok(profile.indexOf('windowFrame.contains(fieldFrame)') < profile.indexOf('field.coordinate('));
  assert.ok(profile.indexOf('capturePhase("profile-name-after-paste"') < profile.indexOf('guard waitUntil('));
  assert.ok(profile.indexOf('guard waitUntil(') < profile.indexOf('try saveSettingsIfEnabled('));
  assert.doesNotMatch(profile, /field\.click\(\)|field\.typeKey|field\.typeText|setValue|evaluateJavaScript/);
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

test("Swift uses the observed responsive Settings category popup through normal menu UI", async () => {
  assertSettingsCategoryContract(await readFile(new URL("./MacOTARuntimeTests/MacOTARuntimeTests.swift", import.meta.url), "utf8"));
});

test("Swift Compact preset uses the observed CheckBox inside its unique Appearance styles group", async () => {
  assertCompactCheckBoxContract(await readFile(new URL("./MacOTARuntimeTests/MacOTARuntimeTests.swift", import.meta.url), "utf8"));
});

test("Swift Compact role regression rejects seed and persisted-check reverts independently", async () => {
  const source = await readFile(new URL("./MacOTARuntimeTests/MacOTARuntimeTests.swift", import.meta.url), "utf8");
  for (const [start, end] of [
    ["private func seedCompactDensity(", "private func seedProfileName("],
    ["private func assertCompactDensity(", "private func assertWatchlist("],
  ]) {
    const phase = swiftSection(source, start, end);
    const reverted = source.replace(phase, phase.replace('styles.checkBoxes, "Apply Compact control style"', 'app.buttons, "Apply Compact control style"'));
    assert.notEqual(reverted, source);
    assert.throws(() => assertCompactCheckBoxContract(reverted), { name: "AssertionError" }, start);
  }
});

test("Swift scopes the split update notice to one immutable bounded group before Install", async () => {
  assertSplitNoticeContract(await readFile(new URL("./MacOTARuntimeTests/MacOTARuntimeTests.swift", import.meta.url), "utf8"));
});

test("Swift static text uses exact title then label then value and refuses ambiguity", async () => {
  assertStaticTextContract(await readFile(new URL("./MacOTARuntimeTests/MacOTARuntimeTests.swift", import.meta.url), "utf8"));
});

test("Swift bounded public attribute probe precedes the first required UI selector", async () => {
  assertInitialAttributeProbe(await readFile(new URL("./MacOTARuntimeTests/MacOTARuntimeTests.swift", import.meta.url), "utf8"));
});

test("Swift seeds only the fixed fake profile through one fresh-hosted-clipboard paste", async () => {
  assertFreshHostedClipboardSeed(await readFile(new URL("./MacOTARuntimeTests/MacOTARuntimeTests.swift", import.meta.url), "utf8"));
});

test("Swift scopes the exact watchlist toggle to the title detail and verifies selected state", async () => {
  assertScopedWatchlistToggle(await readFile(new URL("./MacOTARuntimeTests/MacOTARuntimeTests.swift", import.meta.url), "utf8"));
});

test("Swift title-aware naming does not replace editable or selected-state value assertions", async () => {
  assertPreservedValueQueries(await readFile(new URL("./MacOTARuntimeTests/MacOTARuntimeTests.swift", import.meta.url), "utf8"));
});

test("Swift AX source contracts independently reject critical selector regressions", async () => {
  // Source-contract mutations, not XCTest execution or simulated UI proof.
  const source = await readFile(new URL("./MacOTARuntimeTests/MacOTARuntimeTests.swift", import.meta.url), "utf8");
  const controls = [
    ["fresh notice Install frame equality", assertSplitNoticeContract, 'installFrame == notice.installFrame', 'true'],
    ["update notice distinct physical parts", assertSplitNoticeContract, 'Set(textIndices.flatMap { $0 }).count == 3', 'true'],
    ["update notice ambiguity", assertSplitNoticeContract, 'guard matches.count <= 1 else', 'guard true else'],
    ["update notice Install containment", assertSplitNoticeContract, 'notice.frame.contains(installFrame)', 'true'],
    ["watchlist checkbox role", assertScopedWatchlistToggle, 'NSNumber(value: XCUIElement.ElementType.checkBox.rawValue)', 'NSNumber(value: XCUIElement.ElementType.textField.rawValue)'],
    ["watchlist detail scope", assertScopedWatchlistToggle, 'detailQuery.firstMatch.descendants(matching: .any)', 'app.descendants(matching: .any)'],
    ["watchlist selected state", assertScopedWatchlistToggle, 'XCTAssertTrue(selectedValue == "1" || selectedValue == "true"', 'XCTAssertTrue(true || selectedValue == "true"'],
    ["clipboard fresh admission", assertFreshHostedClipboardSeed, 'runtimeAdmissionRefusal(environment: ProcessInfo.processInfo.environment)', 'noFreshClipboardAdmission()'],
    ["clipboard clear success", assertFreshHostedClipboardSeed, 'guard clearedChangeCount > 0', 'guard true'],
    ["clipboard readback", assertFreshHostedClipboardSeed, 'clipboard.string(forType: .string) == "OTA Runner"', 'true'],
    ["clipboard defer clear", assertFreshHostedClipboardSeed, 'defer { _ = clipboard.clearContents() }', ''],
    ["clipboard no typing fallback", assertFreshHostedClipboardSeed, 'app.typeKey("v", modifierFlags: .command)', 'app.typeText(name)'],
    ["responsive category before and after", assertSettingsCategoryContract, 'try selectSettingsCategory("Appearance", in: app)', 'try clickUniqueButton("Appearance", in: app)'],
    ["exact popup role", assertSettingsCategoryContract, 'app.popUpButtons, "SETTINGS CATEGORY"', 'app.buttons, "SETTINGS CATEGORY"'],
    ["capture before option query", assertSettingsCategoryContract, 'capturePhase("settings-category-\\(category)-menu", in: app)', 'captureSettingsMenuAfterOptionQuery(in: app)'],
    ["category selected value", assertSettingsCategoryContract, '(selected.value as? String) == category', 'true'],
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
    ["no live diagnostic index list", assertInitialAttributeProbe, 'guard let snapshot = try? welcome.snapshot() else { return }', 'guard let snapshot = try? welcome.snapshot() else { return }; let live = app.buttons.allElementsBoundByIndex'],
    ["profile value", assertPreservedValueQueries, '(field.value as? String) == "You"', '(field.label as? String) == "You"'],
    ["profile element-relative center", assertPreservedValueQueries, 'field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).click()', 'field.click()'],
    ["profile contained frame", assertPreservedValueQueries, 'windowFrame.contains(fieldFrame)', 'true'],
    ["profile exact typed readback", assertPreservedValueQueries, '(field.value as? String) == name', 'true'],
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

const runFile = promisify(execFile);
const noticeHostCases = String.raw`
    static func run(_ name: String) throws {
        let groupFrame = CGRect(x: 660, y: 601, width: 340, height: 81)
        let windowFrame = CGRect(x: 0, y: 0, width: 1024, height: 768)
        func node(_ role: String, title: String = "", label: String = "", value: String? = nil, frame: CGRect = CGRect(x: 721, y: 616, width: 60, height: 16), children: [NoticeNode] = []) -> NoticeNode {
            NoticeNode(role: role, title: title, label: label, value: value, frame: frame, children: children)
        }
        func parts(_ version: String = "2.3.102") -> [NoticeNode] { [node("staticText", value: "Update v"), node("staticText", value: version), node("staticText", value: " available")] }
        func buttons() -> [NoticeNode] { [node("button", title: "Install", label: "Install", frame: CGRect(x: 884, y: 619, width: 67, height: 45)), node("button", title: "Dismiss update notification", label: "Dismiss update notification", frame: CGRect(x: 955, y: 627, width: 28, height: 29))] }
        func group(_ children: [NoticeNode], frame: CGRect? = nil) -> NoticeNode { node("group", frame: frame ?? groupFrame, children: children) }
        func app(_ groups: [NoticeNode]) -> NoticeNode { node("application", frame: windowFrame, children: [node("window", frame: windowFrame, children: groups)]) }
        func check(_ condition: Bool) { if !condition { fatalError("Notice fixture assertion: \(name)") } }
        let valid = group(parts() + buttons())
        switch name {
        case "valid-split": check(try updateNoticeWitness(app([valid]), expectedVersion: "2.3.102") != nil)
        case "same-attribute-node-once":
            let texts = [node("staticText", title: "Update v", label: "Update v", value: "Update v"), node("staticText", title: "2.3.102", label: "2.3.102", value: "2.3.102"), node("staticText", title: " available", label: " available", value: " available")]
            check(try updateNoticeWitness(app([group(texts + buttons())]), expectedVersion: "2.3.102") != nil)
        case "altered-version": check(try updateNoticeWitness(app([group(parts("2.3.101") + buttons())]), expectedVersion: "2.3.102") == nil)
        case "missing-part": check(try updateNoticeWitness(app([group(Array(parts().prefix(2)) + buttons())]), expectedVersion: "2.3.102") == nil)
        case "unscoped-group":
            let p = parts(); let inner = group([p[1],p[2]], frame: CGRect(x: 710, y: 610, width: 160, height: 30))
            check(try updateNoticeWitness(app([group([p[0],inner] + buttons())]), expectedVersion: "2.3.102") == nil)
        case "ambiguous-group":
            do { _ = try updateNoticeWitness(app([valid, valid]), expectedVersion: "2.3.102"); fatalError("Accepted ambiguous notice") }
            catch NoticeWitnessError.ambiguousNotice { }
        case "duplicated-part": check(try updateNoticeWitness(app([group(parts() + [parts()[1]] + buttons())]), expectedVersion: "2.3.102") == nil)
        case "same-node-multiple-parts": check(try updateNoticeWitness(app([group([node("staticText", title: "Update v", label: "2.3.102", value: " available")] + buttons())]), expectedVersion: "2.3.102") == nil)
        case "duplicated-install": check(try updateNoticeWitness(app([group(parts() + buttons() + [buttons()[0]])]), expectedVersion: "2.3.102") == nil)
        case "outside-window": check(try updateNoticeWitness(app([group(parts()+buttons(), frame:CGRect(x:660,y:601,width:400,height:81))]), expectedVersion:"2.3.102") == nil)
        case "zero-button": check(try updateNoticeWitness(app([group(parts()+[node("button",title:"Install",frame:.zero),buttons()[1]])]), expectedVersion:"2.3.102") == nil)
        case "depth-bound":
            var deep = valid; for _ in 0..<33 { deep = node("other",children:[deep]) }
            do { _ = try updateNoticeWitness(app([deep]), expectedVersion:"2.3.102"); fatalError("Accepted depth overflow") } catch NoticeWitnessError.bounds { }
        case "node-bound":
            do { _ = try updateNoticeWitness(app([valid]+Array(repeating:node("other"),count:1025)),expectedVersion:"2.3.102");fatalError("Accepted node overflow") } catch NoticeWitnessError.bounds { }
        default: fatalError("Unknown notice fixture")
        }
    }
`;

test("extracted Swift notice witness executes semantic fixtures and four causal controls", {
  skip: process.env.DS_MAC_NOTICE_SKIP_SWIFT_HOST === "1",
  timeout: 120_000,
}, async () => {
  const source = await readFile(new URL("./MacOTARuntimeTests/MacOTARuntimeTests.swift", import.meta.url), "utf8");
  const body = source.split("// HOST_UPDATE_NOTICE_BEGIN")[1].split("// HOST_UPDATE_NOTICE_END")[0];
  const folder = await mkdtemp(path.join(os.tmpdir(), "mac-notice-pure-"));
  const environment = { ...process.env, TMPDIR: folder, CLANG_MODULE_CACHE_PATH: path.join(folder,"modules") };
  async function compile(body, name) {
    const file = path.join(folder, name+".swift"), executable = path.join(folder,name);
    await writeFile(file, "import Foundation\nimport CoreGraphics\nenum NoticeHost {\n"+body+noticeHostCases+"\n}\ntry NoticeHost.run(CommandLine.arguments[1])\n");
    await runFile("/usr/bin/swiftc", ["-module-cache-path",path.join(folder,"modules"),file,"-o",executable], { env: environment, timeout:60_000, maxBuffer:1024*1024 });
    return executable;
  }
  const executable = await compile(body, "notice-fixtures");
  for (const name of ["valid-split","same-attribute-node-once","altered-version","missing-part","unscoped-group","ambiguous-group","duplicated-part","same-node-multiple-parts","duplicated-install","outside-window","zero-button","depth-bound","node-bound"]) {
    await runFile(executable,[name],{env:environment,timeout:10_000,maxBuffer:1024*1024});
  }
  const textLine = 'let textIndices = parts.map { part in node.children.indices.filter { node.children[$0].role == "staticText" && exact(node.children[$0], part) } }';
  const descendantLine = 'func descendantNodes(_ node: NoticeNode) -> [NoticeNode] { node.children.flatMap { [$0] + descendantNodes($0) } }; let textScope = descendantNodes(node); let textIndices = parts.map { part in textScope.indices.filter { textScope[$0].role == "staticText" && exact(textScope[$0], part) } }';
  const controls = [
    ["altered-version", 'let parts = ["Update v", expectedVersion, " available"]', 'let parts = ["Update v", "2.3.101", " available"]'],
    ["missing-part", 'if textIndices.allSatisfy({ $0.count == 1 }), Set(textIndices.flatMap { $0 }).count == 3,', 'if true,'],
    ["unscoped-group", textLine, descendantLine],
    ["ambiguous-group", 'guard matches.count <= 1 else { throw NoticeWitnessError.ambiguousNotice }', 'guard true else { throw NoticeWitnessError.ambiguousNotice }'],
  ];
  for (const [name,before,after] of controls) {
    assert.ok(body.includes(before));
    const mutant = await compile(body.replace(before,after),"mutant-"+name);
    await assert.rejects(runFile(mutant,[name],{env:environment,timeout:10_000,maxBuffer:1024*1024}),name);
  }
});
