# Hosted iPad foreground observation

This is a synthetic, credential-free simulator QA lane. It is not a release,
physical-iPad test, external-provider test, background/PiP test, or proof that a
user's pause was fixed. The UI test uses an ephemeral unsigned XCTest anchor and
an installed Safari web app. It does not ship a native app.

The manual workflow has two modes:

- `admission` runs independent direct and 480p HLS cases, each with an actual
  15-second wall window after the native first-frame readiness gate. This is
  admission evidence only, not endurance evidence.
- `full` requests separate direct and production 480p HLS 480-second windows,
  plus a fresh held-segment negative control. Successful execution emits
  `observation-only`, with `fullQualification` false and manual pixel review
  pending. A green workflow is not a full qualification.

The observer records native `requestVideoFrameCallback` results, media state,
and event-driven `timeupdate` and foreground `requestAnimationFrame` samples.
The latter two are coalesced to at most one observation per second each. These
are QA-only collector requests, not media requests or lease renewals. Missing
rAF or sequence evidence is an instrumentation gap, not proof of a stall. The
negative control uses the real fixture's held TS request and the unchanged
15-second decoded-progress detector.

The fixture and inherited FFmpeg are confined to loopback under a macOS sandbox,
with separate Python and FFmpeg negative controls. CoreSimulator WebContent
and unrelated system traffic are **not** covered by that sandbox. The selected
video source must still be an observed loopback direct/HLS route; unknown and
blob sources are not qualified. The Homebrew media toolchain is QA-only and is
not the shipped media runtime.

The runner requires at least 7.5 GiB free before creating its runtime, preserves
6 GiB free, and caps allocated runtime plus the owned device at 1.5 GiB and
retained diagnostic logical bytes at 250 MiB. Accounting or ownership errors
refuse the run. A newly created device, fixture process group, and ports are
checked during cleanup. Raw logs, cookies, the WebClip, full screenshots, and
xcresults stay private to the ephemeral runner and are not uploaded. Each
positive case can retain at most five bounded synthetic-player crops, stripped
of PNG metadata, with a hash-bound manifest and sanitized status receipt. The
whole retained set is capped at 32 MiB.

An authorized push to `codex/ipad-foreground114-qa` starts the admission matrix.
Only the explicit `codex/ipad-foreground114-full-qa` branch selects the full
matrix on push. Push the same reviewed source there only after admission.
Where manual workflow dispatch is available, use:

```sh
gh workflow run ipad-foreground-qa.yml --ref <qa-branch> -f run_mode=admission
```

The actual XCTest selector is
`SafariNativeInputTests/IPadForegroundTests/testInstalledPwaForeground`.
A completed admission does not imply that the full native run is ready or that
its background behavior is known.
