"""Hosted-only policy tests. They do not run a simulator or prove native playback."""
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('run_native', HERE / 'run_native.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class NativePolicyTests(unittest.TestCase):
    def test_profile_denies_network_and_allows_only_fixture_loopback(self):
        profile = runner.profile(Path('/qa/owned'))
        self.assertIn('(deny network*)', profile)
        self.assertIn('(remote ip "127.0.0.1:*")', profile)
        self.assertIn('(local ip "127.0.0.1:43120")', profile)
        self.assertIn('(local ip "127.0.0.1:43121")', profile)
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


if __name__ == '__main__':
    unittest.main()
