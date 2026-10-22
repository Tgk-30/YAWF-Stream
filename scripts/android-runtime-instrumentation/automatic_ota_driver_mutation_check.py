#!/usr/bin/env python3
"""Run automatic OTA driver contracts against focused valid-Java mutants."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CHECKS = ROOT / "app/src/main/java/com/yawf/runtimeinstrumentation/AutomaticOtaDriverChecks.java"
ASSERTIONS = ROOT / "app/src/test/java/com/yawf/runtimeinstrumentation/AutomaticOtaDriverChecksAssertions.java"
RUNTIME_FLOW = ROOT / "app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeOtaFlowTest.java"

PREDICATE_MUTANTS = [
    (
        "dialogTextIdentity",
        "detailDialogResolver",
        "boolean textMatches = exactIdentity.equals(candidate.text);",
        "boolean textMatches = false;",
    ),
    (
        "dialogDescriptionIdentity",
        "detailDialogResolver",
        "boolean descriptionMatches = exactIdentity.equals(candidate.description);",
        "boolean descriptionMatches = false;",
    ),
    (
        "dialogPackageScope",
        "detailDialogResolver",
        "boolean packageMatches = productPackage.equals(candidate.packageName);",
        "boolean packageMatches = true;",
    ),
    (
        "dialogClassScope",
        "detailDialogResolver",
        "boolean classMatches = dialogClass.equals(candidate.className);",
        "boolean classMatches = true;",
    ),
    (
        "dialogMissingIdentity",
        "detailDialogResolver",
        "boolean identityMatches = (textMatches || descriptionMatches)",
        "boolean identityMatches = true",
    ),
    (
        "dialogMismatchedText",
        "detailDialogResolver",
        "&& (candidate.text.isEmpty() || textMatches)",
        "&& true",
    ),
    (
        "dialogMismatchedDescription",
        "detailDialogResolver",
        "&& (candidate.description.isEmpty() || descriptionMatches);",
        "&& true;",
    ),
    (
        "dialogDuplicateIdentity",
        "detailDialogResolver",
        "if (selected != NO_DIALOG_INDEX) return AMBIGUOUS_DIALOG_INDEX;",
        "if (selected != NO_DIALOG_INDEX) return selected;",
    ),
    (
        "sameForegroundBypass",
        "sameForegroundBypass",
        "offerReturnOrdinal > triggerReturnOrdinal",
        "offerReturnOrdinal >= triggerReturnOrdinal",
    ),
    (
        "profileComparison",
        "profileComparison",
        "before.equals(after)",
        "before.equals(before)",
    ),
    (
        "detailDismissal",
        "detailDismissal",
        "primaryNavigationOrdinal > dialogGoneOrdinal",
        "primaryNavigationOrdinal >= dialogGoneOrdinal",
    ),
    (
        "recentsSwipe",
        "recentsSwipe",
        "swipeCount == 1 && exactTextAbsent && exactDescriptionAbsent",
        "swipeCount >= 0 && exactTextAbsent && exactDescriptionAbsent",
    ),
    (
        "permissionToggle",
        "permissionToggle",
        "toggleCount == 1 && !finallyChecked",
        "toggleCount >= 0",
    ),
    (
        "cleanupAfterFailure",
        "cleanupAfterFailure",
        "return permissionEnabledByTest;",
        "return permissionEnabledByTest && coreTransactionPassed;",
    ),
]

ACTUAL_BRANCH_BEFORE = "if (hasAnyWithoutIdleDelay(By.text(offerTitle))) {"
ACTUAL_BRANCH_AFTER = "if (false && hasAnyWithoutIdleDelay(By.text(offerTitle))) {"


def java_tool(name: str) -> str:
    configured = os.environ.get("JAVA_HOME")
    candidates = [] if configured is None else [Path(configured) / "bin" / name]
    candidates.append(Path("/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin") / name)
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    resolved = shutil.which(name)
    if resolved is None:
        raise RuntimeError(f"Could not locate {name}")
    return resolved


def compile_variant(source: str, destination: Path) -> Path:
    destination.mkdir()
    checks = destination / "AutomaticOtaDriverChecks.java"
    checks.write_text(source, encoding="utf-8")
    classes = destination / "classes"
    classes.mkdir()
    result = subprocess.run(
        [java_tool("javac"), "-d", str(classes), str(checks), str(ASSERTIONS)],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("Automatic driver mutant did not compile:\n" + result.stderr[-4000:])
    return classes


def run_assertion(classes: Path, name: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            java_tool("java"),
            "-cp",
            str(classes),
            "com.yawf.runtimeinstrumentation.AutomaticOtaDriverChecksAssertions",
            name,
        ],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )


def extract_method(source: str, name: str) -> str:
    declaration = re.search(rf"\bprivate\s+[^\n]+\s+{re.escape(name)}\(", source)
    if declaration is None:
        raise RuntimeError(f"Could not find runtime method {name}")
    start = declaration.start()
    brace = source.find("{", start)
    depth = 0
    for index in range(brace, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start : index + 1]
    raise RuntimeError(f"Runtime method {name} was unterminated")


def compile_actual_same_foreground_callsite(source: str, destination: Path) -> Path:
    destination.mkdir()
    method = extract_method(source, "assertAutomaticOfferAbsentForBoundedCheck")
    harness = f"""import java.io.IOException;

public final class SameForegroundCallsiteHarness {{
    private static final long AUTOMATIC_CHECK_BOUND_MS = 1_500L;
    private static final int ABSENT_SETTLED_SAMPLES = 3;
    private final String admittedTargetVersion = "9.9.9";
    private boolean automaticOfferAbsentSameForeground;

    {method}

    private void assertNoBindingTerms() {{}}
    private boolean hasAnyWithoutIdleDelay(BySelector... selectors) {{ return true; }}
    private void capture(String label) throws IOException {{}}
    private void log(String value) {{}}

    private static void assertTrue(String message, boolean value) {{
        if (!value) throw new AssertionError(message);
    }}

    private static void fail(String message) {{
        throw new AssertionError(message);
    }}

    private static final class BySelector {{}}
    private static final class By {{
        static BySelector text(String value) {{ return new BySelector(); }}
    }}
    private static final class SystemClock {{
        private static long now;
        static long uptimeMillis() {{ return now; }}
        static void sleep(long milliseconds) {{ now += milliseconds; }}
    }}

    public static void main(String[] args) throws Exception {{
        SameForegroundCallsiteHarness flow = new SameForegroundCallsiteHarness();
        boolean rejected = false;
        try {{
            flow.assertAutomaticOfferAbsentForBoundedCheck();
        }} catch (AssertionError expected) {{
            rejected = true;
        }}
        if (!rejected || flow.automaticOfferAbsentSameForeground) {{
            throw new AssertionError(
                    "visible same-foreground offer reached the accepted absence receipt");
        }}
        System.out.println("PASS sameForegroundActualBranch");
    }}
}}
"""
    java_source = destination / "SameForegroundCallsiteHarness.java"
    java_source.write_text(harness, encoding="utf-8")
    classes = destination / "classes"
    classes.mkdir()
    result = subprocess.run(
        [java_tool("javac"), "-d", str(classes), str(java_source)],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "Same-foreground callsite harness did not compile:\n" + result.stderr[-4000:]
        )
    return classes


def run_actual_same_foreground_callsite(classes: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [java_tool("java"), "-cp", str(classes), "SameForegroundCallsiteHarness"],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )


def append_result(
    results: list[dict[str, object]],
    name: str,
    baseline: subprocess.CompletedProcess[str],
    mutant: subprocess.CompletedProcess[str],
) -> bool:
    killed = baseline.returncode == 0 and mutant.returncode != 0
    results.append(
        {
            "test": name,
            "baselinePassed": baseline.returncode == 0,
            "mutantKilled": killed,
            "mutantExit": mutant.returncode,
        }
    )
    return killed


def main() -> int:
    original = CHECKS.read_text(encoding="utf-8")
    runtime_original = RUNTIME_FLOW.read_text(encoding="utf-8")
    results: list[dict[str, object]] = []
    with tempfile.TemporaryDirectory(prefix="yawf-automatic-ota-driver-") as temporary:
        root = Path(temporary)
        baseline_classes = compile_variant(original, root / "baseline")
        for index, (name, assertion, before, after) in enumerate(
            PREDICATE_MUTANTS, start=1
        ):
            if original.count(before) != 1:
                raise RuntimeError(f"Expected one mutation site for {name}")
            baseline = run_assertion(baseline_classes, assertion)
            mutant_classes = compile_variant(
                original.replace(before, after, 1), root / f"mutant-{index}"
            )
            mutant = run_assertion(mutant_classes, assertion)
            if not append_result(results, name, baseline, mutant):
                print(json.dumps({"passed": False, "tests": results}, indent=2))
                return 1

        actual_method = extract_method(
            runtime_original, "assertAutomaticOfferAbsentForBoundedCheck"
        )
        if actual_method.count(ACTUAL_BRANCH_BEFORE) != 1:
            raise RuntimeError("Expected one actual same-foreground branch mutation site")
        runtime_mutant = runtime_original.replace(
            actual_method,
            actual_method.replace(ACTUAL_BRANCH_BEFORE, ACTUAL_BRANCH_AFTER, 1),
            1,
        )
        baseline_actual = compile_actual_same_foreground_callsite(
            runtime_original, root / "actual-branch-baseline"
        )
        mutant_actual = compile_actual_same_foreground_callsite(
            runtime_mutant,
            root / "actual-branch-mutant",
        )
        if not append_result(
            results,
            "sameForegroundActualBranch",
            run_actual_same_foreground_callsite(baseline_actual),
            run_actual_same_foreground_callsite(mutant_actual),
        ):
            print(json.dumps({"passed": False, "tests": results}, indent=2))
            return 1
    print(json.dumps({"passed": True, "tests": results}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
