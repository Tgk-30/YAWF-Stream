#!/usr/bin/env python3
"""Host-side admission and evidence gate for one signed Android TV APK.

The only product mutation is one plain ``adb install --no-streaming`` on a
fresh, owned emulator. All runtime input is performed by the isolated
persistent UiAutomation APK through semantic selectors and remote key events.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import tempfile
import time
import unittest
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable, Sequence

PRODUCT = "com.yawf.stream.tv"
HARNESS = "com.yawf.runtimeinstrumentation"
INSTRUMENTATION = f"{HARNESS}.test/androidx.test.runner.AndroidJUnitRunner"
TEST_CLASS = f"{HARNESS}.RuntimeTvFlowTest#signedTvPackageCompletesNativePlaybackTransaction"
EVIDENCE_SUBDIR = "persistent-tv-flow"
FIXTURE_AUDIT = "http://127.0.0.1:4190/__audit"
HEX64 = re.compile(r"[0-9a-f]{64}")
SHA40 = re.compile(r"[0-9a-f]{40}")
CAPTURE = re.compile(r"(?:0[1-9]|[12][0-9]|3[0-2])-[a-z0-9-]+\.(?:png|xml)")
ALLOWED_FIXED = {"actions.txt": 128 * 1024, "instrumentation-tv-receipt.json": 32 * 1024}
MAX_FILES = 68
URL = re.compile(r"https?://[^\s\]\[\"'<>]+", re.IGNORECASE)
BEARER = re.compile(r"Bearer\s+[A-Za-z0-9._~+/-]+", re.IGNORECASE)
AUTH_HEADER = re.compile(r"(?i)(Authorization:)\s*[^\s]+")


class GateError(RuntimeError):
    pass


def redact_diagnostics(value: str) -> str:
    value = URL.sub("<redacted-url>", value)
    value = BEARER.sub("Bearer <redacted>", value)
    return AUTH_HEADER.sub(r"\1 <redacted>", value)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def evidence_limit(name: str) -> int:
    if name in ALLOWED_FIXED:
        return ALLOWED_FIXED[name]
    if not CAPTURE.fullmatch(name):
        raise GateError(f"unexpected persistent evidence file: {name!r}")
    return 8 * 1024 * 1024 if name.endswith(".png") else 1024 * 1024


def validate_pins(args: argparse.Namespace) -> None:
    values = [args.apk_sha256, args.signer_sha256]
    if any(not HEX64.fullmatch(value) for value in values):
        raise GateError("APK and signer SHA-256 pins must be exact lowercase hashes")
    if not SHA40.fullmatch(args.source_revision):
        raise GateError("source revision must be an exact lowercase commit hash")
    if args.apk_size <= 0 or args.version_code <= 0:
        raise GateError("size and version code pins must be positive")
    if "REPLACE" in " ".join(str(value) for value in vars(args).values()):
        raise GateError("unresolved fail-closed placeholder")
    if args.serial != "emulator-5556":
        raise GateError("runtime gate is pinned to its one fresh owned emulator serial")
    if args.fixture_audit != FIXTURE_AUDIT:
        raise GateError("fixture audit URL must stay fixed and loopback-only")


def validate_static_transport(
    root: Path, *, release_id: int, asset_id: int, release_tag: str,
    source_revision: str, asset_name: str, asset_size: int, asset_sha256: str,
) -> dict[str, object]:
    if release_id <= 0 or asset_id <= 0 or asset_size <= 0:
        raise GateError("static transport numeric pins must be positive")
    if not SHA40.fullmatch(source_revision) or not HEX64.fullmatch(asset_sha256):
        raise GateError("static transport source/hash pins must be exact lowercase hashes")
    if asset_name != Path(asset_name).name or release_tag != "v2.3.28-web":
        raise GateError("static transport tag or asset name was outside the fixed gate")
    root = root.resolve()
    expected = {asset_name, "release-metadata.json", "asset-metadata.json", "transport-binding.json"}
    if not root.is_dir() or {path.name for path in root.iterdir() if path.is_file()} != expected:
        raise GateError("static transport did not contain the exact asset and metadata file set")
    try:
        release = json.loads((root / "release-metadata.json").read_text())
        asset = json.loads((root / "asset-metadata.json").read_text())
        binding = json.loads((root / "transport-binding.json").read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise GateError("static transport metadata was unreadable") from error
    if release.get("id") != release_id or release.get("tag_name") != release_tag:
        raise GateError("draft release metadata did not match fixed release pins")
    if release.get("draft") is not True or release.get("prerelease") is not False:
        raise GateError("TV runtime transport must come from the exact draft non-prerelease")
    if asset.get("id") != asset_id or asset.get("name") != asset_name or asset.get("size") != asset_size:
        raise GateError("draft asset metadata did not match fixed identity pins")
    if not str(asset.get("url", "")).endswith(f"/releases/assets/{asset_id}"):
        raise GateError("draft asset API URL was not scoped to the fixed asset ID")
    release_assets = {item.get("id"): item for item in release.get("assets", []) if isinstance(item, dict)}
    if release_assets.get(asset_id, {}).get("name") != asset_name:
        raise GateError("fixed asset was absent from fixed draft release metadata")
    expected_binding = {
        "schemaVersion": 1, "releaseId": release_id, "assetId": asset_id,
        "releaseTag": release_tag, "sourceRevision": source_revision,
        "assetName": asset_name, "assetSize": asset_size, "assetSha256": asset_sha256,
        "privilegedStaticTransport": True, "credentialValuesPersisted": False,
    }
    if binding != expected_binding:
        raise GateError("root static transport binding metadata did not match every fixed pin")
    apk = root / asset_name
    if apk.stat().st_size != asset_size or file_sha256(apk) != asset_sha256:
        raise GateError("transported TV APK bytes did not match fixed size/hash pins")
    digest = asset.get("digest")
    if digest not in (None, f"sha256:{asset_sha256}"):
        raise GateError("GitHub asset digest contradicted the fixed APK hash")
    return binding


def admission_check(command: Sequence[str], product_apk: Path) -> None:
    joined = " ".join(command)
    forbidden = (" shell pm install", " push ", " sync ", " install-multiple", " install-write")
    if any(item in f" {joined} " for item in forbidden):
        raise GateError(f"forbidden product transfer/install route: {joined}")
    if " install " in f" {joined} " and str(product_apk) in command:
        if list(command)[-3:] != ["install", "--no-streaming", str(product_apk)]:
            raise GateError("product APK permits exactly one plain non-replacement install route")


class Runner:
    def __init__(self, evidence: Path, product_apk: Path):
        self.evidence = evidence
        self.product_apk = product_apk
        self.product_installs = 0

    def run(self, command: Sequence[str], *, timeout: int = 60, check: bool = True, text: bool = True):
        command = [str(item) for item in command]
        admission_check(command, self.product_apk)
        if "install" in command and str(self.product_apk) in command:
            self.product_installs += 1
            if self.product_installs != 1:
                raise GateError("more than one product install was attempted")
        completed = subprocess.run(command, capture_output=True, text=text, timeout=timeout)
        if check and completed.returncode:
            tail = completed.stderr if text else b""
            raise GateError(f"command failed ({completed.returncode}): {' '.join(command[:4])}: {tail[-2000:]!r}")
        return completed


def parse_devices(output: str, serial: str) -> None:
    devices = []
    for line in output.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "device":
            devices.append(parts[0])
    if devices != [serial]:
        raise GateError(f"expected only owned serial {serial}; online devices were {devices}")


def parse_signer(output: str) -> str:
    values = re.findall(r"certificate SHA-256 digest:\s*([0-9A-Fa-f:]+)", output)
    normalized = {value.replace(":", "").lower() for value in values}
    if len(normalized) != 1 or not HEX64.fullmatch(next(iter(normalized), "")):
        raise GateError("APK did not have exactly one parseable signer digest")
    return next(iter(normalized))


def apk_abis(path: Path) -> list[str]:
    abis = set()
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            match = re.fullmatch(r"lib/([^/]+)/[^/]+\.so", name)
            if match:
                abis.add(match.group(1))
    return sorted(abis)


def validate_runtime_receipt(value: dict[str, object]) -> None:
    if value.get("outcome") != "passed" or value.get("productPackage") != PRODUCT:
        raise GateError("persistent TV transaction did not pass for the exact product package")
    if value.get("nativeBridgeFixture") is not True or value.get("productionEmbeddedPlayerRoute") is not False:
        raise GateError("fixture classification was absent or misleading")
    checks = value.get("checks")
    if not isinstance(checks, dict):
        raise GateError("TV receipt checks were missing")
    required_true = (
        "serverAddressEnteredThroughUi", "normalConnectFlowReachedFixture",
        "nativePlayerOpened", "playingPositionAdvanced", "decodedFrameChanged",
        "pauseStable", "englishAudioSelected", "frenchAudioSelected",
        "resumedAfterTrackSelection", "backRestoredWebFocus", "nativePlayerReentered",
        "nativeErrorSurfaced", "playbackRecoveredAfterError", "menuOpenedSetupOutsidePlayer",
        "non16By9SourcePlayed",
    )
    missing = [key for key in required_true if checks.get(key) is not True]
    if missing:
        raise GateError(f"semantic runtime claims missing: {missing}")
    if not isinstance(checks.get("seekDeltaSeconds"), (int, float)) or checks["seekDeltaSeconds"] < 10:
        raise GateError("receipt did not prove a meaningful D-pad seek")
    if checks.get("sourceAspectRatio") != "4:3":
        raise GateError("receipt did not bind the non-16:9 source")
    if checks.get("fitSelectorSupported") is not False or checks.get("fitGeometryVerified") is not False:
        raise GateError("unsupported fit selector must remain an explicit non-pass")


def validate_fixture_audit(value: dict[str, object]) -> None:
    if value.get("nativeBridgeFixture") is not True or value.get("authorizationValuesPersisted") is not False:
        raise GateError("fixture audit classification invalid")
    requests = value.get("requests")
    if not isinstance(requests, list) or not requests:
        raise GateError("fixture logged no native media requests")
    paths = []
    for event in requests:
        if not isinstance(event, dict) or not isinstance(event.get("path"), str):
            raise GateError("malformed fixture audit event")
        if event.get("authorized") is not True:
            raise GateError("a native media request lacked the expected fixed fixture authorization")
        paths.append(event["path"])
    for expected in ("/media/master.m3u8", "/media/video.m3u8", "/media/audio-fr.m3u8", "/media/audio-en.m3u8", "/media/missing.m3u8"):
        if expected not in paths:
            raise GateError(f"fixture never observed {expected}")
    meaningful_segments = []
    for sequence, path in enumerate(paths):
        match = re.fullmatch(r"/media/audio-(fr|en)-(\d+)\.ts", path)
        if match and int(match.group(2)) >= 2:
            meaningful_segments.append((sequence, match.group(1), int(match.group(2))))
    try:
        french_before = next(item for item in meaningful_segments if item[1] == "fr")
        english_after = next(item for item in meaningful_segments
                             if item[0] > french_before[0] and item[1] == "en")
        next(item for item in meaningful_segments
             if item[0] > english_after[0] and item[1] == "fr")
    except StopIteration as error:
        raise GateError(
            f"fixture did not prove sustained French to English to French media requests: {meaningful_segments}"
        ) from error
    missing_index = paths.index("/media/missing.m3u8")
    if "/media/master.m3u8" not in paths[missing_index + 1:]:
        raise GateError("fixture did not observe successful media recovery after the missing stream")


def scan_fatal(package: str, *texts: str) -> None:
    escaped = re.escape(package)
    patterns = [
        rf"(?m)^\s*ANR in {escaped}(?:\s|$)",
        rf"(?m)^\s*Process:\s*{escaped}(?:,|\s*$)",
        rf"(?m)^.*FATAL EXCEPTION.*\n(?:.*\n){{0,12}}.*Process:\s*{escaped}(?:,|\s*$)",
    ]
    joined = "\n".join(texts)
    if any(re.search(pattern, joined) for pattern in patterns):
        raise GateError("app-attributed crash or ANR evidence found")


def retrieve_internal_evidence(runner: Runner, adb: list[str], destination: Path) -> dict[str, object]:
    base = f"files/{EVIDENCE_SUBDIR}"
    listing = runner.run(adb + ["shell", "run-as", HARNESS, "ls", "-1", base], timeout=20).stdout
    names = [line.rstrip("\r") for line in listing.splitlines() if line.strip()]
    if not names or len(names) > MAX_FILES or len(names) != len(set(names)):
        raise GateError("persistent evidence listing was empty, duplicate, or over bound")
    for name in names:
        if name != Path(name).name:
            raise GateError("unsafe persistent evidence name")
        limit = evidence_limit(name)
        size_text = runner.run(adb + ["shell", "run-as", HARNESS, "stat", "-c", "%s", f"{base}/{name}"], timeout=20).stdout.strip()
        if not size_text.isdigit() or int(size_text) <= 0 or int(size_text) > limit:
            raise GateError(f"persistent evidence size invalid for {name}")
        content = runner.run(adb + ["exec-out", "run-as", HARNESS, "cat", f"{base}/{name}"], timeout=30, text=False).stdout
        if len(content) != int(size_text):
            raise GateError(f"partial persistent evidence read for {name}")
        (destination / name).write_bytes(content)
    receipt_path = destination / "instrumentation-tv-receipt.json"
    if not receipt_path.is_file():
        raise GateError("persistent TV receipt missing")
    receipt = json.loads(receipt_path.read_text())
    validate_runtime_receipt(receipt)
    return receipt


def verify_apk(args: argparse.Namespace, runner: Runner) -> dict[str, object]:
    apk = args.apk.resolve()
    if not apk.is_file() or apk.stat().st_size != args.apk_size or file_sha256(apk) != args.apk_sha256:
        raise GateError("signed TV APK bytes did not match fixed size/hash pins")
    package = runner.run([args.apkanalyzer, "manifest", "application-id", apk]).stdout.strip()
    version = runner.run([args.apkanalyzer, "manifest", "version-name", apk]).stdout.strip()
    code = runner.run([args.apkanalyzer, "manifest", "version-code", apk]).stdout.strip()
    if (package, version, code) != (PRODUCT, args.version_name, str(args.version_code)):
        raise GateError(f"manifest identity mismatch: {(package, version, code)}")
    signer = parse_signer(runner.run([args.apksigner, "verify", "--print-certs", apk]).stdout)
    if signer != args.signer_sha256:
        raise GateError("TV APK signer did not match fixed production pin")
    abis = apk_abis(apk)
    if abis and "x86_64" not in abis:
        raise GateError(f"TV APK contains native libraries but no x86_64 ABI: {abis}")
    return {"package": package, "versionName": version, "versionCode": int(code), "signerSha256": signer,
            "apkSha256": args.apk_sha256, "apkSize": args.apk_size, "nativeAbis": abis,
            "abiClassification": "native-x86_64-compatible" if abis else "universal-no-native-libraries",
            "sourceRevision": args.source_revision}


def main_run(args: argparse.Namespace) -> None:
    validate_pins(args)
    args.evidence.mkdir(parents=True, exist_ok=True)
    runner = Runner(args.evidence, args.apk.resolve())
    identity = verify_apk(args, runner)
    (args.evidence / "artifact-identity.json").write_text(json.dumps(identity, indent=2, sort_keys=True) + "\n")
    adb = [args.adb, "-s", args.serial]
    parse_devices(runner.run([args.adb, "devices"], timeout=15).stdout, args.serial)
    existing_package = runner.run(adb + ["shell", "pm", "path", PRODUCT], check=False).stdout.strip()
    if existing_package:
        raise GateError("fresh emulator already contained the TV product package")
    runner.run(adb + ["install", "--no-streaming", args.apk.resolve()], timeout=180)
    if runner.product_installs != 1:
        raise GateError("exactly one admitted product install was not observed")
    runner.run(adb + ["install", "-r", args.harness_app], timeout=120)
    runner.run(adb + ["install", "-r", "-t", args.harness_test], timeout=120)

    package_dump = runner.run(adb + ["shell", "dumpsys", "package", PRODUCT], timeout=30).stdout
    (args.evidence / "installed-package.txt").write_text(package_dump)
    path_output = runner.run(adb + ["shell", "pm", "path", PRODUCT], timeout=20).stdout.strip()
    match = re.fullmatch(r"package:(/data/app/[^\r\n]+/base\.apk)", path_output)
    if match is None:
        raise GateError("installed base APK path was not singular and package-scoped")
    installed = args.evidence / "installed-base.apk"
    runner.run(adb + ["pull", match.group(1), installed], timeout=120)
    if file_sha256(installed) != args.apk_sha256:
        raise GateError("installed base APK bytes differ from the signed candidate")

    command = adb + ["shell", "am", "instrument", "-w", "-r",
        "-e", "class", TEST_CLASS,
        "-e", "evidenceSubdir", EVIDENCE_SUBDIR,
        "-e", "fixtureUrl", "http://127.0.0.1:4190",
        INSTRUMENTATION]
    result = runner.run(command, timeout=420, check=False)
    (args.evidence / "instrumentation-output.txt").write_text(
        redact_diagnostics(result.stdout + result.stderr))
    retrieval_error = None
    try:
        receipt = retrieve_internal_evidence(runner, adb, args.evidence)
    except Exception as error:  # Preserve the exact runner output as primary.
        retrieval_error = error
        (args.evidence / "evidence-retrieval-error.txt").write_text(f"{type(error).__name__}: {error}\n")
        receipt = None
    if result.returncode or "FAILURES!!!" in result.stdout or "OK (1 test)" not in result.stdout:
        raise GateError("persistent TV instrumentation failed; exact runner output retained")
    if retrieval_error:
        raise retrieval_error
    assert receipt is not None

    logcat = runner.run(adb + ["logcat", "-d", "-v", "threadtime"], timeout=30).stdout
    dropbox = runner.run(adb + ["shell", "dumpsys", "dropbox", "--print", "data_app_anr", "system_app_anr", "SYSTEM_TOMBSTONE"], timeout=30, check=False).stdout
    (args.evidence / "logcat.txt").write_text(redact_diagnostics(logcat))
    (args.evidence / "dropbox.txt").write_text(redact_diagnostics(dropbox))
    scan_fatal(PRODUCT, logcat, dropbox)

    with urllib.request.urlopen(args.fixture_audit, timeout=10) as response:
        audit_bytes = response.read(2 * 1024 * 1024 + 1)
    if len(audit_bytes) > 2 * 1024 * 1024:
        raise GateError("fixture audit exceeded its byte bound")
    audit = json.loads(audit_bytes)
    validate_fixture_audit(audit)
    (args.evidence / "fixture-audit.json").write_text(json.dumps(audit, indent=2, sort_keys=True) + "\n")
    final = {"outcome": "passed", "identity": identity, "runtime": receipt,
             "fixtureAuditPassed": True, "productInstallCount": runner.product_installs,
             "fitSelectorStatus": "unsupported-not-a-pass"}
    (args.evidence / "RESULT.json").write_text(json.dumps(final, indent=2, sort_keys=True) + "\n")


class PolicyTests(unittest.TestCase):
    def args(self):
        return argparse.Namespace(apk_sha256="a" * 64, signer_sha256="b" * 64,
            source_revision="c" * 40, apk_size=123, version_code=20328,
            version_name="2.3.28", serial="emulator-5556", fixture_audit=FIXTURE_AUDIT,
            apk=Path("/tmp/tv.apk"), apkanalyzer="apkanalyzer", apksigner="apksigner",
            evidence=Path("/tmp/e"), adb="adb", harness_app=Path("/tmp/h.apk"), harness_test=Path("/tmp/ht.apk"))

    def test_pins_reject_placeholders_and_wrong_serial(self):
        args = self.args(); validate_pins(args)
        args.apk_sha256 = "REPLACE_TV_APK_SHA256"
        with self.assertRaises(GateError): validate_pins(args)
        args = self.args(); args.serial = "emulator-5554"
        with self.assertRaises(GateError): validate_pins(args)

    def test_product_install_admission_is_exact(self):
        apk = Path("/tmp/tv.apk")
        admission_check(["adb", "-s", "emulator-5556", "install", "--no-streaming", str(apk)], apk)
        for command in (["adb", "install", "-r", str(apk)], ["adb", "push", str(apk), "/data/local/tmp"],
                        ["adb", "shell", "pm", "install", "/data/local/tmp/tv.apk"]):
            with self.assertRaises(GateError): admission_check(command, apk)

    def test_runtime_receipt_rejects_click_only_claim(self):
        receipt = {"outcome": "passed", "productPackage": PRODUCT, "nativeBridgeFixture": True,
                   "productionEmbeddedPlayerRoute": False, "checks": {}}
        with self.assertRaises(GateError): validate_runtime_receipt(receipt)

    def test_runtime_receipt_requires_every_semantic_postcondition(self):
        checks = {key: True for key in (
            "serverAddressEnteredThroughUi", "normalConnectFlowReachedFixture", "nativePlayerOpened",
            "playingPositionAdvanced", "decodedFrameChanged", "pauseStable", "englishAudioSelected",
            "frenchAudioSelected", "resumedAfterTrackSelection", "backRestoredWebFocus",
            "nativePlayerReentered", "nativeErrorSurfaced", "playbackRecoveredAfterError",
            "menuOpenedSetupOutsidePlayer", "non16By9SourcePlayed")}
        checks.update({"seekDeltaSeconds": 15, "sourceAspectRatio": "4:3",
                       "fitSelectorSupported": False, "fitGeometryVerified": False})
        receipt = {"outcome": "passed", "productPackage": PRODUCT, "nativeBridgeFixture": True,
                   "productionEmbeddedPlayerRoute": False, "checks": checks}
        validate_runtime_receipt(receipt)
        checks["decodedFrameChanged"] = False
        with self.assertRaises(GateError): validate_runtime_receipt(receipt)

    def test_fixture_audit_requires_track_switches_and_recovery(self):
        paths = ["/media/master.m3u8", "/media/video.m3u8", "/media/audio-fr.m3u8",
                 "/media/audio-en.m3u8", "/media/audio-fr-000.ts", "/media/audio-fr-002.ts", "/media/audio-en-004.ts",
                 "/media/audio-fr-006.ts", "/media/missing.m3u8", "/media/master.m3u8"]
        audit = {"nativeBridgeFixture": True, "authorizationValuesPersisted": False,
                 "requests": [{"path": path, "authorized": True} for path in paths]}
        validate_fixture_audit(audit)
        audit["requests"] = [event for event in audit["requests"] if "audio-en-004" not in event["path"]]
        with self.assertRaises(GateError): validate_fixture_audit(audit)

    def test_crash_scanner_matches_exact_package_only(self):
        scan_fatal(PRODUCT, f"Process: {PRODUCT}.helper")
        with self.assertRaises(GateError): scan_fatal(PRODUCT, f"Process: {PRODUCT}")
        with self.assertRaises(GateError): scan_fatal(PRODUCT, f"Process: {PRODUCT}, PID: 42")

    def test_diagnostics_redact_urls_bearers_and_authorization_headers(self):
        redacted = redact_diagnostics(
            "GET https://example.invalid/private Authorization:secret Bearer abc.DEF-123")
        self.assertNotIn("https://", redacted)
        self.assertNotIn("secret", redacted)
        self.assertNotIn("abc.DEF-123", redacted)
        self.assertEqual(redacted, "GET <redacted-url> Authorization: <redacted> Bearer <redacted>")

    def test_static_transport_binds_exact_draft_source_asset_and_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            apk = root / "YAWF.Stream_Android.TV_2.3.28.apk"
            apk.write_bytes(b"signed-tv-fixture")
            digest = file_sha256(apk)
            release = {"id": 123, "tag_name": "v2.3.28-web", "draft": True,
                       "prerelease": False, "assets": [{"id": 456, "name": apk.name}]}
            asset = {"id": 456, "name": apk.name, "size": apk.stat().st_size,
                     "url": "https://api.github.com/repos/Tgk-30/YAWF-Stream/releases/assets/456",
                     "digest": f"sha256:{digest}"}
            binding = {"schemaVersion": 1, "releaseId": 123, "assetId": 456,
                       "releaseTag": "v2.3.28-web", "sourceRevision": "c" * 40,
                       "assetName": apk.name, "assetSize": apk.stat().st_size,
                       "assetSha256": digest, "privilegedStaticTransport": True,
                       "credentialValuesPersisted": False}
            (root / "release-metadata.json").write_text(json.dumps(release))
            (root / "asset-metadata.json").write_text(json.dumps(asset))
            (root / "transport-binding.json").write_text(json.dumps(binding))
            kwargs = dict(release_id=123, asset_id=456, release_tag="v2.3.28-web",
                          source_revision="c" * 40, asset_name=apk.name,
                          asset_size=apk.stat().st_size, asset_sha256=digest)
            validate_static_transport(root, **kwargs)
            binding["sourceRevision"] = "d" * 40
            (root / "transport-binding.json").write_text(json.dumps(binding))
            with self.assertRaises(GateError): validate_static_transport(root, **kwargs)
            binding["sourceRevision"] = "c" * 40
            (root / "transport-binding.json").write_text(json.dumps(binding))
            apk.write_bytes(b"corrupted-tv-fixture")
            with self.assertRaises(GateError): validate_static_transport(root, **kwargs)


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    value.add_argument("--self-test", action="store_true")
    value.add_argument("--validate-static-transport", action="store_true")
    value.add_argument("--transport-dir", type=Path)
    value.add_argument("--release-id", type=int)
    value.add_argument("--asset-id", type=int)
    value.add_argument("--release-tag")
    value.add_argument("--asset-name")
    value.add_argument("--apk", type=Path)
    value.add_argument("--apk-sha256")
    value.add_argument("--apk-size", type=int)
    value.add_argument("--signer-sha256")
    value.add_argument("--source-revision")
    value.add_argument("--version-name")
    value.add_argument("--version-code", type=int)
    value.add_argument("--serial", default="emulator-5556")
    value.add_argument("--adb", default="adb")
    value.add_argument("--apkanalyzer", default="apkanalyzer")
    value.add_argument("--apksigner", default="apksigner")
    value.add_argument("--harness-app", type=Path)
    value.add_argument("--harness-test", type=Path)
    value.add_argument("--fixture-audit", default=FIXTURE_AUDIT)
    value.add_argument("--evidence", type=Path)
    return value


if __name__ == "__main__":
    args = parser().parse_args()
    if args.self_test:
        raise SystemExit(0 if unittest.TextTestRunner(verbosity=2).run(
            unittest.defaultTestLoader.loadTestsFromTestCase(PolicyTests)).wasSuccessful() else 1)
    if args.validate_static_transport:
        required = (args.transport_dir, args.release_id, args.asset_id, args.release_tag,
                    args.source_revision, args.asset_name, args.apk_size, args.apk_sha256)
        if any(value is None for value in required):
            parser().error("static transport validation requires every fixed metadata and byte pin")
        validate_static_transport(
            args.transport_dir, release_id=args.release_id, asset_id=args.asset_id,
            release_tag=args.release_tag, source_revision=args.source_revision,
            asset_name=args.asset_name, asset_size=args.apk_size, asset_sha256=args.apk_sha256,
        )
        raise SystemExit(0)
    required = (args.apk, args.apk_sha256, args.apk_size, args.signer_sha256, args.source_revision,
                args.version_name, args.version_code, args.harness_app, args.harness_test, args.evidence)
    if any(value is None for value in required):
        parser().error("runtime mode requires every fixed identity and harness argument")
    main_run(args)
