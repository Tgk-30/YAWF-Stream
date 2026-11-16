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
import stat
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
CENSUS_INTERVAL_SECONDS = 30
RESOURCE_CODES = frozenset(('ABSOLUTE_DEADLINE', 'REMAINING_6_GIB_REQUIRED', 'RUNTIME_ROOT_CHANGED',
    'RECEIPT_ROOT_CHANGED', 'OWNED_DEVICE_UUID_PATH', 'OWNED_DEVICE_DIRECTORY_REQUIRED', 'OWNED_DEVICE_IDENTITY_CHANGED',
    'OWNED_DEVICE_VOLUME_MISMATCH', 'RUNTIME_FILE_COUNT_LIMIT', 'RUNTIME_1P5_GIB_CAP', 'DIAGNOSTIC_250_MIB_CAP',
    'COMBINED_DIAGNOSTIC_CAP', 'OWNED_DEVICE_AND_RUNTIME_CAP', 'MEASUREMENT_60S_LIMIT', 'MEASUREMENT_ENTRY_LIMIT',
    'DIRECTORY_REPLACED', 'DIRECTORY_IDENTITY_CHANGED', 'DIRECTORY_REQUIRED', 'BLOCK_COUNT_UNAVAILABLE',
    'DIRECTORY_NOFOLLOW_UNAVAILABLE', 'ABSOLUTE_OWNED_ROOT_REQUIRED'))
RESOURCE_FIELDS = ('allocatedBytes', 'logicalBytes', 'diagnosticLogicalBytes', 'files', 'directories', 'symlinkCount', 'entryCount')
COMMAND_LABELS = frozenset(('xcode-version', 'runtimes', 'device-types', 'inventory', 'ffmpeg-filters',
                            'ffmpeg-encoders', 'create-device', 'build', 'boot', 'bootstatus',
                            'network-canary', 'ffmpeg-network-canary', 'fixture', 'native-test',
                            'evaluate', 'export-attachments'))
PHASES = frozenset(('initialization', 'host-admission', 'toolchain-admission', 'device-creation',
                    'native-build', 'device-boot', 'fixture-admission', 'native-test', 'evidence'))
PROFILE_OPERATORS = frozenset(('version', 'allow', 'default', 'deny', 'network*', 'network-inbound',
                               'network-outbound', 'local', 'remote', 'ip', 'file-write*', 'require-all',
                               'require-not', 'subpath', 'literal'))
FIXTURE_STAGES = frozenset(('input-check', 'media-preflight', 'mp4-generation', 'static-hls-generation',
    'media-probe', 'media-output-check', 'long-mp4-generation', 'long-media-probe', 'runtime-init', 'media-listen',
    'server-build', 'seed-owner', 'seed-credentials', 'seed-settings', 'seed-watchlist', 'smoke-media', 'smoke-addon',
    'smoke-outbound', 'smoke-login', 'smoke-bootstrap', 'smoke-watchlist', 'smoke-discover', 'smoke-detail',
    'smoke-streams', 'smoke-resolve', 'smoke-proxy-full', 'smoke-proxy-range', 'smoke-external-full',
    'smoke-external-range', 'smoke-web', 'smoke-receipt', 'server-listen', 'ready'))
FIXTURE_FAILURES = frozenset(('input-missing', 'input-invalid', 'ffmpeg-execution', 'ffmpeg-exit',
    'ffmpeg-filter-missing', 'font-missing', 'probe-execution', 'probe-exit', 'probe-json', 'probe-streams',
    'probe-codecs', 'media-layout', 'media-file', 'http-status', 'csrf-missing', 'smoke-assertion',
    'json-response', 'unclassified-error'))


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


def read_json(path, limit=16 * 1024, *, reject_duplicates=False):
    path = Path(path)
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= limit, 'BOUNDED_FILE_REQUIRED')
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result: raise ValueError('DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    if not reject_duplicates:
        return json.loads(path.read_text())
    require(hasattr(os, 'O_NOFOLLOW'), 'NOFOLLOW_REQUIRED')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_size <= limit, 'BOUNDED_FILE_REQUIRED')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(limit + 1)
        require(len(data) <= limit, 'BOUNDED_FILE_REQUIRED')
        return json.loads(data, object_pairs_hook=unique_pairs)
    finally:
        os.close(fd)


def fixture_diagnostic(path):
    """Only fixed fixture status fields may enter the sanitized receipt."""
    try:
        value = read_json(path, reject_duplicates=True)
        if not isinstance(value, dict) or set(value) != {'schemaVersion', 'stage', 'status', 'failureCode', 'childExitCode'}:
            return 'unavailable'
        stage, status, failure, child = value['stage'], value['status'], value['failureCode'], value['childExitCode']
        if type(value['schemaVersion']) is not int or value['schemaVersion'] != 1 or \
           not isinstance(stage, str) or stage not in FIXTURE_STAGES or \
           not isinstance(status, str) or status not in ('running', 'refused', 'ready'):
            return 'unavailable'
        if failure is not None and (not isinstance(failure, str) or failure not in FIXTURE_FAILURES):
            return 'unavailable'
        if child is not None and (type(child) is not int or not 0 <= child <= 255):
            return 'unavailable'
        if (status == 'refused') != (failure is not None) or \
           (status != 'refused' and child is not None) or \
           (status == 'ready' and stage != 'ready') or (status == 'running' and stage == 'ready'):
            return 'unavailable'
        return {key: value[key] for key in ('schemaVersion', 'stage', 'status', 'failureCode', 'childExitCode')}
    except (OSError, UnicodeError, ValueError, TypeError, Refusal):
        return 'unavailable'


def unavailable(port):
    with socket.socket() as sock:
        sock.settimeout(.3)
        return sock.connect_ex(('127.0.0.1', port)) != 0


def profile(root):
    text = str(root)
    require(not any(x in text for x in ('"', '\\', '\n', '\r', '\0')), 'SANDBOX_PATH_REFUSED')
    return ('(version 1)\n(allow default)\n(deny network*)\n'
            '(allow network-inbound (local ip "localhost:43120"))\n'
            '(allow network-inbound (local ip "localhost:43121"))\n'
            '(allow network-outbound (remote ip "localhost:*"))\n'
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
    operator, parser_line = None, None
    if present and len(stderr) > 32768:
        kind = 'oversize'
    elif present:
        text = stderr.lower()
        if b'unbound variable' in text or b'unbound-variable' in text:
            kind = 'unbound-variable'
        elif any(x in text for x in (b'syntax error', b'error parsing', b'invalid profile', b'unexpected token', b'unknown filter', b'unknown operation')):
            kind = 'sandbox-profile-parse'
        elif b'sbpl' in text:
            kind = 'sbpl-diagnostic'
        elif re.search(rb'\binvalid\b', text):
            kind = 'invalid-diagnostic'
        elif b'sandbox' in text and any(x in text for x in (b'sandbox_init', b'failed to apply', b'sandbox_apply')):
            kind = 'sandbox-apply'
        elif b'sandbox-exec:' in text and b'execvp' in text and b'python3' in text and any(x in text for x in (b'operation not permitted', b'permission denied')):
            kind = 'python-exec-denied'
        elif any(x in text for x in (b'xcrun:', b'xcode-select:', b'no developer tools', b'command line developer tools')):
            kind = 'python-shim'
        else:
            kind = 'other'
        if kind in ('unbound-variable', 'sandbox-profile-parse', 'sbpl-diagnostic', 'invalid-diagnostic'):
            tokens = re.findall(rb'(?:unbound[- ]variable|unknown (?:operation|filter)|invalid operator)\s*[:=]?\s*[\x27\x22\x60]?([a-z][a-z0-9*-]{0,31})(?![a-z0-9*-])', text)
            admitted = {token.decode('ascii') for token in tokens if token.decode('ascii') in PROFILE_OPERATORS}
            if len(admitted) == 1: operator = admitted.pop()
            lines = {int(value) for value in re.findall(rb'\bline(?:\s+number)?\s*[:#]?\s*([0-9]{1,4})\b', text)}
            if len(lines) == 1 and 1 <= next(iter(lines)) <= 1000: parser_line = next(iter(lines))
    return {'exitCode': code, 'errno': number, 'stderrPresent': present, 'stderrClass': kind,
            'operator': operator, 'parserLine': parser_line}


def native_refusal_code(text):
    if not isinstance(text, str) or len(text) > 8 * 1024 * 1024:
        return None
    prefix = 'IPAD_QA_NATIVE_REFUSAL='
    lines = [line[:-1] if line.endswith('\r') else line for line in text.split('\n') if line.startswith(prefix)]
    if len(lines) != 1:
        return None
    match = re.fullmatch(r'IPAD_QA_NATIVE_REFUSAL=([A-Za-z0-9_-]{1,96})', lines[0])
    return match.group(1) if match else None


def directory_facts(path, failure):
    try:
        fd = guard._root_fd(path)
        try:
            info = os.fstat(fd)
            volume = os.fstatvfs(fd)
            return (info.st_dev, info.st_ino), volume.f_bavail * volume.f_frsize
        finally:
            os.close(fd)
    except OSError:
        raise Refusal(failure) from None


class BootStatusDiagnostic:
    """Only monotonic timings, counts and owned-log size, never log contents."""
    def __init__(self, started):
        self.started = started
        self.poll_count = 0
        self.monitor_calls = 0
        self.monitor_total = 0.0
        self.monitor_max = 0.0
        self.log_bytes = 0
        self.last_size = 0
        self.growth_events = 0
        self.first_growth = None
        self.last_growth = None

    def monitor_finished(self, started, finished):
        duration = max(0.0, finished - started)
        self.monitor_calls += 1
        self.monitor_total += duration
        self.monitor_max = max(self.monitor_max, duration)

    def observe_log(self, fd, now):
        try:
            size = os.fstat(fd).st_size
            if size < 0: raise ValueError('NEGATIVE_SIZE')
        except (OSError, ValueError):
            self.log_bytes = None
            return
        self.log_bytes = size
        if size > self.last_size:
            elapsed = round(max(0.0, now - self.started) * 1000, 3)
            self.growth_events += 1
            if self.first_growth is None: self.first_growth = elapsed
            self.last_growth = elapsed
        self.last_size = size

    def finish(self, now, deadline, exit_code):
        if exit_code is None:
            exit_class = 'running-at-deadline' if now >= deadline else None
        elif exit_code == 0:
            exit_class = 'zero'
        elif exit_code < 0:
            exit_class = 'signal'
        else:
            exit_class = 'nonzero'
        return {'elapsedMs': round(max(0.0, now - self.started) * 1000, 3),
                'pollCount': self.poll_count, 'monitorCalls': self.monitor_calls,
                'monitorTotalMs': round(self.monitor_total * 1000, 3), 'monitorMaxMs': round(self.monitor_max * 1000, 3),
                'ownedLogBytes': self.log_bytes, 'growthEvents': self.growth_events,
                'firstGrowthMs': self.first_growth, 'lastGrowthMs': self.last_growth, 'exitClass': exit_class}


def measure_owned_device(device, runtime_root, expected_identity, *, census=None):
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
        usage = guard.measure(device, census=census) if census is not None else guard.measure(device)
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
        self.network_admitted = False
        self.network_profile_sha = None
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
                       'cleanupObservationUnavailable': False, 'networkAdmitted': False}
        require(self.root.is_absolute() and not self.root.exists() and self.root.parent.resolve() == self.root.parent,
                'FRESH_CANONICAL_ROOT_REQUIRED')
        require(self.receipt.is_absolute() and self.receipt.parent.is_dir() and self.receipt.parent.resolve() == self.receipt.parent and
                not self.receipt.is_symlink() and self.root not in self.receipt.parents and self.receipt.parent not in self.root.parents, 'SEPARATE_OWNED_RECEIPT_ROOT')
        guard.admit_start(self.root.parent)
        self.root.mkdir(mode=0o700)
        for name in ('tmp', 'Derived', 'configs', 'fixture'):
            (self.root / name).mkdir(mode=0o700)
        self.root_identity, _ = directory_facts(self.root, 'RUNTIME_ROOT_CHANGED')
        self.receipt_identity, _ = directory_facts(self.receipt.parent, 'RECEIPT_ROOT_CHANGED')
        self.last_census_completed = None
        self.result['resourceDiagnostic'] = {'schemaVersion': 1, 'fullScanCount': 0, 'totalScanMs': 0.0,
            'maxScanMs': 0.0, 'minFreeBytes': None, 'last': None,
            'peak': {'combinedAllocatedBytes': 0, 'combinedIsLowerBound': False, 'roles': {}}, 'refusal': None}
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

    def resource_context(self):
        phase = self.result.get('phase')
        if phase not in PHASES: phase = 'initialization'
        fixture = self.result.get('fixtureDiagnostic')
        stage = fixture.get('stage') if isinstance(fixture, dict) else None
        if stage not in FIXTURE_STAGES: stage = None
        return {'phase': phase, 'lastFixtureStage': stage}

    def resource_refusal(self, error, role):
        code = str(error) if str(error) in RESOURCE_CODES else 'RESOURCE_CHECK_FAILED'
        self.result['resourceDiagnostic']['refusal'] = {**self.resource_context(), 'role': role, 'code': code}

    def cheap_monitor(self):
        role = 'runtime'
        try:
            require(time.monotonic() < self.deadline - CLEANUP_SECONDS, 'ABSOLUTE_DEADLINE')
            identity, free = directory_facts(self.root, 'RUNTIME_ROOT_CHANGED')
            require(identity == self.root_identity, 'RUNTIME_ROOT_CHANGED')
            role = 'receipt'
            receipt_identity, receipt_free = directory_facts(self.receipt.parent, 'RECEIPT_ROOT_CHANGED')
            require(receipt_identity == self.receipt_identity, 'RECEIPT_ROOT_CHANGED')
            minimum = min(free, receipt_free)
            if self.device:
                role = 'device'
                try: require(str(uuid.UUID(self.device)).upper() == self.device.upper(), 'OWNED_DEVICE_UUID_PATH')
                except ValueError: raise Refusal('OWNED_DEVICE_UUID_PATH') from None
                device = Path.home() / 'Library/Developer/CoreSimulator/Devices' / self.device
                device_identity, device_free = directory_facts(device, 'OWNED_DEVICE_DIRECTORY_REQUIRED')
                require(device_identity[0] == identity[0], 'OWNED_DEVICE_VOLUME_MISMATCH')
                if self.device_identity is not None:
                    require(device_identity == self.device_identity, 'OWNED_DEVICE_IDENTITY_CHANGED')
                else:
                    self.device_identity = device_identity
                minimum = min(minimum, device_free)
            diagnostic = self.result['resourceDiagnostic']
            previous = diagnostic['minFreeBytes']
            diagnostic['minFreeBytes'] = minimum if previous is None else min(previous, minimum)
            require(minimum >= guard.REMAINING_FREE, 'REMAINING_6_GIB_REQUIRED')
        except Exception as error:
            self.resource_refusal(error, role)
            raise

    def record_census(self, roles, complete, started):
        diagnostic = self.result['resourceDiagnostic']
        elapsed = round(max(0.0, time.monotonic() - started) * 1000, 3)
        diagnostic['fullScanCount'] += 1
        diagnostic['totalScanMs'] = round(diagnostic['totalScanMs'] + elapsed, 3)
        diagnostic['maxScanMs'] = max(diagnostic['maxScanMs'], elapsed)
        combined = sum(value['allocatedBytes'] for value in roles.values() if value is not None)
        safe_roles = {}
        for role, value in roles.items():
            if value is None:
                safe_roles[role] = None
                continue
            safe_roles[role] = {key: value[key] for key in RESOURCE_FIELDS}
            safe_roles[role]['complete'] = value['complete']
            peak = diagnostic['peak']['roles'].setdefault(role, {**{key: 0 for key in RESOURCE_FIELDS}, 'complete': True})
            for key in RESOURCE_FIELDS: peak[key] = max(peak[key], value[key])
            peak['complete'] = peak['complete'] and value['complete']
        if combined > diagnostic['peak']['combinedAllocatedBytes']:
            diagnostic['peak']['combinedAllocatedBytes'] = combined
            diagnostic['peak']['combinedIsLowerBound'] = not complete
        diagnostic['last'] = {**self.resource_context(), 'snapshotKind': 'last-census-not-current',
                              'complete': complete, 'roles': safe_roles, 'combinedAllocatedBytes': combined,
                              'combinedIsLowerBound': not complete}

    def full_census(self):
        started = time.monotonic()
        roles = {'runtime': None, 'receipt': None, 'device': None}
        role = 'runtime'
        complete = False
        budget = guard.CensusBudget(self.cheap_monitor)
        try:
            roles['runtime'] = guard.measure(self.root, census=budget)
            role = 'receipt'
            roles['receipt'] = guard.measure(self.receipt.parent, census=budget)
            if self.device:
                role = 'device'
                device = Path.home() / 'Library/Developer/CoreSimulator/Devices' / self.device
                roles['device'], self.device_identity = measure_owned_device(device, self.root, self.device_identity, census=budget)
            self.cheap_monitor()
            complete = True
        except Exception as error:
            partial = getattr(error, 'census_partial', None)
            if isinstance(partial, dict): roles[role] = partial
            if self.result['resourceDiagnostic']['refusal'] is None:
                self.resource_refusal(error, role)
            raise
        finally:
            self.record_census(roles, complete, started)
            if complete: self.last_census_completed = time.monotonic()
        for role, value in roles.items():
            if value is not None and value['files'] + value['symlinkCount'] > guard.MAX_FILES:
                error = guard.Refusal('RUNTIME_FILE_COUNT_LIMIT'); self.resource_refusal(error, role); raise error
        if roles['runtime']['allocatedBytes'] > guard.MAX_ALLOCATED - 4096:
            error = guard.Refusal('RUNTIME_1P5_GIB_CAP'); self.resource_refusal(error, 'runtime'); raise error
        if roles['runtime']['diagnosticLogicalBytes'] > guard.MAX_DIAGNOSTIC - 4096:
            error = guard.Refusal('DIAGNOSTIC_250_MIB_CAP'); self.resource_refusal(error, 'runtime'); raise error
        if roles['runtime']['diagnosticLogicalBytes'] + roles['receipt']['logicalBytes'] > guard.MAX_DIAGNOSTIC - 4096:
            error = Refusal('COMBINED_DIAGNOSTIC_CAP'); self.resource_refusal(error, 'receipt'); raise error
        if sum(value['allocatedBytes'] for value in roles.values() if value is not None) > guard.MAX_ALLOCATED - 4096:
            error = Refusal('OWNED_DEVICE_AND_RUNTIME_CAP'); self.resource_refusal(error, 'device' if roles['device'] else 'runtime'); raise error

    def monitor(self, *, force=False):
        self.cheap_monitor()
        if force or self.last_census_completed is None or time.monotonic() - self.last_census_completed >= CENSUS_INTERVAL_SECONDS:
            self.full_census()

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
            self.result['networkCanary'] = {'exitCode': None, 'errno': None, 'stderrPresent': False,
                                            'stderrClass': 'not-started', 'operator': None, 'parserLine': None}
        with log.open('xb') as output:
            stderr_file = stderr_path.open('xb') if canary else None
            try:
                process = subprocess.Popen(args, stdout=output, stderr=stderr_file if canary else subprocess.STDOUT,
                                           env=env or self.env, start_new_session=True)
                end = min(self.deadline - CLEANUP_SECONDS, time.monotonic() + seconds)
                boot_diagnostic = BootStatusDiagnostic(time.monotonic()) if label == 'bootstatus' else None
                def poll():
                    if boot_diagnostic is not None: boot_diagnostic.poll_count += 1
                    return process.poll()
                try:
                    while poll() is None and time.monotonic() < end:
                        if monitor:
                            if boot_diagnostic is None:
                                self.monitor()
                            else:
                                monitor_start = time.monotonic()
                                try: self.monitor()
                                finally:
                                    monitor_end = time.monotonic()
                                    boot_diagnostic.monitor_finished(monitor_start, monitor_end)
                                    boot_diagnostic.observe_log(output.fileno(), monitor_end)
                        time.sleep(.5)
                    completed = poll()
                    require(completed is not None and time.monotonic() < end, 'COMMAND_TIMEOUT_' + label.upper())
                    require(process.returncode == 0, 'COMMAND_FAILED_' + label.upper())
                finally:
                    if boot_diagnostic is not None:
                        boot_end = time.monotonic()
                        boot_diagnostic.observe_log(output.fileno(), boot_end)
                        self.result['bootstatusDiagnostic'] = boot_diagnostic.finish(boot_end, end, process.returncode)
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
        self.admit_network()
        self.monitor()
        self.set_phase('device-creation')
        self.create_attempted = True
        created = self.command('create-device', ['/usr/bin/xcrun', 'simctl', 'create', self.device_name, DEVICE, RUNTIME], 30)
        candidate = created.strip()
        require(str(uuid.UUID(candidate)).lower() == candidate.lower() and candidate not in self.before, 'NEW_DEVICE_UUID_REQUIRED')
        self.device = candidate.upper()
        self.result['deviceCreated'] = True
        # Refuse rather than quietly exclude owned simulator allocations.
        self.monitor(force=True)
        fresh = self.inventory()
        require(self.device in fresh and fresh[self.device][0] == RUNTIME and fresh[self.device][1].get('deviceTypeIdentifier') == DEVICE and fresh[self.device][1].get('name') == self.device_name, 'NEW_DEVICE_IDENTITY')
        self.set_phase('native-build')
        self.command('build', ['/usr/bin/xcodebuild', 'build-for-testing', '-project', str(PROJECT), '-scheme', 'NativeQA',
                              '-destination', 'platform=iOS Simulator,id=' + self.device, '-derivedDataPath', str(self.root / 'Derived'),
                              '-parallel-testing-enabled', 'NO', '-jobs', '1', 'CODE_SIGNING_ALLOWED=NO'], 300)
        self.monitor(force=True)
        runs = list((self.root / 'Derived/Build/Products').glob('*.xctestrun'))
        require(len(runs) == 1 and runs[0].is_file() and not runs[0].is_symlink(), 'ONE_XCTESTRUN_REQUIRED')
        self.xctestrun = runs[0]
        self.set_phase('device-boot')
        self.command('boot', ['/usr/bin/xcrun', 'simctl', 'boot', self.device], 30)
        self.command('bootstatus', ['/usr/bin/xcrun', 'simctl', 'bootstatus', self.device, '-b'], 120)
        self.monitor(force=True)

    def admit_network(self):
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
        self.network_profile_sha = sha(sandbox)
        self.network_admitted = True
        self.result['networkAdmitted'] = True

    def start_fixture(self):
        self.set_phase('fixture-admission')
        sandbox = self.root / 'configs/fixture.sb'
        require(self.network_admitted is True and sandbox.is_file() and not sandbox.is_symlink() and
                self.network_profile_sha is not None and sha(sandbox) == self.network_profile_sha, 'NETWORK_ADMISSION_REQUIRED')
        env = dict(self.env, HOME=str(self.root), IPAD_QA_CONTROL_TOKEN=self.token)
        self.fixture_log = (self.root / 'fixture.log').open('xb')
        self.start_command('fixture')
        self.fixture = subprocess.Popen(['/usr/bin/sandbox-exec', '-f', str(sandbox), str(self.node),
            '--import', str(REPO / 'server/node_modules/tsx/dist/loader.mjs'), str(REPO / 'scripts/android_external_player_server_fixture.mts'),
            '--repo', str(REPO), '--output', str(self.root / 'fixture'), '--foreground-long', '--ipad-foreground'],
            env=env, stdout=self.fixture_log, stderr=subprocess.STDOUT, start_new_session=True)
        end = min(self.deadline - CLEANUP_SECONDS, time.monotonic() + 360)
        status = self.root / 'fixture/foreground-fixture-status.json'
        while time.monotonic() < end:
            self.monitor()
            value = fixture_diagnostic(status)
            self.result['fixtureDiagnostic'] = value
            exit_code = self.fixture.poll()
            if type(exit_code) is int and -255 <= exit_code <= 255:
                self.result['fixtureExitCode'] = exit_code
            require(exit_code is None, 'FIXTURE_EXITED')
            if isinstance(value, dict):
                if value.get('status') == 'refused': raise Refusal('FIXTURE_REFUSED')
                if value.get('status') == 'ready':
                    self.monitor(force=True)
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
                if process.returncode != 0:
                    try:
                        log.flush()
                        if logpath.stat().st_size <= 8 * 1024 * 1024:
                            refusal = native_refusal_code(logpath.read_text(errors='replace'))
                            if refusal is not None: self.result['nativeRefusalCode'] = refusal
                    except (OSError, UnicodeError):
                        pass
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
        self.monitor(force=True)
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
            self.monitor(force=True)
            require(not output.exists() and self.root.stat().st_dev == self.receipt.parent.stat().st_dev, 'ATOMIC_ANCHOR_PUBLISH_REQUIRED')
            staging.rename(output)
            self.monitor()
        self.result['status'] = 'admission-only' if seconds == 15 else 'observation-only'
        self.result['manualPixelReviewPending'] = True
        self.result['fullQualification'] = False

    def cleanup(self):
        errors = []
        self.result['cleanupFailureStage'] = None
        self.result['cleanupDeviceState'] = None
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
            cleanup_stage = 'inventory'
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
                    state = candidates[0].get('state')
                    self.result['cleanupDeviceState'] = state if state in ('Booted', 'Shutdown', 'Creating', 'Booting', 'ShuttingDown') else 'other'
                    if state == 'Booted':
                        cleanup_stage = 'shutdown'
                        subprocess.run(['/usr/bin/xcrun', 'simctl', 'shutdown', self.device], env=self.env, capture_output=True, timeout=15, check=True)
                    cleanup_stage = 'delete'
                    subprocess.run(['/usr/bin/xcrun', 'simctl', 'delete', self.device], env=self.env, capture_output=True, timeout=15, check=True)
                    cleanup_stage = 'verify'
                    after_raw = subprocess.run(['/usr/bin/xcrun', 'simctl', 'list', 'devices', '--json'], env=self.env,
                                               capture_output=True, timeout=10, check=True)
                    after = {x['udid'] for rows in json.loads(after_raw.stdout)['devices'].values() for x in rows}
                    require(self.device not in after and set(self.before).issubset(after), 'POST_CLEANUP_DEVICE_CENSUS')
                    self.result['deviceDeleted'] = True
                self.result['cleanupObservation'] = 'observed'
            except Refusal:
                self.result['cleanupFailureStage'] = cleanup_stage
                self.result['cleanupObservation'] = 'unsafe'
                errors.append('OWNED_DEVICE_CLEANUP')
            except Exception:
                self.result['cleanupFailureStage'] = cleanup_stage
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
