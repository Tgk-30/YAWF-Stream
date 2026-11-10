#!/usr/bin/env python3
"""Local host and extracted-method controls, not Android runtime qualification."""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import importlib.util
import inspect
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HOST = Path(os.environ.get("YAWF_OFFER_HOST_UNDER_TEST", ROOT / "scripts/android_public_ota_runtime_check.py"))
JAVA = Path(os.environ.get("YAWF_OFFER_JAVA_UNDER_TEST", ROOT / "scripts/android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeOtaFlowTest.java"))
WORKFLOW = Path(os.environ.get("YAWF_OFFER_WORKFLOW_UNDER_TEST", ROOT / ".github/workflows/android-public88-to96-initial-offer.yml"))

# Public CI run 42894154678, 01-failure.xml SHA256 106ec65fc68be58b282fd48ff76e1bd5d87da2f408a59e630f44fd7074082e74.
# Only the non-PII native consent Button node is retained.
CAPTURED_ENABLE_BUTTON_XML = '''<node index="1" text="ENABLE" resource-id="android:id/button1"
 class="android.widget.Button" package="com.tgk30.debridstreamer" content-desc=""
 checkable="false" checked="false" clickable="true" enabled="true" focusable="true"
 focused="false" scrollable="false" long-clickable="false" password="false" selected="false"
 visible-to-user="true" bounds="[783,1040][978,1166]" drawing-order="4" hint="" display-id="0" />'''


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


host = module("android_public_ota_runtime_check", HOST)
admission = module("offer_admission_under_test", ROOT / "scripts/android_public88_to96_offer_admission.py")


def java_method(text, name):
    match = re.search(r"    private [^\n]*\b" + name + r"\([^\n]*\) [^{\n]*\{", text)
    assert match is not None, name
    start = text.index("{", match.start())
    depth, end = 1, start + 1
    while depth:
        depth += (text[end] == "{") - (text[end] == "}")
        end += 1
    return text[match.start():end]


def valid_receipt():
    return {
        "outcome": "passed", "persistentUiAutomationSession": True,
        "productPackage": "com.tgk30.debridstreamer",
        "runtimeProfile": "public88-to96-initial-offer-native-install-v1",
        "otaMode": "public88-to96-initial-offer-native-install-v1",
        "baselineVersion": "2.3.88",
        "baselineSourceRevision": "d045f783bbd7d91d215f713c2f3c919e72fac20b",
        "targetVersion": "2.3.96", "targetVersionCode": 2003096,
        "targetSha256": "e2b76d502b0fa10e90d47fb6158e456567be70c26421f64b106b56dd7c5fc4ef",
        "targetSize": 88710017, "targetIdentityAdmitted": True,
        "targetSourceRevision": "887ae66714d1352e66be203cd837a3de0c12f036",
        "targetManifestSha256": "535234bfa5cd195116b353ab1bf1de0035dee59bf258a819492436acccf8c7f7",
        "targetVerificationSha256": "b97e63be919300d74884dd4eb1b98dfb4fce5ce1911ec3897afebf377f588a2e",
        "targetBuildRun": 42867073313,
        "initialOfferEnableSelections": 1, "initialOfferObserved": True,
        "weeklyOnAtInitialOffer": True, "preOfferManualDiscoveries": 0,
        "productUpdateSelections": 1, "productInstallSelections": 1,
        "productPermissionPageObserved": True, "permissionEnabledByTest": True,
        "permissionBackReturnObserved": True, "legacyManualReconsentUsed": False,
        "systemUpdateSelections": 1, "systemOpenSelections": 1,
        "installerSuccessObserved": True, "installerOpenObserved": True,
        "updatedProductObserved": True, "permissionCleanupObserved": True,
        "permissionCleanupToggleSelections": 1, "cancellationProven": False,
        "dueResumeSchedulingProven": False, "dataStatePersistenceProven": False,
        "weeklyElapsedSchedulingProven": False, "independentColdProcessProof": False,
        "physicalDeviceProof": False, "captures": 9, "failure": None,
    }


class OfferHostTests(unittest.TestCase):
    def binding(self):
        return host.load_public88_to96_offer_binding(dict(host.PUBLIC88_TO96_OFFER_ADMISSION))

    def test_exact_profile_and_native_tuple_agree(self):
        binding = self.binding()
        self.assertEqual(binding.baseline_version, "2.3.88")
        self.assertEqual(binding.target_version, "2.3.96")
        self.assertNotEqual(binding.ota_mode, host.AUTOMATIC_OTA_MODE)
        text = java_method(JAVA.read_text(), "admitPublic88To96InitialOfferIdentity")
        pairs = dict(re.findall(r'\{"([A-Za-z0-9]+)", "([^"]+)"\}', text))
        for key, value in host.PUBLIC88_TO96_OFFER_ADMISSION.items():
            if key not in {"profile", "otaMode", "evidenceSubdir", "signerSha256"}:
                self.assertEqual(pairs[key], value, key)
        self.assertIn('{"runtimeProfile", PUBLIC88_TO96_OFFER_PROFILE}', text)
        self.assertIn('{"signerSha256", OtaFlowPolicy.SIGNER_SHA256}', text)

    def test_every_admission_field_is_exact_and_required(self):
        valid = dict(host.PUBLIC88_TO96_OFFER_ADMISSION)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "binding.json"
            path.write_text(json.dumps(valid))
            self.assertEqual(host.load_automatic_binding(path), self.binding())
            variants = [{**valid, "extra": "true"}]
            for key in valid:
                missing = dict(valid)
                del missing[key]
                variants.extend([missing, {**valid, key: "wrong"}, {**valid, key: 1}])
            for value in variants:
                with self.subTest(value=value):
                    path.write_text(json.dumps(value))
                    with self.assertRaises(host.RuntimeGateError):
                        host.load_automatic_binding(path)

    def test_receipt_requires_every_fact_and_rejects_overclaims(self):
        binding, valid = self.binding(), valid_receipt()
        host.validate_receipt(valid, binding.ota_mode, binding)
        for key, value in valid.items():
            missing = dict(valid)
            del missing[key]
            wrong = not value if type(value) is bool else (value + 1 if type(value) is int else "wrong")
            wrong_type = (int(value) if type(value) is bool else
                          float(value) if type(value) is int else
                          1 if type(value) is str else str(value))
            for mutant in (missing, {**valid, key: wrong}, {**valid, key: wrong_type}):
                with self.subTest(key=key, mutant=mutant.get(key)):
                    with self.assertRaises(host.RuntimeGateError):
                        host.validate_receipt(mutant, binding.ota_mode, binding)
        with self.assertRaises(host.RuntimeGateError):
            host.validate_receipt({**valid, "initialManualCancelWon": True}, binding.ota_mode, binding)

    def test_old_cancel_lane_is_not_promoted(self):
        binding = self.binding()
        for mode in (host.AUTOMATIC_OTA_MODE, host.STRICT_OTA_MODE):
            with self.assertRaises(host.RuntimeGateError):
                host.validate_receipt(valid_receipt(), mode, binding)
        with self.assertRaises(host.RuntimeGateError):
            host.validate_receipt(valid_receipt(), binding.ota_mode, host.LEGACY_BINDING)
        old = dict(host.PUBLIC88_TO96_OFFER_ADMISSION)
        old["baselineVersion"] = "2.3.27"
        with self.assertRaises(host.RuntimeGateError):
            host.load_public88_to96_offer_binding(old)

    def test_only_fresh_owned_ci_emulator_context_is_admitted(self):
        self.binding()
        env = {"CI": "true", "GITHUB_ACTIONS": "true",
               "GITHUB_REPOSITORY": "Tgk-30/YAWF-Stream", "GITHUB_ACTOR": "Tgk-30",
               "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_RUN_ID": "123",
               "GITHUB_REF": "refs/heads/qa", "YAWF_PUBLIC88_TO96_OWNED_FRESH_EMULATOR": "true"}
        host.require_public88_to96_ci_emulator("emulator-5554", env)
        for key in env:
            for replacement in ("", "wrong"):
                with self.subTest(key=key, replacement=replacement):
                    with self.assertRaises(host.RuntimeGateError):
                        host.require_public88_to96_ci_emulator("emulator-5554", {**env, key: replacement})
        for serial in ("physical-device", "emulator-5556", "", "emulator-5554\n"):
            with self.assertRaises(host.RuntimeGateError):
                host.require_public88_to96_ci_emulator(serial, env)

    def test_admission_checks_actual_inputs_before_returning_a_binding(self):
        args = argparse.Namespace(profile=host.PUBLIC88_TO96_OFFER_PROFILE)
        with patch.object(host, "validate_host_inputs") as validate:
            self.assertEqual(admission.admit(args), host.PUBLIC88_TO96_OFFER_ADMISSION)
            validate.assert_called_once_with(args, self.binding())
        with patch.object(host, "validate_host_inputs", side_effect=host.RuntimeGateError("bad bytes")):
            with self.assertRaises(host.RuntimeGateError):
                admission.admit(args)
        args.profile = host.AUTOMATIC_OTA_MODE
        with self.assertRaises(host.RuntimeGateError):
            admission.admit(args)

    def test_install_aliases_transfers_and_second_baseline_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = [Path(directory) / name for name in ("baseline", "target", "app", "test")]
            for index, path in enumerate(paths):
                path.write_bytes(f"inert-{index}".encode())
            binding = dataclasses.replace(self.binding(), baseline_sha256=host.sha256_file(paths[0]),
                                          target_sha256=host.sha256_file(paths[1]))
            def wrapper(inputs=paths):
                return host.AdmittedAdb("never-executed", "emulator-5554", *inputs,
                                        automatic_binding=binding)
            adb = wrapper()
            for index in (0, 2, 3):
                inputs = paths.copy()
                inputs[index] = paths[1]
                with self.assertRaises(host.RuntimeGateError):
                    wrapper(inputs)
                saved = paths[index].read_bytes()
                paths[index].write_bytes(paths[1].read_bytes())
                with self.assertRaises(host.RuntimeGateError):
                    wrapper()
                paths[index].write_bytes(saved)
            with patch.object(adb, "_execute", return_value=subprocess.CompletedProcess([], 0, "Success", "")) as execute:
                adb.install_harness(host.sha256_file(paths[2]), host.sha256_file(paths[3]))
                adb.install_baseline_once()
                self.assertEqual(execute.call_count, 3)
                with self.assertRaises(host.RuntimeGateError):
                    adb.install_baseline_once()
                for command in (["install", str(paths[1])], ["push", str(paths[1]), "/data/local/tmp/x"],
                                ["sync"], ["shell", "pm", "clear", host.PRODUCT_PACKAGE],
                                ["shell", "am", "start", "-a", "android.intent.action.INSTALL_PACKAGE"],
                                ["shell", "date", "-s", "20260101"]):
                    with self.assertRaises(host.RuntimeGateError):
                        adb.run(command)
                self.assertEqual(execute.call_count, 3)
                with self.assertRaises(host.RuntimeGateError):
                    adb.pull_final_once("/data/app/x/base.apk", Path(directory) / "final.apk")
                with self.assertRaises(host.RuntimeGateError):
                    adb.mark_installer_success_receipt()
                adb.automatic_instrumentation_started = True
                adb.mark_installer_success_receipt()
                adb.pull_final_once("/data/app/x/base.apk", Path(directory) / "final.apk")
                self.assertEqual(execute.call_count, 4)
                with self.assertRaises(host.RuntimeGateError):
                    adb.pull_final_once("/data/app/x/base.apk", Path(directory) / "final-again.apk")
                with self.assertRaises(host.RuntimeGateError):
                    adb.mark_installer_success_receipt()

    def test_exact_instrumentation_and_installer_receipt_gate_final_pull(self):
        binding = self.binding()
        args = host.automatic_instrumentation_arguments(binding)
        self.assertIn(host.PUBLIC88_TO96_OFFER_PROFILE, args)
        self.assertIn(binding.baseline_source, args)
        self.assertNotIn(host.AUTOMATIC_OTA_MODE, args)
        driver = inspect.getsource(host.OtaRuntimeDriver.run_instrumentation)
        self.assertLess(driver.index("validate_receipt("), driver.index("mark_installer_success_receipt("))
        final = inspect.getsource(host.OtaRuntimeDriver.verify_final)
        self.assertIn("validate_final_identity(baseline, final, self.binding)", final)
        self.assertIn("self.binding.target_sha256", final)
        baseline = host.PackageIdentity("2.3.88", 2003088, 10123, "first", "old-update")
        target = host.PackageIdentity("2.3.96", 2003096, 10123, "first", "new-update")
        host.validate_final_identity(baseline, target, binding)
        for field, value in (("uid", 10124), ("first_install_time", "changed"),
                             ("last_update_time", "old-update"), ("version_code", 2003088),
                             ("version_name", "2.3.88")):
            with self.assertRaises(host.RuntimeGateError):
                host.validate_final_identity(baseline, dataclasses.replace(target, **{field: value}), binding)

    def test_all_nine_native_capture_pairs_are_required(self):
        self.binding()
        labels = ("initial-offer-consent", "initial-public-target-offer", "initial-offer-ready",
                  "unknown-source-before", "unknown-source-after", "installer-confirm",
                  "installer-success", "initial-offer-updated-product", "automatic-permission-cleanup-off")
        names = ["actions.txt", "instrumentation-receipt.json"] + [
            f"{i:02d}-{label}.{ext}" for i, label in enumerate(labels, 1) for ext in ("png", "xml")]
        host.validate_public88_to96_evidence_names(names)
        for index in range(len(names)):
            with self.assertRaises(host.RuntimeGateError):
                host.validate_public88_to96_evidence_names(names[:index] + names[index + 1:])
        for extra in ("failure.png", names[0], "../01-initial-offer-consent.png"):
            with self.assertRaises(host.RuntimeGateError):
                host.validate_public88_to96_evidence_names(names + [extra])

    def test_legacy_native_flow_and_guard_bodies_are_unchanged(self):
        expected = {
            "isAutomaticMode": "ca8ed8fc3a4418c66695fbe1eead4b8e1846a1865c99e9f32514f910b6a62a80",
            "admitAutomaticTargetIdentity": "a3e6fefbb262b551dc2d8359a392d6616ab25cb1f865281d727efeb6db7032ef",
            "runAutomaticFlow": "529391f694148397473477da6faf4a5be704184955890a24005ec9df579a2f69",
            "cancelInitialManualCheckBeforeResult": "a7872e6ddc783769ede6026a398ab6a6284802a7f07f939a3500843c7ce57cd0",
            "enterUnknownSourcePermission": "5ad5f3ef81148c4dca66fd5e91733659d529df5c2259b7de798958778ba8f521",
            "confirmSystemInstaller": "30f967619be194a72353c1270cfb6fc8476a999cb6bc010f7ba0acf952abcfb8",
            "cleanupUnknownSourcePermissionThroughVisibleSettings": "57ef75295fbf9146bb965027eda16320082ce2b662ca92d4a703be32a2b3f45b",
            "assertNoBindingTerms": "e6cb09c7b430e7e0061b93bdc2eef33c125a4877ab9795bb9bf105c3a6ab429d",
            "click": "f7d34e8b80e13877cbc16e144bd0862befe04b99ec8e8b4aa6ab257dd2b73d14",
            "waitFor": "5553ff4278afe8cd92c4e8ecc1bb0452dc5ae473506b69d5d189e44dfb00c660",
        }
        for name, digest in expected.items():
            self.assertEqual(hashlib.sha256(java_method(JAVA.read_text(), name).encode()).hexdigest(), digest, name)

    def test_native_dispatch_and_nonclaims_remain_separate(self):
        self.binding()
        text = JAVA.read_text()
        entry = text[text.index("Throwable primary = null;"):text.index("} catch (Throwable caught)")]
        self.assertRegex(entry, r"if \(isPublic88To96OfferMode\(\)\) \{\s+runPublic88To96InitialOfferFlow\(\);\s+\} else if \(isAutomaticMode\(\)\)")
        receipt = java_method(text, "writeReceipt")
        self.assertIn("if (isAutomaticMode())", receipt)
        self.assertNotIn("isPublic88To96OfferMode", java_method(text, "isAutomaticMode"))
        self.assertNotIn("isPublic88To96OfferMode", java_method(text, "admitAutomaticTargetIdentity"))
        self.assertEqual(text.count("isAutomaticMode()"), 6)
        self.assertIn("if (isAutomaticMode() || isPublic88To96OfferMode())", text)
        appended = java_method(text, "appendPublic88To96OfferReceipt")
        self.assertIn("appendPublic88To96OfferReceipt(receipt);", receipt)
        shared = receipt[:receipt.index("if (isAutomaticMode())")]
        fields = set(re.findall(r'receipt\.put\(\s*"([^"]+)"', shared + appended)) | {"captures", "failure"}
        self.assertEqual(fields, set(valid_receipt()))
        for key in ("cancellationProven", "dueResumeSchedulingProven", "dataStatePersistenceProven",
                    "weeklyElapsedSchedulingProven", "independentColdProcessProof", "physicalDeviceProof"):
            self.assertIn(f'receipt.put("{key}", false);', appended)
            self.assertIn(f'"{key}": False', inspect.getsource(host.OtaRuntimeDriver.run))
        self.assertIn('"persistenceProof": "not-qualified"', inspect.getsource(host.OtaRuntimeDriver.run))
        flow = java_method(text, "runPublic88To96InitialOfferFlow")
        for forbidden in ("cancelInitialManualCheckBeforeResult", "runAutomaticFlow", "completeNormalSetupExact",
                          "seedMeaningfulLocalState", "returnToProductThroughVisibleLauncher", "pressBack", "pressHome"):
            self.assertTrue(forbidden not in flow, forbidden)

    def test_workflow_is_separate_fixed_and_fresh_ci_only(self):
        self.binding()
        text = WORKFLOW.read_text()
        for expected in ("inputs.profile == 'public88-to96-initial-offer-native-install-v1'",
                         "github.event_name == 'workflow_dispatch' &&",
                         "BASELINE_VERSION: 2.3.88", 'BASELINE_VERSION_CODE: "2003088"',
                         "TARGET_VERSION: 2.3.96", 'TARGET_VERSION_CODE: "2003096"',
                         'persistenceProof=not-qualified', 'cancellationProof=not-qualified',
                         'dueResumeSchedulingProof=not-qualified', 'freshOwnedEmulator=true',
                         'YAWF_PUBLIC88_TO96_OWNED_FRESH_EMULATOR=true', 'test -c /dev/kvm',
                         'adb devices |', '-no-snapshot', 'SYSTEM_IMAGE_PACKAGE: system-images;android-36;google_apis;x86_64'):
            self.assertTrue(expected in text, expected)
        for env, key in (("BASELINE_SOURCE_SHA", "baselineSourceRevision"),
                         ("BASELINE_APK_SHA256", "baselineSha256"), ("BASELINE_APK_SIZE", "baselineSize"),
                         ("TARGET_SOURCE_SHA", "targetSourceRevision"), ("TARGET_APK_SHA256", "targetSha256"),
                         ("TARGET_APK_SIZE", "targetSize"), ("TARGET_BUILD_RUN", "targetBuildRun"),
                         ("TARGET_MANIFEST_SHA256", "targetManifestSha256"),
                         ("TARGET_VERIFICATION_SHA256", "targetVerificationSha256")):
            value = re.escape(host.PUBLIC88_TO96_OFFER_ADMISSION[key])
            self.assertRegex(text, rf'(?m)^      {env}: "?{value}"?$')
        host_job = text[text.index("  bounded-host-policy:"):text.index("  public88-to96-initial-offer-api36:")]
        self.assertIn("github.event_name == 'push'", host_job)
        self.assertIn("github.ref == 'refs/heads/codex/ota88-96-offer'", host_job)
        for forbidden in ("setup-android", "sdkmanager", "emulator ", "adb ", "gradle "):
            self.assertTrue(forbidden not in host_job, forbidden)
        self.assertLess(text.index("android_public88_to96_offer_admission.py"), text.index("uses: android-actions/setup-android"))
        self.assertLess(text.index("adb devices |"), text.index("avdmanager create avd"))
        self.assertEqual(text.count("--baseline-apk"), 4)
        for forbidden in ("cancelInitialManualCheckBeforeResult", "adb install", "adb push", "adb sync",
                          "pm clear", "android.intent.action.INSTALL_PACKAGE", "inputs.target_", "date -s", "--ota-mode"):
            self.assertTrue(forbidden not in text, forbidden)


class ExtractedNativeFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        home = os.environ.get("JAVA_HOME", "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home")
        javac = str(Path(home) / "bin/javac") if (Path(home) / "bin/javac").is_file() else shutil.which("javac")
        assert javac is not None, "JDK 17 or newer is required for the local extracted-method controls"
        java = str(Path(javac).with_name("java"))
        cls.java = java
        cls.temporary = tempfile.TemporaryDirectory(prefix="ota88-offer-methods-")
        cls.directory = Path(cls.temporary.name)
        text = JAVA.read_text()
        methods = "\n".join(java_method(text, name) for name in (
            "isAutomaticMode", "isPublic88To96OfferMode", "isFixed42AutomaticMode",
            "isFixed42To59AutomaticMode", "isFixed42To61AutomaticMode", "isFixed42To74AutomaticMode",
            "launchProductFromVisibleLauncher", "admitPublic88To96InitialOfferIdentity",
            "requireInitialOfferSingle", "runPublic88To96InitialOfferFlow"))
        entry = text[text.index('        otaMode = arguments.getString("otaMode", "strict");'):
                     text.index("        Context targetContext = instrumentation.getTargetContext();")]
        methods += "\n private void exerciseActualEntryAdmission(Bundle arguments){\n" + entry + "\n  assertEquals(\"own evidence\",PUBLIC88_TO96_OFFER_EVIDENCE,subdir);\n }\n"
        native_args = dict(host.PUBLIC88_TO96_OFFER_ADMISSION)
        native_args["runtimeProfile"] = native_args.pop("profile")
        bundle = "\n".join(f"  b.put({json.dumps(key)},{json.dumps(value)});" for key, value in native_args.items())
        captured_button = "\n".join(
            f"  node.put({json.dumps(key)},{json.dumps(value)});"
            for key, value in ET.fromstring(CAPTURED_ENABLE_BUTTON_XML).attrib.items())
        probe = r'''
import java.util.*;
import java.util.regex.Pattern;
public final class OfferProbe {
 static final String PUBLIC88_TO96_OFFER_PROFILE="public88-to96-initial-offer-native-install-v1";
 static final String PUBLIC88_TO96_OFFER_EVIDENCE="public88-to96-initial-offer";
 static final String AUTOMATIC_OTA_MODE="automatic-initial-cancel-due-resume", AUTOMATIC_EVIDENCE_SUBDIR="automatic-public-ota-flow", EVIDENCE_SUBDIR="persistent-ota-flow";
 static final String FIXED42_AUTOMATIC_OTA_PROFILE="public-fixed42-to59-initial-cancel-due-resume-v1", FIXED42_TO61_AUTOMATIC_OTA_PROFILE="public-fixed42-to61-initial-cancel-due-resume-v1", FIXED42_TO74_AUTOMATIC_OTA_PROFILE="public-fixed42-to74-initial-cancel-due-resume-v1";
 static final String FIXED42_EVIDENCE_SUBDIR="fixed42-automatic-public-ota-flow", FIXED42_TO61_EVIDENCE_SUBDIR="fixed42-to61-automatic-public-ota-flow", FIXED42_TO74_EVIDENCE_SUBDIR="fixed42-to74-automatic-public-ota-flow";
 static final Pattern SAFE_SUBDIR=Pattern.compile("[A-Za-z0-9._-]{1,64}");
 static final long UI_WAIT_MS=90000, SHORT_WAIT_MS=20000, DOWNLOAD_WAIT_MS=480000;
 static String fault="";
 String otaMode=PUBLIC88_TO96_OFFER_PROFILE;
 String admittedBaselineVersion, admittedBaselineSourceRevision, admittedTargetVersion;
 String admittedTargetSha256, admittedTargetSourceRevision, admittedTargetManifestSha256, admittedTargetVerificationSha256;
 long admittedTargetVersionCode, admittedTargetSize, admittedTargetBuildRun;
 boolean targetIdentityAdmitted, initialOfferObserved, weeklyOnAtInitialOffer;
 boolean legacyManualReconsentUsed, updatedProductObserved;
 int initialOfferEnableSelections, preOfferManualDiscoveries, productUpdateSelections, productInstallSelections;
 final List<String> actions=new ArrayList<>();
 final UiDevice device=new UiDevice();
 static final class OtaFlowPolicy {
  static final String PRODUCT_PACKAGE="com.tgk30.debridstreamer", UPDATE="Update", INSTALL="Install";
  static final String SIGNER_SHA256="233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a";
  static final String BASELINE_VERSION="2.3.25", TARGET_VERSION="2.3.26", TARGET_SHA256="legacy";
  static final long TARGET_VERSION_CODE=2003026, TARGET_SIZE=1;
  static boolean matchesVersionPins(Object... ignored){return false;}
 }
 static class Bundle extends HashMap<String,String> { String getString(String key,String fallback){return getOrDefault(key,fallback);} }
 static final class BySelector {
  String text, resource, packageName, className;
  Boolean clickable, enabled;
  BySelector(String s){text=s;}
  BySelector pkg(String s){packageName=s;return this;} BySelector clazz(String s){className=s;return this;}
  BySelector text(String s){text=s;return this;}
  BySelector clickable(boolean b){clickable=b;return this;} BySelector enabled(boolean b){enabled=b;return this;}
  boolean matches(Map<String,String> node){
   return (text==null||text.equals(node.get("text")))
    &&(resource==null||resource.equals(node.get("resource-id")))
    &&(packageName==null||packageName.equals(node.get("package")))
    &&(className==null||className.equals(node.get("class")))
    &&(clickable==null||clickable.toString().equals(node.get("clickable")))
    &&(enabled==null||enabled.toString().equals(node.get("enabled")));
  }
 }
 static final class By {
  static BySelector res(String a,String b){BySelector s=new BySelector(null);s.resource=a+":id/"+b;return s;}
  static BySelector text(String s){return new BySelector(s);}
  static BySelector pkg(String s){return new BySelector(s);}
 }
 static Map<String,String> capturedEnableNode(){
  Map<String,String> node=new HashMap<>();
'''+captured_button+r'''
  if(fault.equals("enable-foreign"))node.put("package","foreign.package");
  if(fault.equals("enable-disabled"))node.put("enabled","false");
  if(fault.equals("enable-wrong-label"))node.put("text","ENABLE NOW");
  if(fault.equals("enable-wrong-prefix"))node.put("text","XENABLE");
  if(fault.equals("enable-titlecase"))node.put("text","Enable");
  if(fault.equals("enable-wrong-resource"))node.put("resource-id","android:id/button2");
  if(fault.equals("enable-wrong-class"))node.put("class","android.widget.TextView");
  if(fault.equals("enable-nonclickable"))node.put("clickable","false");
  if(fault.equals("enable-missing-label"))node.remove("text");
  return node;
 }
 static final class UiObject2 { boolean isChecked(){return !fault.equals("weekly-off");} }
 static final class UiDevice {
  void wakeUp(){}
  String getCurrentPackageName(){return fault.equals("foreign")?"foreign.package":OtaFlowPolicy.PRODUCT_PACKAGE;}
  List<UiObject2> findObjects(BySelector selector){
   if(fault.equals("missing"))return List.of();
   if(selector.resource!=null){
    Map<String,String> node=capturedEnableNode();
    List<UiObject2> matches=new ArrayList<>();
    if(selector.matches(node)){
     matches.add(new UiObject2());
     if(fault.equals("enable-duplicate"))matches.add(new UiObject2());
    }
    System.out.println("CAPTURED_ENABLE_MATCH_COUNT="+matches.size());
    return matches;
   }
   return fault.equals("duplicate")?List.of(new UiObject2(),new UiObject2()):List.of(new UiObject2());
  }
 }
 static void assertTrue(String label,boolean condition){if(!condition)throw new AssertionError(label);}
 static void assertFalse(String label,boolean condition){assertTrue(label,!condition);}
 static void assertEquals(String label,Object a,Object b){assertTrue(label,Objects.equals(a,b));}
 static long parseLongArgument(Bundle b,String key){return Long.parseLong(b.getString(key,""));}
 void assertNoBindingTerms(){assertTrue("terms",!fault.equals("binding-terms"));}
 void admitAutomaticTargetIdentity(Bundle b){throw new AssertionError("old automatic admission must not run");}
 void launchFixed42ProductFromVisibleLauncher(String phase){throw new AssertionError("old fixed42 launcher must not run");}
 void launchVisibleAppFromLauncher(String label,String pkg,String phase){assertEquals("launcher product package",OtaFlowPolicy.PRODUCT_PACKAGE,pkg);assertEquals("launcher product label","YAWF Stream",label);actions.add("launch");}
 BySelector nativeDialogText(String text){return By.text(text);}
 BySelector nativeProductButton(String text){return By.text(text);}
 UiObject2 waitFor(BySelector selector,long timeout,String label){
  assertTrue("no transient progress dependency",!selector.text.equals("Checking for updates")&&!selector.text.equals("Downloading update"));
  if(fault.equals("no-offer")&&label.equals("exact initial public target offer"))throw new AssertionError("offer timeout");
  if(selector.text.equals("Update ready to install"))assertTrue("ready only after Update",actions.contains("click:Update"));
  if(selector.text.equals(OtaFlowPolicy.PRODUCT_PACKAGE))assertTrue("open only after installer",actions.contains("installer"));
  return new UiObject2();
 }
 void capture(String label){actions.add("capture:"+label);}
 void click(BySelector selector,String label,long timeout,boolean enabled){actions.add("click:"+selector.text);}
 void enterUnknownSourcePermission(){assertTrue("permission only after Install",actions.contains("click:Install"));actions.add("permission");}
 void confirmSystemInstaller(){assertTrue("installer only after permission",actions.contains("permission"));actions.add("installer");}
'''+methods+r'''
 public static void main(String[] args)throws Exception {
  fault=args[0]; OfferProbe p=new OfferProbe();
  Bundle b=new Bundle();
'''+bundle+r'''
  if(fault.startsWith("bad-identity:"))b.put(fault.substring("bad-identity:".length()),"wrong");
  p.exerciseActualEntryAdmission(b);
  assertFalse("new profile is not the old automatic mode",p.isAutomaticMode());
  assertEquals("admitted baseline","2.3.88",p.admittedBaselineVersion);
  assertEquals("admitted baseline source","d045f783bbd7d91d215f713c2f3c919e72fac20b",p.admittedBaselineSourceRevision);
  assertEquals("admitted target","2.3.96",p.admittedTargetVersion);
  assertEquals("admitted code",2003096L,p.admittedTargetVersionCode);
  assertEquals("admitted size",88710017L,p.admittedTargetSize);
  assertEquals("admitted digest","e2b76d502b0fa10e90d47fb6158e456567be70c26421f64b106b56dd7c5fc4ef",p.admittedTargetSha256);
  assertEquals("admitted source","887ae66714d1352e66be203cd837a3de0c12f036",p.admittedTargetSourceRevision);
  assertEquals("admitted manifest","535234bfa5cd195116b353ab1bf1de0035dee59bf258a819492436acccf8c7f7",p.admittedTargetManifestSha256);
  assertEquals("admitted verification","b97e63be919300d74884dd4eb1b98dfb4fce5ce1911ec3897afebf377f588a2e",p.admittedTargetVerificationSha256);
  assertEquals("admitted build",42867073313L,p.admittedTargetBuildRun);
  if(fault.equals("unadmitted"))p.targetIdentityAdmitted=false;
  if(fault.equals("wrong-profile"))p.otaMode="automatic-initial-cancel-due-resume";
  if(fault.equals("repeat-enable"))p.initialOfferEnableSelections=1;
  if(fault.equals("repeat-update"))p.productUpdateSelections=1;
  if(fault.equals("repeat-install"))p.productInstallSelections=1;
  try {p.runPublic88To96InitialOfferFlow();}
  catch(AssertionError failure){
   List<String> rejectedClicks=new ArrayList<>();for(String a:p.actions)if(a.startsWith("click:"))rejectedClicks.add(a);
   System.err.println("REJECTED_CLICKS="+rejectedClicks);throw failure;
  }
  assertTrue("offer observed",p.initialOfferObserved&&p.weeklyOnAtInitialOffer&&p.updatedProductObserved);
  assertEquals("Enable exactly once",1,p.initialOfferEnableSelections);
  assertEquals("Update exactly once",1,p.productUpdateSelections);
  assertEquals("Install exactly once",1,p.productInstallSelections);
  List<String> clicks=new ArrayList<>();for(String a:p.actions)if(a.startsWith("click:"))clicks.add(a);
  assertEquals("ordinary product sequence",List.of("click:ENABLE","click:Update","click:Install"),clicks);
  System.out.println("PASS initial-offer sequence without transient progress");
 }
}
'''
        source = cls.directory / "OfferProbe.java"
        source.write_text(probe)
        result = subprocess.run([javac, "-d", str(cls.directory), str(source)], capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise AssertionError(result.stdout + result.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def run_probe(self, fault):
        return subprocess.run([self.java, "-cp", str(self.directory), "OfferProbe", fault],
                              capture_output=True, text=True, timeout=10)

    def test_exact_native_flow_accepts_offer_without_transient_checking(self):
        result = self.run_probe("valid")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PASS initial-offer sequence", result.stdout)

    def test_captured_public88_enable_xml_matches_actual_new_selector(self):
        node = ET.fromstring(CAPTURED_ENABLE_BUTTON_XML)
        self.assertEqual(node.get("text"), "ENABLE")
        self.assertEqual(node.get("resource-id"), "android:id/button1")
        result = self.run_probe("valid")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("CAPTURED_ENABLE_MATCH_COUNT=1", result.stdout)

    def test_captured_enable_selector_refuses_invalid_exact_nodes_before_input(self):
        self.assertEqual(self.run_probe("valid").returncode, 0)
        for fault in ("enable-foreign", "enable-disabled", "enable-duplicate", "enable-wrong-label",
                      "enable-wrong-prefix", "enable-titlecase", "enable-wrong-resource",
                      "enable-wrong-class", "enable-nonclickable", "enable-missing-label"):
            with self.subTest(fault=fault):
                result = self.run_probe(fault)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("AssertionError", result.stderr)
                self.assertIn("REJECTED_CLICKS=[]", result.stderr)
                self.assertIn("CAPTURED_ENABLE_MATCH_COUNT=" + ("2" if fault == "enable-duplicate" else "0"), result.stdout)

    def test_native_flow_rejects_foreign_duplicate_missing_or_unadmitted_state(self):
        self.assertEqual(self.run_probe("valid").returncode, 0)
        fields = set(host.PUBLIC88_TO96_OFFER_ADMISSION) - {"profile"} | {"runtimeProfile"}
        faults = ("foreign", "duplicate", "missing", "weekly-off", "binding-terms", "no-offer",
                  "unadmitted", "wrong-profile", "repeat-enable", "repeat-update", "repeat-install")
        for fault in (*faults, *("bad-identity:" + field for field in sorted(fields))):
            with self.subTest(fault=fault):
                result = self.run_probe(fault)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("AssertionError", result.stderr)
                if fault in {"foreign", "duplicate", "missing", "binding-terms", "unadmitted",
                             "wrong-profile", "repeat-enable"}:
                    self.assertIn("REJECTED_CLICKS=[]", result.stderr)
                elif fault in {"weekly-off", "no-offer", "repeat-update"}:
                    self.assertIn("REJECTED_CLICKS=[click:ENABLE]", result.stderr)
                elif fault == "repeat-install":
                    self.assertIn("REJECTED_CLICKS=[click:ENABLE, click:Update]", result.stderr)


if __name__ == "__main__":
    unittest.main()
