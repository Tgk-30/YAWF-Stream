#!/usr/bin/env python3
"""Bounded black-box Android phone runtime check for a signed release APK.

The Python driver owns identity, install, diagnostics, and postconditions. A
separate test-only AndroidX package keeps one UiAutomation session for semantic
input across the whole setup flow. Shell hierarchy dumps are diagnostic only.
No path calls a WebView or native bridge, seeds private preferences, or enters
account credentials.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import re
import subprocess
import sys
import time
import traceback
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Iterable, Sequence


PACKAGE = "com.tgk30.debridstreamer"
ACTIVITY = f"{PACKAGE}/.MainActivity"
HARNESS_PACKAGE = "com.yawf.runtimeinstrumentation"
HARNESS_INSTRUMENTATION = (
    "com.yawf.runtimeinstrumentation.test/androidx.test.runner.AndroidJUnitRunner"
)
URL_RE = re.compile(r"https?://[^\s\]\[\"'<>]+", re.IGNORECASE)
BOUNDS_RE = re.compile(r"^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$")


class RuntimeCheckError(RuntimeError):
    """A deterministic runtime-gate failure."""


@dataclasses.dataclass(frozen=True)
class Bounds:
    left: int
    top: int
    right: int
    bottom: int

    @property
    def width(self) -> int:
        return self.right - self.left

    @property
    def height(self) -> int:
        return self.bottom - self.top

    @property
    def area(self) -> int:
        return max(0, self.width) * max(0, self.height)

    @property
    def center(self) -> tuple[int, int]:
        return ((self.left + self.right) // 2, (self.top + self.bottom) // 2)


@dataclasses.dataclass(frozen=True)
class UiNode:
    text: str
    description: str
    resource_id: str
    class_name: str
    bounds: Bounds
    clickable: bool
    checkable: bool
    checked: bool
    enabled: bool
    scrollable: bool

    @property
    def labels(self) -> tuple[str, ...]:
        return tuple(value for value in (self.text, self.description) if value)


@dataclasses.dataclass(frozen=True)
class WebViewProvider:
    package_name: str
    version_name: str


def parse_bounds(value: str) -> Bounds:
    match = BOUNDS_RE.fullmatch(value)
    if match is None:
        raise ValueError(f"Invalid Android bounds: {value!r}")
    bounds = Bounds(*(int(part) for part in match.groups()))
    if bounds.width < 0 or bounds.height < 0:
        raise ValueError(f"Reversed Android bounds: {value!r}")
    return bounds


def parse_ui_xml(xml_text: str) -> list[UiNode]:
    root = ET.fromstring(xml_text)
    nodes: list[UiNode] = []
    for element in root.iter("node"):
        nodes.append(
            UiNode(
                text=element.attrib.get("text", "").strip(),
                description=element.attrib.get("content-desc", "").strip(),
                resource_id=element.attrib.get("resource-id", "").strip(),
                class_name=element.attrib.get("class", "").strip(),
                bounds=parse_bounds(element.attrib.get("bounds", "[0,0][0,0]")),
                clickable=element.attrib.get("clickable") == "true",
                checkable=element.attrib.get("checkable") == "true",
                checked=element.attrib.get("checked") == "true",
                enabled=element.attrib.get("enabled", "true") == "true",
                scrollable=element.attrib.get("scrollable") == "true",
            )
        )
    return nodes


def normalize_label(value: str) -> str:
    return " ".join(value.split()).casefold()


def node_matches(node: UiNode, needle: str, *, exact: bool) -> bool:
    expected = normalize_label(needle)
    for label in node.labels:
        actual = normalize_label(label)
        if actual == expected or (not exact and expected in actual):
            return True
    return False


def visible(node: UiNode, screen_size: tuple[int, int]) -> bool:
    width, height = screen_size
    x, y = node.bounds.center
    return node.bounds.area > 0 and 0 <= x < width and 0 <= y < height


def select_node(
    nodes: Iterable[UiNode],
    needle: str,
    screen_size: tuple[int, int],
    *,
    exact: bool = True,
    require_enabled: bool = True,
) -> UiNode | None:
    matches = [
        node
        for node in nodes
        if node_matches(node, needle, exact=exact)
        and visible(node, screen_size)
        and (node.enabled or not require_enabled)
    ]
    if not matches:
        return None
    matches.sort(
        key=lambda node: (
            0 if node.checkable else 1,
            0 if node.clickable else 1,
            node.bounds.area,
        )
    )
    return matches[0]


def redact_text(value: str) -> str:
    return URL_RE.sub("<redacted-url>", value)


def bounded_text(value: str, max_bytes: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    kept = encoded[:max_bytes].decode("utf-8", "ignore")
    return kept + f"\n<truncated after {max_bytes} bytes>\n"


def parse_webview_provider(value: str) -> WebViewProvider:
    match = re.search(
        r"Current WebView package \(name, version\): \(([^,]+),\s*([^)]+)\)",
        value,
    )
    if match is None:
        raise RuntimeCheckError("Could not determine the current Android WebView provider")
    return WebViewProvider(
        package_name=match.group(1).strip(),
        version_name=match.group(2).strip(),
    )


def validate_webview_provider(
    provider: WebViewProvider,
    *,
    minimum_major: int,
    expected_package: str | None,
    expected_version: str | None,
) -> int:
    version_match = re.fullmatch(r"(\d+)(?:\..*)?", provider.version_name)
    if version_match is None:
        raise RuntimeCheckError("Current Android WebView has an invalid version")
    major = int(version_match.group(1))
    if major < minimum_major:
        raise RuntimeCheckError(
            f"Current Android WebView major {major} is below required {minimum_major}"
        )
    if expected_package is not None and provider.package_name != expected_package:
        raise RuntimeCheckError("Current Android WebView package does not match the CI pin")
    if expected_version is not None and provider.version_name != expected_version:
        raise RuntimeCheckError("Current Android WebView version does not match the CI pin")
    return major


def classify_onboarding_entry(
    nodes: Iterable[UiNode], screen_size: tuple[int, int]
) -> str | None:
    # The FirstRunWizard eyebrow also says "Welcome to YAWF Stream", so its
    # unique question must take priority over the tier welcome heading.
    first_run = select_node(
        nodes, "How do you want to use YAWF Stream?", screen_size, exact=True
    )
    if first_run is not None:
        return "first-run"

    heading = select_node(nodes, "Welcome to YAWF Stream", screen_size, exact=True)
    skip = select_node(nodes, "Skip", screen_size, exact=True)
    next_button = select_node(nodes, "Next", screen_size, exact=True)
    if (
        heading is not None
        and skip is not None
        and next_button is not None
        and skip.clickable
        and next_button.clickable
    ):
        return "tier-welcome"
    return None


def find_binding_terms(nodes: Iterable[UiNode]) -> list[str]:
    text = " ".join(label for node in nodes for label in node.labels).casefold()
    forbidden = ("terms of service", "license agreement", "user agreement", "binding terms")
    return [term for term in forbidden if term in text]


def scan_crash_evidence(value: str, package: str) -> list[str]:
    findings: list[str] = []
    lines = value.splitlines()
    escaped = re.escape(package)
    anr_pattern = re.compile(rf"\bANR in {escaped}(?=\s|$)")
    process_pattern = re.compile(rf"\bProcess:\s*{escaped}(?=,|\s*$)")
    for index, line in enumerate(lines):
        if anr_pattern.search(line) or process_pattern.search(line):
            findings.append(line.strip())
        if "FATAL EXCEPTION:" in line:
            context = lines[index : index + 14]
            if any(process_pattern.search(context_line) for context_line in context):
                findings.append(line.strip())
    return list(dict.fromkeys(findings))


def has_unexpected_installer(activity_dump: str) -> bool:
    resumed = "\n".join(
        line.casefold()
        for line in activity_dump.splitlines()
        if "mresumedactivity" in line.casefold() or "topresumedactivity" in line.casefold()
    )
    return "packageinstaller" in resumed or "permissioncontroller" in resumed


class Adb:
    def __init__(self, executable: str, serial: str):
        self.executable = executable
        self.serial = serial

    def run(
        self,
        args: Sequence[str],
        *,
        timeout: float = 30,
        check: bool = True,
        text: bool = True,
    ) -> subprocess.CompletedProcess:
        result = subprocess.run(
            [self.executable, "-s", self.serial, *args],
            check=False,
            capture_output=True,
            timeout=timeout,
            text=text,
        )
        if check and result.returncode != 0:
            stderr = result.stderr if text else result.stderr.decode("utf-8", "replace")
            stdout = result.stdout if text else result.stdout.decode("utf-8", "replace")
            raise RuntimeCheckError(
                f"ADB command failed ({result.returncode}): {' '.join(args)}\n"
                f"{redact_text(stdout)}\n{redact_text(stderr)}"
            )
        return result

    def shell(self, *args: str, timeout: float = 30, check: bool = True) -> str:
        return self.run(["shell", *args], timeout=timeout, check=check).stdout

    def exec_out(self, *args: str, timeout: float = 30) -> bytes:
        return self.run(["exec-out", *args], timeout=timeout, text=False).stdout


class RuntimeDriver:
    def __init__(
        self,
        *,
        adb: Adb,
        apk: Path,
        evidence: Path,
        expected_sha256: str,
        expected_version: str,
        expected_version_code: int,
        minimum_webview_major: int,
        expected_webview_package: str | None,
        expected_webview_version: str | None,
        expected_published_version: str,
        boot_timeout: int,
        ui_timeout: int,
        update_timeout: int,
    ):
        self.adb = adb
        self.apk = apk
        self.evidence = evidence
        self.expected_sha256 = expected_sha256.casefold()
        self.expected_version = expected_version
        self.expected_version_code = expected_version_code
        self.minimum_webview_major = minimum_webview_major
        self.expected_webview_package = expected_webview_package
        self.expected_webview_version = expected_webview_version
        self.expected_published_version = expected_published_version
        self.boot_timeout = boot_timeout
        self.ui_timeout = ui_timeout
        self.update_timeout = update_timeout
        self.screen_size = (1080, 1920)
        self.stage = 0
        self.events: list[str] = []

    def note(self, message: str) -> None:
        message = redact_text(message)
        self.events.append(message)
        print(message, flush=True)

    def wait_for_boot(self) -> None:
        deadline = time.monotonic() + self.boot_timeout
        while time.monotonic() < deadline:
            try:
                state = self.adb.run(["get-state"], timeout=8, check=False).stdout.strip()
                completed = self.adb.shell("getprop", "sys.boot_completed", timeout=8, check=False).strip()
                if state == "device" and completed == "1":
                    self.adb.shell("input", "keyevent", "KEYCODE_WAKEUP", check=False)
                    self.adb.shell("wm", "dismiss-keyguard", check=False)
                    self.screen_size = self.read_screen_size()
                    self.note(f"Boot complete at {self.screen_size[0]}x{self.screen_size[1]}")
                    return
            except (OSError, subprocess.SubprocessError):
                pass
            time.sleep(2)
        raise RuntimeCheckError(f"Emulator did not boot within {self.boot_timeout} seconds")

    def read_screen_size(self) -> tuple[int, int]:
        output = self.adb.shell("wm", "size")
        matches = re.findall(r"(?:Physical|Override) size:\s*(\d+)x(\d+)", output)
        if not matches:
            raise RuntimeCheckError(f"Could not parse screen size: {output!r}")
        width, height = matches[-1]
        return int(width), int(height)

    def check_apk_hash(self) -> None:
        actual = hashlib.sha256(self.apk.read_bytes()).hexdigest()
        if actual != self.expected_sha256:
            raise RuntimeCheckError(f"Candidate SHA-256 mismatch: {actual}")
        self.note(f"Candidate SHA-256 verified: {actual}")

    def verify_webview_provider(self) -> None:
        provider_dump = self.adb.shell("dumpsys", "webviewupdate", timeout=60)
        self.write_text("webview-provider-driver-dumpsys.txt", provider_dump)
        provider = parse_webview_provider(provider_dump)
        version_match = re.fullmatch(r"(\d+)(?:\..*)?", provider.version_name)
        parsed_major = int(version_match.group(1)) if version_match is not None else -1
        self.write_text(
            "webview-provider-driver-receipt.txt",
            f"currentPackage={provider.package_name}\n"
            f"currentVersion={provider.version_name}\n"
            f"currentMajor={parsed_major}\n"
            f"minimumMajor={self.minimum_webview_major}\n"
            f"expectedPackage={self.expected_webview_package or '<not-pinned>'}\n"
            f"expectedVersion={self.expected_webview_version or '<not-pinned>'}\n"
            "scope=isolated-ci-only\n"
            "shippingProvider=false\n"
            "currentSecurityBrowserProof=false\n",
        )
        major = validate_webview_provider(
            provider,
            minimum_major=self.minimum_webview_major,
            expected_package=self.expected_webview_package,
            expected_version=self.expected_webview_version,
        )
        self.note(
            f"Isolated CI WebView compatibility provider verified at major {major}; "
            "not a shipping or current-security-browser claim"
        )

    def install(self) -> None:
        result = self.adb.run(
            ["install", "--no-streaming", "-r", str(self.apk)], timeout=180
        )
        if "Success" not in result.stdout:
            raise RuntimeCheckError(f"APK install did not report success: {result.stdout}")
        self.note("Fresh in-place-capable APK install reported Success")

    def package_dump(self) -> str:
        return self.adb.shell("dumpsys", "package", PACKAGE, timeout=60)

    def verify_installed_identity(self) -> None:
        package_dump = self.package_dump()
        self.write_text("package.txt", package_dump)
        version_name = re.search(r"\bversionName=([^\s]+)", package_dump)
        version_code = re.search(r"\bversionCode=(\d+)", package_dump)
        if version_name is None or version_name.group(1) != self.expected_version:
            raise RuntimeCheckError("Installed versionName does not match the candidate")
        if version_code is None or int(version_code.group(1)) != self.expected_version_code:
            raise RuntimeCheckError("Installed versionCode does not match the candidate")

        path_output = self.adb.shell("pm", "path", PACKAGE).strip()
        base_paths = [line.removeprefix("package:") for line in path_output.splitlines() if line.endswith("base.apk")]
        if len(base_paths) != 1:
            raise RuntimeCheckError(f"Expected one installed base APK, found {len(base_paths)}")
        installed_hash = self.adb.shell("sha256sum", base_paths[0], timeout=120).split()[0].casefold()
        if installed_hash != self.expected_sha256:
            raise RuntimeCheckError(f"Installed base APK SHA-256 mismatch: {installed_hash}")
        self.write_text(
            "installed-identity.txt",
            f"package={PACKAGE}\nversionName={version_name.group(1)}\n"
            f"versionCode={version_code.group(1)}\nsha256={installed_hash}\n",
        )
        self.note("Installed package version, code, and base APK hash match")

    def start_app(self) -> None:
        self.adb.shell("am", "force-stop", PACKAGE)
        self.adb.run(["logcat", "-c"], check=False)
        output = self.adb.shell("am", "start", "-W", "-n", ACTIVITY, timeout=60)
        self.write_text("launch.txt", output)
        if "Error:" in output:
            raise RuntimeCheckError(f"Activity launch failed: {output}")
        self.note("MainActivity launched through Android activity manager")

    def read_ui(self) -> tuple[list[UiNode], str]:
        remote = "/sdcard/yawf-runtime-window.xml"
        last_error = ""
        for _ in range(3):
            try:
                removed = self.adb.run(
                    ["shell", "rm", "-f", remote], timeout=10, check=False
                )
                if removed.returncode != 0:
                    raise RuntimeCheckError("Could not remove the prior diagnostic hierarchy")
                dumped = self.adb.run(
                    ["shell", "uiautomator", "dump", "--compressed", remote],
                    timeout=20,
                    check=False,
                )
                if dumped.returncode != 0:
                    raise RuntimeCheckError(
                        "Diagnostic hierarchy dumper exited nonzero: "
                        + redact_text((dumped.stdout + dumped.stderr).strip())
                    )
                exists = self.adb.run(
                    ["shell", "test", "-s", remote], timeout=10, check=False
                )
                if exists.returncode != 0:
                    raise RuntimeCheckError("Diagnostic hierarchy was not freshly created")
                raw_result = self.adb.run(
                    ["exec-out", "cat", remote], timeout=20, check=False, text=False
                )
                if raw_result.returncode != 0:
                    raise RuntimeCheckError("Could not read the fresh diagnostic hierarchy")
                xml_text = raw_result.stdout.decode("utf-8", "replace").strip()
                nodes = parse_ui_xml(xml_text)
                if nodes:
                    return nodes, xml_text
                last_error = "accessibility hierarchy was empty"
            except (ET.ParseError, ValueError, RuntimeCheckError) as error:
                last_error = str(error)
            finally:
                self.adb.run(["shell", "rm", "-f", remote], timeout=10, check=False)
            time.sleep(1)
        raise RuntimeCheckError(f"Could not read Android accessibility hierarchy: {last_error}")

    def run_persistent_harness(self) -> None:
        package_paths = self.adb.shell("pm", "path", HARNESS_PACKAGE).splitlines()
        if not any(line.strip().startswith("package:") for line in package_paths):
            raise RuntimeCheckError("Persistent instrumentation helper is not installed")
        listed = self.adb.shell("pm", "list", "instrumentation")
        expected = f"instrumentation:{HARNESS_INSTRUMENTATION} (target={HARNESS_PACKAGE})"
        if expected not in listed:
            raise RuntimeCheckError("Persistent instrumentation runner is not registered")

        self.adb.shell("am", "force-stop", PACKAGE)
        self.adb.run(["logcat", "-c"], check=False)
        subdir = "persistent-flow"
        output = self.adb.run(
            [
                "shell",
                "am",
                "instrument",
                "-w",
                "-r",
                "-e",
                "class",
                (
                    "com.yawf.runtimeinstrumentation.RuntimeFlowTest#"
                    "completeSetupAndNativeUpdateFlowInOneSession"
                ),
                "-e",
                "evidenceSubdir",
                subdir,
                "-e",
                "candidateVersion",
                self.expected_version,
                "-e",
                "publishedVersion",
                self.expected_published_version,
                HARNESS_INSTRUMENTATION,
            ],
            timeout=self.ui_timeout * 5 + self.update_timeout,
            check=False,
        )
        self.write_text("instrumentation-output.txt", output.stdout + output.stderr)

        harness_evidence = self.evidence / "persistent-instrumentation"
        harness_evidence.mkdir(parents=True, exist_ok=True)
        remote = f"/sdcard/Android/data/{HARNESS_PACKAGE}/files/{subdir}/."
        pulled = self.adb.run(
            ["pull", remote, str(harness_evidence)], timeout=120, check=False
        )
        self.write_text("instrumentation-pull.txt", pulled.stdout + pulled.stderr)
        if pulled.returncode != 0:
            raise RuntimeCheckError("Could not retain persistent instrumentation evidence")
        receipt_path = harness_evidence / "instrumentation-receipt.json"
        if not receipt_path.is_file():
            raise RuntimeCheckError("Persistent instrumentation receipt is missing")
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))

        passed = (
            output.returncode == 0
            and "OK (1 test)" in output.stdout
            and "INSTRUMENTATION_CODE: -1" in output.stdout
            and receipt.get("outcome") == "passed"
            and receipt.get("persistentUiAutomationSession") is True
            and receipt.get("candidateVersion") == self.expected_version
            and receipt.get("publishedChannelVersion") == self.expected_published_version
        )
        if not passed:
            raise RuntimeCheckError("Persistent instrumentation setup flow did not pass")
        self.note("Persistent UiAutomation session completed setup and native update flow")

    def assert_no_binding_terms(self, nodes: Iterable[UiNode]) -> None:
        found = find_binding_terms(nodes)
        if found:
            raise RuntimeCheckError(
                "Refusing to accept a binding-terms screen: " + ", ".join(found)
            )

    def snapshot(self, label: str) -> tuple[list[UiNode], str]:
        self.stage += 1
        prefix = f"{self.stage:02d}-{label}"
        nodes, xml_text = self.read_ui()
        self.assert_no_binding_terms(nodes)
        self.write_text(f"{prefix}.xml", xml_text)
        (self.evidence / f"{prefix}.png").write_bytes(
            self.adb.exec_out("screencap", "-p", timeout=30)
        )
        return nodes, xml_text

    def wait_for_any(
        self,
        labels: Sequence[str],
        *,
        timeout: int | None = None,
        exact: bool = True,
        require_enabled: bool = True,
    ) -> tuple[str, UiNode, list[UiNode], str]:
        deadline = time.monotonic() + (timeout if timeout is not None else self.ui_timeout)
        last_xml = ""
        while time.monotonic() < deadline:
            nodes, xml_text = self.read_ui()
            last_xml = xml_text
            self.assert_no_binding_terms(nodes)
            for label in labels:
                node = select_node(
                    nodes,
                    label,
                    self.screen_size,
                    exact=exact,
                    require_enabled=require_enabled,
                )
                if node is not None:
                    return label, node, nodes, xml_text
            time.sleep(2)
        self.write_text("last-timeout.xml", last_xml)
        raise RuntimeCheckError(f"Timed out waiting for UI text: {', '.join(labels)}")

    def wait_for_onboarding_entry(
        self,
        *,
        timeout: int,
        include_update_consent: bool = False,
        poll_interval: float = 2.0,
    ) -> tuple[str, list[UiNode], str]:
        deadline = time.monotonic() + timeout
        last_xml = ""
        while time.monotonic() < deadline:
            nodes, xml_text = self.read_ui()
            last_xml = xml_text
            self.assert_no_binding_terms(nodes)
            if include_update_consent:
                consent = select_node(
                    nodes,
                    "Enable Android update checks?",
                    self.screen_size,
                    exact=True,
                )
                if consent is not None:
                    return "update-consent", nodes, xml_text
            entry = classify_onboarding_entry(nodes, self.screen_size)
            if entry is not None:
                return entry, nodes, xml_text
            time.sleep(poll_interval)
        self.write_text("last-onboarding-timeout.xml", last_xml)
        raise RuntimeCheckError(
            "Timed out waiting for the tier welcome or First Run Wizard"
        )

    def tap_text(
        self,
        label: str,
        *,
        exact: bool = True,
        timeout: int | None = None,
        require_enabled: bool = True,
    ) -> UiNode:
        _, node, _, _ = self.wait_for_any(
            [label], timeout=timeout, exact=exact, require_enabled=require_enabled
        )
        x, y = node.bounds.center
        self.adb.shell("input", "touchscreen", "tap", str(x), str(y))
        self.note(f"Tapped accessibility-derived control: {label}")
        time.sleep(1)
        return node

    def scroll_until_text(self, label: str, *, attempts: int = 8) -> UiNode:
        for _ in range(attempts):
            nodes, _ = self.read_ui()
            self.assert_no_binding_terms(nodes)
            node = select_node(nodes, label, self.screen_size, exact=True)
            if node is not None:
                return node
            scrollables = [
                node for node in nodes if node.scrollable and visible(node, self.screen_size)
            ]
            if not scrollables:
                raise RuntimeCheckError(f"No visible scroll container while seeking {label!r}")
            container = max(scrollables, key=lambda item: item.bounds.area)
            x, _ = container.bounds.center
            start_y = container.bounds.top + (container.bounds.height * 3 // 4)
            end_y = container.bounds.top + (container.bounds.height // 4)
            self.adb.shell(
                "input", "touchscreen", "swipe", str(x), str(start_y), str(x), str(end_y), "500"
            )
            time.sleep(1)
        raise RuntimeCheckError(f"Could not scroll to UI text: {label}")

    def dismiss_nonbinding_tours(self) -> None:
        allowed = ("Skip", "Skip tour", "Skip the tour")
        for _ in range(4):
            nodes, _ = self.read_ui()
            self.assert_no_binding_terms(nodes)
            for label in allowed:
                node = select_node(nodes, label, self.screen_size, exact=True)
                if node is not None:
                    x, y = node.bounds.center
                    self.adb.shell("input", "touchscreen", "tap", str(x), str(y))
                    self.note(f"Dismissed ordinary nonbinding app tour: {label}")
                    time.sleep(2)
                    break
            else:
                return

    def choose_settings_updates(self) -> None:
        nodes, _ = self.read_ui()
        direct = select_node(nodes, "Help & updates", self.screen_size, exact=True)
        if direct is not None:
            x, y = direct.bounds.center
            self.adb.shell("input", "touchscreen", "tap", str(x), str(y))
            self.note("Selected Help & updates directly")
            time.sleep(1)
            return

        selectors = [
            node
            for node in nodes
            if node.class_name in {"android.widget.Spinner", "android.widget.Button"}
            and any(
                normalize_label(label) in {"install & setup", "appearance", "settings category"}
                for label in node.labels
            )
            and visible(node, self.screen_size)
        ]
        if not selectors:
            raise RuntimeCheckError("Settings category selector was not accessible")
        x, y = selectors[0].bounds.center
        self.adb.shell("input", "touchscreen", "tap", str(x), str(y))
        self.note("Opened the accessibility-derived Settings category selector")
        time.sleep(1)
        self.tap_text("Help & updates", exact=True)

    def assert_no_download_or_installer(self) -> None:
        activity_dump = self.adb.shell("dumpsys", "activity", "activities", timeout=60)
        self.write_text("activity-final.txt", activity_dump)
        if has_unexpected_installer(activity_dump):
            raise RuntimeCheckError("An Android installer activity opened unexpectedly")
        download_dump = self.adb.shell(
            "dumpsys",
            "activity",
            "service",
            "com.android.providers.downloads/.DownloadService",
            timeout=60,
            check=False,
        )
        self.write_text("download-service.txt", download_dump)
        if PACKAGE in download_dump:
            raise RuntimeCheckError("DownloadManager unexpectedly contains a YAWF request")
        update_dir = f"/sdcard/Android/data/{PACKAGE}/files/Download/updates"
        listing = self.adb.shell("find", update_dir, "-type", "f", check=False)
        self.write_text("update-files.txt", listing)
        if any(line.strip().casefold().endswith(".apk") for line in listing.splitlines()):
            raise RuntimeCheckError("The no-update check unexpectedly left a downloaded APK")

    def run_flow(self) -> None:
        self.check_apk_hash()
        self.wait_for_boot()
        self.verify_webview_provider()
        self.install()
        self.verify_installed_identity()
        self.run_persistent_harness()
        self.assert_no_download_or_installer()
        self.note(
            "Native manual check reported no newer signed Android release for "
            f"installed {self.expected_version} over public {self.expected_published_version}"
        )

    def write_text(self, name: str, value: str) -> None:
        (self.evidence / name).write_text(redact_text(value), encoding="utf-8")

    def collect_diagnostics(self) -> tuple[list[str], list[str]]:
        logcat = self.adb.run(["logcat", "-d", "-v", "threadtime"], timeout=90, check=False).stdout
        anr = self.adb.shell("dumpsys", "dropbox", "--print", "data_app_anr", timeout=90, check=False)
        crash = self.adb.shell("dumpsys", "dropbox", "--print", "data_app_crash", timeout=90, check=False)
        self.write_text("logcat.txt", logcat)
        self.write_text("dropbox-anr.txt", anr)
        self.write_text("dropbox-crash.txt", crash)
        graphics = "\n".join(
            f"{name}={self.adb.shell('getprop', name, check=False).strip()}"
            for name in (
                "ro.build.fingerprint",
                "ro.product.cpu.abi",
                "ro.hardware.egl",
                "ro.kernel.qemu.gles",
                "debug.hwui.renderer",
            )
        )
        self.write_text("device-graphics.txt", graphics + "\n")
        surface_flinger = self.adb.shell(
            "dumpsys", "SurfaceFlinger", timeout=60, check=False
        )
        self.write_text(
            "surfaceflinger.txt", bounded_text(surface_flinger, 1024 * 1024)
        )
        try:
            self.snapshot("final")
        except Exception as error:  # Evidence collection must not hide the primary failure.
            self.write_text("final-snapshot-error.txt", str(error) + "\n")
        return scan_crash_evidence(logcat + "\n" + anr, PACKAGE), scan_crash_evidence(
            logcat + "\n" + crash, PACKAGE
        )


def execute(args: argparse.Namespace) -> int:
    evidence = Path(args.evidence).resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    driver = RuntimeDriver(
        adb=Adb(args.adb, args.serial),
        apk=Path(args.apk).resolve(),
        evidence=evidence,
        expected_sha256=args.expected_sha256,
        expected_version=args.expected_version,
        expected_version_code=args.expected_version_code,
        minimum_webview_major=args.minimum_webview_major,
        expected_webview_package=args.expected_webview_package,
        expected_webview_version=args.expected_webview_version,
        expected_published_version=args.expected_published_version,
        boot_timeout=args.boot_timeout,
        ui_timeout=args.ui_timeout,
        update_timeout=args.update_timeout,
    )
    error: str | None = None
    try:
        driver.run_flow()
    except Exception as caught:
        error = f"{type(caught).__name__}: {caught}"
        driver.write_text("driver-error.txt", traceback.format_exc())
    try:
        anrs, crashes = driver.collect_diagnostics()
        if anrs or crashes:
            signals = anrs + crashes
            driver.write_text("app-failure-signals.txt", "\n".join(signals) + "\n")
            if error is None:
                error = "App ANR/crash evidence: " + "; ".join(signals)
    except Exception as caught:
        driver.write_text("collection-error.txt", traceback.format_exc())
        if error is None:
            error = f"Evidence collection failed: {type(caught).__name__}: {caught}"

    receipt = {
        "passed": error is None,
        "package": PACKAGE,
        "version": args.expected_version,
        "versionCode": args.expected_version_code,
        "apkSha256": args.expected_sha256.casefold(),
        "serial": args.serial,
        "events": driver.events,
        "error": error,
    }
    (evidence / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2), flush=True)
    return 0 if error is None else 1


class ParserTests(unittest.TestCase):
    XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hierarchy rotation="0">
  <node text="" content-desc="" resource-id="" class="android.widget.FrameLayout" clickable="false" checkable="false" checked="false" enabled="true" scrollable="false" bounds="[0,0][1080,1920]">
    <node text="Quick setup NOT RECOMMENDED Start with public sources without adding your own keys now." content-desc="" resource-id="quick" class="android.widget.Button" clickable="true" checkable="false" checked="false" enabled="true" scrollable="false" bounds="[100,200][900,400]" />
    <node text="I understand the privacy limits" content-desc="" resource-id="ack" class="android.widget.CheckBox" clickable="true" checkable="true" checked="false" enabled="true" scrollable="false" bounds="[100,500][900,600]" />
    <node text="" content-desc="More navigation" resource-id="more" class="android.widget.Button" clickable="true" checkable="false" checked="false" enabled="true" scrollable="false" bounds="[800,1750][1050,1900]" />
  </node>
</hierarchy>"""

    TIER_WELCOME_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hierarchy rotation="0">
  <node text="" content-desc="" resource-id="" class="android.widget.FrameLayout" clickable="false" checkable="false" checked="false" enabled="true" scrollable="false" bounds="[0,0][1080,1920]">
    <node text="Welcome" content-desc="" resource-id="" class="android.app.Dialog" clickable="false" checkable="false" checked="false" enabled="true" scrollable="false" bounds="[0,0][1080,1794]" />
    <node text="GET STARTED" content-desc="" resource-id="" class="android.widget.TextView" clickable="false" checkable="false" checked="false" enabled="true" scrollable="false" bounds="[136,627][370,666]" />
    <node text="Welcome to YAWF Stream" content-desc="" resource-id="" class="android.view.View" clickable="false" checkable="false" checked="false" enabled="true" scrollable="false" bounds="[136,695][945,771]" />
    <node text="Skip" content-desc="" resource-id="" class="android.widget.Button" clickable="true" checkable="false" checked="false" enabled="true" scrollable="false" bounds="[136,1134][262,1244]" />
    <node text="Next" content-desc="" resource-id="" class="android.widget.Button" clickable="true" checkable="false" checked="false" enabled="true" scrollable="false" bounds="[779,1128][945,1249]" />
  </node>
</hierarchy>"""

    FIRST_RUN_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hierarchy rotation="0">
  <node text="" content-desc="" resource-id="" class="android.widget.FrameLayout" clickable="false" checkable="false" checked="false" enabled="true" scrollable="false" bounds="[0,0][1080,2148]">
    <node text="WELCOME TO YAWF STREAM" content-desc="" resource-id="" class="android.widget.TextView" clickable="false" checkable="false" checked="false" enabled="true" scrollable="false" bounds="[165,154][687,195]" />
    <node text="How do you want to use YAWF Stream?" content-desc="" resource-id="" class="android.view.View" clickable="false" checkable="false" checked="false" enabled="true" scrollable="false" bounds="[110,222][970,374]" />
    <node text="Quick setup NOT RECOMMENDED Start with public sources without adding your own keys now. Catalog and playback limits are explained before continuing." content-desc="" resource-id="quick" class="android.widget.Button" clickable="true" checkable="false" checked="false" enabled="true" scrollable="false" bounds="[110,918][970,1204]" />
  </node>
</hierarchy>"""

    def test_parse_and_select_accessible_control(self) -> None:
        nodes = parse_ui_xml(self.XML)
        node = select_node(nodes, "Quick setup", (1080, 1920), exact=False)
        self.assertIsNotNone(node)
        self.assertEqual(node.bounds.center, (500, 300))
        self.assertTrue(node.clickable)

    def test_first_run_classifier_prioritizes_question_over_welcome_eyebrow(self) -> None:
        first_run_nodes = parse_ui_xml(self.FIRST_RUN_XML)
        self.assertIsNotNone(
            select_node(
                first_run_nodes,
                "Welcome to YAWF Stream",
                (1080, 1920),
                exact=True,
            )
        )
        self.assertEqual(
            classify_onboarding_entry(first_run_nodes, (1080, 1920)),
            "first-run",
        )

        # Combine retained nodes from the actual FirstRun and TierWelcome XMLs
        # so both classifiers match. The unique FirstRun question still wins.
        combined_nodes = first_run_nodes + parse_ui_xml(self.TIER_WELCOME_XML)
        self.assertEqual(
            classify_onboarding_entry(combined_nodes, (1080, 1920)),
            "first-run",
        )

    def test_onboarding_wait_ignores_partial_tier_mount_until_controls_ready(self) -> None:
        next_node = '    <node text="Next" content-desc="" resource-id="" class="android.widget.Button" clickable="true" checkable="false" checked="false" enabled="true" scrollable="false" bounds="[779,1128][945,1249]" />\n'
        partial_xml = self.TIER_WELCOME_XML.replace(next_node, "")
        responses = iter(
            [
                (parse_ui_xml(partial_xml), partial_xml),
                (parse_ui_xml(self.TIER_WELCOME_XML), self.TIER_WELCOME_XML),
            ]
        )
        reads = 0

        def read_ui() -> tuple[list[UiNode], str]:
            nonlocal reads
            reads += 1
            return next(responses)

        driver = object.__new__(RuntimeDriver)
        driver.screen_size = (1080, 1920)
        driver.ui_timeout = 1
        driver.read_ui = read_ui
        driver.assert_no_binding_terms = RuntimeDriver.assert_no_binding_terms.__get__(
            driver, RuntimeDriver
        )
        driver.write_text = lambda _name, _value: self.fail("unexpected timeout")

        entry, _, _ = driver.wait_for_onboarding_entry(
            timeout=1,
            poll_interval=0,
        )
        self.assertEqual(entry, "tier-welcome")
        self.assertEqual(reads, 2)

    def test_contains_match_prefers_checkable_node(self) -> None:
        nodes = parse_ui_xml(self.XML)
        node = select_node(nodes, "privacy", (1080, 1920), exact=False)
        self.assertIsNotNone(node)
        self.assertTrue(node.checkable)

    def test_offscreen_node_is_not_selected(self) -> None:
        mutated = self.XML.replace("[100,200][900,400]", "[1100,200][1400,400]")
        self.assertIsNone(
            select_node(parse_ui_xml(mutated), "Quick setup", (1080, 1920), exact=False)
        )

    def test_detects_target_app_anr(self) -> None:
        text = "ActivityManager: ANR in com.tgk30.debridstreamer (MainActivity)"
        self.assertEqual(len(scan_crash_evidence(text, PACKAGE)), 1)

    def test_detects_actual_standalone_dropbox_process_header(self) -> None:
        text = (
            "2026-10-19 16:22:40 data_app_anr (compressed text, 27912 bytes)\n"
            "Process: com.tgk30.debridstreamer\n"
            "PID: 6306\n"
            "Package: com.tgk30.debridstreamer v2003023 (2.3.23)\n"
        )
        self.assertEqual(
            scan_crash_evidence(text, PACKAGE),
            ["Process: com.tgk30.debridstreamer"],
        )

    def test_process_header_keeps_comma_pid_and_rejects_similar_package(self) -> None:
        target = f"AndroidRuntime: Process: {PACKAGE}, PID: 456"
        similar = (
            f"Process: {PACKAGE}.helper\n"
            f"ActivityManager: ANR in {PACKAGE}.helper (MainActivity)"
        )
        self.assertEqual(scan_crash_evidence(target, PACKAGE), [target])
        self.assertEqual(scan_crash_evidence(similar, PACKAGE), [])

    def test_ignores_unrelated_uiautomator_fatal(self) -> None:
        text = (
            "AndroidRuntime: FATAL EXCEPTION: main\n"
            "AndroidRuntime: Process: com.android.commands.uiautomator, PID: 123\n"
            "java.lang.NullPointerException"
        )
        self.assertEqual(scan_crash_evidence(text, PACKAGE), [])

    def test_detects_target_fatal_context(self) -> None:
        text = (
            "AndroidRuntime: FATAL EXCEPTION: main\n"
            f"AndroidRuntime: Process: {PACKAGE}, PID: 456\n"
            "java.lang.IllegalStateException"
        )
        self.assertEqual(len(scan_crash_evidence(text, PACKAGE)), 2)

    def test_detects_only_resumed_installer(self) -> None:
        background = "Hist #2: ActivityRecord{com.google.android.packageinstaller/.InstallStart}"
        resumed = "mResumedActivity: ActivityRecord{com.google.android.packageinstaller/.InstallStart}"
        self.assertFalse(has_unexpected_installer(background))
        self.assertTrue(has_unexpected_installer(resumed))

    def test_redacts_web_urls(self) -> None:
        self.assertEqual(redact_text("visit https://example.test/a?q=1 now"), "visit <redacted-url> now")

    def test_parses_current_webview_provider(self) -> None:
        dump = (
            "Current WebView package (name, version): "
            "(com.android.webview, 91.0.4472.114)\n"
        )
        self.assertEqual(
            parse_webview_provider(dump),
            WebViewProvider("com.android.webview", "91.0.4472.114"),
        )
        with self.assertRaisesRegex(RuntimeCheckError, "Could not determine"):
            parse_webview_provider("Current WebView package is null")

    def test_webview_provider_policy_requires_minimum_and_exact_identity(self) -> None:
        provider = WebViewProvider("com.android.webview", "91.0.4472.114")
        self.assertEqual(
            validate_webview_provider(
                provider,
                minimum_major=90,
                expected_package="com.android.webview",
                expected_version="91.0.4472.114",
            ),
            91,
        )
        with self.assertRaisesRegex(RuntimeCheckError, "below required"):
            validate_webview_provider(
                WebViewProvider("com.android.webview", "83.0.4103.106"),
                minimum_major=90,
                expected_package="com.android.webview",
                expected_version=None,
            )
        with self.assertRaisesRegex(RuntimeCheckError, "package does not match"):
            validate_webview_provider(
                provider,
                minimum_major=90,
                expected_package="com.google.android.webview",
                expected_version=None,
            )
        with self.assertRaisesRegex(RuntimeCheckError, "version does not match"):
            validate_webview_provider(
                provider,
                minimum_major=90,
                expected_package="com.android.webview",
                expected_version="91.0.4472.115",
            )

    def test_bounds_large_diagnostic_text(self) -> None:
        self.assertEqual(bounded_text("abc", 3), "abc")
        self.assertEqual(
            bounded_text("abcdef", 3),
            "abc\n<truncated after 3 bytes>\n",
        )

    def test_binding_terms_guard_rejects_terms_but_not_privacy_notice(self) -> None:
        nodes = parse_ui_xml(self.XML)
        self.assertEqual(find_binding_terms(nodes), [])
        terms = self.XML.replace("Quick setup NOT RECOMMENDED", "Accept the Terms of Service")
        self.assertEqual(find_binding_terms(parse_ui_xml(terms)), ["terms of service"])


def run_self_tests() -> int:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ParserTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--serial", default="emulator-5554")
    parser.add_argument("--apk")
    parser.add_argument("--evidence")
    parser.add_argument("--expected-sha256")
    parser.add_argument("--expected-version", default="2.3.23")
    parser.add_argument("--expected-version-code", type=int, default=2003023)
    parser.add_argument("--minimum-webview-major", type=int, default=90)
    parser.add_argument("--expected-webview-package")
    parser.add_argument("--expected-webview-version")
    parser.add_argument("--expected-published-version", default="2.3.21")
    parser.add_argument("--boot-timeout", type=int, default=300)
    parser.add_argument("--ui-timeout", type=int, default=60)
    parser.add_argument("--update-timeout", type=int, default=120)
    args = parser.parse_args(argv)
    if not args.self_test:
        missing = [name for name in ("apk", "evidence", "expected_sha256") if getattr(args, name) is None]
        if missing:
            parser.error("runtime mode requires: " + ", ".join(f"--{name.replace('_', '-')}" for name in missing))
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.self_test:
        return run_self_tests()
    return execute(args)


if __name__ == "__main__":
    raise SystemExit(main())
