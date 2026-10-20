#!/usr/bin/env python3
"""Prepare exact replay source and build one unsigned native shipping runtime."""

import argparse
import importlib.util
import json
import os
import plistlib
import shutil
import socket
import stat
import subprocess
import sys
from pathlib import Path, PurePosixPath

_REPLAY_SPEC = importlib.util.spec_from_file_location("macos_replay_support", Path(__file__).resolve().with_name("run_macos_media_replay_experiment.py"))
if _REPLAY_SPEC is None or _REPLAY_SPEC.loader is None:
    raise RuntimeError("shared replay support cannot be loaded")
replay = importlib.util.module_from_spec(_REPLAY_SPEC)
_REPLAY_SPEC.loader.exec_module(replay)


HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
CONTROLLER = PROJECT / "scripts/macos-media-replay"
PINS = CONTROLLER / "shipping-source-pins.json"
TARGET = "11.0"
VALID_ARCHES = {"arm64", "x86_64"}


class ProductionError(RuntimeError):
    pass


def load(path: Path) -> dict:
    return json.loads(path.read_text())


def digest(path: Path) -> str:
    return replay.sha256_file(path)


def write_json(path: Path, value: object) -> None:
    replay.write_json(path, value)


def safe_relative(value: str, label: str) -> str:
    if not value or value.startswith("/") or "\\" in value or "\x00" in value:
        raise ProductionError(f"{label} is unsafe")
    path = PurePosixPath(value)
    if str(path) != value or any(part in ("", ".", "..") for part in path.parts):
        raise ProductionError(f"{label} is unsafe")
    return value


def pinned_source() -> dict:
    pins = load(PINS)
    if pins.get("schemaVersion") != 1:
        raise ProductionError("shipping source pins have an unsupported schema")
    artifact = pins.get("artifact", {})
    source = pins.get("source", {})
    if artifact.get("repository") != "Tgk-30/YAWF-Stream" or artifact.get("runId") != "39304293958" or artifact.get("name") != "macos-media-runtime-arm64":
        raise ProductionError("shipping source transport is not exactly pinned")
    for value in (artifact.get("outerSha256"), source.get("sha256")):
        if not isinstance(value, str) or len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
            raise ProductionError("shipping source digest is invalid")
    safe_relative(artifact.get("outerFile", ""), "outer source file")
    safe_relative(source.get("member", ""), "inner source member")
    return pins


def prepare_source(candidate_dir: Path, output_dir: Path) -> dict:
    pins = pinned_source()
    candidate = candidate_dir.resolve(strict=True)
    output = output_dir.resolve()
    if output.exists():
        if not output.is_dir() or any(output.iterdir()):
            raise ProductionError("source output must be absent or empty")
    else:
        output.mkdir(parents=True)
    seed = output / "source-seed.tar.gz"
    transport = replay.extract_pinned_source(candidate, seed, pins)
    temporary = output / "normalized-source.pending.tar.gz"
    normalizer = subprocess.run([
        "/usr/bin/python3", "-I", "-B", str(CONTROLLER / "normalize_source_archive.py"),
        "--input", str(seed), "--output", str(temporary),
        "--plan", str(CONTROLLER / "archive-normalizer-plan.json"),
        "--controller-root", str(CONTROLLER), "--project-root", str(PROJECT),
    ], env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(output / "home"), "TMPDIR": str(output), "LANG": "C", "LC_ALL": "C"}, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if normalizer.returncode != 0:
        raise ProductionError(f"source normalization failed: {normalizer.stdout[-2000:]}")
    normalization = json.loads(normalizer.stdout)
    expected = pins["source"]
    if normalization.get("regularFilesPreserved") != expected["preservedRegularFiles"] or normalization.get("regularBytesPreserved") != expected["preservedRegularBytes"] or normalization.get("linksNormalized") != expected["normalizedLinks"]:
        raise ProductionError("source normalization preservation contract changed")
    admission = replay.admit_normalized_archive(temporary, load(CONTROLLER / "archive-normalizer-plan.json"))
    archive_hash = admission["archiveSha256"]
    archive_name = f"yawf-macos-media-runtime-source-{archive_hash}.tar.gz"
    archive = output / archive_name
    os.replace(temporary, archive)
    seed.unlink()
    receipt = {
        "schemaVersion": 1,
        "result": "pass",
        "licensingCleared": False,
        "archiveFile": archive_name,
        "archiveSha256": archive_hash,
        "archiveBytes": archive.stat().st_size,
        "sourceSeed": transport,
        "normalization": normalization,
        "admission": admission,
        "scope": "Exact normalized corresponding source and owned controls; no binary, publication, or licensing-clearance claim",
    }
    write_json(output / "SOURCE-RECEIPT.json", receipt)
    return receipt


def admitted_source(source_dir: Path, workspace: Path) -> tuple[Path, Path, dict]:
    directory = source_dir.resolve(strict=True)
    receipt_path = directory / "SOURCE-RECEIPT.json"
    if receipt_path.is_symlink() or not receipt_path.is_file():
        raise ProductionError("source receipt is missing")
    receipt = load(receipt_path)
    archive_name = safe_relative(receipt.get("archiveFile", ""), "normalized source archive")
    expected_hash = receipt.get("archiveSha256")
    if receipt.get("schemaVersion") != 1 or receipt.get("result") != "pass" or receipt.get("licensingCleared") is not False or not isinstance(expected_hash, str):
        raise ProductionError("normalized source receipt is invalid")
    if archive_name != f"yawf-macos-media-runtime-source-{expected_hash}.tar.gz":
        raise ProductionError("normalized source archive is not content-addressed")
    archive = directory / archive_name
    if archive.is_symlink() or not archive.is_file() or digest(archive) != expected_hash or archive.stat().st_size != receipt.get("archiveBytes"):
        raise ProductionError("normalized source archive differs from its receipt")
    plan = load(CONTROLLER / "archive-normalizer-plan.json")
    admission = replay.admit_normalized_archive(archive, plan)
    if admission.get("archiveSha256") != expected_hash:
        raise ProductionError("normalized source admission digest differs from its receipt")
    source_root = replay.extract_admitted_archive(archive, workspace / "extracted", plan)
    return source_root, archive, receipt


def inventory_tree(root: Path) -> list[dict]:
    canonical = root.resolve(strict=True)
    entries = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            continue
        if stat.S_ISLNK(info.st_mode):
            resolved = path.resolve(strict=True)
            try:
                resolved.relative_to(canonical)
            except ValueError as error:
                raise ProductionError("install inventory symlink escapes its prefix") from error
            entries.append({"path": relative, "type": "symlink", "target": os.readlink(path)})
        elif stat.S_ISREG(info.st_mode):
            entries.append({"path": relative, "type": "file", "bytes": info.st_size, "sha256": digest(path)})
        else:
            raise ProductionError("install inventory contains a special file")
    return entries


def validate_controller_receipts(source_root: Path, child: Path, arch: str) -> dict:
    plan = load(source_root / "replay-controls/replay-plan.json")
    status = load(child / "STATUS.json")
    audit = load(child / "INSTALL-AUDIT.json")
    expected_ids = [entry["id"] for entry in plan.get("packages", [])]
    packages = audit.get("packages", [])
    if status != {"schemaVersion": 1, "result": "pass", "packages": 33, "arch": arch, "target": TARGET} or len(expected_ids) != 33:
        raise ProductionError("controller status is not a complete 33-package pass")
    if [entry.get("package") for entry in packages] != expected_ids:
        raise ProductionError("controller install audit does not cover the exact package plan")
    changed = set()
    for entry in packages:
        if entry.get("removedMachO") != [] or not isinstance(entry.get("changedMachO"), list):
            raise ProductionError("controller install audit records a removal or malformed change")
        changed.update(entry["changedMachO"])
    if not packages or packages[-1].get("afterMachO") != len(changed):
        raise ProductionError("controller audit does not account for every final Mach-O")
    probe = load(child / "TOOLCHAIN-PROBE.json")
    if probe.get("result") != "pass" or probe.get("shimDenialsObserved") is not False:
        raise ProductionError("controller toolchain probe is not a clean pass")
    return {"status": status, "audit": audit, "toolchainProbe": probe, "machOFilesAudited": len(changed)}


def required_shipping_files(source_root: Path) -> tuple[set[str], set[str]]:
    contract = load(source_root / "replay-controls/required-runtime-outputs.json")
    outputs = contract.get("outputs", [])
    if contract.get("schemaVersion") != 1 or len(outputs) != 57 or len(set(outputs)) != 57:
        raise ProductionError("shipping output contract must contain 57 unique files")
    libraries = {f"Frameworks/{Path(path).name}" for path in outputs if path.startswith("lib/")}
    programs = {f"ffmpeg/{Path(path).name}" for path in outputs if path.startswith("bin/")}
    if len(libraries) != 55 or programs != {"ffmpeg/ffmpeg", "ffmpeg/ffprobe"}:
        raise ProductionError("shipping output contract has an unexpected shape")
    return libraries, programs


def validate_prefix_and_stage(source_root: Path, prefix: Path, stage: Path) -> dict:
    contract = load(source_root / "replay-controls/required-runtime-outputs.json")
    for relative in contract["outputs"]:
        path = prefix / safe_relative(relative, "required runtime output")
        if path.is_symlink() or not path.is_file():
            raise ProductionError(f"required runtime output is absent or aliased: {relative}")
    expected = set().union(*required_shipping_files(source_root))
    actual = set()
    for directory in (stage / "Frameworks", stage / "ffmpeg"):
        for path in directory.rglob("*"):
            if path.is_file() and not path.is_symlink():
                actual.add(path.relative_to(stage).as_posix())
    if actual != expected:
        raise ProductionError("staged runtime is not the exact 57-file shipping closure")
    alias = stage / "Frameworks/libmpv.dylib"
    if not alias.is_symlink() or alias.resolve(strict=True).parent != (stage / "Frameworks").resolve():
        raise ProductionError("staged libmpv compatibility alias is invalid")
    return {"regularFiles": len(actual), "paths": sorted(actual)}


def run_phase(command: list[str], environment: dict[str, str], log: Path) -> None:
    replay.run_checked(command, environment=environment, log=log)


def internal_postbuild(args: argparse.Namespace) -> None:
    replay.ensure_clean_process_environment(dict(os.environ))
    output = args.output_root.resolve(strict=True)
    source_root = args.source_root.resolve(strict=True)
    source_archive = args.source_archive.resolve(strict=True)
    node = args.node.resolve(strict=True)
    arch = args.arch
    child = output / f"replay-{arch}-macos11"
    prefix = child / "install" / arch
    receipts = validate_controller_receipts(source_root, child, arch)
    inventory = inventory_tree(prefix)
    write_json(child / "INSTALL-INVENTORY.json", {"schemaVersion": 1, "arch": arch, "target": TARGET, "entries": inventory})
    logs = child / "logs"
    logs.mkdir(exist_ok=True)
    stage = child / "media-candidate"
    support = source_root / "replay-support/scripts"
    run_phase([str(node), str(support / "stage_macos_media_runtime.mjs"), str(prefix), str(stage), arch], dict(os.environ), logs / "stage.log")
    shipping = validate_prefix_and_stage(source_root, prefix, stage)

    fixture = child / "minimum-fixture/ReplayMinimum.app/Contents"
    (fixture / "MacOS").mkdir(parents=True)
    shutil.copy2(prefix / "bin/ffmpeg", fixture / "MacOS/ReplayMinimum")
    shutil.copytree(stage / "Frameworks", fixture / "Frameworks", symlinks=True)
    platform = "darwin-arm64" if arch == "arm64" else "darwin-x64"
    shutil.copytree(stage / "ffmpeg", fixture / f"Resources/ffmpeg/{platform}", symlinks=True)
    with (fixture / "Info.plist").open("wb") as handle:
        plistlib.dump({"CFBundleExecutable": "ReplayMinimum", "LSMinimumSystemVersion": TARGET}, handle)
    run_phase([str(node), str(support / "check_macos_bundle_minimum.mjs"), str(fixture.parent)], dict(os.environ), logs / "minimum.log")
    smoke = child / "media-smoke"
    run_phase([str(node), str(support / "smoke_macos_media_runtime.mjs"), str(stage), str(smoke)], dict(os.environ), logs / "media-smoke.log")
    smoke_receipt = load(smoke / "RESULTS.json")
    if smoke_receipt.get("result") != "pass" or smoke_receipt.get("architecture") != arch:
        raise ProductionError("natural media runtime smoke did not pass for the native architecture")

    source_hash = digest(source_archive)
    controls = source_root / "OWNED-FILE-MANIFEST.json"
    confinement = load(child / "CONFINEMENT.json")
    if confinement.get("sameProfileNetworkDenied") is not True or confinement.get("sameProfileOutsideWriteDenied") is not True:
        raise ProductionError("shipping provenance lacks passed confinement controls")
    provenance = {
        "schemaVersion": 2,
        "architecture": arch,
        "target": TARGET,
        "licensingCleared": False,
        "sourceBundle": {"file": source_archive.name, "bytes": source_archive.stat().st_size, "sha256": source_hash},
        "sourceInventorySha256": digest(source_root / "SOURCE-INVENTORY.json"),
        "ownedControlManifestSha256": digest(controls),
        "controllerStatusSha256": digest(child / "STATUS.json"),
        "installAuditSha256": digest(child / "INSTALL-AUDIT.json"),
        "installInventorySha256": digest(child / "INSTALL-INVENTORY.json"),
        "toolchainProbeSha256": digest(child / "TOOLCHAIN-PROBE.json"),
        "relocationSha256": digest(stage / "relocation.json"),
        "smokeReceiptSha256": digest(smoke / "RESULTS.json"),
        "packagesAudited": 33,
        "machOFilesAudited": receipts["machOFilesAudited"],
        "shippingRegularFiles": shipping["regularFiles"],
        "networkDeniedDuringBuildStageAndSmoke": True,
        "outsideWritesDeniedDuringBuildStageAndSmoke": True,
        "dyldEnvironmentUsed": False,
        "signingPerformed": "ad-hoc relocation signatures only; Developer ID signing is a separate release step",
        "scope": "Unsigned native runtime rebuilt by the independent bundled controller; no older-OS, publication, binary-equivalence, or licensing-clearance claim",
    }
    provenance_path = child / f"macos-media-provenance-{arch}.json"
    write_json(provenance_path, provenance)
    run_phase([str(node), str(support / "prepare_macos_replay_notices.mjs"), str(source_root), str(provenance_path), str(stage / "notices")], dict(os.environ), logs / "notices.log")
    (stage / "source").mkdir()
    shutil.copy2(source_archive, stage / "source" / source_archive.name)
    shutil.copy2(provenance_path, stage / "source" / provenance_path.name)
    write_json(child / "SHIPPING-RESULTS.json", {"schemaVersion": 1, "result": "pass", "arch": arch, "target": TARGET, "shippingRegularFiles": 57, "sourceSha256": source_hash})


def build_runtime(source_dir: Path, workspace_input: Path, arch: str, jobs: int, node_input: Path, tool_path: str, developer_dir: str) -> dict:
    if sys.platform != "darwin" or arch not in VALID_ARCHES or (os.uname().machine == "x86_64" and arch != "x86_64") or (os.uname().machine == "arm64" and arch != "arm64"):
        raise ProductionError("shipping replay requires a matching native macOS architecture")
    if jobs < 1 or jobs > 16:
        raise ProductionError("jobs must be from 1 through 16")
    workspace = workspace_input.resolve()
    if workspace.exists():
        if not workspace.is_dir() or any(workspace.iterdir()):
            raise ProductionError("shipping workspace must be absent or empty")
    else:
        workspace.mkdir(parents=True)
    source_root, archive, source_receipt = admitted_source(source_dir, workspace)
    bundled = source_root / "replay-controls"
    for local, name in [(Path(__file__).resolve(), "produce_macos_media_runtime.py"), (Path(replay.__file__).resolve(), "run_macos_media_replay_experiment.py")]:
        if digest(local) != digest(bundled / name):
            raise ProductionError("executing producer control differs from corresponding source")
    controller = bundled / "replay_macos_media_sources.mjs"
    verify = subprocess.run([str(node_input), str(controller), "verify", "--source-root", str(source_root)], env={"PATH": tool_path, "HOME": str(workspace / "verify-home"), "TMPDIR": str(workspace), "LANG": "C", "LC_ALL": "C"}, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if verify.returncode != 0:
        raise ProductionError(f"controller rejected admitted source: {verify.stdout[-2000:]}")

    output = workspace / "owned-output"
    logs = workspace / "trusted-logs"
    logs.mkdir()
    init_env = replay.clean_environment(workspace / "trusted-init", tool_path, developer_dir)
    for key in ("HOME", "TMPDIR", "XCRUN_CACHE_ROOT"):
        Path(init_env[key]).mkdir(parents=True, exist_ok=True)
    replay.run_checked([str(node_input), str(controller), "init", "--output-root", str(output)], environment=init_env, log=logs / "init.log")
    tools = replay.discover_tool_selection(Path(developer_dir), tool_path, init_env)
    child = output / f"replay-{arch}-macos11"
    wrappers = workspace / "tool-wrappers"
    wrappers.mkdir()
    xcrun = wrappers / "xcrun"
    xcrun.write_text(f"#!/bin/sh\nmkdir -p '{child / 'xcrun-cache'}'\nXCRUN_CACHE_ROOT='{child / 'xcrun-cache'}' exec /usr/bin/xcrun \"$@\"\n")
    xcrun.chmod(0o755)
    environment = replay.clean_environment(child, f"{wrappers}:{tool_path}", developer_dir)
    replay.ensure_clean_process_environment(environment)

    outside = workspace / "outside"
    outside.mkdir()
    sentinel = outside / "sentinel.txt"
    sentinel.write_text("outside-sentinel\n")
    preserved = {"source": digest(archive), "sentinel": digest(sentinel)}
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0)); server.listen(2)
    port = server.getsockname()[1]
    with socket.create_connection(("127.0.0.1", port), timeout=2):
        connection, _ = server.accept(); connection.close()
    canary_child = output / "canary-child"; canary_child.mkdir()
    canary_profile = workspace / "canary.sb"; canary_profile.write_text(replay.sandbox_profile(canary_child))
    canary_env = replay.clean_environment(canary_child, environment["PATH"], developer_dir)
    bundled_wrapper = bundled / "produce_macos_media_runtime.py"
    replay.invoke_sandbox(canary_profile, canary_env, bundled_wrapper, ["--internal-canary", "--output-root", str(canary_child), "--outside-root", str(output), "--port", str(port)], logs / "canary.log")
    server.close()
    canary = load(canary_child / "CONFINEMENT-CANARY.json")
    if not all(canary.values()):
        raise ProductionError("network and write confinement canary failed")

    profile = workspace / "build.sb"; profile.write_text(replay.sandbox_profile(child))
    build = [
        "/usr/bin/sandbox-exec", "-f", str(profile), "/usr/bin/env", "-i", *[f"{key}={value}" for key, value in environment.items()],
        str(node_input), str(controller), "build", "--output-root", str(output), "--arch", arch, "--jobs", str(jobs),
        "--sdk", tools["sdk"]["selectedPath"], "--tool-path", environment["PATH"], *replay.controller_tool_arguments(tools),
        "--source-root", str(source_root),
    ]
    replay.run_checked(build, environment={}, log=logs / "controller-build.log")
    write_json(child / "CONFINEMENT.json", {"sameProfileNetworkDenied": canary["tcpConnectDenied"], "sameProfileOutsideWriteDenied": all(canary[key] for key in ("outsideWriteDenied", "symlinkEscapeWriteDenied", "spawnedOutsideWriteDenied")), "sandboxProfileSha256": digest(profile)})
    replay.invoke_sandbox(profile, environment, bundled_wrapper, [
        "--internal-postbuild", "--output-root", str(output), "--source-root", str(source_root), "--source-archive", str(archive),
        "--arch", arch, "--node", str(node_input),
    ], logs / "postbuild.log")
    if preserved != {"source": digest(archive), "sentinel": digest(sentinel)} or any(path.name != "sentinel.txt" for path in outside.iterdir()):
        raise ProductionError("confined producer changed a source or outside sentinel")
    results = load(child / "SHIPPING-RESULTS.json")
    if results.get("result") != "pass":
        raise ProductionError("shipping results did not pass")
    return {"root": str(child), "stage": str(child / "media-candidate"), "source": str(archive), "sourceSha256": source_receipt["archiveSha256"], "provenance": str(child / f"macos-media-provenance-{arch}.json")}


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    modes = value.add_mutually_exclusive_group(required=True)
    modes.add_argument("--prepare-source", action="store_true")
    modes.add_argument("--build", action="store_true")
    modes.add_argument("--internal-canary", action="store_true", help=argparse.SUPPRESS)
    modes.add_argument("--internal-postbuild", action="store_true", help=argparse.SUPPRESS)
    value.add_argument("--candidate-dir", type=Path)
    value.add_argument("--output-dir", type=Path)
    value.add_argument("--source-dir", type=Path)
    value.add_argument("--source-root", type=Path)
    value.add_argument("--source-archive", type=Path)
    value.add_argument("--workspace", type=Path)
    value.add_argument("--output-root", type=Path)
    value.add_argument("--outside-root", type=Path)
    value.add_argument("--arch", choices=sorted(VALID_ARCHES))
    value.add_argument("--jobs", type=int, default=8)
    value.add_argument("--node", type=Path)
    value.add_argument("--tool-path")
    value.add_argument("--developer-dir")
    value.add_argument("--port", type=int)
    value.add_argument("--github-output", type=Path)
    return value


def main() -> None:
    args = parser().parse_args()
    if args.internal_canary:
        replay.internal_canary(args); return
    if args.internal_postbuild:
        if not all((args.output_root, args.source_root, args.source_archive, args.arch, args.node)):
            raise ProductionError("internal postbuild arguments are incomplete")
        internal_postbuild(args); return
    if args.prepare_source:
        if not args.candidate_dir or not args.output_dir:
            raise ProductionError("source preparation requires candidate and output directories")
        result = prepare_source(args.candidate_dir, args.output_dir)
        outputs = {"archive_sha256": result["archiveSha256"], "archive_file": result["archiveFile"]}
    else:
        if not all((args.source_dir, args.workspace, args.arch, args.node, args.tool_path, args.developer_dir)):
            raise ProductionError("shipping build arguments are incomplete")
        result = build_runtime(args.source_dir, args.workspace, args.arch, args.jobs, args.node, args.tool_path, args.developer_dir)
        outputs = {"root": result["root"], "stage": result["stage"], "source": result["source"], "source_sha256": result["sourceSha256"], "provenance": result["provenance"]}
    if args.github_output:
        with args.github_output.open("a") as handle:
            for key, value in outputs.items(): handle.write(f"{key}={value}\n")
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (ProductionError, replay.ReplayError, OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"macOS media shipping producer: {error}", file=sys.stderr)
        raise SystemExit(1)
