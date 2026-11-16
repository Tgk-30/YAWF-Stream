#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

import android_foreground_refusal as refusal


def block(phase: str = "selecting-480p", failure_class: str = "AssertionError", code: int = 2) -> str:
    return (
        f"INSTRUMENTATION_STATUS: {refusal.PHASE_KEY}={phase}\n"
        f"INSTRUMENTATION_STATUS: {refusal.CLASS_KEY}={failure_class}\n"
        f"INSTRUMENTATION_STATUS_CODE: {code}\n"
    )


class ParserTests(unittest.TestCase):
    def test_accepts_one_exact_public_status_block(self) -> None:
        result = refusal.parse_instrumentation("ordinary runner line\n" + block())
        self.assertEqual(
            result,
            {
                "schemaVersion": 1,
                "scope": "android-foreground-refusal-metadata",
                "fullQualification": False,
                "nativePhase": "selecting-480p",
                "nativeClass": "AssertionError",
            },
        )

    def test_accepts_fixed_unrecognized_phase_and_safe_class(self) -> None:
        result = refusal.parse_instrumentation(block("unrecognized", "OtherThrowable"))
        self.assertEqual(result["nativePhase"], "unrecognized")
        self.assertEqual(result["nativeClass"], "OtherThrowable")

    def test_missing_diagnostic_is_fixed_unavailable(self) -> None:
        self.assertEqual(refusal.parse_instrumentation("OK (1 test)\n")["code"], "unavailable")

    def test_duplicate_custom_key_is_refused(self) -> None:
        text = (
            f"INSTRUMENTATION_STATUS: {refusal.PHASE_KEY}=server-login\n"
            f"INSTRUMENTATION_STATUS: {refusal.PHASE_KEY}=source-selection\n"
            f"INSTRUMENTATION_STATUS: {refusal.CLASS_KEY}=AssertionError\n"
            "INSTRUMENTATION_STATUS_CODE: 2\n"
        )
        self.assertEqual(refusal.parse_instrumentation(text)["code"], "refused")

    def test_duplicate_status_two_blocks_are_refused(self) -> None:
        self.assertEqual(refusal.parse_instrumentation(block() + block())["code"], "refused")

    def test_extra_key_in_custom_block_is_refused(self) -> None:
        text = block().replace(
            "INSTRUMENTATION_STATUS_CODE: 2",
            "INSTRUMENTATION_STATUS: current=secret\nINSTRUMENTATION_STATUS_CODE: 2",
        )
        self.assertEqual(refusal.parse_instrumentation(text)["code"], "refused")

    def test_malformed_marker_and_unterminated_block_are_refused(self) -> None:
        malformed = "INSTRUMENTATION_STATUS malformed\n" + block()
        self.assertEqual(refusal.parse_instrumentation(malformed)["code"], "refused")
        unterminated = f"INSTRUMENTATION_STATUS: {refusal.PHASE_KEY}=server-login\n"
        self.assertEqual(refusal.parse_instrumentation(unterminated)["code"], "refused")

    def test_custom_keys_with_wrong_status_are_refused(self) -> None:
        self.assertEqual(refusal.parse_instrumentation(block(code=-2))["code"], "refused")

    def test_unknown_phase_or_unsafe_class_is_refused(self) -> None:
        self.assertEqual(refusal.parse_instrumentation(block("private-phase"))["code"], "refused")
        self.assertEqual(refusal.parse_instrumentation(block(failure_class="Bad Class"))["code"], "refused")

    def test_unrelated_secret_text_is_never_copied(self) -> None:
        secret = "authorization=do-not-copy https://private.invalid/path"
        encoded = json.dumps(refusal.parse_instrumentation(secret + "\n" + block()))
        self.assertNotIn("do-not-copy", encoded)
        self.assertNotIn("private.invalid", encoded)


class CliTests(unittest.TestCase):
    def test_cli_writes_only_safe_metadata_to_fresh_mode_600_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "instrumentation.txt"
            output = root / "refusal.json"
            source.write_text("secret raw line\n" + block(), encoding="utf-8")
            self.assertEqual(refusal.main(["--input", str(source), "--output", str(output)]), 0)
            payload = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(payload["nativePhase"], "selecting-480p")
            self.assertNotIn("secret raw line", output.read_text(encoding="utf-8"))
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_cli_writes_unavailable_and_returns_zero_when_diagnostic_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "instrumentation.txt"
            output = root / "refusal.json"
            source.write_text("OK (1 test)\n", encoding="utf-8")
            self.assertEqual(refusal.main(["--input", str(source), "--output", str(output)]), 0)
            self.assertEqual(json.loads(output.read_text())["code"], "unavailable")

    def test_cli_writes_fixed_refused_without_echoing_malformed_input(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "instrumentation.txt"
            output = root / "refusal.json"
            source.write_text("INSTRUMENTATION_STATUS malformed-secret\n" + block(), encoding="utf-8")
            self.assertEqual(refusal.main(["--input", str(source), "--output", str(output)]), 0)
            encoded = output.read_text(encoding="utf-8")
            self.assertEqual(json.loads(encoded)["code"], "refused")
            self.assertNotIn("malformed-secret", encoded)

    def test_oversize_or_symlink_input_is_rejected_without_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            oversized = root / "oversized.txt"
            oversized.write_bytes(b"x" * (refusal.MAX_INPUT_BYTES + 1))
            output = root / "oversized.json"
            with self.assertRaises(refusal.UnsafePathError):
                refusal.main(["--input", str(oversized), "--output", str(output)])
            self.assertFalse(output.exists())

            normal = root / "normal.txt"
            normal.write_text(block())
            link = root / "input-link.txt"
            link.symlink_to(normal)
            link_output = root / "link.json"
            with self.assertRaises(refusal.UnsafePathError):
                refusal.main(["--input", str(link), "--output", str(link_output)])
            self.assertFalse(link_output.exists())

    def test_existing_output_or_symlink_parent_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "instrumentation.txt"
            source.write_text(block())
            existing = root / "existing.json"
            existing.write_text("preserve")
            with self.assertRaises(refusal.UnsafePathError):
                refusal.main(["--input", str(source), "--output", str(existing)])
            self.assertEqual(existing.read_text(), "preserve")

            real_parent = root / "real-parent"
            real_parent.mkdir()
            linked_parent = root / "linked-parent"
            linked_parent.symlink_to(real_parent, target_is_directory=True)
            with self.assertRaises(refusal.UnsafePathError):
                refusal.main(["--input", str(source), "--output", str(linked_parent / "out.json")])


if __name__ == "__main__":
    unittest.main()
