#!/usr/bin/env python3
"""Validate and copy a prebuilt Tauri API JAR; this helper never compiles it.

The caller must bind the input JAR to its producer task. Matching bytes and source
pins alone do not prove which build emitted those bytes.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import stat
import sys
import tarfile
import tomllib
import zipfile
import zlib
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any


CRATE_NAME = "tauri"
CRATE_VERSION = "2.12.4"
CRATE_CHECKSUM = "f316751027fc2644221d1a448564d519efb07067fda584879d9cda966391d212"
SOURCE_FILES = {
    "Cargo.toml": "0226bd683231ce3d1599d504ac85bbec1250ae2ff16078ed00f17ecb3fe62683",
    "mobile/android/build.gradle.kts": "7cd902e29c3d5e495600f98669fb67a2b7983d58e69e627fc7d8778be58802d4",
    "mobile/android/src/main/java/app/tauri/plugin/Plugin.kt": "c5dc0d1b59ac2024399afd0893f1182ae583b4d4f2cc88a5ba7864d365f77f7c",
    "mobile/android/src/main/java/app/tauri/plugin/PluginManager.kt": "053958be1e83d8633d26348ded26bbd6d4ab21121e662985194fa3342eef1e95",
    "mobile/android/src/main/java/app/tauri/plugin/PluginHandle.kt": "628b69f19d03b861765a2f7f3140e5b6a79bd991966019bb250bf7ae79bfd301",
}
REQUIRED_API_CLASSES = (
    "app/tauri/plugin/Plugin.class",
    "app/tauri/plugin/PluginManager.class",
    "app/tauri/plugin/PluginHandle.class",
)

MAX_LOCK_BYTES = 16 * 1024 * 1024
MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 5000
MAX_ARCHIVE_FILE_BYTES = 8 * 1024 * 1024
MAX_ARCHIVE_TOTAL_BYTES = 64 * 1024 * 1024
MAX_JAR_BYTES = 32 * 1024 * 1024
MAX_JAR_MEMBERS = 10000
MAX_JAR_ENTRY_BYTES = 8 * 1024 * 1024
MAX_JAR_TOTAL_BYTES = 64 * 1024 * 1024


@dataclass(frozen=True)
class Policy:
    crate_name: str
    crate_version: str
    crate_checksum: str
    source_files: dict[str, str]
    required_api_classes: tuple[str, ...]
    max_lock_bytes: int = MAX_LOCK_BYTES
    max_archive_bytes: int = MAX_ARCHIVE_BYTES
    max_archive_members: int = MAX_ARCHIVE_MEMBERS
    max_archive_file_bytes: int = MAX_ARCHIVE_FILE_BYTES
    max_archive_total_bytes: int = MAX_ARCHIVE_TOTAL_BYTES
    max_jar_bytes: int = MAX_JAR_BYTES
    max_jar_members: int = MAX_JAR_MEMBERS
    max_jar_entry_bytes: int = MAX_JAR_ENTRY_BYTES
    max_jar_total_bytes: int = MAX_JAR_TOTAL_BYTES


PRODUCTION_POLICY = Policy(
    crate_name=CRATE_NAME,
    crate_version=CRATE_VERSION,
    crate_checksum=CRATE_CHECKSUM,
    source_files=SOURCE_FILES,
    required_api_classes=REQUIRED_API_CLASSES,
)


class FixtureError(Exception):
    """Fixed, non-sensitive failure identifier."""


def _fail(code: str) -> None:
    raise FixtureError(code)


def _safe_path(path: Path, *, expected: str) -> Path:
    """Reject symlinks in every existing path component, then enforce final type."""
    absolute = Path(os.path.abspath(os.fspath(path)))
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current = current / part
        try:
            mode = current.lstat().st_mode
        except OSError:
            _fail("INPUT_MISSING")
        if stat.S_ISLNK(mode):
            _fail("SYMLINK_INPUT_REFUSED")
    try:
        mode = absolute.lstat().st_mode
    except OSError:
        _fail("INPUT_MISSING")
    if expected == "file" and not stat.S_ISREG(mode):
        _fail("INPUT_NOT_REGULAR_FILE")
    if expected == "directory" and not stat.S_ISDIR(mode):
        _fail("INPUT_NOT_DIRECTORY")
    return absolute


def _read_file(path: Path, *, max_bytes: int) -> bytes:
    safe = _safe_path(path, expected="file")
    try:
        fd = os.open(safe, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                _fail("INPUT_NOT_REGULAR_FILE")
            data = stream.read(max_bytes + 1)
    except FixtureError:
        raise
    except OSError:
        _fail("INPUT_READ_FAILED")
    if len(data) > max_bytes:
        _fail("INPUT_SIZE_LIMIT")
    return data


def _path_components(name: str, *, allow_directory_suffix: bool = False) -> tuple[str, ...]:
    if not name or "\\" in name or name.startswith("/") or "\x00" in name:
        _fail("UNSAFE_MEMBER_PATH")
    raw = name[:-1] if allow_directory_suffix and name.endswith("/") else name
    parts = tuple(raw.split("/"))
    if not parts or any(part in ("", ".", "..") for part in parts):
        _fail("UNSAFE_MEMBER_PATH")
    if ":" in parts[0]:
        _fail("UNSAFE_MEMBER_PATH")
    if PurePosixPath(raw).is_absolute():
        _fail("UNSAFE_MEMBER_PATH")
    return parts


def _parse_toml(data: bytes, *, error_code: str) -> dict[str, Any]:
    try:
        value = tomllib.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError):
        _fail(error_code)
    if not isinstance(value, dict):
        _fail(error_code)
    return value


def _validate_lock(lock_bytes: bytes, policy: Policy) -> None:
    lock = _parse_toml(lock_bytes, error_code="CARGO_LOCK_INVALID")
    packages = lock.get("package")
    if not isinstance(packages, list):
        _fail("CARGO_LOCK_PACKAGE_MISSING")
    matches = [p for p in packages if isinstance(p, dict) and
               p.get("name") == policy.crate_name and p.get("version") == policy.crate_version]
    if len(matches) != 1:
        _fail("LOCKED_CRATE_VERSION_MISMATCH")
    package = matches[0]
    if package.get("source") != "registry+https://github.com/rust-lang/crates.io-index":
        _fail("LOCKED_CRATE_SOURCE_MISMATCH")
    if package.get("checksum") != policy.crate_checksum:
        _fail("LOCKED_CRATE_CHECKSUM_MISMATCH")


def _validate_source_root(root: Path, policy: Policy) -> None:
    cargo_toml = _read_file(root / "Cargo.toml", max_bytes=MAX_ARCHIVE_FILE_BYTES)
    package = _parse_toml(cargo_toml, error_code="CRATE_SOURCE_TOML_INVALID").get("package")
    if not isinstance(package, dict) or package.get("name") != policy.crate_name or package.get("version") != policy.crate_version:
        _fail("CRATE_SOURCE_IDENTITY_MISMATCH")


def _reject_extra_android_build_inputs(root: Path, archive_files: set[str]) -> None:
    android_root = root / "mobile" / "android"
    _safe_path(android_root, expected="directory")
    def walk_error(_error: OSError) -> None:
        _fail("CRATE_SOURCE_TREE_UNREADABLE")

    for current, dirs, files in os.walk(android_root, followlinks=False, onerror=walk_error):
        base = Path(current)
        kept_dirs = []
        for name in dirs:
            child = base / name
            try:
                mode = child.lstat().st_mode
            except OSError:
                _fail("CRATE_SOURCE_TREE_INVALID")
            if stat.S_ISLNK(mode):
                _fail("CRATE_SOURCE_SYMLINK_REFUSED")
            is_root_output = base == android_root and name in ("build", ".gradle")
            if not is_root_output:
                kept_dirs.append(name)
        dirs[:] = kept_dirs
        for name in files:
            path = base / name
            try:
                mode = path.lstat().st_mode
            except OSError:
                _fail("CRATE_SOURCE_TREE_INVALID")
            if stat.S_ISLNK(mode):
                _fail("CRATE_SOURCE_SYMLINK_REFUSED")
            suffix = path.suffix.lower()
            if suffix in (".java", ".kt", ".kts", ".gradle"):
                relative = path.relative_to(root).as_posix()
                if relative not in archive_files:
                    _fail("UNEXPECTED_ANDROID_BUILD_INPUT")


def _validate_archive(archive_bytes: bytes, source_root: Path, policy: Policy) -> dict[str, Any]:
    expected_prefix = f"{policy.crate_name}-{policy.crate_version}"
    file_data: dict[str, bytes] = {}
    seen: set[str] = set()
    total_bytes = 0
    try:
        archive = tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz")
        with archive:
            members = archive.getmembers()
            if len(members) == 0 or len(members) > policy.max_archive_members:
                _fail("ARCHIVE_MEMBER_LIMIT")
            for member in members:
                is_dir = member.isdir()
                parts = _path_components(member.name, allow_directory_suffix=is_dir)
                if parts[0] != expected_prefix:
                    _fail("ARCHIVE_ROOT_MISMATCH")
                if len(parts) == 1 and is_dir:
                    if "" in seen:
                        _fail("ARCHIVE_DUPLICATE_MEMBER")
                    seen.add("")
                    if member.size != 0:
                        _fail("ARCHIVE_DIRECTORY_HAS_DATA")
                    continue
                if len(parts) < 2:
                    _fail("ARCHIVE_ROOT_MISMATCH")
                relative = "/".join(parts[1:])
                if relative in seen:
                    _fail("ARCHIVE_DUPLICATE_MEMBER")
                seen.add(relative)
                if is_dir:
                    if member.size != 0:
                        _fail("ARCHIVE_DIRECTORY_HAS_DATA")
                    continue
                if not member.isfile() or member.issparse():
                    _fail("ARCHIVE_LINK_OR_SPECIAL_MEMBER")
                if member.size < 0 or member.size > policy.max_archive_file_bytes:
                    _fail("ARCHIVE_MEMBER_SIZE_LIMIT")
                total_bytes += member.size
                if total_bytes > policy.max_archive_total_bytes:
                    _fail("ARCHIVE_TOTAL_SIZE_LIMIT")
                stream = archive.extractfile(member)
                if stream is None:
                    _fail("ARCHIVE_MEMBER_UNREADABLE")
                data = stream.read(member.size + 1)
                if len(data) != member.size:
                    _fail("ARCHIVE_MEMBER_SIZE_MISMATCH")
                source_file = source_root / relative
                try:
                    actual = _read_file(source_file, max_bytes=policy.max_archive_file_bytes)
                except FixtureError:
                    _fail("CRATE_SOURCE_FILE_MISSING_OR_UNSAFE")
                if actual != data:
                    _fail("CRATE_SOURCE_ARCHIVE_DIVERGENCE")
                file_data[relative] = data
    except FixtureError:
        raise
    except (tarfile.TarError, OSError, EOFError, ValueError, zlib.error):
        _fail("ARCHIVE_INVALID")

    if not file_data:
        _fail("ARCHIVE_SOURCE_EMPTY")
    for relative, expected_hash in policy.source_files.items():
        data = file_data.get(relative)
        if data is None or hashlib.sha256(data).hexdigest() != expected_hash:
            _fail("PINNED_SOURCE_HASH_MISMATCH")
    _reject_extra_android_build_inputs(source_root, set(file_data))

    inventory = hashlib.sha256()
    for relative in sorted(file_data):
        inventory.update(relative.encode("utf-8"))
        inventory.update(b"\0")
        inventory.update(hashlib.sha256(file_data[relative]).digest())
        inventory.update(b"\n")
    return {
        "archiveFileCount": len(file_data),
        "archiveUncompressedBytes": total_bytes,
        "sourceInventorySha256": inventory.hexdigest(),
    }


def _validate_jar(jar_bytes: bytes, policy: Policy) -> dict[str, Any]:
    names: set[str] = set()
    total_bytes = 0
    class_count = 0
    try:
        with zipfile.ZipFile(io.BytesIO(jar_bytes), "r") as jar:
            infos = jar.infolist()
            if len(infos) == 0 or len(infos) > policy.max_jar_members:
                _fail("JAR_MEMBER_LIMIT")
            for info in infos:
                is_dir = info.is_dir()
                parts = _path_components(info.filename, allow_directory_suffix=is_dir)
                name = "/".join(parts)
                if name in names:
                    _fail("JAR_DUPLICATE_MEMBER")
                names.add(name)
                mode = (info.external_attr >> 16) & 0xFFFF
                kind = stat.S_IFMT(mode)
                if kind == stat.S_IFLNK or kind not in (0, stat.S_IFREG, stat.S_IFDIR):
                    _fail("JAR_LINK_OR_SPECIAL_MEMBER")
                if is_dir and info.file_size != 0:
                    _fail("JAR_DIRECTORY_HAS_DATA")
                if info.flag_bits & 0x1:
                    _fail("JAR_ENCRYPTED_MEMBER")
                if info.file_size < 0 or info.file_size > policy.max_jar_entry_bytes:
                    _fail("JAR_MEMBER_SIZE_LIMIT")
                total_bytes += info.file_size
                if total_bytes > policy.max_jar_total_bytes:
                    _fail("JAR_TOTAL_SIZE_LIMIT")
                if info.compress_size == 0 and info.file_size > 0:
                    _fail("JAR_COMPRESSION_INVALID")
                if info.compress_size > 0 and info.file_size > info.compress_size * 300:
                    _fail("JAR_COMPRESSION_RATIO_LIMIT")
                if is_dir:
                    continue
                lower = name.lower()
                if lower.endswith((".dex", ".apk", ".aar", ".so", ".dylib")):
                    _fail("JAR_FORBIDDEN_PAYLOAD")
                if name.endswith(".class"):
                    if not name.startswith("app/tauri/"):
                        _fail("JAR_UNEXPECTED_CLASS_PACKAGE")
                    class_count += 1
                elif not (name.startswith("app/tauri/") or name.startswith("META-INF/")):
                    _fail("JAR_UNEXPECTED_PACKAGE")
                with jar.open(info, "r") as stream:
                    data = stream.read(info.file_size + 1)
                if len(data) != info.file_size:
                    _fail("JAR_MEMBER_SIZE_MISMATCH")
    except FixtureError:
        raise
    except (zipfile.BadZipFile, OSError, EOFError, RuntimeError, ValueError, zlib.error):
        _fail("JAR_INVALID")
    missing = [name for name in policy.required_api_classes if name not in names]
    if missing:
        _fail("JAR_REQUIRED_API_CLASS_MISSING")
    if class_count < len(policy.required_api_classes):
        _fail("JAR_CLASS_COUNT_INVALID")
    return {"jarEntryCount": len(names), "jarClassCount": class_count}


def _hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _build_environment(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,96}", value):
        _fail("BUILD_ENVIRONMENT_LABEL_INVALID")
    return value


def _write_exclusive(path: Path, data: bytes, created: list[Path]) -> None:
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        created.append(path)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError:
        _fail("OUTPUT_WRITE_FAILED")


def prepare(inputs: Any, *, policy: Policy = PRODUCTION_POLICY) -> dict[str, Any]:
    """Validate fixed inputs and copy into an existing, empty destination directory.

    `policy` is an internal fixture seam for unit tests. The CLI never exposes it
    and always passes `PRODUCTION_POLICY` explicitly.
    """
    lock_bytes = _read_file(Path(inputs.cargo_lock), max_bytes=policy.max_lock_bytes)
    archive_bytes = _read_file(Path(inputs.crate_archive), max_bytes=policy.max_archive_bytes)
    jar_bytes = _read_file(Path(inputs.classes_jar), max_bytes=policy.max_jar_bytes)
    source_root = _safe_path(Path(inputs.api_source), expected="directory")
    output = _safe_path(Path(inputs.output), expected="directory")
    try:
        with os.scandir(output) as entries:
            if next(entries, None) is not None:
                _fail("OUTPUT_DIRECTORY_NOT_EMPTY")
    except FixtureError:
        raise
    except OSError:
        _fail("OUTPUT_DIRECTORY_UNREADABLE")

    environment = _build_environment(inputs.build_environment)
    _validate_lock(lock_bytes, policy)
    if _hash(archive_bytes) != policy.crate_checksum:
        _fail("CRATE_ARCHIVE_CHECKSUM_MISMATCH")
    _validate_source_root(source_root, policy)
    archive_facts = _validate_archive(archive_bytes, source_root, policy)
    jar_facts = _validate_jar(jar_bytes, policy)
    jar_hash = _hash(jar_bytes)

    receipt = {
        "schemaVersion": 1,
        "crateName": policy.crate_name,
        "crateVersion": policy.crate_version,
        "crateChecksum": policy.crate_checksum,
        "classesJarSha256": jar_hash,
        "buildEnvironment": environment,
        "sourceFiles": dict(policy.source_files),
        "archiveSha256": _hash(archive_bytes),
        **archive_facts,
        **jar_facts,
    }
    receipt_bytes = (json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    sums = (
        f"{jar_hash}  tauri-android-api-classes.jar\n"
        f"{_hash(receipt_bytes)}  api-source-receipt.json\n"
    ).encode("ascii")
    created: list[Path] = []
    try:
        _write_exclusive(output / "tauri-android-api-classes.jar", jar_bytes, created)
        copied = _read_file(output / "tauri-android-api-classes.jar", max_bytes=policy.max_jar_bytes)
        if _hash(copied) != jar_hash:
            _fail("COPIED_JAR_HASH_MISMATCH")
        _write_exclusive(output / "api-source-receipt.json", receipt_bytes, created)
        _write_exclusive(output / "SHA256SUMS", sums, created)
    except FixtureError:
        for path in reversed(created):
            try:
                path.unlink()
            except OSError:
                pass
        raise

    return {
        "ok": True,
        "crateChecksum": policy.crate_checksum,
        "classesJarSha256": jar_hash,
        "archiveFileCount": archive_facts["archiveFileCount"],
        "jarEntryCount": jar_facts["jarEntryCount"],
        "outputFileCount": 3,
    }


class _SafeParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        del message
        _fail("ARGUMENTS_INVALID")


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = _SafeParser(description=__doc__)
    parser.add_argument("--cargo-lock", required=True)
    parser.add_argument("--crate-archive", required=True)
    parser.add_argument("--api-source", required=True)
    parser.add_argument("--classes-jar", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--build-environment", required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parse_args(argv)
        result = prepare(args, policy=PRODUCTION_POLICY)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except FixtureError as error:
        print(json.dumps({"ok": False, "error": str(error)}, sort_keys=True, separators=(",", ":")))
        return 2
    except (OSError, ValueError):
        print('{"ok":false,"error":"VALIDATION_FAILED"}')
        return 2


if __name__ == "__main__":
    sys.exit(main())
