import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const workflowPath = join(root, ".github/workflows/android-public-ota-runtime.yml");
const driverPath = join(root, "scripts/android_public_ota_runtime_check.py");
const runtimePath = join(
  root,
  "scripts/android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeOtaFlowTest.java",
);
const pythonLookup = spawnSync(
  "/usr/bin/env",
  ["python3", "-c", "import sys; print(sys.executable)"],
  { encoding: "utf8" },
);
assert.equal(pythonLookup.status, 0, `python3 lookup failed: ${pythonLookup.stderr}`);
const pythonExecutable = pythonLookup.stdout.trim();

function validateWorkflow(source) {
  const failures = [];
  const requireText = (value, message) => {
    if (!source.includes(value)) failures.push(message);
  };
  requireText("workflow_dispatch:", "manual trigger is missing");
  if (/\n\s+(?:push|pull_request|schedule):/.test(source)) failures.push("unexpected automatic trigger");
  requireText("permissions:\n  contents: read", "least contents permission is missing");
  if (!/^\s{4}timeout-minutes: 30$/m.test(source)) failures.push("finite job timeout is missing");
  requireText("BASELINE_APK_SHA256: 6b7be775e261db5e400790d7c6d80d0ffeca13aada590ae4c66955003c5163f6", "baseline hash pin is missing");
  requireText("TARGET_SOURCE_SHA: e28c593ed680538dca91c01ac6b993fdc25eb6dd", "target source pin is missing");
  requireText("TARGET_APK_SHA256: 4f8cb6defe54e128f01790fafd84b6f3fd545d7c6734458d24543edcfa4bc58b", "target hash pin is missing");
  requireText("TARGET_APK_SIZE: \"88533889\"", "target size pin is missing");
  requireText(
    "TARGET_VERIFICATION: public-assets/Android_2.3.25_verification.json",
    "target verification receipt path is missing",
  );
  requireText(
    '"$repo/$TARGET_TAG/Android_${TARGET_VERSION}_verification.json"',
    "public verification receipt download is missing",
  );
  if ((source.match(/--target-verification "\$TARGET_VERIFICATION"/g) || []).length !== 2) {
    failures.push("both preflight and runtime must verify the public verification receipt");
  }
  requireText("system-images;android-36;google_apis;x86_64", "exact API 36 image is missing");
  requireText("--proto '=https' --proto-redir '=https'", "HTTPS-only redirect policy is missing");
  requireText("--verify-inputs-only", "public preflight is missing");
  requireText("REQUEST_INSTALL_PACKAGES|BIND_ACCESSIBILITY_SERVICE", "harness permission rejection is missing");
  if (!/^\s+--flow-timeout 720$/m.test(source)) failures.push("bounded persistent flow timeout is missing");
  requireText("if: always()", "failure evidence upload is missing");
  if (/adb -s "\$EMULATOR_SERIAL" install\b/.test(source)) {
    failures.push("workflow must delegate every install admission to the locked host driver");
  }
  return failures;
}

function validateNegativeObservationPolicy(source) {
  const failures = [];
  const requireText = (value, message) => {
    if (!source.includes(value)) failures.push(message);
  };
  requireText(
    "long previous = configurator.getWaitForIdleTimeout();",
    "negative observations do not preserve the UiAutomator idle timeout",
  );
  requireText(
    "configurator.setWaitForIdleTimeout(NEGATIVE_IDLE_TIMEOUT_MS);",
    "negative observations do not use the bounded idle timeout",
  );
  requireText(
    "finally {\n            configurator.setWaitForIdleTimeout(previous);\n        }",
    "negative observations do not restore the prior idle timeout in finally",
  );
  requireText(
    "private static final long NEGATIVE_IDLE_TIMEOUT_MS = 100L;",
    "negative observation timeout is not the reviewed finite value",
  );
  if (/Configurator\.getInstance\(\)\.setWaitForIdleTimeout/.test(source)) {
    failures.push("idle-timeout changes must remain scoped to the restoration helper");
  }
  return failures;
}

test("workflow pins public source and bytes and delegates all installs to the locked driver", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.deepEqual(validateWorkflow(workflow), []);
});

test("workflow contract rejects each targeted semantic regression", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const mutants = [
    ["workflow_dispatch:", "schedule:\n    - cron: '0 0 * * *'"],
    ["permissions:\n  contents: read", "permissions:\n  contents: write"],
    ["timeout-minutes: 30", "timeout-minutes: 300"],
    ["TARGET_SOURCE_SHA: e28c593ed680538dca91c01ac6b993fdc25eb6dd", "TARGET_SOURCE_SHA: 0000000000000000000000000000000000000000"],
    ["TARGET_APK_SIZE: \"88533889\"", "TARGET_APK_SIZE: \"88533890\""],
    [
      "TARGET_VERIFICATION: public-assets/Android_2.3.25_verification.json",
      "TARGET_VERIFICATION: public-assets/unreviewed.json",
    ],
    ["--proto '=https' --proto-redir '=https'", "--proto '=https'"],
    ["--verify-inputs-only", "--self-test"],
    ["--flow-timeout 720", "--flow-timeout 7200"],
  ];
  for (const [before, after] of mutants) {
    assert.equal(workflow.split(before).length - 1, 1, `mutation site must be unique: ${before}`);
    assert.notDeepEqual(validateWorkflow(workflow.replace(before, after)), [], `mutant survived: ${before}`);
  }
});

test("runtime source uses semantic UI only and records genuine installer and cleanup facts", async () => {
  const source = await readFile(runtimePath, "utf8");
  assert.match(source, /advanceFixedTour\(TIER_TITLES, "tier"\)/);
  assert.match(source, /advanceFixedTour\(WELCOME_TITLES, "welcome"\)/);
  assert.match(source, /Dismiss setup reminder/);
  assert.match(source, /Do you want to update this app\?/);
  assert.match(source, /App installed\./);
  assert.match(source, /installerSuccessObserved = true/);
  assert.match(source, /permissionCleanupObserved = true/);
  assert.doesNotMatch(source, /device\.click\s*\(\s*\d/);
  assert.doesNotMatch(source, /executeShellCommand/);
  assert.doesNotMatch(source, /appops\s+set|pm\s+(?:grant|revoke)/i);
});

test("negative observations scope and restore a short UiAutomator idle timeout", async () => {
  const source = await readFile(runtimePath, "utf8");
  assert.deepEqual(validateNegativeObservationPolicy(source), []);

  const mutants = [
    [
      "long previous = configurator.getWaitForIdleTimeout();",
      "long previous = NEGATIVE_IDLE_TIMEOUT_MS;",
    ],
    [
      "configurator.setWaitForIdleTimeout(NEGATIVE_IDLE_TIMEOUT_MS);",
      "configurator.setWaitForIdleTimeout(previous);",
    ],
    [
      "finally {\n            configurator.setWaitForIdleTimeout(previous);\n        }",
      "finally {\n            configurator.setWaitForIdleTimeout(NEGATIVE_IDLE_TIMEOUT_MS);\n        }",
    ],
    [
      "private static final long NEGATIVE_IDLE_TIMEOUT_MS = 100L;",
      "private static final long NEGATIVE_IDLE_TIMEOUT_MS = 10_000L;",
    ],
  ];
  for (const [before, after] of mutants) {
    assert.equal(source.split(before).length - 1, 1, `mutation site must be unique: ${before}`);
    assert.notDeepEqual(
      validateNegativeObservationPolicy(source.replace(before, after)),
      [],
      `negative-observation mutant survived: ${before}`,
    );
  }
});

async function assertAdbAdmissionEnvironmentIsolation(original) {
  const mutationBefore = 'if lowered[0].startswith("install") or lowered[0] in {"push", "sync"}:';
  const mutationAfter = 'if lowered[0].startswith("install") or lowered[0] in {"sync"}:';
  assert.equal(original.split(mutationBefore).length - 1, 1);

  const temporary = await mkdtemp(join(tmpdir(), "yawf-ota-adb-admission-"));
  try {
    const fakeBin = join(temporary, "fake-bin");
    const absentBin = join(temporary, "absent-bin");
    const fakeLog = join(temporary, "fake-adb.log");
    await Promise.all([mkdir(fakeBin), mkdir(absentBin)]);
    const fakeAdb = join(fakeBin, "adb");
    await writeFile(
      fakeAdb,
      '#!/bin/sh\nprintf "called\\n" >> "$YAWF_FAKE_ADB_LOG"\nexit 0\n',
    );
    await chmod(fakeAdb, 0o755);
    const mutatedPath = join(temporary, "mutated-admission.py");
    await writeFile(mutatedPath, original.replace(mutationBefore, mutationAfter));

    for (const [label, pathValue] of [["fake-present", fakeBin], ["absent", absentBin]]) {
      const env = { ...process.env, PATH: pathValue, YAWF_FAKE_ADB_LOG: fakeLog };
      const baseline = spawnSync(
        pythonExecutable,
        [driverPath, "--self-test", "test_admission_locks_all_product_install_routes"],
        { encoding: "utf8", env },
      );
      assert.equal(baseline.status, 0, `${label} baseline failed: ${baseline.stderr}`);
      const mutant = spawnSync(
        pythonExecutable,
        [mutatedPath, "--self-test", "test_admission_locks_all_product_install_routes"],
        { encoding: "utf8", env },
      );
      assert.notEqual(mutant.status, 0, `${label} admission mutant survived`);
      assert.match(mutant.stderr, /Forbidden admission case reached external ADB dispatch/);
      const calls = await readFile(fakeLog, "utf8").catch(() => "");
      assert.equal(calls, "", `${label} invoked external adb`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test("each host policy self-test kills a targeted valid-Python semantic mutant", async () => {
  const original = await readFile(driverPath, "utf8");
  await assertAdbAdmissionEnvironmentIsolation(original);
  const mutants = new Map([
    ["test_manifest_exact", [
      "for key, expected_value in expected.items():\n        if type(value.get(key))",
      'for key, expected_value in expected.items():\n        if key == "versionCode":\n            continue\n        if type(value.get(key))',
    ]],
    ["test_release_requires_newest_public_target", [
      'if release.get("draft") is not False or release.get("prerelease") is not False:',
      'if release.get("prerelease") is not False:',
    ]],
    ["test_release_binds_verification_bytes_and_digest", [
      'if verification.get("digest") != f"sha256:{verification_hash}":',
      'if False and verification.get("digest") != f"sha256:{verification_hash}":',
    ]],
    ["test_verification_receipt_matches_actual_asset_shape", [
      'if value.get("version") != TARGET_VERSION or value.get("sourceRevision") != TARGET_SOURCE:',
      'if value.get("version") != TARGET_VERSION:',
    ]],
    ["test_checksums_reject_duplicates_and_wrong_set", [
      'if set(result) != {TARGET_APK_NAME, "android-update.json", TARGET_VERIFICATION_NAME}:',
      'if set(result) != {TARGET_APK_NAME, "android-update.json"}:',
    ]],
    ["test_identity_requires_all_retention_fields", [
      '    modern_app_ids = re.findall(r"(?m)^    appId=(\\d+)\\s*$", package_fields)',
      "    modern_app_ids = []",
    ]],
    ["test_receipt_requires_every_transaction_fact", [
      "for key, expected_value in expected.items():\n        if value.get(key)",
      'for key, expected_value in expected.items():\n        if key == "installerSuccessObserved":\n            continue\n        if value.get(key)',
    ]],
    ["test_admission_locks_all_product_install_routes", [
      'if lowered[0].startswith("install") or lowered[0] in {"push", "sync"}:',
      'if lowered[0].startswith("install") or lowered[0] in {"sync"}:',
    ]],
    ["test_scoped_pulls_require_correct_state", [
      'if not self.installer_success_receipt or self.final_pulled:',
      'if self.final_pulled:',
    ]],
    ["test_evidence_names_reject_traversal", [
      'r"(?:0[1-9]|[12][0-9]|3[0-9]|40)-[a-z0-9-]+\\.(?:png|xml)|"',
      'r"(?:0[1-9]|[12][0-9]|3[0-9]|4[01])-[a-z0-9-]+\\.(?:png|xml)|"',
    ]],
  ]);
  const temporary = await mkdtemp(join(tmpdir(), "yawf-ota-host-mutants-"));
  try {
    for (const [name, [before, after]] of mutants) {
      assert.equal(original.split(before).length - 1, 1, `mutation site must be unique: ${name}`);
      const baseline = spawnSync("python3", [driverPath, "--self-test", name], { encoding: "utf8" });
      assert.equal(baseline.status, 0, `baseline failed for ${name}: ${baseline.stderr}`);
      const mutatedPath = join(temporary, `${name}.py`);
      await writeFile(mutatedPath, original.replace(before, after));
      const mutant = spawnSync("python3", [mutatedPath, "--self-test", name], { encoding: "utf8" });
      assert.notEqual(mutant.status, 0, `semantic mutant survived: ${name}`);
    }

    const identityMutants = [
      [
        '    if bool(legacy_uids) == bool(modern_app_ids):\n' +
          '        raise RuntimeGateError("Package identity must contain exactly one userId or appId")\n' +
          '    uid = int((legacy_uids or modern_app_ids)[0])',
        '    if legacy_uids and modern_app_ids:\n' +
          '        raise RuntimeGateError("Package identity must contain exactly one userId or appId")\n' +
          '    uid = int((legacy_uids or modern_app_ids or ["10218"])[0])',
        "missing application identity",
      ],
      [
        '    if bool(legacy_uids) == bool(modern_app_ids):',
        '    if not legacy_uids and not modern_app_ids:',
        "mixed legacy and modern identity",
      ],
      [
        '    if len(legacy_uids) > 1 or len(modern_app_ids) > 1:',
        '    if len(legacy_uids) > 1:',
        "duplicate appId",
      ],
      [
        '    if len(package_headers) != 1 or package_headers[0].group(1) != PRODUCT_PACKAGE:',
        '    if len(package_headers) != 1:',
        "wrong package",
      ],
      [
        '    if len(package_headers) != 1 or package_headers[0].group(1) != PRODUCT_PACKAGE:',
        '    if package_headers[0].group(1) != PRODUCT_PACKAGE:',
        "duplicate package section",
      ],
      [
        '    if len(first_install_times) != 1 or not first_install_times[0].strip():\n' +
          '        raise RuntimeGateError("Package identity firstInstallTime is missing or ambiguous")',
        '    if len(first_install_times) > 1:\n' +
          '        raise RuntimeGateError("Package identity firstInstallTime is missing or ambiguous")\n' +
          '    if not first_install_times:\n' +
          '        first_install_times = ["2026-10-20 05:11:15"]',
        "missing first install time",
      ],
      [
        '        last_update_time=exactly_one(\n' +
          '            r"^    lastUpdateTime=([^\\r\\n]+)$", "lastUpdateTime"\n' +
          '        ),',
        '        last_update_time="2026-10-20 05:11:15",',
        "missing last update time",
      ],
      [
        '    if re.search(r"(?:^|\\s)installed=true(?:\\s|$)", user_sections[0].group(2)) is None:',
        '    if False and re.search(r"(?:^|\\s)installed=true(?:\\s|$)", user_sections[0].group(2)) is None:',
        "User 0 not installed",
      ],
      [
        '    if len(user_sections) != 1 or user_sections[0].group(1) != "0":',
        '    if len(user_sections) != 1:',
        "nonzero Android user",
      ],
      [
        '    if not 10_000 <= uid < 100_000:',
        '    if False and not 10_000 <= uid < 100_000:',
        "nonapplication appId",
      ],
      [
        '        version_name=exactly_one(r"^    versionName=([^\\s]+)\\s*$", "versionName"),',
        '        version_name="2.3.25",',
        "missing versionName",
      ],
      [
        '        version_code=int(exactly_one(r"^    versionCode=(\\d+)(?:\\s+.*)?$", "versionCode")),',
        '        version_code=2_003_025,',
        "missing versionCode",
      ],
      [
        '    write_diagnostic(name, value)\n    return parse_package_identity(value)',
        '    identity = parse_package_identity(value)\n' +
          '    write_diagnostic(name, value)\n' +
          '    return identity',
        "diagnostic written only after parsing",
      ],
    ];
    for (const [before, after, label] of identityMutants) {
      assert.equal(original.split(before).length - 1, 1, `identity mutation site must be unique: ${label}`);
      const mutatedPath = join(temporary, `identity-${label.replaceAll(" ", "-")}.py`);
      await writeFile(mutatedPath, original.replace(before, after));
      const mutant = spawnSync(
        "python3",
        [mutatedPath, "--self-test", "test_identity_requires_all_retention_fields"],
        { encoding: "utf8" },
      );
      assert.notEqual(mutant.status, 0, `identity semantic mutant survived: ${label}`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
