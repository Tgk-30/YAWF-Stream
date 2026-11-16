"""Select only bounded, metadata-stripped synthetic-player crops for review."""
import hashlib
import json
from pathlib import Path
import re
import struct
import zlib

MAX_PNG = 5 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024
SIGNATURE = b'\x89PNG\r\n\x1a\n'


def sanitized_png(data):
    if not isinstance(data, bytes) or not 45 <= len(data) <= MAX_PNG or not data.startswith(SIGNATURE):
        raise ValueError('PIXEL_PNG_REFUSED')
    pos, kept, width, height, idats, ended = len(SIGNATURE), bytearray(SIGNATURE), None, None, 0, False
    while pos < len(data):
        if pos + 12 > len(data): raise ValueError('PNG_TRUNCATED')
        size = struct.unpack('>I', data[pos:pos + 4])[0]
        end = pos + 12 + size
        if end > len(data): raise ValueError('PNG_TRUNCATED')
        kind, payload = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + size]
        crc = struct.unpack('>I', data[pos + 8 + size:end])[0]
        if zlib.crc32(kind + payload) & 0xffffffff != crc: raise ValueError('PNG_CRC')
        if width is None:
            if kind != b'IHDR' or size != 13: raise ValueError('PNG_IHDR')
            width, height = struct.unpack('>II', payload[:8])
            if not (100 <= width <= 4096 and 100 <= height <= 4096): raise ValueError('PNG_DIMENSIONS')
        elif kind == b'IHDR': raise ValueError('PNG_DUPLICATE_HEADER')
        if kind == b'IDAT': idats += 1
        if kind == b'IEND':
            if size != 0 or idats == 0 or end != len(data): raise ValueError('PNG_END')
            ended = True
        if kind in (b'IHDR', b'PLTE', b'IDAT', b'tRNS', b'IEND'): kept.extend(data[pos:end])
        elif kind[0] & 0x20 == 0: raise ValueError('PNG_UNKNOWN_CRITICAL_CHUNK')
        pos = end
    if not ended: raise ValueError('PNG_END')
    return bytes(kept), width, height


def extract(export_root, output, lane, seconds, source_sha, asset_provenance):
    export_root, output = Path(export_root), Path(output)
    if lane not in ('direct', 'hls') or seconds not in (15, 480) or not re.fullmatch('[a-f0-9]{40}', source_sha):
        raise ValueError('PIXEL_CASE_REFUSED')
    manifest = export_root / 'manifest.json'
    if not manifest.is_file() or manifest.is_symlink() or manifest.stat().st_size > 8 * 1024 * 1024: raise ValueError('EXPORT_MANIFEST_REFUSED')
    entries = json.loads(manifest.read_text())
    selected = [x for x in entries if x.get('testIdentifier') == 'IPadForegroundTests/testInstalledPwaForeground()']
    if len(selected) != 1 or not isinstance(selected[0].get('attachments'), list): raise ValueError('PIXEL_TEST_IDENTITY')
    expected = ['0', 'end'] if seconds == 15 else ['0', '120', '240', '360', 'end']
    attachments = selected[0]['attachments']
    output.mkdir(mode=0o700)
    rows, total = [], 0
    for name in expected:
        pattern = re.compile(r'^native-' + lane + '-' + name + r'_\d+_[A-Fa-f0-9-]{36}\.png$')
        candidates = [x for x in attachments if pattern.fullmatch(x.get('suggestedHumanReadableName', ''))]
        if len(candidates) != 1: raise ValueError('PIXEL_ANCHOR_CENSUS')
        exported = candidates[0].get('exportedFileName', '')
        if not re.fullmatch(r'[A-Fa-f0-9-]{36}\.png', exported): raise ValueError('PIXEL_FILE_NAME')
        source = export_root / exported
        if source.is_symlink() or not source.is_file() or source.stat().st_size > MAX_PNG: raise ValueError('PIXEL_FILE_REFUSED')
        data, width, height = sanitized_png(source.read_bytes())
        total += len(data)
        if total > MAX_TOTAL: raise ValueError('PIXEL_TOTAL_LIMIT')
        filename = 'anchor-' + name + '.png'
        with (output / filename).open('xb') as f: f.write(data)
        rows.append({'name': filename, 'offset': name, 'bytes': len(data), 'width': width, 'height': height,
                     'sha256': hashlib.sha256(data).hexdigest()})
    result = {'schemaVersion': 1, 'sourceSha': source_sha, 'case': lane, 'windowSeconds': seconds,
              'assetProvenance': asset_provenance, 'manualPixelReviewPending': True, 'anchors': rows}
    data = (json.dumps(result, sort_keys=True) + '\n').encode()
    if total + len(data) > MAX_TOTAL: raise ValueError('PIXEL_TOTAL_LIMIT')
    with (output / 'manifest.json').open('xb') as f: f.write(data)
    return result
