import hashlib
import importlib.util
import io
import json
import os
import tarfile
import tempfile
import unittest
import subprocess
from pathlib import Path


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("replay_experiment", HERE / "run_macos_media_replay_experiment.py")
REPLAY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REPLAY)
PUBLIC_ROOT = HERE.parents[1]


def add_bytes(archive, name, data):
    member = tarfile.TarInfo(name)
    member.size = len(data)
    member.mode = 0o755 if name.endswith("configure") else 0o644
    archive.addfile(member, io.BytesIO(data))


class ReplayExperimentTests(unittest.TestCase):
    def test_extracts_only_the_exact_pinned_inner_source_after_outer_hash_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = root / "candidate"
            candidate.mkdir()
            inner = b"pinned-source-bytes"
            outer = candidate / "candidate.tar.gz"
            with tarfile.open(outer, "w:gz") as archive:
                add_bytes(archive, "source/pinned.tar.gz", inner)
                add_bytes(archive, "unrelated.txt", b"not extracted")
            outer_sha = REPLAY.sha256_file(outer)
            (candidate / "candidate.tar.gz.sha256").write_text(f"{outer_sha}  candidate.tar.gz\n")
            pins = {
                "artifact": {"outerFile": "candidate.tar.gz", "outerSha256": outer_sha},
                "source": {"member": "source/pinned.tar.gz", "sha256": hashlib.sha256(inner).hexdigest()},
            }
            destination = root / "input/pinned.tar.gz"
            receipt = REPLAY.extract_pinned_source(candidate, destination, pins)
            self.assertEqual(destination.read_bytes(), inner)
            self.assertEqual(receipt["sourceSha256"], pins["source"]["sha256"])
            self.assertFalse((root / "unrelated.txt").exists())
            pins["artifact"]["outerSha256"] = "0" * 64
            with self.assertRaisesRegex(REPLAY.ReplayError, "outer transport SHA-256"):
                REPLAY.extract_pinned_source(candidate, root / "never.tar.gz", pins)

    def test_admits_and_safely_extracts_relative_links_but_rejects_pax_absolute_override(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive_path = root / "normalized.tar.gz"
            archive_root = "yawf-macos-media-runtime-source"
            with tarfile.open(archive_path, "w:gz", format=tarfile.PAX_FORMAT) as archive:
                for name in [archive_root, f"{archive_root}/component-sources", f"{archive_root}/component-sources/pkg"]:
                    member = tarfile.TarInfo(name)
                    member.type = tarfile.DIRTYPE
                    member.mode = 0o755
                    archive.addfile(member)
                add_bytes(archive, f"{archive_root}/component-sources/pkg/configure", b"#!/bin/sh\n")
                link = tarfile.TarInfo(f"{archive_root}/component-sources/pkg/configure-link")
                link.type = tarfile.SYMTYPE
                link.linkname = "configure"
                archive.addfile(link)
            plan = {"archiveRoot": archive_root, "limits": {"pathBytes": 512, "members": 20, "memberBytes": 1024, "regularBytes": 4096, "links": 4}}
            receipt = REPLAY.admit_normalized_archive(archive_path, plan)
            self.assertEqual(receipt["links"], 1)
            extracted = REPLAY.extract_admitted_archive(archive_path, root / "extracted", plan)
            self.assertEqual(os.readlink(extracted / "component-sources/pkg/configure-link"), "configure")
            self.assertTrue(os.access(extracted / "component-sources/pkg/configure", os.X_OK))

            bad = root / "bad.tar.gz"
            with tarfile.open(bad, "w:gz", format=tarfile.PAX_FORMAT) as archive:
                member = tarfile.TarInfo(archive_root)
                member.type = tarfile.DIRTYPE
                archive.addfile(member)
                link = tarfile.TarInfo(f"{archive_root}/bad")
                link.type = tarfile.SYMTYPE
                link.linkname = "/outside"
                link.pax_headers = {"linkpath": "/outside"}
                archive.addfile(link)
            with self.assertRaisesRegex(REPLAY.ReplayError, "link target is unsafe"):
                REPLAY.admit_normalized_archive(bad, plan)

    def test_profile_allows_only_the_owned_root_and_dev_null_and_denies_network(self):
        profile = REPLAY.sandbox_profile(Path("/private/tmp/owned-output"))
        self.assertIn("(deny network*)", profile)
        self.assertIn('(require-not (subpath "/private/tmp/owned-output"))', profile)
        self.assertIn('(require-not (literal "/dev/null"))', profile)
        self.assertNotIn("allow network", profile)
        with self.assertRaisesRegex(REPLAY.ReplayError, "represented safely"):
            REPLAY.sandbox_profile(Path('/private/tmp/bad"path'))

    def test_build_profile_scopes_writes_to_the_exact_new_replay_child_not_its_parent(self):
        parent = Path("/private/tmp/owned-output")
        child = parent / "replay-arm64-macos11"
        profile = REPLAY.sandbox_profile(child)
        self.assertIn(f'(require-not (subpath "{child}"))', profile)
        self.assertNotIn(f'(require-not (subpath "{parent}"))\n', profile)
        self.assertIn('(require-not (literal "/dev/null"))', profile)
        wrapper = (HERE / "run_macos_media_replay_experiment.py").read_text()
        self.assertIn("build_profile.write_text(sandbox_profile(child))", wrapper)
        self.assertNotIn("build_profile.write_text(sandbox_profile(output))", wrapper)
        self.assertIn('"/usr/bin/sandbox-exec", "-f", str(build_profile)', wrapper)
        self.assertIn("invoke_sandbox(build_profile, environment, wrapper", wrapper)

    def test_clean_environment_has_child_owned_state_and_no_ambient_overrides(self):
        environment = REPLAY.clean_environment(Path("/private/tmp/owned"), "/tools:/usr/bin:/bin", "/Applications/Xcode.app/Contents/Developer")
        self.assertEqual(environment["HOME"], "/private/tmp/owned/launcher-home")
        self.assertEqual(environment["TMPDIR"], "/private/tmp/owned/launcher-tmp")
        self.assertEqual(environment["XCRUN_CACHE_ROOT"], "/private/tmp/owned/xcrun-cache")
        self.assertTrue(all(not key.startswith(("DYLD_", "PYTHON")) for key in environment))
        self.assertTrue(REPLAY.FORBIDDEN_ENV_NAMES.isdisjoint(environment))
        with self.assertRaisesRegex(REPLAY.ReplayError, "forbidden override"):
            REPLAY.ensure_clean_process_environment({**environment, "NODE_OPTIONS": "--require injected"})

    def test_probe_only_is_opt_in_at_the_wrapper_and_workflow_is_fail_closed_for_pr_and_manual_runs(self):
        self.assertFalse(REPLAY.parser().parse_args([]).probe_only)
        self.assertTrue(REPLAY.parser().parse_args(["--probe-only"]).probe_only)
        workflow = (PUBLIC_ROOT / ".github/workflows/macos-media-replay-experiment.yml").read_text()
        self.assertIn("probe_only:", workflow)
        probe_input = workflow[workflow.index("probe_only:"):workflow.index("  pull_request:")]
        self.assertIn("default: true", probe_input)
        probe_expression = next(line.strip() for line in workflow.splitlines() if line.strip().startswith("PROBE_ONLY:"))
        self.assertEqual(
            probe_expression,
            "PROBE_ONLY: ${{ github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && inputs.probe_only) }}",
        )
        self.assertIn('case "$PROBE_ONLY" in', workflow)
        self.assertIn("true) probe_args+=(--probe-only) ;;", workflow)
        self.assertIn("false) ;;", workflow)
        self.assertIn("*) echo \"Refusing unexpected PROBE_ONLY value\" >&2; exit 1 ;;", workflow)
        self.assertNotIn("github.event_name == 'workflow_dispatch' && inputs.probe_only || false", workflow)
        timeout_expression = next(line.strip() for line in workflow.splitlines() if line.strip().startswith("timeout-minutes:"))
        self.assertEqual(
            timeout_expression,
            "timeout-minutes: ${{ (github.event_name == 'pull_request' || inputs.probe_only) && 20 || 90 }}",
        )
        event_cases = [
            ("pull_request", False, True, 20),
            ("workflow_dispatch", True, True, 20),
            ("workflow_dispatch", False, False, 90),
        ]
        for event_name, manual_input, expected_probe_only, expected_timeout in event_cases:
            probe_only = event_name == "pull_request" or (event_name == "workflow_dispatch" and manual_input)
            timeout_minutes = 20 if event_name == "pull_request" or manual_input else 90
            self.assertEqual(probe_only, expected_probe_only, (event_name, manual_input))
            self.assertEqual(timeout_minutes, expected_timeout, (event_name, manual_input))

    def test_discovers_exact_selected_xcode_tools_and_controlled_path_tools_without_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            developer = root / "Xcode.app/Contents/Developer"
            xcode_bin = developer / "Toolchains/XcodeDefault.xctoolchain/usr/bin"
            developer_bin = developer / "usr/bin"
            sdk = developer / "Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
            path_bin = root / "path-bin"
            for target in (xcode_bin, developer_bin, sdk, path_bin):
                target.mkdir(parents=True, exist_ok=True)
            selected = {}
            for name in REPLAY.XCODE_TOOL_NAMES:
                path = (developer_bin if name == "make" else xcode_bin) / name
                path.write_text("#!/bin/sh\nexit 0\n")
                path.chmod(0o755)
                selected[name] = path
            for name in REPLAY.PATH_TOOL_NAMES:
                path = path_bin / name
                path.write_text("#!/bin/sh\nexit 0\n")
                path.chmod(0o755)

            def run(command, **_kwargs):
                self.assertEqual(_kwargs["timeout"], REPLAY.XCRUN_TIMEOUT_SECONDS)
                if "--show-sdk-path" in command:
                    return subprocess.CompletedProcess(command, 0, stdout=f"{sdk}\n")
                name = command[-1]
                return subprocess.CompletedProcess(command, 0, stdout=f"{selected[name]}\n")

            environment = REPLAY.clean_environment(root / "state", str(path_bin), str(developer))
            receipt = REPLAY.discover_tool_selection(developer, str(path_bin), environment, run=run)
            self.assertEqual(receipt["developerRealPath"], str(developer.resolve()))
            self.assertEqual(receipt["sdk"]["selectedPath"], str(sdk))
            self.assertEqual(receipt["tools"]["ar"]["selectedPath"], str(selected["ar"]))
            self.assertEqual(receipt["tools"]["metal"]["selectedBy"], "/usr/bin/xcrun")
            self.assertEqual(receipt["tools"]["metallib"]["selectedBy"], "/usr/bin/xcrun")
            self.assertEqual(receipt["tools"]["pkg-config"]["selectedPath"], str(path_bin / "pkg-config"))
            arguments = REPLAY.controller_tool_arguments(receipt)
            self.assertEqual(arguments[arguments.index("--ar") + 1], str(selected["ar"]))
            self.assertEqual(arguments[arguments.index("--pkg-config") + 1], str(path_bin / "pkg-config"))
            self.assertEqual(arguments[arguments.index("--metal") + 1], str(selected["metal"]))
            self.assertEqual(arguments[arguments.index("--metallib") + 1], str(selected["metallib"]))

            outside = root / "outside-ar"
            outside.write_text("#!/bin/sh\nexit 0\n")
            outside.chmod(0o755)

            def outside_run(command, **_kwargs):
                if "--show-sdk-path" in command:
                    return subprocess.CompletedProcess(command, 0, stdout=f"{sdk}\n")
                name = command[-1]
                path = outside if name == "ar" else selected[name]
                return subprocess.CompletedProcess(command, 0, stdout=f"{path}\n")

            with self.assertRaisesRegex(REPLAY.ReplayError, "outside the selected Developer directory"):
                REPLAY.discover_tool_selection(developer, str(path_bin), environment, run=outside_run)

            def failed_run(command, **_kwargs):
                return subprocess.CompletedProcess(command, 1, stdout="not found\n")

            with self.assertRaisesRegex(REPLAY.ReplayError, "could not select"):
                REPLAY.discover_tool_selection(developer, str(path_bin), environment, run=failed_run)

            def timeout_run(command, **kwargs):
                raise subprocess.TimeoutExpired(command, kwargs["timeout"])

            with self.assertRaisesRegex(REPLAY.ReplayError, "timed out after 60 seconds while selecting clang"):
                REPLAY.discover_tool_selection(developer, str(path_bin), environment, run=timeout_run)

    def test_accepts_only_trusted_xcrun_selected_metal_tools_outside_the_developer_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            developer = root / "Xcode.app/Contents/Developer"
            xcode_bin = developer / "Toolchains/XcodeDefault.xctoolchain/usr/bin"
            developer_bin = developer / "usr/bin"
            sdk = developer / "Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
            path_bin = root / "path-bin"
            cryptex_bin = root / "system-metal-cryptex/usr/bin"
            for target in (xcode_bin, developer_bin, sdk, path_bin, cryptex_bin):
                target.mkdir(parents=True, exist_ok=True)
            selected = {}
            for name in REPLAY.XCODE_TOOL_NAMES:
                if name in {"metal", "metallib"}:
                    path = cryptex_bin / name
                else:
                    path = (developer_bin if name == "make" else xcode_bin) / name
                path.write_text("#!/bin/sh\nexit 0\n")
                path.chmod(0o755)
                selected[name] = path
            for name in REPLAY.PATH_TOOL_NAMES:
                path = path_bin / name
                path.write_text("#!/bin/sh\nexit 0\n")
                path.chmod(0o755)

            def trusted_xcrun(command, **_kwargs):
                if "--show-sdk-path" in command:
                    return subprocess.CompletedProcess(command, 0, stdout=f"{sdk}\n")
                return subprocess.CompletedProcess(command, 0, stdout=f"{selected[command[-1]]}\n")

            environment = REPLAY.clean_environment(root / "state", str(path_bin), str(developer))
            receipt = REPLAY.discover_tool_selection(developer, str(path_bin), environment, run=trusted_xcrun)
            for name in ("metal", "metallib"):
                self.assertEqual(receipt["tools"][name]["selectedPath"], str(selected[name]))
                self.assertEqual(receipt["tools"][name]["selectedBy"], "/usr/bin/xcrun")
                self.assertFalse(REPLAY._within(developer.resolve(), selected[name].resolve()))
            arguments = REPLAY.controller_tool_arguments(receipt)
            self.assertEqual(arguments[arguments.index("--metal") + 1], str(selected["metal"]))
            self.assertEqual(arguments[arguments.index("--metallib") + 1], str(selected["metallib"]))

    def test_public_inventory_provenance_is_source_identity_relative_and_exactly_pinned(self):
        staged = json.loads((PUBLIC_ROOT / "scripts/macos-media-replay/required-runtime-outputs.json").read_text())
        pins = json.loads((PUBLIC_ROOT / "scripts/macos-media-replay/experiment-pins.json").read_text())
        normalizer = json.loads((PUBLIC_ROOT / "scripts/macos-media-replay/archive-normalizer-plan.json").read_text())
        staged_path = PUBLIC_ROOT / "scripts/macos-media-replay/required-runtime-outputs.json"
        controller_path = PUBLIC_ROOT / "scripts/macos-media-replay/replay_macos_media_sources.mjs"
        self.assertEqual(staged["sourceInstallInventory"], f"source-identity/{staged['sourceIdentity']}/recipe/install/arm64")
        self.assertNotIn("/Volumes/", json.dumps(staged))
        self.assertEqual(REPLAY.sha256_file(staged_path), "0729877e06bbef46f45e63f551df1ff2d7107d9dc482a2748e4b08e399a3fe64")
        self.assertEqual(pins["files"]["scripts/macos-media-replay/required-runtime-outputs.json"], REPLAY.sha256_file(staged_path))
        self.assertEqual(pins["files"]["scripts/macos-media-replay/replay_macos_media_sources.mjs"], REPLAY.sha256_file(controller_path))
        self.assertIn(
            {"base": "controller", "source": "replay_macos_media_sources.mjs", "destination": "replay-controls/replay_macos_media_sources.mjs", "role": "independent replay controller"},
            normalizer["bundledInputs"],
        )
        self.assertEqual(pins["referenceOnlyFrozenNormalizedSha256"], "2ff768a121271a9ab056f6a111b15245a7f84ea3f3f5a165e4f0dd24d4e3ff0c")

    def test_workflow_is_one_bounded_same_repo_arm_experiment_with_diagnostic_evidence_only(self):
        workflow = (PUBLIC_ROOT / ".github/workflows/macos-media-replay-experiment.yml").read_text()
        self.assertIn("runs-on: macos-15", workflow)
        self.assertIn("timeout-minutes: ${{ (github.event_name == 'pull_request' || inputs.probe_only) && 20 || 90 }}", workflow)
        self.assertIn("github.event.pull_request.head.repo.full_name == github.repository", workflow)
        self.assertIn('run-id: ${{ env.SOURCE_RUN_ID }}', workflow)
        self.assertIn('github-token: ${{ github.token }}', workflow)
        self.assertIn("actions: read", workflow)
        self.assertIn("actions/upload-artifact@v4", workflow)
        self.assertIn("if: always()", workflow)
        self.assertIn("maximum_total_bytes = 96 * 1024 * 1024", workflow)
        self.assertIn("probe_only:", workflow)
        self.assertIn("default: true", workflow)
        self.assertIn("--probe-only", workflow)
        self.assertIn("owned-output/replay-arm64-macos11/build/*/meson-logs/meson-log.txt", workflow)
        self.assertIn("owned-output/replay-arm64-macos11/meson-*.ini", workflow)
        self.assertIn('"receipts/*.json"', workflow)
        self.assertIn("05-toolchain-selection.json", (HERE / "run_macos_media_replay_experiment.py").read_text())
        self.assertIn("$developer_dir/Toolchains/XcodeDefault.xctoolchain/usr/bin", workflow)
        self.assertIn("$developer_dir/usr/bin", workflow)
        self.assertNotIn('path: ${{ runner.temp }}/macos-media-replay-experiment', workflow)
        self.assertNotIn("normalized-source.tar.gz", workflow)
        self.assertNotIn("secrets.", workflow)
        self.assertNotIn("strategy:", workflow)
        self.assertNotIn("actions/upload-release-asset", workflow)
        self.assertNotIn("softprops/action-gh-release", workflow)
        profile_function = workflow + (HERE / "run_macos_media_replay_experiment.py").read_text()
        self.assertNotIn('(allow network', profile_function)
        self.assertNotIn('(allow file-write', profile_function)


if __name__ == "__main__":
    unittest.main()
