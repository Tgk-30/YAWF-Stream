"""Fail-closed accounting for one disposable hosted iPad QA runtime.

Allocation counts unique device/inode blocks, including directories. Retained
output has a separate logical-byte limit. A disappearing child can be ignored;
symlinks, access errors and directory replacement cannot be treated as free space.
"""
from pathlib import Path
import errno
import os
import stat

START_FREE = 8_053_063_680
REMAINING_FREE = 6_442_450_944
MAX_ALLOCATED = 1_610_612_736
MAX_DIAGNOSTIC = 262_144_000
MAX_FILES = 6_000


class Refusal(RuntimeError):
    pass


def _flags():
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise Refusal("DIRECTORY_NOFOLLOW_UNAVAILABLE")
    return os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY


def _root_fd(root):
    path = Path(root)
    if not path.is_absolute() or ".." in path.parts:
        raise Refusal("ABSOLUTE_OWNED_ROOT_REQUIRED")
    fd = os.open("/", _flags())
    try:
        for part in path.parts[1:]:
            child = os.open(part, _flags(), dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def measure(root):
    result = {"allocatedBytes": 0, "logicalBytes": 0,
              "diagnosticLogicalBytes": 0, "files": 0,
              "directories": 0, "disappearedChildren": 0}
    seen = set()

    def account(info):
        key = (info.st_dev, info.st_ino)
        if key in seen:
            return
        blocks = getattr(info, "st_blocks", None)
        if not isinstance(blocks, int) or blocks < 0:
            raise Refusal("BLOCK_COUNT_UNAVAILABLE")
        seen.add(key)
        result["allocatedBytes"] += blocks * 512

    def visit(fd, parts):
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode):
            raise Refusal("DIRECTORY_REQUIRED")
        account(info)
        result["directories"] += 1
        with os.scandir(fd) as entries:
            for entry in entries:
                try:
                    info = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                except FileNotFoundError:
                    result["disappearedChildren"] += 1
                    continue
                if stat.S_ISLNK(info.st_mode):
                    raise Refusal("RUNTIME_SYMLINK_REFUSED")
                if stat.S_ISDIR(info.st_mode):
                    try:
                        child = os.open(entry.name, _flags(), dir_fd=fd)
                    except FileNotFoundError:
                        result["disappearedChildren"] += 1
                        continue
                    except OSError as exc:
                        if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                            raise Refusal("DIRECTORY_REPLACED") from exc
                        raise
                    try:
                        opened = os.fstat(child)
                        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                            raise Refusal("DIRECTORY_IDENTITY_CHANGED")
                        visit(child, parts + (entry.name,))
                    finally:
                        os.close(child)
                else:
                    account(info)
                    if stat.S_ISREG(info.st_mode):
                        result["files"] += 1
                        if result["files"] > MAX_FILES:
                            raise Refusal("RUNTIME_FILE_COUNT_LIMIT")
                        result["logicalBytes"] += info.st_size
                        # Derived build products, temporary scratch, and private
                        # XCTest configs are not retained diagnostic receipts.
                        if (parts + (entry.name,))[0] not in ("Derived", "tmp", "configs"):
                            result["diagnosticLogicalBytes"] += info.st_size
    fd = _root_fd(root)
    try:
        visit(fd, ())
    finally:
        os.close(fd)
    return result


def free_bytes(root):
    volume = os.statvfs(root)
    return volume.f_bavail * volume.f_frsize


def admit_start(root):
    if free_bytes(root) < START_FREE:
        raise Refusal("START_7P5_GIB_REQUIRED")


def admit_runtime(root):
    observed = measure(root)
    if observed["allocatedBytes"] > MAX_ALLOCATED - 4096:
        raise Refusal("RUNTIME_1P5_GIB_CAP")
    if observed["diagnosticLogicalBytes"] > MAX_DIAGNOSTIC - 4096:
        raise Refusal("DIAGNOSTIC_250_MIB_CAP")
    if free_bytes(root) < REMAINING_FREE:
        raise Refusal("REMAINING_6_GIB_REQUIRED")
    return observed
