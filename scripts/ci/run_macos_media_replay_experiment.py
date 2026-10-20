#!/usr/bin/env python3
"""Prepare and run one confined ARM macOS media replay experiment."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import posixpath
import shutil
import socket
import subprocess
import sys
import tarfile
from pathlib import Path, PurePosixPath


EXPECTED_ARCH = "arm64"
EXPECTED_TARGET = "11.0"
MAX_OUTER_MEMBERS = 512
MAX_OUTER_BYTES = 2 * 1024 * 1024 * 1024
FORBIDDEN_ENV_PREFIXES = ("DYLD_", "PYTHON")
FORBIDDEN_ENV_NAMES = {"NODE_OPTIONS", "NODE_PATH", "NPM_CONFIG_PREFIX", "LD_LIBRARY_PATH"}
XCODE_TOOL_NAMES = ("clang", "clang++", "ar", "ranlib", "nm", "strip", "make", "metal", "metallib")
PATH_TOOL_NAMES = ("pkg-config", "meson", "ninja")
XCRUN_TIMEOUT_SECONDS = 60


class ReplayError(Exception):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".tmp-{os.getpid()}")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def load_json(path: Path) -> dict:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ReplayError(f"{path.name} must contain a JSON object")
    return value


def normalized_outer_name(name: str) -> str:
    while name.startswith("./"):
        name = name[2:]
    normalized = posixpath.normpath(name.rstrip("/"))
    if not normalized or normalized == "." or name.startswith("/") or "\\" in name or ".." in PurePosixPath(normalized).parts:
        raise ReplayError("outer transport contains an unsafe member path")
    return normalized


def verify_pinned_files(project_root: Path, pins: dict) -> dict[str, str]:
    observed = {}
    for relative, expected in pins.get("files", {}).items():
        if not isinstance(relative, str) or relative.startswith("/") or ".." in PurePosixPath(relative).parts:
            raise ReplayError("experiment pin contains an unsafe path")
        path = project_root / relative
        if path.is_symlink() or not path.is_file():
            raise ReplayError(f"pinned experiment input is missing: {relative}")
        actual = sha256_file(path)
        if actual != expected:
            raise ReplayError(f"pinned experiment input changed: {relative}")
        observed[relative] = actual
    if not observed:
        raise ReplayError("experiment file pins are empty")
    return observed


def extract_pinned_source(candidate_dir: Path, destination: Path, pins: dict) -> dict:
    artifact = pins["artifact"]
    source = pins["source"]
    outer = candidate_dir / artifact["outerFile"]
    checksum = candidate_dir / f"{artifact['outerFile']}.sha256"
    if outer.is_symlink() or checksum.is_symlink() or not outer.is_file() or not checksum.is_file():
        raise ReplayError("downloaded artifact transport is incomplete")
    actual_outer = sha256_file(outer)
    if actual_outer != artifact["outerSha256"]:
        raise ReplayError("outer transport SHA-256 does not match its experiment pin")
    checksum_line = checksum.read_text().strip()
    if checksum_line != f"{actual_outer}  {artifact['outerFile']}":
        raise ReplayError("outer transport checksum receipt is malformed or inconsistent")
    expected_member = source["member"]
    found = 0
    total_bytes = 0
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise ReplayError("inner source destination already exists")
    with tarfile.open(outer, "r|gz") as archive:
        for count, member in enumerate(archive, start=1):
            if count > MAX_OUTER_MEMBERS:
                raise ReplayError("outer transport member limit exceeded")
            if member.name in {".", "./"} and member.isdir():
                continue
            name = normalized_outer_name(member.name)
            if member.islnk() or not (member.isdir() or member.isfile() or member.issym()):
                raise ReplayError("outer transport contains an unsupported member type")
            if member.isfile():
                if member.size < 0 or member.size > MAX_OUTER_BYTES:
                    raise ReplayError("outer transport member size limit exceeded")
                total_bytes += member.size
                if total_bytes > MAX_OUTER_BYTES:
                    raise ReplayError("outer transport byte limit exceeded")
            if name != expected_member:
                continue
            if not member.isfile() or found:
                raise ReplayError("outer transport source member is duplicated or not regular")
            stream = archive.extractfile(member)
            if stream is None:
                raise ReplayError("outer transport source member cannot be read")
            digest = hashlib.sha256()
            count_bytes = 0
            with destination.open("xb") as output:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    output.write(chunk)
                    digest.update(chunk)
                    count_bytes += len(chunk)
            if count_bytes != member.size or digest.hexdigest() != source["sha256"]:
                raise ReplayError("inner source archive size or SHA-256 is incorrect")
            found += 1
    if found != 1:
        raise ReplayError("outer transport does not contain the exact pinned source archive")
    return {"outerSha256": actual_outer, "sourceSha256": sha256_file(destination), "sourceBytes": destination.stat().st_size}


def strict_member_name(name: str, root: str, max_bytes: int) -> str:
    if not name or len(name.encode("utf-8")) > max_bytes or name.startswith("/") or "\\" in name or "\x00" in name:
        raise ReplayError("normalized source contains an unsafe path")
    normalized = posixpath.normpath(name.rstrip("/"))
    if normalized != name.rstrip("/") or ".." in PurePosixPath(normalized).parts:
        raise ReplayError("normalized source contains an unsafe path")
    if normalized != root and not normalized.startswith(root + "/"):
        raise ReplayError("normalized source member is outside its expected root")
    return normalized


def admit_normalized_archive(archive_path: Path, plan: dict) -> dict:
    limits = plan["limits"]
    root = plan["archiveRoot"]
    kinds: dict[str, str] = {}
    links = []
    regular_files = 0
    regular_bytes = 0
    with tarfile.open(archive_path, "r|gz") as archive:
        for member in archive:
            name = strict_member_name(member.name, root, limits["pathBytes"])
            if name in kinds or len(kinds) >= limits["members"] + 16:
                raise ReplayError("normalized source has duplicate or excessive members")
            if member.isdir():
                kind = "directory"
            elif member.isfile():
                kind = "regular"
                if member.size < 0 or member.size > limits["memberBytes"]:
                    raise ReplayError("normalized source member size limit exceeded")
                regular_files += 1
                regular_bytes += member.size
                if regular_bytes > limits["regularBytes"] + 1024 * 1024:
                    raise ReplayError("normalized source byte limit exceeded")
            elif member.issym():
                kind = "symlink"
                if member.linkname.startswith("/") or "\\" in member.linkname or "\x00" in member.linkname:
                    raise ReplayError("normalized source link target is unsafe")
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
                if target != root and not target.startswith(root + "/"):
                    raise ReplayError("normalized source link escapes its root")
                pax_target = member.pax_headers.get("linkpath")
                if pax_target is not None and pax_target != member.linkname:
                    raise ReplayError("normalized source PAX linkpath overrides its contained target")
                links.append((name, member.linkname, target))
                if len(links) > limits["links"]:
                    raise ReplayError("normalized source link limit exceeded")
            elif member.islnk():
                raise ReplayError("normalized source hardlinks are not accepted")
            else:
                raise ReplayError("normalized source contains a special member")
            kinds[name] = kind
    if kinds.get(root) != "directory":
        raise ReplayError("normalized source root is missing")
    for _name, _linkname, target in links:
        if kinds.get(target) not in {"regular", "symlink"}:
            raise ReplayError("normalized source link target is missing")
    return {
        "archiveSha256": sha256_file(archive_path),
        "members": len(kinds),
        "regularFiles": regular_files,
        "regularBytes": regular_bytes,
        "links": len(links),
        "absoluteLinks": 0,
        "hardlinks": 0,
    }


def extract_admitted_archive(archive_path: Path, destination: Path, plan: dict) -> Path:
    if destination.exists():
        raise ReplayError("normalized source extraction destination already exists")
    root = plan["archiveRoot"]
    directories = []
    links = []
    destination.mkdir(parents=True)
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive:
            name = strict_member_name(member.name, root, plan["limits"]["pathBytes"])
            target = destination / PurePosixPath(name)
            if member.isdir():
                directories.append((target, member.mode & 0o777))
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists() or target.is_symlink():
                    raise ReplayError("normalized source extraction would overwrite a path")
                stream = archive.extractfile(member)
                if stream is None:
                    raise ReplayError("normalized source member cannot be read")
                with target.open("xb") as output:
                    shutil.copyfileobj(stream, output, length=1024 * 1024)
                if target.stat().st_size != member.size:
                    raise ReplayError("normalized source member was truncated")
                target.chmod(member.mode & 0o777)
            elif member.issym():
                links.append((target, member.linkname))
            else:
                raise ReplayError("normalized source extraction encountered an unadmitted member")
    for path, linkname in links:
        if path.exists() or path.is_symlink():
            raise ReplayError("normalized source link would overwrite a path")
        path.symlink_to(linkname)
    for path, mode in sorted(directories, key=lambda item: len(item[0].parts), reverse=True):
        path.chmod(mode)
    extracted_root = destination / root
    if not extracted_root.is_dir() or extracted_root.is_symlink():
        raise ReplayError("normalized source extraction did not produce a regular root directory")
    return extracted_root


def sandbox_profile(allowed_root: Path) -> str:
    text = str(allowed_root.resolve())
    if any(character in text for character in ('"', "\\", "\n", "\r", "\x00")):
        raise ReplayError("sandbox write root cannot be represented safely")
    return (
        "(version 1)\n"
        "(allow default)\n"
        "(deny network*)\n"
        "(deny file-write* (require-all\n"
        f"  (require-not (subpath \"{text}\"))\n"
        "  (require-not (literal \"/dev/null\"))))\n"
    )


def clean_environment(output_root: Path, tool_path: str, developer_dir: str) -> dict[str, str]:
    directories = tool_path.split(":")
    if any(not value or not Path(value).is_absolute() for value in directories):
        raise ReplayError("tool path must contain only nonempty absolute directories")
    if not Path(developer_dir).is_absolute() or any(character in developer_dir for character in ("\n", "\r", "\x00")):
        raise ReplayError("developer directory must be an absolute safe path")
    return {
        "PATH": tool_path,
        "HOME": str(output_root / "launcher-home"),
        "TMPDIR": str(output_root / "launcher-tmp"),
        "XCRUN_CACHE_ROOT": str(output_root / "xcrun-cache"),
        "LANG": "C",
        "LC_ALL": "C",
        "DEVELOPER_DIR": str(developer_dir),
    }


def ensure_clean_process_environment(environment: dict[str, str]) -> None:
    forbidden = [key for key in environment if key in FORBIDDEN_ENV_NAMES or key.startswith(FORBIDDEN_ENV_PREFIXES)]
    if forbidden:
        raise ReplayError("sandbox process environment contains a forbidden override")


def _within(root: Path, path: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _selected_executable(path: Path, label: str, required_root: Path | None = None) -> dict[str, str]:
    if not path.is_absolute() or any(character in str(path) for character in ("\n", "\r", "\x00")):
        raise ReplayError(f"selected {label} path is not absolute and safe")
    try:
        real = path.resolve(strict=True)
    except OSError as error:
        raise ReplayError(f"selected {label} path cannot be resolved") from error
    if not real.is_file() or not os.access(path, os.X_OK):
        raise ReplayError(f"selected {label} path is not executable")
    if required_root is not None and not _within(required_root, real):
        raise ReplayError(f"selected {label} path is outside the selected Developer directory")
    return {
        "selectedPath": str(path),
        "realPath": str(real),
    }


def _selected_directory(path: Path, label: str, required_root: Path) -> dict[str, str]:
    if not path.is_absolute() or any(character in str(path) for character in ("\n", "\r", "\x00")):
        raise ReplayError(f"selected {label} path is not absolute and safe")
    try:
        real = path.resolve(strict=True)
    except OSError as error:
        raise ReplayError(f"selected {label} path cannot be resolved") from error
    if not real.is_dir() or not _within(required_root, real):
        raise ReplayError(f"selected {label} path is outside the selected Developer directory")
    return {
        "selectedPath": str(path),
        "realPath": str(real),
    }


def _find_path_tool(name: str, tool_path: str) -> Path:
    for directory in tool_path.split(":"):
        candidate = Path(directory) / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    raise ReplayError(f"required controlled PATH tool is unavailable: {name}")


def discover_tool_selection(
    developer_dir: Path,
    tool_path: str,
    environment: dict[str, str],
    run=subprocess.run,
) -> dict:
    try:
        developer_real = developer_dir.resolve(strict=True)
    except OSError as error:
        raise ReplayError("selected Developer directory cannot be resolved") from error
    if not developer_real.is_dir():
        raise ReplayError("selected Developer directory is not a directory")
    tools = {}
    for name in XCODE_TOOL_NAMES:
        try:
            result = run(
                ["/usr/bin/xcrun", "--find", name],
                env=environment,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=XCRUN_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as error:
            raise ReplayError(f"xcrun timed out after {XCRUN_TIMEOUT_SECONDS} seconds while selecting {name}") from error
        output = result.stdout or ""
        lines = output.splitlines()
        if result.returncode != 0 or len(lines) != 1 or not lines[0].strip():
            raise ReplayError(f"xcrun could not select the exact {name} tool")
        required_root = None if name in {"metal", "metallib"} else developer_real
        tools[name] = _selected_executable(Path(lines[0].strip()), name, required_root)
        tools[name]["selectedBy"] = "/usr/bin/xcrun"
    try:
        sdk_result = run(
            ["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-path"],
            env=environment,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=XCRUN_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        raise ReplayError(f"xcrun timed out after {XCRUN_TIMEOUT_SECONDS} seconds while selecting the macOS SDK") from error
    sdk_lines = (sdk_result.stdout or "").splitlines()
    if sdk_result.returncode != 0 or len(sdk_lines) != 1 or not sdk_lines[0].strip():
        raise ReplayError("xcrun could not select the exact macOS SDK")
    sdk = _selected_directory(Path(sdk_lines[0].strip()), "macOS SDK", developer_real)
    for name in PATH_TOOL_NAMES:
        tools[name] = _selected_executable(_find_path_tool(name, tool_path), name)
    return {
        "schemaVersion": 1,
        "developerDir": str(developer_dir),
        "developerRealPath": str(developer_real),
        "sdk": sdk,
        "toolPathEntries": tool_path.split(":"),
        "tools": tools,
        "selection": "Xcode tools, including explicit Metal compiler and linker paths, and macOS SDK selected by trusted /usr/bin/xcrun with explicit DEVELOPER_DIR and finite per-call timeout; PATH tools selected without fallback",
    }


def controller_tool_arguments(selection: dict) -> list[str]:
    tools = selection["tools"]
    mapping = (
        ("--cc", "clang"),
        ("--cxx", "clang++"),
        ("--ar", "ar"),
        ("--ranlib", "ranlib"),
        ("--nm", "nm"),
        ("--strip", "strip"),
        ("--make", "make"),
        ("--pkg-config", "pkg-config"),
        ("--metal", "metal"),
        ("--metallib", "metallib"),
    )
    arguments = []
    for flag, name in mapping:
        selected = tools.get(name, {}).get("selectedPath")
        if not selected:
            raise ReplayError(f"tool selection is missing {name}")
        arguments.extend((flag, selected))
    return arguments


def run_checked(command: list[str], *, environment: dict[str, str], log: Path | None = None) -> None:
    if log is None:
        result = subprocess.run(command, env=environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        output = result.stdout
    else:
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("x") as output_file:
            result = subprocess.run(command, env=environment, text=True, stdout=output_file, stderr=subprocess.STDOUT)
        output = ""
    if result.returncode != 0:
        raise ReplayError(f"confined command failed with status {result.returncode}: {command[0]}\n{output[-2000:]}")


def sandbox_command(profile: Path, environment: dict[str, str], wrapper: Path, arguments: list[str]) -> list[str]:
    assignments = [f"{key}={value}" for key, value in environment.items()]
    return ["/usr/bin/sandbox-exec", "-f", str(profile), "/usr/bin/env", "-i", *assignments, "/usr/bin/python3", "-I", "-B", str(wrapper), *arguments]


def internal_canary(args: argparse.Namespace) -> None:
    output = args.output_root.resolve(strict=True)
    outside = args.outside_root.resolve(strict=True)
    ensure_clean_process_environment(dict(os.environ))
    inside = output / "canary"
    inside.mkdir()
    (inside / "inside.txt").write_text("inside-write-ok\n")
    with Path("/dev/null").open("w") as sink:
        sink.write("allowed\n")

    def denied_write(path: Path) -> bool:
        try:
            path.write_text("forbidden\n")
        except OSError:
            return True
        return False

    direct_denied = denied_write(outside / "direct.txt")
    escape = inside / "outside-link"
    escape.symlink_to(outside, target_is_directory=True)
    symlink_denied = denied_write(escape / "symlink.txt")
    spawned = subprocess.run(["/bin/sh", "-c", 'printf forbidden > "$1"', "sandbox-canary", str(outside / "spawned.txt")], env=dict(os.environ))
    try:
        with socket.create_connection(("127.0.0.1", args.port), timeout=2):
            network_denied = False
    except OSError:
        network_denied = True
    receipt = {
        "insideWrite": (inside / "inside.txt").read_text() == "inside-write-ok\n",
        "devNullWrite": True,
        "outsideWriteDenied": direct_denied,
        "symlinkEscapeWriteDenied": symlink_denied,
        "spawnedOutsideWriteDenied": spawned.returncode != 0,
        "tcpConnectDenied": network_denied,
    }
    if not all(receipt.values()):
        raise ReplayError("sandbox confinement canary failed")
    write_json(output / "CONFINEMENT-CANARY.json", receipt)


def run_phase(command: list[str], environment: dict[str, str], log: Path) -> None:
    run_checked(command, environment=environment, log=log)


def internal_postbuild(args: argparse.Namespace) -> None:
    ensure_clean_process_environment(dict(os.environ))
    output = args.output_root.resolve(strict=True)
    source = args.source_root.resolve(strict=True)
    project = args.project_root.resolve(strict=True)
    controller = args.controller_root.resolve(strict=True)
    node = args.node.resolve(strict=True)
    child = output / "replay-arm64-macos11"
    if not child.is_dir():
        raise ReplayError("controller did not produce the expected owned replay child")
    logs = child / "logs"
    logs.mkdir()
    stage = child / "staged-runtime"
    run_phase([str(node), str(project / "scripts/stage_macos_media_runtime.mjs"), str(child / "install/arm64"), str(stage), EXPECTED_ARCH], dict(os.environ), logs / "stage.log")

    app = child / "minimum-fixture/ReplayMinimum.app"
    contents = app / "Contents"
    (contents / "MacOS").mkdir(parents=True)
    shutil.copy2(child / "install/arm64/bin/ffmpeg", contents / "MacOS/ReplayMinimum")
    shutil.copytree(stage / "Frameworks", contents / "Frameworks", symlinks=True)
    shutil.copytree(stage / "ffmpeg", contents / "Resources/ffmpeg/darwin-arm64", symlinks=True)
    with (contents / "Info.plist").open("wb") as handle:
        plistlib.dump({"CFBundleExecutable": "ReplayMinimum", "LSMinimumSystemVersion": EXPECTED_TARGET}, handle)
    run_phase([str(node), str(project / "scripts/check_macos_bundle_minimum.mjs"), str(app)], dict(os.environ), logs / "minimum.log")
    run_phase([str(node), str(project / "scripts/smoke_macos_media_runtime.mjs"), str(stage), str(child / "media-smoke")], dict(os.environ), logs / "media-smoke.log")
    write_json(child / "EXPERIMENT-RESULTS.json", {
        "schemaVersion": 1,
        "result": "pass",
        "scope": "one headless ARM macOS 15 source replay; no equivalence, older-OS, onscreen, provider, publication, or licensing claim",
        "controllerStatus": load_json(child / "STATUS.json"),
        "installAudit": load_json(child / "INSTALL-AUDIT.json"),
        "mediaSmoke": load_json(child / "media-smoke/RESULTS.json"),
        "minimumFixture": str(app.relative_to(child)),
    })


def invoke_sandbox(profile: Path, environment: dict[str, str], wrapper: Path, arguments: list[str], log: Path) -> None:
    run_checked(sandbox_command(profile, environment, wrapper, arguments), environment={}, log=log)


def main_run(args: argparse.Namespace) -> None:
    if sys.platform != "darwin" or os.uname().machine != "arm64":
        raise ReplayError("experiment requires a native ARM macOS runner")
    project = args.project_root.resolve(strict=True)
    controller = args.controller_root.resolve(strict=True)
    wrapper = Path(__file__).resolve(strict=True)
    pins = load_json(controller / "experiment-pins.json")
    if pins.get("schemaVersion") != 1 or pins["artifact"]["runId"] != "39304293958" or pins["artifact"]["name"] != "macos-media-runtime-arm64":
        raise ReplayError("experiment artifact binding is not exact")
    observed_controls = verify_pinned_files(project, pins)
    normalizer_plan = load_json(controller / "archive-normalizer-plan.json")
    if normalizer_plan.get("inputArchiveSha256") != pins["source"]["sha256"]:
        raise ReplayError("normalizer source pin differs from the experiment source pin")
    workspace = args.workspace.resolve()
    if workspace.exists():
        if not workspace.is_dir() or any(workspace.iterdir()):
            raise ReplayError("experiment workspace must be absent or empty")
    else:
        workspace.mkdir(parents=True)
    receipts = workspace / "receipts"
    receipts.mkdir()
    input_dir = workspace / "source-input"
    input_dir.mkdir()
    source_archive = input_dir / Path(pins["source"]["member"]).name
    transport = extract_pinned_source(args.candidate_dir.resolve(strict=True), source_archive, pins)
    write_json(receipts / "01-transport.json", transport)
    normalized = workspace / "normalized-source.tar.gz"
    normalizer = subprocess.run([
        "/usr/bin/python3", "-I", "-B", str(controller / "normalize_source_archive.py"),
        "--input", str(source_archive), "--output", str(normalized),
        "--plan", str(controller / "archive-normalizer-plan.json"),
        "--controller-root", str(controller), "--project-root", str(project),
    ], env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(workspace / "normalizer-home"), "TMPDIR": str(workspace / "normalizer-tmp"), "LANG": "C", "LC_ALL": "C"}, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if normalizer.returncode != 0:
        raise ReplayError(f"source normalization failed: {normalizer.stdout[-2000:]}")
    normalization = json.loads(normalizer.stdout)
    if normalization.get("regularFilesPreserved") != pins["source"]["preservedRegularFiles"] or normalization.get("regularBytesPreserved") != pins["source"]["preservedRegularBytes"] or normalization.get("linksNormalized") != pins["source"]["normalizedLinks"]:
        raise ReplayError("source normalization preservation receipt changed")
    admission = admit_normalized_archive(normalized, normalizer_plan)
    if admission["archiveSha256"] == pins["referenceOnlyFrozenNormalizedSha256"]:
        raise ReplayError("sanitized staged controls unexpectedly reproduced the frozen private normalized archive hash")
    write_json(receipts / "02-normalization.json", {
        "normalization": normalization,
        "freshAdmission": admission,
        "frozenNormalizedReferenceOnly": pins["referenceOnlyFrozenNormalizedSha256"],
    })
    extracted_parent = workspace / "extracted"
    source_root = extract_admitted_archive(normalized, extracted_parent, normalizer_plan)
    verify = subprocess.run([str(args.node), str(controller / "replay_macos_media_sources.mjs"), "verify", "--source-root", str(source_root)], env={"PATH": args.tool_path, "HOME": str(workspace / "verify-home"), "TMPDIR": str(workspace / "verify-tmp"), "LANG": "C", "LC_ALL": "C"}, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if verify.returncode != 0:
        raise ReplayError(f"controller rejected safely extracted source: {verify.stdout[-2000:]}")
    write_json(receipts / "03-source-verification.json", {
        "result": "pass",
        "sourceInventorySha256": sha256_file(source_root / "SOURCE-INVENTORY.json"),
        "controlHashes": observed_controls,
    })

    output = workspace / "owned-output"
    trusted_logs = workspace / "trusted-logs"
    trusted_logs.mkdir()
    trusted_init_environment = clean_environment(workspace / "trusted-init-state", args.tool_path, args.developer_dir)
    ensure_clean_process_environment(trusted_init_environment)
    for key in ("HOME", "TMPDIR", "XCRUN_CACHE_ROOT"):
        Path(trusted_init_environment[key]).mkdir(parents=True, exist_ok=True)
    run_checked([str(args.node), str(controller / "replay_macos_media_sources.mjs"), "init", "--output-root", str(output)], environment=trusted_init_environment, log=trusted_logs / "init.log")
    tool_selection = discover_tool_selection(Path(args.developer_dir), args.tool_path, trusted_init_environment)
    write_json(receipts / "05-toolchain-selection.json", tool_selection)
    selected_sdk = tool_selection["sdk"]["selectedPath"]

    child = output / "replay-arm64-macos11"
    xcrun_wrapper_root = workspace / "tool-wrappers"
    xcrun_wrapper_root.mkdir()
    xcrun = xcrun_wrapper_root / "xcrun"
    xcrun.write_text(f"#!/bin/sh\nmkdir -p '{child / 'xcrun-cache'}'\nXCRUN_CACHE_ROOT='{child / 'xcrun-cache'}' exec /usr/bin/xcrun \"$@\"\n")
    xcrun.chmod(0o755)
    environment = clean_environment(child, f"{xcrun_wrapper_root}:{args.tool_path}", args.developer_dir)
    ensure_clean_process_environment(environment)

    outside = workspace / "outside"
    outside.mkdir()
    sentinel = outside / "sentinel.txt"
    sentinel.write_text("outside-sentinel\n")
    preserved = {"sentinel": sha256_file(sentinel), "sourceArchive": sha256_file(source_archive), "normalizedArchive": sha256_file(normalized), "sourceInventory": sha256_file(source_root / "SOURCE-INVENTORY.json")}
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(2)
    port = server.getsockname()[1]
    with socket.create_connection(("127.0.0.1", port), timeout=2):
        control, _address = server.accept()
        control.close()
    canary_child = output / "canary-child"
    canary_child.mkdir()
    sibling_sentinel = output / "sandbox-sibling-sentinel.txt"
    sibling_sentinel.write_text("sandbox-sibling-sentinel\n")
    canary_profile = workspace / "canary.sb"
    canary_profile.write_text(sandbox_profile(canary_child))
    canary_environment = clean_environment(canary_child, environment["PATH"], args.developer_dir)
    invoke_sandbox(canary_profile, canary_environment, wrapper, ["--internal-canary", "--output-root", str(canary_child), "--outside-root", str(output), "--port", str(port)], trusted_logs / "canary.log")
    server.close()
    canary = load_json(canary_child / "CONFINEMENT-CANARY.json")
    if not all(canary.values()) or sibling_sentinel.read_text() != "sandbox-sibling-sentinel\n":
        raise ReplayError("confinement canary receipt is incomplete")
    write_json(receipts / "04-confinement.json", {
        **canary,
        "allowedWriteRoot": str(canary_child),
        "deniedSiblingRoot": str(output),
        "outsideControl": "loopback TCP connection accepted before sandbox denial check",
    })

    build_profile = workspace / "build.sb"
    build_profile.write_text(sandbox_profile(child))
    controller_mode = "probe" if args.probe_only else "build"
    build_command = [
        "/usr/bin/sandbox-exec", "-f", str(build_profile), "/usr/bin/env", "-i",
        *[f"{key}={value}" for key, value in environment.items()],
        str(args.node), str(controller / "replay_macos_media_sources.mjs"), controller_mode,
        "--output-root", str(output), "--arch", EXPECTED_ARCH,
        "--jobs", str(args.jobs), "--sdk", selected_sdk, "--tool-path", environment["PATH"],
        *controller_tool_arguments(tool_selection),
    ]
    if not args.probe_only:
        build_command.extend(("--source-root", str(source_root)))
    run_checked(build_command, environment={}, log=trusted_logs / "controller-build.log")
    toolchain_probe = load_json(child / "TOOLCHAIN-PROBE.json")
    if toolchain_probe.get("result") != "pass" or toolchain_probe.get("shimDenialsObserved") is not False:
        raise ReplayError("toolchain probe receipt did not record a clean pass")
    if not args.probe_only:
        invoke_sandbox(build_profile, environment, wrapper, [
            "--internal-postbuild", "--output-root", str(output), "--source-root", str(source_root),
            "--project-root", str(project), "--controller-root", str(controller), "--node", str(args.node),
            "--tool-path", environment["PATH"], "--jobs", str(args.jobs),
        ], trusted_logs / "postbuild.log")
    after = {"sentinel": sha256_file(sentinel), "sourceArchive": sha256_file(source_archive), "normalizedArchive": sha256_file(normalized), "sourceInventory": sha256_file(source_root / "SOURCE-INVENTORY.json")}
    if preserved != after or any(path.name != "sentinel.txt" for path in outside.iterdir()):
        raise ReplayError("confined replay changed an outside sentinel or source input")
    if args.probe_only:
        write_json(output / "PROBE-ONLY-RECEIPT.json", {
            "schemaVersion": 1,
            "result": "pass",
            "scope": "same-profile ARM macOS toolchain probe only; no package replay, artifact equivalence, publication, signing, or licensing claim",
            "transport": transport,
            "normalization": normalization,
            "freshAdmission": admission,
            "controlHashes": observed_controls,
            "confinement": canary,
            "toolchainSelection": tool_selection,
            "toolchainProbe": toolchain_probe,
            "outsideAndSourceInputsPreserved": True,
        })
        return
    write_json(output / "PREPARATION-RECEIPT.json", {
        "schemaVersion": 1,
        "result": "pass",
        "scope": pins["scope"],
        "transport": transport,
        "normalization": normalization,
        "freshAdmission": admission,
        "frozenNormalizedReferenceOnly": pins["referenceOnlyFrozenNormalizedSha256"],
        "controlHashes": observed_controls,
        "confinement": canary,
        "toolchainSelection": tool_selection,
        "toolchainProbe": toolchain_probe,
        "outsideControl": "loopback TCP connection accepted before sandbox denial check",
        "outsideAndSourceInputsPreserved": True,
    })


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    mode = value.add_mutually_exclusive_group()
    mode.add_argument("--internal-canary", action="store_true", help=argparse.SUPPRESS)
    mode.add_argument("--internal-postbuild", action="store_true", help=argparse.SUPPRESS)
    value.add_argument("--candidate-dir", type=Path)
    value.add_argument("--workspace", type=Path)
    value.add_argument("--project-root", type=Path)
    value.add_argument("--controller-root", type=Path)
    value.add_argument("--output-root", type=Path)
    value.add_argument("--outside-root", type=Path)
    value.add_argument("--source-root", type=Path)
    value.add_argument("--node", type=Path)
    value.add_argument("--developer-dir")
    value.add_argument("--tool-path")
    value.add_argument("--jobs", type=int, default=8)
    value.add_argument("--port", type=int)
    value.add_argument("--probe-only", action="store_true")
    return value


def entrypoint() -> None:
    args = parser().parse_args()
    if args.internal_canary:
        internal_canary(args)
    elif args.internal_postbuild:
        internal_postbuild(args)
    else:
        required = [args.candidate_dir, args.workspace, args.project_root, args.controller_root, args.node, args.developer_dir, args.tool_path]
        if any(value is None for value in required) or not 1 <= args.jobs <= 16:
            raise ReplayError("experiment arguments are incomplete or invalid")
        main_run(args)


if __name__ == "__main__":
    try:
        entrypoint()
    except (ReplayError, OSError, tarfile.TarError, json.JSONDecodeError, KeyError, ValueError) as error:
        raise SystemExit(f"macOS media replay experiment: {error}")
