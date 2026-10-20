import hashlib
import io
import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path

from normalize_source_archive import AdmissionError, normalize_archive, scan_archive, sha256_file


ROOT = "yawf-macos-media-runtime-source"
OWNED = "/runner/owned/recipe/sources"


def add_bytes(archive, name, data):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = 0o644
    archive.addfile(info, io.BytesIO(data))


def fixture(base: Path, *, target=OWNED + "/pkg/target.bin", hardlink=False, escape_path=False):
    archive_path = base / "input.tar.gz"
    regular = {
        f"{ROOT}/SOURCE-INVENTORY.json": b'{"components":["pkg"]}\n',
        f"{ROOT}/SOURCE-BUNDLE-MANIFEST.json": b'{"licensingCleared":false}\n',
        f"{ROOT}/component-sources/pkg/target.bin": b"\x00source-bytes\xff",
        f"{ROOT}/component-sources/pkg/other.txt": b"unchanged\n",
        f"{ROOT}/SHA256SUMS": b"old metadata\n",
    }
    with tarfile.open(archive_path, "w:gz", format=tarfile.PAX_FORMAT) as archive:
        for directory in [ROOT, f"{ROOT}/component-sources", f"{ROOT}/component-sources/pkg"]:
            info = tarfile.TarInfo(directory)
            info.type = tarfile.DIRTYPE
            info.mode = 0o755
            archive.addfile(info)
        for name, data in regular.items():
            add_bytes(archive, name, data)
        link = tarfile.TarInfo(f"{ROOT}/component-sources/pkg/link.bin")
        link.type = tarfile.LNKTYPE if hardlink else tarfile.SYMTYPE
        link.linkname = target
        link.pax_headers = {"linkpath": target}
        archive.addfile(link)
        if escape_path:
            add_bytes(archive, f"{ROOT}/../escape", b"escape")
    controller = base / "controller"
    project = base / "project"
    controller.mkdir()
    (project / "scripts").mkdir(parents=True)
    (controller / "control.mjs").write_bytes(b"control bytes\n")
    (project / "scripts" / "stage.mjs").write_bytes(b"stage bytes\n")
    plan = {
        "schemaVersion": 1,
        "inputArchiveSha256": sha256_file(archive_path),
        "archiveRoot": ROOT,
        "originalOwnedSourcesPrefix": OWNED,
        "limits": {"members": 30, "links": 4, "regularBytes": 4096, "memberBytes": 1024, "pathBytes": 512},
        "bundledInputs": [
            {"base": "controller", "source": "control.mjs", "destination": "replay-controls/control.mjs", "role": "control"},
            {"base": "project", "source": "scripts/stage.mjs", "destination": "replay-support/scripts/stage.mjs", "role": "stager"},
        ],
    }
    return archive_path, controller, project, plan, regular


class ArchiveNormalizerTests(unittest.TestCase):
    def test_identical_inputs_produce_canonical_gzip_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source, controller, project, plan, _ = fixture(base)
            first = base / "first.tar.gz"
            second = base / "second.tar.gz"
            normalize_archive(source, first, plan, controller, project)
            normalize_archive(source, second, plan, controller, project)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(first.read_bytes()[4:8], b"\x00\x00\x00\x00")

    def test_preserves_regular_bytes_and_contains_absolute_links(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source, controller, project, plan, original = fixture(base)
            output = base / "normalized.tar.gz"
            result = normalize_archive(source, output, plan, controller, project)
            self.assertEqual(result["linksNormalized"], 1)
            self.assertEqual(result["regularBytesPreserved"], sum(map(len, original.values())))
            with tarfile.open(output, "r:gz") as archive:
                members = {member.name: member for member in archive}
                for name, data in original.items():
                    if name.endswith("/SHA256SUMS"):
                        continue
                    self.assertEqual(archive.extractfile(members[name]).read(), data)
                link = members[f"{ROOT}/component-sources/pkg/link.bin"]
                self.assertEqual(link.linkname, "target.bin")
                resolved = os.path.normpath(os.path.join(os.path.dirname(link.name), link.linkname))
                self.assertEqual(resolved, f"{ROOT}/component-sources/pkg/target.bin")
                self.assertFalse(link.linkname.startswith("/"))
                sums = archive.extractfile(members[f"{ROOT}/SHA256SUMS"]).read().decode()
                listed = {path: digest for digest, path in (line.rstrip().split("  ", 1) for line in sums.splitlines())}
                for name, member in members.items():
                    if not member.isfile() or name.endswith("/SHA256SUMS"):
                        continue
                    relative = name[len(ROOT) + 1:]
                    data = archive.extractfile(member).read()
                    self.assertEqual(listed[relative], hashlib.sha256(data).hexdigest())
                provenance = json.load(archive.extractfile(members[f"{ROOT}/NORMALIZATION-PROVENANCE.json"]))
                self.assertFalse(provenance["licensingCleared"])
                self.assertTrue(provenance["symlinks"][0]["transformed"])
                owned = json.load(archive.extractfile(members[f"{ROOT}/OWNED-FILE-MANIFEST.json"]))
                self.assertEqual(len(owned["files"]), 2)

    def test_rejects_wrong_sha_and_leaves_no_output(self):
        with tempfile.TemporaryDirectory() as directory:
            source, controller, project, plan, _ = fixture(Path(directory))
            plan["inputArchiveSha256"] = "0" * 64
            output = Path(directory) / "never.tar.gz"
            with self.assertRaisesRegex(AdmissionError, "SHA-256"):
                normalize_archive(source, output, plan, controller, project)
            self.assertFalse(output.exists())

    def test_rejects_outside_and_unknown_absolute_link_targets(self):
        for target, message in [("/outside/secret", "outside"), (OWNED + "/pkg/missing", "missing")]:
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                source, _controller, _project, plan, _ = fixture(Path(directory), target=target)
                with self.assertRaisesRegex(AdmissionError, message):
                    scan_archive(source, plan)

    def test_rejects_path_escape_hardlink_and_member_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            source, _controller, _project, plan, _ = fixture(Path(directory), escape_path=True)
            with self.assertRaisesRegex(AdmissionError, "path is unsafe"):
                scan_archive(source, plan)
        with tempfile.TemporaryDirectory() as directory:
            source, _controller, _project, plan, _ = fixture(Path(directory), hardlink=True)
            with self.assertRaisesRegex(AdmissionError, "hardlinks"):
                scan_archive(source, plan)
        with tempfile.TemporaryDirectory() as directory:
            source, _controller, _project, plan, _ = fixture(Path(directory))
            plan["limits"]["members"] = 2
            with self.assertRaisesRegex(AdmissionError, "member limit"):
                scan_archive(source, plan)

    def test_reference_comparison_accepts_matching_relative_link_and_rejects_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source, _controller, _project, plan, _ = fixture(base)
            reference = base / "reference"
            (reference / "pkg").mkdir(parents=True)
            (reference / "pkg" / "target.bin").write_bytes(b"reference")
            (reference / "pkg" / "link.bin").symlink_to("target.bin")
            scan = scan_archive(source, plan, reference)
            self.assertEqual(scan["referenceComparison"], {"checked": 1, "matched": 1, "unavailable": 0})
            (reference / "pkg" / "other.bin").write_bytes(b"other")
            (reference / "pkg" / "link.bin").unlink()
            (reference / "pkg" / "link.bin").symlink_to("other.bin")
            with self.assertRaisesRegex(AdmissionError, "does not match"):
                scan_archive(source, plan, reference)

    def test_rejects_tampered_input_after_sha_is_pinned(self):
        with tempfile.TemporaryDirectory() as directory:
            source, controller, project, plan, _ = fixture(Path(directory))
            with source.open("ab") as handle:
                handle.write(b"tamper")
            with self.assertRaisesRegex(AdmissionError, "SHA-256"):
                normalize_archive(source, Path(directory) / "never.tar.gz", plan, controller, project)


if __name__ == "__main__":
    unittest.main()
