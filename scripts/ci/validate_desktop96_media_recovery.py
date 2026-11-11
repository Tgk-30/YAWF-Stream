#!/usr/bin/env python3
"""Admit pinned unsigned media metadata without extracting or executing it."""
import argparse
from collections import deque
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tarfile
import unicodedata


SOURCE_SHA256 = "6c850c418e17824d70ba2dcb9bb71a1c829906d8238c3ba616981001098e941c"
SOURCE_BYTES = 456776628
SOURCE_FILE = f"yawf-macos-media-runtime-source-{SOURCE_SHA256}.tar.gz"
MAX_ARCHIVE_BYTES = 600_000_000
MAX_EXPANDED_BYTES = 650_000_000
MAX_MEMBERS = 1024
MAX_PROVENANCE_BYTES = 65536
MAX_RELOCATION_BYTES = 1048576
SCOPE = "unsigned_media_archive_metadata_admission_only"
LIBRARIES = frozenset("""
libfreetype.6.dylib libfribidi.0.dylib libunibreak.7.dylib
libluajit-5.1.2.1.1781602682.dylib libmujs.dylib libuchardet.0.0.8.dylib
liblcms2.2.dylib libudfread.3.dylib liblz4.1.10.0.dylib libzstd.1.5.7.dylib
libzimg.2.dylib libssl.4.dylib libcrypto.4.dylib libbs2b.0.dylib libsoxr.0.1.2.dylib
libx264.165.dylib libjpeg.62.4.0.dylib libwebp.7.2.0.dylib
libwebpdecoder.3.2.0.dylib libwebpdemux.2.0.17.dylib libwebpmux.3.1.2.dylib
libsharpyuv.0.1.2.dylib libSvtAv1Enc.4.2.0.dylib libjxl.0.11.2.dylib
libjxl_cms.0.11.2.dylib libjxl_threads.0.11.2.dylib libbrotlicommon.1.0.9.dylib
libbrotlidec.1.0.9.dylib libbrotlienc.1.0.9.dylib libdav1d.7.dylib
libspeex.1.dylib libogg.0.dylib libvorbis.0.dylib libvorbisenc.2.dylib
libvorbisfile.3.dylib libaribcaption.dylib libharfbuzz.0.dylib
libharfbuzz-subset.0.dylib libharfbuzz-gpu.0.dylib libharfbuzz-raster.0.dylib
libharfbuzz-vector.0.dylib libfontconfig.1.dylib libarchive.13.8.8.dylib
librubberband.3.dylib libbluray.3.dylib libplacebo.360.dylib libass.9.dylib
libavcodec.63.1.102.dylib libavdevice.63.1.102.dylib libavfilter.12.1.102.dylib
libavformat.63.1.102.dylib libavutil.61.1.102.dylib libswresample.7.1.102.dylib
libswscale.10.1.102.dylib libmpv.2.dylib
""".split())
SHIPPING_FILES = frozenset(f"Frameworks/{name}" for name in LIBRARIES) | {"ffmpeg/ffmpeg", "ffmpeg/ffprobe"}


class AdmissionError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise AdmissionError(code)


def safe_text(value):
    return isinstance(value, str) and len(value) <= 4096 and not any(unicodedata.category(ch).startswith("C") for ch in value)


def member_name(value):
    require(safe_text(value) and value and not value.startswith("/") and "\\" not in value, "member_name")
    parts = value.split("/")
    require(".." not in parts, "member_name")
    normalized = "/".join(part for part in parts if part not in ("", "."))
    require(normalized or all(part in ("", ".") for part in parts), "member_name")
    return normalized


def link_target(parent, target):
    require(safe_text(target) and target and not target.startswith("/") and "\\" not in target, "symlink_escape")
    # Do not collapse '..' before preceding symlinks have been followed.
    return "/".join(([parent] if parent else []) + [target])


def resolve_link(name, members, directories):
    pending = deque(name.split("/") if name else [])
    resolved = []
    seen = set()
    hops = 0
    while pending:
        part = pending.popleft()
        if part in ("", "."):
            continue
        if part == "..":
            require(bool(resolved), "symlink_escape")
            resolved.pop()
            continue
        candidate = "/".join(resolved + [part])
        member = members.get(candidate)
        if member is not None and member.issym():
            hops += 1
            state = hashlib.sha256("\0".join([candidate, *pending]).encode()).digest()
            require(hops <= MAX_MEMBERS and state not in seen, "symlink_cycle")
            seen.add(state)
            pending.extendleft(reversed(link_target("", member.linkname).split("/")))
            require(len("/".join([*resolved, *pending])) <= 4096, "symlink_limit")
            continue
        require(candidate in members or candidate in directories, "symlink_broken")
        require(not pending or member is None or member.isdir(), "symlink_broken")
        resolved.append(part)
    target = "/".join(resolved)
    require(target in members or target in directories, "symlink_broken")
    return target


class BoundedTarInfo(tarfile.TarInfo):
    def _metadata(self, archive, maximum):
        count = getattr(archive, "recovery_metadata_count", 0) + 1
        archive.recovery_metadata_count = count
        require(count <= MAX_MEMBERS and 0 <= self.size <= maximum, "tar_metadata_limit")

    def _proc_pax(self, archive):
        self._metadata(archive, MAX_PROVENANCE_BYTES)
        return super()._proc_pax(archive)

    def _proc_gnulong(self, archive):
        self._metadata(archive, 4096)
        return super()._proc_gnulong(archive)

    def _proc_sparse(self, archive):
        raise AdmissionError("member_type")


class ExpandedReader:
    def __init__(self, source):
        self.source = source
        self.count = 0

    def read(self, size=-1):
        size = min(65536 if size < 0 else size, 65536, MAX_EXPANDED_BYTES - self.count + 1)
        data = self.source.read(size)
        self.count += len(data)
        require(self.count <= MAX_EXPANDED_BYTES, "expanded_limit")
        return data


def hash_stream(stream, expected_size=None, limit_error="source_size"):
    digest = hashlib.sha256()
    count = 0
    while True:
        data = stream.read(1024 * 1024)
        if not data:
            break
        count += len(data)
        if expected_size is not None:
            require(count <= expected_size, limit_error)
        digest.update(data)
    return digest.hexdigest(), count


def strict_json(payload):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "json_duplicate")
            result[key] = value
        return result
    value = json.loads(payload.decode("utf8"), object_pairs_hook=pairs,
                       parse_constant=lambda value: (_ for _ in ()).throw(AdmissionError("json_invalid")))
    require(type(value) is dict, "json_invalid")
    return value


def minimum_allowed(value):
    if not isinstance(value, str) or not re.fullmatch(r"(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){0,2}", value):
        return False
    parts = tuple(map(int, value.split(".")))
    return parts + (0,) * (3 - len(parts)) <= (11, 0, 0)


def check_metadata(provenance, relocation, relocation_sha, arch, source_bytes, source_sha):
    require(type(provenance.get("schemaVersion")) is int and provenance["schemaVersion"] == 2, "provenance_schema")
    require(provenance.get("architecture") == arch and provenance.get("target") == "11.0", "provenance_arch_target")
    bundle = provenance.get("sourceBundle")
    require(type(bundle) is dict and type(bundle.get("bytes")) is int and bundle == {
        "file": SOURCE_FILE, "bytes": source_bytes, "sha256": source_sha,
    }, "provenance_source")
    require(type(provenance.get("packagesAudited")) is int and provenance["packagesAudited"] == 33 and
            type(provenance.get("shippingRegularFiles")) is int and provenance["shippingRegularFiles"] == 57, "provenance_counts")
    require(provenance.get("dyldEnvironmentUsed") is False and provenance.get("licensingCleared") is False and
            provenance.get("networkDeniedDuringBuildStageAndSmoke") is True and
            provenance.get("outsideWritesDeniedDuringBuildStageAndSmoke") is True, "provenance_policy")
    require(provenance.get("relocationSha256") == relocation_sha, "relocation_hash")
    require(type(relocation.get("schemaVersion")) is int and relocation["schemaVersion"] == 1 and
            relocation.get("arch") == arch and relocation.get("declaredMinimum") == "11.0", "relocation_schema")
    files = relocation.get("files")
    require(type(files) is list and len(files) == 57, "relocation_files")
    selected = set()
    for item in files:
        require(type(item) is dict and type(item.get("library")) is bool and isinstance(item.get("name"), str), "relocation_files")
        path = ("Frameworks/" if item["library"] else "ffmpeg/") + item["name"]
        require(path in SHIPPING_FILES and path not in selected, "relocation_files")
        selected.add(path)
        require(minimum_allowed(item.get("minimum")), "relocation_minimum")
    require(selected == SHIPPING_FILES, "relocation_files")


def _admit(path, arch, expected_sha, *, _source_bytes=SOURCE_BYTES, _source_sha=SOURCE_SHA256):
    """Private source overrides exist only for bounded synthetic fixtures."""
    require(arch in ("arm64", "x86_64") and isinstance(expected_sha, str) and re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha), "arguments_invalid")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= MAX_ARCHIVE_BYTES, "archive_type_size")
    except Exception:
        os.close(fd)
        raise
    with os.fdopen(fd, "rb") as raw:
        observed_sha, observed_size = hash_stream(raw, before.st_size, limit_error="archive_changed")
        require(observed_size == before.st_size and observed_sha == expected_sha.lower(), "archive_hash")
        raw.seek(0)
        members = {}
        directories = {""}
        total_bytes = 0
        payloads = {}
        source_verified = False
        source_name = "source/" + SOURCE_FILE
        provenance_name = f"source/macos-media-provenance-{arch}.json"
        with gzip.GzipFile(fileobj=raw, mode="rb") as compressed:
            expanded = ExpandedReader(compressed)
            with tarfile.open(fileobj=expanded, mode="r|", tarinfo=BoundedTarInfo, encoding="utf8", errors="strict") as archive:
                for member in archive:
                    require(len(members) < MAX_MEMBERS, "member_limit")
                    name = member_name(member.name)
                    require(name not in members, "duplicate_member")
                    require(member.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE, tarfile.SYMTYPE) and
                            member.sparse is None and member.size >= 0 and not member.mode & 0o6000, "member_type")
                    require(name or member.isdir(), "member_name")
                    require(not name or name.split("/")[0] in ("Frameworks", "ffmpeg", "source", "notices", "relocation.json"), "member_namespace")
                    require(member.isfile() or member.size == 0, "member_type")
                    members[name] = member
                    parts = name.split("/")
                    directories.update("/".join(parts[:index]) for index in range(1, len(parts)))
                    if member.isdir():
                        directories.add(name)
                    if member.issym():
                        link_target(name.rpartition("/")[0], member.linkname)
                    if member.isfile():
                        total_bytes += member.size
                        require(total_bytes <= MAX_EXPANDED_BYTES, "expanded_limit")
                        if name == source_name:
                            require(member.size == _source_bytes, "source_size")
                            digest, size = hash_stream(archive.extractfile(member), _source_bytes)
                            require(size == _source_bytes and digest == _source_sha, "source_hash")
                            source_verified = True
                        if name in (provenance_name, "relocation.json"):
                            limit = MAX_PROVENANCE_BYTES if name == provenance_name else MAX_RELOCATION_BYTES
                            require(member.size <= limit, "json_limit")
                            payload = archive.extractfile(member).read(limit + 1)
                            require(len(payload) == member.size and len(payload) <= limit, "json_limit")
                            payloads[name] = payload
                # Inspect buffered bytes after tar's first end marker too. This
                # also forces the gzip CRC/trailer without unbounded expansion.
                while True:
                    tail = archive.fileobj.read(65536)
                    if not tail:
                        break
                    require(not tail.strip(b"\0"), "tar_trailing")
        for name, member in members.items():
            parts = name.split("/")
            for index in range(1, len(parts)):
                parent = members.get("/".join(parts[:index]))
                require(parent is None or parent.isdir(), "symlink_parent")
            if member.issym():
                resolve_link(name, members, directories)
        shipping = {name for name, member in members.items() if member.isfile() and name.split("/")[0] in ("Frameworks", "ffmpeg")}
        require(shipping == SHIPPING_FILES, "shipping_files")
        for name in ("ffmpeg/ffmpeg", "ffmpeg/ffprobe"):
            require(members[name].mode & 0o111, "executable_mode")
        alias = members.get("Frameworks/libmpv.dylib")
        require(alias is not None and alias.issym() and
                resolve_link("Frameworks/libmpv.dylib", members, directories) == "Frameworks/libmpv.2.dylib" and
                members["Frameworks/libmpv.2.dylib"].isfile(), "mpv_alias")
        require(source_verified and source_name in members and members[source_name].isfile(), "source_missing")
        require(provenance_name in payloads and "relocation.json" in payloads, "metadata_missing")
        source_files = {name for name, member in members.items() if name.startswith("source/") and not member.isdir()}
        require(source_files == {source_name, provenance_name}, "source_members")
        relocation_sha = hashlib.sha256(payloads["relocation.json"]).hexdigest()
        check_metadata(strict_json(payloads[provenance_name]), strict_json(payloads["relocation.json"]),
                       relocation_sha, arch, _source_bytes, _source_sha)
        after = os.fstat(raw.fileno())
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), "archive_changed")
        return {
            "schemaVersion": 1, "result": "admitted", "scope": SCOPE, "arch": arch,
            "archiveSHA256": observed_sha, "archiveBytes": before.st_size,
            "memberCount": len(members), "expandedRegularBytes": total_bytes,
            "shippingRegularFiles": 57, "embeddedSourceSHA256": _source_sha,
            "embeddedSourceBytes": _source_bytes, "relocationSHA256": relocation_sha,
            "target": "11.0", "licensingCleared": False,
            "runtimeExecutionVerified": False, "platformSigningVerified": False,
            "olderOSRuntimeVerified": False,
        }


def validate_archive(path, arch, expected_sha):
    return _admit(path, arch, expected_sha)


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise AdmissionError("arguments_invalid")


def main(argv=None):
    parser = SafeParser(description=__doc__)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--arch", required=True, choices=("arm64", "x86_64"))
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--output", required=True)
    try:
        args = parser.parse_args(argv)
        output = Path(args.output)
        require(not output.exists() and not output.is_symlink(), "output_exists")
    except (AdmissionError, OSError):
        print("Media admission arguments or output unavailable", file=sys.stderr)
        return 2
    try:
        report = validate_archive(args.archive, args.arch, args.sha256)
        result = 0
    except Exception as error:
        report = {"schemaVersion": 1, "result": "rejected", "scope": SCOPE,
                  "errorClass": error.args[0] if isinstance(error, AdmissionError) else "archive_invalid"}
        result = 1
    try:
        with output.open("x", encoding="utf8") as handle:
            json.dump(report, handle, sort_keys=True)
            handle.write("\n")
    except OSError:
        print("Media admission output unavailable", file=sys.stderr)
        return 2
    return result


if __name__ == "__main__":
    raise SystemExit(main())
