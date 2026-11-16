"""Hosted-only checks for sanitized synthetic-player review artifacts."""
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
import uuid
import zlib

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('anchors', HERE / 'anchors.py')
anchors = importlib.util.module_from_spec(spec)
spec.loader.exec_module(anchors)


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)


def png(width=100, height=100):
    header = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    raw = (b'\x00' + b'\x00\x00\x00' * width) * height
    return anchors.SIGNATURE + chunk(b'IHDR', header) + chunk(b'tEXt', b'private\x00not retained') + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


class AnchorTests(unittest.TestCase):
    def test_strip_metadata_and_bound_geometry(self):
        data, width, height = anchors.sanitized_png(png())
        self.assertEqual((width, height), (100, 100))
        self.assertNotIn(b'private', data)
        with self.assertRaises(ValueError): anchors.sanitized_png(png(99, 100))
        bad = bytearray(png()); bad[-1] ^= 1
        with self.assertRaises(ValueError): anchors.sanitized_png(bytes(bad))

    def test_extracts_only_exact_owned_anchors_and_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp); source = base / 'export'; source.mkdir()
            rows = []
            for offset in ('0', 'end'):
                filename = str(uuid.uuid4()).upper() + '.png'
                (source / filename).write_bytes(png())
                rows.append({'suggestedHumanReadableName': 'native-direct-' + offset + '_0_' + str(uuid.uuid4()).upper() + '.png', 'exportedFileName': filename})
            rows.append({'suggestedHumanReadableName': 'unrelated.png', 'exportedFileName': 'private.txt'})
            (source / 'manifest.json').write_text(json.dumps([{'testIdentifier': 'IPadForegroundTests/testInstalledPwaForeground()', 'attachments': rows}]))
            output = base / 'out'
            result = anchors.extract(source, output, 'direct', 15, 'a' * 40, {'sha256': 'b' * 64})
            self.assertEqual(len(result['anchors']), 2)
            self.assertEqual(sorted(x.name for x in output.iterdir()), ['anchor-0.png', 'anchor-end.png', 'manifest.json'])
            self.assertTrue(result['manualPixelReviewPending'])
            self.assertNotIn(b'private', (output / 'anchor-0.png').read_bytes())
            with self.assertRaises(ValueError): anchors.extract(source, base / 'bad', 'stall', 180, 'a' * 40, {})


if __name__ == '__main__':
    unittest.main()
