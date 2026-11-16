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

    def test_diagnostic_scan_can_measure_past_old_acceptance_without_admitting_it(self):
        self.assertEqual(guard.MAX_FILES, 6000)
        self.assertEqual(guard.MEASUREMENT_ENTRIES, 24000)
        self.assertEqual(guard.MEASUREMENT_SECONDS, 60)
        (self.root / 'first').write_bytes(b'1')
        (self.root / 'second').write_bytes(b'2')
        with patch.object(guard, 'MAX_FILES', 1):
            with self.assertRaisesRegex(guard.Refusal, 'RUNTIME_FILE_COUNT_LIMIT'):
                guard.measure(self.root)
            budget = guard.CensusBudget(lambda: None)
            observed = guard.measure(self.root, census=budget)
        self.assertTrue(observed['complete'])
        self.assertEqual(observed['files'], 2)
        self.assertEqual(observed['entryCount'], 3)
        self.assertEqual(budget.entries, 3)

    def test_shared_measurement_ceiling_retains_partial_scalar_facts(self):
        (self.root / 'first').write_bytes(b'1')
        (self.root / 'second').write_bytes(b'2')
        budget = guard.CensusBudget(lambda: None, max_entries=2)
        with self.assertRaisesRegex(guard.Refusal, 'MEASUREMENT_ENTRY_LIMIT') as caught:
            guard.measure(self.root, census=budget)
        partial = caught.exception.census_partial
        self.assertFalse(partial['complete'])
        self.assertEqual(partial['entryCount'], 2)
        self.assertEqual(budget.entries, 2)
        self.assertNotIn(str(self.root), str(partial))

    def test_cooperative_callback_and_absolute_census_deadline(self):
        clock = SimpleNamespace(now=0.0)
        calls = []
        budget = guard.CensusBudget(lambda: calls.append(clock.now), clock=lambda: clock.now)
        for value in (0.1, 0.49, 0.5, 0.75, 1.0):
            clock.now = value
            budget.tick()
        self.assertEqual(calls, [0.5, 1.0])
        clock.now = 60
        with self.assertRaisesRegex(guard.Refusal, 'MEASUREMENT_60S_LIMIT'):
            budget.tick()

    def test_callback_schedule_is_anchored_to_call_start(self):
        clock = SimpleNamespace(now=0.0)
        calls = []
        def check():
            calls.append(clock.now)
            clock.now += 0.25
        budget = guard.CensusBudget(check, clock=lambda: clock.now)
        clock.now = 0.5; budget.tick()
        clock.now = 1.0; budget.tick()
        self.assertEqual(calls, [0.5, 1.0])

    def test_entry_and_time_ceilings_are_shared_across_role_scans(self):
        first = self.root / 'first-role'; first.mkdir(); (first / 'a').write_bytes(b'a')
        second = self.root / 'second-role'; second.mkdir(); (second / 'b').write_bytes(b'b')
        budget = guard.CensusBudget(lambda: None, max_entries=3)
        self.assertTrue(guard.measure(first, census=budget)['complete'])
        with self.assertRaisesRegex(guard.Refusal, 'MEASUREMENT_ENTRY_LIMIT') as caught:
            guard.measure(second, census=budget)
        self.assertEqual(caught.exception.census_partial['entryCount'], 1)
        self.assertFalse(caught.exception.census_partial['complete'])
        self.assertEqual(budget.entries, 3)
        clock = SimpleNamespace(now=0.0)
        timed = guard.CensusBudget(lambda: None, clock=lambda: clock.now)
        clock.now = 60.0
        with self.assertRaisesRegex(guard.Refusal, 'MEASUREMENT_60S_LIMIT') as timeout:
            guard.measure(first, census=timed)
        self.assertEqual(timeout.exception.census_partial['entryCount'], 0)
        self.assertFalse(timeout.exception.census_partial['complete'])

    def test_callback_refusal_keeps_partial_and_never_serializes_paths(self):
        (self.root / 'privateSentinel').write_bytes(b'x')
        clock = SimpleNamespace(now=0.0)
        def now():
            clock.now += 0.26
            return clock.now
        def refuse(): raise guard.Refusal('REMAINING_6_GIB_REQUIRED')
        budget = guard.CensusBudget(refuse, clock=now)
        with self.assertRaisesRegex(guard.Refusal, 'REMAINING_6_GIB_REQUIRED') as caught:
            guard.measure(self.root, census=budget)
        self.assertFalse(caught.exception.census_partial['complete'])
        self.assertNotIn('privateSentinel', str(caught.exception.census_partial))


if __name__ == "__main__":
    unittest.main()
