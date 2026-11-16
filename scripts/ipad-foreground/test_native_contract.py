"""Hosted-only policy tests. They do not run a simulator or prove native playback."""
import importlib.util
import os
import json
from pathlib import Path
import plistlib
import re
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('run_native', HERE / 'run_native.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class NativePolicyTests(unittest.TestCase):
    def diagnostic_run(self, root):
        run = runner.Run.__new__(runner.Run)
        run.root = root
        run.receipt = root / 'receipt.json'
        run.commands = []
        run.deadline = time.monotonic() + 200
        run.started = time.monotonic()
        run.fixture = None
        run.fixture_log = None
        run.network_admitted = False
        run.network_profile_sha = None
        run.device = None
        run.device_name = 'YAWFQATEST'
        run.create_attempted = False
        run.before = None
        run.env = {}
        run.stop = lambda _process: None
        run.monitor = lambda: None
        run.result = {'status': 'refused', 'fullQualification': False, 'deviceCreated': False, 'deviceDeleted': False,
                      'phase': 'host-admission', 'lastCommand': None, 'commandSuccess': {},
                      'primaryCode': None, 'cleanupCode': None, 'cleanupObservationUnavailable': False}
        return run

    def test_profile_denies_network_and_allows_only_fixture_loopback(self):
        profile = runner.profile(Path('/qa/owned'))
        self.assertIn('(deny network*)', profile)
        self.assertIn('(remote ip "localhost:*")', profile)
        self.assertIn('(local ip "localhost:43120")', profile)
        self.assertIn('(local ip "localhost:43121")', profile)
        self.assertNotIn('127.0.0.1', profile)
        self.assertNotIn('(allow network*)', profile)
        self.assertIn('(require-not (subpath "/qa/owned"))', profile)
        with self.assertRaises(runner.Refusal): runner.profile(Path('/qa/"bad'))

    def test_exact_simulator_and_selector_binding(self):
        self.assertEqual(runner.RUNTIME, 'com.apple.CoreSimulator.SimRuntime.iOS-26-5')
        self.assertEqual(runner.DEVICE, 'com.apple.CoreSimulator.SimDeviceType.iPad-A16')
        self.assertEqual(runner.SELECTOR, 'SafariNativeInputTests/IPadForegroundTests/testInstalledPwaForeground')
        swift = (HERE / 'NativeQA/UITests/SafariNativeInputTests.swift').read_text()
        self.assertIn('let baseline = try await decodedReady()', swift)
        self.assertIn('let captureSeconds = window', swift)
        self.assertIn('IPAD_QA_WINDOW_BEGIN_', swift)
        self.assertIn('QA_EXPECTED_UDID', swift)
        self.assertIn('QA_CONTROL_TOKEN', swift)
        self.assertIn('e["SIMULATOR_UDID"]?.lowercased() == expected.lowercased()', swift)
        self.assertIn('e["SIMULATOR_DEVICE_NAME"] == deviceName', swift)
        source = (HERE / 'run_native.py').read_text()
        self.assertNotRegex(source, r"['\"]SIMULATOR_UDID['\"]\s*:")
        self.assertNotRegex(source, r"['\"]SIMULATOR_DEVICE_NAME['\"]\s*:")
        self.assertNotIn('245DAE91-7631-4C52-8656-68ECAD206B78', swift)
        self.assertNotIn('d0f608392b69b7b4f206c7eca1a6df76b3a14a82', swift)

    def test_caps_and_unqualified_full_cannot_be_silently_promoted(self):
        self.assertEqual(runner.guard.START_FREE, 8053063680)
        self.assertEqual(runner.guard.REMAINING_FREE, 6442450944)
        self.assertEqual(runner.guard.MAX_ALLOCATED, 1610612736)
        self.assertEqual(runner.guard.MAX_DIAGNOSTIC, 262144000)
        source = (HERE / 'run_native.py').read_text()
        self.assertIn("'fullQualification': False", source)
        self.assertIn("return 0 if run.result['status'] in ('admission-only', 'observation-only') else 1", source)
        self.assertIn('OWNED_DEVICE_AND_RUNTIME_CAP', source)
        self.assertIn('FFMPEG_NETWORK_CANARY', source)
        self.assertIn('segment-held', source)

    def test_owned_device_missing_links_replacement_and_volume_mismatch_refuse(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            root = base / 'runtime'; root.mkdir()
            device = base / str(uuid.uuid4()).upper()
            with self.assertRaisesRegex(runner.Refusal, 'OWNED_DEVICE_DIRECTORY_REQUIRED'):
                runner.measure_owned_device(device, root, None)
            device.symlink_to(base / 'missing')
            with self.assertRaisesRegex(runner.Refusal, 'OWNED_DEVICE_DIRECTORY_REQUIRED'):
                runner.measure_owned_device(device, root, None)
            device.unlink()
            device.symlink_to(root, target_is_directory=True)
            with self.assertRaisesRegex(runner.Refusal, 'OWNED_DEVICE_DIRECTORY_REQUIRED'):
                runner.measure_owned_device(device, root, None)
            device.unlink(); device.mkdir()
            _, identity = runner.measure_owned_device(device, root, None)
            self.assertEqual(runner.measure_owned_device(device, root, identity)[1], identity)
            device.rename(base / 'original-device'); device.mkdir()
            with self.assertRaisesRegex(runner.Refusal, 'OWNED_DEVICE_IDENTITY_CHANGED'):
                runner.measure_owned_device(device, root, identity)
            real_fstat = os.fstat
            calls = 0
            def different_volume(fd):
                nonlocal calls
                calls += 1
                value = real_fstat(fd)
                if calls == 2: return SimpleNamespace(st_dev=value.st_dev + 1, st_ino=value.st_ino)
                return value
            with patch.object(runner.os, 'fstat', side_effect=different_volume):
                with self.assertRaisesRegex(runner.Refusal, 'OWNED_DEVICE_VOLUME_MISMATCH'):
                    runner.measure_owned_device(device, root, None)

    def test_quality_reacquires_menu_and_never_taps_quality_twice(self):
        swift = (HERE / 'NativeQA/UITests/SafariNativeInputTests.swift').read_text()
        section = swift.split('private func select480()', 1)[1].split('private func screenshot(', 1)[0]
        self.assertIn('while ProcessInfo.processInfo.systemUptime < deadline', section)
        self.assertIn('if let owner = try? web(webapp)', section)
        self.assertIn('if !qualityTapped {', section)
        self.assertEqual(section.count('item.tap()'), 1)
        self.assertLess(section.index('qualityTapped = true'), section.index('item.tap()'))
        self.assertIn('item.isSelected || (item.value as? String) == "1"', section)
        self.assertIn('button(menu, "Close playback settings")', section)
        self.assertIn('QUALITY_MENU_REOPEN_LIMIT', section)

    def test_native_refusal_marker_is_single_exact_and_sanitized(self):
        marker = 'IPAD_QA_NATIVE_REFUSAL='
        for code in ('TIMED_WAIT', 'a_B-9', 'a' * 96, 'UNEXPECTED_FAILURE'):
            self.assertEqual(runner.native_refusal_code('other\n' + marker + code + '\n'), code)
        for text in (marker, marker + 'a' * 97, marker + '/private/token', marker + 'space code',
                     marker + 'OK\n' + marker + 'OTHER', marker + 'OK\n' + marker + '/invalid',
                     'prefix ' + marker + 'CODE', marker + 'CODE\u2028secret', 'x' * (8 * 1024 * 1024 + 1)):
            self.assertIsNone(runner.native_refusal_code(text))
        swift = (HERE / 'NativeQA/UITests/SafariNativeInputTests.swift').read_text()
        wrapper = swift.split('    func testInstalledPwaForeground() async throws {', 1)[1]
        self.assertIn('try await runInstalledPwaForeground()', wrapper)
        self.assertIn('raw.utf8.count <= 96', wrapper)
        self.assertIn('raw.utf8.allSatisfy', wrapper)
        self.assertEqual(wrapper.count('IPAD_QA_NATIVE_REFUSAL='), 1)
        self.assertIn('throw error', wrapper)
        self.assertNotIn('localizedDescription', wrapper)

    def test_native_nonzero_records_only_one_marker_and_keeps_failure(self):
        for body, expected in ((b'IPAD_QA_NATIVE_REFUSAL=TIMED_WAIT\n', 'TIMED_WAIT'),
                               (b'IPAD_QA_NATIVE_REFUSAL=/private/secret\n', None),
                               (b'IPAD_QA_NATIVE_REFUSAL=ONE\nIPAD_QA_NATIVE_REFUSAL=TWO\n', None)):
            with self.subTest(body=body), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / 'configs').mkdir()
                run = self.diagnostic_run(root)
                run.case = 'admission-direct'
                run.device = str(uuid.uuid4()).upper()
                run.token = 'a' * 64
                run.xctestrun = root / 'test.xctestrun'
                run.xctestrun.write_bytes(plistlib.dumps({'SafariNativeInputTests': {'EnvironmentVariables': {}}}))
                process = SimpleNamespace(poll=lambda: 1, returncode=1)
                def fake_popen(_args, **kwargs):
                    kwargs['stdout'].write(body)
                    return process
                with patch.object(runner.subprocess, 'Popen', side_effect=fake_popen):
                    with self.assertRaisesRegex(runner.Refusal, 'NATIVE_TEST_FAILED'):
                        run.native()
                self.assertEqual(run.result.get('nativeRefusalCode'), expected)
                self.assertEqual(run.result['lastCommand'], 'native-test')
                self.assertIs(run.result['commandSuccess']['native-test'], False)
                self.assertNotIn('/private/secret', json.dumps(run.result))

    def test_only_fixed_phases_and_command_labels_can_enter_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = self.diagnostic_run(Path(tmp))
            run.set_phase('host-admission')
            run.start_command('inventory')
            self.assertEqual(run.result['lastCommand'], 'inventory')
            self.assertIs(run.result['commandSuccess']['inventory'], False)
            run.finish_command('inventory')
            self.assertIs(run.result['commandSuccess']['inventory'], True)
            with self.assertRaisesRegex(runner.Refusal, 'INVALID_COMMAND_LABEL'):
                run.start_command('/private/secret-marker')
            with self.assertRaisesRegex(runner.Refusal, 'INVALID_PHASE'):
                run.set_phase('/private/secret-marker')
            self.assertNotIn('secret-marker', json.dumps(run.result))
            for label in ('build', 'boot', 'bootstatus'):
                run.start_command(label)
                run.finish_command(label)
                self.assertIs(run.result['commandSuccess'][label], True)

    def test_constructor_records_but_does_not_preadmit_source_sha(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            receipts = base / 'receipts'; receipts.mkdir()
            with patch.dict(runner.os.environ, {'GITHUB_SHA': 'a' * 40}), \
                 patch.object(runner.guard, 'admit_start'):
                run = runner.Run(base / 'runtime', receipts / 'status.json', 'admission-direct', {})
            self.assertEqual(run.result['sourceSha'], 'a' * 40)
            self.assertIs(run.result['sourceShaAdmitted'], False)
            self.assertEqual(run.result['phase'], 'initialization')

    def test_command_failure_and_timeout_leave_command_label_and_false_completion(self):
        for timeout in (False, True):
            with self.subTest(timeout=timeout), tempfile.TemporaryDirectory() as tmp:
                run = self.diagnostic_run(Path(tmp))
                process = SimpleNamespace(poll=lambda: None if timeout else 1, returncode=None if timeout else 1)
                with patch.object(runner.subprocess, 'Popen', return_value=process):
                    expected = 'COMMAND_TIMEOUT_INVENTORY' if timeout else 'COMMAND_FAILED_INVENTORY'
                    with self.assertRaisesRegex(runner.Refusal, expected):
                        run.command('inventory', ['unused'], 0 if timeout else 20)
                self.assertEqual(run.result['lastCommand'], 'inventory')
                self.assertIs(run.result['commandSuccess']['inventory'], False)

    def test_bootstatus_census_timing_and_log_growth_without_log_content(self):
        for timeout in (False, True):
            with self.subTest(timeout=timeout), tempfile.TemporaryDirectory() as tmp:
                run = self.diagnostic_run(Path(tmp))
                clock = SimpleNamespace(now=0.0)
                run.deadline = 100.0
                holder = {}
                class FakeProcess:
                    returncode = None
                    def poll(self):
                        if not timeout and clock.now >= 1.39:
                            self.returncode = 0
                        return self.returncode
                def fake_popen(_args, **kwargs):
                    holder['output'] = kwargs['stdout']
                    return FakeProcess()
                def monitor():
                    clock.now += 0.2
                    holder['output'].write(b'privateSentinel\n')
                    holder['output'].flush()
                run.monitor = monitor
                def sleep(seconds): clock.now += seconds
                with patch.object(runner.time, 'monotonic', side_effect=lambda: clock.now), \
                     patch.object(runner.time, 'sleep', side_effect=sleep), \
                     patch.object(runner.subprocess, 'Popen', side_effect=fake_popen):
                    if timeout:
                        with self.assertRaisesRegex(runner.Refusal, 'COMMAND_TIMEOUT_BOOTSTATUS'):
                            run.command('bootstatus', ['unused'], 1)
                    else:
                        run.command('bootstatus', ['unused'], 3)
                diag = run.result['bootstatusDiagnostic']
                self.assertEqual(diag['pollCount'], 4)
                self.assertEqual(diag['monitorCalls'], 2)
                self.assertEqual(diag['monitorTotalMs'], 400.0)
                self.assertEqual(diag['monitorMaxMs'], 200.0)
                self.assertEqual(diag['elapsedMs'], 1400.0)
                self.assertEqual(diag['ownedLogBytes'], len(b'privateSentinel\n') * 2)
                self.assertEqual(diag['growthEvents'], 2)
                self.assertEqual((diag['firstGrowthMs'], diag['lastGrowthMs']), (200.0, 900.0))
                self.assertEqual(diag['exitClass'], 'running-at-deadline' if timeout else 'zero')
                self.assertNotIn('privateSentinel', json.dumps(run.result))

    def test_bootstatus_exit_classes_and_interrupted_monitor_do_not_guess(self):
        diag = runner.BootStatusDiagnostic(0)
        for code, expected in ((0, 'zero'), (1, 'nonzero'), (-9, 'signal')):
            self.assertEqual(diag.finish(1, 2, code)['exitClass'], expected)
        self.assertIsNone(diag.finish(1, 2, None)['exitClass'])
        self.assertEqual(diag.finish(2, 2, None)['exitClass'], 'running-at-deadline')
        with tempfile.TemporaryDirectory() as tmp:
            run = self.diagnostic_run(Path(tmp))
            process = SimpleNamespace(poll=lambda: None, returncode=None)
            run.monitor = lambda: (_ for _ in ()).throw(runner.Refusal('ORIGINAL_MONITOR_FAILURE'))
            with patch.object(runner.subprocess, 'Popen', return_value=process):
                with self.assertRaisesRegex(runner.Refusal, 'ORIGINAL_MONITOR_FAILURE'):
                    run.command('bootstatus', ['unused'], 20)
            self.assertIsNone(run.result['bootstatusDiagnostic']['exitClass'])
            self.assertEqual(run.result['bootstatusDiagnostic']['monitorCalls'], 1)

    def test_no_create_does_not_report_a_failed_device_deletion(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = self.diagnostic_run(Path(tmp))
            run.result.update({'code': 'COMMAND_TIMEOUT_INVENTORY', 'primaryCode': 'COMMAND_TIMEOUT_INVENTORY',
                               'lastCommand': 'inventory', 'commandSuccess': {'inventory': False}})
            with patch.object(runner.subprocess, 'run', side_effect=OSError('private-marker')) as inventory, \
                 patch.object(runner, 'unavailable', return_value=True):
                self.assertTrue(run.cleanup())
            inventory.assert_not_called()
            receipt = json.loads(run.receipt.read_text())
            self.assertEqual(receipt['primaryCode'], 'COMMAND_TIMEOUT_INVENTORY')
            self.assertEqual(receipt['code'], 'COMMAND_TIMEOUT_INVENTORY')
            self.assertIsNone(receipt['cleanupCode'])
            self.assertEqual(receipt['cleanupErrors'], [])
            self.assertTrue(receipt['cleanupObservationUnavailable'])
            self.assertEqual(receipt['cleanupObservation'], 'not-required-no-create')
            self.assertNotIn('private-marker', json.dumps(receipt))

    def test_attempted_create_cleanup_failure_never_masks_primary(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = self.diagnostic_run(Path(tmp))
            run.before = {}
            run.create_attempted = True
            run.result.update({'code': 'COMMAND_FAILED_CREATE-DEVICE', 'primaryCode': 'COMMAND_FAILED_CREATE-DEVICE'})
            with patch.object(runner.subprocess, 'run', side_effect=OSError('private-marker')), \
                 patch.object(runner, 'unavailable', return_value=True):
                self.assertFalse(run.cleanup())
            receipt = json.loads(run.receipt.read_text())
            self.assertEqual(receipt['code'], 'COMMAND_FAILED_CREATE-DEVICE')
            self.assertEqual(receipt['primaryCode'], 'COMMAND_FAILED_CREATE-DEVICE')
            self.assertEqual(receipt['cleanupCode'], 'CLEANUP_FAILED')
            self.assertEqual(receipt['cleanupErrors'], ['OWNED_DEVICE_CLEANUP'])
            self.assertTrue(receipt['cleanupObservationUnavailable'])
            self.assertNotIn('private-marker', json.dumps(receipt))

    def test_cleanup_failure_stage_and_state_never_mask_primary(self):
        for failure in ('inventory', 'shutdown', 'delete', 'verify'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                run = self.diagnostic_run(Path(tmp))
                run.before = {}
                run.create_attempted = True
                run.device = str(uuid.uuid4()).upper()
                run.result.update({'code': 'COMMAND_TIMEOUT_BOOTSTATUS', 'primaryCode': 'COMMAND_TIMEOUT_BOOTSTATUS'})
                calls = {'inventory': 0}
                def fake_run(args, **_kwargs):
                    operation = args[2]
                    if operation == 'list':
                        stage = 'inventory' if calls['inventory'] == 0 else 'verify'
                        calls['inventory'] += 1
                    else:
                        stage = operation
                    if stage == failure: raise OSError('privateSentinel')
                    rows = [{'udid': run.device, 'name': run.device_name, 'state': 'Booted'}] if stage == 'inventory' else []
                    return SimpleNamespace(stdout=json.dumps({'devices': {runner.RUNTIME: rows}}).encode())
                with patch.object(runner.subprocess, 'run', side_effect=fake_run), \
                     patch.object(runner, 'unavailable', return_value=True):
                    self.assertFalse(run.cleanup())
                receipt = json.loads(run.receipt.read_text())
                self.assertEqual(receipt['code'], 'COMMAND_TIMEOUT_BOOTSTATUS')
                self.assertEqual(receipt['primaryCode'], 'COMMAND_TIMEOUT_BOOTSTATUS')
                self.assertEqual(receipt['cleanupCode'], 'CLEANUP_FAILED')
                self.assertEqual(receipt['cleanupFailureStage'], failure)
                self.assertEqual(receipt['cleanupDeviceState'], None if failure == 'inventory' else 'Booted')
                self.assertNotIn('privateSentinel', json.dumps(receipt))

    def test_cleanup_device_state_is_fixed_allowlist_only(self):
        for state, expected in (('Shutdown', 'Shutdown'), ('Creating', 'Creating'),
                                ('Booting', 'Booting'), ('ShuttingDown', 'ShuttingDown'),
                                ('privateSentinel', 'other')):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as tmp:
                run = self.diagnostic_run(Path(tmp))
                run.before = {}
                run.create_attempted = True
                run.device = str(uuid.uuid4()).upper()
                lists = 0
                def fake_run(args, **_kwargs):
                    nonlocal lists
                    rows = []
                    if args[2] == 'list':
                        lists += 1
                        if lists == 1: rows = [{'udid': run.device, 'name': run.device_name, 'state': state}]
                    return SimpleNamespace(stdout=json.dumps({'devices': {runner.RUNTIME: rows}}).encode())
                with patch.object(runner.subprocess, 'run', side_effect=fake_run), \
                     patch.object(runner, 'unavailable', return_value=True):
                    self.assertTrue(run.cleanup())
                receipt = json.loads(run.receipt.read_text())
                self.assertEqual(receipt['cleanupDeviceState'], expected)
                self.assertIsNone(receipt['cleanupFailureStage'])
                self.assertNotIn('privateSentinel', json.dumps(receipt))

    def test_network_canary_only_publishes_bounded_numeric_and_classification(self):
        self.assertEqual(runner.canary_diagnostic(1, b'60\n', b''),
                         {'exitCode': 1, 'errno': 60, 'stderrPresent': False, 'stderrClass': 'none',
                          'operator': None, 'parserLine': None})
        self.assertIsNone(runner.canary_diagnostic(1, b'256\n', b'')['errno'])
        self.assertIsNone(runner.canary_diagnostic(1, b'1\nsecret', b'')['errno'])
        for text, expected in ((b'sandbox-exec: syntax error private-marker', 'sandbox-profile-parse'),
                               (b'sandbox-exec: sandbox_init failed private-marker', 'sandbox-apply'),
                               (b'sandbox-exec: execvp python3: Operation not permitted private-marker', 'python-exec-denied'),
                               (b'xcrun: no developer tools private-marker', 'python-shim'),
                               (b'unknown private-marker', 'other')):
            value = runner.canary_diagnostic(1, b'1\n', text)
            self.assertTrue(value['stderrPresent'])
            self.assertEqual(value['stderrClass'], expected)
            self.assertNotIn('private-marker', json.dumps(value))
        self.assertEqual(runner.canary_diagnostic(None, b'', b'x' * 32769)['stderrClass'], 'oversize')

    def test_canary_sbpl_operator_and_line_are_allowlisted_and_never_raw(self):
        cases = (
            (b'unbound variable: network-outbound at line 4 /private/secret', 'unbound-variable', 'network-outbound', 4),
            (b'unknown operation: network-inbound line: 6 /private/secret', 'sandbox-profile-parse', 'network-inbound', 6),
            (b'SBPL diagnostic line 7 /private/secret', 'sbpl-diagnostic', None, 7),
            (b'invalid argument line 8 /private/secret', 'invalid-diagnostic', None, 8),
            (b'unbound variable: secret-marker line 1201', 'unbound-variable', None, None),
            (b'unbound variable: network-outbound-evil line 1 line 2', 'unbound-variable', None, None),
        )
        for raw, kind, operator, line in cases:
            with self.subTest(kind=kind, line=line):
                result = runner.canary_diagnostic(65, b'', raw)
                self.assertEqual((result['stderrClass'], result['operator'], result['parserLine']), (kind, operator, line))
                self.assertNotIn('secret', json.dumps(result))

    def test_failed_network_canary_captures_errno_without_output_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = self.diagnostic_run(Path(tmp))
            process = SimpleNamespace(poll=lambda: 1, returncode=1)
            def fake_popen(_args, **kwargs):
                kwargs['stdout'].write(b'60\n')
                kwargs['stderr'].write(b'xcrun: no developer tools private-marker')
                return process
            with patch.object(runner.subprocess, 'Popen', side_effect=fake_popen):
                with self.assertRaisesRegex(runner.Refusal, 'COMMAND_FAILED_NETWORK-CANARY'):
                    run.command('network-canary', ['unused'], 20)
            self.assertEqual(run.result['lastCommand'], 'network-canary')
            self.assertIs(run.result['commandSuccess']['network-canary'], False)
            self.assertEqual(run.result['networkCanary'], {'exitCode': 1, 'errno': 60,
                             'stderrPresent': True, 'stderrClass': 'python-shim', 'operator': None, 'parserLine': None})
            self.assertNotIn('private-marker', json.dumps(run.result))

    def test_network_admission_precedes_create_and_fixture_requires_same_profile(self):
        source = (HERE / 'run_native.py').read_text()
        prepare = source.split('    def prepare(self):', 1)[1].split('    def admit_network(self):', 1)[0]
        self.assertLess(prepare.index('self.admit_network()'), prepare.index('self.create_attempted = True'))
        self.assertLess(prepare.index('self.admit_network()'), prepare.index("self.command('build'"))
        fixture = source.split('    def start_fixture(self):', 1)[1].split('    def native(self):', 1)[0]
        self.assertIn('self.network_admitted is True', fixture)
        self.assertIn('sha(sandbox) == self.network_profile_sha', fixture)
        with tempfile.TemporaryDirectory() as tmp:
            run = self.diagnostic_run(Path(tmp))
            with patch.object(runner.subprocess, 'Popen') as spawn:
                with self.assertRaisesRegex(runner.Refusal, 'NETWORK_ADMISSION_REQUIRED'):
                    run.start_fixture()
                spawn.assert_not_called()

    def test_network_admission_requires_both_unchanged_negative_controls(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'configs').mkdir()
            run = self.diagnostic_run(root)
            run.ffmpeg = Path('/test/ffmpeg')
            run.result['networkAdmitted'] = False
            with patch.object(run, 'command', return_value='') as python_canary, \
                 patch.object(runner.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stderr=b'Operation not permitted')) as ffmpeg_canary:
                run.admit_network()
            self.assertTrue(run.network_admitted)
            self.assertTrue(run.result['networkAdmitted'])
            self.assertEqual(run.network_profile_sha, runner.sha(root / 'configs/fixture.sb'))
            args = python_canary.call_args.args
            self.assertEqual(args[0], 'network-canary')
            self.assertIn('errno.EPERM,errno.EACCES', args[1][-1])
            self.assertEqual(args[2], 10)
            self.assertEqual(ffmpeg_canary.call_args.kwargs['timeout'], 10)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'configs').mkdir()
            run = self.diagnostic_run(root)
            run.ffmpeg = Path('/test/ffmpeg')
            run.result['networkAdmitted'] = False
            with patch.object(run, 'command', return_value=''), \
                 patch.object(runner.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stderr=b'Network is unreachable')):
                with self.assertRaisesRegex(runner.Refusal, 'FFMPEG_NETWORK_CANARY'):
                    run.admit_network()
            self.assertFalse(run.network_admitted)
            self.assertFalse(run.result['networkAdmitted'])

    def test_fixture_diagnostic_enums_follow_fixture_source(self):
        source = (runner.REPO / 'scripts/android_external_player_server_fixture.mts').read_text()
        for name, expected in (('ForegroundFixtureStage', runner.FIXTURE_STAGES),
                               ('ForegroundFixtureFailure', runner.FIXTURE_FAILURES)):
            match = re.search(r'type ' + name + r'\s*=\s*(.*?);', source, re.DOTALL)
            self.assertIsNotNone(match)
            self.assertEqual(frozenset(re.findall(r'"([a-z0-9-]+)"', match.group(1))), expected)

    def test_fixture_diagnostic_rejects_duplicates_invalid_data_and_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); status = root / 'status.json'
            ready = {'schemaVersion': 1, 'stage': 'ready', 'status': 'ready', 'failureCode': None, 'childExitCode': None}
            refused = {'schemaVersion': 1, 'stage': 'mp4-generation', 'status': 'refused',
                       'failureCode': 'ffmpeg-exit', 'childExitCode': 137}
            self.assertEqual(runner.fixture_diagnostic(status), 'unavailable')
            for value in (ready, refused):
                status.write_text(json.dumps(value))
                self.assertEqual(runner.fixture_diagnostic(status), value)
            invalid = [
                {**ready, 'extra': 'secret'}, {k: v for k, v in ready.items() if k != 'stage'},
                {**ready, 'schemaVersion': True}, {**ready, 'schemaVersion': 2},
                {**ready, 'stage': 'private-path'}, {**ready, 'status': 'unexpected'},
                {**ready, 'failureCode': 'private-error'}, {**ready, 'childExitCode': True},
                {**refused, 'childExitCode': -1}, {**refused, 'childExitCode': 256},
                {**refused, 'failureCode': None}, {**ready, 'stage': 'input-check'},
            ]
            for value in invalid:
                status.write_text(json.dumps(value))
                self.assertEqual(runner.fixture_diagnostic(status), 'unavailable')
            for raw in ('{"schemaVersion":1,"schemaVersion":1,"stage":"ready","status":"ready","failureCode":null,"childExitCode":null}',
                        '{not-json', ' ' * (16 * 1024 + 1)):
                status.write_text(raw)
                self.assertEqual(runner.fixture_diagnostic(status), 'unavailable')
            status.unlink()
            target = root / 'target'; target.write_text(json.dumps(ready))
            status.symlink_to(target)
            self.assertEqual(runner.fixture_diagnostic(status), 'unavailable')

    def test_direct_tsx_loader_and_fixture_failure_precedence(self):
        ready = {'schemaVersion': 1, 'stage': 'ready', 'status': 'ready', 'failureCode': None, 'childExitCode': None}
        refused = {'schemaVersion': 1, 'stage': 'mp4-generation', 'status': 'refused',
                   'failureCode': 'ffmpeg-exit', 'childExitCode': 42}
        cases = ((None, ready, None, None), (None, refused, 'FIXTURE_REFUSED', None),
                 (65, refused, 'FIXTURE_EXITED', 65), (0, {'unexpected': 'secret'}, 'FIXTURE_EXITED', 0),
                 (400, ready, 'FIXTURE_EXITED', None))
        for exit_code, value, failure, recorded in cases:
            with self.subTest(exit_code=exit_code, failure=failure), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); (root / 'configs').mkdir(); (root / 'fixture').mkdir()
                sandbox = root / 'configs/fixture.sb'; sandbox.write_text('owned-profile')
                status = root / 'fixture/foreground-fixture-status.json'; status.write_text(json.dumps(value))
                run = self.diagnostic_run(root)
                run.network_admitted = True; run.network_profile_sha = runner.sha(sandbox)
                run.node = Path('/test/node'); run.token = 'a' * 64
                run.env = {'TMPDIR': str(root / 'tmp'), 'PATH': '/test/bin'}
                process = SimpleNamespace(poll=lambda: exit_code)
                try:
                    with patch.object(runner.subprocess, 'Popen', return_value=process) as spawn:
                        if failure:
                            with self.assertRaisesRegex(runner.Refusal, failure): run.start_fixture()
                        else:
                            run.start_fixture()
                        args = spawn.call_args.args[0]
                        self.assertEqual(args[:4], ['/usr/bin/sandbox-exec', '-f', str(sandbox), '/test/node'])
                        self.assertEqual(args[4:7], ['--import', str(runner.REPO / 'server/node_modules/tsx/dist/loader.mjs'),
                                                      str(runner.REPO / 'scripts/android_external_player_server_fixture.mts')])
                        self.assertNotIn(str(runner.REPO / 'server/node_modules/tsx/dist/cli.mjs'), args)
                        self.assertEqual(args[7:], ['--repo', str(runner.REPO), '--output', str(root / 'fixture'),
                                                    '--foreground-long', '--ipad-foreground'])
                        env = spawn.call_args.kwargs['env']
                        self.assertEqual(env['TMPDIR'], run.env['TMPDIR'])
                        self.assertEqual(env['PATH'], run.env['PATH'])
                        self.assertEqual(env['HOME'], str(root))
                        self.assertEqual(env['IPAD_QA_CONTROL_TOKEN'], run.token)
                    self.assertEqual(run.result.get('fixtureExitCode'), recorded)
                    self.assertEqual(run.result['fixtureDiagnostic'], value if value in (ready, refused) else 'unavailable')
                    self.assertNotIn('secret', json.dumps(run.result))
                finally:
                    if run.fixture_log: run.fixture_log.close()


if __name__ == '__main__':
    unittest.main()
