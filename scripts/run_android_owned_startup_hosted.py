#!/usr/bin/env python3
"""Root-owned lifecycle for one fresh hosted guest, never an existing device."""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import time


def require(value, code):
    if not value:
        raise RuntimeError(code)


def sha(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("sdk", "target-apk", "test-apk", "source", "certificate", "job-root", "build-binding"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    require(sys.platform == "linux" and os.environ.get("GITHUB_ACTIONS") == "true", "HOST_NOT_ADMITTED")
    require(re.fullmatch(r"[0-9a-f]{40}", args.source), "SOURCE_IDENTITY")
    require(re.fullmatch(r"[0-9a-f]{64}", args.certificate), "CERTIFICATE_IDENTITY")
    temp = Path(os.environ["RUNNER_TEMP"])
    require(temp.is_absolute() and temp.resolve(strict=True) == temp, "RUNNER_TEMP_CANONICAL")
    job = Path(args.job_root)
    require(job.is_absolute() and job.resolve() == job and job.is_relative_to(temp) and job != temp and not job.exists(), "FRESH_JOB_ROOT")
    sdk = Path(args.sdk).resolve(strict=True)
    inputs = [Path(args.target_apk), Path(args.test_apk)]
    for path in inputs:
        require(path.is_absolute() and path.resolve(strict=True) == path and path.is_relative_to(temp) and path.is_file() and
                0 < path.stat().st_size <= 512 * 1024**2, "OWNED_APK_INPUT")
    build_binding = Path(args.build_binding)
    build_root = temp / "owned-startup-build"
    input_root = temp / "owned-startup-input"
    require(build_binding == build_root / "TEST-BUILD-BINDING.json" and build_binding.resolve(strict=True) == build_binding and
            build_binding.is_file() and build_binding.stat().st_size <= 131072, "TEST_BUILD_BINDING_REQUIRED")
    binding = json.loads(build_binding.read_text())
    require(binding.get("schemaVersion") == 1 and binding.get("scope") == "TEST_ONLY_MINIFIED_PLUGIN_ALIAS_NO_PRODUCT_MUTATION", "TEST_BUILD_BINDING_SCHEMA")
    candidate, api = binding["candidate"], binding["api"]
    require(binding.get("finalTestAliasAndLoadDefined") is True and
            sha(build_root / "test-fault-runtime-code.txt") == binding.get("finalTestFaultCodeSha256"), "FINAL_TEST_DEX_BINDING")
    require(candidate["source"] == args.source and re.fullmatch(r"[1-9][0-9]{0,19}", candidate["runId"]), "TEST_BUILD_SOURCE_BINDING")
    for path, expected in zip(inputs, (candidate["apk"], binding["finalTestApk"])):
        require(sha(path) == expected["sha256"] and path.stat().st_size == expected["bytes"], "FINAL_APK_BUILD_BINDING")
    manifest = json.loads((input_root / "phone/android-update.json").read_text())
    require(manifest["sourceRevision"] == args.source and manifest["version"] == "2.3.112" and
            manifest["versionCode"] == 2003112 and manifest["packageName"] == "com.tgk30.debridstreamer" and
            manifest["apk"]["sha256"] == candidate["apk"]["sha256"] and manifest["apk"]["size"] == candidate["apk"]["bytes"], "DOWNLOADED_APK_BUILD_BINDING")
    api_binding = json.loads((input_root / "api/api-build-binding.json").read_text())
    api_receipt = json.loads((input_root / "api/api-source-receipt.json").read_text())
    require(api_binding["source"] == args.source and api_binding["runId"] == candidate["runId"] and
            api_binding["ordinaryApkBuildInSameJob"] is True and api_binding["producerTaskInvokedInThisJob"] is True and
            api_binding["producerTask"] == ":tauri-android:bundleLibCompileToJarRelease", "SAME_JOB_API_BUILD_REQUIRED")
    for filename, field, build_field in (("tauri-android-api-classes.jar", "classesJarSha256", None),
            ("android-r8-mapping.txt", "mappingSha256", "releaseMappingSha256"),
            ("plugin-runtime-code.txt", "runtimeCodeSha256", "pluginRuntimeCodeSha256")):
        require(sha(input_root / "api" / filename) == api[field], "API_INPUT_BUILD_BINDING")
        if build_field is not None:
            require(api[field] == api_binding[build_field], "API_SAME_JOB_HASH")
    require(api_receipt["classesJarSha256"] == api["classesJarSha256"] and
            api_receipt["crateChecksum"] == api["crateChecksum"] == "f316751027fc2644221d1a448564d519efb07067fda584879d9cda966391d212", "PUBLIC_API_RECEIPT_BINDING")
    original_module = Path(__file__).with_name("android-owned-destroy-instrumentation")
    for key, root in (("originalModuleFiles", original_module), ("adaptedModuleFiles", build_root / "module")):
        files = binding[key]
        require(type(files) is dict and len(files) == 10, "TEST_MODULE_INVENTORY")
        for relative, expected in files.items():
            path = root / relative
            require(not Path(relative).is_absolute() and ".." not in Path(relative).parts and path.resolve(strict=True) == path and
                    path.is_file() and sha(path) == expected, "TEST_MODULE_SOURCE_BINDING")
    require(shutil.disk_usage(temp).free >= 9 * 1024**3, "ORIGINAL_NINE_GIB_START_RESERVE")
    require(os.path.exists("/dev/kvm") and os.access("/dev/kvm", os.R_OK | os.W_OK), "KVM_REQUIRED")
    module_path = Path(__file__).with_name("android_owned_startup_runtime.py")
    spec = importlib.util.spec_from_file_location("owned_startup_controller", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Adopt descendants if the controller is terminated before its own finally.
    # This applies only to this short-lived recipe, never the runner globally.
    require(ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0, "OWNED_CHILD_SUBREAPER_REQUIRED")
    for port in (5142, 5568, 5569):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))
    # A hosted runner is disposable, but never silently attach to its old guest.
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            command = (process / "cmdline").read_bytes().split(b"\0")
        except (FileNotFoundError, PermissionError):
            continue
        executable = Path(os.fsdecode(command[0])).name if command and command[0] else ""
        require(not (executable.startswith("qemu-system-") or executable in ("emulator", "emulator64-x86") or
                     (executable == "adb" and b"server" in command)), "EXISTING_ANDROID_PROCESS")
    job.mkdir(mode=0o700)
    avd = job / "avd" / "owned36.avd"
    name = "yawf-owned-" + os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"]
    require(re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", name), "AVD_NAME")
    for folder in ("avd", "android-home", "emulator-home", "tmp", "logs"):
        (job / folder).mkdir(mode=0o700)
    target, test = job / "target.apk", job / "test.apk"
    for source, destination in zip(inputs, (target, test)):
        shutil.copyfile(source, destination)
        destination.chmod(0o600)
        require(sha(source) == sha(destination), "APK_COPY_CHANGED")
    env = dict(os.environ, ANDROID_HOME=str(sdk), ANDROID_SDK_ROOT=str(sdk),
               ANDROID_USER_HOME=str(job / "android-home"), ANDROID_EMULATOR_HOME=str(job / "emulator-home"),
               ANDROID_AVD_HOME=str(job / "avd"), ANDROID_ADB_SERVER_PORT="5142",
               ADB_SERVER_SOCKET="tcp:127.0.0.1:5142", ADB_MDNS_AUTO_CONNECT="0",
               TMPDIR=str(job / "tmp"), PYTHONDONTWRITEBYTECODE="1")
    for key in ("GH_TOKEN", "GITHUB_TOKEN", "ADB_TRACE", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS"):
        env.pop(key, None)
    env["ADB_VENDOR_KEYS"] = str(job / "android-home" / "adbkey")
    owned = []
    descendants = {}
    started = time.monotonic()
    max_allocation = 0
    receipt = {"qualification": False, "scope": "SELECTED_ORDINARY_APK_STARTUP_FAULT_RETRY_ONLY",
               "sourceRevision": args.source, "rootRecipeSha256": sha(Path(__file__)),
               "controllerSha256": sha(module_path), "freshUserdata": True,
               "testBuildBindingSha256": sha(build_binding),
               "startingReserveBytes": shutil.disk_usage(temp).free,
               "noExistingDeviceOrUserDataUsed": True}

    def collect_descendants():
        rows = {}
        for process in Path("/proc").iterdir():
            if not process.name.isdigit():
                continue
            try:
                parts = (process / "stat").read_text().rsplit(")", 1)[1].split()
                rows[int(process.name)] = (int(parts[1]), int(parts[19]))
            except FileNotFoundError:
                continue
        parents = {os.getpid()}
        for _ in range(16):
            children = {pid for pid, (parent, _) in rows.items() if parent in parents}
            if children.issubset(parents):
                break
            parents |= children
        for pid in parents - {os.getpid()}:
            birth = rows[pid][1]
            if pid not in descendants:
                descendants[pid] = birth
            else:
                require(descendants[pid] == birth, "DESCENDANT_PID_REUSE")

    def resource_check():
        nonlocal max_allocation
        collect_descendants()
        allocated = module.allocated(job)
        max_allocation = max(max_allocation, allocated)
        require(shutil.disk_usage(temp).free >= module.RESERVE and allocated <= module.CAP, "ORIGINAL_RUNTIME_STORAGE_BOUND")
        require(time.monotonic() - started < 420, "ROOT_LIFECYCLE_DEADLINE")
        for path in (job / "logs").iterdir():
            require(path.is_file() and path.stat().st_size <= 2 * 1024**2, "ROOT_LOG_BOUND")

    def checked_run(command, timeout, **kwargs):
        resource_check()
        input_file = job / "tmp/avdmanager-input"
        input_file.write_bytes(kwargs.pop("input", b""))
        require(not kwargs, "ROOT_COMMAND_OPTIONS")
        with input_file.open("rb") as data:
            process, birth = launch(command, "avdmanager", stdin=data)
            deadline = time.monotonic() + timeout
            while process.poll() is None:
                alive(process, birth)
                resource_check()
                require(time.monotonic() < deadline, "ROOT_COMMAND_DEADLINE")
                time.sleep(0.2)
        require(process.returncode == 0, "ROOT_COMMAND_FAILED")

    def launch(command, label, stdin=subprocess.DEVNULL):
        path = job / "logs" / (label + ".log")
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            process = subprocess.Popen(command, env=env, stdin=stdin,
                                       stdout=descriptor, stderr=subprocess.STDOUT, start_new_session=True)
        finally:
            os.close(descriptor)
        birth, _ = module.process_identity(process.pid)
        owned.append((process, birth, label))
        descendants[process.pid] = birth
        return process, birth

    def alive(process, birth):
        require(process.poll() is None and module.process_identity(process.pid)[0] == birth and
                os.getpgid(process.pid) == process.pid, "ROOT_OWNED_PROCESS_IDENTITY")

    def cleanup():
        facts = []
        # First stop instrumentation on this exact fresh guest. Do not use
        # default ADB, global device inventory, or any existing device.
        roles = {label: (process, birth) for process, birth, label in owned}
        if "emulator" in roles and "adb-server" in roles:
            try:
                def cleanup_guard():
                    for role in ("emulator", "adb-server"):
                        alive(*roles[role])
                    collect_descendants()
                for package in ("com.tgk30.debridstreamer", "com.yawf.ownedstartupinstrumentation.test"):
                    result = module.System().run(device + ["shell", "am", "force-stop", package], 5, 8192, cleanup_guard, env)
                    require(result[0] == 0, "GUEST_INSTRUMENTATION_STOP_REFUSED")
                facts.append({"role": "guest-instrumentation", "ownedChildReaped": True})
            except Exception:
                facts.append({"role": "guest-instrumentation", "ownedChildReaped": False})
        # Each child is independent: a race or mismatch never skips later roles.
        for process, birth, label in reversed(owned):
            try:
                if process.poll() is None:
                    alive(process, birth)
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        alive(process, birth)
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=5)
                facts.append({"role": label, "ownedChildReaped": process.poll() is not None})
            except Exception:
                facts.append({"role": label, "ownedChildReaped": False})
        # An outer timeout can orphan a separate-session ADB client. Subreaper
        # adoption plus birth identity permits only those owned descendants.
        adopted_ok = True
        try:
            collect_descendants()
            for pid, birth in list(descendants.items()):
                try:
                    parts = (Path("/proc") / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()
                    require(int(parts[19]) == birth and int(parts[1]) == os.getpid(), "ADOPTED_CHILD_IDENTITY")
                    if parts[0] != "Z":
                        os.kill(pid, signal.SIGKILL)
                    deadline = time.monotonic() + 3
                    while os.waitpid(pid, os.WNOHANG)[0] == 0:
                        require(time.monotonic() < deadline, "ADOPTED_CHILD_REAP_TIMEOUT")
                        time.sleep(0.05)
                except FileNotFoundError:
                    continue
                except Exception:
                    adopted_ok = False
            collect_descendants()
            live = []
            for pid, birth in descendants.items():
                try:
                    if module.process_identity(pid)[0] == birth:
                        live.append(pid)
                except FileNotFoundError:
                    pass
            facts.append({"role": "adopted-descendants", "ownedChildReaped": adopted_ok and not live})
        except Exception:
            facts.append({"role": "adopted-descendants", "ownedChildReaped": False})
        return facts

    def interrupted(_signum, _frame):
        raise RuntimeError("ROOT_HOST_SIGNAL")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)

    try:
        manager = sdk / "cmdline-tools/latest/bin/avdmanager"
        checked_run([str(manager), "create", "avd", "--force", "--name", name,
                     "--package", "system-images;android-36;google_apis;x86_64", "--path", str(avd)], 45,
                    input=b"no\n")
        adb = sdk / "platform-tools/adb"
        server, server_birth = launch([str(adb), "-L", "tcp:127.0.0.1:5142", "--one-device", "emulator-5568", "server", "nodaemon"], "adb-server")
        until = time.monotonic() + 15
        while not module.System().port_owned(server.pid, 5142):
            alive(server, server_birth)
            resource_check()
            require(time.monotonic() < until, "ADB_PRIVATE_LISTENER_TIMEOUT")
            time.sleep(0.2)
        emulator, emulator_birth = launch([str(sdk / "emulator/emulator"), "-avd", name,
            "-datadir", str(avd), "-port", "5568", "-no-window", "-no-audio", "-no-boot-anim",
            "-no-snapshot", "-wipe-data", "-memory", "2048", "-gpu", "swiftshader_indirect", "-accel", "on"], "emulator")
        boot_deadline = time.monotonic() + 150
        device = [str(adb), "-H", "127.0.0.1", "-P", "5142", "-s", "emulator-5568"]
        while True:
            alive(emulator, emulator_birth)
            alive(server, server_birth)
            resource_check()
            require(time.monotonic() < boot_deadline, "FRESH_GUEST_BOOT_TIMEOUT")
            result = subprocess.run(device + ["shell", "getprop", "sys.boot_completed"], env=env,
                                    capture_output=True, timeout=4)
            require(len(result.stdout) + len(result.stderr) <= 8192, "BOOT_QUERY_OUTPUT_BOUND")
            if result.returncode == 0 and result.stdout.strip() == b"1":
                break
            time.sleep(1)
        def identity(process, birth):
            alive(process, birth)
            actual_birth, command = module.process_identity(process.pid)
            return {"pid": process.pid, "startTicks": actual_birth,
                    "cmdline": [os.fsdecode(part) for part in command]}
        binding = lambda path: {"sha256": sha(path), "bytes": path.stat().st_size}
        admission = {"schemaVersion": 1, "scope": "ROOT_OWNED_FRESH_HOSTED_API36", "freshUserdata": True,
                     "jobRoot": str(job), "avdName": name, "avdPath": str(avd), "serial": "emulator-5568", "adbPort": 5142,
                     "emulator": identity(emulator, emulator_birth), "adbServer": identity(server, server_birth),
                     "targetApk": binding(target), "testApk": binding(test), "sourceRevision": args.source}
        admission_file = job / "owned-admission.json"
        admission_file.write_text(json.dumps(admission, sort_keys=True) + "\n")
        admission_file.chmod(0o600)
        resource_check()
        controller, controller_birth = launch([sys.executable, "-B", str(module_path), "--sdk", str(sdk),
            "--owned-admission", str(admission_file), "--target-apk", str(target), "--test-apk", str(test),
            "--expected-version", "2.3.112", "--expected-code", "2003112", "--expected-cert", args.certificate,
            "--evidence-dir", str(job / "evidence"), "--adb-port", "5142", "--serial", "emulator-5568", "--timeout", "180"], "controller")
        controller_deadline = time.monotonic() + 200
        while controller.poll() is None:
            alive(controller, controller_birth)
            resource_check()
            require(time.monotonic() < controller_deadline, "ROOT_CONTROLLER_TIMEOUT")
            time.sleep(0.2)
        receipt["controllerExit"] = controller.returncode
        proof_file = job / "evidence/OWNED_STARTUP.json"
        if proof_file.is_file():
            require(proof_file.stat().st_size <= 131072, "CONTROLLER_RECEIPT_BOUND")
            proof = json.loads(proof_file.read_text())
            receipt["controllerReceiptSha256"] = sha(proof_file)
            receipt["qualification"] = controller.returncode == 0 and proof.get("qualification") is True
        resource_check()
    except Exception as error:
        # Only this recipe's fixed refusal messages are retained, never tool text.
        receipt["rootRefusal"] = str(error) if type(error) is RuntimeError else type(error).__name__
        receipt["qualification"] = False
    finally:
        try:
            receipt["cleanup"] = cleanup()
            require(all(item["ownedChildReaped"] for item in receipt["cleanup"]), "OWNED_CLEANUP_INCOMPLETE")
        except Exception:
            receipt["qualification"] = False
            receipt["cleanupRefusal"] = "OWNED_CLEANUP_NOT_CONFIRMED"
        receipt["maxRuntimeAllocatedBytes"] = max_allocation
        receipt["endingReserveBytes"] = shutil.disk_usage(temp).free
        receipt["elapsedSeconds"] = round(time.monotonic() - started, 3)
        (job / "ROOT-LIFECYCLE.json").write_text(json.dumps(receipt, sort_keys=True) + "\n")
    print(json.dumps({"qualification": receipt["qualification"], "scope": receipt["scope"]}))
    return 0 if receipt["qualification"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
