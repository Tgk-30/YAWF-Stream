#!/usr/bin/env python3
"""One selected ordinary-APK startup fault/retry on an already-owned hosted guest.

No emulator/ADB server lifecycle, app setup, credentials, global logcat, screenshots
or recovery retries. CLI has no fake/bypass mode. Root owns the outer timeout and
VM/server trap, including terminating device instrumentation after a host timeout.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import stat
import struct
import subprocess
import sys
import time
import zipfile
import zlib
from xml.etree import ElementTree

TARGET = "com.tgk30.debridstreamer"
TEST_PACKAGE = "com.yawf.ownedstartupinstrumentation.test"
RUNNER = "com.yawf.ownedstartup.OwnedDestroyInstrumentationRunner"
TEST_CLASS = "com.yawf.ownedstartup.OwnedDestroyRetryTest"
METHOD = "acceptedPluginLoadFailureIsDestroyedThenOneNativeRetrySucceeds"
SCOPE = "SELECTED_ORDINARY_APK_STARTUP_FAULT_RETRY_ONLY"
PORT, SERIAL = 5142, "emulator-5568"
RESERVE, CAP = 6 * 1024**3, 3 * 1024**3
SHA = re.compile(r"[0-9a-f]{64}\Z")
BOOL_FIELDS = (
    "targetPackageMatched", "targetPidMatched", "firstPluginVerified", "faultInjectedOnce",
    "oldDetachedBeforeTap", "wryClearedBeforeTap", "helperAcceptedClearedBeforeTap",
    "noDecorWebViewBeforeTap", "uniqueShownEnabledRetryBeforeTap", "oldWebViewDetached",
    "newWebViewDistinctAttached", "sameActivityAfterRetry", "wryOwnsNewWebView",
    "activityReferencesNewWebView", "soleDecorWebViewAfterRetry", "retryUiGoneAfterRetry",
    "retryUiGone", "pluginHandleLoaded",
)
PHASES = {"NOT_STARTED", "PREFLIGHT", "LAUNCH_ONCE", "PRE_RETRY_ASSERTIONS",
          "ONE_VERIFIED_NATIVE_TAP", "WAITING_FOR_SAME_ACTIVITY_RETRY", "FINAL_ASSERTIONS",
          "QUALIFIED_SELECTED_STARTUP_RETRY_ONLY"}
FAILURE_CODES = {""} | {phase + "_FAILED" for phase in PHASES}
EVIDENCE_KEYS = set(BOOL_FIELDS) | {
    "schemaVersion", "scope", "phase", "qualification", "failureCode", "elapsedMs",
    "tapCount", "targetActivityCreates", "pluginLoadCount",
}


class Refusal(Exception):
    def __init__(self, code, module_evidence=None):
        super().__init__(code)
        self.module_evidence = module_evidence


def require(condition, code):
    if not condition:
        raise Refusal(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def install_succeeded(output):
    # ADB's non-streaming installer prints its mode before package-manager
    # success. Never accept a success substring or an unrecognized extra line.
    return output.strip().splitlines() in (["Success"], ["Performing Push Install", "Success"])


def test_instrumentation_matches(xml):
    if "<!DOCTYPE" in xml or "<!ENTITY" in xml:
        return False
    try:
        root = ElementTree.fromstring(xml)
    except ElementTree.ParseError:
        return False
    android = "{http://schemas.android.com/apk/res/android}"
    rows = root.findall("instrumentation")
    return root.tag == "manifest" and root.get("package") == TEST_PACKAGE and len(rows) == 1 and \
        rows[0].get(android + "name") == RUNNER and rows[0].get(android + "targetPackage") == TARGET


def strict_json(text):
    def pairs(rows):
        result = {}
        for key, value in rows:
            require(key not in result, "DUPLICATE_JSON_KEY")
            result[key] = value
        return result
    try:
        return json.loads(text, object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(Refusal("JSON_CONSTANT")))
    except (ValueError, TypeError) as error:
        raise Refusal("MALFORMED_JSON") from error


def evidence(output):
    """Parse the module's actual Bundle key, not a fabricated OWNED_STARTUP prefix."""
    key = "INSTRUMENTATION_STATUS: owned_destroy_evidence="
    lines = [line[len(key):] for line in output.splitlines() if line.startswith(key)]
    require(len(lines) == 1 and output.count("owned_destroy_evidence") == 1, "EVIDENCE_COUNT")
    value = strict_json(lines[0])
    require(type(value) is dict and set(value) == EVIDENCE_KEYS, "EVIDENCE_SCHEMA")
    require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1, "EVIDENCE_VERSION")
    require(value["scope"] == "selected_first_plugin_load_failure_then_one_native_retry", "EVIDENCE_SCOPE")
    require(type(value["qualification"]) is bool, "EVIDENCE_TYPE")
    require(all(type(value[name]) is bool for name in BOOL_FIELDS), "EVIDENCE_TYPE")
    for name in ("elapsedMs", "tapCount", "targetActivityCreates", "pluginLoadCount"):
        require(type(value[name]) is int and 0 <= value[name] <= 180000, "EVIDENCE_TYPE")
    require(type(value["phase"]) is str and type(value["failureCode"]) is str, "EVIDENCE_TYPE")
    safe = dict(value)
    safe["phase"] = value["phase"] if value["phase"] in PHASES else "UNRECOGNIZED_MODULE_PHASE"
    safe["failureCode"] = value["failureCode"] if value["failureCode"] in FAILURE_CODES else "UNRECOGNIZED_MODULE_FAILURE"
    # Preserve only this validated, fixed-schema observation on a negative run.
    # It is not qualification and never contains raw instrumentation output.
    def qualify(condition, code):
        if not condition:
            raise Refusal(code, safe)
    qualify(value["phase"] == "QUALIFIED_SELECTED_STARTUP_RETRY_ONLY" and
            value["qualification"] is True and value["failureCode"] == "", "MODULE_UNQUALIFIED")
    qualify(0 < value["elapsedMs"] <= 150000 and value["tapCount"] == 1 and
            value["targetActivityCreates"] == 1 and value["pluginLoadCount"] == 2 and
            all(value[name] for name in BOOL_FIELDS), "MODULE_FACTS")
    qualify(len(re.findall(r"(?m)^OK \(1 test\)\s*$", output)) == 1, "JUNIT_ONE_TEST")
    qualify(re.findall(r"(?m)^INSTRUMENTATION_CODE: (-?\d+)\s*$", output) == ["-1"], "INSTRUMENTATION_COMPLETION")
    qualify(not any(mark in output for mark in ("FAILURES!!!", "INSTRUMENTATION_FAILED", "INSTRUMENTATION_ABORTED", "Process crashed.")), "INSTRUMENTATION_FAILED")
    for name, expected in (("class", TEST_CLASS), ("test", METHOD), ("numtests", "1")):
        seen = re.findall(r"(?m)^INSTRUMENTATION_STATUS: " + name + r"=(.*)$", output)
        qualify(bool(seen) and all(item == expected for item in seen), "JUNIT_IDENTITY")
    return value


def instrumentation_signals(stdout, stderr):
    """Fixed diagnostic facts only, never messages, stack frames or qualification.

    Scan the bounded one-shot instrumentation output even if its evidence Bundle
    is missing. Untrusted text can set a fact but cannot supply a receipt value.
    """
    text = stdout.decode("utf-8", errors="replace") + "\n" + stderr.decode("utf-8", errors="replace")
    exceptions = ("NoClassDefFoundError", "ClassNotFoundException", "UnsatisfiedLinkError",
                  "VerifyError", "SecurityException", "IllegalStateException", "RuntimeException")
    facts = {name: re.search(r"(?<![A-Za-z0-9_$])" + name + r"(?![A-Za-z0-9_$])", text) is not None
             for name in exceptions}
    facts.update(
        instrumentationRunFailed=any(mark in text for mark in
                                     ("INSTRUMENTATION_FAILED", "INSTRUMENTATION_ABORTED", "Instrumentation run failed")),
        processCrashed=any(mark in text for mark in ("Process crashed.", "Process crashed", "process crashed")),
        junitStarted=re.search(r"(?m)^INSTRUMENTATION_STATUS: class=" + re.escape(TEST_CLASS) + r"\r?$", text) is not None and
                     re.search(r"(?m)^INSTRUMENTATION_STATUS_CODE: 1\r?$", text) is not None,
        ownedTestClassMentioned=re.search(r"(?<![A-Za-z0-9_.$])" + re.escape(TEST_CLASS) + r"(?![A-Za-z0-9_$])", text) is not None,
        ownedRunnerClassMentioned=re.search(r"(?<![A-Za-z0-9_.$])" + re.escape(RUNNER) + r"(?![A-Za-z0-9_$])", text) is not None,
    )
    missing = {key: False for key in ("missingAndroidxTest", "missingAndroidxAppcompat", "missingAndroidxCore",
               "missingTauri", "missingKotlin", "missingOwnedTest", "missingOwnedTarget", "missingOther")}
    # Only known JVM missing-class line formats admit a private temporary name.
    # Names/messages never become receipt keys or values, including their hashes.
    segment = r"[A-Za-z_$][A-Za-z0-9_$]{0,63}"
    dotted = segment + r"(?:\." + segment + r"){0,31}"
    internal = segment + r"(?:/" + segment + r"){0,31}"
    envelope = r"(?:(?:INSTRUMENTATION_(?:STATUS|RESULT): (?:stream|shortMsg|longMsg|stack)=))?(?:Caused by: )?"
    exception = r"(?:java\.lang\.)?(?:NoClassDefFoundError|ClassNotFoundException): "
    patterns = (
        envelope + r"(?:" + exception + r")?Failed resolution of: L(" + internal + r");[ \t]*",
        envelope + r"(?:" + exception + r")?Didn't find class \"(" + dotted + r")\"(?: on path: [^\r\n]*)?",
        envelope + r"(?:java\.lang\.)?ClassNotFoundException: \"?(" + dotted + r")\"?[ \t]*",
    )
    for line in text.splitlines():
        if len(line) > 8192:
            continue
        for pattern in patterns:
            match = re.fullmatch(pattern, line.strip())
            if match is None or len(match[1]) > 512:
                continue
            name = match[1].replace("/", ".")
            bucket = next((key for prefixes, key in (
                (("androidx.test.",), "missingAndroidxTest"),
                (("androidx.appcompat.",), "missingAndroidxAppcompat"),
                (("androidx.core.",), "missingAndroidxCore"),
                (("app.tauri.",), "missingTauri"),
                (("kotlin.", "kotlinx."), "missingKotlin"),
                (("com.yawf.ownedstartup.", "com.yawf.ownedstartupinstrumentation."), "missingOwnedTest"),
                ((TARGET + ".",), "missingOwnedTarget"),
            ) if name.startswith(prefixes)), "missingOther")
            missing[bucket] = True
            break
    facts.update(missing)
    public_types = {
        "androidJUnitRunnerMentioned": "androidx.test.runner.AndroidJUnitRunner",
        "instrumentationRegistryMentioned": "androidx.test.platform.app.InstrumentationRegistry",
        "androidJUnit4ClassRunnerMentioned": "androidx.test.internal.runner.junit4.AndroidJUnit4ClassRunner",
        "appCompatActivityMentioned": "androidx.appcompat.app.AppCompatActivity",
        "coreComponentFactoryMentioned": "androidx.core.app.CoreComponentFactory",
        "pluginMentioned": "app.tauri.plugin.Plugin",
        "pluginManagerMentioned": "app.tauri.plugin.PluginManager",
        "pluginHandleMentioned": "app.tauri.plugin.PluginHandle",
    }
    for key, name in public_types.items():
        slash = re.escape(name.replace(".", "/"))
        facts[key] = re.search(r"(?<![A-Za-z0-9_.$/])(?:" + re.escape(name) + r"|L" + slash + r";|" + slash + r")(?![A-Za-z0-9_$/])", text) is not None
    return facts


def dex_class_counts(data):
    """Bounded standard DEX035..040 header/index/class-definition visitor.

    Strings or type references are not definitions. This is not a bytecode verifier.
    No descriptor or other APK string is returned or logged.
    """
    require(112 <= len(data) <= 128 * 1024**2 and
            re.fullmatch(b"dex\\n0(?:3[5-9]|40)\\x00", data[:8]) is not None, "DEX_HEADER")
    u32 = lambda off: struct.unpack_from("<I", data, off)[0]
    require(u32(32) == len(data) and u32(36) == 112 and u32(40) == 0x12345678, "DEX_HEADER")
    require(hashlib.sha1(data[32:]).digest() == data[12:32] and
            zlib.adler32(data[12:]) & 0xffffffff == u32(8), "DEX_INTEGRITY")
    def table(count_off, width, cap):
        count, offset = u32(count_off), u32(count_off + 4)
        require(count <= cap and ((count == 0 and offset == 0) or
                (count > 0 and offset >= 112 and offset % 4 == 0 and offset + count * width <= len(data))), "DEX_TABLE")
        return count, offset
    strings, string_off = table(56, 4, 1000000)
    types, type_off = table(64, 4, 1000000)
    classes, class_off = table(96, 32, 200000)
    def descriptor(index):
        require(index < types, "DEX_TYPE_INDEX")
        string = u32(type_off + index * 4)
        require(string < strings, "DEX_STRING_INDEX")
        offset = u32(string_off + string * 4)
        require(112 <= offset < len(data), "DEX_STRING_OFFSET")
        length, shift = 0, 0
        for _ in range(5):
            require(offset < len(data), "DEX_ULEB")
            byte = data[offset]; offset += 1
            length |= (byte & 127) << shift
            if byte < 128:
                break
            shift += 7
        else:
            raise Refusal("DEX_ULEB")
        end = data.find(b"\0", offset, min(len(data), offset + 65536))
        require(end >= offset, "DEX_STRING_END")
        raw = data[offset:end]
        # Decode MUTF-8 code-unit lengths without mistaking references for classes.
        units, pos = 0, 0
        while pos < len(raw):
            first = raw[pos]
            size = 1 if first < 128 else 2 if 0xc0 <= first <= 0xdf else 3 if 0xe0 <= first <= 0xef else 0
            require(size and pos + size <= len(raw) and all(0x80 <= b <= 0xbf for b in raw[pos + 1:pos + size]), "DEX_MUTF8")
            units += 1; pos += size
        require(units == length and raw.startswith(b"L") and raw.endswith(b";"), "DEX_DESCRIPTOR")
        return raw
    forbidden, seen = 0, set()
    for index in range(classes):
        off = class_off + index * 32
        class_index = u32(off)
        require(class_index not in seen, "DEX_DUPLICATE_CLASS")
        seen.add(class_index)
        superclass = u32(off + 8)
        require(superclass == 0xffffffff or superclass < types, "DEX_SUPERCLASS")
        for field in (12, 20, 24, 28):
            value = u32(off + field)
            require(value == 0 or 112 <= value < len(data), "DEX_CLASS_OFFSET")
        forbidden += descriptor(class_index).startswith(b"Lapp/tauri/")
    return classes, forbidden


def no_tauri_definitions(apk):
    total, count, entries = 0, 0, 0
    with zipfile.ZipFile(apk) as archive:
        names = archive.namelist()
        require(len(names) <= 20000 and len(set(names)) == len(names), "APK_ZIP_ENTRIES")
        for info in archive.infolist():
            if not info.filename.lower().endswith(".dex"):
                continue
            require(re.fullmatch(r"classes(?:[2-9]|[1-9][0-9]+)?\.dex", info.filename) is not None, "APK_DEX_NAME")
            require(not info.flag_bits & 1 and info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "APK_DEX_COMPRESSION")
            total += info.file_size
            require(total <= 256 * 1024**2 and info.file_size <= 128 * 1024**2, "APK_DEX_BYTES")
            classes, forbidden = dex_class_counts(archive.read(info))
            require(forbidden == 0, "BUNDLED_TAURI_CLASS_DEFINITION")
            count += classes; entries += 1
    require(entries > 0, "APK_DEX_MISSING")
    return {"dexFiles": entries, "classDefinitions": count, "tauriClassDefinitions": 0}


def process_identity(pid):
    root = Path("/proc") / str(pid)
    raw = (root / "stat").read_text()
    rest = raw.rsplit(")", 1)[1].split()
    return int(rest[19]), (root / "cmdline").read_bytes().rstrip(b"\0").split(b"\0")


def allocated(root):
    total, seen = 0, set()
    for directory, dirs, files in os.walk(root, followlinks=False, onerror=lambda _: (_ for _ in ()).throw(Refusal("JOB_CENSUS_ERROR"))):
        for path in [Path(directory), *(Path(directory) / name for name in dirs + files)]:
            try:
                item = path.lstat()
            except FileNotFoundError:
                continue
            key = item.st_dev, item.st_ino
            if key not in seen:
                seen.add(key); total += item.st_blocks * 512
                require(len(seen) <= 100000, "JOB_FILE_COUNT")
    return total


class System:
    platform = sys.platform
    environ = os.environ
    clock = staticmethod(time.monotonic)
    process = staticmethod(process_identity)
    free = staticmethod(lambda root: shutil.disk_usage(root).free)
    allocation = staticmethod(allocated)

    def port_owned(self, pid, port):
        sockets = set()
        for path in (Path("/proc") / str(pid) / "fd").iterdir():
            try:
                sockets.add(os.readlink(path))
            except FileNotFoundError:
                pass  # Only an individual disappeared temporary FD is tolerated.
        for table in ("tcp", "tcp6"):
            for line in (Path("/proc/net") / table).read_text().splitlines()[1:]:
                fields = line.split(); address, number = fields[1].split(":")
                if int(number, 16) == port and fields[3] == "0A":
                    require(address in ("0100007F", "00000000000000000000000001000000"), "ADB_NOT_LOOPBACK")
                    if "socket:[" + fields[9] + "]" in sockets:
                        return True
        return False

    def run(self, argv, seconds, limit, guard, env):
        """Hard timeout/output fence. Kill only the live client session we spawned."""
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, env=env, start_new_session=True)
        birth = self.process(child.pid)[0]
        started = self.clock(); result = [bytearray(), bytearray()]
        selector = selectors.DefaultSelector()
        for index, stream in enumerate((child.stdout, child.stderr)):
            os.set_blocking(stream.fileno(), False); selector.register(stream, selectors.EVENT_READ, index)
        try:
            while selector.get_map() or child.poll() is None:
                guard()
                require(self.clock() - started < seconds, "HARD_SUBPROCESS_TIMEOUT")
                for key, _ in selector.select(0.2):
                    block = os.read(key.fd, 8192)
                    if not block:
                        selector.unregister(key.fileobj)
                    else:
                        result[key.data].extend(block)
                        require(sum(map(len, result)) <= limit, "TOOL_OUTPUT_CAP")
            return child.wait(timeout=1), bytes(result[0]), bytes(result[1])
        finally:
            selector.close()
            if child.poll() is None:
                # PID cannot be recycled while this Popen child remains unreaped;
                # still bind its birth and own process group before each signal.
                for sig in (signal.SIGTERM, signal.SIGKILL):
                    require(self.process(child.pid)[0] == birth and os.getpgid(child.pid) == child.pid, "CHILD_CLEANUP_IDENTITY")
                    os.killpg(child.pid, sig)
                    try:
                        child.wait(timeout=2); break
                    except subprocess.TimeoutExpired:
                        pass
            child.stdout.close(); child.stderr.close()


class Controller:
    def __init__(self, args, system=None):
        self.a, self.sys = args, system or System()
        self.started = self.sys.clock(); self.commands = []; self.admission = None
        self.next_inventory = 0; self.directory = None; self.evidence_owned = False; self.fingerprints = {}
        self.instrumentation_signals = None

    def under(self, value, parent, exists=True):
        path = Path(value)
        require(path.is_absolute() and path.resolve(strict=exists) == path, "NONCANONICAL_PATH")
        require(path != parent and path.is_relative_to(parent), "PATH_OUTSIDE_OWNER")
        return path

    def regular(self, path, maximum):
        item = path.lstat()
        require(stat.S_ISREG(item.st_mode) and not path.is_symlink() and
                0 < item.st_size <= maximum and item.st_uid == os.getuid(), "UNSAFE_INPUT_FILE")
        return item

    def check(self, inventory=True):
        require(self.sys.clock() - self.started < self.a.timeout, "CONTROLLER_DEADLINE")
        require(self.sys.free(self.temp) >= RESERVE and self.sys.allocation(self.job) <= CAP, "STORAGE_BOUND")
        for path, fingerprint in self.fingerprints.items():
            item = self.regular(path, 512 * 1024**2)
            require((item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns) == fingerprint, "INPUT_CHANGED")
        for name in ("emulator", "adbServer"):
            expected = self.admission[name]
            birth, command = self.sys.process(expected["pid"])
            require(birth == expected["startTicks"] and command == [arg.encode() for arg in expected["cmdline"]], "OWNED_PROCESS_CHANGED")
        require(self.sys.port_owned(self.admission["adbServer"]["pid"], PORT), "ADB_SERVER_SOCKET_OWNER")
        if inventory and self.sys.clock() >= self.next_inventory:
            self.next_inventory = self.sys.clock() + 1
            code, out, _ = self.command(self.adb + ["devices", "-l"], 3, inventory=False)
            rows = [line.split() for line in out.decode("ascii").splitlines() if line.strip() and not line.startswith("List of devices attached")]
            require(code == 0 and len(rows) == 1 and rows[0][:2] == [SERIAL, "device"], "DEVICE_INVENTORY")

    def command(self, argv, seconds=30, inventory=True):
        self.check(inventory)
        remaining = self.a.timeout - (self.sys.clock() - self.started)
        require(remaining > 0, "CONTROLLER_DEADLINE")
        result = self.sys.run(argv, min(seconds, remaining), 131072,
                              lambda: self.check(inventory), self.env)
        require(len(self.commands) < 256, "COMMAND_RECORD_CAP")
        self.commands.append({"tool": Path(argv[0]).name, "exit": result[0],
                              "stdoutBytes": len(result[1]), "stderrBytes": len(result[2]),
                              "stdoutSha256": digest(result[1]), "stderrSha256": digest(result[2])})
        return result

    def text(self, argv, seconds=30):
        code, out, _ = self.command(argv, seconds)
        require(code == 0, "TOOL_REFUSAL")
        return out.decode("utf-8", errors="strict")

    def apk(self, path, expected, target):
        item = self.regular(path, 512 * 1024**2)
        self.fingerprints[path] = (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
        # Hash incrementally, not an APK-sized in-memory allocation.
        hasher = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024**2), b""):
                hasher.update(chunk)
                self.check()
        require(type(expected) is dict and set(expected) == {"sha256", "bytes"} and type(expected["bytes"]) is int and SHA.fullmatch(expected["sha256"]) and
                hasher.hexdigest() == expected["sha256"] and path.stat().st_size == expected["bytes"], "APK_BINDING")
        badging = self.text([str(self.aapt), "dump", "badging", str(path)])
        packages = re.findall(r"(?m)^package: name='([^']+)' versionCode='([^']*)' versionName='([^']*)'", badging)
        require(len(packages) == 1, "APK_PACKAGE_METADATA")
        if target:
            require(packages[0] == (TARGET, str(self.a.expected_code), self.a.expected_version) and
                    "application-debuggable" not in badging and "application-testOnly" not in badging and "instrumentation:" not in badging, "TARGET_APK_METADATA")
        else:
            require(packages[0][0] == TEST_PACKAGE, "TEST_APK_PACKAGE")
            # aapt badging omits instrumentation declarations. Inspect the
            # actual binary manifest as XML before either APK is installed.
            manifest = self.text([str(self.analyzer), "manifest", "print", str(path)])
            require(test_instrumentation_matches(manifest), "TEST_INSTRUMENTATION")
        certificates = self.text([str(self.signer), "verify", "--print-certs", str(path)])
        found = re.findall(r"(?m)^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]{64})\s*$", certificates)
        require(len(found) == 1 and found[0].lower() == self.a.expected_cert, "APK_CERTIFICATE")
        return {"sha256": hasher.hexdigest(), "bytes": path.stat().st_size}

    def run(self):
        require(self.sys.platform == "linux" and self.sys.environ.get("GITHUB_ACTIONS") == "true", "HOST_NOT_ADMITTED")
        require(self.a.adb_port == PORT and self.a.serial == SERIAL and 0 < self.a.timeout <= 180, "CLI_IDENTITY")
        require(self.a.expected_version == "2.3.112" and self.a.expected_code == 2003112 and
                SHA.fullmatch(self.a.expected_cert), "EXPECTED_TARGET")
        self.temp = Path(self.sys.environ.get("RUNNER_TEMP", ""))
        require(self.temp.is_absolute() and self.temp.resolve(strict=True) == self.temp, "RUNNER_TEMP_REQUIRED")
        admission = self.under(self.a.owned_admission, self.temp); self.regular(admission, 32768)
        self.admission = strict_json(admission.read_text())
        expected_keys = {"schemaVersion", "scope", "freshUserdata", "jobRoot", "avdName", "avdPath", "serial", "adbPort", "emulator", "adbServer", "targetApk", "testApk", "sourceRevision"}
        require(type(self.admission) is dict and set(self.admission) == expected_keys and type(self.admission["schemaVersion"]) is int and self.admission["schemaVersion"] == 1 and
                self.admission["scope"] == "ROOT_OWNED_FRESH_HOSTED_API36" and self.admission["freshUserdata"] is True and
                self.admission["serial"] == SERIAL and self.admission["adbPort"] == PORT and
                re.fullmatch(r"[0-9a-f]{40}", self.admission["sourceRevision"]), "OWNED_ADMISSION")
        self.job = self.under(self.admission["jobRoot"], self.temp)
        require(self.job.is_dir() and admission.is_relative_to(self.job), "OWNED_JOB_ROOT")
        self.avd = self.under(self.admission["avdPath"], self.job)
        require(self.avd.is_dir() and re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", self.admission["avdName"]), "AVD_BINDING")
        for name in ("emulator", "adbServer"):
            item = self.admission[name]
            require(type(item) is dict and set(item) == {"pid", "startTicks", "cmdline"} and
                    type(item["pid"]) is int and item["pid"] > 1 and type(item["startTicks"]) is int and item["startTicks"] > 0 and
                    type(item["cmdline"]) is list and 1 <= len(item["cmdline"]) <= 128 and
                    all(type(arg) is str and 0 < len(arg) <= 4096 and "\0" not in arg for arg in item["cmdline"]), "PROCESS_ADMISSION")
        args = self.admission["emulator"]["cmdline"]
        for flag, value in (("-avd", self.admission["avdName"]), ("-datadir", str(self.avd))):
            require(args.count(flag) == 1 and args.index(flag) + 1 < len(args) and args[args.index(flag) + 1] == value, "EMULATOR_COMMAND_BINDING")
        require(("-port" in args and args[args.index("-port") + 1] == "5568") or
                ("-ports" in args and args[args.index("-ports") + 1] == "5568,5569"), "EMULATOR_PORT_BINDING")
        self.target = self.under(self.a.target_apk, self.job); self.test = self.under(self.a.test_apk, self.job)
        self.directory = self.under(self.a.evidence_dir, self.job, exists=False)
        require(not self.directory.exists(), "EVIDENCE_NOT_FRESH")
        require(self.sys.free(self.temp) >= RESERVE and self.sys.allocation(self.job) <= CAP, "STORAGE_BOUND")
        self.directory.mkdir(mode=0o700)
        self.evidence_owned = True
        sdk = Path(self.a.sdk).resolve(strict=True)
        self.aapt, self.signer = sdk / "build-tools/36.0.0/aapt", sdk / "build-tools/36.0.0/apksigner"
        self.analyzer = sdk / "cmdline-tools/latest/bin/apkanalyzer"
        adb = sdk / "platform-tools/adb"
        for tool in (self.aapt, self.signer, self.analyzer, adb):
            require(tool.is_file() and os.access(tool, os.X_OK) and tool.resolve().is_relative_to(sdk), "SDK_TOOL_REQUIRED")
        self.adb = [str(adb), "-H", "127.0.0.1", "-P", str(PORT), "-s", SERIAL]
        self.env = {"PATH": self.sys.environ.get("PATH", ""), "HOME": str(self.job), "TMPDIR": str(self.job),
                    "ADB_SERVER_SOCKET": "tcp:127.0.0.1:5142", "ANDROID_ADB_SERVER_PORT": "5142"}
        if "JAVA_HOME" in self.sys.environ:
            self.env["JAVA_HOME"] = self.sys.environ["JAVA_HOME"]
        self.check()
        target = self.apk(self.target, self.admission["targetApk"], True)
        test = self.apk(self.test, self.admission["testApk"], False)
        dex = no_tauri_definitions(self.test)
        require(self.text(self.adb + ["shell", "getprop", "ro.build.version.sdk"]).strip() == "36", "GUEST_API")
        require(self.text(self.adb + ["shell", "getprop", "ro.boot.qemu.avd_name"]).splitlines() == [self.admission["avdName"]], "GUEST_AVD_NAME")
        for package in (TARGET, TEST_PACKAGE):
            require(self.text(self.adb + ["shell", "pm", "list", "packages", package]).strip() == "", "PACKAGE_NOT_FRESH")
        for path, extra in ((self.target, []), (self.test, ["-t"])):
            require(install_succeeded(self.text(self.adb + ["install", *extra, "--no-streaming", "--no-incremental", str(path)], 45)), "INSTALL_FAILED")
        code, stdout, stderr = self.command(self.adb + ["shell", "am", "instrument", "-w", "-r", "-e", "class", TEST_CLASS + "#" + METHOD, TEST_PACKAGE + "/" + RUNNER], self.a.timeout)
        self.instrumentation_signals = instrumentation_signals(stdout, stderr)
        require(code == 0, "TOOL_REFUSAL")
        output = stdout.decode("utf-8", errors="strict")
        proof = evidence(output); self.check()
        require(self.sys.free(self.temp) >= RESERVE, "FINAL_RESERVE")
        result = {"qualification": True, "scope": SCOPE, "sourceRevision": self.admission["sourceRevision"],
                  "controllerSha256": digest(Path(__file__).read_bytes()), "targetApk": target, "testApk": test,
                  "testDex": dex, "evidence": proof, "commands": self.commands,
                  "instrumentationSignals": self.instrumentation_signals,
                  "rootLifecycleCleanupRequired": True, "screenshotsOrGlobalLogcatCollected": False}
        (self.directory / "OWNED_STARTUP.json").write_text(json.dumps(result, sort_keys=True) + "\n")
        return result


class Arguments(argparse.ArgumentParser):
    def error(self, message):
        raise Refusal("CLI_ARGUMENTS")


def main():
    parser = Arguments(description=__doc__)
    for name in ("sdk", "owned-admission", "target-apk", "test-apk", "expected-version", "expected-cert", "evidence-dir", "serial"):
        parser.add_argument("--" + name, required=True)
    for name in ("adb-port", "expected-code", "timeout"):
        parser.add_argument("--" + name, required=True, type=int)
    controller = None
    try:
        controller = Controller(parser.parse_args())
        result = controller.run()
        print(json.dumps({"qualification": True, "scope": SCOPE, "targetSha256": result["targetApk"]["sha256"]}))
        return 0
    except (Refusal, OSError, ValueError, IndexError, KeyError, TypeError, struct.error, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        code = str(error) if isinstance(error, Refusal) else "HOST_OR_INPUT_REFUSAL"
        result = {"qualification": False, "scope": SCOPE, "code": code, "rootLifecycleCleanupRequired": True}
        if isinstance(error, Refusal) and error.module_evidence is not None:
            result["moduleEvidence"] = error.module_evidence
        if controller is not None:
            result["commands"] = controller.commands
            if controller.instrumentation_signals is not None:
                result["instrumentationSignals"] = controller.instrumentation_signals
            if controller.evidence_owned and controller.directory is not None and controller.directory.is_dir():
                (controller.directory / "OWNED_STARTUP.json").write_text(json.dumps(result, sort_keys=True) + "\n")
        print(json.dumps({key: value for key, value in result.items() if key != "commands"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
