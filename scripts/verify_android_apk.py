#!/usr/bin/env python3
"""Verify a signed production phone APK without accessing signing secrets."""
import argparse
import hmac
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree

PACKAGE = "com.tgk30.debridstreamer"
ABIS = ("arm64-v8a", "armeabi-v7a", "x86", "x86_64")
ELF_ARCHITECTURES = {"arm64-v8a": (2, 183), "armeabi-v7a": (1, 40), "x86": (1, 3), "x86_64": (2, 62)}
ANDROID = "{http://schemas.android.com/apk/res/android}"
INTERNET = "android.permission.INTERNET"
DYNAMIC_PERMISSION = f"{PACKAGE}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"
MAX_LIBRARY_BYTES = 256 * 1024 * 1024
MAX_TOTAL_NATIVE_BYTES = 1024 * 1024 * 1024
FORBIDDEN = tuple(value.lower() for value in (
    b"com.tgk30.debridstreamer.audit", b"com/tgk30/debridstreamer/audit",
    b"AuditRunner", b"AndroidAuditTest", b"androidx.test", b"androidx/test",
    b"test-driver", b"test_driver", b"testdriver", b"auditPassed",
    b"__AUDIT_START__", b"__AUDIT_GET_STATE__", b"specificity-final-fixture",
))


class VerificationError(Exception):
    pass


def version_code(version):
    match = re.fullmatch(r"([0-9]+)\.([0-9]+)\.([0-9]+)", version)
    if not match:
        raise VerificationError("version must be numeric major.minor.patch")
    major, minor, patch = map(int, match.groups())
    if minor > 999 or patch > 999:
        raise VerificationError("minor and patch versions must fit three digits")
    return major * 1_000_000 + minor * 1_000 + patch


def normalize_pin(text):
    value = text.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", value):
        raise VerificationError("certificate pin must contain exactly 64 hexadecimal characters")
    return value


def is_signature_protection_level(value):
    if value == "signature":
        return True
    if not isinstance(value, str):
        return False
    if re.fullmatch(r"[0-9]+", value):
        return int(value, 10) == 2
    if re.fullmatch(r"0[xX][0-9A-Fa-f]+", value):
        return int(value, 16) == 2
    return False


def checked_output(command, label):
    try:
        result = subprocess.run(command, capture_output=True, check=False, timeout=300)
    except (OSError, subprocess.TimeoutExpired):
        raise VerificationError(f"{label} failed") from None
    if result.returncode != 0:
        raise VerificationError(f"{label} failed")
    try:
        return result.stdout.decode("utf-8")
    except UnicodeDecodeError:
        raise VerificationError(f"{label} returned invalid text") from None


def validate_signature(output, expected_pin):
    counts = re.findall(r"^Number of signers:\s*([0-9]+)\s*$", output, re.MULTILINE)
    digests = re.findall(r"^Signer #1 certificate SHA-256 digest:\s*([0-9A-Fa-f: ]+)\s*$", output, re.MULTILINE)
    if counts != ["1"] or len(digests) != 1:
        raise VerificationError("APK must have exactly one signer")
    actual = re.sub(r"[:\s]", "", digests[0]).lower()
    if not re.fullmatch(r"[0-9a-f]{64}", actual):
        raise VerificationError("APK signer digest is malformed")
    if not hmac.compare_digest(actual, expected_pin):
        raise VerificationError("APK signing certificate does not match the pinned certificate")


def parse_manifest(xml, expected_version):
    if len(xml) > 4 * 1024 * 1024:
        raise VerificationError("manifest output is unexpectedly large")
    start = xml.find("<manifest")
    if start < 0:
        raise VerificationError("APK manifest is missing")
    try:
        root = ElementTree.fromstring(xml[start:])
    except ElementTree.ParseError:
        raise VerificationError("APK manifest is malformed") from None
    if root.attrib.get("package") != PACKAGE:
        raise VerificationError("APK package identity is not the production phone package")
    if root.attrib.get(f"{ANDROID}versionName") != expected_version:
        raise VerificationError("APK version name does not match the release")
    if root.attrib.get(f"{ANDROID}versionCode") != str(version_code(expected_version)):
        raise VerificationError("APK version code does not match the release")
    sdk = root.find("uses-sdk")
    if sdk is None or sdk.attrib.get(f"{ANDROID}minSdkVersion") != "24":
        raise VerificationError("APK minSdk must be 24")
    if sdk.attrib.get(f"{ANDROID}targetSdkVersion") != "36":
        raise VerificationError("APK targetSdk must be 36")
    applications = root.findall("application")
    if len(applications) != 1:
        raise VerificationError("APK must contain exactly one application")
    for attribute in ("debuggable", "testOnly"):
        if applications[0].attrib.get(f"{ANDROID}{attribute}", "false").lower() not in ("false", "0"):
            raise VerificationError(f"production APK must not be {attribute}")
    if root.findall("instrumentation"):
        raise VerificationError("production APK must not contain instrumentation")
    if any(node.attrib.get(f"{ANDROID}name") == "android.software.leanback" for node in root.findall("uses-feature")):
        raise VerificationError("phone APK must not declare Leanback")
    if any(node.attrib.get(f"{ANDROID}name") == "android.intent.category.LEANBACK_LAUNCHER" for node in root.findall(".//category")):
        raise VerificationError("phone APK must not expose a Leanback launcher")
    nodes = [*root.findall("uses-permission"), *root.findall("uses-permission-sdk-23")]
    requested = [node.attrib.get(f"{ANDROID}name") for node in nodes]
    if None in requested or len(requested) != len(set(requested)):
        raise VerificationError("APK contains malformed or duplicate permission requests")
    allowed = {INTERNET}
    if version_code(expected_version) >= version_code("2.3.14"):
        allowed.add("android.permission.REQUEST_INSTALL_PACKAGES")
        providers = [node for node in applications[0].findall("provider") if node.attrib.get(f"{ANDROID}authorities") == f"{PACKAGE}.updates"]
        if len(providers) != 1:
            raise VerificationError("APK must contain exactly one dedicated update provider")
        provider = providers[0]
        if provider.attrib.get(f"{ANDROID}name") not in (".YawfUpdateFileProvider", f"{PACKAGE}.YawfUpdateFileProvider") or provider.attrib.get(f"{ANDROID}exported") != "false" or provider.attrib.get(f"{ANDROID}grantUriPermissions") != "true":
            raise VerificationError("APK update provider is not restricted")
        metadata = provider.findall("meta-data")
        if len(metadata) != 1 or metadata[0].attrib.get(f"{ANDROID}name") != "android.support.FILE_PROVIDER_PATHS" or metadata[0].attrib.get(f"{ANDROID}resource") != "@xml/yawf_update_paths":
            raise VerificationError("APK update provider paths metadata is invalid")
    if DYNAMIC_PERMISSION in requested:
        declarations = [node for node in root.findall("permission") if node.attrib.get(f"{ANDROID}name") == DYNAMIC_PERMISSION]
        if len(declarations) != 1 or not is_signature_protection_level(
            declarations[0].attrib.get(f"{ANDROID}protectionLevel")
        ):
            raise VerificationError("AndroidX receiver permission is not signature protected")
        allowed.add(DYNAMIC_PERMISSION)
    if set(requested) != allowed:
        raise VerificationError("APK requests an unexpected Android permission")
    if any(node.attrib.get(f"{ANDROID}name") != DYNAMIC_PERMISSION for node in root.findall("permission")):
        raise VerificationError("APK declares an unexpected custom permission")



def validate_update_paths(xml):
    if len(xml) > 16384:
        raise VerificationError("APK update provider paths are oversized")
    try:
        root = ElementTree.fromstring(xml[xml.index("<paths"):])
    except (ValueError, ElementTree.ParseError):
        raise VerificationError("APK update provider paths are malformed") from None
    children = list(root)
    if root.tag != "paths" or root.attrib or len(children) != 1 or children[0].tag != "files-path" or children[0].attrib != {"name": "updates", "path": "updates/"} or list(children[0]):
        raise VerificationError("APK update provider must expose only internal updates files")


def safe_member_name(name):
    if not name or "\0" in name or "\\" in name or name.startswith("/"):
        return False
    normalized = name[:-1] if name.endswith("/") else name
    path = PurePosixPath(normalized)
    return normalized == path.as_posix() and normalized not in ("", ".") and ".." not in path.parts


def validate_inventory(infos):
    seen = set()
    libraries = {abi: {} for abi in ABIS}
    scan = []
    total = 0
    for info in infos:
        name = info.filename
        if not safe_member_name(name) or name in seen:
            raise VerificationError("APK contains an unsafe or duplicate ZIP member")
        seen.add(name)
        if stat.S_ISLNK(info.external_attr >> 16):
            raise VerificationError("APK must not contain symbolic links")
        if info.is_dir():
            continue
        parts = PurePosixPath(name).parts
        is_dex = len(parts) == 1 and re.fullmatch(r"classes[0-9]*\.dex", parts[0])
        is_asset = parts and parts[0] == "assets"
        is_native = parts and parts[0] == "lib"
        if is_native:
            if len(parts) != 3 or parts[1] not in libraries or not parts[2].endswith(".so"):
                raise VerificationError("APK contains an unexpected native-library path")
            if info.file_size > MAX_LIBRARY_BYTES:
                raise VerificationError("APK native library size exceeds the verification limit")
            total += info.file_size
            if total > MAX_TOTAL_NATIVE_BYTES:
                raise VerificationError("APK total native size exceeds the verification limit")
            libraries[parts[1]][parts[2]] = info
        if is_dex or is_asset or is_native:
            scan.append(info)
    if any(not libraries[abi] for abi in ABIS):
        raise VerificationError("APK does not contain native libraries for all four required ABIs")
    names = [set(libraries[abi]) for abi in ABIS]
    if any(value != names[0] for value in names[1:]):
        raise VerificationError("APK native-library inventory differs between ABIs")
    if "libdebridstreamer_lib.so" not in names[0]:
        raise VerificationError("APK is missing libdebridstreamer_lib.so")
    return [libraries[abi][name] for abi in ABIS for name in sorted(names[0])], scan


def scan_forbidden_chunks(chunks):
    carry = b""
    overlap = max(map(len, FORBIDDEN)) - 1
    for chunk in chunks:
        data = (carry + chunk).lower()
        for needle in FORBIDDEN:
            if needle in data:
                return needle
        carry = data[-overlap:]
    return None


def validate_native_header(header, abi):
    if len(header) < 20 or header[:4] != b"\x7fELF" or header[5] != 1:
        raise VerificationError("APK native library is not a supported ELF")
    elf_class, machine = ELF_ARCHITECTURES[abi]
    if header[4] != elf_class or int.from_bytes(header[18:20], "little") != machine:
        raise VerificationError("APK native library architecture does not match its ABI")
    if int.from_bytes(header[16:18], "little") != 3:
        raise VerificationError("APK native library is not a shared object")


def stream_chunks(source, limit):
    total = 0
    while True:
        chunk = source.read(1024 * 1024)
        if not chunk:
            return
        total += len(chunk)
        if total > limit:
            raise VerificationError("APK member exceeds the verification size limit")
        yield chunk


def locate_sdk_tools(sdk):
    build = sdk / "build-tools/36.0.0"
    if not all((build / name).is_file() for name in ("apksigner", "zipalign")):
        raise VerificationError("Android build-tools 36.0.0 are missing")
    analyzers = [sdk / "cmdline-tools/latest/bin/apkanalyzer", *sorted((sdk / "cmdline-tools").glob("*/bin/apkanalyzer"), reverse=True), sdk / "tools/bin/apkanalyzer"]
    analyzer = next((path for path in analyzers if path.is_file()), None)
    if analyzer is None:
        raise VerificationError("required Android SDK tools are missing")
    return analyzer, build / "apksigner", build / "zipalign"


def verify(apk, version, pin_file, sdk):
    if not apk.is_file() or not pin_file.is_file() or not sdk.is_dir():
        raise VerificationError("APK, certificate pin, or Android SDK path is missing")
    expected_pin = normalize_pin(pin_file.read_text(encoding="ascii"))
    analyzer, apksigner, zipalign = locate_sdk_tools(sdk)
    signature = checked_output([str(apksigner), "verify", "--verbose", "--print-certs", str(apk)], "APK signature verification")
    validate_signature(signature, expected_pin)
    checked_output([str(zipalign), "-c", "-P", "16", "4", str(apk)], "16 KiB APK ZIP alignment verification")
    parse_manifest(checked_output([str(analyzer), "manifest", "print", str(apk)], "APK manifest inspection"), version)
    if version_code(version) >= version_code("2.3.14"):
        validate_update_paths(checked_output([str(analyzer), "resources", "xml", "--file", "res/xml/yawf_update_paths.xml", str(apk)], "APK update paths inspection"))
    with zipfile.ZipFile(apk) as archive, tempfile.TemporaryDirectory(prefix="yawf-apk-verify-") as temporary:
        native, scan = validate_inventory(archive.infolist())
        for info in scan:
            with archive.open(info) as source:
                if scan_forbidden_chunks(stream_chunks(source, 512 * 1024 * 1024)):
                    raise VerificationError("production APK contains test-only content")
        paths = []
        total = 0
        for info in native:
            _, abi, filename = PurePosixPath(info.filename).parts
            destination = Path(temporary) / abi / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as source, destination.open("wb") as target:
                first = True
                for chunk in stream_chunks(source, MAX_LIBRARY_BYTES):
                    if first:
                        validate_native_header(chunk, abi)
                        first = False
                    total += len(chunk)
                    if total > MAX_TOTAL_NATIVE_BYTES:
                        raise VerificationError("APK total native size exceeds the verification limit")
                    target.write(chunk)
            paths.append(str(destination))
        node = shutil.which("node")
        checker = Path(__file__).with_name("check_android_elf_alignment.mjs")
        if node is None or not checker.is_file():
            raise VerificationError("native ELF checker is unavailable")
        checked_output([node, str(checker), *paths], "native ELF alignment verification")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--certificate-pin", type=Path, required=True)
    parser.add_argument("--sdk", type=Path, required=True)
    args = parser.parse_args()
    try:
        verify(args.apk, args.version, args.certificate_pin, args.sdk)
    except VerificationError as error:
        print(f"Android APK verification failed: {error}", file=sys.stderr)
        return 1
    except (OSError, UnicodeError, ValueError, RuntimeError, zipfile.BadZipFile):
        print("Android APK verification failed: unreadable or invalid artifact", file=sys.stderr)
        return 1
    print("Android APK verification passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
