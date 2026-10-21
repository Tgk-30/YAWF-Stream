#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Sequence


SOURCE = Path(__file__).with_name("android_public_ota_runtime_check.py")
TEST_SOURCE = Path(__file__)
SPEC = importlib.util.spec_from_file_location("android_public_ota_runtime_check", SOURCE)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load Android OTA runtime helper")
diag = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = diag
SPEC.loader.exec_module(diag)

MIB = 1024 * 1024
RECEIPT_KEYS = {
    "rawOriginalUtf8Bytes",
    "rawOriginalSha256",
    "redactedUtf8Bytes",
    "retainedSourceUtf8Bytes",
    "markerUtf8Bytes",
    "storedUtf8Bytes",
    "omittedRedactedUtf8Bytes",
    "truncated",
    "strategy",
}


def observed(
    stdout: str, *, returncode: int = 0, stderr: str = ""
) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        ["adb", "observation"], returncode, stdout, stderr
    )


def valid_logcat(extra: str = "") -> str:
    return (
        "--------- beginning of main\n"
        "10-20 05:11:18.054  1290  1319 I YawfTest: line\n"
        f"{extra}"
    )


def valid_dropbox(tag: str, extra: str = "") -> str:
    return (
        "Drop box contents: 53 entries\n"
        "Max entries: 1000\n"
        f"Searching for: {tag}\n\n"
        "(No entries found.)\n"
        f"{extra}"
    )


class QueuedAdb:
    def __init__(self, *results: subprocess.CompletedProcess[str]):
        self.results = list(results)
        self.commands: list[tuple[str, ...]] = []

    def run(
        self, args: Sequence[str], **_kwargs: object
    ) -> subprocess.CompletedProcess[str]:
        self.commands.append(tuple(args))
        if not self.results:
            raise AssertionError("Unexpected ADB observation")
        return self.results.pop(0)


def make_driver(evidence: Path, *results: subprocess.CompletedProcess[str]):
    driver = object.__new__(diag.OtaRuntimeDriver)
    driver.evidence = evidence
    driver.events = []
    driver.adb = QueuedAdb(*results)
    return driver


def retention_path(evidence: Path, name: str) -> Path:
    return evidence / f"{name.removesuffix('.txt')}-retention.json"


class DiagnosticsBoundedTests(unittest.TestCase):
    def assert_retention_receipt(
        self, evidence: Path, name: str, raw: str, *, truncated: bool
    ) -> dict[str, object]:
        stored_path = evidence / name
        receipt = json.loads(retention_path(evidence, name).read_text(encoding="utf-8"))
        stored_bytes = stored_path.read_bytes()
        redacted_bytes = diag.redact(raw).encode("utf-8")
        raw_bytes = raw.encode("utf-8")

        self.assertEqual(set(receipt), RECEIPT_KEYS)
        self.assertEqual(receipt["rawOriginalUtf8Bytes"], len(raw_bytes))
        self.assertEqual(
            receipt["rawOriginalSha256"], hashlib.sha256(raw_bytes).hexdigest()
        )
        self.assertEqual(receipt["redactedUtf8Bytes"], len(redacted_bytes))
        self.assertEqual(receipt["storedUtf8Bytes"], len(stored_bytes))
        self.assertEqual(
            receipt["retainedSourceUtf8Bytes"] + receipt["markerUtf8Bytes"],
            receipt["storedUtf8Bytes"],
        )
        self.assertEqual(
            receipt["retainedSourceUtf8Bytes"]
            + receipt["omittedRedactedUtf8Bytes"],
            receipt["redactedUtf8Bytes"],
        )
        self.assertEqual(receipt["truncated"], truncated)
        self.assertLessEqual(len(stored_bytes), diag.MAX_HOST_EVIDENCE_BYTES)
        stored_bytes.decode("utf-8", "strict")
        return receipt

    def test_exact_allowlist_bounds_redacted_unicode_and_records_byte_receipt(self):
        self.assertEqual(
            diag.BOUNDED_DIAGNOSTIC_STDOUT_NAMES,
            frozenset({"logcat.txt", "dropbox-anr.txt", "dropbox-crash.txt"}),
        )
        raw = (
            valid_logcat("head-🙂\nhttp://example.invalid/private\n")
            + ("🙂漢" * 310_000)
            + "\ntail-終🙂\n"
        )
        self.assertGreater(len(diag.redact(raw).encode("utf-8")), diag.MAX_HOST_EVIDENCE_BYTES)

        with tempfile.TemporaryDirectory() as temporary:
            evidence = Path(temporary)
            driver = make_driver(evidence)
            driver.record_adb_observation("logcat.txt", observed(raw))

            receipt = self.assert_retention_receipt(
                evidence, "logcat.txt", raw, truncated=True
            )
            retained = (evidence / "logcat.txt").read_text(encoding="utf-8")
            self.assertIn("--------- beginning of main", retained)
            self.assertIn("tail-終🙂", retained)
            self.assertIn(diag.DIAGNOSTIC_TRUNCATION_MARKER.strip(), retained)
            self.assertNotIn("http://example.invalid/private", retained)
            self.assertEqual(
                receipt["strategy"], "utf8-safe-head-tail-after-redaction"
            )
            self.assertGreater(receipt["omittedRedactedUtf8Bytes"], 0)
            self.assertEqual(
                (evidence / "logcat-status.txt").read_text(encoding="utf-8"),
                "returnCode=0\nstderr:\n",
            )

            small = valid_dropbox("data_app_anr")
            driver.record_adb_observation("dropbox-anr.txt", observed(small))
            small_receipt = self.assert_retention_receipt(
                evidence, "dropbox-anr.txt", small, truncated=False
            )
            self.assertEqual(small_receipt["strategy"], "full-redacted-utf8")
            self.assertEqual(small_receipt["markerUtf8Bytes"], 0)
            self.assertEqual(small_receipt["omittedRedactedUtf8Bytes"], 0)

    def test_short_url_expansion_is_bounded_after_redaction(self):
        limit = 1024
        prefix = valid_logcat()
        token = "http://x "
        count = (limit - len(prefix.encode("utf-8"))) // len(token.encode("utf-8"))
        raw = prefix + token * count
        retained, receipt = diag.bounded_diagnostic_retention(raw, limit=limit)
        self.assertLessEqual(len(raw.encode("utf-8")), limit)
        self.assertGreater(len(diag.redact(raw).encode("utf-8")), limit)
        self.assertLessEqual(len(retained.encode("utf-8")), limit)
        self.assertTrue(receipt["truncated"])
        self.assertEqual(receipt["storedUtf8Bytes"], len(retained.encode("utf-8")))
        self.assertGreater(
            receipt["redactedUtf8Bytes"], receipt["rawOriginalUtf8Bytes"]
        )

    def test_unknown_observations_and_status_remain_strict(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / "evidence"
            evidence.mkdir()
            driver = make_driver(evidence)
            driver.record_adb_observation(
                "update-files.txt", observed("small http://x\n")
            )
            self.assertEqual(
                (evidence / "update-files.txt").read_text(encoding="utf-8"),
                "small <redacted-url>\n",
            )
            self.assertFalse(retention_path(evidence, "update-files.txt").exists())

            with self.assertRaisesRegex(diag.RuntimeGateError, "Unsafe host evidence write"):
                driver.record_adb_observation(
                    "update-files.txt",
                    observed("x" * (diag.MAX_HOST_EVIDENCE_BYTES + 1)),
                )
            self.assertFalse(retention_path(evidence, "update-files.txt").exists())

            with self.assertRaisesRegex(diag.RuntimeGateError, "Unsafe host evidence write"):
                driver.record_adb_observation("../logcat.txt", observed(valid_logcat()))
            self.assertFalse((root / "logcat.txt").exists())

        with tempfile.TemporaryDirectory() as temporary:
            evidence = Path(temporary)
            driver = make_driver(evidence)
            with self.assertRaisesRegex(diag.RuntimeGateError, "Unsafe host evidence write"):
                driver.record_adb_observation(
                    "logcat.txt",
                    observed(
                        valid_logcat(),
                        stderr="e" * (diag.MAX_HOST_EVIDENCE_BYTES + 1),
                    ),
                )
            self.assertTrue((evidence / "logcat.txt").is_file())
            self.assertTrue(retention_path(evidence, "logcat.txt").is_file())
            self.assertFalse((evidence / "logcat-status.txt").exists())

    def test_collect_diagnostics_scans_full_unretained_stdout(self):
        filler = "x" * (MIB + 64 * 1024)
        danger_by_channel = {
            "logcat": (
                valid_logcat(filler + "\nANR in " + diag.PRODUCT_PACKAGE + "\n" + filler),
                "ANR in " + diag.PRODUCT_PACKAGE,
                "logcat.txt",
            ),
            "anr": (
                valid_dropbox(
                    "data_app_anr",
                    filler
                    + "\nProcess: "
                    + diag.PRODUCT_PACKAGE
                    + ", PID: 7\n"
                    + filler,
                ),
                "Process: " + diag.PRODUCT_PACKAGE + ", PID: 7",
                "dropbox-anr.txt",
            ),
            "crash": (
                valid_dropbox(
                    "data_app_crash",
                    filler
                    + "\nProcess: "
                    + diag.PRODUCT_PACKAGE
                    + ", PID: 8\n"
                    + filler,
                ),
                "Process: " + diag.PRODUCT_PACKAGE + ", PID: 8",
                "dropbox-crash.txt",
            ),
        }
        clean = {
            "logcat": valid_logcat(),
            "anr": valid_dropbox("data_app_anr"),
            "crash": valid_dropbox("data_app_crash"),
        }

        for channel, (dangerous, marker, evidence_name) in danger_by_channel.items():
            with self.subTest(channel=channel), tempfile.TemporaryDirectory() as temporary:
                before, separator, after = dangerous.partition(marker)
                self.assertEqual(separator, marker)
                self.assertGreater(len(before.encode("utf-8")), MIB)
                self.assertGreater(len(after.encode("utf-8")), MIB)
                outputs = dict(clean)
                outputs[channel] = dangerous
                driver = make_driver(
                    Path(temporary),
                    observed(outputs["logcat"]),
                    observed(outputs["anr"]),
                    observed(outputs["crash"]),
                )
                with self.assertRaisesRegex(
                    diag.RuntimeGateError, "Product ANR/crash evidence was retained"
                ):
                    driver.collect_diagnostics()
                self.assertEqual(driver.adb.results, [])
                retained = (Path(temporary) / evidence_name).read_text(encoding="utf-8")
                self.assertNotIn(marker, retained)
                receipt = self.assert_retention_receipt(
                    Path(temporary), evidence_name, dangerous, truncated=True
                )
                self.assertGreater(receipt["omittedRedactedUtf8Bytes"], 0)

    def test_collect_diagnostics_rejects_nonzero_empty_stderr_and_missing_markers(self):
        cases = {
            "nonzero-logcat": [
                observed(valid_logcat(), returncode=1),
            ],
            "empty-logcat": [observed("")],
            "stderr-logcat": [observed(valid_logcat(), stderr="unavailable")],
            "missing-logcat-marker": [observed("not structured logcat\n")],
            "missing-anr-marker": [
                observed(valid_logcat()),
                observed("(No entries found.)\n"),
            ],
            "missing-crash-marker": [
                observed(valid_logcat()),
                observed(valid_dropbox("data_app_anr")),
                observed("(No entries found.)\n"),
            ],
        }
        for name, results in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                driver = make_driver(Path(temporary), *results)
                with self.assertRaises(diag.RuntimeGateError):
                    driver.collect_diagnostics()
                self.assertTrue((Path(temporary) / "logcat.txt").is_file())
                self.assertTrue(retention_path(Path(temporary), "logcat.txt").is_file())

    def test_raw_scan_assignment_mutants_are_rejected(self):
        source = SOURCE.read_text(encoding="utf-8")
        target_test = (
            "DiagnosticsBoundedTests."
            "test_collect_diagnostics_scans_full_unretained_stdout"
        )
        baseline = subprocess.run(
            [sys.executable, str(TEST_SOURCE), target_test],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(
            baseline.returncode,
            0,
            f"baseline subprocess failed:\n{baseline.stdout}\n{baseline.stderr}",
        )
        mutations = {
            "logcat": (
                "        logcat = logcat_result.stdout",
                '        logcat = (self.evidence / "logcat.txt").read_text(encoding="utf-8")',
            ),
            "anr": (
                "        anr = anr_result.stdout",
                '        anr = (self.evidence / "dropbox-anr.txt").read_text(encoding="utf-8")',
            ),
            "crash": (
                "        crash = crash_result.stdout",
                '        crash = (self.evidence / "dropbox-crash.txt").read_text(encoding="utf-8")',
            ),
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, (before, after) in mutations.items():
                with self.subTest(mutant=name):
                    self.assertEqual(source.count(before), 1)
                    mutant = root / name
                    mutant.mkdir()
                    (mutant / SOURCE.name).write_text(
                        source.replace(before, after), encoding="utf-8"
                    )
                    shutil.copy2(TEST_SOURCE, mutant / TEST_SOURCE.name)
                    result = subprocess.run(
                        [sys.executable, str(mutant / TEST_SOURCE.name), target_test],
                        capture_output=True,
                        text=True,
                        timeout=30,
                        check=False,
                    )
                    self.assertNotEqual(
                        result.returncode,
                        0,
                        f"{name} retained-output scan mutant survived",
                    )


if __name__ == "__main__":
    unittest.main(verbosity=2)
