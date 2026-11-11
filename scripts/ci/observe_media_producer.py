#!/usr/bin/env python3
"""External, bounded observations only. Never substitutes for shipping gates."""
import argparse
from datetime import datetime
import errno
import hashlib
import json
import math
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time


MAX_SECONDS = 6600
MAX_EVENTS = 2048
MAX_LEDGER_BYTES = 64 * 1024 * 1024
MAX_PS_BYTES = 2 * 1024 * 1024
MAX_PROCESSES = 64
# Lifetime births are bounded by the declared event/concurrency envelope.
MAX_IDENTITY_HISTORY = MAX_EVENTS * MAX_PROCESSES
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_RETAINED_BYTES = 32 * 1024 * 1024

FILES = {
    "trusted_init": "trusted-logs/init.log",
    "trusted_canary": "trusted-logs/canary.log",
    "trusted_controller": "trusted-logs/controller-build.log",
    "trusted_postbuild": "trusted-logs/postbuild.log",
    "canary_receipt": "owned-output/canary-child/CONFINEMENT-CANARY.json",
}
for _arch, _label in (("x86_64", "intel"), ("arm64", "arm")):
    _child = f"owned-output/replay-{_arch}-macos11"
    for _name in ("stage", "minimum", "media-smoke", "notices"):
        FILES[f"{_label}_{_name.replace('-', '_')}_log"] = f"{_child}/logs/{_name}.log"
    for _name in ("STATUS", "TOOLCHAIN-PROBE", "INSTALL-AUDIT", "INSTALL-INVENTORY", "CONFINEMENT", "SHIPPING-RESULTS"):
        FILES[f"{_label}_{_name.lower().replace('-', '_')}"] = f"{_child}/{_name}.json"
    FILES[f"{_label}_smoke_results"] = f"{_child}/media-smoke/RESULTS.json"
    FILES[f"{_label}_relocation"] = f"{_child}/media-candidate/relocation.json"


class ObservationError(Exception):
    pass


def new_path(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        raise ObservationError("path_invalid")
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise ObservationError("symlink_rejected")
    if path.exists() or not path.parent.is_dir():
        raise ObservationError("new_directory_required")
    return path


def duration_ms(value: str) -> float:
    match = re.fullmatch(r"(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)", value)
    if not match:
        raise ObservationError("snapshot_malformed")
    days, hours, minutes, seconds = match.groups()
    result = ((int(days or 0) * 24 + int(hours or 0)) * 3600 + int(minutes) * 60 + float(seconds)) * 1000
    if not math.isfinite(result):
        raise ObservationError("snapshot_malformed")
    return result


def process_class(command: str) -> str:
    name = command.rsplit("/", 1)[-1]
    if re.fullmatch(r"(?:python|Python)(?:3(?:\.\d+)*)?", name):
        return "python"
    return {
        "node": "node", "sandbox-exec": "sandbox", "env": "env",
        "lipo": "lipo", "otool": "otool", "install_name_tool": "install_name_tool",
        "codesign": "codesign", "ninja": "ninja", "meson": "meson",
        "make": "make", "clang": "compiler", "clang++": "compiler",
        "ffmpeg": "ffmpeg", "ffprobe": "ffprobe", "sh": "shell", "bash": "shell",
    }.get(name, "other")


def parse_snapshot(text: str) -> dict:
    if len(text.encode("utf8")) > MAX_PS_BYTES:
        raise ObservationError("snapshot_limit")
    rows = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        fields = line.split(None, 11)
        if len(fields) != 12 or not all(re.fullmatch(r"\d+", item) for item in fields[:3]):
            raise ObservationError("snapshot_malformed")
        pid, parent, group = map(int, fields[:3])
        start = " ".join(fields[3:8])
        if pid <= 0 or pid in rows or not re.fullmatch(r"[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}", start):
            raise ObservationError("snapshot_malformed")
        try:
            datetime.strptime(start, "%a %b %d %H:%M:%S %Y")
        except ValueError:
            raise ObservationError("snapshot_malformed") from None
        state = fields[10][0]
        rows[pid] = {
            "pid": pid, "parentPid": parent, "groupPid": group,
            "startIdentity": hashlib.sha256(f"{pid}:{start}".encode()).hexdigest(),
            "elapsedMs": duration_ms(fields[8]), "cpuMs": duration_ms(fields[9]),
            "state": state if state in "RSTITUWZX" else "other",
            "processClass": process_class(fields[11]),
        }
        if len(rows) > 16384:
            raise ObservationError("snapshot_limit")
    return rows


def collect_snapshot() -> dict:
    environment = dict(os.environ)
    environment["LC_ALL"] = "C"
    process = None
    selector = selectors.DefaultSelector()
    try:
        process = subprocess.Popen(
            ["/bin/ps", "-axo", "pid=,ppid=,pgid=,lstart=,etime=,time=,state=,comm="],
            env=environment, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        selector.register(process.stdout, selectors.EVENT_READ)
        data = bytearray()
        deadline = time.monotonic() + 2
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise ObservationError("snapshot_unavailable")
            block = os.read(process.stdout.fileno(), min(65536, MAX_PS_BYTES + 1 - len(data)))
            if not block:
                break
            data.extend(block)
            if len(data) > MAX_PS_BYTES:
                raise ObservationError("snapshot_limit")
        if process.wait(timeout=max(.01, deadline - time.monotonic())) != 0:
            raise ObservationError("snapshot_unavailable")
        return parse_snapshot(data.decode("utf8", errors="strict"))
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        raise ObservationError("snapshot_unavailable") from None
    finally:
        selector.close()
        if process is not None:
            if process.poll() is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            try:
                process.wait(timeout=.5)
            except subprocess.TimeoutExpired:
                pass
            process.stdout.close()


class ProcessTracker:
    def __init__(self, root_pid: int, history_limit=MAX_IDENTITY_HISTORY):
        if not isinstance(history_limit, int) or not 1 <= history_limit <= MAX_IDENTITY_HISTORY:
            raise ObservationError("history_limit_invalid")
        self.root_pid = root_pid
        self.root_identity = None
        self.history_limit = history_limit
        self.identities = {}
        self.known = {}
        self.previous_cpu = {}
        self.previous_elapsed = {}
        self.previous_state = {}
        self.reused = set()
        self.truncated = False
        self.history_overflow = self.active_overflow = False
        self.root_observed = False
        self.unattributed = 0
        self.unattributed_observed = False

    def update(self, rows: dict) -> list:
        """Consume a complete validated snapshot, never an unavailable one."""
        active = {}
        root = rows.get(self.root_pid)
        if self.root_identity is None and root and root["groupPid"] == self.root_pid:
            self.root_identity = root["startIdentity"]
            self.identities[self.root_pid] = self.root_identity
            self.root_observed = True

        # Keep only compact first-birth tokens for retired processes. Matching
        # identities retain ownership after reparenting; reused PIDs never do.
        ordered = [self.root_pid] + sorted(pid for pid in rows if pid != self.root_pid)
        for pid in ordered:
            row = rows.get(pid)
            identity = self.identities.get(pid)
            if row is None or identity is None:
                continue
            if row["startIdentity"] != identity:
                self.reused.add(pid)
            elif pid not in self.reused:
                if len(active) < MAX_PROCESSES:
                    active[pid] = row
                else:
                    self.active_overflow = self.truncated = True
        changed = True
        while changed:
            changed = False
            for pid, row in rows.items():
                if pid not in self.identities and row["parentPid"] in active:
                    if len(active) >= MAX_PROCESSES:
                        self.active_overflow = self.truncated = True
                        continue
                    if len(self.identities) >= self.history_limit:
                        self.history_overflow = self.truncated = True
                        continue
                    self.identities[pid] = row["startIdentity"]
                    active[pid] = row
                    changed = True
        self.known = active
        self.unattributed = sum(row["groupPid"] == self.root_pid and row["state"] != "Z" and pid not in active for pid, row in rows.items())
        self.unattributed_observed |= self.unattributed > 0
        output = []
        for pid, row in sorted(active.items()):
            previous = self.previous_cpu.get(pid, row["cpuMs"])
            output.append({**row, "cpuDeltaMs": max(0, row["cpuMs"] - previous),
                           "elapsedDeltaMs": max(0, row["elapsedMs"] - self.previous_elapsed.get(pid, row["elapsedMs"])),
                           "stateChanged": row["state"] != self.previous_state.get(pid, row["state"]),
                           "inOwnedGroup": row["groupPid"] == self.root_pid})
        self.previous_cpu = {pid: row["cpuMs"] for pid, row in active.items()}
        self.previous_elapsed = {pid: row["elapsedMs"] for pid, row in active.items()}
        self.previous_state = {pid: row["state"] for pid, row in active.items()}
        return output

    def residuals(self, rows: dict) -> tuple[int, int]:
        owned = detached = 0
        for pid, row in rows.items():
            if pid not in self.reused and row["startIdentity"] == self.identities.get(pid) and row["state"] != "Z":
                if row["groupPid"] == self.root_pid:
                    owned += 1
                else:
                    detached += 1
        return owned, detached


class Recorder:
    def __init__(self, evidence: Path, max_events=MAX_EVENTS, max_bytes=MAX_LEDGER_BYTES):
        self.handle = (evidence / "events.jsonl").open("x", encoding="utf8")
        self.count = self.bytes = 0
        self.max_events, self.max_bytes = max_events, max_bytes
        self.truncated = self.unavailable = False

    def emit(self, event: dict) -> None:
        if self.truncated or self.unavailable:
            return
        encoded = json.dumps(event, separators=(",", ":")) + "\n"
        if self.count >= self.max_events - 1 or self.bytes + len(encoded) > self.max_bytes - 128:
            encoded = '{"event":"truncated","truncated":true}\n'
            self.truncated = True
        try:
            self.handle.write(encoded)
            self.handle.flush()
            self.count += 1
            self.bytes += len(encoded)
        except (OSError, ValueError):
            self.unavailable = True


def open_allowed(workspace: Path, relative: str) -> int:
    """Open only through no-follow directory descriptors, never a tree walk."""
    if relative not in FILES.values():
        raise ObservationError("not_allowlisted")
    descriptors = []
    try:
        directory = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(directory)
        parts = relative.split("/")
        for part in parts[:-1]:
            directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            descriptors.append(directory)
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            os.close(fd)
            raise ObservationError("unsafe")
        return fd
    except OSError as error:
        raise ObservationError("missing" if error.errno == errno.ENOENT else "unsafe") from None
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def milestones(workspace: Path) -> dict:
    result = {}
    for label, relative in FILES.items():
        try:
            fd = open_allowed(workspace, relative)
            try:
                result[label] = {"state": "present", "bytes": os.fstat(fd).st_size}
            finally:
                os.close(fd)
        except ObservationError as error:
            result[label] = {"state": error.args[0]}
    return result


def retain_files(workspace: Path, evidence: Path, per_file=MAX_FILE_BYTES, total=MAX_RETAINED_BYTES) -> list:
    destination = evidence / "files"
    destination.mkdir()
    records = []
    for label, relative in FILES.items():
        record = {"fileClass": label}
        try:
            fd = open_allowed(workspace, relative)
            try:
                before = os.fstat(fd)
                allowance = min(per_file, total)
                if before.st_size and allowance <= 0:
                    record.update(state="budget_exhausted", sourceBytes=before.st_size, truncated=True, sourceSHA256=None)
                else:
                    start = max(0, before.st_size - allowance) if relative.endswith(".log") else 0
                    os.lseek(fd, start, os.SEEK_SET)
                    payload = bytearray()
                    while len(payload) < allowance:
                        block = os.read(fd, min(65536, allowance - len(payload)))
                        if not block:
                            break
                        payload.extend(block)
                    after = os.fstat(fd)
                    changed = (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns)
                    truncated = start != 0 or len(payload) != before.st_size or changed
                    suffix = ".log" if relative.endswith(".log") else ".json"
                    with (destination / f"{label}{suffix}").open("xb") as output:
                        output.write(payload)
                    total -= len(payload)
                    digest = hashlib.sha256(payload).hexdigest()
                    record.update(state="retained", sourceBytes=before.st_size, observedFinalBytes=after.st_size,
                                  retainedBytes=len(payload), retainedSHA256=digest,
                                  sourceSHA256=None if truncated else digest, truncated=truncated,
                                  changedDuringCapture=changed, retainedRegion="tail" if start else "head" if truncated else "whole")
                    if suffix == ".json":
                        try:
                            json.loads(payload)
                            record["jsonValid"] = not truncated
                        except (ValueError, UnicodeError):
                            record["jsonValid"] = False
            finally:
                os.close(fd)
        except (ObservationError, OSError) as error:
            record["state"] = error.args[0] if isinstance(error, ObservationError) else "unavailable"
        records.append(record)
    return records


def cleanup_group(process, tracker: ProcessTracker, snapshot_fn, grace=2.0) -> dict:
    result = {"termSent": False, "killSent": False, "incomplete": False, "ownedResidual": 0, "detachedResidual": 0, "unattributedGroupResidual": 0}
    try:
        rows = snapshot_fn()
        tracker.update(rows)
        owned, detached = tracker.residuals(rows)
    except Exception:
        owned, detached = 0, 0
        result["incomplete"] = True
    # Popen owns the unreaped/live leader. Otherwise require a matching known
    # start identity in our new group. Never signal a detached group or PID.
    authorized = process.poll() is None or owned > 0
    if authorized:
        for sig, name in ((signal.SIGTERM, "termSent"), (signal.SIGKILL, "killSent")):
            if process.poll() is not None:
                try:
                    rows = snapshot_fn()
                    tracker.update(rows)
                    owned, detached = tracker.residuals(rows)
                except Exception:
                    result["incomplete"] = True
                    break
                if owned == 0:
                    break
            try:
                os.killpg(process.pid, sig)
                result[name] = True
            except ProcessLookupError:
                break
            except OSError:
                result["incomplete"] = True
                break
            end = time.monotonic() + grace
            while time.monotonic() < end:
                process.poll()
                try:
                    rows = snapshot_fn()
                    owned, detached = tracker.residuals(rows)
                    if process.poll() is not None and owned == 0:
                        break
                except Exception:
                    result["incomplete"] = True
                time.sleep(0.05)
            if process.poll() is not None and owned == 0:
                break
    try:
        process.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        result["incomplete"] = True
    try:
        rows = snapshot_fn()
        tracker.update(rows)
        owned, detached = tracker.residuals(rows)
        result["ownedResidual"], result["detachedResidual"] = owned, detached
        result["unattributedGroupResidual"] = tracker.unattributed
        result["incomplete"] |= owned > 0 or detached > 0 or tracker.unattributed > 0
    except Exception:
        result["incomplete"] = True
    return result


def observe(workspace: Path, evidence: Path, command: list[str], max_seconds: float,
            snapshot_fn=collect_snapshot, sample_seconds=5.0, cleanup_grace=2.0) -> int:
    evidence.mkdir(mode=0o700)
    recorder = Recorder(evidence)
    started = time.monotonic()
    summary = {"schemaVersion": 1, "scope": "external_observation_only", "qualificationObserved": False,
               "producerStarted": False, "producerExit": None, "timedOut": False, "interruptedSignal": None,
               "observerValid": False, "snapshotUnavailable": 0, "maxSeconds": max_seconds,
               "processStartResolutionSeconds": 1}
    interrupted = []
    previous_handlers = {}
    process = None
    tracker = None
    valid = True
    recorder.emit({"event": "ready", "elapsedMs": 0})
    try:
        for sig in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[sig] = signal.signal(sig, lambda number, frame: interrupted.append(number))
        try:
            process = subprocess.Popen(command, start_new_session=True)
        except OSError:
            summary["launchFailed"] = True
            valid = False
        if process is not None:
            summary["producerStarted"] = True
            tracker = ProcessTracker(process.pid)
            while True:
                sample_started = time.monotonic()
                elapsed = sample_started - started
                try:
                    scoped = tracker.update(snapshot_fn())
                    recorder.emit({"event": "sample", "elapsedMs": round(elapsed * 1000, 3),
                                   "processes": scoped, "milestones": milestones(workspace),
                                   "pidReuseCount": len(tracker.reused), "processesTruncated": tracker.truncated,
                                   "identityHistoryCount": len(tracker.identities), "identityHistoryLimit": tracker.history_limit,
                                   "identityHistoryOverflow": tracker.history_overflow, "activeProcessOverflow": tracker.active_overflow,
                                   "unattributedGroupCount": tracker.unattributed})
                except Exception as error:
                    valid = False
                    summary["snapshotUnavailable"] += 1
                    error_class = error.args[0] if isinstance(error, ObservationError) and error.args[0] in ("snapshot_unavailable", "snapshot_malformed", "snapshot_limit") else "snapshot_unavailable"
                    recorder.emit({"event": "snapshot_unavailable", "errorClass": error_class,
                                   "elapsedMs": round(elapsed * 1000, 3)})
                elapsed = time.monotonic() - started
                if process.poll() is not None:
                    break
                if interrupted or elapsed >= max_seconds:
                    summary["timedOut"] = not interrupted
                    summary["interruptedSignal"] = interrupted[0] if interrupted else None
                    break
                try:
                    process.wait(timeout=max(0, min(sample_seconds - (time.monotonic() - sample_started), max_seconds - (time.monotonic() - started))))
                except subprocess.TimeoutExpired:
                    pass
            summary["cleanup"] = cleanup_group(process, tracker, snapshot_fn, cleanup_grace)
            summary["producerExit"] = process.poll()
            summary["rootObserved"] = tracker.root_observed
            summary["pidReuseCount"] = len(tracker.reused)
            summary["processesTruncated"] = tracker.truncated
            summary["identityHistoryCount"] = len(tracker.identities)
            summary["identityHistoryLimit"] = tracker.history_limit
            summary["identityHistoryOverflow"] = tracker.history_overflow
            summary["activeProcessOverflow"] = tracker.active_overflow
            summary["unattributedGroupObserved"] = tracker.unattributed_observed
            valid &= tracker.root_observed and not tracker.reused and not tracker.truncated and not tracker.unattributed_observed and not summary["cleanup"]["incomplete"]
    finally:
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)
        try:
            records = retain_files(workspace, evidence)
        except Exception:
            records = []
            summary["retentionUnavailable"] = True
            valid = False
        summary["files"] = records
        valid &= not any(row["state"] in ("unsafe", "unavailable", "budget_exhausted") or row.get("truncated", False) for row in records)
        recorder.emit({"event": "terminal", "producerExit": summary["producerExit"],
                       "timedOut": summary["timedOut"], "elapsedMs": round((time.monotonic() - started) * 1000, 3)})
        summary.update(observerValid=bool(valid and not recorder.truncated and not recorder.unavailable),
                       ledgerUnavailable=recorder.unavailable, ledgerTruncated=recorder.truncated,
                       eventCount=recorder.count, elapsedMs=round((time.monotonic() - started) * 1000, 3))
        try:
            recorder.handle.close()
            with (evidence / "summary.json").open("x", encoding="utf8") as output:
                json.dump(summary, output, sort_keys=True)
                output.write("\n")
        except OSError:
            summary["observerValid"] = False
    if summary["timedOut"]:
        return 124
    if summary["interruptedSignal"]:
        return 128 + summary["interruptedSignal"]
    code = summary["producerExit"]
    if code is None:
        return 127
    if code:
        return code if code > 0 else 128 - code
    return 0 if summary["observerValid"] else 2


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise ObservationError("arguments_invalid")


def main(argv=None) -> int:
    parser = SafeParser(description=__doc__)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--max-seconds", required=True, type=float)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    try:
        args = parser.parse_args(argv)
        command = args.command
        if command[:1] == ["--"]:
            command = command[1:]
        if not command or not math.isfinite(args.max_seconds) or not 0 < args.max_seconds <= MAX_SECONDS:
            raise ObservationError("arguments_invalid")
        workspace, evidence = new_path(args.workspace), new_path(args.evidence)
        if workspace == evidence or workspace in evidence.parents or evidence in workspace.parents:
            raise ObservationError("separate_directories_required")
        return observe(workspace, evidence, command, args.max_seconds)
    except (ObservationError, OSError):
        print("External observer unavailable; no qualification inferred", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
