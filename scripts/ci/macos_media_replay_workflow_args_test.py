#!/usr/bin/env python3
"""Exercise the replay mode argv block with the platform /bin/bash."""

import os
import subprocess
import sys
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
WORKFLOW = ROOT / ".github/workflows/macos-media-replay-experiment.yml"
BEGIN = "          # BEGIN replay argument selection"
END = "          # END replay argument selection"
INDENT = "          "


def argument_selection_block() -> str:
    lines = WORKFLOW.read_text().splitlines()
    start = lines.index(BEGIN)
    finish = lines.index(END)
    selected = lines[start + 1:finish]
    if not selected or any(not line.startswith(INDENT) for line in selected):
        raise AssertionError("workflow argument selection block has unexpected indentation")
    return "\n".join(line[len(INDENT):] for line in selected)


def run_selection(mode: str) -> subprocess.CompletedProcess:
    script = (
        "set -euo pipefail\n"
        + argument_selection_block()
        + "\nprintf 'ARG=%s\\n' \"${probe_args[@]}\"\n"
    )
    return subprocess.run(
        ["/bin/bash", "-c", script],
        env={"PATH": "/usr/bin:/bin", "PROBE_ONLY": mode},
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


class ReplayWorkflowArgumentTests(unittest.TestCase):
    def test_platform_bash_selects_exact_probe_and_full_vectors(self):
        version = subprocess.run(
            ["/bin/bash", "--version"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=True,
        ).stdout
        self.assertIn("GNU bash, version", version)
        if sys.platform == "darwin":
            self.assertRegex(version, r"version 3\.2\.")

        full = run_selection("false")
        self.assertEqual(full.returncode, 0, full.stderr)
        self.assertEqual(full.stdout.splitlines(), ["ARG=--jobs", "ARG=8"])

        probe = run_selection("true")
        self.assertEqual(probe.returncode, 0, probe.stderr)
        self.assertEqual(probe.stdout.splitlines(), ["ARG=--jobs", "ARG=8", "ARG=--probe-only"])

    def test_unknown_mode_is_rejected(self):
        result = run_selection("unexpected")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("Refusing unexpected PROBE_ONLY value", result.stderr)

    def test_workflow_keeps_mode_and_timeout_boundaries(self):
        workflow = WORKFLOW.read_text()
        self.assertIn("probe_args=(--jobs 8)", workflow)
        self.assertIn('"${probe_args[@]}"', workflow)
        self.assertNotIn("probe_args=()", workflow)
        self.assertIn("default: true", workflow)
        self.assertIn("github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && inputs.probe_only)", workflow)
        self.assertIn("timeout-minutes: ${{ (github.event_name == 'pull_request' || inputs.probe_only) && 20 || 90 }}", workflow)


if __name__ == "__main__":
    unittest.main()
