#!/usr/bin/env python3
"""Synthetic, local-only logic tests for the future public automatic OTA host gate.

No tuple in this file claims that a future official public release exists. The APK
files are inert local byte fixtures and are never installed or sent to ADB.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

HOST_PATH = Path(__file__).with_name("android_public_ota_runtime_check.py")
SPEC = importlib.util.spec_from_file_location("automatic_ota_host_under_test", HOST_PATH)
assert SPEC is not None and SPEC.loader is not None
host = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = host
SPEC.loader.exec_module(host)

SYNTHETIC_VERSION = "90.1.2"
SYNTHETIC_CODE = 90_001_002
SYNTHETIC_SOURCE = "a" * 40
SYNTHETIC_RUN = 9_000_012


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def synthetic_binding(baseline_bytes: bytes, target_bytes: bytes) -> host.RuntimeBinding:
    manifest_sha = "c" * 64
    verification_sha = "d" * 64
    return host.RuntimeBinding(
        automatic=True,
        ota_mode=host.AUTOMATIC_OTA_MODE,
        evidence_subdir="automatic-public-ota-flow",
        baseline_version="80.0.1",
        baseline_code=80_000_001,
        baseline_sha256=digest(baseline_bytes),
        baseline_size=len(baseline_bytes),
        baseline_source="8" * 40,
        baseline_tag="android-v80.0.1",
        baseline_apk_name="YAWF.Stream_Android_80.0.1.apk",
        target_version=SYNTHETIC_VERSION,
        target_code=SYNTHETIC_CODE,
        target_sha256=digest(target_bytes),
        target_size=len(target_bytes),
        target_source=SYNTHETIC_SOURCE,
        target_build_run=SYNTHETIC_RUN,
        target_tag=f"android-v{SYNTHETIC_VERSION}",
        target_apk_name=f"YAWF.Stream_Android_{SYNTHETIC_VERSION}.apk",
        target_verification_name=f"Android_{SYNTHETIC_VERSION}_verification.json",
        signer_pin=host.SIGNER_PIN,
        target_manifest_sha256=manifest_sha,
        target_verification_sha256=verification_sha,
    )


def automatic_admission_value() -> dict[str, str]:
    return {
        "evidenceSubdir": "automatic-public-ota-flow",
        "otaMode": host.AUTOMATIC_OTA_MODE,
        "baselineVersion": host.AUTOMATIC_BASELINE_VERSION,
        "baselineVersionCode": str(host.AUTOMATIC_BASELINE_CODE),
        "baselineSha256": host.AUTOMATIC_BASELINE_SHA256,
        "baselineSize": str(host.AUTOMATIC_BASELINE_SIZE),
        "targetVersion": SYNTHETIC_VERSION,
        "targetVersionCode": str(SYNTHETIC_CODE),
        "targetApkName": f"YAWF.Stream_Android_{SYNTHETIC_VERSION}.apk",
        "targetSha256": "b" * 64,
        "targetSize": "123",
        "signerSha256": host.SIGNER_PIN,
        "targetSourceRevision": SYNTHETIC_SOURCE,
        "targetManifestSha256": "c" * 64,
        "targetVerificationSha256": "d" * 64,
        "targetBuildRun": str(SYNTHETIC_RUN),
        "targetPublicRelease": "true",
    }


def automatic_receipt(binding: host.RuntimeBinding) -> dict[str, object]:
    return {
        "outcome": "passed",
        "persistentUiAutomationSession": True,
        "productPackage": host.PRODUCT_PACKAGE,
        "baselineVersion": binding.baseline_version,
        "targetVersion": binding.target_version,
        "targetVersionCode": binding.target_code,
        "targetSha256": binding.target_sha256,
        "targetSize": binding.target_size,
        "targetIdentityAdmitted": True,
        "productPermissionPageObserved": True,
        "permissionEnabledByTest": True,
        "installerSuccessObserved": True,
        "installerOpenObserved": True,
        "updatedProductObserved": True,
        "permissionCleanupObserved": True,
        "permissionBackReturnObserved": True,
        "otaMode": host.AUTOMATIC_OTA_MODE,
        "legacyManualReconsentUsed": False,
        "productInstallSelections": 1,
        "systemUpdateSelections": 1,
        "systemOpenSelections": 1,
        "targetSourceRevision": binding.target_source,
        "targetManifestSha256": binding.target_manifest_sha256,
        "targetVerificationSha256": binding.target_verification_sha256,
        "targetBuildRun": binding.target_build_run,
        "initialManualProgressObserved": True,
        "initialManualCancelWon": True,
        "automaticOfferAbsentSameForeground": True,
        "deferredAutomaticOfferObserved": True,
        "automaticDiscoveryObserved": True,
        "weeklyElapsedSchedulingProven": False,
        "sampleCatalogFixtureUsed": True,
        "liveCatalogProviderProof": False,
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
        "failure": None,
    }


class AutomaticHostTests(unittest.TestCase):
    def test_admission_exactly_pins_public_27_and_rejects_mutants(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "admission.json"
            valid = automatic_admission_value()
            path.write_text(json.dumps(valid))
            binding = host.load_automatic_binding(path)
            self.assertEqual(binding.baseline_source, host.AUTOMATIC_BASELINE_SOURCE)
            self.assertEqual(binding.baseline_code, 2_003_027)
            self.assertEqual(binding.target_code, SYNTHETIC_CODE)
            mutations = {
                "baseline hash": ("baselineSha256", "0" * 64),
                "baseline size": ("baselineSize", "1"),
                "target equals baseline": ("targetSha256", host.AUTOMATIC_BASELINE_SHA256),
                "target pre-31": ("targetVersionCode", "2003030"),
                "target source": ("targetSourceRevision", "private-candidate"),
                "target manifest": ("targetManifestSha256", "C" * 64),
                "target verification": ("targetVerificationSha256", "short"),
                "public state": ("targetPublicRelease", "false"),
            }
            for label, (key, value) in mutations.items():
                with self.subTest(label=label):
                    damaged = dict(valid)
                    damaged[key] = value
                    path.write_text(json.dumps(damaged))
                    with self.assertRaises(host.RuntimeGateError):
                        host.load_automatic_binding(path)
            damaged = dict(valid)
            damaged["unexpected"] = True
            path.write_text(json.dumps(damaged))
            with self.assertRaises(host.RuntimeGateError):
                host.load_automatic_binding(path)

    def make_public_fixture(self, root: Path):
        baseline_bytes = b"synthetic baseline APK bytes; never install"
        target_bytes = b"synthetic target APK bytes; never install"
        binding = synthetic_binding(baseline_bytes, target_bytes)
        baseline = root / binding.baseline_apk_name
        target = root / binding.target_apk_name
        baseline.write_bytes(baseline_bytes)
        target.write_bytes(target_bytes)
        manifest = root / "android-update.json"
        manifest.write_text(json.dumps({
            "schemaVersion": 1,
            "version": binding.target_version,
            "versionCode": binding.target_code,
            "packageName": host.PRODUCT_PACKAGE,
            "sourceRevision": binding.target_source,
            "apk": {
                "name": binding.target_apk_name,
                "sha256": binding.target_sha256,
                "size": binding.target_size,
            },
        }, sort_keys=True))
        verification = root / binding.target_verification_name
        verification.write_text(json.dumps({
            "version": binding.target_version,
            "sourceRevision": binding.target_source,
            "buildRun": binding.target_build_run,
            "apk": {
                "name": binding.target_apk_name,
                "sha256": binding.target_sha256,
                "size": binding.target_size,
            },
            "certificateSha256": binding.signer_pin,
            "checks": {"buildProvenance": {
                "workflowRun": binding.target_build_run,
                "sourceRevision": binding.target_source,
                "canonicalSignedCandidateUnchanged": True,
            }},
            "pending": [],
            "limits": ["synthetic local logic fixture only"],
        }, sort_keys=True))
        binding = dataclasses.replace(
            binding,
            target_manifest_sha256=host.sha256_file(manifest),
            target_verification_sha256=host.sha256_file(verification),
        )
        checksums = root / "SHA256SUMS"
        checksums.write_text(
            f"{binding.target_sha256}  {binding.target_apk_name}\n"
            f"{host.sha256_file(manifest)}  android-update.json\n"
            f"{host.sha256_file(verification)}  {binding.target_verification_name}\n"
        )
        pages = root / "pages"
        pages.mkdir()
        def asset(tag: str, name: str, path: Path) -> dict[str, object]:
            return {
                "name": name,
                "state": "uploaded",
                "size": path.stat().st_size,
                "digest": f"sha256:{host.sha256_file(path)}",
                "browser_download_url": (
                    f"https://github.com/Tgk-30/YAWF-Stream/releases/download/{tag}/{name}"
                ),
            }
        target_release = {
            "tag_name": binding.target_tag,
            "draft": False,
            "prerelease": False,
            "published_at": "2090-01-02T00:00:00Z",
            "target_commitish": binding.target_source,
            "assets": [
                asset(binding.target_tag, binding.target_apk_name, target),
                asset(binding.target_tag, "android-update.json", manifest),
                asset(binding.target_tag, binding.target_verification_name, verification),
                asset(binding.target_tag, "SHA256SUMS", checksums),
            ],
        }
        baseline_release = {
            "tag_name": binding.baseline_tag,
            "draft": False,
            "prerelease": False,
            "published_at": "2080-01-01T00:00:00Z",
            "target_commitish": binding.baseline_source,
            "assets": [asset(binding.baseline_tag, binding.baseline_apk_name, baseline)],
        }
        (pages / "page-1.json").write_text(json.dumps([target_release, baseline_release]))
        args = argparse.Namespace(
            baseline_apk=baseline,
            target_apk=target,
            target_manifest=manifest,
            target_verification=verification,
            target_checksums=checksums,
            release_pages=pages,
        )
        return binding, args, target_release, baseline_release

    def test_actual_local_bytes_and_public_metadata_are_bound(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binding, args, target_release, baseline_release = self.make_public_fixture(root)
            host.validate_host_inputs(args, binding)
            mutations = {
                "substituted target bytes": lambda: args.target_apk.write_bytes(b"private bytes"),
                "bad manifest bytes": lambda: args.target_manifest.write_text("{}"),
                "bad verification signer": lambda: self._mutate_json(
                    args.target_verification, "certificateSha256", "0" * 64
                ),
                "bad target release source": lambda: target_release.update(
                    target_commitish="f" * 40
                ),
                "draft target": lambda: target_release.update(draft=True),
                "bad baseline source": lambda: baseline_release.update(
                    target_commitish="7" * 40
                ),
                "bad checksums bytes": lambda: args.target_checksums.write_text("bad\n"),
            }
            for label, mutate in mutations.items():
                with self.subTest(label=label), tempfile.TemporaryDirectory() as fresh:
                    fresh_root = Path(fresh)
                    fresh_binding, fresh_args, fresh_target, fresh_baseline = self.make_public_fixture(fresh_root)
                    binding, args = fresh_binding, fresh_args
                    target_release, baseline_release = fresh_target, fresh_baseline
                    mutate()
                    (args.release_pages / "page-1.json").write_text(
                        json.dumps([target_release, baseline_release])
                    )
                    with self.assertRaises(host.RuntimeGateError):
                        host.validate_host_inputs(args, binding)

    def test_release_history_uses_canonical_numeric_page_order_through_ten(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binding, args, target_release, baseline_release = self.make_public_fixture(root)
            drafts = [
                {
                    "tag_name": f"draft-{index}",
                    "draft": True,
                    "prerelease": False,
                    "assets": [],
                }
                for index in range(179)
            ]
            (args.release_pages / "page-1.json").write_text(
                json.dumps([target_release, *drafts[:19]])
            )
            for page_number in range(2, 10):
                start = 19 + (page_number - 2) * 20
                (args.release_pages / f"page-{page_number}.json").write_text(
                    json.dumps(drafts[start:start + 20])
                )
            (args.release_pages / "page-10.json").write_text(
                json.dumps([baseline_release])
            )
            host.validate_host_inputs(args, binding)

    def test_release_history_rejects_noncanonical_gapped_and_duplicate_pages(self) -> None:
        mutations = {
            "missing page one": lambda pages: (pages / "page-1.json").rename(
                pages / "page-2.json"
            ),
            "gap": lambda pages: (pages / "page-1.json").rename(pages / "page-3.json"),
            "leading zero": lambda pages: (pages / "page-1.json").rename(
                pages / "page-01.json"
            ),
            "outside bound": lambda pages: (pages / "page-1.json").rename(
                pages / "page-11.json"
            ),
            "malformed identity": lambda pages: (pages / "page-1.json").rename(
                pages / "page-one.json"
            ),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                binding, args, *_ = self.make_public_fixture(root)
                mutate(args.release_pages)
                with self.assertRaises(host.RuntimeGateError):
                    host.validate_host_inputs(args, binding)
        with self.assertRaises(host.RuntimeGateError):
            host._ordered_release_pages([
                Path("/first/page-1.json"),
                Path("/second/page-1.json"),
            ])

    @staticmethod
    def _mutate_json(path: Path, key: str, value: object) -> None:
        data = json.loads(path.read_text())
        data[key] = value
        path.write_text(json.dumps(data))

    def test_apksigner_and_manifest_identity_cover_both_local_apks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            baseline = root / "synthetic-baseline.apk"
            target = root / "synthetic-target.apk"
            baseline_bytes = b"baseline local APK fixture"
            target_bytes = b"target local APK fixture"
            baseline.write_bytes(baseline_bytes)
            target.write_bytes(target_bytes)
            binding = synthetic_binding(baseline_bytes, target_bytes)
            tool = root / "fake_apk_tool.py"
            tool.write_text(
                "#!/usr/bin/env python3\n"
                "import os,sys\n"
                f"signer={host.SIGNER_PIN!r}\n"
                "if sys.argv[1:3] == ['verify', '--print-certs']:\n"
                " print('Signer #1 certificate SHA-256 digest: ' + "
                "('0'*64 if os.getenv('BAD_SIGNER') else signer)); raise SystemExit(0)\n"
                "field=sys.argv[2]; name=sys.argv[3]\n"
                "baseline=name.endswith('synthetic-baseline.apk')\n"
                f"values={{'application-id':{host.PRODUCT_PACKAGE!r},'version-name':"
                f"('80.0.1' if baseline else {SYNTHETIC_VERSION!r}),'version-code':"
                f"('80000001' if baseline else {str(SYNTHETIC_CODE)!r})}}\n"
                "print('wrong' if os.getenv('BAD_MANIFEST') == field else values[field])\n"
            )
            tool.chmod(tool.stat().st_mode | stat.S_IXUSR)
            host.verify_downloaded_apk_identities(baseline, target, str(tool), str(tool), binding)
            for variable in ("BAD_SIGNER", "BAD_MANIFEST"):
                with self.subTest(variable=variable):
                    os.environ[variable] = "version-code" if variable == "BAD_MANIFEST" else "1"
                    try:
                        with self.assertRaises(host.RuntimeGateError):
                            host.verify_downloaded_apk_identities(
                                baseline, target, str(tool), str(tool), binding
                            )
                    finally:
                        os.environ.pop(variable, None)

    def test_adb_budget_and_mutation_routes_fail_before_dispatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = [root / name for name in ("baseline.apk", "target.apk", "harness.apk", "test.apk")]
            for index, path in enumerate(paths):
                path.write_bytes(bytes([index + 1]))
            adb = host.AdmittedAdb("adb", "emulator-5554", *paths)
            dispatches: list[tuple[str, ...]] = []
            def success(args, **_kwargs):
                dispatches.append(tuple(args))
                return subprocess.CompletedProcess(args, 0, "Success\n", "")
            adb._execute = success
            with self.assertRaises(host.RuntimeGateError):
                adb.install_baseline_once()
            self.assertEqual(dispatches, [])
            adb.install_harness(host.sha256_file(paths[2]), host.sha256_file(paths[3]))
            adb.install_baseline_once()
            self.assertEqual(adb.harness_install_count, 2)
            self.assertEqual(adb.baseline_install_count, 1)
            with self.assertRaises(host.RuntimeGateError):
                adb.install_baseline_once()
            with self.assertRaises(host.RuntimeGateError):
                adb.install_harness(host.sha256_file(paths[2]), host.sha256_file(paths[3]))
            self.assertEqual(len(dispatches), 3)

            def forbidden_dispatch(*_args, **_kwargs):
                raise AssertionError("forbidden command reached external ADB")
            adb._execute = forbidden_dispatch
            forbidden = [
                ["install", str(paths[1])],
                ["push", "anything", "/sdcard/anything"],
                ["sync"],
                ["shell", "pm", "install", "/data/local/tmp/private.apk"],
                ["shell", "cmd", "package", "install-existing", host.PRODUCT_PACKAGE],
                ["shell", "am", "start", "-d", "content://private.apk"],
                ["shell", "settings", "put", "global", "auto_time", "0"],
                ["shell", "device_config", "put", "yawf", "feed", "private"],
                ["shell", "date", "010100002090"],
                ["shell", "setprop", "persist.yawf.feed", "private"],
                ["shell", "content", "update", "--uri", "content://settings"],
                ["shell", "am", "broadcast", "-a", "private.feed"],
                ["shell", "run-as", host.PRODUCT_PACKAGE, "cat", "shared_prefs/x.xml"],
                ["shell", "appops", "set", host.PRODUCT_PACKAGE, "REQUEST_INSTALL_PACKAGES", "allow"],
                ["shell", "pm", "grant", host.PRODUCT_PACKAGE, "android.permission.REQUEST_INSTALL_PACKAGES"],
                ["shell", "echo", "https://private.invalid/android-update.json"],
            ]
            for command in forbidden:
                with self.subTest(command=command), self.assertRaises(host.RuntimeGateError):
                    adb.run(command)

    def test_automatic_adb_exact_allowlist_and_stateful_routes_dispatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = [
                root / name
                for name in ("baseline.apk", "target.apk", "harness.apk", "test.apk")
            ]
            for index, path in enumerate(paths):
                path.write_bytes(bytes([index + 1]))
            binding = synthetic_binding(paths[0].read_bytes(), paths[1].read_bytes())
            adb = host.AdmittedAdb(
                "adb", "emulator-5554", *paths, automatic_binding=binding
            )
            dispatches: list[tuple[str, ...]] = []

            def success(args, **kwargs):
                dispatches.append(tuple(args))
                stdout = b"Success\n" if kwargs.get("text") is False else "Success\n"
                stderr = b"" if kwargs.get("text") is False else ""
                return subprocess.CompletedProcess(args, 0, stdout, stderr)

            adb._execute = success
            allowed = [
                ["shell", "pm", "path", host.PRODUCT_PACKAGE],
                ["shell", "dumpsys", "package", host.PRODUCT_PACKAGE],
                [
                    "shell", "cmd", "appops", "get", host.PRODUCT_PACKAGE,
                    "REQUEST_INSTALL_PACKAGES",
                ],
                [
                    "shell", "find",
                    f"/sdcard/Android/data/{host.PRODUCT_PACKAGE}/files/Download/updates",
                    "-maxdepth", "1", "-type", "f", "-name", "*.apk", "-print",
                ],
                ["logcat", "-d", "-v", "threadtime"],
                ["shell", "dumpsys", "dropbox", "--print", "data_app_anr"],
                ["shell", "dumpsys", "dropbox", "--print", "data_app_crash"],
            ]
            for command in allowed:
                adb.run(command)
            remote = f"files/{binding.evidence_subdir}"
            adb.exec_out("run-as", host.HARNESS_PACKAGE, "ls", "-1", remote)
            for verb, prefix in (("stat", ("-c", "%s")), ("cat", ())):
                adb.exec_out(
                    "run-as", host.HARNESS_PACKAGE, verb, *prefix,
                    f"{remote}/instrumentation-receipt.json",
                )

            adb.install_harness(host.sha256_file(paths[2]), host.sha256_file(paths[3]))
            adb.install_baseline_once()
            adb.pull_baseline_once("/data/app/public/base.apk", root / "baseline-pull.apk")
            instrumentation = host.automatic_instrumentation_arguments(binding)
            adb.run_automatic_instrumentation_once(
                instrumentation, timeout=12, check=False
            )
            adb.mark_installer_success_receipt()
            adb.pull_final_once("/data/app/public/base.apk", root / "final-pull.apk")

            for command in allowed:
                self.assertIn(tuple(command), dispatches)
            self.assertIn(tuple(instrumentation), dispatches)
            self.assertEqual(adb.harness_install_count, 2)
            self.assertEqual(adb.baseline_install_count, 1)
            self.assertTrue(adb.baseline_pulled and adb.final_pulled)

    def test_automatic_adb_wrappers_execout_and_generic_pull_fail_before_dispatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = [
                root / name
                for name in ("baseline.apk", "target.apk", "harness.apk", "test.apk")
            ]
            for path in paths:
                path.write_bytes(b"x")
            binding = synthetic_binding(b"x", b"x")
            adb = host.AdmittedAdb(
                "adb", "emulator-5554", *paths, automatic_binding=binding
            )
            dispatches: list[tuple[str, ...]] = []

            def forbidden_dispatch(args, **_kwargs):
                dispatches.append(tuple(args))
                raise AssertionError("forbidden command reached external ADB")

            adb._execute = forbidden_dispatch
            forbidden_calls = [
                lambda: adb.shell(
                    "sh", "-c",
                    f"pm grant {host.PRODUCT_PACKAGE} android.permission.REQUEST_INSTALL_PACKAGES",
                ),
                lambda: adb.shell(
                    "/system/bin/sh", "-c", "settings put global auto_time 0"
                ),
                lambda: adb.shell(
                    "/system/bin/settings", "put", "global", "auto_time", "0"
                ),
                lambda: adb.shell(
                    "env", "pm", "grant", host.PRODUCT_PACKAGE,
                    "android.permission.REQUEST_INSTALL_PACKAGES",
                ),
                lambda: adb.shell(
                    "toybox", "sh", "-c", "device_config put yawf feed private"
                ),
                lambda: adb.exec_out(
                    "run-as", host.PRODUCT_PACKAGE, "cat", "shared_prefs/update.xml"
                ),
                lambda: adb.exec_out(
                    "run-as", host.HARNESS_PACKAGE, "sh", "-c",
                    "cat ../shared_prefs/update.xml",
                ),
                lambda: adb.run(["pull", "/data/app/public/base.apk", str(root / "early.apk")]),
                lambda: adb.run(
                    ["shell", "pm", "path", host.PRODUCT_PACKAGE, "unexpected"]
                ),
                lambda: adb.run(host.automatic_instrumentation_arguments(binding)),
            ]
            for index, call in enumerate(forbidden_calls):
                with self.subTest(index=index), self.assertRaises(host.RuntimeGateError):
                    call()
            self.assertEqual(dispatches, [])

            adb.installer_success_receipt = True
            with self.assertRaises(host.RuntimeGateError):
                adb.run(["pull", "/data/app/public/base.apk", str(root / "late.apk")])
            self.assertEqual(dispatches, [])

            adb.installer_success_receipt = False
            adb.harness_install_count = 2
            adb.baseline_install_count = 1
            adb.baseline_installed = True
            adb.baseline_pulled = True
            damaged = host.automatic_instrumentation_arguments(binding)
            damaged[-1] = "other.package/androidx.test.runner.AndroidJUnitRunner"
            with self.assertRaises(host.RuntimeGateError):
                adb.run_automatic_instrumentation_once(damaged, timeout=12, check=False)
            self.assertEqual(dispatches, [])

            with self.assertRaises(host.RuntimeGateError):
                adb.pull_final_once("/data/app/public/base.apk", root / "premature-final.apk")
            self.assertEqual(dispatches, [])

    def test_final_pull_receipt_identity_and_automatic_discovery_are_fail_closed(self) -> None:
        baseline_bytes = b"b"
        target_bytes = b"t"
        binding = synthetic_binding(baseline_bytes, target_bytes)
        baseline = host.PackageIdentity("80.0.1", 80_000_001, 10123, "first", "before")
        final = host.PackageIdentity(binding.target_version, binding.target_code, 10123, "first", "after")
        host.validate_final_identity(baseline, final, binding)
        for damaged in (
            dataclasses.replace(final, uid=10124),
            dataclasses.replace(final, first_install_time="changed"),
            dataclasses.replace(final, last_update_time="before"),
            dataclasses.replace(final, version_code=binding.target_code + 1),
        ):
            with self.assertRaises(host.RuntimeGateError):
                host.validate_final_identity(baseline, damaged, binding)
        receipt = automatic_receipt(binding)
        host.validate_receipt(receipt, host.AUTOMATIC_OTA_MODE, binding)
        for key in (
            "automaticDiscoveryObserved",
            "automaticOfferAbsentSameForeground",
            "deferredAutomaticOfferObserved",
            "initialManualCancelWon",
            "targetIdentityAdmitted",
            "profilePersistedAfterTaskRelaunch",
        ):
            damaged = dict(receipt)
            damaged[key] = False
            with self.subTest(receipt_key=key), self.assertRaises(host.RuntimeGateError):
                host.validate_receipt(damaged, host.AUTOMATIC_OTA_MODE, binding)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = [root / name for name in ("baseline.apk", "target.apk", "harness.apk", "test.apk")]
            for path in paths:
                path.write_bytes(b"x")
            adb = host.AdmittedAdb("adb", "emulator-5554", *paths)
            adb.baseline_installed = True
            adb._execute = lambda *_args, **_kwargs: (_ for _ in ()).throw(
                AssertionError("premature final pull dispatched")
            )
            with self.assertRaises(host.RuntimeGateError):
                adb.pull_final_once("/base.apk", root / "final.apk")

    def test_driver_passes_full_automatic_tuple_and_marks_pull_only_after_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binding = synthetic_binding(b"b", b"t")
            binding = dataclasses.replace(
                binding, target_manifest_sha256="c" * 64,
                target_verification_sha256="d" * 64,
            )
            receipt = automatic_receipt(binding)
            driver = object.__new__(host.OtaRuntimeDriver)
            driver.binding = binding
            driver.ota_mode = host.AUTOMATIC_OTA_MODE
            driver.args = argparse.Namespace(flow_timeout=12)
            driver.evidence = root
            driver.events = []
            captured: list[str] = []
            class FakeAdb:
                marked = False
                automatic_calls = 0
                def run_automatic_instrumentation_once(self, args, **_kwargs):
                    self.automatic_calls += 1
                    captured.extend(args)
                    return subprocess.CompletedProcess(args, 0, "OK (1 test)\n", "")
                def mark_installer_success_receipt(self):
                    self.marked = True
            driver.adb = FakeAdb()
            def retrieve(self):
                destination = self.evidence / self.binding.evidence_subdir
                destination.mkdir()
                (destination / "instrumentation-receipt.json").write_text(json.dumps(receipt))
            driver.retrieve_harness_evidence = types.MethodType(retrieve, driver)
            driver.run_instrumentation()
            self.assertTrue(driver.adb.marked)
            self.assertEqual(driver.adb.automatic_calls, 1)
            joined = " ".join(captured)
            for value in (
                binding.baseline_sha256,
                binding.target_apk_name,
                binding.target_source,
                binding.target_manifest_sha256,
                binding.target_verification_sha256,
                str(binding.target_build_run),
                host.AUTOMATIC_OTA_MODE,
            ):
                self.assertIn(value, joined)
            self.assertNotIn("legacy-manual-reconsent", joined)


if __name__ == "__main__":
    unittest.main(verbosity=2)
