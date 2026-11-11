#!/usr/bin/env python3
"""Contracts for a distinct fixed-source production export, not observation."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
TEXT = (ROOT / '.github/workflows/macos-media-runtime.yml').read_text()
SOURCE = '2edc189a33539bf1742435590810fb84aa653ce5'
ARCHIVE = '6c850c418e17824d70ba2dcb9bb71a1c829906d8238c3ba616981001098e941c'


def check(text):
    errors = []
    def need(value, label):
        if value not in text:
            errors.append(label)
    need("on:\n  workflow_dispatch:\n", 'manual')
    if re.search(r'^  (push|pull_request|workflow_call):', text, re.M):
        errors.append('automatic-trigger')
    need("github.event_name == 'workflow_dispatch' && github.repository == 'Tgk-30/YAWF-Stream' &&\n      github.actor == 'Tgk-30' && github.ref == 'refs/heads/codex/desktop96-media-observe'", 'owner-guard')
    need('permissions:\n  actions: read\n  contents: read\n', 'readonly')
    need('runs-on: macos-15-intel\n    timeout-minutes: 120\n', 'runner-budget')
    need('cancel-in-progress: false', 'no-cancellation-restart')
    need('ref: '+SOURCE+'\n          path: frozen-production\n          persist-credentials: false', 'frozen-source')
    need('test "$(git -C frozen-production rev-parse HEAD)" = '+SOURCE, 'source-binding')
    need('run-id: 42916926303', 'source-run')
    need('archive=yawf-macos-media-runtime-source-'+ARCHIVE+'.tar.gz', 'archive-name')
    need('= '+ARCHIVE+'\n', 'archive-hash')
    need('assert value["archiveBytes"] == 456776628', 'source-bytes')
    need('assert value["archiveSha256"] == "'+ARCHIVE+'"', 'source-receipt')
    need('working-directory: frozen-production', 'original-controls')
    for control in ['scripts/stage_macos_media_runtime.test.mjs', 'scripts/smoke_macos_media_runtime.test.mjs', 'scripts/prepare_macos_replay_notices.test.mjs', 'scripts/macos_media_workflow.test.mjs', 'scripts/ci/run_macos_media_replay_experiment.test.py', 'scripts/ci/produce_macos_media_runtime.test.py']:
        need(control, 'original-controls')
    need('brew install cmake meson ninja autoconf automake libtool nasm pkgconf', 'tools-only')
    need('test -x "$libtool_prefix/bin/glibtoolize"', 'libtool')
    need('test -f "$libtool_prefix/share/aclocal/libtool.m4"', 'libtool')
    for arg in ['"$GITHUB_WORKSPACE/frozen-production/scripts/ci/produce_macos_media_runtime.py"', '--build', '--source-dir "$RUNNER_TEMP/frozen-corresponding-source"', '--workspace "$RUNNER_TEMP/media-intel96-export"', '--arch x86_64', '--jobs 8', '--node "$(command -v node)"', '--tool-path "$tool_path"', '--developer-dir "$developer_dir"', '--github-output "$GITHUB_OUTPUT"']:
        need(arg, 'original-cli')
    need('assert value == {"schemaVersion": 1, "result": "pass", "arch": "x86_64", "target": "11.0", "shippingRegularFiles": 57, "sourceSha256": "'+ARCHIVE+'"}', 'exact-shipping')
    archive = text.split('      - name: Archive only a fully passed unsigned candidate', 1)[-1].split('      - name: Collect fixed allowlisted', 1)[0]
    if 'if: always()' in archive or 'continue-on-error' in text or '|| true' in text:
        errors.append('success-only-export')
    need('name: intel96-fixed-production-export-runtime', 'artifact-name')
    need('compression-level: 0', 'preserved-transport')
    need('records = module.retain_files(pathlib.Path(sys.argv[2]), evidence)', 'bounded-file-retention')
    need('"priorDiagnosticRun": 42955542025, "priorDiagnosticObserverValid": False', 'failed-diagnostic-retained')
    if re.search(r'secrets\.|contents: write|gh release|notarytool|tauri-action|docker build|DYLD_|PYTHONPATH|module\.observe\(', text):
        errors.append('privilege-or-observation-change')
    return errors


class Contracts(unittest.TestCase):
    def test_current(self):
        self.assertEqual(check(TEXT), [])

    def test_each_guard_is_causal(self):
        mutations = [
            ("github.actor == 'Tgk-30' &&", '', 'owner-guard'),
            ("github.repository == 'Tgk-30/YAWF-Stream'", 'true', 'owner-guard'),
            ("github.ref == 'refs/heads/codex/desktop96-media-observe'", 'true', 'owner-guard'),
            ('  contents: read', '  contents: write', 'readonly'),
            ('timeout-minutes: 120', 'timeout-minutes: 240', 'runner-budget'),
            ('ref: '+SOURCE, 'ref: main', 'frozen-source'),
            ('run-id: 42916926303', 'run-id: 42916926304', 'source-run'),
            ('--jobs 8', '--jobs 16', 'original-cli'),
            ('assert value["archiveBytes"] == 456776628', 'assert True', 'source-bytes'),
            ('"shippingRegularFiles": 57', '"shippingRegularFiles": 56', 'exact-shipping'),
            ('      - name: Archive only a fully passed unsigned candidate\n', '      - name: Archive only a fully passed unsigned candidate\n        if: always()\n', 'success-only-export'),
            ('records = module.retain_files(pathlib.Path(sys.argv[2]), evidence)', 'records = []', 'bounded-file-retention'),
            ('"priorDiagnosticObserverValid": False', '"priorDiagnosticObserverValid": True', 'failed-diagnostic-retained'),
        ]
        for before, after, label in mutations:
            with self.subTest(label=label):
                self.assertIn(before, TEXT)
                self.assertIn(label, check(TEXT.replace(before, after, 1)))

    def test_no_observer_or_producer_source_changed(self):
        producer = ROOT / 'scripts/ci/produce_macos_media_runtime.py'
        self.assertTrue(producer.is_file())
        self.assertNotIn('observe_media_producer.py \\\n', TEXT)
        self.assertNotIn('observerValid', TEXT)


if __name__ == '__main__':
    unittest.main()
