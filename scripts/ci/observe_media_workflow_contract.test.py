#!/usr/bin/env python3
"""Source contracts for one unprivileged external Intel observation profile."""
import ast
import hashlib
from pathlib import Path
import re
import subprocess
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / '.github/workflows/macos-media-replay-experiment.yml'
LEGACY_BODY_SHA256 = 'db9681647bf8f7eedce9d90dea6c8c27de1b4229558572531ba0143afea3d16f'
FROZEN = '2edc189a33539bf1742435590810fb84aa653ce5'
SOURCE = '6c850c418e17824d70ba2dcb9bb71a1c829906d8238c3ba616981001098e941c'
GUARD = "github.event_name == 'workflow_dispatch' && inputs.observe_intel96 && github.repository == 'Tgk-30/YAWF-Stream' && github.actor == 'Tgk-30' && github.ref == 'refs/heads/codex/desktop96-media-observe'"


def validate(text):
    errors = []
    if '  intel96-observed:\n' not in text:
        return ['profile-missing']
    legacy, native = text.split('\n\n  intel96-observed:', 1)
    body = legacy[legacy.index('    name: Confined ARM source replay, no publication'):].rstrip()
    if hashlib.sha256(body.encode()).hexdigest() != LEGACY_BODY_SHA256:
        errors.append('legacy-body')
    if not re.search(r'observe_intel96:\n        description:[^\n]+\n        required: false\n        default: false\n        type: boolean', text):
        errors.append('default-opt-out')
    if '!inputs.observe_intel96 &&\n      (github.event_name' not in legacy:
        errors.append('legacy-isolation')
    guard = re.search(r'    if: >-\n(.*?)\n    name:', native, re.S)
    if guard is None or ' '.join(guard.group(1).split()) != GUARD:
        errors.append('native-guard')
    if '    runs-on: macos-15-intel\n    timeout-minutes: 120\n' not in native:
        errors.append('native-runner-budget')
    if f'          ref: {FROZEN}\n          path: frozen-production\n          persist-credentials: false' not in native:
        errors.append('frozen-checkout')
    if native.count('persist-credentials: false') != 2:
        errors.append('checkout-credentials')
    download = '''
          name: macos-media-corresponding-source
          path: ${{ runner.temp }}/frozen-corresponding-source
          github-token: ${{ github.token }}
          repository: Tgk-30/YAWF-Stream
          run-id: 42916926303'''
    if download not in native:
        errors.append('fixed-source-artifact')
    if f'test "$(git -C frozen-production rev-parse HEAD)" = {FROZEN}' not in native or f'archive=yawf-macos-media-runtime-source-{SOURCE}.tar.gz' not in native or f'= {SOURCE}\n' not in native:
        errors.append('source-admission')
    if 'name: Admit immutable source and independent observation contracts\n        shell: bash\n        env:\n          TMPDIR: ${{ runner.temp }}' not in native:
        errors.append('controlled-test-temp')
    frozen_tests = ['scripts/stage_macos_media_runtime.test.mjs', 'scripts/smoke_macos_media_runtime.test.mjs', 'scripts/prepare_macos_replay_notices.test.mjs', 'scripts/macos_media_workflow.test.mjs', 'scripts/ci/run_macos_media_replay_experiment.test.py', 'scripts/ci/produce_macos_media_runtime.test.py']
    if any(value not in native for value in frozen_tests) or 'working-directory: frozen-production' not in native:
        errors.append('original-controls')
    if 'assert value["archiveSha256"] == "'+SOURCE+'"' not in native or 'assert value["archiveFile"] == sys.argv[2]' not in native or 'assert value["archiveBytes"] == 456776628' not in native:
        errors.append('source-receipt-pin')
    expected = [
        'observation-tools/scripts/ci/observe_media_producer.py',
        '--workspace "$RUNNER_TEMP/media-intel96-observed"',
        '--evidence "$RUNNER_TEMP/media-intel96-observer-evidence"',
        '--max-seconds "$maximum_seconds"',
        '-- /usr/bin/python3 -I -B "$GITHUB_WORKSPACE/frozen-production/scripts/ci/produce_macos_media_runtime.py"',
        '--source-dir "$RUNNER_TEMP/frozen-corresponding-source"',
        '--arch x86_64', '--jobs 8', '--node "$(command -v node)"',
        '--tool-path "$tool_path"', '--developer-dir "$developer_dir"',
    ]
    if any(value not in native for value in expected):
        errors.append('unchanged-producer-invocation')
    if native.index('Bind the actual job start before setup') > native.index('Checkout external observation tooling') or 'attempts/$GITHUB_RUN_ATTEMPT/jobs?per_page=100' not in native or '.runner_name == env.RUNNER_NAME' not in native:
        errors.append('job-start-binding')
    budget_tokens = ['7200 - 720 - 120 - elapsed_seconds', 'remaining_producer_seconds(value["initialRemainingSeconds"], value["clockContinuousNs"], time.clock_gettime_ns(time.CLOCK_MONOTONIC_RAW))', 'if maximum < 60:', 'raise SystemExit("Setup consumed the safe producer budget")']
    if any(value not in native for value in budget_tokens) or '${{ runner.temp }}/media-intel96-preflight.json' not in native:
        errors.append('job-relative-budget')
    if native.count('time.clock_gettime_ns(time.CLOCK_MONOTONIC_RAW)') != 2 or 'time.monotonic_ns()' in native or 'assert value["clockDomain"] == "Darwin-CLOCK_MONOTONIC_RAW"' not in native:
        errors.append('cross-process-clock')
    archive = native.split('      - name: Archive only a fully passed unsigned candidate', 1)[-1].split('      - name: Retain bounded observations', 1)[0]
    exact = '{"schemaVersion": 1, "result": "pass", "arch": "x86_64", "target": "11.0", "shippingRegularFiles": 57, "sourceSha256": "'+SOURCE+'"}'
    if 'assert value == '+exact not in archive or 'if: always()' in archive or 'continue-on-error' in native:
        errors.append('candidate-success-only')
    if 'name: intel96-observed-unsigned-runtime' not in native or 'compression-level: 0' not in archive:
        errors.append('unsigned-transport')
    retention = '      - name: Retain bounded observations including nested phase logs\n        if: always()\n        uses: actions/upload-artifact@v4'
    if retention not in native or '${{ runner.temp }}/media-intel96-observer-evidence' not in native:
        errors.append('bounded-retention')
    if re.search(r'secrets\.|contents: write|gh release|notarytool|tauri-action|docker build|DYLD_|PYTHONPATH|continue-on-error', native):
        errors.append('privilege-or-source-injection')
    if 'permissions:\n  actions: read\n  contents: read\n' not in text:
        errors.append('read-only-permissions')
    return errors


class WorkflowContracts(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text()

    def test_current_profile_and_legacy_body_pass(self):
        self.assertEqual(validate(self.text), [])

    def test_each_guard_and_permission_mutation_is_rejected(self):
        controls = [
            ("github.event_name == 'workflow_dispatch' && inputs.observe_intel96", "github.event_name == 'push' && inputs.observe_intel96", 'native-guard'),
            ("github.actor == 'Tgk-30' &&", '', 'native-guard'),
            ("github.repository == 'Tgk-30/YAWF-Stream' &&", '', 'native-guard'),
            ("github.ref == 'refs/heads/codex/desktop96-media-observe'", 'true', 'native-guard'),
            ('required: false\n        default: false', 'required: false\n        default: true', 'default-opt-out'),
            ('!inputs.observe_intel96 &&', 'inputs.observe_intel96 &&', 'legacy-isolation'),
            ('  contents: read', '  contents: write', 'read-only-permissions'),
        ]
        for old, new, reason in controls:
            with self.subTest(reason=reason, old=old):
                self.assertIn(old, self.text)
                self.assertIn(reason, validate(self.text.replace(old, new, 1)))

    def test_frozen_input_arguments_budget_and_retention_mutations_rejected(self):
        controls = [
            ('ref: '+FROZEN, 'ref: main', 'frozen-checkout'),
            ('run-id: 42916926303', 'run-id: 42916926304', 'fixed-source-artifact'),
            ('--max-seconds "$maximum_seconds"', '--max-seconds 7200', 'unchanged-producer-invocation'),
            ('--jobs 8', '--jobs 16', 'unchanged-producer-invocation'),
            ('time.clock_gettime_ns(time.CLOCK_MONOTONIC_RAW)', 'time.monotonic_ns()', 'cross-process-clock'),
            ('TMPDIR: ${{ runner.temp }}', 'TMPDIR: /var/tmp', 'controlled-test-temp'),
            ('7200 - 720 - 120 - elapsed_seconds', '7200 - 720 - 120', 'job-relative-budget'),
            ('.runner_name == env.RUNNER_NAME', 'true', 'job-start-binding'),
            ('scripts/stage_macos_media_runtime.test.mjs', 'scripts/not-a-check.mjs', 'original-controls'),
            ('assert value["archiveBytes"] == 456776628', 'assert value["archiveBytes"] > 0', 'source-receipt-pin'),
            ('--arch x86_64', '--arch arm64', 'unchanged-producer-invocation'),
            ('timeout-minutes: 120', 'timeout-minutes: 180', 'native-runner-budget'),
            ('assert value == {', 'assert value != {', 'candidate-success-only'),
            ('including nested phase logs\n        if: always()', 'including nested phase logs\n        if: success()', 'bounded-retention'),
        ]
        for old, new, reason in controls:
            with self.subTest(reason=reason, old=old):
                self.assertIn(old, self.text)
                prefix, native = self.text.split('\n\n  intel96-observed:', 1)
                self.assertIn(old, native)
                changed = prefix + '\n\n  intel96-observed:' + native.replace(old, new, 1)
                self.assertIn(reason, validate(changed))

    def test_actual_inline_budget_functions_deduct_slow_setup_and_refuse_bad_clocks(self):
        functions = {}
        for marker in ('CLOCK', 'BUDGET'):
            match = re.search(r"<<'" + marker + r"'\n(.*?)\n          " + marker, self.text, re.S)
            self.assertIsNotNone(match)
            code = '\n'.join(line[10:] for line in match.group(1).splitlines())
            nodes = [node for node in ast.parse(code).body if isinstance(node, ast.FunctionDef)]
            scope = {}
            exec(compile(ast.Module(body=nodes, type_ignores=[]), '<actual-workflow-budget-functions>', 'exec'), scope)
            functions.update({key: value for key, value in scope.items() if callable(value)})
        initial = functions['initial_remaining_seconds']
        remaining = functions['remaining_producer_seconds']
        self.assertEqual(initial(0), 6360)
        self.assertEqual(initial(900), 5460)
        self.assertEqual(remaining(initial(900), 1000000000, 301000000000), 5160)
        self.assertEqual(remaining(initial(6000), 1000000000, 361000000000), 0)
        self.assertLess(remaining(initial(6301), 1000000000, 1000000000), 60)
        for bad in (-1, True, '0'):
            with self.assertRaises(ValueError):
                initial(bad)
        for values in ((6360, 2, 1), (7201, 1, 1), (True, 1, 1), (6360, 0, 1)):
            with self.assertRaises(ValueError):
                remaining(*values)

    def test_actual_workflow_clock_is_comparable_across_system_python_processes(self):
        expression = 'time.clock_gettime_ns(time.CLOCK_MONOTONIC_RAW)'
        self.assertEqual(self.text.count(expression), 2)
        def read_clock(expr):
            return int(subprocess.check_output(['/usr/bin/python3', '-I', '-B', '-c', 'import time; print(' + expr + ')'], text=True, timeout=5).strip())
        before = read_clock(expression)
        time.sleep(.2)
        after = read_clock(expression)
        self.assertGreaterEqual(after - before, 200000000)
        self.assertLess(after - before, 5000000000)

    def test_legacy_steps_are_hash_bound(self):
        changed = self.text.replace('Run the confined toolchain probe or clean replay', 'Skip the original replay', 1)
        self.assertIn('legacy-body', validate(changed))


if __name__ == '__main__':
    unittest.main()
