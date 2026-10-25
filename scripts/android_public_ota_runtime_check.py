#!/usr/bin/env python3
"""Host guard for one admitted public native Android OTA transaction.

The target APK is a host-side reference only. After one exact baseline product
install, every product install, push, sync, package-manager install, and direct
installer intent is rejected. One read-only baseline pull and one final pull
after the instrumentation installer-success receipt are admitted explicitly.

The historical 2.3.25 to 2.3.26 binding remains the default. A separate
admission file can bind the reviewed automatic 2.3.27 to strictly post-2.3.30
mode after the official public release exists.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import unittest
from pathlib import Path
from typing import Callable, Sequence

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
STRICT_OTA_MODE = "strict"
LEGACY_MANUAL_RECONSENT_MODE = "legacy-manual-reconsent"
AUTOMATIC_OTA_MODE = "automatic-initial-cancel-due-resume"
FIXED42_AUTOMATIC_OTA_PROFILE = "public-fixed42-to59-initial-cancel-due-resume-v1"
FIXED42_EVIDENCE_SUBDIR = "fixed42-automatic-public-ota-flow"
EVIDENCE_SUBDIR = "persistent-ota-flow"
BASELINE_VERSION = "2.3.25"
BASELINE_CODE = 2_003_025
BASELINE_SHA256 = "4f8cb6defe54e128f01790fafd84b6f3fd545d7c6734458d24543edcfa4bc58b"
BASELINE_SIZE = 88_533_889
BASELINE_SOURCE = "e28c593ed680538dca91c01ac6b993fdc25eb6dd"
TARGET_VERSION = "2.3.26"
TARGET_CODE = 2_003_026
TARGET_SHA256 = "2ad11054cdbb2805a75e06d8d59961e2f43c00c0c2532d02ade3e197ef5e9a3c"
TARGET_SIZE = 88_562_561
TARGET_SOURCE = "21c0509300c8284b41f4cf1bffaabd84da999164"
TARGET_BUILD_RUN = 39_515_566_836
SIGNER_PIN = "233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a"
TARGET_TAG = "android-v2.3.26"
TARGET_APK_NAME = "YAWF.Stream_Android_2.3.26.apk"
TARGET_VERIFICATION_NAME = "Android_2.3.26_verification.json"
AUTOMATIC_BASELINE_VERSION = "2.3.27"
AUTOMATIC_BASELINE_CODE = 2_003_027
AUTOMATIC_BASELINE_SHA256 = "f3e983929db9fb32ed42b9779d94f2f8492c1cf4fae3e0cd29eee91a9492e0eb"
AUTOMATIC_BASELINE_SIZE = 88_558_465
AUTOMATIC_BASELINE_SOURCE = "9fc94a237d99b849cfc18a01085bb487915dd978"
AUTOMATIC_BASELINE_TAG = "android-v2.3.27"
AUTOMATIC_BASELINE_APK_NAME = "YAWF.Stream_Android_2.3.27.apk"
MINIMUM_AUTOMATIC_TARGET_CODE = 2_003_031
FIXED42_BASELINE_VERSION = "2.3.42"
FIXED42_BASELINE_CODE = 2_003_042
FIXED42_BASELINE_SHA256 = "3e1f72c2d1214b491fb505b5ea85ccc507d2478288066ff9cf846c5924d1805c"
FIXED42_BASELINE_SIZE = 88_583_041
FIXED42_BASELINE_SOURCE = "ae9b35f8513c9f7e203508f2c95f1f99d77ddcf5"
FIXED42_BASELINE_MANIFEST_SHA256 = "26fedf40c35011ecf3edaa29462c18f04301dafae7dd9e3808e1ea1e2a3001a8"
FIXED42_BASELINE_VERIFICATION_SHA256 = "a87360645d7700f7c2ff9a99629d714b7d126fbe5d66a9a2e44a10baad42c4dc"
FIXED42_BASELINE_BUILD_RUN = 40_025_606_020
FIXED42_TARGET_VERSION = "2.3.59"
FIXED42_TARGET_CODE = 2_003_059
FIXED42_TARGET_SHA256 = "5fe550e66658f3c9ae172c087c656d69e126af2892df05ca15e7e021594dae47"
FIXED42_TARGET_SIZE = 88_644_481
FIXED42_TARGET_SOURCE = "ac885bb98b2672614beb801b5aea11eb2f98ab40"
FIXED42_TARGET_BUILD_RUN = 40_169_716_770
FIXED42_TARGET_MANIFEST_SHA256 = "8d0f680abc7d52cd467ef79b3fd860e18c7e1dd15a7c5fd765a9d3941c974af6"
FIXED42_TARGET_VERIFICATION_SHA256 = "28ccb986f613b68917a907b5dd9632c02e98185413ce9d09bc745eb564541294"
FIXED42_UPDATER_SHA256 = "129df15e095ed5ce8933d17ab9a0329da79244e14ac046df18c3fad32e01163d"
EMERGENCY_36_VERSION = "2.3.36"
EMERGENCY_36_CODE = 2_003_036
EMERGENCY_36_SOURCE = "b9f51773232fa546ed3a95ec3e9169780f7df244"
EMERGENCY_36_PRODUCER_RUN = 39_917_780_677
EMERGENCY_36_SOURCE_CI_RUN = 39_917_164_434
EMERGENCY_36_APK_SHA256 = "b6109604b1bc0bb7db87ed79402da7356011caab48833ac2d07eb4cede4dfe11"
EMERGENCY_36_APK_SIZE = 88_578_945
EMERGENCY_36_MANIFEST_SHA256 = "82cf99df55ebc766da645f16ac76d7dd7f5f7d06671cdc78d65318595e326b95"
EMERGENCY_36_VERIFICATION_SHA256 = "fa7eb7dc02f30594ceceb03a8c86aa2ccde35ed6228c2b243b83ecae44667d1c"
EMERGENCY_36_VERIFIED_AT = "2026-10-23T07:55:43.417811+00:00"
EMERGENCY_36_SCOPE = (
    "Emergency canonical episode-guide and continuation-identity fix. "
    "Separate from pending player stabilization37."
)
STANDARD_VERIFICATION_KEYS = frozenset({
    "version", "sourceRevision", "buildRun", "apk", "certificateSha256",
    "checks", "pending", "limits",
})
EMERGENCY_VERIFICATION_KEYS = frozenset({
    "schemaVersion", "version", "versionCode", "packageName", "sourceRevision",
    "exactSourceCiRun", "producerRun", "apk", "signerSha256",
    "offlineSignatureManifestAbiPayloadAndAlignment", "nativeRuntime",
    "episodeVerification", "verifiedAt", "scope",
})
URL_RE = re.compile(r"https?://[^\s\]\[\"'<>]+", re.IGNORECASE)
MAX_HOST_EVIDENCE_BYTES = 2 * 1024 * 1024
BOUNDED_DIAGNOSTIC_STDOUT_NAMES = frozenset(
    {"logcat.txt", "dropbox-anr.txt", "dropbox-crash.txt"}
)
DIAGNOSTIC_TRUNCATION_MARKER = (
    "\n...[middle of redacted diagnostic omitted by UTF-8 byte bound]...\n"
)
SAFE_EVIDENCE_NAME = re.compile(
    r"(?:0[1-9]|[12][0-9]|3[0-9]|40)-[a-z0-9-]+\.(?:png|xml)|"
    r"actions\.txt|instrumentation-receipt\.json"
)


class RuntimeGateError(RuntimeError):
    pass


@dataclasses.dataclass(frozen=True)
class RuntimeBinding:
    automatic: bool
    ota_mode: str
    evidence_subdir: str
    baseline_version: str
    baseline_code: int
    baseline_sha256: str
    baseline_size: int
    baseline_source: str
    baseline_tag: str
    baseline_apk_name: str
    target_version: str
    target_code: int
    target_sha256: str
    target_size: int
    target_source: str
    target_build_run: int
    target_tag: str
    target_apk_name: str
    target_verification_name: str
    signer_pin: str
    target_manifest_sha256: str | None = None
    target_verification_sha256: str | None = None
    profile: str | None = None
    baseline_manifest_sha256: str | None = None
    baseline_verification_sha256: str | None = None
    baseline_build_run: int | None = None
    updater_source_sha256: str | None = None


LEGACY_BINDING = RuntimeBinding(
    automatic=False,
    ota_mode=STRICT_OTA_MODE,
    evidence_subdir=EVIDENCE_SUBDIR,
    baseline_version=BASELINE_VERSION,
    baseline_code=BASELINE_CODE,
    baseline_sha256=BASELINE_SHA256,
    baseline_size=BASELINE_SIZE,
    baseline_source=BASELINE_SOURCE,
    baseline_tag="android-v2.3.25",
    baseline_apk_name="YAWF.Stream_Android_2.3.25.apk",
    target_version=TARGET_VERSION,
    target_code=TARGET_CODE,
    target_sha256=TARGET_SHA256,
    target_size=TARGET_SIZE,
    target_source=TARGET_SOURCE,
    target_build_run=TARGET_BUILD_RUN,
    target_tag=TARGET_TAG,
    target_apk_name=TARGET_APK_NAME,
    target_verification_name=TARGET_VERIFICATION_NAME,
    signer_pin=SIGNER_PIN,
)


def _exact_string(value: object, pattern: str, label: str) -> str:
    if not isinstance(value, str) or re.fullmatch(pattern, value) is None:
        raise RuntimeGateError(f"Automatic admission {label} is invalid")
    return value


def _decimal_string(value: object, label: str) -> int:
    if not isinstance(value, str) or re.fullmatch(r"[1-9]\d*", value) is None:
        raise RuntimeGateError(f"Automatic admission {label} is invalid")
    parsed = int(value)
    if parsed > 9_007_199_254_740_991:
        raise RuntimeGateError(f"Automatic admission {label} is outside the safe range")
    return parsed


def _load_fixed42_automatic_binding(value: object) -> RuntimeBinding:
    """Load the exact output of the separately named fixed 2.3.42 to 2.3.59 admission."""
    expected = {
        "profile": FIXED42_AUTOMATIC_OTA_PROFILE,
        "evidenceSubdir": FIXED42_EVIDENCE_SUBDIR,
        "otaMode": FIXED42_AUTOMATIC_OTA_PROFILE,
        "baselineVersion": FIXED42_BASELINE_VERSION,
        "baselineVersionCode": str(FIXED42_BASELINE_CODE),
        "baselineTag": "android-v2.3.42",
        "baselineApkName": "YAWF.Stream_Android_2.3.42.apk",
        "baselineSha256": FIXED42_BASELINE_SHA256,
        "baselineSize": str(FIXED42_BASELINE_SIZE),
        "baselineSourceRevision": FIXED42_BASELINE_SOURCE,
        "baselineManifestSha256": FIXED42_BASELINE_MANIFEST_SHA256,
        "baselineVerificationSha256": FIXED42_BASELINE_VERIFICATION_SHA256,
        "baselineBuildRun": str(FIXED42_BASELINE_BUILD_RUN),
        "targetVersion": FIXED42_TARGET_VERSION,
        "targetVersionCode": str(FIXED42_TARGET_CODE),
        "targetTag": "android-v2.3.59",
        "targetApkName": "YAWF.Stream_Android_2.3.59.apk",
        "targetSha256": FIXED42_TARGET_SHA256,
        "targetSize": str(FIXED42_TARGET_SIZE),
        "signerSha256": SIGNER_PIN,
        "targetSourceRevision": FIXED42_TARGET_SOURCE,
        "targetManifestSha256": FIXED42_TARGET_MANIFEST_SHA256,
        "targetVerificationSha256": FIXED42_TARGET_VERIFICATION_SHA256,
        "targetBuildRun": str(FIXED42_TARGET_BUILD_RUN),
        "updaterSourceSha256": FIXED42_UPDATER_SHA256,
        "targetPublicRelease": "true",
    }
    if not isinstance(value, dict) or set(value) != set(expected):
        raise RuntimeGateError("Fixed42 automatic admission keys are not exact")
    for key, wanted in expected.items():
        if value.get(key) != wanted:
            raise RuntimeGateError(f"Fixed42 automatic admission {key} mismatch")
    return RuntimeBinding(
        automatic=True,
        ota_mode=FIXED42_AUTOMATIC_OTA_PROFILE,
        evidence_subdir=FIXED42_EVIDENCE_SUBDIR,
        baseline_version=FIXED42_BASELINE_VERSION,
        baseline_code=FIXED42_BASELINE_CODE,
        baseline_sha256=FIXED42_BASELINE_SHA256,
        baseline_size=FIXED42_BASELINE_SIZE,
        baseline_source=FIXED42_BASELINE_SOURCE,
        baseline_tag="android-v2.3.42",
        baseline_apk_name="YAWF.Stream_Android_2.3.42.apk",
        target_version=FIXED42_TARGET_VERSION,
        target_code=FIXED42_TARGET_CODE,
        target_sha256=FIXED42_TARGET_SHA256,
        target_size=FIXED42_TARGET_SIZE,
        target_source=FIXED42_TARGET_SOURCE,
        target_build_run=FIXED42_TARGET_BUILD_RUN,
        target_tag="android-v2.3.59",
        target_apk_name="YAWF.Stream_Android_2.3.59.apk",
        target_verification_name="Android_2.3.59_verification.json",
        signer_pin=SIGNER_PIN,
        target_manifest_sha256=FIXED42_TARGET_MANIFEST_SHA256,
        target_verification_sha256=FIXED42_TARGET_VERIFICATION_SHA256,
        profile=FIXED42_AUTOMATIC_OTA_PROFILE,
        baseline_manifest_sha256=FIXED42_BASELINE_MANIFEST_SHA256,
        baseline_verification_sha256=FIXED42_BASELINE_VERIFICATION_SHA256,
        baseline_build_run=FIXED42_BASELINE_BUILD_RUN,
        updater_source_sha256=FIXED42_UPDATER_SHA256,
    )


def load_automatic_binding(path: Path) -> RuntimeBinding:
    """Load only the exact output of admitAutomaticPublicTuple."""
    if not path.is_file() or path.stat().st_size > 16 * 1024:
        raise RuntimeGateError("Automatic admission file is missing or oversized")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeGateError("Automatic admission file is invalid JSON") from error
    if isinstance(value, dict) and value.get("profile") == FIXED42_AUTOMATIC_OTA_PROFILE:
        return _load_fixed42_automatic_binding(value)
    expected_keys = {
        "evidenceSubdir", "otaMode", "baselineVersion", "baselineVersionCode",
        "baselineSha256", "baselineSize", "targetVersion", "targetVersionCode",
        "targetApkName", "targetSha256", "targetSize", "signerSha256",
        "targetSourceRevision", "targetManifestSha256", "targetVerificationSha256",
        "targetBuildRun", "targetPublicRelease",
    }
    if not isinstance(value, dict) or set(value) != expected_keys:
        raise RuntimeGateError("Automatic admission keys are not exact")
    fixed = {
        "evidenceSubdir": "automatic-public-ota-flow",
        "otaMode": AUTOMATIC_OTA_MODE,
        "baselineVersion": AUTOMATIC_BASELINE_VERSION,
        "baselineVersionCode": str(AUTOMATIC_BASELINE_CODE),
        "baselineSha256": AUTOMATIC_BASELINE_SHA256,
        "baselineSize": str(AUTOMATIC_BASELINE_SIZE),
        "signerSha256": SIGNER_PIN,
        "targetPublicRelease": "true",
    }
    for key, expected in fixed.items():
        if value.get(key) != expected:
            raise RuntimeGateError(f"Automatic admission {key} mismatch")
    target_version = _exact_string(
        value.get("targetVersion"), r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)",
        "targetVersion",
    )
    components = [int(part) for part in target_version.split(".")]
    if any(part > 999 for part in components):
        raise RuntimeGateError("Automatic admission targetVersion component is too large")
    target_code = _decimal_string(value.get("targetVersionCode"), "targetVersionCode")
    mapped_code = components[0] * 1_000_000 + components[1] * 1_000 + components[2]
    if target_code != mapped_code or target_code < MINIMUM_AUTOMATIC_TARGET_CODE:
        raise RuntimeGateError("Automatic admission target version/code is not strictly post-2.3.30")
    target_apk_name = f"YAWF.Stream_Android_{target_version}.apk"
    if value.get("targetApkName") != target_apk_name:
        raise RuntimeGateError("Automatic admission target APK name mismatch")
    target_sha256 = _exact_string(
        value.get("targetSha256"), r"[0-9a-f]{64}", "targetSha256"
    )
    if target_sha256 == AUTOMATIC_BASELINE_SHA256:
        raise RuntimeGateError("Automatic admission target APK equals the baseline")
    target_size = _decimal_string(value.get("targetSize"), "targetSize")
    target_source = _exact_string(
        value.get("targetSourceRevision"), r"[0-9a-f]{40}", "targetSourceRevision"
    )
    target_build_run = _decimal_string(value.get("targetBuildRun"), "targetBuildRun")
    target_manifest_sha256 = _exact_string(
        value.get("targetManifestSha256"), r"[0-9a-f]{64}", "targetManifestSha256"
    )
    target_verification_sha256 = _exact_string(
        value.get("targetVerificationSha256"), r"[0-9a-f]{64}",
        "targetVerificationSha256",
    )
    if target_version == EMERGENCY_36_VERSION:
        exact_emergency = {
            "targetCode": (target_code, EMERGENCY_36_CODE),
            "targetSha256": (target_sha256, EMERGENCY_36_APK_SHA256),
            "targetSize": (target_size, EMERGENCY_36_APK_SIZE),
            "targetSourceRevision": (target_source, EMERGENCY_36_SOURCE),
            "targetBuildRun": (target_build_run, EMERGENCY_36_PRODUCER_RUN),
            "targetManifestSha256": (
                target_manifest_sha256, EMERGENCY_36_MANIFEST_SHA256
            ),
            "targetVerificationSha256": (
                target_verification_sha256, EMERGENCY_36_VERIFICATION_SHA256
            ),
        }
        for label, (actual, expected) in exact_emergency.items():
            if actual != expected:
                raise RuntimeGateError(f"Automatic emergency 2.3.36 {label} mismatch")
    return RuntimeBinding(
        automatic=True,
        ota_mode=AUTOMATIC_OTA_MODE,
        evidence_subdir="automatic-public-ota-flow",
        baseline_version=AUTOMATIC_BASELINE_VERSION,
        baseline_code=AUTOMATIC_BASELINE_CODE,
        baseline_sha256=AUTOMATIC_BASELINE_SHA256,
        baseline_size=AUTOMATIC_BASELINE_SIZE,
        baseline_source=AUTOMATIC_BASELINE_SOURCE,
        baseline_tag=AUTOMATIC_BASELINE_TAG,
        baseline_apk_name=AUTOMATIC_BASELINE_APK_NAME,
        target_version=target_version,
        target_code=target_code,
        target_sha256=target_sha256,
        target_size=target_size,
        target_source=target_source,
        target_build_run=target_build_run,
        target_tag=f"android-v{target_version}",
        target_apk_name=target_apk_name,
        target_verification_name=f"Android_{target_version}_verification.json",
        signer_pin=SIGNER_PIN,
        target_manifest_sha256=target_manifest_sha256,
        target_verification_sha256=target_verification_sha256,
    )


def require_successful_observation(
    result: subprocess.CompletedProcess[str], label: str
) -> None:
    if result.returncode != 0 or result.stderr.strip():
        raise RuntimeGateError(f"{label} QA observation was unavailable")


def validate_unknown_source_observation(result: subprocess.CompletedProcess[str]) -> None:
    require_successful_observation(result, "Unknown-source app-op")
    output = result.stdout.strip()
    if output == "No operations.\nDefault mode: default":
        return
    match = re.fullmatch(
        r"REQUEST_INSTALL_PACKAGES:\s*(allow|default|ignore|deny|errored)(?:;[^\r\n]*)?",
        output,
        re.IGNORECASE,
    )
    if match is None:
        raise RuntimeGateError("Unknown-source app-op QA observation was unrecognized")
    if match.group(1).casefold() == "allow":
        raise RuntimeGateError("YAWF unknown-source access remained allowed")


def validate_no_residual_update_apks(result: subprocess.CompletedProcess[str]) -> None:
    require_successful_observation(result, "Residual update-file")
    if result.stdout.strip():
        raise RuntimeGateError("External update APK remained after relaunch cleanup")


def validate_logcat_observation(result: subprocess.CompletedProcess[str]) -> None:
    require_successful_observation(result, "Logcat")
    if re.search(
        r"(?m)^(?:--------- beginning of \S+|\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\s+)",
        result.stdout,
    ) is None:
        raise RuntimeGateError("Logcat QA observation was empty or unrecognized")


def validate_dropbox_observation(
    result: subprocess.CompletedProcess[str], tag: str
) -> None:
    require_successful_observation(result, f"Dropbox {tag}")
    output = result.stdout
    header = re.search(r"(?m)^Drop box contents: \d+ entries$", output)
    search = re.search(rf"(?m)^Searching for: {re.escape(tag)}$", output)
    if header is None or search is None or not output[search.end():].strip():
        raise RuntimeGateError(f"Dropbox {tag} QA observation was empty or unrecognized")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def redact(value: str) -> str:
    return URL_RE.sub("<redacted-url>", value).replace("\r", "")


def bounded_diagnostic_retention(
    value: str, limit: int = MAX_HOST_EVIDENCE_BYTES
) -> tuple[str, dict[str, object]]:
    """Redact, then retain UTF-8-safe head and tail diagnostic evidence."""
    raw_bytes = value.encode("utf-8")
    redacted_bytes = redact(value).encode("utf-8")
    marker_bytes = b""
    if len(redacted_bytes) <= limit:
        retained_bytes = redacted_bytes
        retained_source_bytes = len(redacted_bytes)
        strategy = "full-redacted-utf8"
        truncated = False
    else:
        marker_bytes = DIAGNOSTIC_TRUNCATION_MARKER.encode("utf-8")
        if len(marker_bytes) >= limit:
            raise RuntimeGateError("Diagnostic byte bound is too small")
        source_budget = limit - len(marker_bytes)
        head_budget = source_budget // 2
        tail_budget = source_budget - head_budget
        head = redacted_bytes[:head_budget].decode("utf-8", "ignore").encode("utf-8")
        tail = redacted_bytes[-tail_budget:].decode("utf-8", "ignore").encode("utf-8")
        retained_bytes = head + marker_bytes + tail
        retained_source_bytes = len(head) + len(tail)
        strategy = "utf8-safe-head-tail-after-redaction"
        truncated = True

    receipt: dict[str, object] = {
        "rawOriginalUtf8Bytes": len(raw_bytes),
        "rawOriginalSha256": hashlib.sha256(raw_bytes).hexdigest(),
        "redactedUtf8Bytes": len(redacted_bytes),
        "retainedSourceUtf8Bytes": retained_source_bytes,
        "markerUtf8Bytes": len(marker_bytes),
        "storedUtf8Bytes": len(retained_bytes),
        "omittedRedactedUtf8Bytes": len(redacted_bytes) - retained_source_bytes,
        "truncated": truncated,
        "strategy": strategy,
    }
    if (
        len(retained_bytes) > limit
        or receipt["retainedSourceUtf8Bytes"] + receipt["markerUtf8Bytes"]
        != receipt["storedUtf8Bytes"]
        or receipt["retainedSourceUtf8Bytes"] + receipt["omittedRedactedUtf8Bytes"]
        != receipt["redactedUtf8Bytes"]
    ):
        raise RuntimeGateError("Diagnostic retention invariant failed")
    return retained_bytes.decode("utf-8", "strict"), receipt


def subprocess_output_text(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value


def retain_diagnostic_stream(
    evidence: Path, stem: str, stream: str, value: str
) -> dict[str, object]:
    retained, receipt = bounded_diagnostic_retention(value)
    (evidence / f"{stem}-{stream}.txt").write_text(retained, encoding="utf-8")
    (evidence / f"{stem}-{stream}-retention.json").write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return receipt


def observe_host_command(args: Sequence[str], timeout: float) -> tuple[dict[str, object], str, str]:
    started = time.monotonic()
    try:
        result = subprocess.run(
            list(args), capture_output=True, timeout=timeout, check=False, text=True
        )
        stdout = subprocess_output_text(result.stdout)
        stderr = subprocess_output_text(result.stderr)
        return ({
            "returnCode": result.returncode,
            "timedOut": False,
            "elapsedMilliseconds": round((time.monotonic() - started) * 1000),
        }, stdout, stderr)
    except subprocess.TimeoutExpired as error:
        return ({
            "returnCode": None,
            "timedOut": True,
            "elapsedMilliseconds": round((time.monotonic() - started) * 1000),
        }, subprocess_output_text(error.stdout), subprocess_output_text(error.stderr))
    except OSError as error:
        return ({
            "returnCode": None,
            "timedOut": False,
            "elapsedMilliseconds": round((time.monotonic() - started) * 1000),
            "dispatchError": type(error).__name__,
        }, "", str(error))


def collect_fixed42_host_failure_diagnostics(
    *,
    evidence: Path,
    adb: str,
    serial: str,
    emulator_pid: str,
    emulator_pid_liveness: str,
    emulator_exit_status: str,
    runner_temp: Path,
    workspace: Path,
) -> dict[str, object]:
    """Retain bounded host health without changing ADB or emulator state."""
    evidence.mkdir(parents=True, exist_ok=True)
    if emulator_pid and (not emulator_pid.isdigit() or int(emulator_pid) <= 0):
        raise RuntimeGateError("Owned emulator PID diagnostic is invalid")
    if emulator_pid_liveness not in {"not-started", "alive", "dead"}:
        raise RuntimeGateError("Owned emulator liveness diagnostic is invalid")
    if not (
        emulator_exit_status in {"not-started", "not-exited"}
        or emulator_exit_status.isdigit()
    ):
        raise RuntimeGateError("Owned emulator exit-status diagnostic is invalid")

    report: dict[str, object] = {
        "schemaVersion": 1,
        "profile": FIXED42_AUTOMATIC_OTA_PROFILE,
        "ownedEmulator": {
            "pid": int(emulator_pid) if emulator_pid else None,
            "liveness": emulator_pid_liveness,
            "exitStatus": (
                int(emulator_exit_status)
                if emulator_exit_status.isdigit()
                else emulator_exit_status
            ),
        },
        "filesystem": {},
        "memoryKiB": {"MemAvailable": None, "MemFree": None, "SwapFree": None},
        "adb": {},
        "diagnosticErrors": [],
    }
    errors = report["diagnosticErrors"]
    assert isinstance(errors, list)

    filesystems = report["filesystem"]
    assert isinstance(filesystems, dict)
    for label, path in (("runnerTemp", runner_temp), ("workspace", workspace)):
        try:
            stats = os.statvfs(path)
            filesystems[label] = {
                "availableBytes": stats.f_bavail * stats.f_frsize,
                "availableInodes": stats.f_favail,
            }
        except OSError as error:
            filesystems[label] = {
                "availableBytes": None,
                "availableInodes": None,
                "observationError": type(error).__name__,
            }
            errors.append(f"filesystem:{label}:{type(error).__name__}")

    memory = report["memoryKiB"]
    assert isinstance(memory, dict)
    try:
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            key, separator, rest = line.partition(":")
            if separator and key in {"MemAvailable", "MemFree", "SwapFree"}:
                match = re.fullmatch(r"\s*(\d+)\s+kB\s*", rest)
                if match is not None:
                    memory[key] = int(match.group(1))
        for key in ("MemAvailable", "MemFree", "SwapFree"):
            if memory[key] is None:
                errors.append(f"memory:{key}:unavailable")
    except OSError as error:
        errors.append(f"memory:read:{type(error).__name__}")

    resolved_value = shutil.which(adb) if not Path(adb).is_absolute() else adb
    resolved_adb = Path(resolved_value).resolve() if resolved_value else None
    adb_report = report["adb"]
    assert isinstance(adb_report, dict)
    adb_report["requestedPath"] = adb
    adb_report["resolvedPath"] = str(resolved_adb) if resolved_adb else None
    if resolved_adb is None or not resolved_adb.is_file() or not os.access(resolved_adb, os.X_OK):
        adb_report["executableAvailable"] = False
        adb_report["executableSha256"] = None
        errors.append("adb:executable:unavailable")
        for stem in ("workflow-adb-version", "workflow-adb-get-state"):
            retain_diagnostic_stream(evidence, stem, "stdout", "")
            retain_diagnostic_stream(evidence, stem, "stderr", "ADB executable unavailable\n")
            adb_report["version" if stem.endswith("version") else "getState"] = {
                "returnCode": None,
                "timedOut": False,
                "elapsedMilliseconds": 0,
                "dispatched": False,
            }
    else:
        adb_report["executableAvailable"] = True
        try:
            adb_report["executableSha256"] = sha256_file(resolved_adb)
        except OSError as error:
            adb_report["executableSha256"] = None
            errors.append(f"adb:sha256:{type(error).__name__}")
        for key, stem, command in (
            ("version", "workflow-adb-version", [str(resolved_adb), "version"]),
            (
                "getState", "workflow-adb-get-state",
                [str(resolved_adb), "-s", serial, "get-state"],
            ),
        ):
            observation, stdout, stderr = observe_host_command(command, 5)
            observation["dispatched"] = True
            observation["stdoutRetention"] = retain_diagnostic_stream(
                evidence, stem, "stdout", stdout
            )
            observation["stderrRetention"] = retain_diagnostic_stream(
                evidence, stem, "stderr", stderr
            )
            adb_report[key] = observation

    (evidence / "workflow-host-diagnostics.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return report


def fixed42_device_capture_available(evidence: Path) -> bool:
    """Admit failure-time device reads only from one complete bounded get-state receipt."""
    try:
        def bounded_bytes(name: str, limit: int) -> bytes:
            path = evidence / name
            if not path.is_file():
                raise RuntimeGateError(f"Missing {name}")
            with path.open("rb") as stream:
                value = stream.read(limit + 1)
            if len(value) > limit:
                raise RuntimeGateError(f"Oversized {name}")
            return value

        report_bytes = bounded_bytes("workflow-host-diagnostics.json", 64 * 1024)
        receipt_bytes = bounded_bytes(
            "workflow-adb-get-state-stdout-retention.json", 64 * 1024
        )
        stdout_bytes = bounded_bytes(
            "workflow-adb-get-state-stdout.txt", MAX_HOST_EVIDENCE_BYTES
        )
        report = json.loads(report_bytes.decode("utf-8", "strict"))
        receipt = json.loads(receipt_bytes.decode("utf-8", "strict"))
        if not isinstance(report, dict) or not isinstance(receipt, dict):
            return False
        if report.get("profile") != FIXED42_AUTOMATIC_OTA_PROFILE:
            return False
        adb = report.get("adb")
        get_state = adb.get("getState") if isinstance(adb, dict) else None
        if not isinstance(get_state, dict):
            return False
        if (
            type(get_state.get("returnCode")) is not int
            or get_state["returnCode"] != 0
            or get_state.get("timedOut") is not False
            or get_state.get("dispatched") is not True
            or get_state.get("stdoutRetention") != receipt
            or stdout_bytes != b"device\n"
        ):
            return False
        expected_size = len(stdout_bytes)
        return (
            receipt.get("truncated") is False
            and receipt.get("strategy") == "full-redacted-utf8"
            and type(receipt.get("rawOriginalUtf8Bytes")) is int
            and receipt["rawOriginalUtf8Bytes"] == expected_size
            and receipt.get("rawOriginalSha256") == hashlib.sha256(stdout_bytes).hexdigest()
            and type(receipt.get("redactedUtf8Bytes")) is int
            and receipt["redactedUtf8Bytes"] == expected_size
            and type(receipt.get("retainedSourceUtf8Bytes")) is int
            and receipt["retainedSourceUtf8Bytes"] == expected_size
            and receipt.get("markerUtf8Bytes") == 0
            and receipt.get("storedUtf8Bytes") == expected_size
            and receipt.get("omittedRedactedUtf8Bytes") == 0
        )
    except (
        OSError, UnicodeError, json.JSONDecodeError, RuntimeGateError,
        RecursionError, TypeError,
    ):
        return False


def validate_file(path: Path, expected_hash: str, expected_size: int, label: str) -> None:
    if not path.is_file() or path.stat().st_size != expected_size:
        raise RuntimeGateError(f"{label} size mismatch")
    if sha256_file(path) != expected_hash:
        raise RuntimeGateError(f"{label} SHA-256 mismatch")


def validate_target_manifest(
    path: Path, binding: RuntimeBinding = LEGACY_BINDING
) -> dict[str, object]:
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
        "version": binding.target_version,
        "versionCode": binding.target_code,
        "packageName": PRODUCT_PACKAGE,
        "sourceRevision": binding.target_source,
    }
    for key, expected_value in expected.items():
        if type(value.get(key)) is not type(expected_value) or value.get(key) != expected_value:
            raise RuntimeGateError(f"Target manifest {key} mismatch")
    if apk != {
        "name": binding.target_apk_name,
        "sha256": binding.target_sha256,
        "size": binding.target_size,
    }:
        raise RuntimeGateError("Target manifest APK identity mismatch")
    if binding.target_manifest_sha256 is not None:
        validate_file(
            path, binding.target_manifest_sha256, path.stat().st_size, "target manifest"
        )
    return value


def validate_target_verification(
    path: Path, binding: RuntimeBinding = LEGACY_BINDING
) -> dict[str, object]:
    if not path.is_file() or path.stat().st_size > 64 * 1024:
        raise RuntimeGateError("Target verification receipt is missing or oversized")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeGateError("Target verification receipt is invalid JSON") from error
    if not isinstance(value, dict):
        raise RuntimeGateError("Target verification receipt keys are not exact")
    if set(value) == EMERGENCY_VERIFICATION_KEYS:
        if not binding.automatic or binding.target_version != EMERGENCY_36_VERSION:
            raise RuntimeGateError("Emergency verification schema is not admitted for this target")
        expected_root = {
            "schemaVersion": 1,
            "version": EMERGENCY_36_VERSION,
            "versionCode": EMERGENCY_36_CODE,
            "packageName": PRODUCT_PACKAGE,
            "sourceRevision": EMERGENCY_36_SOURCE,
            "exactSourceCiRun": EMERGENCY_36_SOURCE_CI_RUN,
            "producerRun": EMERGENCY_36_PRODUCER_RUN,
            "signerSha256": binding.signer_pin,
            "offlineSignatureManifestAbiPayloadAndAlignment": "passed verify_android_apk.py",
            "verifiedAt": EMERGENCY_36_VERIFIED_AT,
            "scope": EMERGENCY_36_SCOPE,
        }
        for key, expected in expected_root.items():
            if type(value.get(key)) is not type(expected) or value.get(key) != expected:
                raise RuntimeGateError(f"Emergency target verification {key} mismatch")
        expected_apk = {
            "name": binding.target_apk_name,
            "sha256": EMERGENCY_36_APK_SHA256,
            "size": EMERGENCY_36_APK_SIZE,
        }
        if value.get("apk") != expected_apk:
            raise RuntimeGateError("Emergency target verification APK identity mismatch")
        expected_native_runtime = {
            "abi": "arm64-v8a",
            "api": 36,
            "automaticOtaTransactionProven": False,
            "completeSetupAndNativeManualUpdater": "pass",
            "exactInstalledApkHash": "pass",
            "freshOwnedEmulator": True,
            "passed": True,
            "physicalDeviceProof": False,
            "webviewMajor": 133,
        }
        if value.get("nativeRuntime") != expected_native_runtime:
            raise RuntimeGateError("Emergency target native runtime state mismatch")
        expected_episode_verification = {
            "allPlatformVerificationComplete": False,
            "canonicalGuideAndSourceRegressionTests": "passed exact source CI",
            "productionServer36Tybw17E1FileDecode": (
                "The Blood Warfare,524decodedframes,0dropped"
            ),
            "standaloneConfiguredGuideRuntime": (
                "not run without metadata credential in account-free emulator"
            ),
        }
        if value.get("episodeVerification") != expected_episode_verification:
            raise RuntimeGateError("Emergency target episode verification state mismatch")
        exact_binding = {
            "versionCode": (binding.target_code, EMERGENCY_36_CODE),
            "sourceRevision": (binding.target_source, EMERGENCY_36_SOURCE),
            "producerRun": (binding.target_build_run, EMERGENCY_36_PRODUCER_RUN),
            "apkSha256": (binding.target_sha256, EMERGENCY_36_APK_SHA256),
            "apkSize": (binding.target_size, EMERGENCY_36_APK_SIZE),
            "manifestSha256": (
                binding.target_manifest_sha256, EMERGENCY_36_MANIFEST_SHA256
            ),
            "verificationSha256": (
                binding.target_verification_sha256, EMERGENCY_36_VERIFICATION_SHA256
            ),
        }
        for label, (actual, expected) in exact_binding.items():
            if actual != expected:
                raise RuntimeGateError(f"Emergency target binding {label} mismatch")
        validate_file(
            path,
            EMERGENCY_36_VERIFICATION_SHA256,
            path.stat().st_size,
            "emergency target verification receipt",
        )
        return value
    if set(value) != STANDARD_VERIFICATION_KEYS:
        raise RuntimeGateError("Target verification receipt keys are not exact")
    if not binding.automatic:
        if value.get("version") != TARGET_VERSION or value.get("sourceRevision") != TARGET_SOURCE:
            raise RuntimeGateError("Target verification version/source mismatch")
    elif (value.get("version") != binding.target_version
          or value.get("sourceRevision") != binding.target_source):
        raise RuntimeGateError("Target verification version/source mismatch")
    build_run = value.get("buildRun")
    if not binding.automatic:
        if type(build_run) is not int or build_run != TARGET_BUILD_RUN:
            raise RuntimeGateError("Target verification build run is invalid")
    elif type(build_run) is not int or build_run != binding.target_build_run:
        raise RuntimeGateError("Target verification build run is invalid")
    if value.get("apk") != {
        "name": binding.target_apk_name,
        "sha256": binding.target_sha256,
        "size": binding.target_size,
    }:
        raise RuntimeGateError("Target verification APK identity mismatch")
    if value.get("certificateSha256") != binding.signer_pin:
        raise RuntimeGateError("Target verification signer mismatch")
    if not isinstance(value.get("checks"), dict) or not value["checks"]:
        raise RuntimeGateError("Target verification checks are missing")
    if binding.automatic:
        provenance = value["checks"].get("buildProvenance")
        if not isinstance(provenance, dict) or provenance.get("workflowRun") != binding.target_build_run:
            raise RuntimeGateError("Target verification provenance run mismatch")
        if provenance.get("sourceRevision") != binding.target_source:
            raise RuntimeGateError("Target verification provenance source mismatch")
        if provenance.get("canonicalSignedCandidateUnchanged") is not True:
            raise RuntimeGateError("Target verification canonical candidate state mismatch")
    for name in ("pending", "limits"):
        entries = value.get(name)
        if (not isinstance(entries, list) or len(entries) > 32
                or any(not isinstance(entry, str) or not entry for entry in entries)):
            raise RuntimeGateError(f"Target verification {name} is invalid")
    if binding.target_verification_sha256 is not None:
        validate_file(
            path, binding.target_verification_sha256, path.stat().st_size,
            "target verification receipt",
        )
    return value


def parse_checksums(
    path: Path, binding: RuntimeBinding = LEGACY_BINDING
) -> dict[str, str]:
    if not path.is_file() or path.stat().st_size > 16 * 1024:
        raise RuntimeGateError("SHA256SUMS is missing or oversized")
    result: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9._-]+)", line)
        if match is None or match.group(2) in result:
            raise RuntimeGateError("SHA256SUMS has an invalid or duplicate row")
        result[match.group(2)] = match.group(1)
    if not binding.automatic:
        if set(result) != {TARGET_APK_NAME, "android-update.json", TARGET_VERIFICATION_NAME}:
            raise RuntimeGateError("SHA256SUMS asset set is not exact")
        if result[TARGET_APK_NAME] != TARGET_SHA256:
            raise RuntimeGateError("SHA256SUMS target APK hash mismatch")
    else:
        if set(result) != {
            binding.target_apk_name, "android-update.json", binding.target_verification_name
        }:
            raise RuntimeGateError("SHA256SUMS asset set is not exact")
        if result[binding.target_apk_name] != binding.target_sha256:
            raise RuntimeGateError("SHA256SUMS target APK hash mismatch")
    return result


def _ordered_release_pages(paths: Sequence[Path]) -> list[Path]:
    """Admit only canonical, unique, contiguous page-1.json through page-10.json."""
    if not paths or len(paths) > 10:
        raise RuntimeGateError("Release history page count is outside bounds")
    numbered: dict[int, Path] = {}
    for page in paths:
        match = re.fullmatch(r"page-(\d+)\.json", page.name)
        if match is None:
            raise RuntimeGateError("Release history page identity is invalid")
        number = int(match.group(1))
        if page.name != f"page-{number}.json" or not 1 <= number <= 10:
            raise RuntimeGateError("Release history page identity is invalid")
        if number in numbered:
            raise RuntimeGateError("Release history page number is duplicated")
        numbered[number] = page
    if sorted(numbered) != list(range(1, len(numbered) + 1)):
        raise RuntimeGateError("Release history pages are not contiguous")
    return [numbered[number] for number in range(1, len(numbered) + 1)]


def validate_release_pages(
    directory: Path,
    verification_path: Path,
    binding: RuntimeBinding = LEGACY_BINDING,
    *,
    baseline_path: Path | None = None,
    manifest_path: Path | None = None,
    checksums_path: Path | None = None,
) -> dict[str, object]:
    pages = _ordered_release_pages(list(directory.glob("page-*.json")))
    releases: list[dict[str, object]] = []
    reached_end = False
    for page in pages:
        if not page.is_file() or page.stat().st_size > 1024 * 1024:
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
    if newest.get("tag_name") != binding.target_tag:
        raise RuntimeGateError(
            f"{binding.target_version} is not the newest stable Android phone release"
        )

    if binding.automatic:
        if sum(
            1 for release in releases if release.get("tag_name") == binding.target_tag
        ) != 1:
            raise RuntimeGateError("Target public release is missing or ambiguous")
        required_paths = (baseline_path, manifest_path, checksums_path)
        if any(path is None for path in required_paths):
            raise RuntimeGateError("Automatic release validation requires every downloaded asset")
        if newest.get("published_at") in {None, ""}:
            raise RuntimeGateError("Target public release publication metadata is absent")
        if newest.get("target_commitish") != binding.target_source:
            raise RuntimeGateError("Target public release source revision mismatch")

    assets = newest.get("assets")
    if not isinstance(assets, list) or len(assets) > 200:
        raise RuntimeGateError("Target release assets are invalid")
    selected: dict[str, dict[str, object]] = {}
    for asset in assets:
        if not isinstance(asset, dict) or asset.get("name") not in {
            binding.target_apk_name, "android-update.json",
            binding.target_verification_name, "SHA256SUMS"
        }:
            continue
        name = str(asset["name"])
        if name in selected:
            raise RuntimeGateError("Target release has duplicate required assets")
        expected_url = (
            "https://github.com/Tgk-30/YAWF-Stream/releases/download/"
            f"{binding.target_tag}/{name}"
        )
        if asset.get("browser_download_url") != expected_url:
            raise RuntimeGateError("Target release asset URL is not exact")
        if binding.automatic and asset.get("state") != "uploaded":
            raise RuntimeGateError("Target release asset upload state is not exact")
        selected[name] = asset
    if set(selected) != {
        binding.target_apk_name, "android-update.json",
        binding.target_verification_name, "SHA256SUMS"
    }:
        raise RuntimeGateError("Target release required assets are incomplete")
    apk = selected[binding.target_apk_name]
    if apk.get("size") != binding.target_size:
        raise RuntimeGateError("Target release APK size mismatch")
    digest = apk.get("digest")
    if (binding.automatic and digest != f"sha256:{binding.target_sha256}") or (
        not binding.automatic
        and digest is not None
        and digest != f"sha256:{binding.target_sha256}"
    ):
        raise RuntimeGateError("Target release APK digest mismatch")
    verification = selected[binding.target_verification_name]
    verification_hash = sha256_file(verification_path)
    if verification.get("size") != verification_path.stat().st_size:
        raise RuntimeGateError("Target release verification receipt size mismatch")
    if verification.get("digest") != f"sha256:{verification_hash}":
        raise RuntimeGateError("Target release verification receipt digest mismatch")

    if binding.automatic:
        assert baseline_path is not None and manifest_path is not None and checksums_path is not None
        target_files = {
            binding.target_apk_name: None,
            "android-update.json": manifest_path,
            binding.target_verification_name: verification_path,
            "SHA256SUMS": checksums_path,
        }
        for name, path in target_files.items():
            asset = selected[name]
            expected_hash = binding.target_sha256 if path is None else sha256_file(path)
            expected_size = binding.target_size if path is None else path.stat().st_size
            if asset.get("size") != expected_size:
                raise RuntimeGateError(f"Target release {name} size mismatch")
            if asset.get("digest") != f"sha256:{expected_hash}":
                raise RuntimeGateError(f"Target release {name} digest mismatch")

        baseline_matches = [
            release for release in releases if release.get("tag_name") == binding.baseline_tag
        ]
        if len(baseline_matches) != 1:
            raise RuntimeGateError("Baseline public release is missing or ambiguous")
        baseline_release = baseline_matches[0]
        if (
            baseline_release.get("draft") is not False
            or baseline_release.get("prerelease") is not False
            or baseline_release.get("published_at") in {None, ""}
            or baseline_release.get("target_commitish") != binding.baseline_source
        ):
            raise RuntimeGateError("Baseline public release metadata is invalid")
        baseline_assets = baseline_release.get("assets")
        if not isinstance(baseline_assets, list) or len(baseline_assets) > 200:
            raise RuntimeGateError("Baseline public release assets are invalid")
        baseline_apks = [
            asset for asset in baseline_assets
            if isinstance(asset, dict) and asset.get("name") == binding.baseline_apk_name
        ]
        if len(baseline_apks) != 1:
            raise RuntimeGateError("Baseline public APK asset is missing or ambiguous")
        baseline_asset = baseline_apks[0]
        expected_baseline_url = (
            "https://github.com/Tgk-30/YAWF-Stream/releases/download/"
            f"{binding.baseline_tag}/{binding.baseline_apk_name}"
        )
        if (
            baseline_asset.get("state") != "uploaded"
            or baseline_asset.get("browser_download_url") != expected_baseline_url
            or baseline_asset.get("size") != binding.baseline_size
            or baseline_asset.get("digest") != f"sha256:{binding.baseline_sha256}"
        ):
            raise RuntimeGateError("Baseline public APK asset identity mismatch")
        validate_file(
            baseline_path, binding.baseline_sha256, binding.baseline_size,
            "downloaded baseline APK",
        )
    return newest


def validate_host_inputs(args: argparse.Namespace, binding: RuntimeBinding) -> None:
    """Bind the actual downloaded bytes to the admitted public release tuple."""
    validate_file(
        args.baseline_apk, binding.baseline_sha256, binding.baseline_size, "baseline APK"
    )
    validate_file(args.target_apk, binding.target_sha256, binding.target_size, "target APK")
    validate_target_manifest(args.target_manifest, binding)
    validate_target_verification(args.target_verification, binding)
    checksums = parse_checksums(args.target_checksums, binding)
    if checksums["android-update.json"] != sha256_file(args.target_manifest):
        raise RuntimeGateError("SHA256SUMS manifest hash mismatch")
    if (
        checksums[binding.target_verification_name]
        != sha256_file(args.target_verification)
    ):
        raise RuntimeGateError("SHA256SUMS verification receipt hash mismatch")
    validate_release_pages(
        args.release_pages,
        args.target_verification,
        binding,
        baseline_path=args.baseline_apk if binding.automatic else None,
        manifest_path=args.target_manifest if binding.automatic else None,
        checksums_path=args.target_checksums if binding.automatic else None,
    )


def _run_apk_tool(command: list[str], label: str) -> str:
    result = subprocess.run(
        command, capture_output=True, text=True, timeout=120, check=False
    )
    if result.returncode != 0:
        raise RuntimeGateError(f"{label} failed")
    return result.stdout.strip()


def _apk_signer(path: Path, apksigner: str) -> str:
    output = _run_apk_tool(
        [apksigner, "verify", "--print-certs", str(path)], "apksigner verification"
    )
    matches = re.findall(
        r"certificate SHA-256 digest:\s*([0-9a-fA-F:]+)", output
    )
    if len(matches) != 1:
        raise RuntimeGateError("APK signer digest is missing or ambiguous")
    return matches[0].replace(":", "").casefold()


def verify_downloaded_apk_identities(
    baseline_apk: Path,
    target_apk: Path,
    apksigner: str,
    apkanalyzer: str,
    binding: RuntimeBinding,
) -> None:
    """Verify both downloaded APKs without ever transferring the target to ADB."""
    for label, path, version, code in (
        ("baseline", baseline_apk, binding.baseline_version, binding.baseline_code),
        ("target", target_apk, binding.target_version, binding.target_code),
    ):
        if _apk_signer(path, apksigner) != binding.signer_pin:
            raise RuntimeGateError(f"Downloaded {label} APK signer mismatch")
        commands = (
            ("application-id", PRODUCT_PACKAGE),
            ("version-name", version),
            ("version-code", str(code)),
        )
        for field, expected in commands:
            observed = _run_apk_tool(
                [apkanalyzer, "manifest", field, str(path)],
                f"apkanalyzer {label} {field}",
            )
            if observed != expected:
                raise RuntimeGateError(f"Downloaded {label} APK {field} mismatch")


def binding_from_args(args: argparse.Namespace) -> RuntimeBinding:
    admission = getattr(args, "automatic_binding", None)
    if admission is None:
        return LEGACY_BINDING
    binding = load_automatic_binding(admission)
    if args.ota_mode != STRICT_OTA_MODE:
        raise RuntimeGateError("Automatic admission cannot be combined with legacy recovery mode")
    return binding


@dataclasses.dataclass(frozen=True)
class PackageIdentity:
    version_name: str
    version_code: int
    uid: int
    first_install_time: str
    last_update_time: str


def parse_package_identity(value: str) -> PackageIdentity:
    if len(re.findall(r"(?m)^Packages:$", value)) != 1:
        raise RuntimeGateError("Package identity Packages section is missing or ambiguous")
    package_headers = list(re.finditer(r"(?m)^  Package \[([^\]\r\n]+)\] \([^\r\n)]+\):$", value))
    if len(package_headers) != 1 or package_headers[0].group(1) != PRODUCT_PACKAGE:
        raise RuntimeGateError("Package identity target section is missing or ambiguous")
    header = package_headers[0]
    section_tail = value[header.end():]
    next_section = re.search(r"(?m)^[A-Za-z][^\r\n]*:\s*$", section_tail)
    section = section_tail[:next_section.start()] if next_section is not None else section_tail

    user_sections = list(re.finditer(r"(?m)^    User (\d+):([^\r\n]*)$", section))
    if len(user_sections) != 1 or user_sections[0].group(1) != "0":
        raise RuntimeGateError("Package identity must contain exactly one User 0 section")
    if re.search(r"(?:^|\s)installed=true(?:\s|$)", user_sections[0].group(2)) is None:
        raise RuntimeGateError("Package identity User 0 installation state is missing")
    package_fields = section[:user_sections[0].start()]
    user_zero_fields = section[user_sections[0].end():]

    def exactly_one(pattern: str, label: str, source: str = package_fields) -> str:
        matches = re.findall(pattern, source, re.MULTILINE)
        if len(matches) != 1 or not matches[0].strip():
            raise RuntimeGateError(f"Package identity {label} is missing or ambiguous")
        return matches[0].strip()

    legacy_uids = re.findall(r"(?m)^    userId=(\d+)\s*$", package_fields)
    modern_app_ids = re.findall(r"(?m)^    appId=(\d+)\s*$", package_fields)
    if len(legacy_uids) > 1 or len(modern_app_ids) > 1:
        raise RuntimeGateError("Package identity application ID is duplicated")
    if bool(legacy_uids) == bool(modern_app_ids):
        raise RuntimeGateError("Package identity must contain exactly one userId or appId")
    uid = int((legacy_uids or modern_app_ids)[0])
    if not 10_000 <= uid < 100_000:
        raise RuntimeGateError("Package identity User 0 UID is outside the application range")

    package_first_install = re.findall(
        r"(?m)^    firstInstallTime=([^\r\n]+)$", package_fields
    )
    user_first_install = re.findall(
        r"(?m)^      firstInstallTime=([^\r\n]+)$", user_zero_fields
    )
    first_install_times = package_first_install + user_first_install
    if len(first_install_times) != 1 or not first_install_times[0].strip():
        raise RuntimeGateError("Package identity firstInstallTime is missing or ambiguous")
    return PackageIdentity(
        version_name=exactly_one(r"^    versionName=([^\s]+)\s*$", "versionName"),
        version_code=int(exactly_one(r"^    versionCode=(\d+)(?:\s+.*)?$", "versionCode")),
        uid=uid,
        first_install_time=first_install_times[0].strip(),
        last_update_time=exactly_one(
            r"^    lastUpdateTime=([^\r\n]+)$", "lastUpdateTime"
        ),
    )


def record_package_identity(write_diagnostic, name: str, value: str) -> PackageIdentity:
    write_diagnostic(name, value)
    return parse_package_identity(value)


def validate_final_identity(
    baseline: PackageIdentity,
    final: PackageIdentity,
    binding: RuntimeBinding = LEGACY_BINDING,
) -> None:
    if final.version_name != binding.target_version or final.version_code != binding.target_code:
        raise RuntimeGateError("Final installed version identity mismatch")
    if final.uid != baseline.uid or final.first_install_time != baseline.first_install_time:
        raise RuntimeGateError("UID or first-install time changed across OTA")
    if final.last_update_time == baseline.last_update_time:
        raise RuntimeGateError("Last-update time did not change across OTA")


def validate_receipt(
    value: dict[str, object],
    ota_mode: str = STRICT_OTA_MODE,
    binding: RuntimeBinding = LEGACY_BINDING,
) -> None:
    expected = {
        "outcome": "passed",
        "persistentUiAutomationSession": True,
        "productPackage": PRODUCT_PACKAGE,
        "baselineVersion": binding.baseline_version,
        "targetVersion": binding.target_version,
        "targetSha256": binding.target_sha256,
        "productPermissionPageObserved": True,
        "permissionEnabledByTest": True,
        "installerSuccessObserved": True,
        "installerOpenObserved": True,
        "updatedProductObserved": True,
        "permissionCleanupObserved": True,
        "permissionBackReturnObserved": True,
    }
    for key, expected_value in expected.items():
        if value.get(key) != expected_value:
            raise RuntimeGateError(f"Instrumentation receipt {key} did not prove the full OTA")
    if value.get("otaMode") != ota_mode:
        raise RuntimeGateError("Instrumentation receipt OTA mode did not match the admitted mode")
    used = value.get("legacyManualReconsentUsed")
    if ota_mode == STRICT_OTA_MODE and used is not False:
        raise RuntimeGateError("Strict receipt must prove the legacy reconsent path was unused")
    if ota_mode == LEGACY_MANUAL_RECONSENT_MODE and used is not True:
        raise RuntimeGateError("Legacy manual reconsent receipt did not prove its single use")
    if ota_mode == AUTOMATIC_OTA_MODE:
        if not binding.automatic:
            raise RuntimeGateError("Automatic receipt requires an admitted automatic binding")
        automatic_expected = {
            "targetVersionCode": binding.target_code,
            "targetSize": binding.target_size,
            "targetIdentityAdmitted": True,
            "legacyManualReconsentUsed": False,
            "productInstallSelections": 1,
            "systemUpdateSelections": 1,
            "systemOpenSelections": 1,
            "targetSourceRevision": binding.target_source,
            "targetManifestSha256": binding.target_manifest_sha256,
            "targetVerificationSha256": binding.target_verification_sha256,
            "targetBuildRun": binding.target_build_run,
            "initialManualProgressObserved": True,
            "initialManualCancelWon": True,
            "automaticOfferAbsentSameForeground": True,
            "deferredAutomaticOfferObserved": True,
            "automaticDiscoveryObserved": True,
            "weeklyElapsedSchedulingProven": False,
            "sampleCatalogFixtureUsed": True,
            "liveCatalogProviderProof": False,
            "profilePersistedWarm": True,
            "appearancePersistedWarm": True,
            "watchlistPersistedWarm": True,
            "folderPersistedWarm": True,
            "visibleTaskDismissalObserved": True,
            "visibleTaskDismissalSwipes": 1,
            "independentColdProcessProof": False,
            "profilePersistedAfterTaskRelaunch": True,
            "appearancePersistedAfterTaskRelaunch": True,
            "watchlistPersistedAfterTaskRelaunch": True,
            "folderPersistedAfterTaskRelaunch": True,
            "permissionCleanupToggleSelections": 1,
        }
        for key, expected_value in automatic_expected.items():
            if value.get(key) != expected_value:
                raise RuntimeGateError(
                    f"Automatic instrumentation receipt {key} mismatch"
                )
    elif ota_mode == FIXED42_AUTOMATIC_OTA_PROFILE:
        if binding.profile != FIXED42_AUTOMATIC_OTA_PROFILE:
            raise RuntimeGateError("Fixed42 receipt requires the exact admitted profile")
        for key, expected_value in expected.items():
            actual = value.get(key)
            if type(actual) is not type(expected_value) or actual != expected_value:
                raise RuntimeGateError(f"Fixed42 common instrumentation receipt {key} mismatch")
        fixed_expected: dict[str, object] = {
            "runtimeProfile": FIXED42_AUTOMATIC_OTA_PROFILE,
            "baselineSourceRevision": FIXED42_BASELINE_SOURCE,
            "baselineManifestSha256": FIXED42_BASELINE_MANIFEST_SHA256,
            "baselineVerificationSha256": FIXED42_BASELINE_VERIFICATION_SHA256,
            "baselineBuildRun": FIXED42_BASELINE_BUILD_RUN,
            "targetVersionCode": FIXED42_TARGET_CODE,
            "targetSize": FIXED42_TARGET_SIZE,
            "targetIdentityAdmitted": True,
            "targetSourceRevision": FIXED42_TARGET_SOURCE,
            "targetManifestSha256": FIXED42_TARGET_MANIFEST_SHA256,
            "targetVerificationSha256": FIXED42_TARGET_VERIFICATION_SHA256,
            "targetBuildRun": FIXED42_TARGET_BUILD_RUN,
            "updaterSourceSha256": FIXED42_UPDATER_SHA256,
            "legacyManualReconsentUsed": False,
            "initialManualProgressObserved": False,
            "initialManualCancelWon": False,
            "initialEnableCheckingTitleObserved": True,
            "initialEnableCheckingMessageObserved": True,
            "initialEnableCancelObserved": True,
            "initialEnableTerminalResultExcludedBeforeCancel": True,
            "initialEnableCancelSelections": 1,
            "initialEnableCancelWon": True,
            "initialEnableSettledResultExclusionSamples": 3,
            "preOfferManualDiscoveries": 0,
            "automaticOfferAbsentSameForeground": True,
            "deferredAutomaticOfferObserved": True,
            "weeklyOnAtDeferredOffer": True,
            "automaticDiscoveryObserved": True,
            "weeklyElapsedSchedulingProven": False,
            "productUpdateSelections": 1,
            "productInstallSelections": 1,
            "systemUpdateSelections": 1,
            "systemOpenSelections": 1,
            "postInstallManualInspectionChecks": 1,
            "postInstallExactUpToDate59Observed": True,
            "weeklyOnAfterUpdate": True,
            "postInstallNativeOkClosures": 1,
            "postInstallNativeCancelClosures": 0,
            "automaticDiscoveryProofIncludesPostInstallInspection": False,
            "sampleCatalogFixtureUsed": True,
            "liveCatalogProviderProof": False,
            "profileNameMarker": "Fixed42OTA59Marker",
            "profileNameInitialDistinct": True,
            "profileNameSetTextActions": 1,
            "profileNameImmediateExact": True,
            "profileNameCloseReopenExact": True,
            "profileNamePostInstallSetTextActions": 0,
            "profilePersistedWarm": True,
            "appearancePersistedWarm": True,
            "watchlistPersistedWarm": True,
            "folderPersistedWarm": True,
            "visibleTaskDismissalObserved": True,
            "visibleTaskDismissalSwipes": 1,
            "independentColdProcessProof": False,
            "profilePersistedAfterTaskRelaunch": True,
            "appearancePersistedAfterTaskRelaunch": True,
            "watchlistPersistedAfterTaskRelaunch": True,
            "folderPersistedAfterTaskRelaunch": True,
            "permissionCleanupToggleSelections": 1,
        }
        for key, expected_value in fixed_expected.items():
            actual = value.get(key)
            if type(actual) is not type(expected_value) or actual != expected_value:
                raise RuntimeGateError(f"Fixed42 instrumentation receipt {key} mismatch")
        trigger = value.get("automaticTriggerReturnOrdinal")
        deferred = value.get("deferredOfferReturnOrdinal")
        offer_ordinal = value.get("automaticOfferOrdinal")
        inspection_ordinal = value.get("postInstallInspectionOrdinal")
        if (
            type(trigger) is not int
            or type(deferred) is not int
            or type(offer_ordinal) is not int
            or type(inspection_ordinal) is not int
            or trigger < 1
            or deferred != trigger + 1
            or offer_ordinal != deferred
            or inspection_ordinal <= offer_ordinal
        ):
            raise RuntimeGateError("Fixed42 receipt event ordering mismatch")
        captures = value.get("captures")
        if type(captures) is not int or captures < 1 or captures > 40:
            raise RuntimeGateError("Fixed42 receipt capture count is invalid")
        exact_keys = (
            set(expected)
            | set(fixed_expected)
            | {
                "otaMode", "automaticTriggerReturnOrdinal",
                "deferredOfferReturnOrdinal", "automaticOfferOrdinal",
                "postInstallInspectionOrdinal", "captures", "failure",
            }
        )
        if set(value) != exact_keys:
            raise RuntimeGateError("Fixed42 instrumentation receipt keys are not exact")
    if value.get("failure") is not None:
        raise RuntimeGateError("Instrumentation receipt retained a failure")


def automatic_instrumentation_arguments(binding: RuntimeBinding) -> list[str]:
    if not binding.automatic:
        raise RuntimeGateError("Automatic instrumentation requires an automatic binding")
    arguments = [
        "shell", "am", "instrument", "-w", "-r",
        "-e", "class", HARNESS_CLASS,
        "-e", "evidenceSubdir", binding.evidence_subdir,
        "-e", "baselineVersion", binding.baseline_version,
        "-e", "targetVersion", binding.target_version,
        "-e", "targetVersionCode", str(binding.target_code),
        "-e", "targetSha256", binding.target_sha256,
        "-e", "targetSize", str(binding.target_size),
        "-e", "signerSha256", binding.signer_pin,
        "-e", "otaMode", binding.ota_mode,
        "-e", "baselineVersionCode", str(binding.baseline_code),
        "-e", "baselineSha256", binding.baseline_sha256,
        "-e", "baselineSize", str(binding.baseline_size),
        "-e", "targetApkName", binding.target_apk_name,
        "-e", "targetSourceRevision", binding.target_source,
        "-e", "targetManifestSha256", binding.target_manifest_sha256 or "",
        "-e", "targetVerificationSha256", binding.target_verification_sha256 or "",
        "-e", "targetBuildRun", str(binding.target_build_run),
        "-e", "targetPublicRelease", "true",
    ]
    if binding.profile == FIXED42_AUTOMATIC_OTA_PROFILE:
        arguments.extend([
            "-e", "runtimeProfile", FIXED42_AUTOMATIC_OTA_PROFILE,
            "-e", "baselineSourceRevision", binding.baseline_source,
            "-e", "baselineManifestSha256", binding.baseline_manifest_sha256 or "",
            "-e", "baselineVerificationSha256", binding.baseline_verification_sha256 or "",
            "-e", "baselineBuildRun", str(binding.baseline_build_run or 0),
            "-e", "updaterSourceSha256", binding.updater_source_sha256 or "",
        ])
    arguments.append(HARNESS_INSTRUMENTATION)
    return arguments


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
        *,
        automatic_binding: RuntimeBinding | None = None,
    ):
        self.executable = executable
        self.serial = serial
        self.baseline_apk = baseline_apk.resolve()
        self.target_apk = target_apk.resolve()
        self.harness_app = harness_app.resolve()
        self.harness_test = harness_test.resolve()
        if automatic_binding is not None and not automatic_binding.automatic:
            raise RuntimeGateError("Automatic ADB admission requires an automatic binding")
        self.automatic_binding = automatic_binding
        self._assert_fixed42_install_inputs_are_not_target()
        self.harness_install_count = 0
        self.baseline_install_count = 0
        self.baseline_installed = False
        self.baseline_pull_attempted = False
        self.baseline_pulled = False
        self.installer_success_receipt = False
        self.final_pulled = False
        self.automatic_instrumentation_started = False
        self.commands: list[tuple[str, ...]] = []

    def _assert_fixed42_install_inputs_are_not_target(self) -> None:
        binding = self.automatic_binding
        if binding is None or binding.profile != FIXED42_AUTOMATIC_OTA_PROFILE:
            return
        for label, candidate in (
            ("baseline", self.baseline_apk),
            ("harness app", self.harness_app),
            ("harness test", self.harness_test),
        ):
            try:
                same_file = candidate == self.target_apk or candidate.samefile(self.target_apk)
                digest = sha256_file(candidate)
            except OSError as error:
                raise RuntimeGateError(
                    f"Fixed42 {label} input identity could not be verified"
                ) from error
            if same_file:
                raise RuntimeGateError(
                    f"Fixed42 {label} input aliases the target APK"
                )
            if digest == FIXED42_TARGET_SHA256:
                raise RuntimeGateError(
                    f"Fixed42 {label} input contains the target APK bytes"
                )
            if label == "baseline" and digest != FIXED42_BASELINE_SHA256:
                raise RuntimeGateError(
                    "Fixed42 baseline install input is not the admitted official APK"
                )

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
        if lowered[0] in {
            "uninstall", "root", "remount", "disable-verity", "enable-verity",
            "reverse", "forward", "restore",
        }:
            raise RuntimeGateError("ADB privileged mutation is locked")
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
            mutation = False
            if shell:
                mutation = (
                    shell[0] in {"settings", "device_config", "setprop", "date"}
                    or shell[:2] in (["toybox", "date"], ["service", "call"])
                    or shell[:2] in (["cmd", "alarm"], ["am", "broadcast"])
                    or (shell[0] == "content" and len(shell) >= 2
                        and shell[1] in {"insert", "update", "delete", "call"})
                    or (shell[0] == "run-as" and len(shell) >= 2
                        and shell[1] == PRODUCT_PACKAGE.casefold())
                    or (shell[0] == "pm" and len(shell) >= 2
                        and shell[1] in {"grant", "revoke", "clear", "uninstall"})
                    or (shell[:2] == ["cmd", "package"] and len(shell) >= 3
                        and shell[2] in {"grant", "revoke", "clear"})
                    or (shell[:2] == ["cmd", "permission"] and len(shell) >= 3
                        and shell[2] in {"grant", "revoke"})
                    or (shell[:2] in (["appops", "set"], ["appops", "reset"])
                        or shell[:3] in (["cmd", "appops", "set"], ["cmd", "appops", "reset"]))
                    or (shell[:2] == ["am", "force-stop"]
                        and PRODUCT_PACKAGE.casefold() in shell[2:])
                )
            if mutation:
                raise RuntimeGateError("Privileged product, feed, permission, or clock mutation is locked")
        if any(
            token in joined
            for token in (
                "http://", "https://", "android-update.json", "update-feed",
                "update_feed", "ota-feed",
            )
        ):
            raise RuntimeGateError("Updater feed mutation material must never be passed to ADB")

    def _require_automatic_read_only_command(self, args: Sequence[str]) -> None:
        binding = self.automatic_binding
        if binding is None:
            raise RuntimeGateError("Automatic ADB admission is not active")
        command = tuple(args)
        if not command or any(not isinstance(part, str) for part in command):
            raise RuntimeGateError("Automatic ADB command shape is invalid")
        exact_commands = {
            ("shell", "pm", "path", PRODUCT_PACKAGE),
            ("shell", "dumpsys", "package", PRODUCT_PACKAGE),
            (
                "shell", "cmd", "appops", "get", PRODUCT_PACKAGE,
                "REQUEST_INSTALL_PACKAGES",
            ),
            (
                "shell", "find",
                f"/sdcard/Android/data/{PRODUCT_PACKAGE}/files/Download/updates",
                "-maxdepth", "1", "-type", "f", "-name", "*.apk", "-print",
            ),
            ("logcat", "-d", "-v", "threadtime"),
            ("shell", "dumpsys", "dropbox", "--print", "data_app_anr"),
            ("shell", "dumpsys", "dropbox", "--print", "data_app_crash"),
        }
        if command in exact_commands:
            return

        remote = f"files/{binding.evidence_subdir}"
        if command == ("exec-out", "run-as", HARNESS_PACKAGE, "ls", "-1", remote):
            return
        evidence_name: str | None = None
        if command[:6] == (
            "exec-out", "run-as", HARNESS_PACKAGE, "stat", "-c", "%s"
        ) and len(command) == 7:
            evidence_name = command[6].removeprefix(f"{remote}/")
            if command[6] != f"{remote}/{evidence_name}":
                evidence_name = None
        elif command[:4] == (
            "exec-out", "run-as", HARNESS_PACKAGE, "cat"
        ) and len(command) == 5:
            evidence_name = command[4].removeprefix(f"{remote}/")
            if command[4] != f"{remote}/{evidence_name}":
                evidence_name = None
        if (
            evidence_name is not None
            and evidence_name == Path(evidence_name).name
            and SAFE_EVIDENCE_NAME.fullmatch(evidence_name) is not None
        ):
            return
        raise RuntimeGateError("Automatic ADB command is outside the exact allowlist")

    def run(self, args: Sequence[str], **kwargs) -> subprocess.CompletedProcess:
        if self.automatic_binding is None:
            self._reject_transfer_or_install(args)
        else:
            self._require_automatic_read_only_command(args)
        return self._execute(args, **kwargs)

    def shell(self, *args: str, timeout: float = 30, check: bool = True) -> str:
        return self.run(["shell", *args], timeout=timeout, check=check).stdout

    def exec_out(self, *args: str, timeout: float = 30) -> bytes:
        return self.run(["exec-out", *args], timeout=timeout, text=False).stdout

    def run_automatic_instrumentation_once(
        self,
        args: Sequence[str],
        *,
        timeout: float,
        check: bool = False,
    ) -> subprocess.CompletedProcess:
        binding = self.automatic_binding
        if binding is None:
            raise RuntimeGateError("Automatic instrumentation admission is not active")
        if (
            self.harness_install_count != 2
            or self.baseline_install_count != 1
            or not self.baseline_installed
            or not self.baseline_pulled
        ):
            raise RuntimeGateError(
                "Automatic instrumentation requires the exact baseline install and pull state"
            )
        if self.automatic_instrumentation_started or self.installer_success_receipt:
            raise RuntimeGateError("Automatic instrumentation may run exactly once")
        expected = automatic_instrumentation_arguments(binding)
        if tuple(args) != tuple(expected):
            raise RuntimeGateError("Automatic instrumentation arguments are not exact")
        self.automatic_instrumentation_started = True
        return self._execute(expected, timeout=timeout, check=check)

    def install_harness(self, app_hash: str, test_hash: str) -> None:
        self._assert_fixed42_install_inputs_are_not_target()
        if self.baseline_installed:
            raise RuntimeGateError("Harness installation is forbidden after baseline")
        if self.harness_install_count != 0:
            raise RuntimeGateError("Harness APKs may be installed exactly once each")
        if sha256_file(self.harness_app) != app_hash or sha256_file(self.harness_test) != test_hash:
            raise RuntimeGateError("Harness APK hash mismatch")
        for path, flags in (
            (self.harness_app, ["install", "--no-streaming", "-r"]),
            (self.harness_test, ["install", "--no-streaming", "-r", "-t"]),
        ):
            self._assert_fixed42_install_inputs_are_not_target()
            result = self._execute([*flags, str(path)], timeout=120)
            if "Success" not in result.stdout:
                raise RuntimeGateError("Harness install did not report Success")
            self.harness_install_count += 1
        if self.harness_install_count != 2:
            raise RuntimeGateError("Exactly two harness APK installs are required")

    def install_baseline_once(self) -> None:
        self._assert_fixed42_install_inputs_are_not_target()
        if self.baseline_installed:
            raise RuntimeGateError("Baseline product install may occur exactly once")
        if self.baseline_install_count != 0:
            raise RuntimeGateError("Baseline product install count is invalid")
        if self.harness_install_count != 2:
            raise RuntimeGateError("Both harness APKs must be installed before the baseline")
        result = self._execute(
            ["install", "--no-streaming", str(self.baseline_apk)], timeout=180
        )
        if "Success" not in result.stdout:
            raise RuntimeGateError("Baseline install did not report Success")
        self.baseline_install_count = 1
        self.baseline_installed = True

    def pull_baseline_once(
        self,
        remote: str,
        destination: Path,
        *,
        diagnostic_writer: Callable[[str, str], None] | None = None,
    ) -> None:
        fixed42 = (
            self.automatic_binding is not None
            and self.automatic_binding.profile == FIXED42_AUTOMATIC_OTA_PROFILE
        )
        if (
            not self.baseline_installed
            or self.baseline_pulled
            or (fixed42 and self.baseline_pull_attempted)
        ):
            raise RuntimeGateError("Baseline pull scope is invalid")
        if not fixed42:
            self._execute(["pull", remote, str(destination)], timeout=180)
            self.baseline_pulled = True
            return
        if diagnostic_writer is None:
            raise RuntimeGateError("Fixed42 baseline pull requires diagnostic retention")

        diagnostic_writer(
            "baseline-pull-attempt.json",
            json.dumps({
                "profile": FIXED42_AUTOMATIC_OTA_PROFILE,
                "phase": "before-dispatch",
                "attemptOrdinal": 1,
                "timeoutSeconds": 180,
                "remoteKind": "installed-package-base-apk",
                "destinationName": destination.name,
            }, indent=2, sort_keys=True) + "\n",
        )
        args = ["pull", remote, str(destination)]
        self.baseline_pull_attempted = True
        self.commands.append(tuple(args))
        started = time.monotonic()
        timeout_error: subprocess.TimeoutExpired | None = None
        result: subprocess.CompletedProcess[str] | None = None
        try:
            result = subprocess.run(
                [self.executable, "-s", self.serial, *args],
                capture_output=True,
                timeout=180,
                check=False,
                text=True,
            )
            stdout = subprocess_output_text(result.stdout)
            stderr = subprocess_output_text(result.stderr)
            return_code: int | None = result.returncode
            timed_out = False
        except subprocess.TimeoutExpired as error:
            timeout_error = error
            stdout = subprocess_output_text(error.stdout)
            stderr = subprocess_output_text(error.stderr)
            return_code = None
            timed_out = True

        elapsed_ms = round((time.monotonic() - started) * 1000)
        try:
            partial_bytes: int | None = destination.stat().st_size if destination.exists() else 0
        except OSError:
            partial_bytes = None

        process_error: RuntimeGateError | None = None
        if timed_out:
            process_error = RuntimeGateError("ADB command timed out (180s): pull")
        elif return_code != 0:
            process_error = RuntimeGateError(
                f"ADB command failed ({return_code}): pull\n"
                + redact(stdout + "\n" + stderr)[-4000:]
            )

        diagnostic_error: Exception | None = None
        try:
            for stream, value in (("stdout", stdout), ("stderr", stderr)):
                retained, receipt = bounded_diagnostic_retention(value)
                diagnostic_writer(f"baseline-pull-{stream}.txt", retained)
                diagnostic_writer(
                    f"baseline-pull-{stream}-retention.json",
                    json.dumps(receipt, indent=2, sort_keys=True) + "\n",
                )
            diagnostic_writer(
                "baseline-pull-result.json",
                json.dumps({
                    "profile": FIXED42_AUTOMATIC_OTA_PROFILE,
                    "dispatched": True,
                    "returnCode": return_code,
                    "timedOut": timed_out,
                    "elapsedMilliseconds": elapsed_ms,
                    "partialDestinationBytes": partial_bytes,
                    "partialDestinationUsedForAdmission": False,
                    "admittedForIdentityValidation": False,
                }, indent=2, sort_keys=True) + "\n",
            )
        except Exception as error:
            diagnostic_error = error

        if process_error is not None:
            if timeout_error is not None:
                raise process_error from timeout_error
            raise process_error
        if diagnostic_error is not None:
            raise RuntimeGateError("Fixed42 baseline pull diagnostics could not be retained") from diagnostic_error
        self.baseline_pulled = True

    def mark_installer_success_receipt(self) -> None:
        if self.automatic_binding is not None and (
            not self.automatic_instrumentation_started
            or self.installer_success_receipt
        ):
            raise RuntimeGateError("Automatic installer receipt state is invalid")
        self.installer_success_receipt = True

    def pull_final_once(self, remote: str, destination: Path) -> None:
        if not self.installer_success_receipt or self.final_pulled:
            raise RuntimeGateError("Final pull requires one genuine installer-success receipt")
        self._execute(["pull", remote, str(destination)], timeout=180)
        self.final_pulled = True


class OtaRuntimeDriver:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.binding = binding_from_args(args)
        self.ota_mode = self.binding.ota_mode if self.binding.automatic else args.ota_mode
        self.evidence = args.evidence
        self.evidence.mkdir(parents=True, exist_ok=True)
        self.adb = AdmittedAdb(
            args.adb,
            args.serial,
            args.baseline_apk,
            args.target_apk,
            args.harness_app,
            args.harness_test,
            automatic_binding=self.binding if self.binding.automatic else None,
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

    def record_adb_observation(
        self, name: str, result: subprocess.CompletedProcess[str]
    ) -> None:
        if Path(name).name != name:
            raise RuntimeGateError("Unsafe host evidence write")
        stem = name.removesuffix(".txt")
        if name in BOUNDED_DIAGNOSTIC_STDOUT_NAMES:
            retained, receipt = bounded_diagnostic_retention(result.stdout)
            retained_bytes = retained.encode("utf-8")
            if (
                len(retained_bytes) > MAX_HOST_EVIDENCE_BYTES
                or len(retained_bytes) != receipt["storedUtf8Bytes"]
            ):
                raise RuntimeGateError("Diagnostic retention invariant failed")
            (self.evidence / name).write_bytes(retained_bytes)
            self.write(
                f"{stem}-retention.json",
                json.dumps(receipt, indent=2, sort_keys=True) + "\n",
            )
        else:
            self.write(name, result.stdout)
        self.write(
            f"{stem}-status.txt",
            f"returnCode={result.returncode}\nstderr:\n{result.stderr}",
        )

    def verify_host_inputs(self) -> None:
        validate_host_inputs(self.args, self.binding)
        if self.binding.automatic:
            verify_downloaded_apk_identities(
                self.args.baseline_apk,
                self.args.target_apk,
                self.args.apksigner,
                self.args.apkanalyzer,
                self.binding,
            )
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
        if not self.binding.automatic:
            result = subprocess.run(
                [self.args.apksigner, "verify", "--print-certs", str(apk)],
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
            if result.returncode != 0:
                raise RuntimeGateError("apksigner rejected an installed APK")
            match = re.search(
                r"certificate SHA-256 digest:\s*([0-9a-fA-F:]+)", result.stdout
            )
            if match is None:
                raise RuntimeGateError("Installed APK signer digest is missing")
            return match.group(1).replace(":", "").casefold()
        return _apk_signer(apk, self.args.apksigner)

    def assert_unknown_source_denied(self, phase: str) -> None:
        result = self.adb.run(
            ["shell", "cmd", "appops", "get", PRODUCT_PACKAGE, "REQUEST_INSTALL_PACKAGES"],
            timeout=30,
            check=False,
        )
        self.record_adb_observation(f"unknown-source-{phase}.txt", result)
        try:
            validate_unknown_source_observation(result)
        except RuntimeGateError as error:
            if "remained allowed" in str(error):
                raise RuntimeGateError(
                    f"YAWF unknown-source access remained allowed at {phase}"
                ) from error
            raise

    def assert_no_residual_update_apks(self) -> None:
        result = self.adb.run(
            [
                "shell",
                "find",
                f"/sdcard/Android/data/{PRODUCT_PACKAGE}/files/Download/updates",
                "-maxdepth", "1", "-type", "f", "-name", "*.apk", "-print",
            ],
            timeout=30,
            check=False,
        )
        self.record_adb_observation("update-files.txt", result)
        validate_no_residual_update_apks(result)

    def install_and_record_baseline(self) -> tuple[PackageIdentity, str]:
        self.package_absent()
        self.adb.install_harness(self.args.harness_app_sha256, self.args.harness_test_sha256)
        self.adb.install_baseline_once()
        identity = record_package_identity(
            self.write, "baseline-package.txt", self.package_dump()
        )
        if (
            identity.version_name != self.binding.baseline_version
            or identity.version_code != self.binding.baseline_code
        ):
            raise RuntimeGateError("Installed baseline version identity mismatch")
        pulled = self.evidence / f"installed-baseline-{self.binding.baseline_version}.apk"
        if self.binding.profile == FIXED42_AUTOMATIC_OTA_PROFILE:
            self.adb.pull_baseline_once(
                self.base_path(), pulled, diagnostic_writer=self.write
            )
        else:
            self.adb.pull_baseline_once(self.base_path(), pulled)
        validate_file(
            pulled,
            self.binding.baseline_sha256,
            self.binding.baseline_size,
            "installed baseline",
        )
        signer = self.signer(pulled)
        if signer != self.binding.signer_pin:
            raise RuntimeGateError("Installed baseline signer mismatch")
        self.assert_unknown_source_denied("before")
        self.write("baseline-identity.json", json.dumps(dataclasses.asdict(identity), indent=2) + "\n")
        self.note("Exactly one official baseline product install and scoped read-only pull passed")
        return identity, signer

    def run_instrumentation(self) -> dict[str, object]:
        binding = self.binding
        if not binding.automatic:
            arguments = [
                "shell", "am", "instrument", "-w", "-r",
                "-e", "class", HARNESS_CLASS,
                "-e", "evidenceSubdir", EVIDENCE_SUBDIR,
                "-e", "baselineVersion", BASELINE_VERSION,
                "-e", "targetVersion", TARGET_VERSION,
                "-e", "targetVersionCode", str(TARGET_CODE),
                "-e", "targetSha256", TARGET_SHA256,
                "-e", "targetSize", str(TARGET_SIZE),
                "-e", "signerSha256", SIGNER_PIN,
                "-e", "otaMode", self.ota_mode,
                HARNESS_INSTRUMENTATION,
            ]
            result = self.adb.run(
                arguments,
                timeout=self.args.flow_timeout,
                check=False,
            )
        else:
            arguments = automatic_instrumentation_arguments(binding)
            result = self.adb.run_automatic_instrumentation_once(
                arguments,
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
        receipt_path = (
            self.evidence / binding.evidence_subdir / "instrumentation-receipt.json"
        )
        if result.returncode != 0 or "OK (1 test)" not in result.stdout:
            raise RuntimeGateError("Persistent OTA instrumentation failed; runner output retained")
        if retrieval_error is not None:
            raise RuntimeGateError("Persistent OTA evidence retrieval failed") from retrieval_error
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        if binding.automatic:
            validate_receipt(receipt, self.ota_mode, binding)
        else:
            validate_receipt(receipt, self.args.ota_mode)
        self.adb.mark_installer_success_receipt()
        if self.ota_mode == LEGACY_MANUAL_RECONSENT_MODE:
            self.note("Persistent UI receipt proves the explicitly admitted legacy-manual-reconsent path; this is not an automatic OTA continuation claim")
        else:
            self.note("Persistent UI receipt proves native updater and OS installer success")
        return receipt

    def retrieve_harness_evidence(self) -> None:
        destination = self.evidence / self.binding.evidence_subdir
        destination.mkdir(exist_ok=True)
        remote = f"files/{self.binding.evidence_subdir}"
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
        final = record_package_identity(self.write, "final-package.txt", self.package_dump())
        validate_final_identity(baseline, final, self.binding)
        pulled = self.evidence / f"installed-final-{self.binding.target_version}.apk"
        self.adb.pull_final_once(self.base_path(), pulled)
        if self.binding.automatic:
            validate_file(
                pulled, self.binding.target_sha256, self.binding.target_size,
                "installed final",
            )
        else:
            validate_file(pulled, TARGET_SHA256, TARGET_SIZE, "installed final")
        final_signer = self.signer(pulled)
        if final_signer != baseline_signer or final_signer != self.binding.signer_pin:
            raise RuntimeGateError("Final installed signer changed")
        self.assert_unknown_source_denied("after-cleanup")
        self.assert_no_residual_update_apks()
        self.write("final-identity.json", json.dumps(dataclasses.asdict(final), indent=2) + "\n")
        self.write(
            "installed-byte-identity.txt",
            f"baselineSha256={self.binding.baseline_sha256}\n"
            f"finalSha256={self.binding.target_sha256}\n"
            f"signerSha256={final_signer}\nuidRetained=true\nfirstInstallTimeRetained=true\n"
            "lastUpdateTimeChanged=true\n",
        )
        self.note(
            f"Final OS-installed base APK exactly matches public {self.binding.target_version} "
            "and retained identity"
        )

    def collect_diagnostics(self) -> None:
        logcat_result = self.adb.run(
            ["logcat", "-d", "-v", "threadtime"], timeout=60, check=False
        )
        self.record_adb_observation("logcat.txt", logcat_result)
        validate_logcat_observation(logcat_result)
        anr_result = self.adb.run(
            ["shell", "dumpsys", "dropbox", "--print", "data_app_anr"],
            timeout=60,
            check=False,
        )
        self.record_adb_observation("dropbox-anr.txt", anr_result)
        validate_dropbox_observation(anr_result, "data_app_anr")
        crash_result = self.adb.run(
            ["shell", "dumpsys", "dropbox", "--print", "data_app_crash"],
            timeout=60,
            check=False,
        )
        self.record_adb_observation("dropbox-crash.txt", crash_result)
        validate_dropbox_observation(crash_result, "data_app_crash")
        logcat = logcat_result.stdout
        anr = anr_result.stdout
        crash = crash_result.stdout
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
        if self.adb.harness_install_count != 2 or self.adb.baseline_install_count != 1:
            raise RuntimeGateError("ADB install budget was not exactly two harness plus one baseline")
        self.write("events.txt", "\n".join(self.events) + "\n")
        result_receipt: dict[str, object] = {
            "outcome": "passed",
            "transaction": "public-native-ota",
            "baseline": self.binding.baseline_version,
            "target": self.binding.target_version,
            "targetSha256": self.binding.target_sha256,
            "adbProductInstalls": 1,
            "targetTransferredToAdb": False,
            "otaMode": self.ota_mode,
            "baselinePull": True,
            "finalPullAfterInstallerReceipt": True,
        }
        if self.binding.automatic:
            result_receipt.update({
                "persistenceProof": "task-relaunch-only",
                "independentColdProcessProof": False,
            })
        if self.binding.profile == FIXED42_AUTOMATIC_OTA_PROFILE:
            result_receipt.update({
                "runtimeProfile": FIXED42_AUTOMATIC_OTA_PROFILE,
                "preOfferManualDiscoveries": 0,
                "postInstallManualInspectionChecks": 1,
                "automaticDiscoveryProofIncludesPostInstallInspection": False,
            })
        self.write(
            "RESULT.json",
            json.dumps(result_receipt, indent=2) + "\n",
        )


def actual_verification_fixture() -> dict[str, object]:
    """Proposed 2.3.26 publication receipt shape; public OTA is still pending."""
    return {
        "version": "2.3.26",
        "sourceRevision": "21c0509300c8284b41f4cf1bffaabd84da999164",
        "buildRun": TARGET_BUILD_RUN,
        "apk": {
            "name": "YAWF.Stream_Android_2.3.26.apk",
            "sha256": "2ad11054cdbb2805a75e06d8d59961e2f43c00c0c2532d02ade3e197ef5e9a3c",
            "size": 88562561,
        },
        "certificateSha256":
            "233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a",
        "checks": {
            "canonicalSignedCandidateVerified": True,
            "exactApkStructureSignerPermissionsAnd16KiBAlignment": True,
            "fourAbis": True,
            "api30ProductionSignedCandidateChecks": {
                "workflowRun": 39525625462,
                "driverSourceRevision": "04d88b2d8a997a945c7b8e13290c553d6560851b",
                "candidateSourceRevision": TARGET_SOURCE,
                "apkSha256": TARGET_SHA256,
                "candidateVersion": "2.3.26",
                "publishedChannelVersion": "2.3.25",
                "fullOtaInstall": False,
            },
            "api36ProductionSignedCandidateChecks": {
                "workflowRun": 39525627751,
                "driverSourceRevision": "04d88b2d8a997a945c7b8e13290c553d6560851b",
                "candidateSourceRevision": TARGET_SOURCE,
                "apkSha256": TARGET_SHA256,
                "candidateVersion": "2.3.26",
                "publishedChannelVersion": "2.3.25",
                "fullOtaInstall": False,
            },
        },
        "pending": [
            "Public25-to26 native updater installation.",
            "Full feature-by-feature all-platform audit.",
        ],
        "limits": [
            "The private signed candidate, API30, and API36 receipts do not prove public release metadata or a public OTA runtime pass.",
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
                ("buildRun", TARGET_BUILD_RUN + 1),
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
        api30 = """Permissions:
  Permission [com.tgk30.debridstreamer.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION] (abc):
    uid=99999 gids=[] type=0 prot=signature
Packages:
  Package [com.tgk30.debridstreamer] (c51a00c):
    userId=10170
    versionCode=2003025 minSdk=24 targetSdk=36
    versionName=2.3.25
    timeStamp=2026-10-20 01:02:03
    firstInstallTime=2026-10-20 01:02:03
    lastUpdateTime=2026-10-20 01:02:03
    User 0: ceDataInode=131827 installed=true hidden=false stopped=true
      gids=[3003]
Queries:
  system apps queryable: false
"""
        api36 = """Permissions:
  Permission [com.tgk30.debridstreamer.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION] (da31363):
    uid=10218 gids=[] type=0 prot=signature
Packages:
  Package [com.tgk30.debridstreamer] (3a628df):
    appId=10218
    versionCode=2003026 minSdk=24 targetSdk=36
    versionName=2.3.26
    timeStamp=2026-10-20 05:11:15
    lastUpdateTime=2026-10-20 05:11:15
    User 0: ceDataInode=352915 installed=true hidden=false stopped=true
      firstInstallTime=2026-10-20 05:11:15
      gids=[3003]
Queries:
  system apps queryable: false
"""
        legacy = parse_package_identity(api30)
        modern = parse_package_identity(api36)
        self.assertEqual((legacy.uid, legacy.first_install_time), (10170, "2026-10-20 01:02:03"))
        self.assertEqual((modern.uid, modern.first_install_time), (10218, "2026-10-20 05:11:15"))

        invalid = [
            api36.replace("    appId=10218\n", ""),
            api36.replace("    appId=10218\n", "    appId=10218\n    appId=10218\n"),
            api36.replace("    appId=10218\n", "    userId=10218\n    appId=10218\n"),
            api36.replace("    appId=10218\n", "    userId=10217\n    appId=10218\n"),
            api36.replace("Package [com.tgk30.debridstreamer]", "Package [other.package]"),
            api36.replace("    versionCode=2003026 minSdk=24 targetSdk=36\n", ""),
            api36.replace("    versionName=2.3.26\n", ""),
            api36.replace("    versionName=2.3.26\n", "    versionName=2.3.26\n    versionName=2.3.26\n"),
            api36.replace("    lastUpdateTime=2026-10-20 05:11:15\n", ""),
            api36.replace(
                "    lastUpdateTime=2026-10-20 05:11:15\n",
                "    lastUpdateTime=2026-10-20 05:11:15\n"
                "    lastUpdateTime=2026-10-20 05:11:15\n",
            ),
            api36.replace("      firstInstallTime=2026-10-20 05:11:15\n", ""),
            api36.replace(
                "      firstInstallTime=2026-10-20 05:11:15\n",
                "      firstInstallTime=2026-10-20 05:11:15\n"
                "      firstInstallTime=2026-10-20 05:11:15\n",
            ),
            api36.replace("    appId=10218\n", "    appId=999\n"),
            api36.replace("    User 0:", "    User 10:"),
            api36.replace(
                "Queries:\n",
                "    User 0: ceDataInode=352916 installed=true hidden=false stopped=true\n"
                "Queries:\n",
            ),
            api36.replace(" installed=true", " installed=false"),
            api36.replace("Queries:\n", "  Package [com.tgk30.debridstreamer] (duplicate):\nQueries:\n"),
        ]
        for damaged in invalid:
            with self.assertRaises(RuntimeGateError):
                parse_package_identity(damaged)

        writes: list[tuple[str, str]] = []
        missing_uid = api36.replace("    appId=10218\n", "")
        with self.assertRaises(RuntimeGateError):
            record_package_identity(
                lambda name, payload: writes.append((name, payload)),
                "baseline-package.txt",
                missing_uid,
            )
        self.assertEqual(writes, [("baseline-package.txt", missing_uid)])

    def test_receipt_requires_every_transaction_fact(self) -> None:
        receipt = {
            "outcome": "passed", "persistentUiAutomationSession": True,
            "productPackage": PRODUCT_PACKAGE, "baselineVersion": BASELINE_VERSION,
            "targetVersion": TARGET_VERSION, "targetSha256": TARGET_SHA256,
            "productPermissionPageObserved": True, "permissionEnabledByTest": True,
            "installerSuccessObserved": True, "installerOpenObserved": True,
            "updatedProductObserved": True, "permissionCleanupObserved": True,
            "permissionBackReturnObserved": True,
            "otaMode": STRICT_OTA_MODE, "legacyManualReconsentUsed": False,
            "failure": None,
        }
        validate_receipt(receipt)
        receipt["installerSuccessObserved"] = False
        with self.assertRaises(RuntimeGateError):
            validate_receipt(receipt)

        def observed(
            stdout: str, *, returncode: int = 0, stderr: str = ""
        ) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(
                ["adb", "observation"], returncode, stdout, stderr
            )

        validate_unknown_source_observation(
            observed("No operations.\nDefault mode: default\n")
        )
        for mode in ("default", "ignore", "deny", "errored"):
            validate_unknown_source_observation(
                observed(f"REQUEST_INSTALL_PACKAGES: {mode}\n")
            )
        rejected_appops = [
            observed(""),
            observed("No operations.\n"),
            observed("REQUEST_INSTALL_PACKAGES: allow\n"),
            observed("REQUEST_INSTALL_PACKAGES: foreground\n"),
            observed("", returncode=1),
            observed("", stderr="appops unavailable"),
        ]
        for result in rejected_appops:
            with self.assertRaises(RuntimeGateError):
                validate_unknown_source_observation(result)

        validate_no_residual_update_apks(observed(""))
        for result in (
            observed("/sdcard/Android/data/com.tgk30.debridstreamer/files/Download/updates/update.apk\n"),
            observed("", returncode=1),
            observed("", stderr="find unavailable"),
        ):
            with self.assertRaises(RuntimeGateError):
                validate_no_residual_update_apks(result)

        validate_logcat_observation(
            observed("--------- beginning of main\n10-20 05:11:18.054  1290  1319 I Tag: line\n")
        )
        for result in (
            observed(""),
            observed("not logcat output\n"),
            observed("", returncode=1),
            observed("", stderr="logcat unavailable"),
        ):
            with self.assertRaises(RuntimeGateError):
                validate_logcat_observation(result)

        for tag in ("data_app_anr", "data_app_crash"):
            validate_dropbox_observation(
                observed(
                    "Drop box contents: 53 entries\n"
                    "Max entries: 1000\n"
                    f"Searching for: {tag}\n\n"
                    "(No entries found.)\n"
                ),
                tag,
            )
        for result in (
            observed(""),
            observed("(No entries found.)\n"),
            observed("", returncode=1),
            observed("", stderr="dropbox unavailable"),
        ):
            with self.assertRaises(RuntimeGateError):
                validate_dropbox_observation(result, "data_app_anr")

        class StubAdb:
            def __init__(self, result: subprocess.CompletedProcess[str]):
                self.result = result
                self.commands: list[tuple[str, ...]] = []

            def run(self, args: Sequence[str], **_kwargs) -> subprocess.CompletedProcess[str]:
                self.commands.append(tuple(args))
                return self.result

        with tempfile.TemporaryDirectory() as temporary:
            driver = object.__new__(OtaRuntimeDriver)
            driver.evidence = Path(temporary)
            driver.events = []
            driver.adb = StubAdb(observed("", returncode=1, stderr="failed"))
            with self.assertRaises(RuntimeGateError):
                driver.assert_unknown_source_denied("before")
            self.assertTrue((driver.evidence / "unknown-source-before.txt").is_file())
            self.assertTrue((driver.evidence / "unknown-source-before-status.txt").is_file())
            self.assertEqual(
                driver.adb.commands,
                [("shell", "cmd", "appops", "get", PRODUCT_PACKAGE, "REQUEST_INSTALL_PACKAGES")],
            )

            driver.adb = StubAdb(observed("", returncode=1, stderr="failed"))
            with self.assertRaises(RuntimeGateError):
                driver.assert_no_residual_update_apks()
            self.assertTrue((driver.evidence / "update-files.txt").is_file())
            self.assertTrue((driver.evidence / "update-files-status.txt").is_file())
            self.assertEqual(
                driver.adb.commands,
                [(
                    "shell", "find",
                    f"/sdcard/Android/data/{PRODUCT_PACKAGE}/files/Download/updates",
                    "-maxdepth", "1", "-type", "f", "-name", "*.apk", "-print",
                )],
            )

            driver.adb = StubAdb(observed(""))
            with self.assertRaises(RuntimeGateError):
                driver.collect_diagnostics()
            self.assertTrue((driver.evidence / "logcat.txt").is_file())
            self.assertTrue((driver.evidence / "logcat-status.txt").is_file())

    def test_receipt_mode_is_explicit_and_strict_cannot_claim_reconsent(self) -> None:
        receipt = {
            "outcome": "passed", "persistentUiAutomationSession": True,
            "productPackage": PRODUCT_PACKAGE, "baselineVersion": BASELINE_VERSION,
            "targetVersion": TARGET_VERSION, "targetSha256": TARGET_SHA256,
            "productPermissionPageObserved": True, "permissionEnabledByTest": True,
            "installerSuccessObserved": True, "installerOpenObserved": True,
            "updatedProductObserved": True, "permissionCleanupObserved": True,
            "permissionBackReturnObserved": True,
            "otaMode": LEGACY_MANUAL_RECONSENT_MODE,
            "legacyManualReconsentUsed": True, "failure": None,
        }
        validate_receipt(receipt, LEGACY_MANUAL_RECONSENT_MODE)
        receipt["legacyManualReconsentUsed"] = False
        with self.assertRaises(RuntimeGateError):
            validate_receipt(receipt, LEGACY_MANUAL_RECONSENT_MODE)
        with self.assertRaises(RuntimeGateError):
            validate_receipt(receipt, STRICT_OTA_MODE)
        receipt["otaMode"] = STRICT_OTA_MODE
        validate_receipt(receipt, STRICT_OTA_MODE)
        receipt["legacyManualReconsentUsed"] = True
        with self.assertRaises(RuntimeGateError):
            validate_receipt(receipt, STRICT_OTA_MODE)

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
    verification_mode = parser.add_mutually_exclusive_group()
    verification_mode.add_argument("--verify-inputs-only", action="store_true")
    verification_mode.add_argument("--verify-apks-only", action="store_true")
    verification_mode.add_argument(
        "--fixed42-host-failure-diagnostics", action="store_true"
    )
    verification_mode.add_argument("--fixed42-device-capture-gate", action="store_true")
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--serial")
    parser.add_argument("--emulator-pid", default="")
    parser.add_argument("--emulator-pid-liveness")
    parser.add_argument("--emulator-exit-status")
    parser.add_argument("--runner-temp", type=Path)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--apksigner")
    parser.add_argument("--apkanalyzer")
    parser.add_argument("--automatic-binding", type=Path)
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
    parser.add_argument(
        "--ota-mode",
        choices=(STRICT_OTA_MODE, LEGACY_MANUAL_RECONSENT_MODE),
        default=STRICT_OTA_MODE,
        help=(
            "strict is the unchanged default; legacy-manual-reconsent admits one exact "
            "product tap; --automatic-binding selects the admitted automatic mode"
        ),
    )
    args = parser.parse_args(argv)
    if args.self_test is None:
        if args.fixed42_device_capture_gate:
            required = ["evidence"]
        elif args.fixed42_host_failure_diagnostics:
            required = [
                "serial", "emulator_pid_liveness", "emulator_exit_status",
                "runner_temp", "workspace", "evidence",
            ]
        elif args.verify_apks_only:
            required = [
                "baseline_apk", "target_apk", "apksigner", "apkanalyzer",
                "automatic_binding", "evidence",
            ]
        else:
            required = [
                "baseline_apk", "target_apk", "target_manifest", "target_verification",
                "target_checksums", "release_pages", "evidence",
            ]
        if (
            not args.verify_inputs_only
            and not args.verify_apks_only
            and not args.fixed42_host_failure_diagnostics
            and not args.fixed42_device_capture_gate
        ):
            required += [
                "serial", "apksigner", "harness_app", "harness_test",
                "harness_app_sha256", "harness_test_sha256",
            ]
            if args.automatic_binding is not None:
                required.append("apkanalyzer")
        missing = [name for name in required if getattr(args, name) in {None, ""}]
        if missing:
            parser.error("missing required runtime arguments: " + ", ".join(sorted(set(missing))))
        if args.automatic_binding is not None and args.ota_mode != STRICT_OTA_MODE:
            parser.error("--automatic-binding cannot be combined with legacy recovery mode")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.self_test is not None:
        return run_self_tests(args.self_test or None)
    if args.fixed42_device_capture_gate:
        return 0 if fixed42_device_capture_available(args.evidence) else 1
    if args.fixed42_host_failure_diagnostics:
        try:
            collect_fixed42_host_failure_diagnostics(
                evidence=args.evidence,
                adb=args.adb,
                serial=args.serial,
                emulator_pid=args.emulator_pid,
                emulator_pid_liveness=args.emulator_pid_liveness,
                emulator_exit_status=args.emulator_exit_status,
                runner_temp=args.runner_temp,
                workspace=args.workspace,
            )
            return 0
        except Exception as caught:
            print(f"{type(caught).__name__}: {caught}", file=sys.stderr)
            return 1
    if args.verify_inputs_only:
        try:
            binding = binding_from_args(args)
            validate_host_inputs(args, binding)
            args.evidence.mkdir(parents=True, exist_ok=True)
            if binding.automatic:
                preflight = (
                    f"publicBaseline={binding.baseline_version}\n"
                    f"publicTarget={binding.target_version}\n"
                    f"otaMode={binding.ota_mode}\n"
                    "publicPreflight=passed\n"
                )
            else:
                preflight = "publicTarget=2.3.26\npublicPreflight=passed\n"
            (args.evidence / "public-preflight.txt").write_text(preflight)
            return 0
        except Exception as caught:
            print(f"{type(caught).__name__}: {caught}", file=sys.stderr)
            return 1
    if args.verify_apks_only:
        try:
            binding = binding_from_args(args)
            if not binding.automatic:
                raise RuntimeGateError("APK-only verification is reserved for automatic mode")
            validate_file(
                args.baseline_apk, binding.baseline_sha256, binding.baseline_size,
                "baseline APK",
            )
            validate_file(args.target_apk, binding.target_sha256, binding.target_size, "target APK")
            verify_downloaded_apk_identities(
                args.baseline_apk, args.target_apk, args.apksigner, args.apkanalyzer, binding
            )
            args.evidence.mkdir(parents=True, exist_ok=True)
            (args.evidence / "downloaded-apk-identities.txt").write_text(
                f"baseline={binding.baseline_version}\n"
                f"target={binding.target_version}\n"
                f"signerSha256={binding.signer_pin}\n"
                "downloadedApkIdentities=passed\n"
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
