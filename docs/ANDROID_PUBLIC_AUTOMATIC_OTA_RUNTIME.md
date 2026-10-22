# Public automatic Android OTA runtime gate

This is preparation for a future official public Android release. No suitable
strictly post-2.3.30 public target is asserted to exist by this document or by
the workflow defaults. The workflow has no future target defaults and cannot
run until the dispatcher supplies a complete official public tuple.

## Immutable baseline

The automatic flow starts from exactly one product install of the official
public 2.3.27 APK:

- Version: `2.3.27`
- Version code: `2003027`
- Tag: `android-v2.3.27`
- Source revision: `9fc94a237d99b849cfc18a01085bb487915dd978`
- APK: `YAWF.Stream_Android_2.3.27.apk`
- APK SHA-256: `f3e983929db9fb32ed42b9779d94f2f8492c1cf4fae3e0cd29eee91a9492e0eb`
- APK size: `88558465` bytes
- Certificate SHA-256: `233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a`

## Required future target tuple

`.github/workflows/android-public-automatic-ota-runtime.yml` requires every
field below as an explicit manual-dispatch input. None has a default:

- semantic version and exactly mapped version code, strictly after 2.3.30
- 40-character lowercase source commit
- positive verification build workflow run
- lowercase APK SHA-256 and positive byte size
- lowercase `android-update.json` SHA-256
- lowercase public verification receipt SHA-256

Before Java, Android SDK, or emulator setup, the workflow downloads the public
baseline APK and all target assets, retrieves a bounded official GitHub release
history in canonical, contiguous numeric files from `page-1.json` through at
most `page-10.json`, constructs the input for
`scripts/android_public_automatic_ota_admission.mjs`, and executes that current
admission helper. The Python host then independently binds actual bytes for the
baseline APK, target APK, manifest, verification receipt, and `SHA256SUMS` to:

- an official `Tgk-30/YAWF-Stream` non-draft, non-prerelease published tag
- exact official asset URLs, uploaded state, API sizes, and API digests
- the newest stable Android release
- the manifest source revision and APK identity
- verification build provenance, source revision, unchanged signed candidate,
  and signer continuity

After SDK setup, the same host runs `apksigner` and `apkanalyzer` over both
downloaded APKs. The target APK remains a host-side reference. It is never
installed, pushed, synchronized, staged, or passed to ADB.

## Runtime admission and proof boundary

The owned emulator run admits exactly two harness APK installs followed by
exactly one baseline product install. The host rejects later product install or
transfer routes, direct installer intents, privileged product data access,
feed and preference mutation, permission mutation, and clock mutation.
Automatic-mode generic ADB calls use an exact command-shape allowlist limited
to the required read-only package, permission, file, crash, and harness evidence
observations. Harness and baseline installs, instrumentation, and the two APK
pulls are available only through their ordered, one-shot stateful methods.

The instrumentation receives the complete admitted tuple and follows only the
reviewed `automatic-initial-cancel-due-resume` path: initial manual check,
cancel before its result, same-foreground absence, later launcher/Home return,
automatic offer, product Install, unknown-source consent, system Update and
Open, warm persistence, visible recent-task dismissal, launcher relaunch,
task-relaunch persistence, and visible permission cleanup. There is no manual
check or reconsent fallback.

The final installed APK pull is admitted only after the positive receipt proves
automatic discovery and all required UI facts. Its bytes, version, version
code, signer, UID retention, first-install-time retention, changed update time,
unknown-source cleanup, and residual-update-file cleanup are then checked.

This proves task-relaunch persistence only. It does not prove an independent
cold-process replacement, weekly elapsed scheduling, physical-device behavior,
or a real public OTA until an eligible official tuple exists and this workflow
finishes successfully. The workflow only records the emulator process it owns;
it does not make a product PID replacement claim.
