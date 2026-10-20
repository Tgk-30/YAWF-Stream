#!/usr/bin/env python3
import importlib.util
import json
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

    def test_shipping_source_pin_rejects_drift(self):
        pins = producer.pinned_source()
        self.assertEqual(pins["artifact"]["runId"], "39304293958")
        original = producer.PINS
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "pins.json"
            changed = json.loads(json.dumps(pins)); changed["artifact"]["runId"] = "latest"
            dump(path, changed)
            producer.PINS = path
            with self.assertRaisesRegex(producer.ProductionError, "exactly pinned"):
                producer.pinned_source()
        producer.PINS = original


if __name__ == "__main__":
    unittest.main()
