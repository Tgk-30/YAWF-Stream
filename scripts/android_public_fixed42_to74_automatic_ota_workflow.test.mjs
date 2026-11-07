import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultWorkflow = path.join(
  root,
  ".github/workflows/android-public-fixed42-to74-automatic-ota-runtime.yml",
);
const workflowPath = process.env.FIXED42_TO74_WORKFLOW_SOURCE == null
  ? defaultWorkflow
  : path.resolve(process.env.FIXED42_TO74_WORKFLOW_SOURCE);
const source = fs.readFileSync(workflowPath, "utf8");
const runtimeSource = fs.readFileSync(
  path.join(root, "scripts/android_public_ota_runtime_check.py"),
  "utf8",
);

function need(haystack, needle, message) {
  assert.ok(haystack.includes(needle), message);
}

function contract(yaml) {
  for (const token of [
    "BASELINE_VERSION: 2.3.42",
    'BASELINE_VERSION_CODE: "2003042"',
    "BASELINE_SOURCE_SHA: ae9b35f8513c9f7e203508f2c95f1f99d77ddcf5",
    "BASELINE_BUILD_RUN: \"40025606020\"",
    "BASELINE_APK_SHA256: 3e1f72c2d1214b491fb505b5ea85ccc507d2478288066ff9cf846c5924d1805c",
    "BASELINE_APK_SIZE: \"88583041\"",
    "BASELINE_MANIFEST_SHA256: 26fedf40c35011ecf3edaa29462c18f04301dafae7dd9e3808e1ea1e2a3001a8",
    "BASELINE_VERIFICATION_SHA256: a87360645d7700f7c2ff9a99629d714b7d126fbe5d66a9a2e44a10baad42c4dc",
    "TARGET_VERSION: 2.3.74",
    'TARGET_VERSION_CODE: "2003074"',
    "TARGET_SOURCE_SHA: 6eff963227ef58adc508c35abb56c58a615a8a96",
    "TARGET_BUILD_RUN: \"42365613314\"",
    "TARGET_APK_SHA256: d6eda3e15aca6005ea9be32b793339cd22469b4802b39326f3ee9ab17b47b7ae",
    "TARGET_APK_SIZE: \"88669057\"",
    "TARGET_MANIFEST_SHA256: 0493b4ba62722d38b7223648d6c2ca4423d8f6934df735316f17da7285491984",
    "TARGET_VERIFICATION_SHA256: c74413a7a4a0591df1407b9483d00e98f1919b538c1fbb6b009439121a750130",
    "TARGET_CHECKSUMS_SHA256: 4bc1283984e9d3c8573414a8aff08a7a651e8e04354492e8cbde7c6aa6c6bdaa",
    "UPDATER_SOURCE_SHA256: 129df15e095ed5ce8933d17ab9a0329da79244e14ac046df18c3fad32e01163d",
    "OTA_MODE: public-fixed42-to74-initial-cancel-due-resume-v1",
  ]) need(yaml, token, `fixed workflow lost ${token}`);
  assert.equal(yaml.includes("inputs."), false, "fixed profile admits arbitrary dispatch inputs");
  assert.equal(yaml.includes("workflow_dispatch:\n    inputs:"), false, "fixed profile exposes inputs");
}

function mutate(original, replacement) {
  need(source, original, `mutation anchor is missing: ${original}`);
  const changed = source.replace(original, replacement);
  assert.throws(() => contract(changed));
}

test("workflow is a separately named immutable 2.3.42 to 2.3.74 profile", () => {
  contract(source);
  mutate("BASELINE_VERSION: 2.3.42", "BASELINE_VERSION: 2.3.27");
  mutate("TARGET_VERSION: 2.3.74", "TARGET_VERSION: 2.3.60");
  mutate(
    "OTA_MODE: public-fixed42-to74-initial-cancel-due-resume-v1",
    "OTA_MODE: automatic-initial-cancel-due-resume",
  );
});

test("workflow freshly admits both official public release records and every required asset", () => {
  for (const token of [
    '"$repo/$BASELINE_TAG/YAWF.Stream_Android_${BASELINE_VERSION}.apk"',
    '"$repo/$BASELINE_TAG/android-update.json"',
    '"$repo/$BASELINE_TAG/Android_${BASELINE_VERSION}_verification.json"',
    '"$repo/$BASELINE_TAG/SHA256SUMS"',
    '"$repo/$TARGET_TAG/YAWF.Stream_Android_${TARGET_VERSION}.apk"',
    '"$repo/$TARGET_TAG/android-update.json"',
    '"$repo/$TARGET_TAG/Android_${TARGET_VERSION}_verification.json"',
    '"$repo/$TARGET_TAG/SHA256SUMS"',
    '"https://api.github.com/repos/Tgk-30/YAWF-Stream/releases?per_page=20&page=$page"',
    '"publishedAt": release.get("published_at")',
    '"targetCommitish": release.get("target_commitish")',
    'node scripts/android_public_fixed42_to74_automatic_ota_admission.mjs',
  ]) need(source, token, `fresh publication admission lost ${token}`);
  const changed = source.replace('"targetCommitish": release.get("target_commitish")', '"targetCommitish": os.environ["TARGET_SOURCE_SHA"]');
  assert.equal(changed.includes('"targetCommitish": release.get("target_commitish")'), false);
});

test("workflow checks out both exact sources and proves updater byte identity", () => {
  for (const token of [
    "ref: ${{ env.BASELINE_SOURCE_SHA }}",
    "path: baseline-source",
    "ref: ${{ env.TARGET_SOURCE_SHA }}",
    "path: target-source",
    'test "$(git -C baseline-source rev-parse HEAD)" = "$BASELINE_SOURCE_SHA"',
    'test "$(git -C target-source rev-parse HEAD)" = "$TARGET_SOURCE_SHA"',
    "baseline-source/scripts/android/YawfAndroidUpdater.kt | sha256sum -c -",
    "target-source/scripts/android/YawfAndroidUpdater.kt | sha256sum -c -",
    '"$TARGET_CHECKSUMS_SHA256" "$TARGET_CHECKSUMS" | sha256sum -c -',
  ]) need(source, token, `source admission lost ${token}`);
});

test("workflow pins Node 24.22.1, JDK 17, API 36, and executes the new gates", () => {
  for (const token of [
    'node-version: "24.22.1"',
    'test "$(node --version)" = "v24.22.1"',
    'java-version: "17"',
    "system-images;android-36;google_apis;x86_64",
    "scripts/android_public_fixed42_to74_automatic_ota_admission.test.mjs",
    "scripts/android_public_fixed42_to74_automatic_ota_policy.test.mjs",
    "scripts/android_public_fixed42_to74_automatic_ota_driver.test.mjs",
    "scripts/android_public_fixed42_to74_automatic_ota_workflow.test.mjs",
    "scripts/android_public_fixed42_to74_automatic_ota_host.test.py",
    "scripts/android_public_fixed42_automatic_ota_admission.test.mjs",
    "scripts/android_public_fixed42_automatic_ota_policy.test.mjs",
    "scripts/android_public_fixed42_automatic_ota_driver.test.mjs",
    "scripts/android_public_fixed42_automatic_ota_workflow.test.mjs",
    "scripts/android_public_fixed42_automatic_ota_host.test.py",
  ]) need(source, token, `tool or gate pin lost ${token}`);
  const changed = source.replace('node-version: "24.22.1"', 'node-version: "node"');
  assert.equal(changed.includes('node-version: "24.22.1"'), false);
});

test("target APK remains a host reference and only the baseline is installed through ADB", () => {
  need(source, "AUTOMATIC_BINDING: public-assets/fixed42-to74-automatic-admission.json", "fixed host binding is absent");
  need(source, '--baseline-apk "$BASELINE_APK"', "baseline host input is absent");
  need(source, '--target-apk "$TARGET_APK"', "target host reference is absent");
  assert.equal(/adb[^\n]*(?:install|push)[^\n]*\$TARGET_APK/.test(source), false);
  assert.equal(/adb[^\n]*(?:install|push)[^\n]*YAWF\.Stream_Android_2\.3\.61\.apk/.test(source), false);
  need(source, "python3 scripts/android_public_ota_runtime_check.py", "guarded host driver is absent");
});

test("merged harness manifest requires one exact app MAIN HOME query and none in test APK", () => {
  for (const token of [
    'APP_MANIFEST="$EVIDENCE/instrumentation-app-manifest.xml"',
    'TEST_MANIFEST="$EVIDENCE/instrumentation-test-manifest.xml"',
    'actions[0].get(ANDROID + "name") == "android.intent.action.MAIN"',
    'categories[0].get(ANDROID + "name") == "android.intent.category.HOME"',
    'assert len(app_queries) == 1',
    'assert len(test_queries) == 0',
  ]) need(source, token, `merged manifest query gate lost ${token}`);

  const appOnlyRemoved = source.replace('assert len(app_queries) == 1', 'assert len(test_queries) == 1');
  assert.notEqual(appOnlyRemoved, source, "query-only-test-manifest mutant anchor is absent");
  assert.equal(appOnlyRemoved.includes('assert len(app_queries) == 1'), false,
    "query-only-test-manifest mutant was not detected");
});

test("recorded protocol separates automatic discovery from one later manual inspection", () => {
  for (const token of [
    'echo "preOfferManualDiscoveries=0"',
    'echo "postInstallManualInspectionChecks=1"',
    'echo "postInstallNativeOkClosures=1"',
    'echo "automaticDiscoveryProofIncludesPostInstallInspection=false"',
  ]) need(source, token, `binding non-claim lost ${token}`);
  const changed = source.replace(
    'echo "automaticDiscoveryProofIncludesPostInstallInspection=false"',
    'echo "automaticDiscoveryProofIncludesPostInstallInspection=true"',
  );
  assert.equal(changed.includes('echo "automaticDiscoveryProofIncludesPostInstallInspection=false"'), false);
});

test("failure trap always retains bounded host health before conditional device evidence", () => {
  for (const token of [
    "collect_fixed42_host_failure_diagnostics",
    '--fixed42-host-failure-diagnostics',
    '--fixed42-device-capture-gate',
    '--emulator-pid-liveness "$emulator_pid_liveness"',
    '--emulator-exit-status "$emulator_exit_status"',
    '--runner-temp "$RUNNER_TEMP"',
    '--workspace "$GITHUB_WORKSPACE"',
    'command -v adb',
    'status=$?',
    'exit "$status"',
  ]) need(source, token, `bounded host failure observation lost ${token}`);
  for (const token of [
    'sha256_file(resolved_adb)',
    'os.statvfs(path)',
    '"MemAvailable"',
    '[str(resolved_adb), "version"]',
    '[str(resolved_adb), "-s", serial, "get-state"]',
    'workflow-host-diagnostics.json',
    '"workflow-adb-get-state"',
    'f"{stem}-{stream}-retention.json"',
  ]) need(runtimeSource, token, `bounded host failure observation lost ${token}`);

  const hostStart = source.indexOf("collect_fixed42_host_failure_diagnostics");
  const deviceGate = source.indexOf('if [ "$get_state" != "device" ]', hostStart);
  assert.ok(hostStart >= 0, "host evidence must be collected");
  assert.equal(deviceGate, -1, "stdout text alone must not admit device capture");
  const semanticGate = source.indexOf("--fixed42-device-capture-gate", hostStart);
  const deviceUnavailable = source.indexOf('echo "deviceEvidence=unavailable"', semanticGate);
  assert.ok(semanticGate > hostStart && deviceUnavailable > semanticGate,
    "validated host receipt must gate conditional device evidence");
  assert.equal(source.includes("adb reconnect"), false);
  assert.equal(source.includes("adb kill-server"), false);
  assert.equal(source.includes("adb start-server"), false);
  assert.equal(/\bps\s+(?:aux|-[a-z]*e)/.test(source), false, "failure evidence must not enumerate processes");
  assert.equal(/\benv\b\s*>/.test(source), false, "failure evidence must not dump environment values");
});

function fixtureScript(phase, yaml = source) {
  const first = `          # BEGIN EXACT480 ${phase}`;
  const last = `          # END EXACT480 ${phase}`;
  const start = yaml.indexOf(first);
  const end = yaml.indexOf(last, start);
  assert.ok(start >= 0 && end > start, `missing actual ${phase} fixture policy`);
  return yaml.slice(start, end + last.length).split("\n")
    .map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");
}

function withDisplayFixture(run) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "yawf-480dpi-policy-"));
  const root = fs.realpathSync(temporary);
  const name = "yawf-public-fixed42-to74-automatic-ota-api36-480dpi";
  const home = path.join(root, "yawf-public-fixed42-to74-480dpi-android", "avd");
  const directory = path.join(home, name);
  const config = path.join(directory, "config.ini");
  const evidence = path.join(root, "evidence");
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(evidence);
  const original = "# Unrelated420 remains byte-identical\r\n"
    + "hw.device.name=pixel\r\nhw.lcd.width=1080\r\nhw.lcd.height=1920\r\n"
    + "hw.lcd.density = 420  \r\nhw.keyboard=yes\r\nhw.cpu.arch=x86_64\r\n";
  fs.writeFileSync(config, original);
  const env = {
    ...process.env, RUNNER_TEMP: root, AVD_NAME: name, ANDROID_AVD_HOME: home,
    AVD_CONFIG: config, RUN_EVIDENCE: evidence,
  };
  try { run({ root, config, evidence, original, env }); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function runFixturePolicy(phase, env, yaml = source) {
  return spawnSync("python3", ["-c", fixtureScript(phase, yaml)], {
    env, encoding: "utf8", timeout: 10_000,
  });
}

test("480dpi is an explicitly named preboot-only functional fixture, not a420dpi UI qualification", () => {
  for (const token of [
    "AVD_NAME: yawf-public-fixed42-to74-automatic-ota-api36-480dpi",
    "EVIDENCE: android-public-fixed42-to74-automatic-ota-runtime-480dpi-evidence",
    "name: android-public-fixed42-to74-automatic-ota-api36-480dpi-evidence",
    'echo "functionalOtaFixtureDensityDpi=480"',
    'echo "expectedUnzoomedDpr=3"',
    'echo "domDprMeasured=false"',
    'echo "original420DpiObserverGapOpen=true"',
    'echo "fullUiQualificationClaimed=false"',
    'adb -s "$EMULATOR_SERIAL" shell wm size >',
    'adb -s "$EMULATOR_SERIAL" shell wm density >',
  ]) need(source, token, `density fixture lost ${token}`);
  const preboot = source.indexOf("# BEGIN EXACT480 PREBOOT FIXTURE");
  const boot = source.indexOf("nohup emulator");
  const readback = source.indexOf("# BEGIN EXACT480 POSTBOOT READBACK");
  const flow = source.indexOf('--flow-timeout 720');
  assert.ok(preboot > source.indexOf("avdmanager create avd") && preboot < boot
    && boot < readback && readback < flow, "density configuration/readback order changed");
  assert.doesNotMatch(source, /-dpi-device|shell wm density\s+\d|shell wm size\s+\d/);
});

test("actual preboot policy changes only density inside one fresh owned Pixel configuration", () => {
  withDisplayFixture(({ config, evidence, original, env }) => {
    const result = runFixturePolicy("PREBOOT FIXTURE", env);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const expected = original.replace("hw.lcd.density = 420", "hw.lcd.density = 480");
    assert.equal(fs.readFileSync(config, "utf8"), expected);
    assert.equal(fs.readFileSync(path.join(evidence, "avd-config-before.ini"), "utf8"), original);
    assert.equal(fs.readFileSync(path.join(evidence, "avd-config-480dpi.ini"), "utf8"), expected);
    const receipt = JSON.parse(fs.readFileSync(path.join(evidence, "preboot-display-fixture.json")));
    assert.equal(receipt.configuredDensityDpi, 480);
    assert.equal(receipt.expectedUnzoomedDpr, 3);
    assert.equal(receipt.domDprMeasured, false);
    assert.equal(receipt.original420DpiObserverGapOpen, true);
    assert.equal(receipt.fullUiQualificationClaimed, false);
  });
});

for (const [name, change] of [
  ["wrong physical size", (f) => fs.writeFileSync(f.config, f.original.replace("width=1080", "width=1079"))],
  ["wrong Pixel identity", (f) => fs.writeFileSync(f.config, f.original.replace("name=pixel", "name=other"))],
  ["nonfresh density", (f) => fs.writeFileSync(f.config, f.original.replace("density = 420", "density = 480"))],
  ["duplicate density", (f) => fs.appendFileSync(f.config, "hw.lcd.density=420\n")],
  ["duplicate width", (f) => fs.appendFileSync(f.config, "hw.lcd.width=1080\n")],
  ["missing hardware", (f) => fs.writeFileSync(f.config, f.original.replace("hw.lcd.height=1920\r\n", ""))],
  ["wrong configuration path", (f) => { f.env.AVD_CONFIG = path.join(f.root, "foreign.ini"); fs.writeFileSync(f.env.AVD_CONFIG, f.original); }],
  ["wrong owned AVD root", (f) => { f.env.ANDROID_AVD_HOME = path.join(f.root, "other-avds"); }],
  ["wrong owned AVD name", (f) => { f.env.AVD_NAME = "another-avd"; }],
  ["symlinked configuration", (f) => { const target = path.join(f.root, "aliased.ini"); fs.renameSync(f.config, target); fs.symlinkSync(target, f.config); }],
]) {
  test(`actual preboot policy rejects ${name} before any configuration write`, () => {
    withDisplayFixture((f) => {
      change(f);
      const before = fs.readFileSync(f.config);
      const requestedBefore = fs.existsSync(f.env.AVD_CONFIG) ? fs.readFileSync(f.env.AVD_CONFIG) : null;
      const result = runFixturePolicy("PREBOOT FIXTURE", f.env);
      assert.notEqual(result.status, 0, `${name} was admitted`);
      assert.deepEqual(fs.readFileSync(f.config), before);
      if (requestedBefore != null) assert.deepEqual(fs.readFileSync(f.env.AVD_CONFIG), requestedBefore);
      assert.equal(fs.existsSync(path.join(f.evidence, "preboot-display-fixture.json")), false);
    });
  });
}

for (const [name, size, density, accepted] of [
  ["exact480dpi", "Physical size: 1080x1920\n", "Physical density: 480\n", true],
  ["wrong420dpi", "Physical size: 1080x1920\n", "Physical density: 420\n", false],
  ["different physical size", "Physical size: 1079x1920\n", "Physical density: 480\n", false],
  ["density override", "Physical size: 1080x1920\n", "Physical density: 420\nOverride density: 480\n", false],
  ["size override", "Physical size: 1080x1920\nOverride size: 1080x1920\n", "Physical density: 480\n", false],
]) {
  test(`actual postboot policy ${accepted ? "admits" : "rejects"} ${name}`, () => {
    withDisplayFixture(({ evidence, env }) => {
      fs.writeFileSync(path.join(evidence, "effective-display-size.txt"), size);
      fs.writeFileSync(path.join(evidence, "effective-display-density.txt"), density);
      const result = runFixturePolicy("POSTBOOT READBACK", env);
      assert.equal(result.status === 0, accepted, result.stdout + result.stderr);
      const receipt = path.join(evidence, "effective-display-fixture.json");
      assert.equal(fs.existsSync(receipt), accepted);
      if (accepted) {
        const value = JSON.parse(fs.readFileSync(receipt));
        assert.equal(value.expectedUnzoomedDpr, 3);
        assert.equal(value.domDprMeasured, false);
        assert.equal(value.original420DpiObserverGapOpen, true);
      }
    });
  });
}

test("individual executable fixture-policy mutants are rejected by their causal controls", () => {
  const mutants = [
    ["wrong-size admission", "PREBOOT FIXTURE", '"hw.lcd.width": "1080"', '"hw.lcd.width": "1079"',
      (f) => fs.writeFileSync(f.config, f.original.replace("width=1080", "width=1079")), "reject"],
    ["duplicate-key admission", "PREBOOT FIXTURE", 'assert key not in indices, "Duplicate hardware property: " + key', "assert True",
      (f) => fs.appendFileSync(f.config, "hw.lcd.density=420\n"), "reject"],
    ["wrong-root admission", "PREBOOT FIXTURE", 'assert Path(os.environ["ANDROID_AVD_HOME"]) == owned, "Unexpected owned AVD root"', "assert True",
      (f) => { f.env.ANDROID_AVD_HOME = path.join(f.root, "other-avds"); }, "reject"],
    ["missing density write", "PREBOOT FIXTURE", "config.write_bytes(configured)", "config.write_bytes(original)",
      () => {}, "density-only"],
    ["unrelated-field mutation", "PREBOOT FIXTURE", 'configured = "".join(lines).encode("utf-8")', 'configured = "".join(lines).replace("hw.keyboard=yes", "hw.keyboard=no").encode("utf-8")',
      () => {}, "density-only"],
    ["wrong effective density", "POSTBOOT READBACK", 'r"Physical density: 480\\n?"', 'r"Physical density: 420\\n?"',
      (f) => {
        fs.writeFileSync(path.join(f.evidence, "effective-display-size.txt"), "Physical size: 1080x1920\n");
        fs.writeFileSync(path.join(f.evidence, "effective-display-density.txt"), "Physical density: 420\n");
      }, "reject"],
  ];
  for (const [name, phase, before, after, prepare, control] of mutants) {
    assert.equal(source.split(before).length - 1, 1, `${name} mutation site`);
    withDisplayFixture((f) => {
      prepare(f);
      const mutated = source.replace(before, after);
      const result = runFixturePolicy(phase, f.env, mutated);
      assert.equal(result.status, 0, `${name} mutant must remain executable: ${result.stderr}`);
      if (control === "reject") {
        assert.throws(() => assert.notEqual(result.status, 0), `${name} control did not become RED`);
      } else {
        const expected = f.original.replace("hw.lcd.density = 420", "hw.lcd.density = 480");
        assert.throws(() => assert.equal(fs.readFileSync(f.config, "utf8"), expected),
          `${name} density-only control did not become RED`);
      }
    });
  }
});
