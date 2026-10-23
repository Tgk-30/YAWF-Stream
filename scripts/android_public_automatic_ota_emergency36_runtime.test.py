#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

HOST_PATH = Path(__file__).with_name("android_public_ota_runtime_check.py")
SPEC = importlib.util.spec_from_file_location("emergency36_runtime_under_test", HOST_PATH)
assert SPEC is not None and SPEC.loader is not None
host = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = host
SPEC.loader.exec_module(host)
FIXTURE = Path(__file__).parent.parent / "fixtures" / "public36"


class Emergency36RuntimeCompatibilityTests(unittest.TestCase):
    def load_binding(self) -> host.RuntimeBinding:
        return host.load_automatic_binding(FIXTURE / "automatic-admission-output.json")

    def test_exact_retained_public_manifest_and_verification_bytes_pass(self) -> None:
        binding = self.load_binding()
        manifest = FIXTURE / "android-update.json"
        verification = FIXTURE / "Android_2.3.36_verification.json"
        self.assertEqual(host.sha256_file(manifest), host.EMERGENCY_36_MANIFEST_SHA256)
        self.assertEqual(host.sha256_file(verification), host.EMERGENCY_36_VERIFICATION_SHA256)
        self.assertEqual(host.validate_target_manifest(manifest, binding)["version"], "2.3.36")
        receipt = host.validate_target_verification(verification, binding)
        self.assertEqual(receipt["producerRun"], host.EMERGENCY_36_PRODUCER_RUN)
        self.assertEqual(receipt["exactSourceCiRun"], host.EMERGENCY_36_SOURCE_CI_RUN)

    def test_emergency_binding_rejects_every_independently_supplied_identity_mutant(self) -> None:
        original = json.loads((FIXTURE / "automatic-admission-output.json").read_text())
        mutations = {
            "versionCode": ("targetVersionCode", "2003037"),
            "APK digest": ("targetSha256", "0" * 64),
            "APK size": ("targetSize", "88578946"),
            "source": ("targetSourceRevision", "0" * 40),
            "producer run": ("targetBuildRun", "39917780678"),
            "manifest digest": ("targetManifestSha256", "0" * 64),
            "verification digest": ("targetVerificationSha256", "0" * 64),
        }
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "binding.json"
            for label, (key, value) in mutations.items():
                with self.subTest(label=label):
                    damaged = dict(original)
                    damaged[key] = value
                    path.write_text(json.dumps(damaged))
                    with self.assertRaises(host.RuntimeGateError):
                        host.load_automatic_binding(path)

    def test_runtime_rejects_each_emergency_schema_invariant_before_hash_fallback(self) -> None:
        original = json.loads(
            (FIXTURE / "Android_2.3.36_verification.json").read_text()
        )
        binding = self.load_binding()
        mutations = {
            "schemaVersion": ("schemaVersion", 2),
            "version": ("version", "2.3.37"),
            "versionCode": ("versionCode", 2003037),
            "packageName": ("packageName", "com.example.private"),
            "sourceRevision": ("sourceRevision", "0" * 40),
            "exactSourceCiRun": ("exactSourceCiRun", 39917164435),
            "producerRun": ("producerRun", 39917780678),
            "signerSha256": ("signerSha256", "0" * 64),
            "offline signature": (
                "offlineSignatureManifestAbiPayloadAndAlignment", "pending"
            ),
            "verifiedAt": ("verifiedAt", "2026-10-23T07:55:44.000000+00:00"),
            "scope": ("scope", "different scope"),
        }
        nested_mutations = {
            "apk name": ("apk", "name", "different.apk"),
            "apk digest": ("apk", "sha256", "0" * 64),
            "apk size": ("apk", "size", 88578946),
            "native abi": ("nativeRuntime", "abi", "x86_64"),
            "native api": ("nativeRuntime", "api", 35),
            "native automatic non-claim": (
                "nativeRuntime", "automaticOtaTransactionProven", True
            ),
            "native manual updater": (
                "nativeRuntime", "completeSetupAndNativeManualUpdater", "pending"
            ),
            "native installed hash": ("nativeRuntime", "exactInstalledApkHash", "pending"),
            "native fresh emulator": ("nativeRuntime", "freshOwnedEmulator", False),
            "native passed": ("nativeRuntime", "passed", False),
            "native physical non-claim": ("nativeRuntime", "physicalDeviceProof", True),
            "native webview": ("nativeRuntime", "webviewMajor", 132),
            "episode all-platform non-claim": (
                "episodeVerification", "allPlatformVerificationComplete", True
            ),
            "episode regressions": (
                "episodeVerification", "canonicalGuideAndSourceRegressionTests", "pending"
            ),
            "episode production decode": (
                "episodeVerification", "productionServer36Tybw17E1FileDecode", "pending"
            ),
            "episode standalone non-claim": (
                "episodeVerification", "standaloneConfiguredGuideRuntime", "passed"
            ),
        }
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "verification.json"
            for label, (key, value) in mutations.items():
                with self.subTest(label=label):
                    damaged = json.loads(json.dumps(original))
                    damaged[key] = value
                    path.write_text(json.dumps(damaged))
                    with self.assertRaises(host.RuntimeGateError) as caught:
                        host.validate_target_verification(path, binding)
                    self.assertNotIn("SHA-256 mismatch", str(caught.exception))
            for label, (owner, key, value) in nested_mutations.items():
                with self.subTest(label=label):
                    damaged = json.loads(json.dumps(original))
                    damaged[owner][key] = value
                    path.write_text(json.dumps(damaged))
                    with self.assertRaises(host.RuntimeGateError) as caught:
                        host.validate_target_verification(path, binding)
                    self.assertNotIn("SHA-256 mismatch", str(caught.exception))

    def test_runtime_rejects_missing_extra_and_unrecognized_schema_keys(self) -> None:
        original = json.loads(
            (FIXTURE / "Android_2.3.36_verification.json").read_text()
        )
        binding = self.load_binding()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "verification.json"
            for key in original:
                with self.subTest(missing=key):
                    damaged = dict(original)
                    damaged.pop(key)
                    path.write_text(json.dumps(damaged))
                    with self.assertRaises(host.RuntimeGateError) as caught:
                        host.validate_target_verification(path, binding)
                    self.assertNotIn("SHA-256 mismatch", str(caught.exception))
            damaged = dict(original)
            damaged["unexpected"] = True
            path.write_text(json.dumps(damaged))
            with self.assertRaises(host.RuntimeGateError) as caught:
                host.validate_target_verification(path, binding)
            self.assertNotIn("SHA-256 mismatch", str(caught.exception))
            for owner in ("apk", "nativeRuntime", "episodeVerification"):
                with self.subTest(extra_nested=owner):
                    damaged = json.loads(json.dumps(original))
                    damaged[owner]["unexpected"] = True
                    path.write_text(json.dumps(damaged))
                    with self.assertRaises(host.RuntimeGateError) as caught:
                        host.validate_target_verification(path, binding)
                    self.assertNotIn("SHA-256 mismatch", str(caught.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
