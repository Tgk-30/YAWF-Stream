"""Local QA toolchain attestation; expected digests must be verified externally."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile

CELLAR = Path('/opt/homebrew/Cellar/ffmpeg-full/9.0.2')
MANIFEST_SHA = '608f61ba726f0562df7aadf96670ae2367107ff746e9ceb9314d49db7ae2035e'
BOTTLE_SHA = 'b32725987244bf52f2da5f5b3104d62f25207b2806d74b06eafd507f6a1f395b'
ARCHIVE_SHA = 'cf7e9152d7bd86c140f6eccf3577abfbaf8960be1ca49d9d900e8484984dcb9a'
NODE_SHA = 'f5f9b9db4d95f5e0340982685f083de654c21eef9d9122cab5321081ccaa2601'
FFMPEG_SHA = 'da79449d686c2aeccc4dbd70c85106851a9c4c81524c44df6378e232d345fde9'
FFPROBE_SHA = '91ad3d20883c5a4d95eef817b92dc78ebaa7b85ad2f032453993f2e3b49c655b'
NODE_ARCHIVE = 'node-v24.17.0-darwin-arm64.tar.xz'
NODE_MEMBER = 'node-v24.17.0-darwin-arm64/bin/node'
SCOPE = 'local-homebrew-qa-not-shipping-5.1.9'


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''): h.update(block)
    return h.hexdigest()


def check(condition, code):
    if not condition: raise ValueError(code)


def digest(value):
    check(isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None, 'EXPECTED_DIGEST_REQUIRED')
    return value


def bounded_json(path, limit):
    path = Path(path)
    check(path.is_file() and not path.is_symlink() and path.stat().st_size <= limit, 'BOUNDED_INPUT_REQUIRED')
    def unique(pairs):
        result = {}
        for k, v in pairs:
            check(k not in result, 'DUPLICATE_JSON_KEY')
            result[k] = v
        return result
    return json.loads(path.read_text(), object_pairs_hook=unique)


def validate_formula(data, bottle_digest):
    check(isinstance(data, dict) and data.get('schemaVersion') == 2 and isinstance(data.get('manifests'), list), 'OFFICIAL_MANIFEST_REQUIRED')
    annotations = data.get('annotations', {})
    check(annotations.get('org.opencontainers.image.title') == 'ffmpeg-full' and
          annotations.get('org.opencontainers.image.version') == '9.0.2' and
          annotations.get('org.opencontainers.image.vendor') == 'homebrew', 'OFFICIAL_MANIFEST_REQUIRED')
    rows = [row for row in data['manifests'] if isinstance(row, dict) and
            row.get('annotations', {}).get('org.opencontainers.image.ref.name') == '9.0.2.arm64_tahoe']
    check(len(rows) == 1 and rows[0].get('platform', {}).get('architecture') == 'arm64' and
          rows[0].get('platform', {}).get('os') == 'darwin' and
          rows[0]['annotations'].get('sh.brew.bottle.digest') == bottle_digest and
          rows[0]['annotations'].get('sh.brew.bottle.size') == '24032885', 'OFFICIAL_BOTTLE_REQUIRED')


def validate_receipt(data):
    check(isinstance(data, dict) and data.get('poured_from_bottle') is True and data.get('built_as_bottle') is True and
          data.get('arch') == 'arm64' and data.get('source', {}).get('tap') == 'homebrew/core' and
          data.get('source', {}).get('versions', {}).get('stable') == '9.0.2', 'INSTALLED_RECEIPT_REQUIRED')


def verify(inputs):
    required = {'schemaVersion', 'scope', 'metadataPath', 'metadataSha256', 'bottlePath', 'bottleSha256',
                'nodeArchivePath', 'nodeArchiveSha256', 'nodePath'}
    optional = {'formulaName', 'formulaVersion', 'installedKeg', 'nodeVersion', 'ffmpegSha256',
                'ffprobeSha256', 'nodeSha256', 'installReceiptSha256'}
    check(isinstance(inputs, dict) and required <= set(inputs) and set(inputs) <= required | optional and
          type(inputs.get('schemaVersion')) is int and inputs['schemaVersion'] == 1 and inputs.get('scope') == SCOPE, 'LOCAL_SCHEMA_REQUIRED')
    expected_meta, expected_bottle, expected_archive = (digest(inputs[k]) for k in ('metadataSha256', 'bottleSha256', 'nodeArchiveSha256'))
    check((expected_meta, expected_bottle, expected_archive) == (MANIFEST_SHA, BOTTLE_SHA, ARCHIVE_SHA), 'OFFICIAL_DIGEST_REQUIRED')
    metadata, bottle, archive = (Path(inputs[k]) for k in ('metadataPath', 'bottlePath', 'nodeArchivePath'))
    check(archive.name == NODE_ARCHIVE, 'NODE_ARCHIVE_REQUIRED')
    for path in (metadata, bottle, archive):
        check(path.is_absolute() and path.is_file() and not path.is_symlink(), 'ATTESTATION_INPUT_REQUIRED')
    check(sha(metadata) == expected_meta and sha(bottle) == expected_bottle and sha(archive) == expected_archive, 'ATTESTATION_DIGEST_MISMATCH')
    validate_formula(bounded_json(metadata, 2 * 1024 * 1024), expected_bottle)
    receipt = CELLAR / 'INSTALL_RECEIPT.json'
    validate_receipt(bounded_json(receipt, 128 * 1024))
    ffmpeg, ffprobe = CELLAR / 'bin/ffmpeg', CELLAR / 'bin/ffprobe'
    node = Path(inputs['nodePath'])
    check(node.is_absolute() and node.is_relative_to('/Volumes/Work') and node.resolve(strict=True) == node, 'NODE_PATH_REQUIRED')
    for path in (ffmpeg, ffprobe, node):
        check(path.is_file() and not path.is_symlink() and os.access(path, os.X_OK), 'EXACT_TOOL_REQUIRED')
    with tarfile.open(archive, mode='r:xz') as package:
        members = [m for m in package if m.name == NODE_MEMBER]
        check(len(members) == 1 and members[0].isfile() and 0 < members[0].size <= 300 * 1024 * 1024, 'NODE_ARCHIVE_MEMBER_REQUIRED')
        stream = package.extractfile(members[0]); check(stream is not None, 'NODE_ARCHIVE_MEMBER_REQUIRED')
        h = hashlib.sha256()
        with stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''): h.update(block)
        check(h.hexdigest() == sha(node) == NODE_SHA, 'NODE_BINARY_MISMATCH')
    check(sha(ffmpeg) == FFMPEG_SHA and sha(ffprobe) == FFPROBE_SHA, 'INSTALLED_BINARY_MISMATCH')
    return {'ffmpegSha256': sha(ffmpeg), 'ffprobeSha256': sha(ffprobe), 'nodeSha256': sha(node),
            'installReceiptSha256': sha(receipt)}


def main():
    parser = argparse.ArgumentParser()
    for key in ('metadata', 'bottle', 'node-archive', 'node', 'output'):
        parser.add_argument('--' + key, required=True)
    args = parser.parse_args()
    result = {'schemaVersion': 1, 'scope': SCOPE, 'formulaName': 'ffmpeg-full', 'formulaVersion': '9.0.2',
              'installedKeg': '9.0.2', 'nodeVersion': 'v24.17.0', 'metadataPath': args.metadata,
              'metadataSha256': MANIFEST_SHA, 'bottlePath': args.bottle, 'bottleSha256': BOTTLE_SHA,
              'nodeArchivePath': args.node_archive, 'nodeArchiveSha256': ARCHIVE_SHA, 'nodePath': args.node}
    result.update(verify(result))
    node_version = subprocess.run([args.node, '--version'], capture_output=True, text=True, timeout=10, check=True).stdout.strip()
    first_line = subprocess.run([str(CELLAR / 'bin/ffmpeg'), '-version'], capture_output=True, text=True, timeout=10, check=True).stdout.splitlines()[0]
    check(node_version == 'v24.17.0' and re.match(r'^ffmpeg version 9\.0\.2(?:\s|$)', first_line) is not None, 'TOOL_VERSION_REQUIRED')
    output_path = Path(args.output)
    check(output_path.is_absolute() and output_path.is_relative_to('/Volumes/Work') and
          output_path.parent.resolve() == output_path.parent and os.path.ismount('/Volumes/Work') and
          output_path.parent.stat().st_dev == Path('/Volumes/Work').stat().st_dev, 'LOCAL_OUTPUT_REQUIRED')
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output: json.dump(result, output, sort_keys=True)


if __name__ == '__main__':
    try: main()
    except (OSError, ValueError, KeyError, TypeError, IndexError, tarfile.TarError, subprocess.SubprocessError):
        raise SystemExit('LOCAL_TOOLCHAIN_REFUSED')
