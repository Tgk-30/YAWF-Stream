#!/usr/bin/env python3
"""Executable admission and receipt checks for the fixed public 2.3.42 to 2.3.59 profile."""

from __future__ import annotations

import copy
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
MODULE_PATH = Path(os.environ.get(
    "FIXED42_RUNTIME_CHECK_SOURCE",
    ROOT / "android_public_ota_runtime_check.py",
))
SPEC = importlib.util.spec_from_file_location("android_public_ota_runtime_check", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
runtime = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runtime
SPEC.loader.exec_module(runtime)


def exact_binding_value() -> dict[str, str]:
    return {
        "profile": runtime.FIXED42_AUTOMATIC_OTA_PROFILE,
        "evidenceSubdir": runtime.FIXED42_EVIDENCE_SUBDIR,
        "otaMode": runtime.FIXED42_AUTOMATIC_OTA_PROFILE,
        "baselineVersion": runtime.FIXED42_BASELINE_VERSION,
        "baselineVersionCode": str(runtime.FIXED42_BASELINE_CODE),
        "baselineTag": "android-v2.3.42",
        "baselineApkName": "YAWF.Stream_Android_2.3.42.apk",
        "baselineSha256": runtime.FIXED42_BASELINE_SHA256,
        "baselineSize": str(runtime.FIXED42_BASELINE_SIZE),
        "baselineSourceRevision": runtime.FIXED42_BASELINE_SOURCE,
        "baselineManifestSha256": runtime.FIXED42_BASELINE_MANIFEST_SHA256,
        "baselineVerificationSha256": runtime.FIXED42_BASELINE_VERIFICATION_SHA256,
        "baselineBuildRun": str(runtime.FIXED42_BASELINE_BUILD_RUN),
        "targetVersion": runtime.FIXED42_TARGET_VERSION,
        "targetVersionCode": str(runtime.FIXED42_TARGET_CODE),
        "targetTag": "android-v2.3.59",
        "targetApkName": "YAWF.Stream_Android_2.3.59.apk",
        "targetSha256": runtime.FIXED42_TARGET_SHA256,
        "targetSize": str(runtime.FIXED42_TARGET_SIZE),
        "signerSha256": runtime.SIGNER_PIN,
        "targetSourceRevision": runtime.FIXED42_TARGET_SOURCE,
        "targetManifestSha256": runtime.FIXED42_TARGET_MANIFEST_SHA256,
        "targetVerificationSha256": runtime.FIXED42_TARGET_VERIFICATION_SHA256,
        "targetBuildRun": str(runtime.FIXED42_TARGET_BUILD_RUN),
        "updaterSourceSha256": runtime.FIXED42_UPDATER_SHA256,
        "targetPublicRelease": "true",
    }


def load_binding(value: dict[str, str] | None = None):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "binding.json"
        path.write_text(json.dumps(exact_binding_value() if value is None else value))
        return runtime.load_automatic_binding(path)


def exact_receipt() -> dict[str, object]:
    return {
        "outcome": "passed",
        "persistentUiAutomationSession": True,
        "productPackage": runtime.PRODUCT_PACKAGE,
        "baselineVersion": runtime.FIXED42_BASELINE_VERSION,
        "targetVersion": runtime.FIXED42_TARGET_VERSION,
        "targetVersionCode": runtime.FIXED42_TARGET_CODE,
        "targetSha256": runtime.FIXED42_TARGET_SHA256,
        "targetSize": runtime.FIXED42_TARGET_SIZE,
        "targetIdentityAdmitted": True,
        "productPermissionPageObserved": True,
        "permissionEnabledByTest": True,
        "installerSuccessObserved": True,
        "installerOpenObserved": True,
        "updatedProductObserved": True,
        "permissionCleanupObserved": True,
        "permissionBackReturnObserved": True,
        "otaMode": runtime.FIXED42_AUTOMATIC_OTA_PROFILE,
        "runtimeProfile": runtime.FIXED42_AUTOMATIC_OTA_PROFILE,
        "legacyManualReconsentUsed": False,
        "baselineSourceRevision": runtime.FIXED42_BASELINE_SOURCE,
        "baselineManifestSha256": runtime.FIXED42_BASELINE_MANIFEST_SHA256,
        "baselineVerificationSha256": runtime.FIXED42_BASELINE_VERIFICATION_SHA256,
        "baselineBuildRun": runtime.FIXED42_BASELINE_BUILD_RUN,
        "targetSourceRevision": runtime.FIXED42_TARGET_SOURCE,
        "targetManifestSha256": runtime.FIXED42_TARGET_MANIFEST_SHA256,
        "targetVerificationSha256": runtime.FIXED42_TARGET_VERIFICATION_SHA256,
        "targetBuildRun": runtime.FIXED42_TARGET_BUILD_RUN,
        "updaterSourceSha256": runtime.FIXED42_UPDATER_SHA256,
        "initialManualProgressObserved": False,
        "initialManualCancelWon": False,
        "initialEnableCheckingTitleObserved": True,
        "initialEnableCheckingMessageObserved": True,
        "initialEnableCancelObserved": True,
        "initialEnableTerminalResultExcludedBeforeCancel": True,
        "initialEnableCancelSelections": 1,
        "initialEnableCancelWon": True,
        "initialEnableSettledResultExclusionSamples": 3,
        "preOfferManualDiscoveries": 0,
        "automaticOfferAbsentSameForeground": True,
        "deferredAutomaticOfferObserved": True,
        "weeklyOnAtDeferredOffer": True,
        "automaticDiscoveryObserved": True,
        "weeklyElapsedSchedulingProven": False,
        "productUpdateSelections": 1,
        "productInstallSelections": 1,
        "systemUpdateSelections": 1,
        "systemOpenSelections": 1,
        "automaticTriggerReturnOrdinal": 1,
        "deferredOfferReturnOrdinal": 2,
        "automaticOfferOrdinal": 2,
        "postInstallInspectionOrdinal": 3,
        "postInstallManualInspectionChecks": 1,
        "postInstallExactUpToDate59Observed": True,
        "weeklyOnAfterUpdate": True,
        "postInstallNativeOkClosures": 1,
        "postInstallNativeCancelClosures": 0,
        "automaticDiscoveryProofIncludesPostInstallInspection": False,
        "sampleCatalogFixtureUsed": True,
        "liveCatalogProviderProof": False,
        "profileNameMarker": "Fixed42OTA59Marker",
        "profileNameInitialDistinct": True,
        "profileNameSetTextActions": 1,
        "profileNameImmediateExact": True,
        "profileNameCloseReopenExact": True,
        "profileNamePostInstallSetTextActions": 0,
        "profilePersistedWarm": True,
        "appearancePersistedWarm": True,
        "watchlistPersistedWarm": True,
        "folderPersistedWarm": True,
        "visibleTaskDismissalObserved": True,
        "visibleTaskDismissalSwipes": 1,
        "independentColdProcessProof": False,
        "profilePersistedAfterTaskRelaunch": True,
        "appearancePersistedAfterTaskRelaunch": True,
        "watchlistPersistedAfterTaskRelaunch": True,
        "folderPersistedAfterTaskRelaunch": True,
        "permissionCleanupToggleSelections": 1,
        "captures": 35,
        "failure": None,
    }


class Fixed42HostTests(unittest.TestCase):
    def write_device_capture_gate_fixture(
        self,
        root: Path,
        *,
        return_code: int | None = 0,
        timed_out: bool = False,
        dispatched: bool = True,
        stdout: str = "device\n",
        receipt_override: dict[str, object] | None = None,
        write_receipt: bool = True,
        report_text: str | None = None,
    ) -> None:
        root.mkdir(parents=True, exist_ok=True)
        retained, receipt = runtime.bounded_diagnostic_retention(stdout)
        if receipt_override is not None:
            receipt.update(receipt_override)
        (root / "workflow-adb-get-state-stdout.txt").write_text(retained)
        if write_receipt:
            (root / "workflow-adb-get-state-stdout-retention.json").write_text(
                json.dumps(receipt)
            )
        report = {
            "profile": runtime.FIXED42_AUTOMATIC_OTA_PROFILE,
            "adb": {"getState": {
                "returnCode": return_code,
                "timedOut": timed_out,
                "dispatched": dispatched,
                "stdoutRetention": receipt,
            }},
        }
        (root / "workflow-host-diagnostics.json").write_text(
            json.dumps(report) if report_text is None else report_text
        )

    def test_device_capture_gate_allows_only_completed_exact_device_observation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_device_capture_gate_fixture(root)
            self.assertTrue(runtime.fixed42_device_capture_available(root))

    def test_device_capture_gate_rejects_rc_timeout_and_undispatched_device_text(self) -> None:
        for name, override in (
            ("rc1", {"return_code": 1}),
            ("timeout", {"return_code": 0, "timed_out": True}),
            ("undispatched", {"return_code": 0, "dispatched": False}),
        ):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.write_device_capture_gate_fixture(root, **override)
                self.assertFalse(runtime.fixed42_device_capture_available(root))

    def test_device_capture_gate_rejects_missing_truncated_or_unknown_stdout(self) -> None:
        cases = (
            {"write_receipt": False},
            {"receipt_override": {"truncated": True}},
            {"stdout": "offline\n"},
            {"report_text": "{invalid-json"},
        )
        for index, options in enumerate(cases):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.write_device_capture_gate_fixture(root, **options)
                self.assertFalse(runtime.fixed42_device_capture_available(root))

    def make_fixed42_adb(self, root: Path):
        target = root / "target59.apk"
        baseline = root / "baseline42.apk"
        harness_app = root / "harness-app.apk"
        harness_test = root / "harness-test.apk"
        target.write_bytes(b"target59-reference")
        baseline.write_bytes(b"official-baseline42-reference")
        harness_app.write_bytes(b"debug-harness-app")
        harness_test.write_bytes(b"debug-harness-test")
        with mock.patch.object(
            runtime, "FIXED42_BASELINE_SHA256", runtime.sha256_file(baseline)
        ):
            adb = runtime.AdmittedAdb(
                "adb", "emulator-5554", baseline, target,
                harness_app, harness_test, automatic_binding=load_binding(),
            )
        adb.baseline_installed = True
        return adb

    def test_failed_baseline_pull_retains_bounded_result_without_retry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            adb = self.make_fixed42_adb(root)
            destination = root / "installed-baseline.apk"
            destination.write_bytes(b"partial")
            writes: dict[str, str] = {}
            failure = runtime.subprocess.CompletedProcess(
                args=["adb"], returncode=1, stdout="29% copied\n", stderr="transport closed\n"
            )
            with mock.patch.object(runtime.subprocess, "run", return_value=failure) as execute:
                with self.assertRaisesRegex(runtime.RuntimeGateError, r"ADB command failed \(1\): pull"):
                    adb.pull_baseline_once(
                        "/data/app/random/base.apk", destination,
                        diagnostic_writer=writes.__setitem__,
                    )
                with self.assertRaisesRegex(runtime.RuntimeGateError, "scope is invalid"):
                    adb.pull_baseline_once(
                        "/data/app/random/base.apk", destination,
                        diagnostic_writer=writes.__setitem__,
                    )
            self.assertEqual(execute.call_count, 1)
            self.assertEqual([command[0] for command in adb.commands], ["pull"])
            self.assertFalse(adb.baseline_pulled)
            attempt = json.loads(writes["baseline-pull-attempt.json"])
            result = json.loads(writes["baseline-pull-result.json"])
            self.assertEqual(attempt["phase"], "before-dispatch")
            self.assertEqual(result["returnCode"], 1)
            self.assertFalse(result["timedOut"])
            self.assertEqual(result["partialDestinationBytes"], len(b"partial"))
            self.assertFalse(result["admittedForIdentityValidation"])
            self.assertEqual(writes["baseline-pull-stdout.txt"], "29% copied\n")
            self.assertEqual(writes["baseline-pull-stderr.txt"], "transport closed\n")

    def test_timed_out_baseline_pull_retains_timeout_and_blocks_retry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            adb = self.make_fixed42_adb(root)
            writes: dict[str, str] = {}
            timeout = runtime.subprocess.TimeoutExpired(
                cmd=["adb", "pull"], timeout=180, output=b"0% copied\n",
                stderr=b"device offline\n",
            )
            with mock.patch.object(runtime.subprocess, "run", side_effect=timeout) as execute:
                with self.assertRaisesRegex(runtime.RuntimeGateError, "ADB command timed out"):
                    adb.pull_baseline_once(
                        "/data/app/random/base.apk", root / "installed-baseline.apk",
                        diagnostic_writer=writes.__setitem__,
                    )
            self.assertEqual(execute.call_count, 1)
            result = json.loads(writes["baseline-pull-result.json"])
            self.assertTrue(result["timedOut"])
            self.assertIsNone(result["returnCode"])
            self.assertFalse(result["admittedForIdentityValidation"])
            self.assertIn("0% copied", writes["baseline-pull-stdout.txt"])
            self.assertIn("device offline", writes["baseline-pull-stderr.txt"])

    def test_failed_baseline_pull_bounds_and_redacts_each_stream(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            adb = self.make_fixed42_adb(root)
            writes: dict[str, str] = {}
            oversized = "A" * (runtime.MAX_HOST_EVIDENCE_BYTES + 512)
            failure = runtime.subprocess.CompletedProcess(
                args=["adb"], returncode=1,
                stdout=f"https://example.invalid/token {oversized}",
                stderr=f"https://secret.invalid/value {oversized}",
            )
            with mock.patch.object(runtime.subprocess, "run", return_value=failure):
                with self.assertRaises(runtime.RuntimeGateError):
                    adb.pull_baseline_once(
                        "/data/app/random/base.apk", root / "installed-baseline.apk",
                        diagnostic_writer=writes.__setitem__,
                    )
            for stream in ("stdout", "stderr"):
                retained = writes[f"baseline-pull-{stream}.txt"]
                receipt = json.loads(writes[f"baseline-pull-{stream}-retention.json"])
                self.assertLessEqual(len(retained.encode()), runtime.MAX_HOST_EVIDENCE_BYTES)
                self.assertTrue(receipt["truncated"])
                self.assertGreater(receipt["omittedRedactedUtf8Bytes"], 0)
                self.assertNotIn("example.invalid", retained)
                self.assertNotIn("secret.invalid", retained)

    def test_diagnostic_write_failure_does_not_replace_pull_error_or_retry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            adb = self.make_fixed42_adb(root)
            writes: dict[str, str] = {}

            def writer(name: str, value: str) -> None:
                if name == "baseline-pull-result.json":
                    raise OSError("synthetic evidence write failure")
                writes[name] = value

            failure = runtime.subprocess.CompletedProcess(
                args=["adb"], returncode=1, stdout="", stderr="pull transport failed"
            )
            with mock.patch.object(runtime.subprocess, "run", return_value=failure) as execute:
                with self.assertRaisesRegex(runtime.RuntimeGateError, r"ADB command failed \(1\): pull") as caught:
                    adb.pull_baseline_once(
                        "/data/app/random/base.apk", root / "installed-baseline.apk",
                        diagnostic_writer=writer,
                    )
            self.assertNotIn("synthetic evidence write failure", str(caught.exception))
            self.assertEqual(execute.call_count, 1)
            self.assertEqual([command[0] for command in adb.commands], ["pull"])
            self.assertFalse(adb.baseline_pulled)

    def test_host_failure_diagnostics_are_bounded_and_do_not_mutate_adb(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = root / "evidence"
            adb_path = root / "adb"
            adb_path.write_bytes(b"fake-adb")
            adb_path.chmod(0o700)
            oversized = "Z" * (runtime.MAX_HOST_EVIDENCE_BYTES + 128)
            observations = [
                runtime.subprocess.CompletedProcess(
                    args=[str(adb_path), "version"], returncode=0,
                    stdout=f"Android Debug Bridge https://example.invalid/token {oversized}",
                    stderr="",
                ),
                runtime.subprocess.CompletedProcess(
                    args=[str(adb_path), "-s", "emulator-5554", "get-state"],
                    returncode=1, stdout="", stderr="device unavailable\n",
                ),
            ]
            with mock.patch.object(runtime.subprocess, "run", side_effect=observations) as execute:
                report = runtime.collect_fixed42_host_failure_diagnostics(
                    evidence=evidence,
                    adb=str(adb_path),
                    serial="emulator-5554",
                    emulator_pid="1234",
                    emulator_pid_liveness="alive",
                    emulator_exit_status="not-exited",
                    runner_temp=root,
                    workspace=root,
                )
            self.assertEqual(execute.call_count, 2)
            commands = [call.args[0] for call in execute.call_args_list]
            self.assertEqual(commands, [
                [str(adb_path.resolve()), "version"],
                [str(adb_path.resolve()), "-s", "emulator-5554", "get-state"],
            ])
            self.assertFalse(any("pull" in command or "install" in command for command in commands))
            self.assertEqual(report["adb"]["getState"]["returnCode"], 1)
            self.assertEqual(report["ownedEmulator"]["exitStatus"], "not-exited")
            self.assertIn("availableBytes", report["filesystem"]["runnerTemp"])
            self.assertIn("availableInodes", report["filesystem"]["workspace"])
            retained = (evidence / "workflow-adb-version-stdout.txt").read_text()
            receipt = json.loads(
                (evidence / "workflow-adb-version-stdout-retention.json").read_text()
            )
            self.assertTrue(receipt["truncated"])
            self.assertNotIn("example.invalid", retained)
            self.assertLessEqual(len(retained.encode()), runtime.MAX_HOST_EVIDENCE_BYTES)

    def test_exact_binding_and_instrumentation_arguments(self) -> None:
        binding = load_binding()
        self.assertEqual(binding.profile, runtime.FIXED42_AUTOMATIC_OTA_PROFILE)
        arguments = runtime.automatic_instrumentation_arguments(binding)
        rendered = "\0".join(arguments)
        self.assertIn(f"runtimeProfile\0{runtime.FIXED42_AUTOMATIC_OTA_PROFILE}", rendered)
        self.assertIn(f"baselineSourceRevision\0{runtime.FIXED42_BASELINE_SOURCE}", rendered)
        self.assertIn(f"updaterSourceSha256\0{runtime.FIXED42_UPDATER_SHA256}", rendered)
        self.assertNotIn("public-assets/YAWF.Stream_Android_2.3.59.apk", rendered)

    def test_binding_rejects_each_arbitrary_override(self) -> None:
        mutations = {
            "profile": "automatic-initial-cancel-due-resume",
            "baselineVersion": "2.3.27",
            "baselineSourceRevision": "0" * 40,
            "targetVersion": "2.3.60",
            "targetSha256": "0" * 64,
            "updaterSourceSha256": "0" * 64,
        }
        for key, value in mutations.items():
            with self.subTest(key=key):
                binding = exact_binding_value()
                binding[key] = value
                with self.assertRaises(runtime.RuntimeGateError):
                    load_binding(binding)
        binding = exact_binding_value()
        binding["arbitraryBaselineOverride"] = "true"
        with self.assertRaises(runtime.RuntimeGateError):
            load_binding(binding)

    def test_low_level_install_inputs_reject_target_aliases_before_subprocess(self) -> None:
        for scenario in ("harness-symlink", "harness-hardlink", "baseline-symlink"):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                target = root / "target59.apk"
                baseline = root / "baseline42.apk"
                harness_app = root / "harness-app.apk"
                harness_test = root / "harness-test.apk"
                target.write_bytes(b"target59-reference")
                baseline.write_bytes(b"official-baseline42-reference")
                harness_app.write_bytes(b"debug-harness-app")
                harness_test.write_bytes(b"debug-harness-test")
                if scenario == "harness-symlink":
                    harness_app.unlink()
                    harness_app.symlink_to(target)
                elif scenario == "harness-hardlink":
                    harness_test.unlink()
                    harness_test.hardlink_to(target)
                else:
                    baseline.unlink()
                    baseline.symlink_to(target)
                with (
                    mock.patch.object(
                        runtime, "FIXED42_BASELINE_SHA256", runtime.sha256_file(baseline)
                    ),
                    mock.patch.object(runtime.subprocess, "run") as execute,
                ):
                    with self.assertRaises(runtime.RuntimeGateError):
                        runtime.AdmittedAdb(
                            "adb", "emulator-5554", baseline, target,
                            harness_app, harness_test, automatic_binding=load_binding(),
                        )
                    execute.assert_not_called()

    def test_low_level_install_inputs_reject_copied_target_bytes_before_subprocess(self) -> None:
        for target_copy in ("harness", "baseline"):
            with self.subTest(target_copy=target_copy), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                target = root / "target59.apk"
                baseline = root / "baseline42.apk"
                harness_app = root / "harness-app.apk"
                harness_test = root / "harness-test.apk"
                target.write_bytes(b"copied-target59-bytes")
                baseline.write_bytes(
                    target.read_bytes() if target_copy == "baseline" else b"official-baseline42-reference"
                )
                harness_app.write_bytes(
                    target.read_bytes() if target_copy == "harness" else b"debug-harness-app"
                )
                harness_test.write_bytes(b"debug-harness-test")
                target_digest = runtime.sha256_file(target)
                with (
                    mock.patch.object(
                        runtime, "FIXED42_BASELINE_SHA256", runtime.sha256_file(baseline)
                    ),
                    mock.patch.object(runtime, "FIXED42_TARGET_SHA256", target_digest),
                    mock.patch.object(runtime.subprocess, "run") as execute,
                ):
                    with self.assertRaises(runtime.RuntimeGateError):
                        runtime.AdmittedAdb(
                            "adb", "emulator-5554", baseline, target,
                            harness_app, harness_test, automatic_binding=load_binding(),
                        )
                    execute.assert_not_called()

    def test_low_level_install_rejects_nonofficial_baseline_before_subprocess(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target59.apk"
            baseline = root / "not-official-baseline42.apk"
            harness_app = root / "harness-app.apk"
            harness_test = root / "harness-test.apk"
            target.write_bytes(b"target59-reference")
            baseline.write_bytes(b"not-the-official-baseline42")
            harness_app.write_bytes(b"debug-harness-app")
            harness_test.write_bytes(b"debug-harness-test")
            with mock.patch.object(runtime.subprocess, "run") as execute:
                with self.assertRaises(runtime.RuntimeGateError):
                    runtime.AdmittedAdb(
                        "adb", "emulator-5554", baseline, target,
                        harness_app, harness_test, automatic_binding=load_binding(),
                    )
                execute.assert_not_called()

    def test_low_level_install_allows_distinct_harness_with_admitted_baseline_fixture(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target59.apk"
            baseline = root / "baseline42.apk"
            harness_app = root / "harness-app.apk"
            harness_test = root / "harness-test.apk"
            target.write_bytes(b"target59-reference")
            baseline.write_bytes(b"official-baseline42-reference")
            harness_app.write_bytes(b"debug-harness-app")
            harness_test.write_bytes(b"debug-harness-test")
            success = runtime.subprocess.CompletedProcess(
                args=["adb"], returncode=0, stdout="Success\n", stderr=""
            )
            with (
                mock.patch.object(
                    runtime, "FIXED42_BASELINE_SHA256", runtime.sha256_file(baseline)
                ),
                mock.patch.object(runtime.subprocess, "run", return_value=success) as execute,
            ):
                adb = runtime.AdmittedAdb(
                    "adb", "emulator-5554", baseline, target,
                    harness_app, harness_test, automatic_binding=load_binding(),
                )
                adb.install_harness(
                    runtime.sha256_file(harness_app), runtime.sha256_file(harness_test)
                )
                adb.install_baseline_once()
                self.assertEqual(execute.call_count, 3)
                dispatched = [str(argument) for call in execute.call_args_list for argument in call.args[0]]
                self.assertNotIn(str(target.resolve()), dispatched)
                self.assertIn(str(harness_app.resolve()), dispatched)
                self.assertIn(str(harness_test.resolve()), dispatched)
                self.assertIn(str(baseline.resolve()), dispatched)

    def test_exact_receipt_passes(self) -> None:
        runtime.validate_receipt(
            exact_receipt(), runtime.FIXED42_AUTOMATIC_OTA_PROFILE, load_binding()
        )

    def test_receipt_keys_are_exact_and_capture_count_is_bounded(self) -> None:
        for change in (
            lambda receipt: receipt.update({"unadmittedClaim": True}),
            lambda receipt: receipt.pop("initialManualProgressObserved"),
            lambda receipt: receipt.update({"captures": 0}),
            lambda receipt: receipt.update({"captures": 41}),
            lambda receipt: receipt.update({"captures": True}),
        ):
            receipt = exact_receipt()
            change(receipt)
            with self.assertRaises(runtime.RuntimeGateError):
                runtime.validate_receipt(
                    receipt, runtime.FIXED42_AUTOMATIC_OTA_PROFILE, load_binding()
                )

    def test_receipt_rejects_initial_enable_and_automatic_discovery_mutants(self) -> None:
        mutations = {
            "initialEnableCheckingTitleObserved": False,
            "initialEnableCheckingMessageObserved": False,
            "initialEnableCancelObserved": False,
            "initialEnableTerminalResultExcludedBeforeCancel": False,
            "initialEnableCancelSelections": 0,
            "initialEnableCancelWon": False,
            "preOfferManualDiscoveries": 1,
            "automaticOfferAbsentSameForeground": False,
            "deferredAutomaticOfferObserved": False,
            "weeklyOnAtDeferredOffer": False,
        }
        for key, value in mutations.items():
            with self.subTest(key=key):
                receipt = exact_receipt()
                receipt[key] = value
                with self.assertRaises(runtime.RuntimeGateError):
                    runtime.validate_receipt(
                        receipt, runtime.FIXED42_AUTOMATIC_OTA_PROFILE, load_binding()
                    )

    def test_receipt_rejects_postinstall_inspection_mutants(self) -> None:
        mutations = {
            "postInstallInspectionOrdinal": 1,
            "postInstallManualInspectionChecks": 0,
            "postInstallExactUpToDate59Observed": False,
            "weeklyOnAfterUpdate": False,
            "postInstallNativeOkClosures": 0,
            "postInstallNativeCancelClosures": 1,
            "automaticDiscoveryProofIncludesPostInstallInspection": True,
        }
        for key, value in mutations.items():
            with self.subTest(key=key):
                receipt = exact_receipt()
                receipt[key] = value
                with self.assertRaises(runtime.RuntimeGateError):
                    runtime.validate_receipt(
                        receipt, runtime.FIXED42_AUTOMATIC_OTA_PROFILE, load_binding()
                    )

    def test_receipt_rejects_marker_repairs_and_boolean_integer_aliases(self) -> None:
        for key, value in {
            "profileNameSetTextActions": 2,
            "profileNamePostInstallSetTextActions": 1,
            "appearancePersistedWarm": False,
            "folderPersistedAfterTaskRelaunch": False,
            "permissionEnabledByTest": 1,
        }.items():
            with self.subTest(key=key):
                receipt = exact_receipt()
                receipt[key] = value
                with self.assertRaises(runtime.RuntimeGateError):
                    runtime.validate_receipt(
                        receipt, runtime.FIXED42_AUTOMATIC_OTA_PROFILE, load_binding()
                    )


if __name__ == "__main__":
    unittest.main(verbosity=2)
