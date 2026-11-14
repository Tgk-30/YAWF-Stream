import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateArrival, validateProbeURL, validateOwnership } from './ipad-native-qa/preflight.mjs';

const folder = fileURLToPath(new URL('./ipad-native-qa/', import.meta.url));
const app = await readFile(join(folder, 'Anchor/AppDelegate.swift'), 'utf8');
const ui = await readFile(join(folder, 'UITests/SafariNativeInputTests.swift'), 'utf8');
const project = await readFile(join(folder, 'NativeQA.xcodeproj/project.pbxproj'), 'utf8');
const scheme = await readFile(join(folder, 'NativeQA.xcodeproj/xcshareddata/xcschemes/NativeQA.xcscheme'), 'utf8');
const udid = '21348230-4567-4567-9876-123456789abc', run = '12345678-1234-4567-9876-123456789abc';
const name = `YAWF-iPad-NativeQA-${run}`, runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
const source = '262881ed48a0e7810f3fc06b79961cd7a870d134';
function metadata(set = '/Volumes/Work/qa-owned/Devices') {
  const ownership = { schemaVersion: 1, createdFor: 'ipad-native-qa', createdFresh: true, udid, name, runtimeIdentifier: runtime, deviceSetPath: set, rootApprovedDefaultSet: false };
  const registry = { devices: { [runtime]: [{ udid, name, isAvailable: true, state: 'Shutdown', deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-A16', dataPath: join(set, udid, 'data') }] } };
  const destinations = `Available destinations for the "NativeQA" scheme:\n { platform:iOS Simulator, arch:arm64, id:${udid}, OS:26.5, name:${name} }`;
  return { ownership, registry, destinations };
}

test('owned iPad metadata requires root fresh creation and exact available destination without fallback', () => {
  const { ownership, registry, destinations } = metadata();
  assert.equal(validateOwnership(ownership, registry, destinations).destination, `platform=iOS Simulator,id=${udid}`);
  for (const patch of [{ createdFresh: false }, { name: 'YAWF-iPad-Safari-QA-existing' }, { udid: 'booted' }, { runtimeIdentifier: 'unknown' }]) assert.throws(() => validateOwnership({ ...ownership, ...patch }, registry, destinations));
  for (const patch of [{ isAvailable: false }, { deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone' }, { dataPath: '/unrelated/data' }]) {
    const changed = { devices: { [runtime]: [{ ...registry.devices[runtime][0], ...patch }] } };
    assert.throws(() => validateOwnership(ownership, changed, destinations));
  }
  assert.throws(() => validateOwnership(ownership, registry, destinations.replace('Available destinations', 'Unavailable destinations')));
  assert.throws(() => validateOwnership(ownership, registry, destinations.replace(udid, run)));
});

test('captured Xcode27 compatible headers admit only the exact owned line and stop at incompatible sections', () => {
  // Public owned-device lines from the root's actual Xcode27 inventory. No
  // other device names, host identities or build-log paths are included.
  const actualUDID = '3394FE5E-A317-4088-90E1-96EB034B3D4C';
  const actualName = 'YAWF-iPad-NativeQA-683f22e2-80ca-470c-b722-3d59c0fbfd81';
  const captured = `\tDestinations compatible with the "NativeQA" scheme:
\t\t{ platform:iOS Simulator, arch:arm64, id:3394FE5E-A317-4088-90E1-96EB034B3D4C, OS:26.5, name:YAWF-iPad-NativeQA-683f22e2-80ca-470c-b722-3d59c0fbfd81 }
\tDestinations incompatible with the "NativeQA" scheme:`;
  const { ownership, registry } = metadata();
  ownership.udid = actualUDID; ownership.name = actualName;
  Object.assign(registry.devices[runtime][0], { udid: actualUDID, name: actualName, dataPath: join(ownership.deviceSetPath, actualUDID, 'data') });
  assert.equal(validateOwnership(ownership, registry, captured).udid, actualUDID);
  assert.throws(() => validateOwnership(ownership, registry, captured.replace('Destinations compatible with', 'Destinations incompatible with')));
  const ownedLine = captured.split('\n')[1];
  assert.throws(() => validateOwnership(ownership, registry,
    `Destinations compatible with the "NativeQA" scheme:\nDestinations incompatible with the "NativeQA" scheme:\n${ownedLine}`));
});

test('fresh default-set device requires explicit root decision and leaves existing paths untouched', () => {
  const { ownership, registry, destinations } = metadata(join(homedir(), 'Library/Developer/CoreSimulator/Devices'));
  assert.throws(() => validateOwnership(ownership, registry, destinations));
  assert.equal(validateOwnership({ ...ownership, rootApprovedDefaultSet: true }, registry, destinations).defaultSetApproved, true);
  assert.throws(() => validateOwnership({ ...ownership, rootApprovedDefaultSet: true, deviceSetPath: '/some-other-set' }, registry, destinations));
});

test('independent public arrival probe rejects missing identity, source, counters, extra data and foreign URLs', () => {
  const valid = { schemaVersion: 1, fixtureInstanceId: run, sourceRevision: source, loginSuccessCount: 3 };
  assert.equal(validateArrival(valid, run, source), 3);
  for (const patch of [{ fixtureInstanceId: udid }, { sourceRevision: 'bad' }, { loginSuccessCount: -1 }, { loginSuccessCount: 1.5 }, { cookie: 'not-allowed' }]) assert.throws(() => validateArrival({ ...valid, ...patch }, run, source));
  assert.equal(validateProbeURL('http://127.0.0.1:43178/__qa/arrival'), 'http://127.0.0.1:43178/__qa/arrival');
  for (const url of ['https://127.0.0.1:43178/__qa/arrival', 'http://example.com:43178/__qa/arrival', 'http://127.0.0.1:43178/api/health', 'http://a:b@127.0.0.1:43178/__qa/arrival', 'http://127.0.0.1:43178/__qa/arrival?x=1']) assert.throws(() => validateProbeURL(url));
});

test('native counter gate requires three actual taps and independently observed values and screenshot', () => {
  assert.match(app, /button\.accessibilityIdentifier = "qa\.counter\.increment"/);
  assert.match(app, /button\.addTarget\(self, action: #selector\(increment\), for: \.primaryActionTriggered\)/);
  assert.match(app, /count \+= 1; updateLabel\(\)/);
  assert.match(ui, /for expected in 1\.\.\.3 \{\s+button\.tap\(\)/);
  assert.match(ui, /XCTAssertEqual\(value\.value as\? String, "3"\)/);
  assert.match(ui, /XCTAssertEqual\(value\.label, "Counter: \\\(expected\)"\)/);
  assert.match(ui, /native-counter-three-real-taps/); assert.match(ui, /attachment\.lifetime = \.keepAlways/);
});

test('Safari gate uses normal public fixture HTML input and independent exact-one login arrival', () => {
  assert.match(ui, /XCUIApplication\(bundleIdentifier: "com\.apple\.mobilesafari"\)/);
  assert.match(ui, /safari\.open\(origin\)/); assert.match(ui, /safari\.webViews\.firstMatch/);
  for (const text of ['web.textFields["Username"]', 'web.secureTextFields["Password"]', 'username.typeText("fixture-owner")', 'password.typeText("fixture-owner-password")', 'web.buttons["Sign in"]', 'signIn.tap()', 'web.buttons["Watchlist"]', 'watchlist.tap()']) assert.ok(ui.includes(text));
  assert.match(ui, /QA_HTTP_PROBE_URL/); assert.match(ui, /QA_EXPECTED_FIXTURE_ID/); assert.match(ui, /QA_EXPECTED_SOURCE_REVISION/);
  assert.ok(ui.indexOf('let baseline: Arrival') < ui.indexOf('safari.open(origin)'));
  assert.match(ui, /after\.loginSuccessCount == baseline\.loginSuccessCount \+ 1/);
  assert.match(ui, /after\.loginSuccessCount <= baseline\.loginSuccessCount \+ 1/);
  assert.match(ui, /XCTAssertTrue\(arrived,/); assert.match(ui, /XCTAssertTrue\(watchlist\.isHittable\)/);
  assert.match(ui, /request\.httpMethod = "GET"/); assert.match(ui, /data\.count <= 4096/);
  assert.match(ui, /completionHandler\(nil\)/);
  assert.doesNotMatch(ui, /evaluateJavaScript|document\.|HTTPCookie\(|setValue\([^;]*HTTPHeader|httpMethod = "POST"|UserDefaults|simctl|WebDriver/);
});

test('Safari dismisses only the exact known tour and verifies page content before its settled screenshot', async () => {
  const welcome = await readFile(new URL('../web/src/components/WelcomeGuide.tsx', import.meta.url), 'utf8');
  const watchlist = await readFile(new URL('../web/src/screens/Watchlist.tsx', import.meta.url), 'utf8');
  assert.match(welcome, /aria-label="Welcome tour"/); assert.match(welcome, /aria-label="Skip the tour"/);
  assert.match(watchlist, /<h1 className="lib-h1">Watchlist<\/h1>/);
  assert.match(watchlist, /Titles you've saved to watch later\./);
  assert.match(ui, /let skip = web\.buttons\["Skip the tour"\]/);
  assert.doesNotMatch(ui, /web\.buttons\["Skip"\]/);
  assert.match(ui, /web\.descendants\(matching: \.any\)\.matching\(identifier: "Welcome tour"\)/);
  assert.match(ui, /guard !welcomeTourPresent\(in: web\)/);
  assert.match(ui, /let headings = web\.staticTexts\.matching\(identifier: "Watchlist"\)/);
  assert.match(ui, /let descriptions = web\.staticTexts\.matching\(NSPredicate\(format: "label BEGINSWITH %@", "Titles you've saved to watch later\."\)\)/);
  assert.match(ui, /let movies = web\.buttons\.matching\(identifier: "Synthetic Fixture Movie"\)/);
  const settled = [...ui.matchAll(/try await requireSettledWatchlist\(in: web\)/g)].map((match) => match.index);
  assert.equal(settled.length, 2);
  assert.ok(ui.indexOf('try await dismissKnownWelcomeTour(in: web)') < ui.indexOf('watchlist.tap()'));
  assert.ok(settled[0] > ui.indexOf('watchlist.tap()'));
  assert.ok(settled[1] > ui.indexOf('XCTAssertTrue(arrived,'));
  assert.ok(settled[1] < ui.indexOf('keepScreenshot(safari, name: "safari-fixture-login-and-watchlist")'));
  assert.match(ui, /Task\.sleep\(nanoseconds: 500_000_000\)/);
});

test('actual Swift Watchlist policy rejects tour-covered navigation and absent or unsettled page content', async (t) => {
  if (process.platform !== 'darwin') { t.skip('Actual pure Swift host policy unavailable; no native navigation pass.'); return; }
  function declaration(prefix) {
    const start = ui.indexOf(prefix); assert.ok(start >= 0);
    const open = ui.indexOf('{', start); let depth = 0;
    for (let index = open; index < ui.length; index++) {
      if (ui[index] === '{') depth++;
      if (ui[index] === '}' && --depth === 0) return ui.slice(start, index + 1);
    }
    throw new Error('Unbalanced actual Swift declaration');
  }
  const script = `import Foundation
${declaration('private enum QAError:')}
${declaration('private struct WatchlistPageObservation')}
${declaration('private enum WatchlistPagePolicy')}
private func sample(tour: Bool = false, headings: Int = 1, headingVisible: Bool = true,
                    descriptions: Int = 1, descriptionVisible: Bool = true, movies: Int = 1, movieVisible: Bool = true) -> WatchlistPageObservation {
    WatchlistPageObservation(welcomeTourPresent: tour, headingCount: headings, headingVisible: headingVisible,
      descriptionCount: descriptions, descriptionVisible: descriptionVisible, movieCount: movies, movieVisible: movieVisible)
}
func accepted(_ operation: () throws -> Void) -> Bool { do { try operation(); return true } catch { return false } }
func require(_ condition: Bool) { if !condition { print("actual Watchlist policy case failed"); exit(1) } }
require(accepted { try WatchlistPagePolicy.requireSettled(sample(), sample()) })
require(!accepted { try WatchlistPagePolicy.requireSettled(sample(tour: true), sample()) })
require(!accepted { try WatchlistPagePolicy.requireSettled(sample(), sample(tour: true)) })
require(!accepted { try WatchlistPagePolicy.requireSettled(sample(headings: 0), sample()) })
require(!accepted { try WatchlistPagePolicy.requireSettled(sample(headings: 2), sample()) })
require(!accepted { try WatchlistPagePolicy.requireSettled(sample(headingVisible: false), sample()) })
require(!accepted { try WatchlistPagePolicy.requireSettled(sample(descriptions: 0), sample()) })
require(!accepted { try WatchlistPagePolicy.requireSettled(sample(descriptionVisible: false), sample()) })
require(!accepted { try WatchlistPagePolicy.requireSettled(sample(movies: 0), sample()) })
require(!accepted { try WatchlistPagePolicy.requireSettled(sample(), sample(movieVisible: false)) })
require(!accepted { try WatchlistPagePolicy.requireSettled(sample(tour: true, headings: 0, descriptions: 0, movies: 0), sample()) })
print("actual-watchlist-policy-cases=11 passed")
`;
  const workspace = await mkdtemp(join(tmpdir(), 'ipad-qa-watchlist-policy-'));
  try {
    const result = spawnSync('/usr/bin/xcrun', ['swift', '-module-cache-path', join(workspace, 'module-cache'), '-'], {
      env: { ...process.env, DEVELOPER_DIR: '/Applications/Xcode-beta.app/Contents/Developer' }, input: script, encoding: 'utf8', timeout: 30_000,
    });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /actual-watchlist-policy-cases=11 passed/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('actual Swift arrival read policy rejects read-driven count changes and identity drift before and after UI', async (t) => {
  const pre = 'try ArrivalReadPolicy.requireStable(baseline, preUI, expectedCount: baseline.loginSuccessCount)';
  const post = 'try ArrivalReadPolicy.requireStable(after, postUI, expectedCount: baseline.loginSuccessCount + 1)';
  assert.ok(ui.includes(pre) && ui.indexOf(pre) < ui.indexOf('safari.open(origin)'));
  assert.ok(ui.includes(post) && ui.indexOf(post) > ui.indexOf('if after.loginSuccessCount == baseline.loginSuccessCount + 1'));
  assert.ok(ui.indexOf(post) < ui.indexOf('arrived = true'));
  if (process.platform !== 'darwin') { t.skip('Actual host Swift policy execution unavailable; wiring assertions only, not a native pass.'); return; }
  function declaration(prefix) {
    const start = ui.indexOf(prefix); assert.ok(start >= 0);
    const open = ui.indexOf('{', start); let depth = 0;
    for (let index = open; index < ui.length; index++) {
      if (ui[index] === '{') depth++;
      if (ui[index] === '}' && --depth === 0) return ui.slice(start, index + 1);
    }
    throw new Error('Unbalanced actual Swift declaration');
  }
  const script = `import Foundation
${declaration('private enum QAError:')}
${declaration('private struct Arrival:')}
${declaration('private enum ArrivalReadPolicy')}
let fixture = UUID(uuidString: "${run}")!
let other = UUID(uuidString: "${udid}")!
private func sample(_ count: Int, id: UUID = fixture, revision: String = "${source}") -> Arrival {
    Arrival(schemaVersion: 1, fixtureInstanceId: id, sourceRevision: revision, loginSuccessCount: count)
}
func accepted(_ operation: () throws -> Void) -> Bool { do { try operation(); return true } catch { return false } }
func require(_ condition: Bool) { if !condition { print("actual policy case failed"); exit(1) } }
require(accepted { try ArrivalReadPolicy.requireStable(sample(0), sample(0), expectedCount: 0) })
require(accepted { try ArrivalReadPolicy.requireStable(sample(1), sample(1), expectedCount: 1) })
require(!accepted { try ArrivalReadPolicy.requireStable(sample(0), sample(1), expectedCount: 0) })
require(!accepted { try ArrivalReadPolicy.requireStable(sample(1), sample(2), expectedCount: 1) })
require(!accepted { try ArrivalReadPolicy.requireStable(sample(1), sample(1, id: other), expectedCount: 1) })
require(!accepted { try ArrivalReadPolicy.requireStable(sample(1), sample(1, revision: "different"), expectedCount: 1) })
require(!accepted { try ArrivalReadPolicy.requireStable(sample(1), sample(1), expectedCount: 2) })
print("actual-policy-cases=7 passed")
`;
  const workspace = await mkdtemp(join(tmpdir(), 'ipad-qa-pure-policy-'));
  try {
    const result = spawnSync('/usr/bin/xcrun', ['swift', '-module-cache-path', join(workspace, 'module-cache'), '-'], {
      env: { ...process.env, DEVELOPER_DIR: '/Applications/Xcode-beta.app/Contents/Developer' }, input: script, encoding: 'utf8', timeout: 30_000,
    });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /actual-policy-cases=7 passed/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('runner guards exact owned iPad and stops unexpected consent or security prompts without accepting', () => {
  assert.match(ui, /UUID\(uuidString: actual\) == expectedID/); assert.match(ui, /UIDevice\.current\.userInterfaceIdiom == \.pad/);
  assert.match(ui, /SIMULATOR_DEVICE_NAME/); assert.match(ui, /YAWF-iPad-NativeQA-/);
  assert.match(ui, /!application\.alerts\.firstMatch\.exists, !springboard\.alerts\.firstMatch\.exists/);
  assert.match(ui, /Unexpected terms, authorization, privacy or security prompt/);
  assert.doesNotMatch(ui, /buttons\["(?:Agree|Allow|Enable UI Automation)"\]\.tap|resetAuthorizationStatus|requestAuthorization|openSettingsURLString/);
});

test('manual project and shared scheme are simulator-only unsigned iPad targets without packages or parallel clones', () => {
  assert.match(project, /productType = "com\.apple\.product-type\.bundle\.ui-testing"/);
  assert.equal((project.match(/SUPPORTED_PLATFORMS = iphonesimulator/g) ?? []).length, 6);
  assert.equal((project.match(/CODE_SIGNING_ALLOWED = NO/g) ?? []).length, 6);
  assert.equal((project.match(/TARGETED_DEVICE_FAMILY = 2/g) ?? []).length, 6);
  assert.match(project, /TEST_TARGET_NAME = NativeQAAnchor/);
  assert.doesNotMatch(project, /PBXShellScriptBuildPhase|XCRemoteSwiftPackageReference|DEVELOPMENT_TEAM|CODE_SIGN_IDENTITY|com\.tgk30/);
  assert.match(scheme, /parallelizeBuildables="NO"/); assert.match(scheme, /parallelizable="NO"/);
  for (const key of ['QA_EXPECTED_UDID', 'QA_OWNED_DEVICE_NAME', 'QA_HTTP_PROBE_URL', 'QA_EXPECTED_FIXTURE_ID', 'QA_EXPECTED_SOURCE_REVISION']) assert.ok(scheme.includes(`key="${key}" value="$(${key})"`));
});

test('Apple tools strictly parse Swift, plists and scheme and list the project without build or launch', (t) => {
  if (process.platform !== 'darwin') { t.skip('Apple SDK parser/project inventory unavailable; not a native pass.'); return; }
  const env = { ...process.env, DEVELOPER_DIR: '/Applications/Xcode-beta.app/Contents/Developer' };
  const command = (file, args) => {
    const result = spawnSync(file, args, { env, encoding: 'utf8', timeout: 30_000 }); assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  const sdk = command('/usr/bin/xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']).trim();
  for (const path of ['Anchor/AppDelegate.swift', 'UITests/SafariNativeInputTests.swift']) command('/usr/bin/xcrun', ['swiftc', '-frontend', '-parse', '-warnings-as-errors', '-target', 'arm64-apple-ios26.5-simulator', '-sdk', sdk, join(folder, path)]);
  command('/usr/bin/plutil', ['-lint', join(folder, 'Anchor/Info.plist'), join(folder, 'NativeQA.xcodeproj/project.pbxproj')]);
  command('/usr/bin/xmllint', ['--noout', join(folder, 'NativeQA.xcodeproj/xcshareddata/xcschemes/NativeQA.xcscheme')]);
  const listed = JSON.parse(command('/usr/bin/xcodebuild', ['-list', '-json', '-project', join(folder, 'NativeQA.xcodeproj'), '-disableAutomaticPackageResolution']));
  assert.deepEqual(listed.project.targets.sort(), ['NativeQAAnchor', 'SafariNativeInputTests']);
  assert.deepEqual(listed.project.schemes.sort(), ['NativeQA', 'NativeQAAnchor']);
});
