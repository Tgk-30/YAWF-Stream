"""Hosted-only unit checks for resource admission, not a playback test."""
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
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

    def test_external_large_target_is_never_opened_or_counted(self):
        with tempfile.TemporaryDirectory() as tmp:
            outside = Path(tmp).resolve()
            large = outside / "large"
            with large.open("wb") as stream:
                stream.truncate(3 * 1024 ** 3)
            link = self.root / "outside"
            link.symlink_to(outside, target_is_directory=True)
            root_info, link_info = self.root.lstat(), link.lstat()
            real_open = os.open
            with patch.object(guard.os, "open", wraps=real_open) as opened, \
                 patch.object(guard.os, "readlink", side_effect=AssertionError("target read")):
                measured = guard.measure(self.root)
            self.assertFalse(any(call.args[0] == "outside" for call in opened.call_args_list))
            self.assertEqual(measured["allocatedBytes"], (root_info.st_blocks + link_info.st_blocks) * 512)
            self.assertEqual(measured["logicalBytes"], link_info.st_size)
            self.assertEqual(measured["diagnosticLogicalBytes"], link_info.st_size)
            self.assertEqual(measured["files"], 0)
            self.assertEqual(measured["symlinkCount"], 1)

    def test_dangling_cycle_and_scratch_links_are_counted_without_traversal(self):
        dangling = self.root / "dangling"
        cycle = self.root / "cycle"
        scratch = self.root / "tmp"; scratch.mkdir()
        excluded = scratch / "excluded"
        dangling.symlink_to("no-such-target")
        cycle.symlink_to(".", target_is_directory=True)
        excluded.symlink_to("../also-missing")
        items = [self.root, scratch, dangling, cycle, excluded]
        allocated = sum(path.lstat().st_blocks * 512 for path in items)
        sizes = [path.lstat().st_size for path in (dangling, cycle, excluded)]
        with patch.object(guard.os, "readlink", side_effect=AssertionError("target read")):
            measured = guard.measure(self.root)
        self.assertEqual(measured["allocatedBytes"], allocated)
        self.assertEqual(measured["logicalBytes"], sum(sizes))
        self.assertEqual(measured["diagnosticLogicalBytes"], sum(sizes[:2]))
        self.assertEqual(measured["symlinkCount"], 3)
        self.assertEqual(measured["directories"], 2)

    def test_symlink_inode_blocks_are_added_even_on_zero_block_filesystems(self):
        link = self.root / "link"
        link.symlink_to("missing")
        root_info = self.root.lstat()
        real_stat = os.stat
        def with_allocated_link(path, *args, **kwargs):
            result = real_stat(path, *args, **kwargs)
            if path == "link":
                self.assertIs(kwargs.get("follow_symlinks"), False)
                return SimpleNamespace(st_mode=result.st_mode, st_dev=result.st_dev, st_ino=result.st_ino,
                                       st_size=result.st_size, st_blocks=17)
            return result
        with patch.object(guard.os, "stat", side_effect=with_allocated_link):
            measured = guard.measure(self.root)
        self.assertEqual(measured["allocatedBytes"], (root_info.st_blocks + 17) * 512)
        self.assertEqual(measured["symlinkCount"], 1)

    def test_hardlinked_symlink_inodes_are_allocated_only_once(self):
        link = self.root / "first"
        link.symlink_to("missing")
        alias = self.root / "second"
        try:
            os.link(link, alias, follow_symlinks=False)
        except (OSError, NotImplementedError) as error:
            self.skipTest("Hard-linking a symlink is unsupported: " + type(error).__name__)
        first, second = link.lstat(), alias.lstat()
        self.assertEqual((first.st_dev, first.st_ino), (second.st_dev, second.st_ino))
        measured = guard.measure(self.root)
        self.assertEqual(measured["allocatedBytes"], (self.root.lstat().st_blocks + first.st_blocks) * 512)
        self.assertEqual(measured["logicalBytes"], first.st_size + second.st_size)
        self.assertEqual(measured["symlinkCount"], 2)

    def test_link_entries_share_file_limit_without_relaxing_root_guard(self):
        link = self.root / "link"
        link.symlink_to("missing")
        (self.root / "regular").write_bytes(b"a")
        with patch.object(guard, "MAX_FILES", 1):
            with self.assertRaisesRegex(guard.Refusal, "RUNTIME_FILE_COUNT_LIMIT"):
                guard.measure(self.root)
        alias = self.root / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises((OSError, guard.Refusal)):
            guard.measure(alias)

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
