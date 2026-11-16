"""Bind the actual hosted Homebrew QA toolchain to official formula/bottle metadata."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

FORMULA = 'ffmpeg@6'
VERSION = '6.1.6'
BOTTLE_SHA256 = '59fa049858eaf083a7cf7b958ee951a03c9fde8452d39c113f643f5d4c4e50e2'
SOURCE_SHA256 = 'd4fcb164028dd3beee5d92c0ac72e46aac6973c75ea12dc14de07bf8f407370a'
REGISTRY = 'https://ghcr.io/v2/homebrew/core/ffmpeg/6/blobs/sha256:'
CELLAR = Path('/opt/homebrew/Cellar/ffmpeg@6')


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''): h.update(block)
    return h.hexdigest()


def validate_formula(formula):
    if not isinstance(formula, dict) or formula.get('name') != FORMULA or formula.get('tap') != 'homebrew/core' or formula.get('keg_only') is not True:
        raise ValueError('OFFICIAL_FORMULA_REQUIRED')
    try:
        version = formula['versions']['stable']
        source = formula['urls']['stable']
        commit = formula['tap_git_head']
    except (KeyError, TypeError):
        raise ValueError('FORMULA_METADATA_REQUIRED') from None
    if version != VERSION or not isinstance(source, dict) or source.get('url') != 'https://ffmpeg.org/releases/ffmpeg-6.1.6.tar.xz' or source.get('checksum') != SOURCE_SHA256:
        raise ValueError('FORMULA_SOURCE_DRIFT')
    if not isinstance(commit, str) or not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('FORMULA_COMMIT_REQUIRED')
    return version, commit


def validate_bottle(formula, bottle_path):
    try:
        expected = formula['bottle']['stable']['files']['arm64_tahoe']
        digest = expected['sha256']
        url = expected['url']
    except (KeyError, TypeError):
        raise ValueError('BOTTLE_METADATA_REQUIRED') from None
    if digest != BOTTLE_SHA256 or url != REGISTRY + BOTTLE_SHA256:
        raise ValueError('OFFICIAL_BOTTLE_MISMATCH')
    bottle = Path(bottle_path).resolve(strict=True)
    if not bottle.is_file() or sha(bottle) != digest:
        raise ValueError('OFFICIAL_BOTTLE_MISMATCH')
    return digest


def validate_installed(formula, ffmpeg, ffprobe):
    ffmpeg, ffprobe = Path(ffmpeg), Path(ffprobe)
    keg = ffmpeg.parent.parent.name
    if not re.fullmatch(r'6\.1\.6(?:_[1-9][0-9]*)?', keg):
        raise ValueError('INSTALLED_KEG_VERSION')
    expected = CELLAR / keg / 'bin'
    if ffmpeg != expected / 'ffmpeg' or ffprobe != expected / 'ffprobe':
        raise ValueError('ACTUAL_EXECUTABLE_REQUIRED')
    installed = formula.get('installed')
    if not isinstance(installed, list): raise ValueError('POURED_FORMULA_REQUIRED')
    matches = [row for row in installed if isinstance(row, dict) and row.get('version') == keg and row.get('poured_from_bottle') is True]
    if len(matches) != 1: raise ValueError('POURED_FORMULA_REQUIRED')
    return keg


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--info', required=True)
    parser.add_argument('--bottle', required=True)
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--ffprobe', required=True)
    parser.add_argument('--node', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    info = Path(args.info)
    if not info.is_file() or info.stat().st_size > 2 * 1024 * 1024: raise ValueError('FORMULA_INFO_REQUIRED')
    payload = json.loads(info.read_text())
    formulae = payload.get('formulae', [])
    if len(formulae) != 1: raise ValueError('ONE_FORMULA_REQUIRED')
    formula = formulae[0]
    version, commit = validate_formula(formula)
    bottle_hash = validate_bottle(formula, args.bottle)
    ffmpeg, ffprobe, node = (Path(x).resolve() for x in (args.ffmpeg, args.ffprobe, args.node))
    keg = validate_installed(formula, ffmpeg, ffprobe)
    if not all(p.is_file() and os.access(p, os.X_OK) for p in (ffmpeg, ffprobe, node)):
        raise ValueError('ACTUAL_EXECUTABLE_REQUIRED')
    node_version = subprocess.run([str(node), '--version'], capture_output=True, text=True, timeout=10, check=True).stdout.strip()
    if node_version != 'v24.22.3': raise ValueError('NODE_VERSION_REQUIRED')
    first_line = subprocess.run([str(ffmpeg), '-version'], capture_output=True, text=True, timeout=10, check=True).stdout.splitlines()[0]
    match = re.match(r'ffmpeg version ([0-9A-Za-z._-]+)', first_line)
    if not match or match.group(1) != version: raise ValueError('FFMPEG_VERSION_REQUIRED')
    result = {'formulaName': FORMULA, 'formulaVersion': version, 'formulaCommit': commit, 'installedKeg': keg,
              'scope': 'homebrew-qa-not-shipping-5.1.9', 'sourceSha256': SOURCE_SHA256, 'bottleSha256': bottle_hash,
              'ffmpegSha256': sha(ffmpeg), 'ffprobeSha256': sha(ffprobe), 'nodeVersion': node_version,
              'node': str(node), 'ffmpeg': str(ffmpeg), 'ffprobe': str(ffprobe)}
    output = Path(args.output)
    with output.open('x') as f: json.dump(result, f, sort_keys=True)
    os.chmod(output, 0o600)


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        code = str(error)
        if not re.fullmatch(r'[A-Z0-9_]{1,64}', code): code = 'TOOLCHAIN_INVALID_DATA'
        print('IPAD_TOOLCHAIN_REFUSED=' + code, file=sys.stderr)
        sys.exit(1)
    except (OSError, KeyError, IndexError, TypeError, subprocess.SubprocessError):
        print('IPAD_TOOLCHAIN_REFUSED=TOOLCHAIN_IO_OR_FORMAT', file=sys.stderr)
        sys.exit(1)
