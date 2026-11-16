"""Hosted contract tests for local attestation. Never invoke installed tools."""
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('prepare_local_toolchain', HERE / 'prepare_local_toolchain.py')
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)


class LocalToolchainTests(unittest.TestCase):
    def fixture(self, root):
        cellar = root / 'cellar'; (cellar / 'bin').mkdir(parents=True)
        ffmpeg, ffprobe = cellar / 'bin/ffmpeg', cellar / 'bin/ffprobe'
        ffmpeg.write_bytes(b'ffmpeg'); ffprobe.write_bytes(b'ffprobe')
        for path in (ffmpeg, ffprobe): path.chmod(0o700)
        receipt = cellar / 'INSTALL_RECEIPT.json'
        receipt.write_text(json.dumps({'poured_from_bottle': True, 'built_as_bottle': True, 'arch': 'arm64',
            'source': {'tap': 'homebrew/core', 'versions': {'stable': '9.0.2'}}}))
        node = root / 'node'; node.write_bytes(b'node executable'); node.chmod(0o700)
        archive = root / local.NODE_ARCHIVE
        with tarfile.open(archive, 'w:xz') as package:
            item = tarfile.TarInfo(local.NODE_MEMBER); item.size = node.stat().st_size
            package.addfile(item, io.BytesIO(node.read_bytes()))
        bottle = root / 'bottle'; bottle.write_bytes(b'official bottle fixture')
        bottle_sha = local.sha(bottle)
        manifest = root / 'manifest.json'
        manifest.write_text(json.dumps({'schemaVersion': 2, 'annotations': {'org.opencontainers.image.title': 'ffmpeg-full',
            'org.opencontainers.image.version': '9.0.2', 'org.opencontainers.image.vendor': 'homebrew'},
            'manifests': [{'platform': {'architecture': 'arm64', 'os': 'darwin'}, 'annotations': {
                'org.opencontainers.image.ref.name': '9.0.2.arm64_tahoe',
                'sh.brew.bottle.digest': bottle_sha, 'sh.brew.bottle.size': '24032885'}}]}))
        inputs = {'schemaVersion': 1, 'scope': local.SCOPE, 'metadataPath': str(manifest), 'metadataSha256': local.sha(manifest),
                  'bottlePath': str(bottle), 'bottleSha256': bottle_sha, 'nodeArchivePath': str(archive),
                  'nodeArchiveSha256': local.sha(archive), 'nodePath': str(node)}
        pins = {'CELLAR': cellar, 'MANIFEST_SHA': local.sha(manifest), 'BOTTLE_SHA': bottle_sha,
                'ARCHIVE_SHA': local.sha(archive), 'NODE_SHA': local.sha(node),
                'FFMPEG_SHA': local.sha(ffmpeg), 'FFPROBE_SHA': local.sha(ffprobe)}
        return inputs, pins, receipt, node, manifest

    def test_exact_verified_inputs_and_mutations(self):
        with tempfile.TemporaryDirectory() as tmp:
            inputs, pins, receipt, node, manifest = self.fixture(Path(tmp).resolve())
            with patch.multiple(local, **pins), patch.object(Path, 'is_relative_to', return_value=True):
                observed = local.verify(inputs)
                self.assertEqual(observed['nodeSha256'], pins['NODE_SHA'])
                self.assertEqual(observed['ffmpegSha256'], pins['FFMPEG_SHA'])
                with self.assertRaisesRegex(ValueError, 'LOCAL_SCHEMA_REQUIRED'):
                    local.verify({**inputs, 'unexpected': 'privateSentinel'})
                with self.assertRaisesRegex(ValueError, 'LOCAL_SCHEMA_REQUIRED'):
                    local.verify({**inputs, 'schemaVersion': True})
                for key in ('metadataSha256', 'bottleSha256', 'nodeArchiveSha256'):
                    with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'OFFICIAL_DIGEST_REQUIRED'):
                        local.verify({**inputs, key: '0' * 64})
                node.write_bytes(b'changed')
                with self.assertRaisesRegex(ValueError, 'NODE_BINARY_MISMATCH'): local.verify(inputs)
                node.write_bytes(b'node executable')
                receipt.write_text(json.dumps({'poured_from_bottle': False}))
                with self.assertRaisesRegex(ValueError, 'INSTALLED_RECEIPT_REQUIRED'): local.verify(inputs)
                manifest.write_text('{}')
                with self.assertRaisesRegex(ValueError, 'ATTESTATION_DIGEST_MISMATCH'): local.verify(inputs)

    def test_manifest_unique_tahoe_and_receipt_are_strict(self):
        row = {'platform': {'architecture': 'arm64', 'os': 'darwin'}, 'annotations': {
            'org.opencontainers.image.ref.name': '9.0.2.arm64_tahoe',
            'sh.brew.bottle.digest': 'a' * 64, 'sh.brew.bottle.size': '24032885'}}
        manifest = {'schemaVersion': 2, 'annotations': {'org.opencontainers.image.title': 'ffmpeg-full',
            'org.opencontainers.image.version': '9.0.2', 'org.opencontainers.image.vendor': 'homebrew'}, 'manifests': [row]}
        local.validate_formula(manifest, 'a' * 64)
        with self.assertRaisesRegex(ValueError, 'OFFICIAL_BOTTLE_REQUIRED'):
            local.validate_formula({**manifest, 'manifests': [row, row]}, 'a' * 64)
        with self.assertRaisesRegex(ValueError, 'OFFICIAL_MANIFEST_REQUIRED'):
            local.validate_formula({**manifest, 'annotations': {**manifest['annotations'], 'org.opencontainers.image.title': 'ffmpeg'}}, 'a' * 64)
        with self.assertRaisesRegex(ValueError, 'INSTALLED_RECEIPT_REQUIRED'):
            local.validate_receipt({'poured_from_bottle': True, 'built_as_bottle': True, 'arch': 'arm64',
                'source': {'tap': 'other', 'versions': {'stable': '9.0.2'}}})


if __name__ == '__main__': unittest.main()
