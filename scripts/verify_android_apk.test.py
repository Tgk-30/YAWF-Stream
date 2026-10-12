#!/usr/bin/env python3
"""Pure production APK verifier fixtures. No signing keys or SDK needed."""
import io
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zipfile import ZipInfo
from verify_android_apk import (
    ABIS, DYNAMIC_PERMISSION, FORBIDDEN, MAX_LIBRARY_BYTES,
    MAX_TOTAL_NATIVE_BYTES, PACKAGE, VerificationError, checked_output,
    locate_sdk_tools, normalize_pin, parse_manifest, scan_forbidden_chunks,
    stream_chunks, validate_inventory, validate_signature, version_code,
    validate_native_header, ELF_ARCHITECTURES,
)

def accepts(function, *args):
    try:
        return function(*args)
    except VerificationError as error:
        raise AssertionError(f"Valid fixture was rejected: {error}") from None


PIN = "a" * 64
LIBRARY = "libdebridstreamer_lib.so"


def signer(digest=PIN, count=1):
    return f"Number of signers: {count}\nSigner #1 certificate SHA-256 digest: {digest}\n"


def manifest(**changes):
    values = dict(package=PACKAGE, version="2.3.7", code="2003007", minimum="24", target="36", attributes="", extra="", permissions="")
    values.update(changes)
    return '''<manifest xmlns:android="http://schemas.android.com/apk/res/android"
      package="{package}" android:versionName="{version}" android:versionCode="{code}">
      <uses-sdk android:minSdkVersion="{minimum}" android:targetSdkVersion="{target}" />
      <uses-permission android:name="android.permission.INTERNET" />{permissions}
      <application {attributes} /><!---->{extra}</manifest>'''.format(**values)


def entry(name, size=1024, mode=stat.S_IFREG | 0o644):
    info = ZipInfo(name)
    info.file_size = size
    info.external_attr = mode << 16
    return info


def inventory(size=1024, library=LIBRARY):
    return [entry("classes.dex"), entry("assets/app.js"), *[entry(f"lib/{abi}/{library}", size) for abi in ABIS]]


class VersionTests(unittest.TestCase):
    def test_phone_version_arithmetic(self):
        self.assertEqual(version_code("2.3.7"), 2003007)

    def test_numeric_version_and_component_bounds(self):
        for value in ("2.3", "2.3.7-rc1", "2.1000.7", "2.3.1000"):
            with self.subTest(value=value), self.assertRaises(VerificationError):
                version_code(value)

    def test_exact_certificate_pin_format(self):
        self.assertEqual(normalize_pin(PIN.upper() + "\n"), PIN)
        for value in (PIN[:-1], ":".join(PIN), "g" * 64):
            with self.subTest(value=value), self.assertRaises(VerificationError):
                normalize_pin(value)


class SignatureTests(unittest.TestCase):
    def test_one_pinned_signer(self):
        accepts(validate_signature, signer(), PIN)

    def test_signer_count_and_duplicate_digest(self):
        for value in (signer(count=2), signer().replace("Number of signers: 1\n", ""), signer() + signer()):
            with self.subTest(value=value), self.assertRaises(VerificationError):
                validate_signature(value, PIN)

    def test_wrong_signer_is_rejected(self):
        with self.assertRaisesRegex(VerificationError, "pinned certificate"):
            validate_signature(signer("b" + PIN[1:]), PIN)

    def test_subprocess_failure_is_redacted(self):
        result = SimpleNamespace(returncode=1, stdout=b"private material", stderr=b"private value")
        with patch("verify_android_apk.subprocess.run", return_value=result), self.assertRaises(VerificationError) as error:
            checked_output(["apksigner"], "signature check")
        self.assertEqual(str(error.exception), "signature check failed")


class ManifestTests(unittest.TestCase):
    def test_production_manifest(self):
        accepts(parse_manifest, manifest(), "2.3.7")

    def test_package_and_version_identity(self):
        for changes in (dict(package=PACKAGE + ".audit"), dict(version="2.3.6"), dict(code="2003006")):
            with self.subTest(changes=changes), self.assertRaises(VerificationError):
                parse_manifest(manifest(**changes), "2.3.7")

    def test_sdk_floor_and_target(self):
        for changes in (dict(minimum="23"), dict(target="35")):
            with self.subTest(changes=changes), self.assertRaises(VerificationError):
                parse_manifest(manifest(**changes), "2.3.7")

    def test_debug_and_test_only_are_rejected(self):
        for name in ("debuggable", "testOnly"):
            with self.subTest(name=name), self.assertRaises(VerificationError):
                parse_manifest(manifest(attributes=f'android:{name}="true"'), "2.3.7")

    def test_instrumentation_is_rejected(self):
        with self.assertRaises(VerificationError):
            parse_manifest(manifest(extra='<instrumentation android:name="AuditRunner" />'), "2.3.7")

    def test_leanback_is_rejected(self):
        for extra in ('<uses-feature android:name="android.software.leanback" />', '<category android:name="android.intent.category.LEANBACK_LAUNCHER" />'):
            with self.subTest(extra=extra), self.assertRaises(VerificationError):
                parse_manifest(manifest(extra=extra), "2.3.7")

    def test_only_expected_permissions(self):
        for name in ("android.permission.CAMERA", "android.permission.INTERNET"):
            with self.subTest(name=name), self.assertRaises(VerificationError):
                parse_manifest(manifest(permissions=f'<uses-permission android:name="{name}" />'), "2.3.7")

    def test_internal_receiver_permission_is_signature_protected(self):
        request = f'<uses-permission android:name="{DYNAMIC_PERMISSION}" />'
        declaration = f'<permission android:name="{DYNAMIC_PERMISSION}" android:protectionLevel="signature" />'
        accepts(parse_manifest, manifest(permissions=request, extra=declaration), "2.3.7")
        for extra in ("", declaration.replace("signature", "normal")):
            with self.subTest(extra=extra), self.assertRaises(VerificationError):
                parse_manifest(manifest(permissions=request, extra=extra), "2.3.7")

    def test_application_count_and_custom_permission(self):
        for xml in (manifest().replace('<application  />', ""), manifest(extra="<application />"), manifest(extra='<permission android:name="unexpected.PERMISSION" />')):
            with self.subTest(xml=xml), self.assertRaises(VerificationError):
                parse_manifest(xml, "2.3.7")

    def test_malformed_or_oversized_manifest(self):
        for xml in ("broken", "<manifest", " " * (4 * 1024 * 1024 + 1)):
            with self.subTest(size=len(xml)), self.assertRaises(VerificationError):
                parse_manifest(xml, "2.3.7")


class InventoryTests(unittest.TestCase):
    def test_four_matching_application_libraries(self):
        native, scan = accepts(validate_inventory, inventory())
        self.assertEqual({info.filename for info in native}, {f"lib/{abi}/{LIBRARY}" for abi in ABIS})
        self.assertEqual(len(scan), 6)

    def test_missing_or_extra_abi(self):
        for infos in (inventory()[:-1], inventory() + [entry(f"lib/mips/{LIBRARY}")]):
            with self.subTest(count=len(infos)), self.assertRaises(VerificationError):
                validate_inventory(infos)

    def test_identical_and_required_native_library_inventory(self):
        for infos in (inventory() + [entry("lib/x86/libextra.so")], inventory(library="libother.so"), inventory() + [entry("lib/x86/README")]):
            with self.subTest(count=len(infos)), self.assertRaises(VerificationError):
                validate_inventory(infos)

    def test_unsafe_duplicate_and_symlink_members(self):
        for unsafe in ("../classes.dex", "/classes.dex", "assets\\driver", "assets//driver", "assets/./driver", "classes.dex"):
            with self.subTest(unsafe=unsafe), self.assertRaises(VerificationError):
                validate_inventory(inventory() + [entry(unsafe)])
        with self.assertRaises(VerificationError):
            validate_inventory(inventory() + [entry("assets/link", mode=stat.S_IFLNK | 0o777)])

    def test_native_size_limits(self):
        accepts(validate_inventory, inventory(size=MAX_LIBRARY_BYTES))
        with self.assertRaisesRegex(VerificationError, "native library size"):
            validate_inventory(inventory(size=MAX_LIBRARY_BYTES + 1))
        infos = inventory(size=MAX_LIBRARY_BYTES) + [entry(f"lib/{abi}/extra.so") for abi in ABIS]
        with self.assertRaisesRegex(VerificationError, "total native"):
            validate_inventory(infos)
        self.assertEqual(MAX_LIBRARY_BYTES * 4, MAX_TOTAL_NATIVE_BYTES)

    def test_streaming_limit_is_enforced(self):
        with self.assertRaises(VerificationError):
            list(stream_chunks(io.BytesIO(b"12345"), 4))


class ContentAndToolTests(unittest.TestCase):
    def test_native_elf_matches_every_abi(self):
        for abi, (elf_class, machine) in ELF_ARCHITECTURES.items():
            header = bytearray(20)
            header[:4] = b"\x7fELF"
            header[4:6] = bytes([elf_class, 1])
            header[16:18] = (3).to_bytes(2, "little")
            header[18:20] = machine.to_bytes(2, "little")
            accepts(validate_native_header, header, abi)
            for offset, value in ((4, 3 - elf_class), (18, 255), (16, 2)):
                changed = bytearray(header)
                changed[offset] = value
                with self.subTest(abi=abi, offset=offset), self.assertRaises(VerificationError):
                    validate_native_header(changed, abi)

    def test_test_signatures_and_chunk_boundaries(self):
        for needle in FORBIDDEN:
            with self.subTest(needle=needle):
                self.assertIsNotNone(scan_forbidden_chunks([b"prefix" + needle.upper() + b"suffix"]))
                self.assertIsNotNone(scan_forbidden_chunks([needle[:4], needle[4:]]))
        self.assertIsNone(scan_forbidden_chunks([b"production auditing and media driver information"]))

    def test_exact_sdk_tools_are_required(self):
        with tempfile.TemporaryDirectory() as temp:
            sdk = Path(temp)
            paths = ["cmdline-tools/latest/bin/apkanalyzer", "build-tools/36.0.0/apksigner", "build-tools/36.0.0/zipalign"]
            for relative in paths:
                p = sdk / relative
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text("fixture")
            self.assertEqual(accepts(locate_sdk_tools, sdk), tuple(sdk / p for p in paths))
            (sdk / paths[2]).unlink()
            with self.assertRaises(VerificationError):
                locate_sdk_tools(sdk)


if __name__ == "__main__":
    unittest.main()
