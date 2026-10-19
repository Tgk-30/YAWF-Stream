#!/usr/bin/env python3
"""Run each pure policy self-test against one targeted semantic mutant."""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
POLICY = ROOT / "app/src/main/java/com/yawf/runtimeinstrumentation/FlowPolicy.java"
TEST_ROOT = ROOT / "app/src/test/java/com/yawf/runtimeinstrumentation"
SUPPORT = [TEST_ROOT / "FlowPolicyAssertions.java", TEST_ROOT / "FlowPolicySelfTest.java"]

MUTANTS = {
    "firstRunPriority": (
        """        if (firstRunQuestion) {\n            return OnboardingEntry.FIRST_RUN;\n        }\n        if (tierHeading && tierSkip && tierNext) {\n            return OnboardingEntry.TIER_WELCOME;\n        }\n""",
        """        if (tierHeading && tierSkip && tierNext) {\n            return OnboardingEntry.TIER_WELCOME;\n        }\n        if (firstRunQuestion) {\n            return OnboardingEntry.FIRST_RUN;\n        }\n""",
    ),
    "tierComplete": (
        "if (tierHeading && tierSkip && tierNext)",
        "if (tierHeading && tierSkip)",
    ),
    "consentPriority": (
        "if (updateConsent) {",
        "if (false && updateConsent) {",
    ),
    "termsPolicy": (
        "terms of service|license agreement|user agreement|binding terms",
        "privacy notice|license agreement|user agreement|binding terms",
    ),
    "exactNativeResult": (
        "return UP_TO_DATE_TITLE.equals(title) && UP_TO_DATE_MESSAGE.equals(message);",
        "return UP_TO_DATE_TITLE.equals(title);",
    ),
    "versionPins": (
        "return EXPECTED_CANDIDATE_VERSION.equals(candidateVersion)\n                && EXPECTED_PUBLISHED_VERSION.equals(publishedVersion);",
        "return EXPECTED_CANDIDATE_VERSION.equals(candidateVersion);",
    ),
}


def compile_variant(policy_source: str, directory: Path) -> Path:
    directory.mkdir()
    policy = directory / "FlowPolicy.java"
    policy.write_text(policy_source, encoding="utf-8")
    classes = directory / "classes"
    classes.mkdir()
    compile_result = subprocess.run(
        ["javac", "-d", str(classes), str(policy), *(str(path) for path in SUPPORT)],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if compile_result.returncode != 0:
        raise RuntimeError("Mutant did not compile:\n" + compile_result.stderr[-4000:])
    return classes


def run_test(classes: Path, test_name: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "java",
            "-cp",
            str(classes),
            "com.yawf.runtimeinstrumentation.FlowPolicySelfTest",
            test_name,
        ],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )


def main() -> int:
    original = POLICY.read_text(encoding="utf-8")
    results: list[dict[str, object]] = []
    with tempfile.TemporaryDirectory(prefix="yawf-policy-mutant-") as temporary:
        temp = Path(temporary)
        baseline_classes = compile_variant(original, temp / "baseline")
        for index, (test_name, (before, after)) in enumerate(MUTANTS.items(), start=1):
            if original.count(before) != 1:
                raise RuntimeError(f"Expected exactly one mutation site for {test_name}")
            baseline = run_test(baseline_classes, test_name)
            mutated = original.replace(before, after, 1)
            mutant_classes = compile_variant(mutated, temp / f"mutant-{index}")
            mutant = run_test(mutant_classes, test_name)
            killed = baseline.returncode == 0 and mutant.returncode != 0
            results.append(
                {
                    "test": test_name,
                    "baselinePassed": baseline.returncode == 0,
                    "mutantKilled": killed,
                    "mutantExit": mutant.returncode,
                    "mutantTail": (mutant.stdout + mutant.stderr)[-600:].replace(str(ROOT), "<root>"),
                }
            )
            if not killed:
                print(json.dumps(results, indent=2))
                return 1
    print(json.dumps({"passed": True, "tests": results}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
