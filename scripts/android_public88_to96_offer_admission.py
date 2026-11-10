#!/usr/bin/env python3
"""Admit one exact public88-to96 initial-offer case after public-byte checks.

No SDK, device, network, clock or product mutation. The caller downloads the
canonical public assets and bounded complete release history first. This receipt
does not qualify cancellation, due/resume scheduling or data-state persistence.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import android_public_ota_runtime_check as runtime


def admit(args: argparse.Namespace) -> dict[str, str]:
    if args.profile != runtime.PUBLIC88_TO96_OFFER_PROFILE:
        raise runtime.RuntimeGateError("The separate public88-to96 profile must be explicit")
    value = dict(runtime.PUBLIC88_TO96_OFFER_ADMISSION)
    binding = runtime.load_public88_to96_offer_binding(value)
    runtime.validate_host_inputs(args, binding)
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True,
                        choices=(runtime.PUBLIC88_TO96_OFFER_PROFILE,))
    for name in (
        "baseline-apk", "target-apk", "target-manifest", "target-verification",
        "target-checksums", "release-pages",
    ):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        value = admit(args)
    except (runtime.RuntimeGateError, OSError, ValueError) as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1
    print(json.dumps(value, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
