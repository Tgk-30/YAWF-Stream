"""Bind the actual hosted Homebrew QA toolchain to official formula/bottle metadata."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''): h.update(block)
    return h.hexdigest()


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
    if formula.get('name') != 'ffmpeg' or formula.get('tap') != 'homebrew/core': raise ValueError('OFFICIAL_FORMULA_REQUIRED')
    version = formula['versions']['stable']
    commit = formula.get('tap_git_head')
    if not isinstance(version, str) or not re.fullmatch(r'[0-9A-Za-z._-]{1,40}', version): raise ValueError('VERSION_REQUIRED')
    if not isinstance(commit, str) or not re.fullmatch(r'[a-f0-9]{40}', commit): raise ValueError('FORMULA_COMMIT_REQUIRED')
    bottle = Path(args.bottle).resolve()
    expected = formula['bottle']['stable']['files']['arm64_tahoe']
    bottle_hash = sha(bottle)
    if bottle_hash != expected.get('sha256') or not str(expected.get('url', '')).startswith('https://ghcr.io/v2/homebrew/core/ffmpeg/'):
        raise ValueError('OFFICIAL_BOTTLE_MISMATCH')
    linked = formula.get('linked_keg')
    installed = [x for x in formula.get('installed', []) if x.get('version') == linked and x.get('poured_from_bottle') is True]
    if len(installed) != 1 or not str(linked).startswith(version): raise ValueError('POURED_FORMULA_REQUIRED')
    ffmpeg, ffprobe, node = (Path(x).resolve() for x in (args.ffmpeg, args.ffprobe, args.node))
    if ffmpeg.parent != ffprobe.parent or '/Cellar/ffmpeg/' not in str(ffmpeg) or not all(p.is_file() and os.access(p, os.X_OK) for p in (ffmpeg, ffprobe, node)):
        raise ValueError('ACTUAL_EXECUTABLE_REQUIRED')
    node_version = subprocess.run([str(node), '--version'], capture_output=True, text=True, timeout=10, check=True).stdout.strip()
    if node_version != 'v24.22.3': raise ValueError('NODE_VERSION_REQUIRED')
    first_line = subprocess.run([str(ffmpeg), '-version'], capture_output=True, text=True, timeout=10, check=True).stdout.splitlines()[0]
    match = re.match(r'ffmpeg version ([0-9A-Za-z._-]+)', first_line)
    if not match or not match.group(1).startswith(version): raise ValueError('FFMPEG_VERSION_REQUIRED')
    result = {'formulaVersion': version, 'formulaCommit': commit, 'bottleSha256': bottle_hash,
              'ffmpegSha256': sha(ffmpeg), 'ffprobeSha256': sha(ffprobe), 'nodeVersion': node_version,
              'node': str(node), 'ffmpeg': str(ffmpeg), 'ffprobe': str(ffprobe)}
    output = Path(args.output)
    with output.open('x') as f: json.dump(result, f, sort_keys=True)
    os.chmod(output, 0o600)


if __name__ == '__main__':
    main()
