#!/usr/bin/env python3
"""Source-contract checks for the exact Android unknown-source permission control."""

from __future__ import annotations

import os
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUNTIME = Path(os.environ.get(
    "OTA_RUNTIME_FLOW",
    ROOT / "app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeOtaFlowTest.java",
))
POLICY = Path(os.environ.get(
    "OTA_FLOW_POLICY",
    ROOT / "app/src/main/java/com/yawf/runtimeinstrumentation/OtaFlowPolicy.java",
))
ASSERTIONS = Path(os.environ.get(
    "OTA_POLICY_ASSERTIONS",
    ROOT / "app/src/test/java/com/yawf/runtimeinstrumentation/OtaFlowPolicyAssertions.java",
))
MUTATION_CHECK = Path(os.environ.get(
    "OTA_POLICY_MUTATION_CHECK",
    ROOT / "ota_policy_mutation_check.py",
))


def section(source: str, start: str, end: str) -> str:
    match = re.search(start + r"[\s\S]*?" + end, source)
    return match.group(0) if match else ""


def runtime_failures(source: str) -> list[str]:
    failures: list[str] = []
    resolver = section(
        source,
        r"private UiObject2 findUnknownSourceSwitch\(\)",
        r"private UiObject2 waitForUnknownSourceSwitchState",
    )
    waiter = section(
        source,
        r"private UiObject2 waitForUnknownSourceSwitchState",
        r"private void confirmSystemInstaller",
    )
    enter = section(
        source,
        r"private void enterUnknownSourcePermission\(\)",
        r"private UiObject2 findUnknownSourceSwitch",
    )
    cleanup = section(
        source,
        r"private void cleanupUnknownSourcePermission\(\)",
        r"private void launchProduct",
    )

    requirements = [
        (resolver, r'"android:id/switch_widget", "com\.android\.settings:id/switch_widget"',
         "legacy reviewed resources changed"),
        (resolver, r"By\.text\(OtaFlowPolicy\.UNKNOWN_SOURCE_LABEL\)\s*"
                   r"\.pkg\(OtaFlowPolicy\.SETTINGS_PACKAGE\)\s*"
                   r"\.clazz\(OtaFlowPolicy\.UNKNOWN_SOURCE_LABEL_CLASS\)\s*"
                   r"\.enabled\(true\)",
         "exact Settings label selector missing"),
        (resolver, r"if \(labels\.size\(\) != 1\) \{\s*return null;\s*\}",
         "exactly one label is not required"),
        (resolver, r"UiObject2 label = labels\.get\(0\);\s*"
                   r"UiObject2 toggle = label\.getParent\(\);",
         "semantic toggle is not the direct label parent"),
        (resolver, r"OtaFlowPolicy\.isUnknownSourceSemanticToggle\(\s*"
                   r"toggle\.getApplicationPackage\(\),\s*"
                   r"toggle\.getClassName\(\),\s*"
                   r"toggle\.getResourceName\(\),\s*"
                   r"toggle\.isEnabled\(\),\s*"
                   r"toggle\.isClickable\(\),\s*"
                   r"toggle\.isCheckable\(\),\s*"
                   r"label\.getApplicationPackage\(\),\s*"
                   r"label\.getClassName\(\),\s*"
                   r"label\.getText\(\),\s*"
                   r"label\.isEnabled\(\)\)",
         "central semantic policy is not given the exact observed shape"),
        (waiter, r"while \(SystemClock\.uptimeMillis\(\) < deadline\) \{\s*"
                  r"UiObject2 toggle = findUnknownSourceSwitch\(\);\s*"
                  r"if \(toggle != null && toggle\.isChecked\(\) == expected\)",
         "state wait does not re-resolve the reviewed control"),
        (enter, r'toggle\.click\(\);\s*waitForUnknownSourceSwitchState\(true, "unknown-source switch on"\);',
         "enable wait bypasses the reviewed resolver"),
        (cleanup, r"UiObject2 toggle = findUnknownSourceSwitch\(\);",
         "cleanup does not resolve the reviewed control"),
        (cleanup, r'toggle\.click\(\);\s*waitForUnknownSourceSwitchState\(false, "unknown-source switch off"\);',
         "cleanup wait bypasses the reviewed resolver"),
    ]
    for target, pattern, message in requirements:
        if not re.search(pattern, target):
            failures.append(message)

    permission_scope = enter + resolver + waiter + cleanup
    if re.search(r"device\.click\s*\(|By\.checkable\s*\(|By\.clazz\(\"android\.view\.View\"\)", permission_scope):
        failures.append("permission flow uses coordinates or a generic checkable/view selector")
    if "By.res(toggle.getResourceName())" in enter + cleanup:
        failures.append("no-resource semantic toggle is still converted to By.res")
    return failures


def policy_failures(source: str, assertions: str, mutation_check: str) -> list[str]:
    failures: list[str] = []
    method = section(
        source,
        r"public static boolean isUnknownSourceSemanticToggle\(",
        r"public static boolean cleanupMayOpenSettings",
    )
    constants = [
        'public static final String SETTINGS_PACKAGE = "com.android.settings";',
        'public static final String UNKNOWN_SOURCE_LABEL = "Allow from this source";',
        'public static final String UNKNOWN_SOURCE_LABEL_CLASS = "android.widget.TextView";',
        'public static final String UNKNOWN_SOURCE_TOGGLE_CLASS = "android.view.View";',
    ]
    for value in constants:
        if value not in source:
            failures.append(f"missing exact semantic constant: {value}")
    conditions = [
        "SETTINGS_PACKAGE.equals(togglePackage)",
        "UNKNOWN_SOURCE_TOGGLE_CLASS.equals(toggleClass)",
        "(toggleResource == null || toggleResource.isEmpty())",
        "&& toggleEnabled",
        "&& toggleClickable",
        "&& toggleCheckable",
        "SETTINGS_PACKAGE.equals(labelPackage)",
        "UNKNOWN_SOURCE_LABEL_CLASS.equals(labelClass)",
        "UNKNOWN_SOURCE_LABEL.equals(labelText)",
        "&& labelEnabled",
    ]
    for value in conditions:
        if value not in method:
            failures.append(f"semantic policy missing condition: {value}")
    for name in ("semanticSwitchActual", "semanticSwitchIdentity", "semanticSwitchState"):
        if f'TESTS.put("{name}"' not in assertions:
            failures.append(f"missing independent Java baseline: {name}")
        if f'"{name}": (' not in mutation_check:
            failures.append(f"missing independent Java mutant: {name}")
    return failures


class UnknownSourcePermissionContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.runtime = RUNTIME.read_text(encoding="utf-8")
        cls.policy = POLICY.read_text(encoding="utf-8")
        cls.assertions = ASSERTIONS.read_text(encoding="utf-8")
        cls.mutation_check = MUTATION_CHECK.read_text(encoding="utf-8")

    def test_exact_runtime_and_policy_contract(self) -> None:
        self.assertEqual(runtime_failures(self.runtime), [])
        self.assertEqual(
            policy_failures(self.policy, self.assertions, self.mutation_check),
            [],
        )

    def test_targeted_semantic_mutants_are_rejected(self) -> None:
        runtime_mutants = {
            "generic parent search": self.runtime.replace(
                "UiObject2 toggle = label.getParent();",
                "UiObject2 toggle = device.findObject(By.checkable(true));",
                1,
            ),
            "nonunique label": self.runtime.replace("labels.size() != 1", "labels.isEmpty()", 1),
            "wrong label package": self.runtime.replace(
                ".pkg(OtaFlowPolicy.SETTINGS_PACKAGE)", ".pkg(OtaFlowPolicy.PRODUCT_PACKAGE)", 1,
            ),
            "generic state wait": self.runtime.replace(
                "UiObject2 toggle = findUnknownSourceSwitch();",
                "UiObject2 toggle = device.findObject(By.checkable(true));",
                1,
            ),
            "resource enable wait": self.runtime.replace(
                'waitForUnknownSourceSwitchState(true, "unknown-source switch on");',
                'waitForCheckedState(By.res(toggle.getResourceName()), true, "unknown-source switch on");',
                1,
            ),
            "resource cleanup wait": self.runtime.replace(
                'waitForUnknownSourceSwitchState(false, "unknown-source switch off");',
                'waitForCheckedState(By.res(toggle.getResourceName()), false, "unknown-source switch off");',
                1,
            ),
            "coordinate click": self.runtime.replace(
                "toggle.click();", "device.click(540, 981);", 1,
            ),
        }
        for name, mutant in runtime_mutants.items():
            with self.subTest(runtime=name):
                self.assertNotEqual(mutant, self.runtime)
                self.assertNotEqual(runtime_failures(mutant), [])

        policy_mutants = {
            "toggle package": self.policy.replace(
                "return SETTINGS_PACKAGE.equals(togglePackage)", "return true", 1,
            ),
            "toggle class": self.policy.replace(
                "&& UNKNOWN_SOURCE_TOGGLE_CLASS.equals(toggleClass)", "&& true", 1,
            ),
            "resource absence": self.policy.replace(
                "&& (toggleResource == null || toggleResource.isEmpty())", "&& true", 1,
            ),
            "enabled": self.policy.replace("&& toggleEnabled", "&& true", 1),
            "clickable": self.policy.replace("&& toggleClickable", "&& true", 1),
            "checkable": self.policy.replace("&& toggleCheckable", "&& true", 1),
            "label package": self.policy.replace(
                "&& SETTINGS_PACKAGE.equals(labelPackage)", "&& true", 1,
            ),
            "label class": self.policy.replace(
                "&& UNKNOWN_SOURCE_LABEL_CLASS.equals(labelClass)", "&& true", 1,
            ),
            "label text": self.policy.replace(
                "&& UNKNOWN_SOURCE_LABEL.equals(labelText)", "&& true", 1,
            ),
            "label enabled": self.policy.replace("&& labelEnabled", "&& true", 1),
        }
        for name, mutant in policy_mutants.items():
            with self.subTest(policy=name):
                self.assertNotEqual(mutant, self.policy)
                self.assertNotEqual(
                    policy_failures(mutant, self.assertions, self.mutation_check),
                    [],
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
