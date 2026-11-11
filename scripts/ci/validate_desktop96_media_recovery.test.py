#!/usr/bin/env python3
import copy
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


MODULE = Path(__file__).resolve().with_name("validate_desktop96_media_recovery.py")
SPEC = importlib.util.spec_from_file_location("media_admission", MODULE)
admission = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(admission)


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="desktop96-media-admission-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.serial = 0
        self.source = b"bounded synthetic source fixture"

    def fixture(self, *, arch="arm64", change_provenance=None, change_relocation=None,
                change_entries=None, source=None, raw_provenance=None):
        self.serial += 1
        path = self.root / f"candidate-{self.serial}.tar.gz"
        source = self.source if source is None else source
        relocation = {"schemaVersion": 1, "arch": arch, "declaredMinimum": "11.0", "files": [
            {"name": name.split("/")[1], "library": name.startswith("Frameworks/"), "minimum": "11.0", "changes": []}
            for name in sorted(admission.SHIPPING_FILES)
        ]}
        if change_relocation:
            change_relocation(relocation)
        relocation_bytes = json.dumps(relocation).encode()
        provenance = {
            "schemaVersion": 2, "architecture": arch, "target": "11.0",
            "sourceBundle": {"file": admission.SOURCE_FILE, "bytes": len(self.source), "sha256": hashlib.sha256(self.source).hexdigest()},
            "packagesAudited": 33, "shippingRegularFiles": 57,
            "dyldEnvironmentUsed": False, "licensingCleared": False,
            "networkDeniedDuringBuildStageAndSmoke": True, "outsideWritesDeniedDuringBuildStageAndSmoke": True,
            "relocationSha256": hashlib.sha256(relocation_bytes).hexdigest(),
        }
        if change_provenance:
            change_provenance(provenance)
        entries = [{"name": ".", "kind": "directory"}]
        entries.extend({"name": name, "data": b"nonexecutable fixture bytes", "mode": 0o755 if name.startswith("ffmpeg/") else 0o644} for name in sorted(admission.SHIPPING_FILES))
        entries.extend([
            {"name": "Frameworks/libmpv.dylib", "kind": "symlink", "target": "libmpv.2.dylib"},
            {"name": "source/" + admission.SOURCE_FILE, "data": source},
            {"name": f"source/macos-media-provenance-{arch}.json", "data": raw_provenance if raw_provenance is not None else json.dumps(provenance).encode()},
            {"name": "relocation.json", "data": relocation_bytes},
            {"name": "notices/README.txt", "data": b"bounded fixture notice"},
        ])
        if change_entries:
            change_entries(entries)
        with tarfile.open(path, "w:gz", format=tarfile.PAX_FORMAT) as archive:
            for entry in entries:
                info = tarfile.TarInfo(entry["name"])
                info.mode = entry.get("mode", 0o644)
                kind = entry.get("kind", "file")
                info.type = {"file": tarfile.REGTYPE, "directory": tarfile.DIRTYPE,
                             "symlink": tarfile.SYMTYPE, "hardlink": tarfile.LNKTYPE,
                             "fifo": tarfile.FIFOTYPE, "pax": tarfile.XHDTYPE}[kind]
                info.linkname = entry.get("target", "")
                data = entry.get("data", b"")
                info.size = entry.get("declared_size", len(data))
                archive.addfile(info, None if "declared_size" in entry or kind != "file" else io.BytesIO(data))
        return path

    def admit(self, path, arch="arm64", pin=None):
        return admission._admit(path, arch, hashlib.sha256(path.read_bytes()).hexdigest() if pin is None else pin,
                                _source_bytes=len(self.source), _source_sha=hashlib.sha256(self.source).hexdigest())

    def rejected(self, code, **kwargs):
        path = self.fixture(**kwargs)
        with self.assertRaises(admission.AdmissionError) as caught:
            self.admit(path)
        self.assertEqual(caught.exception.args, (code,))

    def test_bounded_arm_and_intel_positive_metadata_only(self):
        for arch in ("arm64", "x86_64"):
            with self.subTest(arch=arch):
                report = self.admit(self.fixture(arch=arch), arch)
                self.assertEqual(report["result"], "admitted")
                self.assertEqual(report["shippingRegularFiles"], 57)
                self.assertFalse(report["runtimeExecutionVerified"])
                self.assertFalse(report["platformSigningVerified"])
                self.assertFalse(report["olderOSRuntimeVerified"])
                self.assertFalse(report["licensingCleared"])

    def test_fixed_inventory_matches_frozen_source_contract(self):
        contract = json.loads((MODULE.parent.parent / "macos-media-replay/required-runtime-outputs.json").read_text())
        expected = {("Frameworks/" if value.startswith("lib/") else "ffmpeg/") + value.split("/")[-1] for value in contract["outputs"]}
        self.assertEqual(admission.SHIPPING_FILES, expected)
        self.assertEqual(len(expected), 57)

    def test_direct_hash_mismatch_precedes_tar_inspection(self):
        path = self.fixture()
        with mock.patch.object(admission.tarfile, "open") as inspect:
            with self.assertRaises(admission.AdmissionError) as caught:
                self.admit(path, pin="0" * 64)
        self.assertEqual(caught.exception.args, ("archive_hash",))
        inspect.assert_not_called()

    def test_hash_pin_must_be_exact_hex_and_arch_known(self):
        path = self.fixture()
        for pin in ("", "a" * 63, "g" * 64, " " + "a" * 64, "a" * 64 + "\n"):
            with self.subTest(pin_length=len(pin)), self.assertRaises(admission.AdmissionError):
                self.admit(path, pin=pin)
        self.assertEqual(self.admit(path, pin=hashlib.sha256(path.read_bytes()).hexdigest().upper())["result"], "admitted")
        with self.assertRaises(admission.AdmissionError):
            self.admit(path, arch="other")

    def test_archive_size_limit_precedes_hash_read(self):
        path = self.root / "oversize.tar.gz"
        with path.open("wb") as handle:
            handle.truncate(admission.MAX_ARCHIVE_BYTES + 1)
        with mock.patch.object(admission, "hash_stream") as digest:
            with self.assertRaises(admission.AdmissionError) as caught:
                self.admit(path, pin="0" * 64)
        self.assertEqual(caught.exception.args, ("archive_type_size",))
        digest.assert_not_called()

    def test_archive_digest_is_bounded_to_observed_file_size(self):
        path = self.fixture()
        original = admission.hash_stream
        calls = []
        def record(stream, expected_size=None, **kwargs):
            calls.append(expected_size)
            return original(stream, expected_size, **kwargs)
        with mock.patch.object(admission, "hash_stream", side_effect=record):
            self.assertEqual(self.admit(path)["result"], "admitted")
        self.assertEqual(calls[0], path.stat().st_size)

    def test_nonregular_and_symlink_archive_rejected(self):
        path = self.fixture()
        alias = self.root / "alias.tar.gz"
        alias.symlink_to(path)
        fifo = self.root / "fifo"
        os.mkfifo(fifo)
        for candidate in (alias, fifo, self.root):
            with self.subTest(kind=candidate.name), self.assertRaises((admission.AdmissionError, OSError)):
                admission._admit(candidate, "arm64", "0" * 64)

    def test_all_member_path_aliases_are_checked(self):
        for name in ("/absolute", "notices/../escape", "notices\\escape", "notices/PRIVATE_MARKER\n", "notices/\x7f"):
            with self.subTest(name=repr(name)):
                self.rejected("member_name", change_entries=lambda entries, n=name: entries.append({"name": n, "data": b"x"}))

    def test_normalized_duplicate_is_rejected(self):
        self.rejected("duplicate_member", change_entries=lambda entries: entries.append({"name": "./Frameworks/./libmpv.2.dylib", "data": b"duplicate"}))

    def test_unknown_namespace_is_rejected(self):
        self.rejected("member_namespace", change_entries=lambda entries: entries.append({"name": "unexpected.bin", "data": b"x"}))

    def test_special_hardlink_and_privileged_modes_rejected(self):
        for kind in ("hardlink", "fifo"):
            with self.subTest(kind=kind):
                self.rejected("member_type", change_entries=lambda entries, k=kind: entries.append({"name": "notices/special", "kind": k, "target": "README.txt"}))
        self.rejected("member_type", change_entries=lambda entries: entries.append({"name": "notices/setuid", "data": b"x", "mode": 0o4755}))

    def test_symlink_escape_broken_and_cycle_are_distinct(self):
        for target, code in (("../../escape", "symlink_escape"), ("/absolute", "symlink_escape"), ("missing", "symlink_broken"), ("link", "symlink_cycle")):
            with self.subTest(target=target):
                self.rejected(code, change_entries=lambda entries, t=target: entries.append({"name": "notices/link", "kind": "symlink", "target": t}))

    def test_two_link_cycle_is_rejected(self):
        self.rejected("symlink_cycle", change_entries=lambda entries: entries.extend([
            {"name": "notices/one", "kind": "symlink", "target": "two"},
            {"name": "notices/two", "kind": "symlink", "target": "one"},
        ]))

    def test_internal_relative_link_is_allowed(self):
        path = self.fixture(change_entries=lambda entries: entries.append({"name": "notices/alias", "kind": "symlink", "target": "../Frameworks/libmpv.2.dylib"}))
        self.assertEqual(self.admit(path)["result"], "admitted")

    def test_intermediate_symlink_is_followed_before_parent_component(self):
        self.rejected("symlink_escape", change_entries=lambda entries: entries.extend([
            {"name": "notices/root", "kind": "symlink", "target": ".."},
            {"name": "notices/escape", "kind": "symlink", "target": "root/../outside"},
            {"name": "notices/outside", "data": b"must not mask the escaping target"},
        ]))

    def test_nonexistent_or_regular_component_before_parent_is_broken(self):
        for target in ("missing/../README.txt", "README.txt/../README.txt"):
            with self.subTest(target=target):
                self.rejected("symlink_broken", change_entries=lambda entries, t=target: entries.append(
                    {"name": "notices/link", "kind": "symlink", "target": t}))

    def test_intermediate_directory_link_can_remain_inside_archive(self):
        path = self.fixture(change_entries=lambda entries: entries.extend([
            {"name": "notices/root", "kind": "symlink", "target": ".."},
            {"name": "notices/inside", "kind": "symlink", "target": "root/notices/README.txt"},
        ]))
        self.assertEqual(self.admit(path)["result"], "admitted")

    def test_member_must_not_traverse_symlink_parent(self):
        self.rejected("symlink_parent", change_entries=lambda entries: entries.extend([
            {"name": "notices/link", "kind": "symlink", "target": "README.txt"},
            {"name": "notices/link/child", "data": b"x"},
        ]))

    def test_shipping_inventory_is_exact_not_just_count(self):
        def replace(entries):
            next(item for item in entries if item["name"] == "Frameworks/libfreetype.6.dylib")["name"] = "Frameworks/unapproved.dylib"
        self.rejected("shipping_files", change_entries=replace)
        self.rejected("shipping_files", change_entries=lambda entries: entries.append({"name": "ffmpeg/extra", "data": b"x"}))

    def test_ffmpeg_and_ffprobe_require_executable_modes(self):
        for name in ("ffmpeg/ffmpeg", "ffmpeg/ffprobe"):
            def no_execute(entries, target=name):
                next(item for item in entries if item["name"] == target)["mode"] = 0o644
            with self.subTest(name=name):
                self.rejected("executable_mode", change_entries=no_execute)

    def test_libmpv_alias_must_be_symlink_to_actual_mpv_library(self):
        def wrong(entries):
            next(item for item in entries if item["name"] == "Frameworks/libmpv.dylib")["target"] = "libfreetype.6.dylib"
        self.rejected("mpv_alias", change_entries=wrong)

    def test_source_size_and_content_are_independently_bound(self):
        self.rejected("source_size", source=self.source + b"extra")
        self.rejected("source_hash", source=b"X" + self.source[1:])

    def test_source_must_be_present_and_no_extra_source_members(self):
        self.rejected("source_missing", change_entries=lambda entries: entries.__setitem__(slice(None), [item for item in entries if item["name"] != "source/" + admission.SOURCE_FILE]))
        self.rejected("source_members", change_entries=lambda entries: entries.append({"name": "source/extra", "data": b"x"}))

    def test_provenance_schema_arch_target_counts_and_source(self):
        for field, value, code in (("schemaVersion", 1, "provenance_schema"), ("architecture", "x86_64", "provenance_arch_target"),
                                   ("target", "12.0", "provenance_arch_target"), ("packagesAudited", 32, "provenance_counts"),
                                   ("shippingRegularFiles", 56, "provenance_counts"), ("packagesAudited", 33.0, "provenance_counts"),
                                   ("sourceBundle", {}, "provenance_source")):
            with self.subTest(field=field, value=value):
                self.rejected(code, change_provenance=lambda data, key=field, bad=value: data.__setitem__(key, bad))

    def test_all_provenance_policy_flags_are_exact_booleans(self):
        for field, value in (("dyldEnvironmentUsed", True), ("dyldEnvironmentUsed", 0), ("licensingCleared", True),
                             ("licensingCleared", 0), ("networkDeniedDuringBuildStageAndSmoke", False),
                             ("networkDeniedDuringBuildStageAndSmoke", 1), ("outsideWritesDeniedDuringBuildStageAndSmoke", False)):
            with self.subTest(field=field, value=value):
                self.rejected("provenance_policy", change_provenance=lambda data, key=field, bad=value: data.__setitem__(key, bad))

    def test_relocation_payload_hash_is_checked(self):
        self.rejected("relocation_hash", change_provenance=lambda data: data.__setitem__("relocationSha256", "0" * 64))

    def test_relocation_schema_arch_target_and_inventory(self):
        for field, value, code in (("schemaVersion", True, "relocation_schema"), ("arch", "x86_64", "relocation_schema"),
                                   ("declaredMinimum", "12.0", "relocation_schema"), ("files", [], "relocation_files")):
            with self.subTest(field=field):
                self.rejected(code, change_relocation=lambda data, key=field, bad=value: data.__setitem__(key, bad))
        def duplicate(data):
            data["files"][1] = copy.deepcopy(data["files"][0])
        self.rejected("relocation_files", change_relocation=duplicate)

    def test_relocation_each_minimum_is_checked_numerically(self):
        for value in ("11.0.1", "12.0", "bad", "010.0", "11.0.0.0", None, True):
            with self.subTest(value=value):
                self.rejected("relocation_minimum", change_relocation=lambda data, bad=value: data["files"][0].__setitem__("minimum", bad))
        path = self.fixture(change_relocation=lambda data: data["files"][0].__setitem__("minimum", "10.15.7"))
        self.assertEqual(self.admit(path)["result"], "admitted")

    def test_json_payload_limits_and_duplicate_keys(self):
        self.rejected("json_limit", change_provenance=lambda data: data.__setitem__("padding", "x" * 65536))
        self.rejected("json_limit", change_relocation=lambda data: data.__setitem__("padding", "x" * admission.MAX_RELOCATION_BYTES))
        self.rejected("json_duplicate", raw_provenance=b'{"schemaVersion":2,"schemaVersion":2}')

    def test_member_and_expanded_limits(self):
        self.rejected("member_limit", change_entries=lambda entries: entries.extend({"name": f"notices/directory-{index}", "kind": "directory"} for index in range(1024)))
        self.rejected("expanded_limit", change_entries=lambda entries: entries.append({"name": "notices/huge", "declared_size": admission.MAX_EXPANDED_BYTES + 1}))

    def test_exact_member_limit_is_accepted(self):
        def fill(entries):
            entries.extend({"name": f"notices/directory-{index}", "kind": "directory"} for index in range(admission.MAX_MEMBERS - len(entries)))
        self.assertEqual(self.admit(self.fixture(change_entries=fill))["memberCount"], 1024)

    def test_trailing_nonzero_tar_bytes_are_not_silently_ignored(self):
        path = self.fixture()
        path.write_bytes(gzip.compress(gzip.decompress(path.read_bytes()) + b"PRIVATE_MARKER"))
        with self.assertRaises(admission.AdmissionError) as caught:
            self.admit(path)
        self.assertEqual(caught.exception.args, ("tar_trailing",))

    def test_truncated_gzip_trailer_cannot_be_admitted(self):
        path = self.fixture()
        path.write_bytes(path.read_bytes()[:-4])
        with self.assertRaises((admission.AdmissionError, OSError, EOFError, tarfile.TarError)):
            self.admit(path)

    def test_pax_metadata_limit_is_checked_before_payload_read(self):
        self.rejected("tar_metadata_limit", change_entries=lambda entries: entries.insert(0, {"name": "pax", "kind": "pax", "declared_size": 65537}))

    def test_no_filesystem_extraction_is_used(self):
        path = self.fixture()
        with mock.patch.object(admission.tarfile.TarFile, "extract", side_effect=AssertionError("must not extract")), mock.patch.object(admission.tarfile.TarFile, "extractall", side_effect=AssertionError("must not extract")):
            self.assertEqual(self.admit(path)["result"], "admitted")

    def test_source_digest_reads_are_stream_bounded(self):
        class RecordingStream(io.BytesIO):
            sizes = []
            def read(self, size=-1):
                self.sizes.append(size)
                return super().read(size)
        stream = RecordingStream(b"x" * (2 * 1024 * 1024 + 1))
        digest, size = admission.hash_stream(stream, 2 * 1024 * 1024 + 1)
        self.assertEqual(size, 2 * 1024 * 1024 + 1)
        self.assertTrue(all(0 < item <= 1024 * 1024 for item in stream.sizes))
        self.assertEqual(digest, hashlib.sha256(stream.getvalue()).hexdigest())

    def cli(self, path, output, *extra):
        return subprocess.run([sys.executable, "-I", "-B", str(MODULE), "--archive", str(path), "--arch", "arm64",
                               "--sha256", hashlib.sha256(path.read_bytes()).hexdigest(), "--output", str(output), *extra],
                              capture_output=True, text=True, timeout=5)

    def test_cli_has_no_fixture_source_override(self):
        path = self.fixture()
        self.assertEqual(self.admit(path)["result"], "admitted")
        output = self.root / "admission.json"
        result = self.cli(path, output)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(output.read_text())["errorClass"], "source_size")
        self.assertEqual(result.stdout, "")
        self.assertNotIn("PRIVATE_MARKER", result.stderr)
        other = self.root / "private-override.json"
        result = self.cli(path, other, "--source-bytes", str(len(self.source)))
        self.assertEqual(result.returncode, 2)
        self.assertFalse(other.exists())

    def test_output_never_overwrites_existing_or_symlink(self):
        path = self.fixture()
        existing = self.root / "existing.json"
        existing.write_text("PRIVATE_MARKER")
        alias = self.root / "alias.json"
        alias.symlink_to(existing)
        for output in (existing, alias):
            with self.subTest(output=output.name):
                result = self.cli(path, output)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(existing.read_text(), "PRIVATE_MARKER")
                self.assertNotIn("PRIVATE_MARKER", result.stderr + result.stdout)

    def test_rejected_report_is_fixed_schema_without_raw_names(self):
        path = self.fixture(change_entries=lambda entries: entries.append({"name": "notices/PRIVATE_MARKER\n", "data": b"private payload"}))
        output = self.root / "report.json"
        result = self.cli(path, output)
        report = json.loads(output.read_text())
        self.assertEqual(result.returncode, 1)
        self.assertEqual(set(report), {"schemaVersion", "result", "scope", "errorClass"})
        self.assertNotIn("PRIVATE_MARKER", output.read_text() + result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
