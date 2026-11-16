"""Hosted-only unit checks for resource admission, not a playback test."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "resource_guard", Path(__file__).with_name("resource_guard.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class ResourceGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()

    def test_unique_allocated_blocks_with_hard_links(self):
        original = self.root / "receipt"
        original.write_bytes(b"a" * 8192)
        os.link(original, self.root / "copy")
        measured = guard.measure(self.root)
        expected = (self.root.stat().st_blocks + original.stat().st_blocks) * 512
        self.assertEqual(measured["allocatedBytes"], expected)
        self.assertEqual(measured["files"], 2)
        self.assertEqual(measured["diagnosticLogicalBytes"], 16384)

    def test_scratch_is_allocated_but_not_retained_diagnostic(self):
        derived = self.root / "Derived"
        derived.mkdir()
        (derived / "product").write_bytes(b"d" * 4096)
        (self.root / "receipt").write_bytes(b"r" * 64)
        measured = guard.measure(self.root)
        self.assertEqual(measured["logicalBytes"], 4160)
        self.assertEqual(measured["diagnosticLogicalBytes"], 64)
        self.assertGreaterEqual(measured["allocatedBytes"], 4096)

    def test_symlink_anywhere_in_runtime_refuses(self):
        (self.root / "outside").symlink_to(self.root.parent)
        with self.assertRaisesRegex(guard.Refusal, "RUNTIME_SYMLINK_REFUSED"):
            guard.measure(self.root)

    def test_start_capacity_boundary(self):
        with patch.object(guard, "free_bytes", return_value=guard.START_FREE - 1):
            with self.assertRaisesRegex(guard.Refusal, "START_7P5_GIB_REQUIRED"):
                guard.admit_start(self.root)
        with patch.object(guard, "free_bytes", return_value=guard.START_FREE):
            guard.admit_start(self.root)

    def test_runtime_capacity_and_diagnostics_boundaries(self):
        baseline = {"allocatedBytes": 0, "diagnosticLogicalBytes": 0}
        with patch.object(guard, "free_bytes", return_value=guard.REMAINING_FREE):
            for field, limit, message in (
                ("allocatedBytes", guard.MAX_ALLOCATED, "RUNTIME_1P5_GIB_CAP"),
                ("diagnosticLogicalBytes", guard.MAX_DIAGNOSTIC, "DIAGNOSTIC_250_MIB_CAP"),
            ):
                with self.subTest(field=field):
                    safe = dict(baseline, **{field: limit - 4096})
                    with patch.object(guard, "measure", return_value=safe):
                        self.assertEqual(guard.admit_runtime(self.root), safe)
                    unsafe = dict(baseline, **{field: limit - 4095})
                    with patch.object(guard, "measure", return_value=unsafe):
                        with self.assertRaisesRegex(guard.Refusal, message):
                            guard.admit_runtime(self.root)
        with patch.object(guard, "measure", return_value=baseline), \
             patch.object(guard, "free_bytes", return_value=guard.REMAINING_FREE - 1):
            with self.assertRaisesRegex(guard.Refusal, "REMAINING_6_GIB_REQUIRED"):
                guard.admit_runtime(self.root)

    def test_nonabsolute_and_dotdot_paths_refuse(self):
        for path in ("relative", str(self.root / ".." / "other")):
            with self.subTest(path=path), self.assertRaises(guard.Refusal):
                guard.measure(path)


if __name__ == "__main__":
    unittest.main()
