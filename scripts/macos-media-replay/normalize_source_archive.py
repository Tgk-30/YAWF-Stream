#!/usr/bin/env python3
"""Normalize a verified source archive without extracting it."""

from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import io
import json
import os
import posixpath
import stat
import tarfile
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent
DEFAULT_PLAN = HERE / "archive-normalizer-plan.json"
REGENERATED = {"SHA256SUMS", "NORMALIZATION-PROVENANCE.json", "OWNED-FILE-MANIFEST.json"}


class AdmissionError(Exception):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_member_name(name: str, root: str, max_bytes: int) -> str:
    if not isinstance(name, str) or not name or len(name.encode("utf-8")) > max_bytes:
        raise AdmissionError("archive member path is invalid")
    if "\x00" in name or "\\" in name or name.startswith("/"):
        raise AdmissionError("archive member path is unsafe")
    normalized = posixpath.normpath(name.rstrip("/"))
    parts = PurePosixPath(normalized).parts
    if normalized in ("", ".") or ".." in parts or normalized != name.rstrip("/"):
        raise AdmissionError("archive member path is unsafe")
    if normalized != root and not normalized.startswith(root + "/"):
        raise AdmissionError("archive member is outside the expected root")
    return normalized


def contained_target(member_name: str, linkname: str, root: str, owned_prefix: str) -> tuple[str, str | None]:
    component_prefix = root + "/component-sources/"
    if not member_name.startswith(component_prefix):
        raise AdmissionError("archive link is outside component sources")
    if linkname.startswith("/"):
        prefix = owned_prefix.rstrip("/") + "/"
        if not linkname.startswith(prefix):
            raise AdmissionError("absolute archive link target is outside the proven source prefix")
        suffix = linkname[len(prefix):]
        if not suffix or posixpath.normpath(suffix) != suffix or ".." in PurePosixPath(suffix).parts:
            raise AdmissionError("absolute archive link target suffix is unsafe")
        target = component_prefix + suffix
        replacement = posixpath.relpath(target, posixpath.dirname(member_name))
        if posixpath.normpath(posixpath.join(posixpath.dirname(member_name), replacement)) != target:
            raise AdmissionError("normalized archive link target is not equivalent")
        return target, replacement
    if not linkname or "\x00" in linkname or "\\" in linkname:
        raise AdmissionError("relative archive link target is unsafe")
    target = posixpath.normpath(posixpath.join(posixpath.dirname(member_name), linkname))
    if target != root and not target.startswith(root + "/"):
        raise AdmissionError("relative archive link target escapes the archive root")
    return target, None


def scan_archive(path: Path, plan: dict, reference_source_root: Path | None = None) -> dict:
    limits = plan["limits"]
    root = plan["archiveRoot"]
    names: dict[str, str] = {}
    links = []
    regular_count = 0
    regular_bytes = 0
    with tarfile.open(path, "r|gz") as archive:
        for member in archive:
            name = safe_member_name(member.name, root, limits["pathBytes"])
            if name in names:
                raise AdmissionError("archive contains duplicate member paths")
            if len(names) >= limits["members"]:
                raise AdmissionError("archive member limit exceeded")
            if member.isdir():
                kind = "directory"
            elif member.isfile():
                kind = "regular"
                if member.size < 0 or member.size > limits["memberBytes"]:
                    raise AdmissionError("archive member size limit exceeded")
                regular_count += 1
                regular_bytes += member.size
                if regular_bytes > limits["regularBytes"]:
                    raise AdmissionError("archive regular-byte limit exceeded")
            elif member.issym():
                kind = "symlink"
                if len(links) >= limits["links"]:
                    raise AdmissionError("archive link limit exceeded")
                target, replacement = contained_target(name, member.linkname, root, plan["originalOwnedSourcesPrefix"])
                links.append({
                    "path": name,
                    "originalTarget": member.linkname,
                    "resolvedArchiveTarget": target,
                    "normalizedTarget": replacement or member.linkname,
                    "transformed": replacement is not None,
                })
            elif member.islnk():
                raise AdmissionError("archive hardlinks are not accepted")
            else:
                raise AdmissionError("archive contains an unsupported special member")
            names[name] = kind
    if root not in names or names[root] != "directory":
        raise AdmissionError("archive root directory is missing")
    for link in links:
        if names.get(link["resolvedArchiveTarget"]) not in {"regular", "symlink"}:
            raise AdmissionError("archive link target is missing or unsupported")
    reference = {"checked": 0, "matched": 0, "unavailable": 0}
    if reference_source_root is not None:
        reference_source_root = reference_source_root.resolve(strict=True)
        component_prefix = root + "/component-sources/"
        for link in links:
            relative_link = link["path"][len(component_prefix):]
            candidate = reference_source_root / relative_link
            if not candidate.is_symlink():
                reference["unavailable"] += 1
                continue
            reference["checked"] += 1
            local_target = os.readlink(candidate)
            resolved = (candidate.parent / local_target).resolve(strict=True)
            try:
                local_suffix = resolved.relative_to(reference_source_root).as_posix()
            except ValueError as error:
                raise AdmissionError("reference source link escapes its source root") from error
            archive_suffix = link["resolvedArchiveTarget"][len(component_prefix):]
            if local_suffix != archive_suffix:
                raise AdmissionError("reference source link destination does not match the archive")
            reference["matched"] += 1
    return {
        "members": len(names),
        "regularFiles": regular_count,
        "regularBytes": regular_bytes,
        "links": links,
        "referenceComparison": reference,
    }


class HashingReader:
    def __init__(self, source):
        self.source = source
        self.digest = hashlib.sha256()
        self.count = 0

    def read(self, size=-1):
        data = self.source.read(size)
        self.digest.update(data)
        self.count += len(data)
        return data


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def add_bytes(archive: tarfile.TarFile, name: str, data: bytes, mode: int = 0o644) -> str:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = mode
    info.mtime = 0
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    archive.addfile(info, io.BytesIO(data))
    return hashlib.sha256(data).hexdigest()


def normalize_archive(input_path: Path, output_path: Path, plan: dict, controller_root: Path, project_root: Path, reference_source_root: Path | None = None) -> dict:
    input_path = input_path.resolve(strict=True)
    if output_path.exists():
        raise AdmissionError("output archive already exists")
    if not output_path.parent.is_dir():
        raise AdmissionError("output parent directory is missing")
    actual_sha = sha256_file(input_path)
    if actual_sha != plan["inputArchiveSha256"]:
        raise AdmissionError("input archive SHA-256 does not match the pinned archive")
    scan = scan_archive(input_path, plan, reference_source_root)
    root = plan["archiveRoot"]
    inputs = []
    for item in plan["bundledInputs"]:
        base = controller_root if item["base"] == "controller" else project_root
        source = (base / item["source"]).resolve(strict=True)
        base_real = base.resolve(strict=True)
        if base_real not in source.parents or not source.is_file() or source.is_symlink():
            raise AdmissionError("bundled input is not a contained regular file")
        data = source.read_bytes()
        destination = safe_member_name(root + "/" + item["destination"], root, plan["limits"]["pathBytes"])
        inputs.append({**item, "path": source, "data": data, "destinationPath": destination, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    provenance = {
        "schemaVersion": 1,
        "licensingCleared": False,
        "inputArchive": {"sha256": actual_sha, "bytes": input_path.stat().st_size},
        "preservation": {"regularFiles": scan["regularFiles"], "regularBytes": scan["regularBytes"], "metadataExceptions": ["SHA256SUMS"]},
        "symlinks": scan["links"],
        "referenceComparison": scan["referenceComparison"],
        "note": "Technical containment normalization only; no licensing clearance is claimed",
    }
    owned_manifest = {
        "schemaVersion": 1,
        "licensingCleared": False,
        "files": [{"path": item["destinationPath"][len(root) + 1:], "role": item["role"], "bytes": item["bytes"], "sha256": item["sha256"]} for item in inputs],
    }
    generated = {
        root + "/NORMALIZATION-PROVENANCE.json": json_bytes(provenance),
        root + "/OWNED-FILE-MANIFEST.json": json_bytes(owned_manifest),
    }
    checksum_entries: dict[str, str] = {}
    temp = output_path.with_name(output_path.name + f".tmp-{os.getpid()}")
    if temp.exists():
        raise AdmissionError("temporary output already exists")
    replacements = {link["path"]: link["normalizedTarget"] for link in scan["links"] if link["transformed"]}
    try:
        # The normalized archive is a content-addressed release input. Pin the
        # gzip header as well as tar member metadata so identical admitted
        # source and controls produce identical bytes across workflow runs.
        with tarfile.open(input_path, "r|gz") as source_archive, temp.open("xb") as compressed_file, gzip.GzipFile(filename="", mode="wb", fileobj=compressed_file, compresslevel=6, mtime=0) as compressed, tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as output_archive:
            for member in source_archive:
                name = safe_member_name(member.name, root, plan["limits"]["pathBytes"])
                relative = name[len(root) + 1:] if name != root else ""
                if relative == "SHA256SUMS":
                    continue
                copied = copy.copy(member)
                copied.name = name
                if member.issym() and name in replacements:
                    copied.linkname = replacements[name]
                    copied.pax_headers = dict(copied.pax_headers)
                    copied.pax_headers.pop("linkpath", None)
                if member.isfile():
                    source = source_archive.extractfile(member)
                    if source is None:
                        raise AdmissionError("archive regular member cannot be read")
                    hashing = HashingReader(source)
                    output_archive.addfile(copied, hashing)
                    if hashing.count != member.size:
                        raise AdmissionError("archive regular member was truncated")
                    checksum_entries[relative] = hashing.digest.hexdigest()
                else:
                    output_archive.addfile(copied)
            for directory in [root + "/replay-controls", root + "/replay-support", root + "/replay-support/scripts"]:
                info = tarfile.TarInfo(directory)
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                info.mtime = 0
                output_archive.addfile(info)
            for item in inputs:
                checksum_entries[item["destinationPath"][len(root) + 1:]] = add_bytes(output_archive, item["destinationPath"], item["data"], stat.S_IMODE(item["path"].stat().st_mode))
            for name, data in generated.items():
                checksum_entries[name[len(root) + 1:]] = add_bytes(output_archive, name, data)
            sums = "".join(f"{checksum_entries[name]}  {name}\n" for name in sorted(checksum_entries)).encode("utf-8")
            add_bytes(output_archive, root + "/SHA256SUMS", sums)
        os.replace(temp, output_path)
    except Exception:
        if temp.exists():
            temp.unlink()
        raise
    return {"output": str(output_path), "outputSha256": sha256_file(output_path), "inputSha256": actual_sha, "members": scan["members"], "regularFilesPreserved": scan["regularFiles"], "regularBytesPreserved": scan["regularBytes"], "linksNormalized": len(replacements), "referenceComparison": scan["referenceComparison"], "ownedInputs": len(inputs)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--plan", default=DEFAULT_PLAN, type=Path)
    parser.add_argument("--controller-root", default=HERE, type=Path)
    parser.add_argument("--project-root", required=True, type=Path)
    parser.add_argument("--reference-source-root", type=Path)
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text())
    if plan.get("schemaVersion") != 1:
        raise AdmissionError("normalizer plan schema is unsupported")
    result = normalize_archive(args.input, args.output, plan, args.controller_root, args.project_root, args.reference_source_root)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (AdmissionError, OSError, tarfile.TarError, json.JSONDecodeError) as error:
        raise SystemExit(f"source archive normalizer: {error}")
