#!/usr/bin/env python3
import importlib.util
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("producer", HERE / "produce_macos_media_runtime.py")
producer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(producer)


def dump(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


class ProducerTests(unittest.TestCase):
    def transport_fixture(self, payload: bytes = b"durable source seed") -> tuple[dict, dict]:
        digest = hashlib.sha256(payload).hexdigest()
        durable = {
            "repository": "Tgk-30/YAWF-Stream",
            "releaseId": 417897650,
            "tag": "media-source-seed-20261019",
            "draft": True,
            "targetCommitish": "163c6d3d52ed5b537099deffbb6fa655f437d200",
            "asset": {
                "id": 657879542,
                "name": "macos-media-runtime-arm64.tar.gz",
                "size": len(payload),
                "digest": f"sha256:{digest}",
            },
        }
        release_url = f"https://api.github.com/repos/{durable['repository']}/releases/{durable['releaseId']}"
        asset = durable["asset"]
        metadata = {
            "url": release_url,
            "assets_url": f"{release_url}/assets",
            "id": durable["releaseId"],
            "tag_name": durable["tag"],
            "draft": durable["draft"],
            "target_commitish": durable["targetCommitish"],
            "assets": [
                {
                    "url": f"https://api.github.com/repos/{durable['repository']}/releases/assets/{asset['id']}",
                    "state": "uploaded",
                    **asset,
                },
                {"id": 657879543, "name": f"{asset['name']}.sha256", "size": 113, "digest": "sha256:" + "0" * 64},
            ],
        }
        return {"durableRelease": durable}, metadata

    def test_normalized_source_bundles_every_executed_shipping_control(self):
        plan = json.loads((producer.CONTROLLER / "archive-normalizer-plan.json").read_text())
        destinations = {entry["destination"] for entry in plan["bundledInputs"]}
        self.assertTrue({
            "replay-controls/replay-plan.json",
            "replay-controls/replay_macos_media_sources.mjs",
            "replay-controls/required-runtime-outputs.json",
            "replay-controls/normalize_source_archive.py",
            "replay-controls/archive-normalizer-plan.json",
            "replay-controls/shipping-source-pins.json",
            "replay-controls/produce_macos_media_runtime.py",
            "replay-controls/run_macos_media_replay_experiment.py",
            "replay-controls/SOURCE-NOTICES.md",
            "replay-controls/macos-media-runtime.yml",
            "replay-support/scripts/stage_macos_media_runtime.mjs",
            "replay-support/scripts/check_macos_bundle_minimum.mjs",
            "replay-support/scripts/smoke_macos_media_runtime.mjs",
            "replay-support/scripts/prepare_macos_replay_notices.mjs",
            "replay-controls/PROJECT-LICENSE.txt",
        }.issubset(destinations))
        project_license = next(entry for entry in plan["bundledInputs"] if entry["destination"] == "replay-controls/PROJECT-LICENSE.txt")
        self.assertEqual(project_license["base"], "project")
        self.assertEqual(project_license["source"], "LICENSE")

    def source_fixture(self, root: Path) -> tuple[Path, list[str]]:
        source = root / "source"
        controls = source / "replay-controls"
        controls.mkdir(parents=True)
        package_ids = [f"package-{index:02d}" for index in range(33)]
        dump(controls / "replay-plan.json", {"packages": [{"id": value} for value in package_ids]})
        required = [f"lib/lib-{index:02d}.dylib" for index in range(55)] + ["bin/ffmpeg", "bin/ffprobe"]
        dump(controls / "required-runtime-outputs.json", {"schemaVersion": 1, "outputs": required})
        return source, package_ids

    def passing_receipts(self, child: Path, package_ids: list[str], arch: str = "arm64") -> None:
        dump(child / "STATUS.json", {"schemaVersion": 1, "result": "pass", "packages": 33, "arch": arch, "target": "11.0"})
        packages = []
        for index, name in enumerate(package_ids):
            packages.append({"package": name, "beforeMachO": index, "afterMachO": index + 1, "changedMachO": [f"lib/{name}.dylib"], "removedMachO": []})
        dump(child / "INSTALL-AUDIT.json", {"schemaVersion": 1, "arch": arch, "target": "11.0", "packages": packages})
        dump(child / "TOOLCHAIN-PROBE.json", {"result": "pass", "shimDenialsObserved": False})

    def test_requires_complete_ordered_audit_and_clean_toolchain_probe(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, package_ids = self.source_fixture(root)
            child = root / "child"; child.mkdir()
            self.passing_receipts(child, package_ids)
            result = producer.validate_controller_receipts(source, child, "arm64")
            self.assertEqual(result["machOFilesAudited"], 33)
            for mutation in ("missing", "reordered", "removed", "probe"):
                self.passing_receipts(child, package_ids)
                if mutation == "missing":
                    value = json.loads((child / "INSTALL-AUDIT.json").read_text()); value["packages"].pop(); dump(child / "INSTALL-AUDIT.json", value)
                elif mutation == "reordered":
                    value = json.loads((child / "INSTALL-AUDIT.json").read_text()); value["packages"][0], value["packages"][1] = value["packages"][1], value["packages"][0]; dump(child / "INSTALL-AUDIT.json", value)
                elif mutation == "removed":
                    value = json.loads((child / "INSTALL-AUDIT.json").read_text()); value["packages"][1]["removedMachO"] = ["lib/old.dylib"]; dump(child / "INSTALL-AUDIT.json", value)
                else:
                    dump(child / "TOOLCHAIN-PROBE.json", {"result": "pass", "shimDenialsObserved": True})
                with self.assertRaises(producer.ProductionError, msg=mutation):
                    producer.validate_controller_receipts(source, child, "arm64")

    def test_exact_shipping_closure_allows_extra_raw_prefix_helpers(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, _ = self.source_fixture(root)
            prefix = root / "prefix"
            stage = root / "stage"
            required = json.loads((source / "replay-controls/required-runtime-outputs.json").read_text())["outputs"]
            for relative in required:
                path = prefix / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b"binary")
                destination = stage / (f"Frameworks/{path.name}" if relative.startswith("lib/") else f"ffmpeg/{path.name}")
                destination.parent.mkdir(parents=True, exist_ok=True); destination.write_bytes(b"binary")
            helper = prefix / "bin/build-helper"; helper.write_bytes(b"audited but not shipped")
            (stage / "Frameworks/libmpv.dylib").symlink_to("lib-54.dylib")
            result = producer.validate_prefix_and_stage(source, prefix, stage)
            self.assertEqual(result["regularFiles"], 57)
            extra = stage / "Frameworks/unrequired.dylib"; extra.write_bytes(b"wrong")
            with self.assertRaisesRegex(producer.ProductionError, "exact 57-file"):
                producer.validate_prefix_and_stage(source, prefix, stage)

    def test_shipping_stager_receives_the_bundled_exact_output_contract(self):
        source = Path("/owned/admitted-source")
        command = producer.shipping_stage_command(
            Path("/controlled/node"), source, Path("/owned/install/arm64"), Path("/owned/media-candidate"), "arm64"
        )
        self.assertEqual(command, [
            "/controlled/node",
            "/owned/admitted-source/replay-support/scripts/stage_macos_media_runtime.mjs",
            "/owned/install/arm64",
            "/owned/media-candidate",
            "arm64",
            "/owned/admitted-source/replay-controls/required-runtime-outputs.json",
        ])

    def test_shipping_source_pin_rejects_drift(self):
        pins = producer.pinned_source()
        self.assertEqual(pins["artifact"]["runId"], "39304293958")
        self.assertEqual(pins["durableRelease"], producer.DURABLE_RELEASE_PIN)
        original = producer.PINS
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "pins.json"
            producer.PINS = path
            mutations = {
                "historical run": lambda value: value["artifact"].__setitem__("runId", "latest"),
                "repository": lambda value: value["durableRelease"].__setitem__("repository", "other/repository"),
                "release ID": lambda value: value["durableRelease"].__setitem__("releaseId", 417897651),
                "tag": lambda value: value["durableRelease"].__setitem__("tag", "other-tag"),
                "draft state": lambda value: value["durableRelease"].__setitem__("draft", False),
                "target": lambda value: value["durableRelease"].__setitem__("targetCommitish", "0" * 40),
                "asset ID": lambda value: value["durableRelease"]["asset"].__setitem__("id", 657879543),
                "asset name": lambda value: value["durableRelease"]["asset"].__setitem__("name", "other.tar.gz"),
                "asset size": lambda value: value["durableRelease"]["asset"].__setitem__("size", 481020409),
                "asset digest": lambda value: value["durableRelease"]["asset"].__setitem__("digest", "sha256:" + "0" * 64),
            }
            for label, mutate in mutations.items():
                with self.subTest(label=label):
                    changed = json.loads(json.dumps(pins))
                    mutate(changed)
                    dump(path, changed)
                    with self.assertRaisesRegex(producer.ProductionError, "exactly pinned"):
                        producer.pinned_source()
        producer.PINS = original

    def test_release_metadata_requires_every_pinned_identity_and_asset_field(self):
        pins, metadata = self.transport_fixture()
        verified = producer.validate_source_transport_metadata(metadata, pins)
        self.assertEqual(verified["releaseId"], 417897650)
        self.assertEqual(verified["asset"]["id"], 657879542)
        mutations = {
            "repository URL": lambda value: value.__setitem__("url", value["url"].replace("Tgk-30", "other")),
            "assets URL": lambda value: value.__setitem__("assets_url", value["assets_url"] + "/wrong"),
            "release ID": lambda value: value.__setitem__("id", 1),
            "tag": lambda value: value.__setitem__("tag_name", "wrong"),
            "draft": lambda value: value.__setitem__("draft", False),
            "target": lambda value: value.__setitem__("target_commitish", "0" * 40),
            "asset ID": lambda value: value["assets"][0].__setitem__("id", 1),
            "asset name": lambda value: value["assets"][0].__setitem__("name", "wrong.tar.gz"),
            "asset size": lambda value: value["assets"][0].__setitem__("size", 1),
            "asset digest": lambda value: value["assets"][0].__setitem__("digest", "sha256:" + "0" * 64),
            "asset URL": lambda value: value["assets"][0].__setitem__("url", value["assets"][0]["url"].replace("Tgk-30", "other")),
            "asset state": lambda value: value["assets"][0].__setitem__("state", "new"),
            "missing assets": lambda value: value.pop("assets"),
            "duplicate ID": lambda value: value["assets"].append({**value["assets"][0], "name": "duplicate.tar.gz"}),
            "duplicate name": lambda value: value["assets"].append({**value["assets"][0], "id": 1}),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                changed = json.loads(json.dumps(metadata))
                mutate(changed)
                with self.assertRaises(producer.ProductionError):
                    producer.validate_source_transport_metadata(changed, pins)

    def test_local_transport_files_require_metadata_size_and_digest(self):
        payload = b"durable source seed"
        pins, metadata = self.transport_fixture(payload)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = root / "candidate"; candidate.mkdir()
            outer = candidate / pins["durableRelease"]["asset"]["name"]
            outer.write_bytes(payload)
            metadata_path = root / "release.json"
            dump(metadata_path, metadata)
            self.assertEqual(producer.verify_source_transport_files(candidate, metadata_path, pins)["releaseId"], 417897650)
            outer.write_bytes(b"Durable source seed")
            with self.assertRaisesRegex(producer.ProductionError, "digest"):
                producer.verify_source_transport_files(candidate, metadata_path, pins)
            outer.write_bytes(b"short")
            with self.assertRaisesRegex(producer.ProductionError, "size"):
                producer.verify_source_transport_files(candidate, metadata_path, pins)
            outer.unlink()
            with self.assertRaisesRegex(producer.ProductionError, "missing"):
                producer.verify_source_transport_files(candidate, metadata_path, pins)
            with self.assertRaisesRegex(producer.ProductionError, "metadata file"):
                producer.verify_source_transport_files(candidate, root / "missing.json", pins)

    def test_metadata_cli_accepts_only_the_pinned_local_release_document(self):
        pins = producer.pinned_source()
        durable = pins["durableRelease"]
        _, metadata = self.transport_fixture(b"irrelevant")
        metadata["assets"][0].update(durable["asset"])
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "release.json"
            dump(path, metadata)
            result = subprocess.run([sys.executable, str(Path(producer.__file__)), "--verify-source-transport-metadata", str(path)], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["asset"], durable["asset"])
            metadata["assets"][0]["digest"] = "sha256:" + "0" * 64
            dump(path, metadata)
            rejected = subprocess.run([sys.executable, str(Path(producer.__file__)), "--verify-source-transport-metadata", str(path)], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("differs from its pin", rejected.stderr)

    def test_prepare_source_cli_requires_local_release_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = root / "candidate"; candidate.mkdir()
            result = subprocess.run([
                sys.executable, str(Path(producer.__file__)), "--prepare-source",
                "--candidate-dir", str(candidate), "--output-dir", str(root / "output"),
            ], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("source preparation requires candidate, metadata, and output paths", result.stderr)
            self.assertFalse((root / "output").exists())


if __name__ == "__main__":
    unittest.main()
