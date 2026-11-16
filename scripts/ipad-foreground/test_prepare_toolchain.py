"""Hosted-only Homebrew cache and provenance contract checks."""
import copy
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('prepare_toolchain', HERE / 'prepare_toolchain.py')
toolchain = importlib.util.module_from_spec(spec)
spec.loader.exec_module(toolchain)


def formula():
    return {'name': 'ffmpeg@6', 'tap': 'homebrew/core', 'keg_only': True,
        'versions': {'stable': '6.1.6'}, 'tap_git_head': '0d406593ad16e61d853778fa6827f50178660217',
        'urls': {'stable': {'url': 'https://ffmpeg.org/releases/ffmpeg-6.1.6.tar.xz', 'checksum': toolchain.SOURCE_SHA256}},
        'linked_keg': None, 'installed': [{'version': '6.1.6_4', 'poured_from_bottle': True}],
        'bottle': {'stable': {'files': {'arm64_tahoe': {
            'sha256': toolchain.BOTTLE_SHA256, 'url': toolchain.REGISTRY + toolchain.BOTTLE_SHA256,
        }}}}}


class ToolchainContractTests(unittest.TestCase):
    def test_cache_query_is_the_documented_force_bottle_query(self):
        workflow = (HERE.parents[1] / '.github/workflows/ipad-foreground-qa.yml').read_text()
        self.assertIn('brew fetch --force-bottle ffmpeg@6', workflow)
        self.assertIn('brew --cache --force-bottle ffmpeg@6', workflow)
        self.assertIn('brew install --force-bottle ffmpeg@6', workflow)
        self.assertIn('brew --prefix ffmpeg@6', workflow)
        self.assertNotIn('brew --cache --bottle ffmpeg', workflow)
        self.assertNotIn('brew fetch --force-bottle ffmpeg >', workflow)
        self.assertIn('test -f "$bottle" && test -r "$bottle"', workflow)
        self.assertIn('test -s "$RUNNER_TEMP/ipad-bootstrap/brew-installed.txt"', workflow)
        for stage in ('BREW_FETCH', 'BREW_BOTTLE_CACHE_QUERY', 'BREW_BOTTLE_MISSING',
                      'BREW_INSTALL', 'BREW_FORMULA_INFO', 'BREW_PREFIX', 'BREW_TOOLCHAIN_ATTEST'):
            self.assertIn('stage=' + stage, workflow)
        self.assertIn('IPAD_BOOTSTRAP_REFUSED=%s', workflow)
        self.assertIn('not shipping runtime', workflow)

    def test_formula_name_source_version_and_commit_are_admitted_exactly(self):
        expected = formula()
        self.assertEqual(toolchain.validate_formula(expected), ('6.1.6', expected['tap_git_head']))
        for changes in ({'name': 'ffmpeg'}, {'tap': 'thirdparty/tap'}, {'keg_only': False}):
            mutated = {**expected, **changes}
            with self.assertRaisesRegex(ValueError, 'OFFICIAL_FORMULA_REQUIRED'):
                toolchain.validate_formula(mutated)
        for field, value in (('version', '6.1.60'), ('source', '0' * 64)):
            mutated = copy.deepcopy(expected)
            if field == 'version': mutated['versions']['stable'] = value
            else: mutated['urls']['stable']['checksum'] = value
            with self.assertRaisesRegex(ValueError, 'FORMULA_SOURCE_DRIFT'):
                toolchain.validate_formula(mutated)
        mutated = copy.deepcopy(expected); mutated['tap_git_head'] = 'bad'
        with self.assertRaisesRegex(ValueError, 'FORMULA_COMMIT_REQUIRED'):
            toolchain.validate_formula(mutated)

    def test_only_pinned_official_tahoe_bottle_and_actual_hash_are_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            bottle = Path(tmp) / 'bottle'; bottle.write_bytes(b'synthetic bottle')
            with patch.object(toolchain, 'sha', return_value=toolchain.BOTTLE_SHA256):
                self.assertEqual(toolchain.validate_bottle(formula(), bottle), toolchain.BOTTLE_SHA256)
                wrong_digest = formula(); wrong_digest['bottle']['stable']['files']['arm64_tahoe']['sha256'] = '0' * 64
                with self.assertRaisesRegex(ValueError, 'OFFICIAL_BOTTLE_MISMATCH'):
                    toolchain.validate_bottle(wrong_digest, bottle)
                wrong_url = formula(); wrong_url['bottle']['stable']['files']['arm64_tahoe']['url'] = 'https://example.invalid/' + toolchain.BOTTLE_SHA256
                with self.assertRaisesRegex(ValueError, 'OFFICIAL_BOTTLE_MISMATCH'):
                    toolchain.validate_bottle(wrong_url, bottle)
                wrong_tag = {'bottle': {'stable': {'files': {'arm64_sequoia': {}}}}}
                with self.assertRaisesRegex(ValueError, 'BOTTLE_METADATA_REQUIRED'):
                    toolchain.validate_bottle(wrong_tag, bottle)
            with self.assertRaisesRegex(ValueError, 'OFFICIAL_BOTTLE_MISMATCH'):
                toolchain.validate_bottle(formula(), bottle)

    def test_keg_only_requires_exact_cellar_path_and_one_poured_row(self):
        expected = formula()
        binary = '/opt/homebrew/Cellar/ffmpeg@6/6.1.6_4/bin/ffmpeg'
        probe = '/opt/homebrew/Cellar/ffmpeg@6/6.1.6_4/bin/ffprobe'
        self.assertIsNone(expected['linked_keg'])
        self.assertEqual(toolchain.validate_installed(expected, binary, probe), '6.1.6_4')
        for bad_ffmpeg, bad_ffprobe in (
            (binary.replace('ffmpeg@6', 'ffmpeg'), probe),
            (binary, probe.replace('6.1.6_4', '6.1.6_3')),
            (binary.replace('6.1.6_4', '6.1.60'), probe),
        ):
            with self.assertRaises(ValueError): toolchain.validate_installed(expected, bad_ffmpeg, bad_ffprobe)
        empty = copy.deepcopy(expected); empty['installed'] = []
        with self.assertRaisesRegex(ValueError, 'POURED_FORMULA_REQUIRED'):
            toolchain.validate_installed(empty, binary, probe)
        not_poured = copy.deepcopy(expected); not_poured['installed'][0]['poured_from_bottle'] = False
        with self.assertRaisesRegex(ValueError, 'POURED_FORMULA_REQUIRED'):
            toolchain.validate_installed(not_poured, binary, probe)
        duplicate = copy.deepcopy(expected); duplicate['installed'].append(dict(duplicate['installed'][0]))
        with self.assertRaisesRegex(ValueError, 'POURED_FORMULA_REQUIRED'):
            toolchain.validate_installed(duplicate, binary, probe)

    def test_cli_refusal_does_not_print_private_input_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = str(Path(tmp) / 'private-identity-marker')
            result = subprocess.run([sys.executable, '-I', str(HERE / 'prepare_toolchain.py'),
                '--info', missing, '--bottle', missing, '--ffmpeg', missing, '--ffprobe', missing,
                '--node', missing, '--output', missing], capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('IPAD_TOOLCHAIN_REFUSED=FORMULA_INFO_REQUIRED', result.stderr)
            self.assertNotIn(missing, result.stdout + result.stderr)
            self.assertNotIn('Traceback', result.stderr)


if __name__ == '__main__':
    unittest.main()
