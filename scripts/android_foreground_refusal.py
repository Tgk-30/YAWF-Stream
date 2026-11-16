#!/usr/bin/env python3
"""Extract bounded Android foreground refusal metadata without retaining raw output."""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
from pathlib import Path
from typing import Final

MAX_INPUT_BYTES: Final = 1024 * 1024
SCHEMA_VERSION: Final = 1
SCOPE: Final = "android-foreground-refusal-metadata"
STATUS_PREFIX: Final = "INSTRUMENTATION_STATUS: "
STATUS_CODE_PREFIX: Final = "INSTRUMENTATION_STATUS_CODE: "
PHASE_KEY: Final = "yawfForegroundRefusalPhase"
CLASS_KEY: Final = "yawfForegroundRefusalClass"
SITE_KEY: Final = "yawfForegroundRefusalSite"
LINE_KEY: Final = "yawfForegroundRefusalLine"
CUSTOM_KEYS: Final = frozenset({PHASE_KEY, CLASS_KEY, SITE_KEY, LINE_KEY})
ALLOWED_PHASES: Final = frozenset(
    {
        "not-started",
        "launching-product",
        "server-login",
        "source-selection",
        "selecting-480p",
        "opening-read-only-details",
        "measured-no-input-window",
        "native-observation-complete",
        "unrecognized",
    }
)
SAFE_CLASS: Final = re.compile(r"\A[A-Za-z_$][A-Za-z0-9_$]{0,79}\Z")
ALLOWED_SITES: Final = frozenset({"native-flow", "settings-transaction", "unknown"})
SAFE_LINE: Final = re.compile(r"\A(?:0|[1-9][0-9]{0,3})\Z")
SAFE_KEY: Final = re.compile(r"\A[A-Za-z][A-Za-z0-9_.-]{0,127}\Z")
INTEGER: Final = re.compile(r"\A-?[0-9]{1,10}\Z")


class UnsafePathError(Exception):
    """The CLI input or output path violated the bounded file contract."""


def _base() -> dict[str, object]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "scope": SCOPE,
        "fullQualification": False,
    }


def _fixed(code: str) -> dict[str, object]:
    result = _base()
    result["code"] = code
    return result


def _observed(phase: str, failure_class: str, site: str, line: int) -> dict[str, object]:
    result = _base()
    result.update(
        {
            "nativePhase": phase,
            "nativeClass": failure_class,
            "nativeSite": site,
            "nativeLine": line,
        }
    )
    return result


def parse_instrumentation(text: str) -> dict[str, object]:
    """Return only fixed or allowlisted metadata from instrumentation stdout."""

    blocks: list[tuple[dict[str, str], int]] = []
    pending: list[tuple[str, str]] = []
    malformed = False
    custom_outside_status_two = False

    for raw_line in text.splitlines():
        line = raw_line.rstrip("\r")
        if line.startswith(STATUS_PREFIX):
            body = line[len(STATUS_PREFIX) :]
            if "=" not in body:
                malformed = True
                continue
            key, value = body.split("=", 1)
            if not SAFE_KEY.fullmatch(key):
                malformed = True
                continue
            pending.append((key, value))
            continue
        if line.startswith(STATUS_CODE_PREFIX):
            body = line[len(STATUS_CODE_PREFIX) :]
            if not INTEGER.fullmatch(body):
                malformed = True
                pending.clear()
                continue
            code = int(body)
            block: dict[str, str] = {}
            for key, value in pending:
                if key in block:
                    malformed = True
                block[key] = value
            if code != 2 and any(key in block for key in CUSTOM_KEYS):
                custom_outside_status_two = True
            blocks.append((block, code))
            pending.clear()
            continue
        if line.startswith("INSTRUMENTATION_STATUS"):
            malformed = True

    if pending:
        malformed = True
        if any(key in CUSTOM_KEYS for key, _ in pending):
            custom_outside_status_two = True

    status_two = [block for block, code in blocks if code == 2]
    if malformed or custom_outside_status_two:
        return _fixed("refused")
    if not status_two:
        return _fixed("unavailable")
    if len(status_two) != 1:
        return _fixed("refused")

    diagnostic = status_two[0]
    if set(diagnostic) != CUSTOM_KEYS:
        return _fixed("refused")
    phase = diagnostic[PHASE_KEY]
    failure_class = diagnostic[CLASS_KEY]
    site = diagnostic[SITE_KEY]
    raw_line = diagnostic[LINE_KEY]
    if (
        phase not in ALLOWED_PHASES
        or not SAFE_CLASS.fullmatch(failure_class)
        or site not in ALLOWED_SITES
        or not SAFE_LINE.fullmatch(raw_line)
    ):
        return _fixed("refused")
    line = int(raw_line)
    if line > 2000 or (site == "unknown") != (line == 0):
        return _fixed("refused")
    return _observed(phase, failure_class, site, line)


def _read_bounded(path: Path) -> str:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise UnsafePathError("input unavailable") from error
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise UnsafePathError("input is not a normal file")
        if info.st_size > MAX_INPUT_BYTES:
            raise UnsafePathError("input exceeds byte bound")
        with os.fdopen(descriptor, "rb") as source:
            descriptor = -1
            data = source.read(MAX_INPUT_BYTES + 1)
    except UnsafePathError:
        raise
    except OSError as error:
        raise UnsafePathError("input unreadable") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if len(data) > MAX_INPUT_BYTES:
        raise UnsafePathError("input exceeds byte bound")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return "INSTRUMENTATION_STATUS malformed-utf8"


def _write_fresh(path: Path, payload: dict[str, object]) -> None:
    parent = path.parent
    parent_flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        parent_flags |= os.O_DIRECTORY
    if hasattr(os, "O_NOFOLLOW"):
        parent_flags |= os.O_NOFOLLOW
    try:
        parent_descriptor = os.open(parent, parent_flags)
    except OSError as error:
        raise UnsafePathError("output parent unavailable") from error
    try:
        if not stat.S_ISDIR(os.fstat(parent_descriptor).st_mode):
            raise UnsafePathError("output parent is not a normal directory")
        encoded = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        if len(encoded) > 1024:
            raise UnsafePathError("output exceeded fixed bound")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(path.name, flags, 0o600, dir_fd=parent_descriptor)
        except OSError as error:
            raise UnsafePathError("output is not fresh") from error
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(encoded)
                output.flush()
                os.fsync(output.fileno())
        except Exception:
            try:
                os.unlink(path.name, dir_fd=parent_descriptor)
            except OSError:
                pass
            raise
    finally:
        os.close(parent_descriptor)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Extract bounded Android refusal metadata")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args(argv)
    if arguments.input.absolute() == arguments.output.absolute():
        raise UnsafePathError("input and output must differ")
    result = parse_instrumentation(_read_bounded(arguments.input))
    _write_fresh(arguments.output, result)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except UnsafePathError:
        raise SystemExit(2) from None
