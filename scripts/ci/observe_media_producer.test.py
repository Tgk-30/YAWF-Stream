#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


HERE = Path(__file__).resolve().parent
MODULE = HERE / "observe_media_producer.py"
SPEC = importlib.util.spec_from_file_location("media_observer", MODULE)
observer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(observer)


def row(pid=100, parent=1, group=100, start="Mon Nov 10 12:34:56 2026", command="/usr/bin/python3", state="S", elapsed="00:01", cpu="0:00.12"):
    return f"{pid} {parent} {group} {start} {elapsed} {cpu} {state} {command}\n"


class ObserverTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="media-observer-contract-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def fixture(self, body, **kwargs):
        workspace, evidence = self.root / "workspace", self.root / "evidence"
        code = "import os,sys,time,json,pathlib,subprocess,signal\n" + body
        result = observer.observe(workspace, evidence, [sys.executable, "-I", "-B", "-c", code],
                                  kwargs.pop("max_seconds", 3), sample_seconds=.025, cleanup_grace=.15, **kwargs)
        summary = json.loads((evidence / "summary.json").read_text())
        ledger = [json.loads(line) for line in (evidence / "events.jsonl").read_text().splitlines()]
        return result, summary, ledger

    def test_duration_parser(self):
        self.assertEqual(observer.duration_ms("1-02:03:04.50"), 93784500)
        self.assertEqual(observer.duration_ms("02:03"), 123000)
        with self.assertRaises(observer.ObservationError):
            observer.duration_ms("private malformed data")

    def test_parser_discards_paths_arguments_and_unknown_names(self):
        result = observer.parse_snapshot(row(command="/private/PRIVATE_MARKER/unknown-process-name"))[100]
        serialized = json.dumps(result)
        self.assertEqual(result["processClass"], "other")
        self.assertNotIn("PRIVATE_MARKER", serialized)
        self.assertNotIn("/", serialized)
        self.assertEqual(len(result["startIdentity"]), 64)

    def test_parser_fixed_process_classes(self):
        for name, expected in [("python3.11", "python"), ("node", "node"), ("codesign", "codesign"), ("otool", "otool"), ("install_name_tool", "install_name_tool")]:
            with self.subTest(name=name):
                self.assertEqual(observer.process_class("/usr/bin/" + name), expected)

    def test_canonical_capital_python_is_not_other(self):
        for name in ("Python", "Python3", "Python3.9", "Python3.9.6", "python", "python3", "python3.11.2"):
            with self.subTest(name=name):
                self.assertEqual(observer.process_class("/framework/bin/" + name), "python")

    def test_python_like_names_remain_other_without_path_leaks(self):
        for name in ("notpython", "Python-worker", "Python3.9-config", "Python.framework", "PYTHON", "python2", "python3.bad", "Python3.9suffix"):
            with self.subTest(name=name):
                parsed = observer.parse_snapshot(row(command="/PRIVATE_MARKER/" + name))[100]
                self.assertEqual(parsed["processClass"], "other")
                self.assertNotIn("PRIVATE_MARKER", json.dumps(parsed))

    def test_parser_rejects_malformed_duplicate_and_oversize(self):
        for value in ["invalid row", row() + row(), row(start="private invalid start"), row(start="Mon Nov 32 99:34:56 2026"), row(cpu="bad"), "x" * (observer.MAX_PS_BYTES + 1)]:
            with self.subTest(length=len(value)), self.assertRaises(observer.ObservationError):
                observer.parse_snapshot(value)

    def test_ancestry_excludes_unrelated_and_tracks_deltas(self):
        tracker = observer.ProcessTracker(100)
        first = observer.parse_snapshot(row() + row(101, 100, command="/usr/bin/otool") + row(200, 1, 200))
        self.assertEqual([r["pid"] for r in tracker.update(first)], [100, 101])
        second = observer.parse_snapshot(row(elapsed="00:02", cpu="0:00.25", state="R") + row(101, 1, command="/usr/bin/otool"))
        result = tracker.update(second)
        self.assertEqual(result[0]["cpuDeltaMs"], 130)
        self.assertEqual(result[0]["elapsedDeltaMs"], 1000)
        self.assertTrue(result[0]["stateChanged"])
        self.assertEqual(result[1]["pid"], 101)

    def test_pid_reuse_is_not_adopted_as_descendant(self):
        tracker = observer.ProcessTracker(100)
        tracker.update(observer.parse_snapshot(row() + row(101, 100)))
        result = tracker.update(observer.parse_snapshot(row() + row(101, 100, start="Mon Nov 10 12:35:01 2026") + row(102, 101)))
        self.assertEqual([r["pid"] for r in result], [100])
        self.assertEqual(tracker.reused, {101})

    def test_detached_descendant_is_recorded_not_same_group(self):
        tracker = observer.ProcessTracker(100)
        result = tracker.update(observer.parse_snapshot(row() + row(101, 100, 101)))
        self.assertFalse(result[1]["inOwnedGroup"])
        self.assertEqual(tracker.residuals(observer.parse_snapshot(row(101, 1, 101))), (0, 1))

    def test_unknown_orphan_is_not_guessed_from_group_number(self):
        tracker = observer.ProcessTracker(100)
        tracker.update(observer.parse_snapshot(row()))
        self.assertEqual(tracker.update(observer.parse_snapshot(row(101, 1, 100))), [])
        self.assertEqual(tracker.unattributed, 1)

    def test_process_count_bounds_are_explicit(self):
        tracker = observer.ProcessTracker(100)
        rows = observer.parse_snapshot(row() + "".join(row(pid, 100) for pid in range(101, 180)))
        self.assertEqual(len(tracker.update(rows)), observer.MAX_PROCESSES)
        self.assertTrue(tracker.truncated)

    def test_rotated_low_concurrency_lifetime_exceeds_256_without_invalidity(self):
        tracker = observer.ProcessTracker(100)
        for generation in range(320):
            rows = observer.parse_snapshot(row() + "".join(row(1000 + generation * 8 + index, 100) for index in range(8)))
            output = tracker.update(rows)
            self.assertFalse(tracker.truncated, generation)
            self.assertEqual(len(output), 9)
        self.assertEqual(len(tracker.identities), 2561)
        self.assertEqual(len(tracker.known), 9)
        self.assertFalse(tracker.history_overflow)
        self.assertFalse(tracker.reused)

    def test_history_budget_is_explicitly_sample_concurrency_derived(self):
        self.assertEqual(observer.MAX_IDENTITY_HISTORY, observer.MAX_EVENTS * observer.MAX_PROCESSES)
        self.assertEqual(observer.MAX_IDENTITY_HISTORY, 131072)

    def test_exact_history_boundary_then_overflow_never_evicts(self):
        tracker = observer.ProcessTracker(100, history_limit=17)
        for first in (1000, 2000):
            tracker.update(observer.parse_snapshot(row() + "".join(row(first + index, 100) for index in range(8))))
        self.assertEqual(len(tracker.identities), 17)
        self.assertFalse(tracker.truncated)
        original = dict(tracker.identities)
        output = tracker.update(observer.parse_snapshot(row() + row(3000, 100)))
        self.assertEqual([item["pid"] for item in output], [100])
        self.assertTrue(tracker.truncated)
        self.assertTrue(tracker.history_overflow)
        self.assertFalse(tracker.active_overflow)
        self.assertEqual(tracker.identities, original)

    def test_declared_131072_history_limit_is_exact_and_bounded(self):
        tracker = observer.ProcessTracker(100)
        root = observer.parse_snapshot(row())[100]
        child = observer.parse_snapshot(row(1000, 100))[1000]
        next_pid = 1000
        remaining = observer.MAX_IDENTITY_HISTORY - 1
        while remaining:
            count = min(observer.MAX_PROCESSES - 1, remaining)
            rows = {100: root}
            for pid in range(next_pid, next_pid + count):
                rows[pid] = {**child, "pid": pid, "startIdentity": f"{pid:064x}"}
            tracker.update(rows)
            self.assertFalse(tracker.truncated)
            self.assertLessEqual(len(tracker.known), 64)
            next_pid += count
            remaining -= count
        self.assertEqual(len(tracker.identities), 131072)
        tracker.update({100: root, next_pid: {**child, "pid": next_pid, "startIdentity": f"{next_pid:064x}"}})
        self.assertTrue(tracker.history_overflow)
        self.assertTrue(tracker.truncated)
        self.assertEqual(len(tracker.identities), 131072)
        self.assertLessEqual(len(tracker.reused), 131072)

    def test_unavailable_or_malformed_snapshot_does_not_prune_frontier(self):
        tracker = observer.ProcessTracker(100)
        tracker.update(observer.parse_snapshot(row() + row(101, 100)))
        original = dict(tracker.known)
        with self.assertRaises(observer.ObservationError):
            tracker.update(observer.parse_snapshot("malformed"))
        with mock.patch.object(observer, "collect_snapshot", side_effect=observer.ObservationError("snapshot_unavailable")):
            with self.assertRaises(observer.ObservationError):
                tracker.update(observer.collect_snapshot())
        self.assertEqual(tracker.known, original)
        for cache in (tracker.previous_cpu, tracker.previous_elapsed, tracker.previous_state):
            self.assertEqual(set(cache), {100, 101})

    def test_frontier_and_all_timing_caches_prune_but_history_does_not(self):
        tracker = observer.ProcessTracker(100)
        tracker.update(observer.parse_snapshot(row() + "".join(row(pid, 100) for pid in range(101, 164))))
        self.assertEqual(len(tracker.known), 64)
        self.assertFalse(tracker.active_overflow)
        tracker.update(observer.parse_snapshot(row()))
        for cache in (tracker.known, tracker.previous_cpu, tracker.previous_elapsed, tracker.previous_state):
            self.assertEqual(set(cache), {100})
        self.assertEqual(len(tracker.identities), 64)
        tracker.update(observer.parse_snapshot(row() + "".join(row(pid, 100) for pid in range(101, 165))))
        self.assertEqual(len(tracker.known), 64)
        self.assertTrue(tracker.active_overflow)
        self.assertFalse(tracker.history_overflow)
        self.assertTrue(tracker.truncated)
        for cache in (tracker.previous_cpu, tracker.previous_elapsed, tracker.previous_state):
            self.assertLessEqual(len(cache), 64)

    def test_reused_pid_after_retirement_is_still_excluded(self):
        tracker = observer.ProcessTracker(100)
        tracker.update(observer.parse_snapshot(row() + row(101, 100)))
        tracker.update(observer.parse_snapshot(row()))
        self.assertNotIn(101, tracker.known)
        self.assertIn(101, tracker.identities)
        output = tracker.update(observer.parse_snapshot(row() + row(101, 100, start="Mon Nov 10 12:35:01 2026") + row(102, 101)))
        self.assertEqual([item["pid"] for item in output], [100])
        self.assertEqual(tracker.reused, {101})

    def test_matching_historical_identity_survives_reparenting(self):
        tracker = observer.ProcessTracker(100)
        tracker.update(observer.parse_snapshot(row() + row(101, 100, 101)))
        tracker.update(observer.parse_snapshot(row()))
        output = tracker.update(observer.parse_snapshot(row() + row(101, 1, 101)))
        self.assertEqual([item["pid"] for item in output], [100, 101])
        self.assertEqual(tracker.residuals(observer.parse_snapshot(row(101, 1, 101))), (0, 1))

    def test_retired_root_is_never_reanchored_to_reused_pid(self):
        tracker = observer.ProcessTracker(100)
        tracker.update(observer.parse_snapshot(row()))
        tracker.update({})
        self.assertEqual(tracker.known, {})
        output = tracker.update(observer.parse_snapshot(row(start="Mon Nov 10 12:35:01 2026")))
        self.assertEqual(output, [])
        self.assertEqual(tracker.reused, {100})

    def test_new_paths_reject_existing_relative_symlink_and_nested(self):
        existing = self.root / "existing"
        existing.mkdir()
        alias = self.root / "alias"
        alias.symlink_to(existing, target_is_directory=True)
        for value in [str(existing), "relative", str(alias / "new"), str(self.root / ".." / "new")]:
            with self.subTest(value=value), self.assertRaises(observer.ObservationError):
                observer.new_path(value)
        self.assertEqual(observer.new_path(str(self.root / "new")), self.root / "new")

    def test_recorder_bounds_reserve_explicit_truncation(self):
        evidence = self.root / "evidence"
        evidence.mkdir()
        recorder = observer.Recorder(evidence, max_events=3)
        for _ in range(10):
            recorder.emit({"event": "sample"})
        recorder.handle.close()
        rows = [json.loads(line) for line in (evidence / "events.jsonl").read_text().splitlines()]
        self.assertEqual(len(rows), 3)
        self.assertTrue(rows[-1]["truncated"])

    def test_recorder_io_failure_is_scalar_unavailable(self):
        evidence = self.root / "evidence"
        evidence.mkdir()
        recorder = observer.Recorder(evidence)
        recorder.handle.close()
        with mock.patch.object(recorder, "handle") as handle:
            handle.write.side_effect = OSError("PRIVATE_MARKER")
            recorder.emit({"event": "sample"})
        self.assertTrue(recorder.unavailable)

    def test_byte_bound_also_records_truncation(self):
        evidence = self.root / "evidence"
        evidence.mkdir()
        recorder = observer.Recorder(evidence, max_bytes=256)
        recorder.emit({"event": "sample", "fixedData": "x" * 512})
        recorder.handle.close()
        self.assertTrue(recorder.truncated)
        self.assertLessEqual((evidence / "events.jsonl").stat().st_size, 256)

    def prepare_files(self):
        workspace, evidence = self.root / "workspace", self.root / "evidence"
        (workspace / "trusted-logs").mkdir(parents=True)
        evidence.mkdir()
        return workspace, evidence

    def test_allowlist_retains_nested_partial_logs_and_hashes(self):
        workspace, evidence = self.prepare_files()
        nested = workspace / "owned-output/replay-x86_64-macos11/logs/stage.log"
        nested.parent.mkdir(parents=True)
        nested.write_bytes(b"partial line without newline")
        (workspace / "trusted-logs/unrequested.log").write_bytes(b"PRIVATE_MARKER")
        records = observer.retain_files(workspace, evidence)
        record = next(r for r in records if r["fileClass"] == "intel_stage_log")
        self.assertFalse(record["truncated"])
        self.assertEqual(record["sourceSHA256"], hashlib.sha256(nested.read_bytes()).hexdigest())
        self.assertEqual((evidence / "files/intel_stage_log.log").read_bytes(), nested.read_bytes())
        self.assertFalse(any(b"PRIVATE_MARKER" in p.read_bytes() for p in (evidence / "files").iterdir()))

    def test_file_limit_preserves_tail_and_does_not_claim_full_hash(self):
        workspace, evidence = self.prepare_files()
        (workspace / "trusted-logs/init.log").write_bytes(b"0123456789")
        records = observer.retain_files(workspace, evidence, per_file=4)
        record = records[0]
        self.assertEqual((evidence / "files/trusted_init.log").read_bytes(), b"6789")
        self.assertEqual(record["sourceBytes"], 10)
        self.assertIsNone(record["sourceSHA256"])
        self.assertTrue(record["truncated"])

    def test_total_retention_budget_is_bounded(self):
        workspace, evidence = self.prepare_files()
        for name in ["init.log", "canary.log"]:
            (workspace / "trusted-logs" / name).write_bytes(b"abcdef")
        records = observer.retain_files(workspace, evidence, total=4)
        self.assertEqual(sum(p.stat().st_size for p in (evidence / "files").iterdir()), 4)
        self.assertTrue(any(r["state"] == "budget_exhausted" for r in records))

    def test_file_and_directory_symlinks_and_hardlinks_are_refused(self):
        workspace, evidence = self.prepare_files()
        outside = self.root / "outside"
        outside.write_bytes(b"PRIVATE_MARKER")
        (workspace / "trusted-logs/init.log").symlink_to(outside)
        hardlink_source = self.root / "hardlink-source"
        hardlink_source.write_bytes(b"PRIVATE_MARKER")
        os.link(hardlink_source, workspace / "trusted-logs/canary.log")
        child = workspace / "owned-output"
        child.symlink_to(self.root, target_is_directory=True)
        records = observer.retain_files(workspace, evidence)
        self.assertEqual(records[0]["state"], "unsafe")
        self.assertEqual(records[1]["state"], "unsafe")
        self.assertFalse(list((evidence / "files").iterdir()))

    def test_fifo_is_refused_without_blocking(self):
        workspace, evidence = self.prepare_files()
        os.mkfifo(workspace / "trusted-logs/init.log")
        self.assertEqual(observer.retain_files(workspace, evidence)[0]["state"], "unsafe")

    def test_nonallowlisted_source_cannot_be_opened(self):
        path = self.root / "prefix/private"
        path.parent.mkdir()
        path.write_bytes(b"PRIVATE_MARKER")
        with self.assertRaises(observer.ObservationError):
            fd = observer.open_allowed(self.root, "prefix/private")
            os.close(fd)

    def test_invalid_partial_json_is_retained_but_not_marked_valid(self):
        workspace, evidence = self.prepare_files()
        path = workspace / "owned-output/replay-x86_64-macos11/STATUS.json"
        path.parent.mkdir(parents=True)
        path.write_bytes(b'{"result":')
        records = observer.retain_files(workspace, evidence)
        self.assertFalse(next(r for r in records if r["fileClass"] == "intel_status")["jsonValid"])

    def test_changed_during_capture_does_not_claim_stable_source_hash(self):
        workspace, evidence = self.prepare_files()
        path = workspace / "trusted-logs/init.log"
        path.write_bytes(b"initial")
        original_read = observer.os.read
        changed = False
        def change_after_read(fd, length):
            nonlocal changed
            result = original_read(fd, length)
            if not changed:
                changed = True
                with path.open("ab") as output:
                    output.write(b" appended")
            return result
        with mock.patch.object(observer.os, "read", side_effect=change_after_read):
            records = observer.retain_files(workspace, evidence)
        self.assertTrue(records[0]["changedDuringCapture"])
        self.assertTrue(records[0]["truncated"])
        self.assertIsNone(records[0]["sourceSHA256"])

    def test_actual_harmless_mac_child_pass_and_observable_ledger(self):
        result, summary, ledger = self.fixture("time.sleep(.18)\n")
        self.assertEqual(result, 0)
        self.assertEqual(summary["producerExit"], 0)
        self.assertTrue(summary["observerValid"])
        self.assertFalse(summary["qualificationObserved"])
        self.assertTrue(any(event.get("processes") for event in ledger))

    def test_actual_failure_exit_is_preserved(self):
        result, summary, _ = self.fixture("time.sleep(.12)\nsys.exit(17)\n")
        self.assertEqual(result, 17)
        self.assertEqual(summary["producerExit"], 17)

    def test_unavailable_snapshots_invalidate_but_preserve_failure(self):
        def unavailable():
            raise observer.ObservationError("snapshot_unavailable")
        result, summary, ledger = self.fixture("time.sleep(.08)\nsys.exit(19)\n", snapshot_fn=unavailable)
        self.assertEqual(result, 19)
        self.assertFalse(summary["observerValid"])
        self.assertGreater(summary["snapshotUnavailable"], 0)
        self.assertTrue(any(e["event"] == "snapshot_unavailable" for e in ledger))

    def test_unavailable_success_is_not_green_qualification(self):
        def unavailable():
            raise observer.ObservationError("snapshot_unavailable")
        result, summary, _ = self.fixture("time.sleep(.05)\n", snapshot_fn=unavailable)
        self.assertEqual(result, 2)
        self.assertEqual(summary["producerExit"], 0)

    def test_unexpected_snapshot_error_never_echoes_or_replaces_failure(self):
        def unavailable():
            raise RuntimeError("PRIVATE_MARKER")
        result, summary, ledger = self.fixture("time.sleep(.05)\nsys.exit(29)\n", snapshot_fn=unavailable)
        self.assertEqual(result, 29)
        self.assertFalse(summary["observerValid"])
        self.assertNotIn("PRIVATE_MARKER", json.dumps(ledger))

    def test_retention_io_failure_preserves_actual_exit(self):
        with mock.patch.object(observer, "retain_files", side_effect=OSError("PRIVATE_MARKER")):
            result, summary, _ = self.fixture("time.sleep(.05)\nsys.exit(31)\n")
        self.assertEqual(result, 31)
        self.assertTrue(summary["retentionUnavailable"])
        self.assertFalse(summary["observerValid"])

    def test_ledger_failure_preserves_actual_exit(self):
        original = observer.Recorder.emit
        def unavailable(recorder, event):
            if event["event"] != "ready":
                recorder.unavailable = True
            original(recorder, event)
        with mock.patch.object(observer.Recorder, "emit", new=unavailable):
            result, summary, _ = self.fixture("time.sleep(.05)\nsys.exit(37)\n")
        self.assertEqual(result, 37)
        self.assertTrue(summary["ledgerUnavailable"])
        self.assertFalse(summary["observerValid"])

    def test_cleanup_refuses_pid_reuse_and_unknown_group_ownership(self):
        tracker = observer.ProcessTracker(100)
        tracker.update(observer.parse_snapshot(row()))
        fake = mock.Mock(pid=100)
        fake.poll.return_value = 0
        fake.wait.return_value = 0
        reused = observer.parse_snapshot(row(start="Mon Nov 10 12:35:01 2026"))
        with mock.patch.object(observer.os, "killpg") as kill:
            result = observer.cleanup_group(fake, tracker, lambda: reused, grace=.01)
        kill.assert_not_called()
        self.assertTrue(result["incomplete"])

    def test_cleanup_rechecks_group_ownership_before_escalation(self):
        tracker = observer.ProcessTracker(100)
        tracker.update(observer.parse_snapshot(row()))
        fake = mock.Mock(pid=100)
        fake.poll.side_effect = [None, None, 0, 0, 0]
        fake.wait.return_value = 0
        def unavailable():
            raise observer.ObservationError("snapshot_unavailable")
        snapshots = iter([observer.parse_snapshot(row()), None, None])
        def snapshot():
            value = next(snapshots)
            return unavailable() if value is None else value
        with mock.patch.object(observer.os, "killpg") as kill:
            result = observer.cleanup_group(fake, tracker, snapshot, grace=0)
        self.assertEqual(kill.call_args_list, [mock.call(100, signal.SIGTERM)])
        self.assertTrue(result["incomplete"])

    def test_timeout_does_not_signal_independent_fixture_group(self):
        independent = subprocess.Popen([sys.executable, "-I", "-B", "-c", "import time;time.sleep(60)"], start_new_session=True)
        try:
            result, summary, _ = self.fixture("time.sleep(60)\n", max_seconds=.15)
            self.assertEqual(result, 124)
            self.assertIsNone(independent.poll())
            self.assertEqual(summary["cleanup"]["ownedResidual"], 0)
        finally:
            independent.kill()
            independent.wait(timeout=2)

    def test_observer_interrupt_cleans_owned_producer_and_records_signal(self):
        workspace, evidence = self.root / "workspace", self.root / "evidence"
        pidfile = self.root / "producer-pid"
        body = f"import os,pathlib,time;pathlib.Path({str(pidfile)!r}).write_text(str(os.getpid()));time.sleep(60)"
        command = [sys.executable, "-I", "-B", str(MODULE), "--workspace", str(workspace), "--evidence", str(evidence), "--max-seconds", "3", "--", sys.executable, "-I", "-B", "-c", body]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 2
            while not pidfile.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(pidfile.exists())
            process.terminate()
            process.communicate(timeout=5)
            self.assertEqual(process.returncode, 128 + signal.SIGTERM)
            summary = json.loads((evidence / "summary.json").read_text())
            self.assertEqual(summary["interruptedSignal"], signal.SIGTERM)
            self.assertEqual(summary["producerExit"], -signal.SIGTERM)
            self.assertNotIn(int(pidfile.read_text()), observer.collect_snapshot())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=2)
            if pidfile.exists():
                try:
                    os.killpg(int(pidfile.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_timeout_cleans_only_owned_group_and_records_not_success(self):
        pidfile = self.root / "child-pid"
        body = f"child=subprocess.Popen([sys.executable,'-I','-B','-c','import time;time.sleep(60)'])\npathlib.Path({str(pidfile)!r}).write_text(str(child.pid))\nsignal.signal(signal.SIGTERM,lambda *_:(child.wait(timeout=1),sys.exit(23)))\ntime.sleep(60)\n"
        result, summary, _ = self.fixture(body, max_seconds=.25)
        self.assertEqual(result, 124)
        self.assertTrue(summary["timedOut"])
        self.assertTrue(summary["cleanup"]["termSent"])
        self.assertEqual(summary["cleanup"]["ownedResidual"], 0)
        child = int(pidfile.read_text())
        self.assertNotIn(child, observer.collect_snapshot())

    def test_timeout_escalates_owned_term_ignoring_child(self):
        result, summary, _ = self.fixture("signal.signal(signal.SIGTERM,signal.SIG_IGN)\ntime.sleep(60)\n", max_seconds=.15)
        self.assertEqual(result, 124)
        self.assertTrue(summary["cleanup"]["killSent"])
        self.assertEqual(summary["producerExit"], -signal.SIGKILL)

    def test_detached_child_not_signalled_and_fixture_cleans_it(self):
        pidfile = self.root / "detached-pid"
        body = f"child=subprocess.Popen([sys.executable,'-I','-B','-c','import time;time.sleep(60)'],start_new_session=True)\npathlib.Path({str(pidfile)!r}).write_text(str(child.pid))\ntime.sleep(60)\n"
        try:
            result, summary, _ = self.fixture(body, max_seconds=.25)
            pid = int(pidfile.read_text())
            self.assertEqual(result, 124)
            self.assertFalse(summary["observerValid"])
            self.assertEqual(summary["cleanup"]["detachedResidual"], 1)
            self.assertIn(pid, observer.collect_snapshot())
        finally:
            if pidfile.exists():
                pid = int(pidfile.read_text())
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_launch_failure_is_unavailable_not_product_success(self):
        workspace, evidence = self.root / "workspace", self.root / "evidence"
        result = observer.observe(workspace, evidence, [str(self.root / "absent-executable")], .1)
        summary = json.loads((evidence / "summary.json").read_text())
        self.assertEqual(result, 127)
        self.assertIsNone(summary["producerExit"])
        self.assertFalse(summary["observerValid"])

    def test_cli_preserves_exact_argv_environment_stdout_stderr(self):
        output = self.root / "identity.json"
        workspace, evidence = self.root / "workspace", self.root / "evidence"
        environment = dict(os.environ, MEDIA_OBSERVER_FIXTURE="PRIVATE_MARKER")
        args = ["", " spaced ", "--literal", "line\nbreak", "unicode-\u00e9"]
        body = "import json,os,pathlib,sys,time;pathlib.Path(sys.argv[1]).write_text(json.dumps({'argv':sys.argv[2:],'env':dict(os.environ)}));print('fixture stdout');print('fixture stderr',file=sys.stderr);time.sleep(.12)"
        command = [sys.executable, "-I", "-B", str(MODULE), "--workspace", str(workspace), "--evidence", str(evidence), "--max-seconds", "3", "--", sys.executable, "-I", "-B", "-c", body, str(output), *args]
        completed = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=6)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout, "fixture stdout\n")
        self.assertEqual(completed.stderr, "fixture stderr\n")
        identity = json.loads(output.read_text())
        self.assertEqual(identity["argv"], args)
        self.assertEqual(identity["env"], environment)
        ledger = (evidence / "events.jsonl").read_text()
        self.assertNotIn("PRIVATE_MARKER", ledger)
        self.assertNotIn(str(output), ledger)
        self.assertNotIn("--literal", ledger)

    def test_cli_rejects_limits_and_existing_or_overlapping_directories_before_launch(self):
        for maximum in ["nan", "inf", "0", "-1", "6601"]:
            with self.subTest(maximum=maximum):
                self.assertEqual(observer.main(["--workspace", str(self.root / "workspace"), "--evidence", str(self.root / "evidence"), "--max-seconds", maximum, "--", "/never-launched"]), 2)
        self.assertEqual(observer.main(["--workspace", str(self.root / "same"), "--evidence", str(self.root / "same"), "--max-seconds", "1", "--", "/never-launched"]), 2)


if __name__ == "__main__":
    unittest.main()
