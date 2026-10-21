#!/usr/bin/env python3
"""Run every OTA policy assertion against one targeted valid-Java mutant."""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
POLICY = ROOT / "app/src/main/java/com/yawf/runtimeinstrumentation/OtaFlowPolicy.java"
ASSERTIONS = (
    ROOT
    / "app/src/test/java/com/yawf/runtimeinstrumentation/OtaFlowPolicyAssertions.java"
)

MUTANTS = {
    "pins": (
        "public static final long TARGET_VERSION_CODE = 2_003_026L;",
        "public static final long TARGET_VERSION_CODE = 2_003_027L;",
    ),
    "wrongBaseline": (
        "return BASELINE_VERSION.equals(baselineVersion)\n                && TARGET_VERSION.equals(targetVersion)",
        "return TARGET_VERSION.equals(targetVersion)",
    ),
    "wrongTarget": (
        "&& TARGET_VERSION.equals(targetVersion)\n                && TARGET_VERSION_CODE == targetVersionCode",
        "&& TARGET_VERSION_CODE == targetVersionCode",
    ),
    "wrongSigner": (
        "&& TARGET_SIZE == targetSize\n                && SIGNER_SHA256.equals(signerSha256);",
        "&& TARGET_SIZE == targetSize;",
    ),
    "offerDomain": (
        'return ("YAWF Stream " + TARGET_VERSION + " is available").equals(title)\n                &&',
        'return title.endsWith(" is available")\n                &&',
    ),
    "webButtonIdentity": (
        "return PRODUCT_PACKAGE.equals(observedPackage)\n                    && WEB_BUTTON_CLASS.equals(observedClass)",
        "return WEB_BUTTON_CLASS.equals(observedClass)",
    ),
    "quickSetupCardIdentity": (
        '"Quick setup NOT RECOMMENDED Start with public sources without adding your own keys now. "\n'
        '                    + "Catalog and playback limits are explained before continuing."',
        '"Quick setup"',
    ),
    "nativeButtonIdentity": (
        "&& resourceName.equals(observedResource)\n                    && textPattern.matcher",
        "&& textPattern.matcher",
    ),
    "bindingTerms": (
        "terms of service|license agreement|user agreement|binding terms",
        "privacy notice|license agreement|user agreement|binding terms",
    ),
    "tourCounts": (
        "return zeroBasedStep == totalSteps - 1 ? GET_STARTED.label() : NEXT.label();",
        "return zeroBasedStep == totalSteps - 2 ? GET_STARTED.label() : NEXT.label();",
    ),
    "settledAbsence": (
        "return samples >= SETTLED_ABSENT_SAMPLES;",
        "return samples >= 2;",
    ),
    "systemPackages": (
        '"com.google.android.packageinstaller",',
        '"com.example.installer",',
    ),
    "switchResources": (
        '"android:id/switch_widget",',
        '"android:id/button1",',
    ),
    "cleanupSequence": (
        "return installerSuccessObserved && installerOpenObserved && updatedProductObserved;",
        "return installerOpenObserved && updatedProductObserved;",
    ),
    "exactDialogs": (
        'return "Update ready to install".equals(title)\n                &&',
        'return title.startsWith("Update ready")\n                &&',
    ),
}


def compile_variant(source: str, destination: Path) -> Path:
    destination.mkdir()
    policy = destination / "OtaFlowPolicy.java"
    policy.write_text(source, encoding="utf-8")
    classes = destination / "classes"
    classes.mkdir()
    result = subprocess.run(
        ["javac", "-d", str(classes), str(policy), str(ASSERTIONS)],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("Mutant did not compile:\n" + result.stderr[-4000:])
    return classes


def run_assertion(classes: Path, name: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "java",
            "-cp",
            str(classes),
            "com.yawf.runtimeinstrumentation.OtaFlowPolicyAssertions",
            name,
        ],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )


def main() -> int:
    original = POLICY.read_text(encoding="utf-8")
    results: list[dict[str, object]] = []
    with tempfile.TemporaryDirectory(prefix="yawf-ota-policy-") as temporary:
        temporary_path = Path(temporary)
        baseline_classes = compile_variant(original, temporary_path / "baseline")
        for index, (name, (before, after)) in enumerate(MUTANTS.items(), start=1):
            if original.count(before) != 1:
                raise RuntimeError(f"Expected one mutation site for {name}")
            baseline = run_assertion(baseline_classes, name)
            mutated = original.replace(before, after, 1)
            mutant_classes = compile_variant(mutated, temporary_path / f"mutant-{index}")
            mutant = run_assertion(mutant_classes, name)
            killed = baseline.returncode == 0 and mutant.returncode != 0
            results.append(
                {
                    "test": name,
                    "baselinePassed": baseline.returncode == 0,
                    "mutantKilled": killed,
                    "mutantExit": mutant.returncode,
                    "mutantTail": (mutant.stdout + mutant.stderr)[-500:],
                }
            )
            if not killed:
                print(json.dumps({"passed": False, "tests": results}, indent=2))
                return 1
    print(json.dumps({"passed": True, "tests": results}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
