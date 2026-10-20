#!/usr/bin/env python3
"""Host guard for one public 2.3.21 to 2.3.25 native Android OTA transaction.

The target APK is a host-side reference only. After one exact baseline product
install, every product install, push, sync, package-manager install, and direct
installer intent is rejected. One read-only baseline pull and one final pull
after the instrumentation installer-success receipt are admitted explicitly.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import time
import traceback
import unittest
from pathlib import Path
from typing import Sequence

PRODUCT_PACKAGE = "com.tgk30.debridstreamer"
HARNESS_PACKAGE = "com.yawf.runtimeinstrumentation"
HARNESS_TEST_PACKAGE = "com.yawf.runtimeinstrumentation.test"
HARNESS_INSTRUMENTATION = (
    "com.yawf.runtimeinstrumentation.test/androidx.test.runner.AndroidJUnitRunner"
)
HARNESS_CLASS = (
    "com.yawf.runtimeinstrumentation.RuntimeOtaFlowTest#"
    "updateOfficialPublicBaselineThroughNativeUi"
)
EVIDENCE_SUBDIR = "persistent-ota-flow"
BASELINE_VERSION = "2.3.21"
BASELINE_CODE = 2_003_021
BASELINE_SHA256 = "6b7be775e261db5e400790d7c6d80d0ffeca13aada590ae4c66955003c5163f6"
BASELINE_SIZE = 88_509_227
TARGET_VERSION = "2.3.25"
TARGET_CODE = 2_003_025
TARGET_SHA256 = "4f8cb6defe54e128f01790fafd84b6f3fd545d7c6734458d24543edcfa4bc58b"
TARGET_SIZE = 88_533_889
TARGET_SOURCE = "e28c593ed680538dca91c01ac6b993fdc25eb6dd"
SIGNER_PIN = "233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a"
TARGET_TAG = "android-v2.3.25"
TARGET_APK_NAME = "YAWF.Stream_Android_2.3.25.apk"
TARGET_VERIFICATION_NAME = "Android_2.3.25_verification.json"
URL_RE = re.compile(r"https?://[^\s\]\[\"'<>]+", re.IGNORECASE)
SAFE_EVIDENCE_NAME = re.compile(
    r"(?:0[1-9]|[12][0-9]|3[0-9]|40)-[a-z0-9-]+\.(?:png|xml)|"
    r"actions\.txt|instrumentation-receipt\.json"
)


class RuntimeGateError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def redact(value: str) -> str:
    return URL_RE.sub("<redacted-url>", value).replace("\r", "")


def validate_file(path: Path, expected_hash: str, expected_size: int, label: str) -> None:
    if not path.is_file() or path.stat().st_size != expected_size:
        raise RuntimeGateError(f"{label} size mismatch")
    if sha256_file(path) != expected_hash:
        raise RuntimeGateError(f"{label} SHA-256 mismatch")


def validate_target_manifest(path: Path) -> dict[str, object]:
    if not path.is_file() or path.stat().st_size > 16 * 1024:
        raise RuntimeGateError("Target manifest is missing or oversized")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeGateError("Target manifest is invalid JSON") from error
    if not isinstance(value, dict) or set(value) != {
        "schemaVersion", "version", "versionCode", "packageName", "sourceRevision", "apk"
    }:
        raise RuntimeGateError("Target manifest keys are not exact")
    apk = value.get("apk")
    if not isinstance(apk, dict) or set(apk) != {"name", "sha256", "size"}:
        raise RuntimeGateError("Target manifest APK keys are not exact")
    expected = {
        "schemaVersion": 1,
        "version": TARGET_VERSION,
        "versionCode": TARGET_CODE,
        "packageName": PRODUCT_PACKAGE,
        "sourceRevision": TARGET_SOURCE,
    }
    for key, expected_value in expected.items():
        if type(value.get(key)) is not type(expected_value) or value.get(key) != expected_value:
            raise RuntimeGateError(f"Target manifest {key} mismatch")
    if apk != {"name": TARGET_APK_NAME, "sha256": TARGET_SHA256, "size": TARGET_SIZE}:
        raise RuntimeGateError("Target manifest APK identity mismatch")
    return value


def validate_target_verification(path: Path) -> dict[str, object]:
    if not path.is_file() or path.stat().st_size > 64 * 1024:
        raise RuntimeGateError("Target verification receipt is missing or oversized")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeGateError("Target verification receipt is invalid JSON") from error
    if not isinstance(value, dict) or set(value) != {
        "version", "sourceRevision", "buildRun", "apk", "certificateSha256",
        "checks", "pending", "limits",
    }:
        raise RuntimeGateError("Target verification receipt keys are not exact")
    if value.get("version") != TARGET_VERSION or value.get("sourceRevision") != TARGET_SOURCE:
        raise RuntimeGateError("Target verification version/source mismatch")
    build_run = value.get("buildRun")
    if type(build_run) is not int or build_run <= 0:
        raise RuntimeGateError("Target verification build run is invalid")
    if value.get("apk") != {
        "name": TARGET_APK_NAME,
        "sha256": TARGET_SHA256,
        "size": TARGET_SIZE,
    }:
        raise RuntimeGateError("Target verification APK identity mismatch")
    if value.get("certificateSha256") != SIGNER_PIN:
        raise RuntimeGateError("Target verification signer mismatch")
    if not isinstance(value.get("checks"), dict) or not value["checks"]:
        raise RuntimeGateError("Target verification checks are missing")
    for name in ("pending", "limits"):
        entries = value.get(name)
        if (not isinstance(entries, list) or len(entries) > 32
                or any(not isinstance(entry, str) or not entry for entry in entries)):
            raise RuntimeGateError(f"Target verification {name} is invalid")
    return value


def parse_checksums(path: Path) -> dict[str, str]:
    if not path.is_file() or path.stat().st_size > 16 * 1024:
        raise RuntimeGateError("SHA256SUMS is missing or oversized")
    result: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9._-]+)", line)
        if match is None or match.group(2) in result:
            raise RuntimeGateError("SHA256SUMS has an invalid or duplicate row")
        result[match.group(2)] = match.group(1)
    if set(result) != {TARGET_APK_NAME, "android-update.json", TARGET_VERIFICATION_NAME}:
        raise RuntimeGateError("SHA256SUMS asset set is not exact")
    if result[TARGET_APK_NAME] != TARGET_SHA256:
        raise RuntimeGateError("SHA256SUMS target APK hash mismatch")
    return result


def validate_release_pages(directory: Path, verification_path: Path) -> dict[str, object]:
    pages = sorted(directory.glob("page-*.json"))
    if not pages or len(pages) > 10:
        raise RuntimeGateError("Release history page count is outside bounds")
    releases: list[dict[str, object]] = []
    reached_end = False
    for index, page in enumerate(pages, start=1):
        if page.name != f"page-{index}.json" or page.stat().st_size > 1024 * 1024:
            raise RuntimeGateError("Release history page identity is invalid")
        value = json.loads(page.read_text(encoding="utf-8"))
        if not isinstance(value, list) or len(value) > 20:
            raise RuntimeGateError("Release history page is invalid")
        if reached_end:
            raise RuntimeGateError("Release history contains pages after its end")
        releases.extend(item for item in value if isinstance(item, dict))
        if len(value) < 20:
            reached_end = True
    if not reached_end:
        raise RuntimeGateError("Release history did not reach a bounded end")

    stable: list[tuple[tuple[int, int, int], dict[str, object]]] = []
    for release in releases:
        if release.get("draft") is not False or release.get("prerelease") is not False:
            continue
        tag = release.get("tag_name")
        match = re.fullmatch(r"android-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", tag or "")
        if match is not None:
            stable.append((tuple(map(int, match.groups())), release))
    if not stable:
        raise RuntimeGateError("No stable Android phone releases were found")
    _, newest = max(stable, key=lambda item: item[0])
    if newest.get("tag_name") != TARGET_TAG:
        raise RuntimeGateError("2.3.25 is not the newest stable Android phone release")

    assets = newest.get("assets")
    if not isinstance(assets, list) or len(assets) > 200:
        raise RuntimeGateError("Target release assets are invalid")
    selected: dict[str, dict[str, object]] = {}
    for asset in assets:
        if not isinstance(asset, dict) or asset.get("name") not in {
            TARGET_APK_NAME, "android-update.json", TARGET_VERIFICATION_NAME, "SHA256SUMS"
        }:
            continue
        name = str(asset["name"])
        if name in selected:
            raise RuntimeGateError("Target release has duplicate required assets")
        expected_url = f"https://github.com/Tgk-30/YAWF-Stream/releases/download/{TARGET_TAG}/{name}"
        if asset.get("browser_download_url") != expected_url:
            raise RuntimeGateError("Target release asset URL is not exact")
        selected[name] = asset
    if set(selected) != {
        TARGET_APK_NAME, "android-update.json", TARGET_VERIFICATION_NAME, "SHA256SUMS"
    }:
        raise RuntimeGateError("Target release required assets are incomplete")
    apk = selected[TARGET_APK_NAME]
    if apk.get("size") != TARGET_SIZE:
        raise RuntimeGateError("Target release APK size mismatch")
    digest = apk.get("digest")
    if digest is not None and digest != f"sha256:{TARGET_SHA256}":
        raise RuntimeGateError("Target release APK digest mismatch")
    verification = selected[TARGET_VERIFICATION_NAME]
    verification_hash = sha256_file(verification_path)
    if verification.get("size") != verification_path.stat().st_size:
        raise RuntimeGateError("Target release verification receipt size mismatch")
    if verification.get("digest") != f"sha256:{verification_hash}":
        raise RuntimeGateError("Target release verification receipt digest mismatch")
    return newest


@dataclasses.dataclass(frozen=True)
class PackageIdentity:
    version_name: str
    version_code: int
    uid: int
    first_install_time: str
    last_update_time: str


def parse_package_identity(value: str) -> PackageIdentity:
    patterns = {
        "version_name": r"\bversionName=([^\s]+)",
        "version_code": r"\bversionCode=(\d+)",
        "uid": r"\buserId=(\d+)",
        "first_install_time": r"\bfirstInstallTime=([^\n\r]+)",
        "last_update_time": r"\blastUpdateTime=([^\n\r]+)",
    }
    found = {name: re.search(pattern, value) for name, pattern in patterns.items()}
    if any(match is None for match in found.values()):
        raise RuntimeGateError("Package identity fields are incomplete")
    return PackageIdentity(
        version_name=found["version_name"].group(1),
        version_code=int(found["version_code"].group(1)),
        uid=int(found["uid"].group(1)),
        first_install_time=found["first_install_time"].group(1).strip(),
        last_update_time=found["last_update_time"].group(1).strip(),
    )


def validate_receipt(value: dict[str, object]) -> None:
    expected = {
        "outcome": "passed",
        "persistentUiAutomationSession": True,
        "productPackage": PRODUCT_PACKAGE,
        "baselineVersion": BASELINE_VERSION,
        "targetVersion": TARGET_VERSION,
        "targetSha256": TARGET_SHA256,
        "productPermissionPageObserved": True,
        "permissionEnabledByTest": True,
        "installerSuccessObserved": True,
        "installerOpenObserved": True,
        "updatedProductObserved": True,
        "permissionCleanupObserved": True,
    }
    for key, expected_value in expected.items():
        if value.get(key) != expected_value:
            raise RuntimeGateError(f"Instrumentation receipt {key} did not prove the full OTA")
    if value.get("failure") is not None:
        raise RuntimeGateError("Instrumentation receipt retained a failure")


class AdmittedAdb:
    """ADB wrapper with an explicit one-product-install state machine."""

    def __init__(
        self,
        executable: str,
        serial: str,
        baseline_apk: Path,
        target_apk: Path,
        harness_app: Path,
        harness_test: Path,
    ):
        self.executable = executable
        self.serial = serial
        self.baseline_apk = baseline_apk.resolve()
        self.target_apk = target_apk.resolve()
        self.harness_app = harness_app.resolve()
        self.harness_test = harness_test.resolve()
        self.baseline_installed = False
        self.baseline_pulled = False
        self.installer_success_receipt = False
        self.final_pulled = False
        self.commands: list[tuple[str, ...]] = []

    def _execute(
        self,
        args: Sequence[str],
        *,
        timeout: float = 30,
        check: bool = True,
        text: bool = True,
    ) -> subprocess.CompletedProcess:
        self.commands.append(tuple(args))
        result = subprocess.run(
            [self.executable, "-s", self.serial, *args],
            capture_output=True,
            timeout=timeout,
            check=False,
            text=text,
        )
        if check and result.returncode != 0:
            stdout = result.stdout if text else result.stdout.decode("utf-8", "replace")
            stderr = result.stderr if text else result.stderr.decode("utf-8", "replace")
            raise RuntimeGateError(
                f"ADB command failed ({result.returncode}): {args[0]}\n"
                + redact(stdout + "\n" + stderr)[-4000:]
            )
        return result

    def _reject_transfer_or_install(self, args: Sequence[str]) -> None:
        lowered = [part.casefold() for part in args]
        joined = " ".join(lowered)
        if any(str(self.target_apk).casefold() in part for part in lowered):
            raise RuntimeGateError("Target APK path must never be passed to ADB")
        if not args:
            return
        if lowered[0].startswith("install") or lowered[0] in {"push", "sync"}:
            raise RuntimeGateError("ADB package transfer/install is locked")
        if lowered[0] == "shell":
            shell = lowered[1:]
            if len(shell) >= 2 and shell[0] == "pm" and shell[1].startswith("install"):
                raise RuntimeGateError("Package-manager install is locked")
            if len(shell) >= 3 and shell[:2] == ["cmd", "package"] and shell[2].startswith("install"):
                raise RuntimeGateError("cmd package install is locked")
            if len(shell) >= 2 and shell[:2] == ["am", "start"] and (
                "application/vnd.android.package-archive" in joined
                or "content:" in joined
                or "file:" in joined
                or ".apk" in joined
            ):
                raise RuntimeGateError("Direct installer intent is locked")

    def run(self, args: Sequence[str], **kwargs) -> subprocess.CompletedProcess:
        self._reject_transfer_or_install(args)
        return self._execute(args, **kwargs)

    def shell(self, *args: str, timeout: float = 30, check: bool = True) -> str:
        return self.run(["shell", *args], timeout=timeout, check=check).stdout

    def exec_out(self, *args: str, timeout: float = 30) -> bytes:
        return self.run(["exec-out", *args], timeout=timeout, text=False).stdout

    def install_harness(self, app_hash: str, test_hash: str) -> None:
        if self.baseline_installed:
            raise RuntimeGateError("Harness installation is forbidden after baseline")
        if sha256_file(self.harness_app) != app_hash or sha256_file(self.harness_test) != test_hash:
            raise RuntimeGateError("Harness APK hash mismatch")
        for path, flags in (
            (self.harness_app, ["install", "--no-streaming", "-r"]),
            (self.harness_test, ["install", "--no-streaming", "-r", "-t"]),
        ):
            result = self._execute([*flags, str(path)], timeout=120)
            if "Success" not in result.stdout:
                raise RuntimeGateError("Harness install did not report Success")

    def install_baseline_once(self) -> None:
        if self.baseline_installed:
            raise RuntimeGateError("Baseline product install may occur exactly once")
        result = self._execute(
            ["install", "--no-streaming", str(self.baseline_apk)], timeout=180
        )
        if "Success" not in result.stdout:
            raise RuntimeGateError("Baseline install did not report Success")
        self.baseline_installed = True

    def pull_baseline_once(self, remote: str, destination: Path) -> None:
        if not self.baseline_installed or self.baseline_pulled:
            raise RuntimeGateError("Baseline pull scope is invalid")
        self._execute(["pull", remote, str(destination)], timeout=180)
        self.baseline_pulled = True

    def mark_installer_success_receipt(self) -> None:
        self.installer_success_receipt = True

    def pull_final_once(self, remote: str, destination: Path) -> None:
        if not self.installer_success_receipt or self.final_pulled:
            raise RuntimeGateError("Final pull requires one genuine installer-success receipt")
        self._execute(["pull", remote, str(destination)], timeout=180)
        self.final_pulled = True


class OtaRuntimeDriver:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.evidence = args.evidence
        self.evidence.mkdir(parents=True, exist_ok=True)
        self.adb = AdmittedAdb(
            args.adb,
            args.serial,
            args.baseline_apk,
            args.target_apk,
            args.harness_app,
            args.harness_test,
        )
        self.events: list[str] = []

    def note(self, value: str) -> None:
        safe = redact(value)
        self.events.append(safe)
        print(safe, flush=True)

    def write(self, name: str, value: str) -> None:
        if Path(name).name != name or len(value.encode()) > 2 * 1024 * 1024:
            raise RuntimeGateError("Unsafe host evidence write")
        (self.evidence / name).write_text(redact(value), encoding="utf-8")

    def verify_host_inputs(self) -> None:
        validate_file(self.args.baseline_apk, BASELINE_SHA256, BASELINE_SIZE, "baseline APK")
        validate_file(self.args.target_apk, TARGET_SHA256, TARGET_SIZE, "target APK")
        validate_target_manifest(self.args.target_manifest)
        validate_target_verification(self.args.target_verification)
        checksums = parse_checksums(self.args.target_checksums)
        if checksums["android-update.json"] != sha256_file(self.args.target_manifest):
            raise RuntimeGateError("SHA256SUMS manifest hash mismatch")
        if checksums[TARGET_VERIFICATION_NAME] != sha256_file(self.args.target_verification):
            raise RuntimeGateError("SHA256SUMS verification receipt hash mismatch")
        validate_release_pages(self.args.release_pages, self.args.target_verification)
        self.note(
            "Public release, manifest, verification receipt, checksum, source, size, and hash pins passed"
        )

    def package_absent(self) -> None:
        result = self.adb.run(
            ["shell", "pm", "path", PRODUCT_PACKAGE], timeout=30, check=False
        )
        if result.returncode == 0 and "package:" in result.stdout:
            raise RuntimeGateError("Fresh emulator already contains the product package")

    def package_dump(self) -> str:
        return self.adb.shell("dumpsys", "package", PRODUCT_PACKAGE, timeout=60)

    def base_path(self) -> str:
        output = self.adb.shell("pm", "path", PRODUCT_PACKAGE, timeout=30)
        paths = [
            line.removeprefix("package:").strip()
            for line in output.splitlines()
            if line.strip().endswith("base.apk")
        ]
        if len(paths) != 1:
            raise RuntimeGateError("Installed package did not expose exactly one base.apk")
        return paths[0]

    def signer(self, apk: Path) -> str:
        result = subprocess.run(
            [self.args.apksigner, "verify", "--print-certs", str(apk)],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeGateError("apksigner rejected an installed APK")
        match = re.search(r"certificate SHA-256 digest:\s*([0-9a-fA-F:]+)", result.stdout)
        if match is None:
            raise RuntimeGateError("Installed APK signer digest is missing")
        return match.group(1).replace(":", "").casefold()

    def assert_unknown_source_denied(self, phase: str) -> None:
        value = self.adb.shell(
            "cmd", "appops", "get", PRODUCT_PACKAGE, "REQUEST_INSTALL_PACKAGES",
            timeout=30,
            check=False,
        )
        self.write(f"unknown-source-{phase}.txt", value)
        if re.search(r"REQUEST_INSTALL_PACKAGES:\s*allow\b", value, re.IGNORECASE):
            raise RuntimeGateError(f"YAWF unknown-source access remained allowed at {phase}")

    def install_and_record_baseline(self) -> tuple[PackageIdentity, str]:
        self.package_absent()
        self.adb.install_harness(self.args.harness_app_sha256, self.args.harness_test_sha256)
        self.adb.install_baseline_once()
        identity = parse_package_identity(self.package_dump())
        if identity.version_name != BASELINE_VERSION or identity.version_code != BASELINE_CODE:
            raise RuntimeGateError("Installed baseline version identity mismatch")
        pulled = self.evidence / "installed-baseline-2.3.21.apk"
        self.adb.pull_baseline_once(self.base_path(), pulled)
        validate_file(pulled, BASELINE_SHA256, BASELINE_SIZE, "installed baseline")
        signer = self.signer(pulled)
        if signer != SIGNER_PIN:
            raise RuntimeGateError("Installed baseline signer mismatch")
        self.assert_unknown_source_denied("before")
        self.write("baseline-package.txt", self.package_dump())
        self.write("baseline-identity.json", json.dumps(dataclasses.asdict(identity), indent=2) + "\n")
        self.note("Exactly one official baseline product install and scoped read-only pull passed")
        return identity, signer

    def run_instrumentation(self) -> dict[str, object]:
        result = self.adb.run(
            [
                "shell", "am", "instrument", "-w", "-r",
                "-e", "class", HARNESS_CLASS,
                "-e", "evidenceSubdir", EVIDENCE_SUBDIR,
                "-e", "baselineVersion", BASELINE_VERSION,
                "-e", "targetVersion", TARGET_VERSION,
                "-e", "targetVersionCode", str(TARGET_CODE),
                "-e", "targetSha256", TARGET_SHA256,
                "-e", "targetSize", str(TARGET_SIZE),
                HARNESS_INSTRUMENTATION,
            ],
            timeout=self.args.flow_timeout,
            check=False,
        )
        self.write("instrumentation-output.txt", result.stdout + result.stderr)
        retrieval_error: Exception | None = None
        try:
            self.retrieve_harness_evidence()
        except Exception as error:
            retrieval_error = error
            self.write("instrumentation-retrieval-error.txt", f"{type(error).__name__}: {error}\n")
        receipt_path = self.evidence / "persistent-ota-flow" / "instrumentation-receipt.json"
        if result.returncode != 0 or "OK (1 test)" not in result.stdout:
            raise RuntimeGateError("Persistent OTA instrumentation failed; runner output retained")
        if retrieval_error is not None:
            raise RuntimeGateError("Persistent OTA evidence retrieval failed") from retrieval_error
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        validate_receipt(receipt)
        self.adb.mark_installer_success_receipt()
        self.note("Persistent UI receipt proves native updater and OS installer success")
        return receipt

    def retrieve_harness_evidence(self) -> None:
        destination = self.evidence / "persistent-ota-flow"
        destination.mkdir(exist_ok=True)
        remote = f"files/{EVIDENCE_SUBDIR}"
        listing = self.adb.exec_out(
            "run-as", HARNESS_PACKAGE, "ls", "-1", remote, timeout=30
        ).decode("utf-8", "strict")
        names = listing.splitlines()
        if not names or len(names) > 84 or len(names) != len(set(names)):
            raise RuntimeGateError("Harness evidence listing count/duplicates are invalid")
        for name in names:
            if SAFE_EVIDENCE_NAME.fullmatch(name) is None or name != Path(name).name:
                raise RuntimeGateError(f"Unexpected harness evidence name: {name!r}")
            limit = 8 * 1024 * 1024 if name.endswith(".png") else 1024 * 1024
            if name in {"actions.txt", "instrumentation-receipt.json"}:
                limit = 64 * 1024
            remote_file = f"{remote}/{name}"
            size_text = self.adb.exec_out(
                "run-as", HARNESS_PACKAGE, "stat", "-c", "%s", remote_file, timeout=20
            ).decode("ascii", "strict").strip()
            if re.fullmatch(r"[1-9]\d*", size_text) is None or int(size_text) > limit:
                raise RuntimeGateError("Harness evidence size is invalid")
            payload = self.adb.exec_out(
                "run-as", HARNESS_PACKAGE, "cat", remote_file, timeout=60
            )
            if len(payload) != int(size_text):
                raise RuntimeGateError("Harness evidence read was partial")
            (destination / name).write_bytes(payload)
        if "instrumentation-receipt.json" not in names:
            raise RuntimeGateError("Harness receipt is missing")

    def verify_final(self, baseline: PackageIdentity, baseline_signer: str) -> None:
        final = parse_package_identity(self.package_dump())
        if final.version_name != TARGET_VERSION or final.version_code != TARGET_CODE:
            raise RuntimeGateError("Final installed version identity mismatch")
        if final.uid != baseline.uid or final.first_install_time != baseline.first_install_time:
            raise RuntimeGateError("UID or first-install time changed across OTA")
        if final.last_update_time == baseline.last_update_time:
            raise RuntimeGateError("Last-update time did not change across OTA")
        pulled = self.evidence / "installed-final-2.3.25.apk"
        self.adb.pull_final_once(self.base_path(), pulled)
        validate_file(pulled, TARGET_SHA256, TARGET_SIZE, "installed final")
        final_signer = self.signer(pulled)
        if final_signer != baseline_signer or final_signer != SIGNER_PIN:
            raise RuntimeGateError("Final installed signer changed")
        self.assert_unknown_source_denied("after-cleanup")
        residual = self.adb.shell(
            "find",
            f"/sdcard/Android/data/{PRODUCT_PACKAGE}/files/Download/updates",
            "-maxdepth", "1", "-type", "f", "-name", "*.apk", "-print",
            timeout=30,
            check=False,
        ).strip()
        if residual:
            raise RuntimeGateError("External update APK remained after relaunch cleanup")
        self.write("final-package.txt", self.package_dump())
        self.write("final-identity.json", json.dumps(dataclasses.asdict(final), indent=2) + "\n")
        self.write(
            "installed-byte-identity.txt",
            f"baselineSha256={BASELINE_SHA256}\nfinalSha256={TARGET_SHA256}\n"
            f"signerSha256={final_signer}\nuidRetained=true\nfirstInstallTimeRetained=true\n"
            "lastUpdateTimeChanged=true\n",
        )
        self.note("Final OS-installed base APK exactly matches public 2.3.25 and retained identity")

    def collect_diagnostics(self) -> None:
        logcat = self.adb.run(["logcat", "-d", "-v", "threadtime"], timeout=60, check=False).stdout
        anr = self.adb.shell("dumpsys", "dropbox", "--print", "data_app_anr", timeout=60, check=False)
        crash = self.adb.shell("dumpsys", "dropbox", "--print", "data_app_crash", timeout=60, check=False)
        self.write("logcat.txt", logcat)
        self.write("dropbox-anr.txt", anr)
        self.write("dropbox-crash.txt", crash)
        escaped = re.escape(PRODUCT_PACKAGE)
        patterns = [
            re.compile(rf"\bANR in {escaped}(?=\s|$)"),
            re.compile(rf"(?m)^Process:\s*{escaped}(?:,\s*PID:\s*\d+)?\s*$"),
        ]
        combined = logcat + "\n" + anr + "\n" + crash
        if any(pattern.search(combined) for pattern in patterns):
            raise RuntimeGateError("Product ANR/crash evidence was retained")

    def run(self) -> None:
        self.verify_host_inputs()
        baseline, signer = self.install_and_record_baseline()
        self.run_instrumentation()
        self.verify_final(baseline, signer)
        self.collect_diagnostics()
        self.write("events.txt", "\n".join(self.events) + "\n")
        self.write(
            "RESULT.json",
            json.dumps(
                {
                    "outcome": "passed",
                    "transaction": "public-native-ota",
                    "baseline": BASELINE_VERSION,
                    "target": TARGET_VERSION,
                    "targetSha256": TARGET_SHA256,
                    "adbProductInstalls": 1,
                    "targetTransferredToAdb": False,
                    "baselinePull": True,
                    "finalPullAfterInstallerReceipt": True,
                },
                indent=2,
            )
            + "\n",
        )


def actual_verification_fixture() -> dict[str, object]:
    """Shape copied from the final 2.3.25 release verification asset."""
    return {
        "version": "2.3.25",
        "sourceRevision": "e28c593ed680538dca91c01ac6b993fdc25eb6dd",
        "buildRun": 39365387810,
        "apk": {
            "name": "YAWF.Stream_Android_2.3.25.apk",
            "sha256": "4f8cb6defe54e128f01790fafd84b6f3fd545d7c6734458d24543edcfa4bc58b",
            "size": 88533889,
        },
        "certificateSha256":
            "233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a",
        "checks": {
            "exactApkStructureSignerPermissionsAnd16KiBAlignment": True,
            "fourAbis": True,
            "api30ProductionSignedFreshFlows": {
                "driverSource": "c52dc43219017f3bff3b95f7d1a58e82d564fe6f",
                "run": 39366593051,
                "sequentialFreshEmulators": 2,
                "onboardingAndOrdinaryTourSkip": True,
                "moreNavigationActuallyReachesSettings": True,
                "installedNativeAndroidUpdateGuidanceVisible": True,
                "noBrowserInstallInstruction": True,
                "manualNativeUpToDateCheck": True,
                "fullOtaInstall": False,
            },
        },
        "pending": [
            "Supplementary API36 stock-provider flow.",
            "Public21-to25 native updater installation.",
            "Full feature-by-feature all-platform audit.",
        ],
        "limits": [
            "Two API30 x86_64 emulator flows used a pinned CI-only WebView91 compatibility provider. They do not prove every device or a current-security browser.",
            "Offline16KiB alignment checks are not ARM16KiB runtime proof.",
            "This receipt does not claim every codec, HDR, DRM, audible audio, physical-device playback or external-player decoding.",
            "Automatic APK checks are opt-in. Android installation still requires confirmation; silent installation is not claimed.",
        ],
    }


class PolicyTests(unittest.TestCase):
    def test_manifest_exact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "android-update.json"
            path.write_text(json.dumps({
                "schemaVersion": 1,
                "version": TARGET_VERSION,
                "versionCode": TARGET_CODE,
                "packageName": PRODUCT_PACKAGE,
                "sourceRevision": TARGET_SOURCE,
                "apk": {"name": TARGET_APK_NAME, "sha256": TARGET_SHA256, "size": TARGET_SIZE},
            }))
            self.assertEqual(validate_target_manifest(path)["version"], TARGET_VERSION)
            value = json.loads(path.read_text())
            value["versionCode"] = TARGET_CODE + 1
            path.write_text(json.dumps(value))
            with self.assertRaises(RuntimeGateError):
                validate_target_manifest(path)

    def test_release_requires_newest_public_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            verification = root / TARGET_VERIFICATION_NAME
            verification.write_text(json.dumps(actual_verification_fixture()))
            verification_hash = sha256_file(verification)
            assets = [
                {"name": TARGET_APK_NAME, "size": TARGET_SIZE, "digest": f"sha256:{TARGET_SHA256}",
                 "browser_download_url": f"https://github.com/Tgk-30/YAWF-Stream/releases/download/{TARGET_TAG}/{TARGET_APK_NAME}"},
                {"name": "android-update.json", "browser_download_url": f"https://github.com/Tgk-30/YAWF-Stream/releases/download/{TARGET_TAG}/android-update.json"},
                {"name": TARGET_VERIFICATION_NAME, "size": verification.stat().st_size,
                 "digest": f"sha256:{verification_hash}",
                 "browser_download_url": f"https://github.com/Tgk-30/YAWF-Stream/releases/download/{TARGET_TAG}/{TARGET_VERIFICATION_NAME}"},
                {"name": "SHA256SUMS", "browser_download_url": f"https://github.com/Tgk-30/YAWF-Stream/releases/download/{TARGET_TAG}/SHA256SUMS"},
            ]
            release = {"draft": False, "prerelease": False, "tag_name": TARGET_TAG, "assets": assets}
            (root / "page-1.json").write_text(json.dumps([release]))
            self.assertEqual(validate_release_pages(root, verification)["tag_name"], TARGET_TAG)
            release["draft"] = True
            (root / "page-1.json").write_text(json.dumps([release]))
            with self.assertRaises(RuntimeGateError):
                validate_release_pages(root, verification)

    def test_release_binds_verification_bytes_and_digest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            verification = root / TARGET_VERIFICATION_NAME
            verification.write_text(json.dumps(actual_verification_fixture()))
            verification_hash = sha256_file(verification)
            verification_asset = {
                "name": TARGET_VERIFICATION_NAME,
                "size": verification.stat().st_size,
                "digest": f"sha256:{verification_hash}",
                "browser_download_url":
                    f"https://github.com/Tgk-30/YAWF-Stream/releases/download/"
                    f"{TARGET_TAG}/{TARGET_VERIFICATION_NAME}",
            }
            assets = [
                {"name": TARGET_APK_NAME, "size": TARGET_SIZE,
                 "digest": f"sha256:{TARGET_SHA256}",
                 "browser_download_url":
                    f"https://github.com/Tgk-30/YAWF-Stream/releases/download/"
                    f"{TARGET_TAG}/{TARGET_APK_NAME}"},
                {"name": "android-update.json", "browser_download_url":
                    f"https://github.com/Tgk-30/YAWF-Stream/releases/download/"
                    f"{TARGET_TAG}/android-update.json"},
                verification_asset,
                {"name": "SHA256SUMS", "browser_download_url":
                    f"https://github.com/Tgk-30/YAWF-Stream/releases/download/"
                    f"{TARGET_TAG}/SHA256SUMS"},
            ]
            release = {
                "draft": False,
                "prerelease": False,
                "tag_name": TARGET_TAG,
                "assets": assets,
            }
            (root / "page-1.json").write_text(json.dumps([release]))
            self.assertEqual(validate_release_pages(root, verification)["tag_name"], TARGET_TAG)
            verification_asset["digest"] = "sha256:" + "0" * 64
            (root / "page-1.json").write_text(json.dumps([release]))
            with self.assertRaises(RuntimeGateError):
                validate_release_pages(root, verification)
            verification_asset["digest"] = f"sha256:{verification_hash}"
            verification_asset["size"] = verification.stat().st_size + 1
            (root / "page-1.json").write_text(json.dumps([release]))
            with self.assertRaises(RuntimeGateError):
                validate_release_pages(root, verification)

    def test_verification_receipt_matches_actual_asset_shape(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / TARGET_VERIFICATION_NAME
            actual = actual_verification_fixture()
            path.write_text(json.dumps(actual))
            self.assertEqual(validate_target_verification(path)["version"], TARGET_VERSION)
            corruptions = [
                ("version", "2.3.24"),
                ("sourceRevision", "0" * 40),
                ("apk", {**actual["apk"], "sha256": "0" * 64}),
            ]
            for key, bad_value in corruptions:
                damaged = {**actual, key: bad_value}
                path.write_text(json.dumps(damaged))
                with self.assertRaises(RuntimeGateError, msg=key):
                    validate_target_verification(path)
            path.write_text(json.dumps({**actual, "unexpected": True}))
            with self.assertRaises(RuntimeGateError):
                validate_target_verification(path)
            missing = dict(actual)
            missing.pop("certificateSha256")
            path.write_text(json.dumps(missing))
            with self.assertRaises(RuntimeGateError):
                validate_target_verification(path)

    def test_checksums_reject_duplicates_and_wrong_set(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "SHA256SUMS"
            valid = (
                f"{TARGET_SHA256}  {TARGET_APK_NAME}\n"
                f"{'a' * 64}  android-update.json\n"
                f"{'c' * 64}  {TARGET_VERIFICATION_NAME}\n"
            )
            path.write_text(valid)
            self.assertEqual(parse_checksums(path)[TARGET_APK_NAME], TARGET_SHA256)
            path.write_text(valid.replace(TARGET_SHA256, "b" * 64, 1))
            with self.assertRaises(RuntimeGateError):
                parse_checksums(path)
            path.write_text(valid + f"{'d' * 64}  unexpected.json\n")
            with self.assertRaises(RuntimeGateError):
                parse_checksums(path)
            path.write_text(valid.replace(f"{'c' * 64}  {TARGET_VERIFICATION_NAME}\n", ""))
            with self.assertRaises(RuntimeGateError):
                parse_checksums(path)
            path.write_text(valid + f"{TARGET_SHA256}  {TARGET_APK_NAME}\n")
            with self.assertRaises(RuntimeGateError):
                parse_checksums(path)

    def test_identity_requires_all_retention_fields(self) -> None:
        value = "versionName=2.3.21 versionCode=2003021 userId=10123\nfirstInstallTime=2026-10-20 01:02:03\nlastUpdateTime=2026-10-20 01:02:03\n"
        identity = parse_package_identity(value)
        self.assertEqual(identity.uid, 10123)
        with self.assertRaises(RuntimeGateError):
            parse_package_identity(value.replace("userId=10123", ""))

    def test_receipt_requires_every_transaction_fact(self) -> None:
        receipt = {
            "outcome": "passed", "persistentUiAutomationSession": True,
            "productPackage": PRODUCT_PACKAGE, "baselineVersion": BASELINE_VERSION,
            "targetVersion": TARGET_VERSION, "targetSha256": TARGET_SHA256,
            "productPermissionPageObserved": True, "permissionEnabledByTest": True,
            "installerSuccessObserved": True, "installerOpenObserved": True,
            "updatedProductObserved": True, "permissionCleanupObserved": True,
            "failure": None,
        }
        validate_receipt(receipt)
        receipt["installerSuccessObserved"] = False
        with self.assertRaises(RuntimeGateError):
            validate_receipt(receipt)

    def test_admission_locks_all_product_install_routes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            files = [root / name for name in ("baseline.apk", "target.apk", "harness.apk", "test.apk")]
            for index, path in enumerate(files):
                path.write_bytes(bytes([index + 1]))
            adb = AdmittedAdb("adb", "emulator-5554", *files)
            adb.baseline_installed = True
            dispatches: list[tuple[tuple[object, ...], dict[str, object]]] = []

            def fail_on_dispatch(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
                dispatches.append((args, kwargs))
                raise AssertionError("Forbidden admission case reached external ADB dispatch")

            adb._execute = fail_on_dispatch
            forbidden = [
                ["install", str(files[1])],
                ["install-multiple", str(files[1])],
                ["push", "source.bin", "/sdcard/destination.bin"],
                ["sync"],
                ["shell", "pm", "install", "/data/local/tmp/target.apk"],
                ["shell", "cmd", "package", "install-existing", PRODUCT_PACKAGE],
                ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", "content://target.apk"],
            ]
            for command in forbidden:
                with self.assertRaises(RuntimeGateError, msg=str(command)):
                    adb.run(command)
            self.assertEqual(dispatches, [], "Every forbidden command must fail before dispatch")

    def test_scoped_pulls_require_correct_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            files = [root / name for name in ("baseline.apk", "target.apk", "harness.apk", "test.apk")]
            for path in files:
                path.write_bytes(b"x")
            adb = AdmittedAdb("adb", "emulator-5554", *files)
            rejected_dispatches: list[tuple[tuple[object, ...], dict[str, object]]] = []

            def fail_on_dispatch(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
                rejected_dispatches.append((args, kwargs))
                raise AssertionError("Invalid pull state reached external ADB dispatch")

            adb._execute = fail_on_dispatch
            with self.assertRaises(RuntimeGateError):
                adb.pull_baseline_once("/base.apk", root / "pulled.apk")
            with self.assertRaises(RuntimeGateError):
                adb.pull_final_once("/base.apk", root / "final.apk")
            self.assertEqual(rejected_dispatches, [], "Invalid pull states must fail before dispatch")
            adb.baseline_installed = True
            allowed_dispatches: list[tuple[object, ...]] = []

            def successful_dispatch(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
                allowed_dispatches.append(args)
                return subprocess.CompletedProcess(args, 0, "", "")

            adb._execute = successful_dispatch
            adb.pull_baseline_once("/base.apk", root / "pulled.apk")
            adb.mark_installer_success_receipt()
            adb.pull_final_once("/base.apk", root / "final.apk")
            self.assertTrue(adb.baseline_pulled and adb.final_pulled)
            self.assertEqual(len(allowed_dispatches), 2)

    def test_evidence_names_reject_traversal(self) -> None:
        self.assertIsNotNone(SAFE_EVIDENCE_NAME.fullmatch("01-initial-update-consent.png"))
        self.assertIsNone(SAFE_EVIDENCE_NAME.fullmatch("../instrumentation-receipt.json"))
        self.assertIsNone(SAFE_EVIDENCE_NAME.fullmatch("41-too-many.png"))


def run_self_tests(name: str | None) -> int:
    loader = unittest.TestLoader()
    if name:
        suite = loader.loadTestsFromName(f"{__name__}.PolicyTests.{name}")
    else:
        suite = loader.loadTestsFromTestCase(PolicyTests)
    return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", nargs="?", const="", default=None)
    parser.add_argument("--verify-inputs-only", action="store_true")
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--serial")
    parser.add_argument("--apksigner")
    parser.add_argument("--baseline-apk", type=Path)
    parser.add_argument("--target-apk", type=Path)
    parser.add_argument("--target-manifest", type=Path)
    parser.add_argument("--target-verification", type=Path)
    parser.add_argument("--target-checksums", type=Path)
    parser.add_argument("--release-pages", type=Path)
    parser.add_argument("--harness-app", type=Path)
    parser.add_argument("--harness-test", type=Path)
    parser.add_argument("--harness-app-sha256")
    parser.add_argument("--harness-test-sha256")
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--flow-timeout", type=int, default=12 * 60)
    args = parser.parse_args(argv)
    if args.self_test is None:
        required = [
            "baseline_apk", "target_apk", "target_manifest", "target_verification", "target_checksums",
            "release_pages", "evidence",
        ]
        if not args.verify_inputs_only:
            required += [
                "serial", "apksigner", "harness_app", "harness_test",
                "harness_app_sha256", "harness_test_sha256",
            ]
        missing = [name for name in required if getattr(args, name) in {None, ""}]
        if missing:
            parser.error("missing required runtime arguments: " + ", ".join(missing))
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.self_test is not None:
        return run_self_tests(args.self_test or None)
    if args.verify_inputs_only:
        try:
            validate_file(args.baseline_apk, BASELINE_SHA256, BASELINE_SIZE, "baseline APK")
            validate_file(args.target_apk, TARGET_SHA256, TARGET_SIZE, "target APK")
            validate_target_manifest(args.target_manifest)
            validate_target_verification(args.target_verification)
            checksums = parse_checksums(args.target_checksums)
            if checksums["android-update.json"] != sha256_file(args.target_manifest):
                raise RuntimeGateError("SHA256SUMS manifest hash mismatch")
            if checksums[TARGET_VERIFICATION_NAME] != sha256_file(args.target_verification):
                raise RuntimeGateError("SHA256SUMS verification receipt hash mismatch")
            validate_release_pages(args.release_pages, args.target_verification)
            args.evidence.mkdir(parents=True, exist_ok=True)
            (args.evidence / "public-preflight.txt").write_text(
                "publicTarget=2.3.25\npublicPreflight=passed\n"
            )
            return 0
        except Exception as caught:
            print(f"{type(caught).__name__}: {caught}", file=sys.stderr)
            return 1
    error: str | None = None
    try:
        OtaRuntimeDriver(args).run()
        return 0
    except Exception as caught:
        error = f"{type(caught).__name__}: {caught}"
        print(error, file=sys.stderr)
        traceback.print_exc()
        return 1
    finally:
        if args.evidence is not None:
            args.evidence.mkdir(parents=True, exist_ok=True)
            (args.evidence / "host-driver-result.json").write_text(
                json.dumps({"outcome": "failed" if error else "passed", "error": error}, indent=2) + "\n"
            )


if __name__ == "__main__":
    raise SystemExit(main())
