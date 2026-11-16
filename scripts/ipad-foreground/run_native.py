"""Owned hosted-simulator harness. No artifacts other than a sanitized receipt leave the runner."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import signal
import socket
import subprocess
import sys
import time
import uuid

guard_spec = importlib.util.spec_from_file_location('resource_guard', Path(__file__).with_name('resource_guard.py'))
guard = importlib.util.module_from_spec(guard_spec)
guard_spec.loader.exec_module(guard)
anchors_spec = importlib.util.spec_from_file_location('anchors', Path(__file__).with_name('anchors.py'))
anchors = importlib.util.module_from_spec(anchors_spec)
anchors_spec.loader.exec_module(anchors)

REPO = Path(__file__).resolve().parents[2]
PROJECT = REPO / 'scripts/ipad-foreground/NativeQA/NativeQA.xcodeproj'
RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5'
DEVICE = 'com.apple.CoreSimulator.SimDeviceType.iPad-A16'
DEVELOPER = '/Applications/Xcode_26.5.app/Contents/Developer'
SELECTOR = 'SafariNativeInputTests/IPadForegroundTests/testInstalledPwaForeground'
ABSOLUTE_SECONDS = 1500
CLEANUP_SECONDS = 60
COMMAND_LABELS = frozenset(('xcode-version', 'runtimes', 'device-types', 'inventory', 'ffmpeg-filters',
                            'ffmpeg-encoders', 'create-device', 'build', 'boot', 'bootstatus',
                            'network-canary', 'ffmpeg-network-canary', 'fixture', 'native-test',
                            'evaluate', 'export-attachments'))
PHASES = frozenset(('initialization', 'host-admission', 'toolchain-admission', 'device-creation',
                    'native-build', 'device-boot', 'fixture-admission', 'native-test', 'evidence'))


class Refusal(Exception):
    pass


def require(value, code):
    if not value:
        raise Refusal(code)


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def read_json(path, limit=16 * 1024):
    path = Path(path)
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= limit, 'BOUNDED_FILE_REQUIRED')
    return json.loads(path.read_text())


def unavailable(port):
    with socket.socket() as sock:
        sock.settimeout(.3)
        return sock.connect_ex(('127.0.0.1', port)) != 0


def profile(root):
    text = str(root)
    require(not any(x in text for x in ('"', '\\', '\n', '\r', '\0')), 'SANDBOX_PATH_REFUSED')
    return ('(version 1)\n(allow default)\n(deny network*)\n'
            '(allow network-inbound (local ip "127.0.0.1:43120"))\n'
            '(allow network-inbound (local ip "127.0.0.1:43121"))\n'
            '(allow network-outbound (remote ip "127.0.0.1:*"))\n'
            '(deny file-write* (require-all '
            f'(require-not (subpath "{text}")) (require-not (literal "/dev/null"))))\n')


def canary_diagnostic(exit_code, stdout, stderr):
    """Return bounded classifications only; never retain child text in receipts."""
    code = exit_code if isinstance(exit_code, int) and not isinstance(exit_code, bool) and -255 <= exit_code <= 255 else None
    number = None
    if isinstance(stdout, bytes) and len(stdout) <= 16 and re.fullmatch(rb'\s*[0-9]{1,3}\s*', stdout):
        parsed = int(stdout.strip())
        if parsed <= 255: number = parsed
    present = isinstance(stderr, bytes) and bool(stderr)
    kind = 'none'
    if present and len(stderr) > 32768:
        kind = 'oversize'
    elif present:
        text = stderr.lower()
        if b'sandbox' in text and any(x in text for x in (b'syntax error', b'error parsing', b'invalid profile', b'unexpected token', b'unknown filter', b'unknown operation')):
            kind = 'sandbox-profile-parse'
        elif b'sandbox' in text and any(x in text for x in (b'sandbox_init', b'failed to apply', b'sandbox_apply')):
            kind = 'sandbox-apply'
        elif b'sandbox-exec:' in text and b'execvp' in text and b'python3' in text and any(x in text for x in (b'operation not permitted', b'permission denied')):
            kind = 'python-exec-denied'
        elif any(x in text for x in (b'xcrun:', b'xcode-select:', b'no developer tools', b'command line developer tools')):
            kind = 'python-shim'
        else:
            kind = 'other'
    return {'exitCode': code, 'errno': number, 'stderrPresent': present, 'stderrClass': kind}


def measure_owned_device(device, runtime_root, expected_identity):
    """Admit and recheck the exact device directory without following links."""
    device = Path(device)
    try:
        require(device.is_absolute() and str(uuid.UUID(device.name)).upper() == device.name.upper(), 'OWNED_DEVICE_UUID_PATH')
        fd = guard._root_fd(device)
    except (OSError, ValueError):
        raise Refusal('OWNED_DEVICE_DIRECTORY_REQUIRED') from None
    try:
        info = os.fstat(fd)
        identity = (info.st_dev, info.st_ino)
        if expected_identity is not None:
            require(identity == expected_identity, 'OWNED_DEVICE_IDENTITY_CHANGED')
        root_fd = guard._root_fd(runtime_root)
        try:
            require(info.st_dev == os.fstat(root_fd).st_dev, 'OWNED_DEVICE_VOLUME_MISMATCH')
        finally:
            os.close(root_fd)
        usage = guard.measure(device)
        verify_fd = guard._root_fd(device)
        try:
            final = os.fstat(verify_fd)
            require((final.st_dev, final.st_ino) == identity and
                    (os.fstat(fd).st_dev, os.fstat(fd).st_ino) == identity, 'OWNED_DEVICE_IDENTITY_CHANGED')
        finally:
            os.close(verify_fd)
        return usage, identity
    except OSError:
        raise Refusal('OWNED_DEVICE_DIRECTORY_REQUIRED') from None
    finally:
        os.close(fd)


class Run:
    def __init__(self, root, receipt, case, toolchain):
        self.root = Path(root)
        self.receipt = Path(receipt)
        self.case = case
        self.toolchain = toolchain
        self.started = time.monotonic()
        self.deadline = self.started + ABSOLUTE_SECONDS
        self.device = None
        self.device_identity = None
        self.create_attempted = False
        self.device_name = 'YAWFQA' + secrets.token_hex(5)
        self.fixture = None
        self.fixture_log = None
        self.commands = []
        self.before = None
        self.marker_seq = None
        source_sha = os.environ.get('GITHUB_SHA', '')
        self.result = {'schemaVersion': 1, 'case': case, 'scope': 'hosted-ipad-simulator-foreground',
                       'status': 'refused', 'fullQualification': False, 'deviceCreated': False,
                       'deviceDeleted': False, 'fixtureBoundaryOnly': True, 'simulatorWideEgressIsolation': False,
                       'sourceSha': source_sha if re.fullmatch('[a-f0-9]{40}', source_sha) else None,
                       'sourceShaAdmitted': False, 'phase': 'initialization', 'lastCommand': None,
                       'commandSuccess': {}, 'primaryCode': None, 'cleanupCode': None,
                       'cleanupObservationUnavailable': False}
        require(self.root.is_absolute() and not self.root.exists() and self.root.parent.resolve() == self.root.parent,
                'FRESH_CANONICAL_ROOT_REQUIRED')
        require(self.receipt.is_absolute() and self.receipt.parent.is_dir() and self.receipt.parent.resolve() == self.receipt.parent and
                not self.receipt.is_symlink() and self.root not in self.receipt.parents and self.receipt.parent not in self.root.parents, 'SEPARATE_OWNED_RECEIPT_ROOT')
        guard.admit_start(self.root.parent)
        self.root.mkdir(mode=0o700)
        for name in ('tmp', 'Derived', 'configs', 'fixture'):
            (self.root / name).mkdir(mode=0o700)
        self.env = dict(os.environ, DEVELOPER_DIR=DEVELOPER, TMPDIR=str(self.root / 'tmp'),
                        CLANG_MODULE_CACHE_PATH=str(self.root / 'tmp/clang-modules'),
                        SWIFT_MODULE_CACHE_PATH=str(self.root / 'tmp/swift-modules'))
        self.token = secrets.token_hex(32)

    def set_phase(self, phase):
        require(phase in PHASES, 'INVALID_PHASE')
        self.result['phase'] = phase

    def start_command(self, label):
        require(label in COMMAND_LABELS, 'INVALID_COMMAND_LABEL')
        self.result['lastCommand'] = label
        self.result['commandSuccess'][label] = False

    def finish_command(self, label):
        require(label in COMMAND_LABELS and self.result['lastCommand'] == label, 'INVALID_COMMAND_LABEL')
        self.result['commandSuccess'][label] = True

    def monitor(self):
        require(time.monotonic() < self.deadline - CLEANUP_SECONDS, 'ABSOLUTE_DEADLINE')
        usage = guard.admit_runtime(self.root)
        public_usage = guard.measure(self.receipt.parent)
        allocated = usage['allocatedBytes'] + public_usage['allocatedBytes']
        require(usage['diagnosticLogicalBytes'] + public_usage['logicalBytes'] <= guard.MAX_DIAGNOSTIC - 4096,
                'COMBINED_DIAGNOSTIC_CAP')
        if self.device:
            device = Path.home() / 'Library/Developer/CoreSimulator/Devices' / self.device
            device_usage, self.device_identity = measure_owned_device(device, self.root, self.device_identity)
            allocated += device_usage['allocatedBytes']
        require(allocated <= guard.MAX_ALLOCATED - 4096, 'OWNED_DEVICE_AND_RUNTIME_CAP')

    def stop(self, process):
        if not process: return
        try: os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError: return
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: pass
        # A producer can outlive its launcher. Only its new session group is
        # eligible for termination; never search for or kill unrelated ffmpeg.
        try: os.killpg(process.pid, 0)
        except ProcessLookupError: return
        try: os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        if process.poll() is None: process.wait(timeout=4)

    def command(self, label, args, seconds, *, env=None, monitor=True):
        self.start_command(label)
        log = self.root / f'{len(self.commands):03d}-{label}.log'
        canary = label == 'network-canary'
        stderr_path = self.root / f'{len(self.commands):03d}-network-canary-stderr.log'
        if canary:
            self.result['networkCanary'] = {'exitCode': None, 'errno': None, 'stderrPresent': False, 'stderrClass': 'not-started'}
        with log.open('xb') as output:
            stderr_file = stderr_path.open('xb') if canary else None
            try:
                process = subprocess.Popen(args, stdout=output, stderr=stderr_file if canary else subprocess.STDOUT,
                                           env=env or self.env, start_new_session=True)
                end = min(self.deadline - CLEANUP_SECONDS, time.monotonic() + seconds)
                try:
                    while process.poll() is None and time.monotonic() < end:
                        if monitor: self.monitor()
                        time.sleep(.5)
                    require(process.poll() is not None, 'COMMAND_TIMEOUT_' + label.upper())
                    require(process.returncode == 0, 'COMMAND_FAILED_' + label.upper())
                finally:
                    try: self.stop(process)
                    finally:
                        if canary:
                            output.flush(); stderr_file.flush()
                            stdout = log.read_bytes() if log.stat().st_size <= 16 else b''
                            stderr = stderr_path.read_bytes() if stderr_path.stat().st_size <= 32768 else b'x' * 32769
                            self.result['networkCanary'] = canary_diagnostic(process.returncode, stdout, stderr)
            finally:
                if stderr_file is not None: stderr_file.close()
        require(log.stat().st_size <= 4 * 1024 * 1024, 'COMMAND_OUTPUT_LIMIT')
        self.finish_command(label)
        self.commands.append(label)
        return log.read_text(errors='replace')

    def inventory(self):
        result = self.command('inventory', ['/usr/bin/xcrun', 'simctl', 'list', 'devices', '--json'], 20)
        info = json.loads(result)
        return {item['udid']: (runtime, item) for runtime, items in info['devices'].items() for item in items}

    def prepare(self):
        self.set_phase('host-admission')
        require(os.uname().machine == 'arm64' and Path(DEVELOPER).is_dir(), 'EXPECTED_HOST_AND_XCODE')
        version = self.command('xcode-version', ['/usr/bin/xcodebuild', '-version'], 20)
        require('Xcode 26.5' in version and 'Build version 17F42' in version, 'XCODE_VERSION_REFUSED')
        runtime_data = json.loads(self.command('runtimes', ['/usr/bin/xcrun', 'simctl', 'list', 'runtimes', '--json'], 20))
        available = [x for x in runtime_data['runtimes'] if x.get('identifier') == RUNTIME and x.get('isAvailable') is True]
        require(len(available) == 1, 'IOS_26_5_RUNTIME_REFUSED')
        types = json.loads(self.command('device-types', ['/usr/bin/xcrun', 'simctl', 'list', 'devicetypes', '--json'], 20))
        require(sum(x.get('identifier') == DEVICE for x in types['devicetypes']) == 1, 'IPAD_A16_TYPE_REFUSED')
        self.before = self.inventory()
        require(all(x[1].get('name') != self.device_name for x in self.before.values()), 'DEVICE_NAME_COLLISION')
        require(all(unavailable(port) for port in (43120, 43121)), 'OWNED_PORTS_REQUIRED')
        require(re.fullmatch('[a-f0-9]{40}', os.environ.get('GITHUB_SHA', '')) is not None, 'SOURCE_SHA_REQUIRED')
        self.result['sourceSha'] = os.environ['GITHUB_SHA']
        self.result['sourceShaAdmitted'] = True
        self.set_phase('toolchain-admission')
        self.result['sourceHashes'] = {name: sha(REPO / name) for name in (
            'web/src/components/VideoPlayer.tsx', 'web/src/components/EmbeddedPlayer.tsx',
            'server/src/transcodeSession.ts', 'server/src/transcode.ts', 'server/src/app.ts')}
        node = Path(self.toolchain['node']).resolve()
        ffmpeg = Path(self.toolchain['ffmpeg']).resolve()
        ffprobe = Path(self.toolchain['ffprobe']).resolve()
        require(ffmpeg.parent == ffprobe.parent and all(p.is_file() and os.access(p, os.X_OK) for p in (node, ffmpeg, ffprobe)), 'TOOLCHAIN_PATHS')
        require(sha(ffmpeg) == self.toolchain['ffmpegSha256'] and sha(ffprobe) == self.toolchain['ffprobeSha256'] and
                re.fullmatch('[a-f0-9]{64}', self.toolchain['bottleSha256']) is not None and
                re.fullmatch('[a-f0-9]{40}', self.toolchain['formulaCommit']) is not None, 'TOOLCHAIN_PROVENANCE')
        self.node, self.ffmpeg, self.ffprobe = node, ffmpeg, ffprobe
        self.result['toolchain'] = {k: self.toolchain[k] for k in ('formulaVersion', 'formulaCommit', 'bottleSha256', 'ffmpegSha256', 'ffprobeSha256', 'nodeVersion')}
        self.env['PATH'] = str(ffmpeg.parent) + os.pathsep + str(node.parent) + ':/usr/bin:/bin:/usr/sbin:/sbin'
        filters = self.command('ffmpeg-filters', [str(ffmpeg), '-hide_banner', '-filters'], 20)
        encoders = self.command('ffmpeg-encoders', [str(ffmpeg), '-hide_banner', '-encoders'], 20)
        require(re.search(r'\bdrawtext\b', filters) and re.search(r'\blibx264\b', encoders) and re.search(r'\baac\b', encoders), 'FFMPEG_CAPABILITIES')
        self.monitor()
        self.set_phase('device-creation')
        self.create_attempted = True
        created = self.command('create-device', ['/usr/bin/xcrun', 'simctl', 'create', self.device_name, DEVICE, RUNTIME], 30)
        candidate = created.strip()
        require(str(uuid.UUID(candidate)).lower() == candidate.lower() and candidate not in self.before, 'NEW_DEVICE_UUID_REQUIRED')
        self.device = candidate.upper()
        self.result['deviceCreated'] = True
        # Refuse rather than quietly exclude owned simulator allocations.
        self.monitor()
        fresh = self.inventory()
        require(self.device in fresh and fresh[self.device][0] == RUNTIME and fresh[self.device][1].get('deviceTypeIdentifier') == DEVICE and fresh[self.device][1].get('name') == self.device_name, 'NEW_DEVICE_IDENTITY')
        self.set_phase('native-build')
        self.command('build', ['/usr/bin/xcodebuild', 'build-for-testing', '-project', str(PROJECT), '-scheme', 'NativeQA',
                              '-destination', 'platform=iOS Simulator,id=' + self.device, '-derivedDataPath', str(self.root / 'Derived'),
                              '-parallel-testing-enabled', 'NO', '-jobs', '1', 'CODE_SIGNING_ALLOWED=NO'], 300)
        runs = list((self.root / 'Derived/Build/Products').glob('*.xctestrun'))
        require(len(runs) == 1 and runs[0].is_file() and not runs[0].is_symlink(), 'ONE_XCTESTRUN_REQUIRED')
        self.xctestrun = runs[0]
        self.set_phase('device-boot')
        self.command('boot', ['/usr/bin/xcrun', 'simctl', 'boot', self.device], 30)
        self.command('bootstatus', ['/usr/bin/xcrun', 'simctl', 'bootstatus', self.device, '-b'], 120)

    def start_fixture(self):
        self.set_phase('fixture-admission')
        sandbox = self.root / 'configs/fixture.sb'
        sandbox.write_text(profile(self.root))
        # Both controls must fail by sandbox permission, not an unreachable network.
        canary = "import errno,socket; s=socket.socket(); e=s.connect_ex(('192.0.2.1',9)); print(e); raise SystemExit(0 if e in (errno.EPERM,errno.EACCES) else 1)"
        self.command('network-canary', ['/usr/bin/sandbox-exec', '-f', str(sandbox), '/usr/bin/python3', '-c', canary], 10)
        self.start_command('ffmpeg-network-canary')
        ff_canary = subprocess.run(['/usr/bin/sandbox-exec', '-f', str(sandbox), str(self.ffmpeg), '-nostdin', '-hide_banner',
                                    '-loglevel', 'error', '-i', 'http://192.0.2.1:9/qa', '-f', 'null', '-'],
                                   env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10)
        require(ff_canary.returncode != 0 and any(x in ff_canary.stderr for x in (b'Operation not permitted', b'Permission denied')), 'FFMPEG_NETWORK_CANARY')
        self.finish_command('ffmpeg-network-canary')
        self.monitor()
        env = dict(self.env, HOME=str(self.root), IPAD_QA_CONTROL_TOKEN=self.token)
        self.fixture_log = (self.root / 'fixture.log').open('xb')
        self.start_command('fixture')
        self.fixture = subprocess.Popen(['/usr/bin/sandbox-exec', '-f', str(sandbox), str(self.node),
            str(REPO / 'server/node_modules/tsx/dist/cli.mjs'), str(REPO / 'scripts/android_external_player_server_fixture.mts'),
            '--repo', str(REPO), '--output', str(self.root / 'fixture'), '--foreground-long', '--ipad-foreground'],
            env=env, stdout=self.fixture_log, stderr=subprocess.STDOUT, start_new_session=True)
        end = min(self.deadline - CLEANUP_SECONDS, time.monotonic() + 360)
        status = self.root / 'fixture/foreground-fixture-status.json'
        while time.monotonic() < end:
            self.monitor()
            require(self.fixture.poll() is None, 'FIXTURE_EXITED')
            if status.exists():
                value = read_json(status)
                if value.get('status') == 'refused': raise Refusal('FIXTURE_REFUSED')
                if value.get('status') == 'ready':
                    self.finish_command('fixture')
                    return
            time.sleep(.5)
        raise Refusal('FIXTURE_READY_TIMEOUT')

    def native(self):
        self.set_phase('native-test')
        config = plistlib.loads(self.xctestrun.read_bytes())
        products = self.xctestrun.parent
        def expand(value):
            if isinstance(value, str): return value.replace('__TESTROOT__', str(products))
            if isinstance(value, list): return [expand(v) for v in value]
            if isinstance(value, dict): return {k: expand(v) for k, v in value.items()}
            return value
        config = expand(config)
        env = config['SafariNativeInputTests']['EnvironmentVariables']
        require(not any(k.startswith(('QA_', 'SIMULATOR_')) for k in env), 'CLEAN_TEST_ENV_REQUIRED')
        lane = self.case.removeprefix('admission-')
        seconds = 15 if self.case.startswith('admission-') else (180 if lane == 'stall' else 480)
        env.update({'QA_EXPECTED_UDID': self.device,
                    'QA_EXPECTED_DEVICE_NAME': self.device_name,
                    'QA_ORIGIN': 'http://127.0.0.1:43120', 'QA_CLIP_NAME': self.device_name,
                    'QA_CONTROL_TOKEN': self.token, 'QA_MEDIA': lane, 'QA_WINDOW_SECONDS': str(seconds)})
        cfg = self.root / 'configs/owned.xctestrun'
        cfg.write_bytes(plistlib.dumps(config)); os.chmod(cfg, 0o600)
        logpath = self.root / 'native.log'
        command = ['/usr/bin/xcodebuild', 'test-without-building', '-xctestrun', str(cfg),
                   '-destination', 'platform=iOS Simulator,id=' + self.device, '-parallel-testing-enabled', 'NO',
                   '-maximum-concurrent-test-simulator-destinations', '1', '-jobs', '1', '-only-testing:' + SELECTOR,
                   '-resultBundlePath', str(self.root / 'native.xcresult'), '-test-timeouts-enabled', 'YES',
                   '-default-test-execution-time-allowance', '900', '-maximum-test-execution-time-allowance', '900']
        pattern = re.compile(r'IPAD_QA_WINDOW_BEGIN_(DIRECT|HLS|STALL)_(15|180|480)_([a-f0-9]{32})_(\d+)_(\d+)')
        begin = None
        self.start_command('native-test')
        with logpath.open('xb') as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, env=self.env, start_new_session=True)
            end = min(self.deadline - CLEANUP_SECONDS, time.monotonic() + 900)
            try:
                while process.poll() is None and time.monotonic() < end:
                    self.monitor()
                    require(self.fixture.poll() is None, 'FIXTURE_DIED_DURING_NATIVE')
                    if logpath.stat().st_size <= 8 * 1024 * 1024:
                        text = logpath.read_text(errors='replace')
                        matches = pattern.findall(text)
                        require(len(matches) <= 1, 'AMBIGUOUS_NATIVE_BASELINE')
                        if matches: begin = matches[0]
                    else: raise Refusal('NATIVE_LOG_LIMIT')
                    if lane == 'stall' and begin and self.marker_seq is None:
                        ledger = self.root / 'fixture/ipad-observations.jsonl'
                        if ledger.exists() and ledger.stat().st_size <= 8 * 1024 * 1024:
                            rows = [json.loads(line) for line in ledger.read_text().splitlines() if line]
                            current = [r['observation'] for r in rows if r.get('kind') == 'browser' and r['observation'].get('document') == begin[2] and r['observation'].get('sourceOrdinal') == int(begin[4])]
                            if current:
                                latest = max(current, key=lambda x: x['seq'])
                                if latest['sourceKind'] == 'hls' and latest['bufferAhead'] is not None and latest['bufferAhead'] <= 15:
                                    self.marker_seq = latest['seq']
                                    (self.root / 'fixture/hold-segments').write_text('hold\n')
                    time.sleep(.5)
                require(process.poll() is not None, 'NATIVE_TIMEOUT')
                require(process.returncode == 0, 'NATIVE_TEST_FAILED')
            finally:
                self.stop(process)
        text = logpath.read_text(errors='replace')
        matches = pattern.findall(text)
        require(len(matches) == 1, 'NATIVE_BASELINE_REQUIRED')
        begin = matches[0]
        require(begin[0] == lane.upper() and int(begin[1]) == seconds, 'NATIVE_LANE_MISMATCH')
        require('Executed 1 test, with 0 failures' in text, 'EXACT_ONE_NATIVE_TEST_REQUIRED')
        self.finish_command('native-test')
        self.set_phase('evidence')
        # Permit late asynchronous collector delivery, without touching media.
        time.sleep(3)
        self.monitor()
        evidence_args = {'document': begin[2], 'baselineSeq': int(begin[3]), 'sourceOrdinal': int(begin[4]),
                         'kind': lane, 'seconds': seconds, 'markerSeq': self.marker_seq,
                         'segmentHeld': (self.root / 'fixture/segment-held').is_file()}
        argpath = self.root / 'configs/evidence.json'
        argpath.write_text(json.dumps(evidence_args)); os.chmod(argpath, 0o600)
        resultpath = self.root / 'case-result.json'
        try:
            self.command('evaluate', [str(self.node), str(REPO / 'scripts/ipad-foreground/evaluate_cli.mjs'),
                str(self.root / 'fixture/ipad-observations.jsonl'), str(argpath), str(resultpath)], 20)
        except Refusal:
            if resultpath.exists():
                result = read_json(resultpath)
                code = result.get('code', 'EVIDENCE_FAILED')
                raise Refusal(code if isinstance(code, str) and re.fullmatch('[A-Za-z0-9_-]{1,64}', code) else 'EVIDENCE_FAILED')
            raise
        result = read_json(resultpath)
        require(result.get('ok') is True, 'EVIDENCE_FAILED')
        ledger = self.root / 'fixture/ipad-observations.jsonl'
        require(ledger.is_file() and ledger.stat().st_size <= 8 * 1024 * 1024, 'BOUNDED_LEDGER_REQUIRED')
        provenance = [r for r in (json.loads(line) for line in ledger.read_text().splitlines()) if r.get('kind') == 'html-provenance']
        require(len(provenance) == 1 and isinstance(provenance[0].get('assets'), dict) and
                re.fullmatch('[a-f0-9]{64}', provenance[0].get('originalSha256', '')) and
                re.fullmatch('[a-f0-9]{64}', provenance[0].get('servedSha256', '')) and
                re.fullmatch('[a-f0-9]{64}', provenance[0]['assets'].get('sha256', '')), 'ASSET_PROVENANCE_REQUIRED')
        self.result['assetProvenance'] = {k: provenance[0][k] for k in ('originalSha256', 'servedSha256', 'assets')}
        self.result['observation'] = result
        if lane in ('direct', 'hls'):
            export = self.root / 'tmp/attachments'
            self.command('export-attachments', ['/usr/bin/xcrun', 'xcresulttool', 'export', 'attachments', '--path',
                         str(self.root / 'native.xcresult'), '--output-path', str(export)], 60)
            output = self.receipt.parent / 'anchors'
            staging = self.root / 'tmp/validated-anchors'
            anchors.extract(export, staging, lane, seconds, self.result['sourceSha'], self.result['assetProvenance'])
            self.result['anchorManifestSha256'] = sha(staging / 'manifest.json')
            require(not output.exists() and self.root.stat().st_dev == self.receipt.parent.stat().st_dev, 'ATOMIC_ANCHOR_PUBLISH_REQUIRED')
            staging.rename(output)
            self.monitor()
        self.result['status'] = 'admission-only' if seconds == 15 else 'observation-only'
        self.result['manualPixelReviewPending'] = True
        self.result['fullQualification'] = False

    def cleanup(self):
        errors = []
        try: self.stop(self.fixture)
        except Exception: errors.append('FIXTURE_TERMINATION')
        try:
            if self.fixture_log: self.fixture_log.close()
        except Exception: errors.append('FIXTURE_LOG_CLOSE')
        # No create command means no owned device can have been created by this
        # run. A failed earlier inventory is an observation gap, not a failed
        # deletion. An attempted create always requires the existing census.
        if not self.create_attempted and self.device is None:
            self.result['cleanupObservation'] = 'not-required-no-create'
            if self.before is None and self.result['commandSuccess'].get('inventory') is False:
                self.result['cleanupObservationUnavailable'] = True
            if self.result['status'] in ('admission-only', 'observation-only'):
                self.result['status'] = 'refused'
                self.result['primaryCode'] = 'DEVICE_CREATION_NOT_ATTEMPTED'
                self.result['code'] = 'DEVICE_CREATION_NOT_ATTEMPTED'
        else:
            try:
                require(self.before is not None, 'CLEANUP_BASELINE_MISSING')
                result = subprocess.run(['/usr/bin/xcrun', 'simctl', 'list', 'devices', '--json'], env=self.env,
                                        capture_output=True, timeout=15, check=True)
                items = [(runtime, x) for runtime, rows in json.loads(result.stdout)['devices'].items() for x in rows]
                candidates = [x for runtime, x in items if x.get('name') == self.device_name and runtime == RUNTIME and x.get('udid') not in self.before]
                require(len(candidates) <= 1, 'CLEANUP_AMBIGUOUS_DEVICE')
                if self.device is None and len(candidates) == 1:
                    self.device = candidates[0]['udid']; self.result['deviceCreated'] = True
                if self.device:
                    require(len(candidates) == 1 and candidates[0]['udid'].lower() == self.device.lower(), 'CLEANUP_IDENTITY')
                    if candidates[0].get('state') == 'Booted':
                        subprocess.run(['/usr/bin/xcrun', 'simctl', 'shutdown', self.device], env=self.env, capture_output=True, timeout=15, check=True)
                    subprocess.run(['/usr/bin/xcrun', 'simctl', 'delete', self.device], env=self.env, capture_output=True, timeout=15, check=True)
                    after_raw = subprocess.run(['/usr/bin/xcrun', 'simctl', 'list', 'devices', '--json'], env=self.env,
                                               capture_output=True, timeout=10, check=True)
                    after = {x['udid'] for rows in json.loads(after_raw.stdout)['devices'].values() for x in rows}
                    require(self.device not in after and set(self.before).issubset(after), 'POST_CLEANUP_DEVICE_CENSUS')
                    self.result['deviceDeleted'] = True
                self.result['cleanupObservation'] = 'observed'
            except Refusal:
                self.result['cleanupObservation'] = 'unsafe'
                errors.append('OWNED_DEVICE_CLEANUP')
            except Exception:
                self.result['cleanupObservation'] = 'unavailable'
                self.result['cleanupObservationUnavailable'] = True
                errors.append('OWNED_DEVICE_CLEANUP')
        try:
            if not all(unavailable(port) for port in (43120, 43121)): errors.append('FIXTURE_PORTS_STILL_OPEN')
        except Exception: errors.append('FIXTURE_PORT_CENSUS')
        self.result['cleanupErrors'] = errors
        self.result['elapsedSeconds'] = round(time.monotonic() - self.started, 3)
        if errors:
            self.result['status'] = 'refused'
            self.result['cleanupCode'] = 'CLEANUP_FAILED'
            if not self.result.get('code'): self.result['code'] = 'CLEANUP_FAILED'
        self.receipt.parent.mkdir(parents=True, exist_ok=True)
        self.receipt.write_text(json.dumps(self.result, sort_keys=True) + '\n')
        os.chmod(self.receipt, 0o600)
        return not errors


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--receipt', required=True)
    parser.add_argument('--case', choices=['admission-direct', 'admission-hls', 'direct', 'hls', 'stall'], required=True)
    parser.add_argument('--toolchain', required=True)
    args = parser.parse_args()
    run = None
    try:
        run = Run(args.root, args.receipt, args.case, read_json(args.toolchain))
        run.prepare(); run.start_fixture(); run.native()
    except Exception as error:
        code = str(error) if isinstance(error, (Refusal, guard.Refusal)) else 'UNEXPECTED_FAILURE'
        if not re.fullmatch('[A-Za-z0-9_-]{1,64}', code): code = 'UNEXPECTED_FAILURE'
        if run is None:
            Path(args.receipt).parent.mkdir(parents=True, exist_ok=True)
            source_sha = os.environ.get('GITHUB_SHA', '')
            Path(args.receipt).write_text(json.dumps({'schemaVersion': 1, 'case': args.case, 'status': 'refused', 'code': code,
                'primaryCode': code, 'cleanupCode': None, 'sourceSha': source_sha if re.fullmatch('[a-f0-9]{40}', source_sha) else None,
                'sourceShaAdmitted': False, 'phase': 'initialization', 'lastCommand': None, 'commandSuccess': {},
                'cleanupObservationUnavailable': False, 'fullQualification': False}) + '\n')
            return 1
        run.result['code'] = code
        run.result['primaryCode'] = code
    finally:
        if run is not None:
            if not run.cleanup(): return 1
    return 0 if run.result['status'] in ('admission-only', 'observation-only') else 1


if __name__ == '__main__':
    sys.exit(main())
