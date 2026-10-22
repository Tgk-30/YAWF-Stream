# Android permission-return lifecycle fixture

This isolated debug fixture exercises one narrow updater boundary on a fresh API 36 emulator:

1. Build the existing success-fixture target APK for `com.yawf.permissionreturnfixture` at version 90.0.2/code 90000002, then stage the exact same pinned bytes into the positive and negative fixture builds.
2. Copy that valid target from the fixture asset into private update storage and seed its actual size, SHA-256, package, version and filename in the updater's persisted candidate format at `PHASE_STAGED`.
3. Use public `PackageManager` archive parsing with `GET_SIGNING_CERTIFICATES` to require the target package, version and current signer set, including equality with the installed fixture signer set.
4. Let the exact reviewed updater parse that state and show `Update ready to install`.
5. Use the ordinary `Install` action to open the fixture package's real Android `Allow from this source` page.
6. Strictly parse the APK Signing Block and its `0x42726577` zero-padding entry, change exactly one padding byte without changing the APK length, and fail closed if the entry or its bounds are absent or malformed. No fallback content or signature mutation is permitted.
7. Parse the changed APK again through public `PackageManager` and require unchanged package, version and current signer set before enabling permission through the visible Settings switch and pressing Back once.
8. Require the Activity's real lifecycle forwarding to reach the updater's SHA-256 verification failure, clear the rejected staged file, return persisted state to preparing, clear the permission-return marker, and show only the exact changed-stage retry message without exposing a package-installer surface.
9. Reopen the same scoped Settings page and visibly turn the permission off.

`prepare_fixture_source.mjs` accepts only updater source revision `9fc94a237d99b849cfc18a01085bb487915dd978` with SHA-256 `bf42027e5f1aa0715d51ef68b87f4c6c209173465613896357071eebc599b565`, and rewrites only its package declaration for `com.yawf.permissionreturnfixture`. The transformed fixture source SHA-256 is pinned to `13204e15181c05d62f492ba074962a314ef2623415c7181528f595a8eca30c93`. The fixture has no `INTERNET` permission, no feed, no signing input and no direct verification hook. Its persisted JSON is consumed by the updater's own candidate parser when the Activity resumes.

## Scope

Passing proves the candidate updater's permission-return lifecycle and fail-closed rejection when only the valid target APK's parsed signing-block padding differs from the seeded SHA-256. Public archive parsing establishes that package, version and current signer identity still match before updater verification, so the exact changed-stage result is attributable to the digest mismatch rather than a later package-identity failure. It also proves staged-file removal, an unset permission-return marker, `PHASE_PREPARING`, the exact changed-stage retry UI, no installer, and visible permission cleanup. It does not prove public OTA discovery or download, package installation, production signing, update data preservation, or ordinary production-app presentation.

The proposed workflow is manual-only and read-only. Its checkout revision, updater digest, transformed digest and both fixture `BuildConfig` source hashes are bound to the same final integrated updater source.

## Negative control

The bounded workflow matrix builds a negative-control variant that forwards the initial `onResume` normally, then omits only the `onResume` edge where the persisted `awaiting_install_permission` marker proves return from the unknown-source trip. It must reach the ready UI, same-length tamper, and enabled permission, but retain staged bytes and fail to reach verifier-recovery UI. Both variants visibly revoke permission. Do not alter the pinned updater source for this control, and do not treat the control build as product evidence.

## Seeded success fixture

The success fixture is a separate positive transaction. It does not combine its result with either tamper result:

| Transaction | Fixture build | Required outcome |
| --- | --- | --- |
| Changed SHA-only recovery | `app` debug | Full verification rejects the same-size target whose only changed byte is inside the strictly parsed signing-block padding entry, removes it, returns state to preparing, shows the exact changed-stage retry UI, and opens no installer. |
| Return-resume omission | `app` negative control | The initial resume runs, only the permission-return resume is omitted, tampered bytes remain staged, and verifier recovery does not occur. |
| Seeded success | `success-fixture` baseline 90.0.1 plus target 90.0.2, driven by `success-driver` | Real permission return reaches full verification and the OS installer, then the driver confirms the update identity and preserved state. |

The target fixture must be built first. `stage_success_target.mjs` copies its pinned bytes to both `success-fixture/build/generated/successBaselineAssets/success-target.apk` and `app/build/generated/tamperBaselineAssets/success-target.apk`. Only the success baseline flavor and the app debug and negative-control variants consume those generated assets. The target flavor consumes neither path, so it cannot recursively contain itself. Both fixture paths receive the same build-supplied SHA-256 and size.

`success-driver` is a separate instrumentation host package. That process remains alive while Android replaces the fixture package. It performs exactly one fixture `Install` action, uses the real fixture-scoped unknown-source Settings switch, presses Back once, waits for the updater to open the system installer, chooses the exact system `Update` action, and then chooses `Open`. It verifies version 90.0.2, unchanged UID, signer set and first-install time, the target activity's exact canary and cleanup receipt, and visible permission revocation. The target APK is never pushed or installed through ADB. Initial baseline and driver installation are test setup, not update proof.

Root-owned workflow integration should run these commands once after checking out the pinned updater revision and generating the exact package-only copy:

```sh
gradle --project-dir scripts/android-permission-return-fixture \
  --no-daemon --max-workers=2 \
  :success-fixture:assembleTargetDebug

target=scripts/android-permission-return-fixture/success-fixture/build/outputs/apk/target/debug/success-fixture-target-debug.apk
test "$(apkanalyzer manifest application-id "$target")" = com.yawf.permissionreturnfixture
test "$(apkanalyzer manifest version-name "$target")" = 90.0.2
test "$(apkanalyzer manifest version-code "$target")" = 90000002
target_sha="$(sha256sum "$target" | awk '{print $1}')"
target_size="$(stat -c %s "$target")"
node scripts/android-permission-return-fixture/stage_success_target.mjs \
  --target "$target" --sha256 "$target_sha" --size "$target_size" \
  --receipt "$EVIDENCE/success-target-binding.json"

gradle --project-dir scripts/android-permission-return-fixture \
  --no-daemon --max-workers=2 \
  -PsuccessTargetSha256="$target_sha" -PsuccessTargetSize="$target_size" \
  :app:assembleDebug \
  :app:assembleDebugAndroidTest \
  :success-fixture:assembleBaselineDebug \
  :success-driver:assembleDebug \
  :success-driver:assembleDebugAndroidTest
```

The return-resume-omitted build uses the same target properties and adds only `-PfixtureTestBuildType=negativeControl` while selecting the existing negative-control tasks.

Before dispatch, the root-owned workflow must verify the built fixture and target are signed by the same workflow-controlled default debug signer in all three modes. For seeded success it also verifies the baseline identity is 90.0.1/code 90000001, installs only the baseline, driver and driver test APKs on a fresh API 36 emulator, and runs `SuccessPermissionReturnFlowTest` from `com.yawf.permissionreturndriver.test`. The workflow must not ADB-push or ADB-install the target asset.

A passing success fixture uses the real valid target APK and therefore proves the fixture's successful cryptographic and package-identity verification path, lifecycle continuation, system installer handoff, fixture update identity, private canary preservation, updater cleanup and permission cleanup. It does not prove public discovery, download, production signing, production package update, production presentation, or user-data migration beyond the fixture canary.

## Independent visible permission cleanup

Positive and negative core instrumentation write core-only receipts and do not revoke their own package's install permission. The workflow installs the existing separate driver host and runs `FixturePermissionCleanupTest` after the core command, even if that command fails. The helper can query only the exact fixture package. It opens the real fixture-scoped Android Settings page and visibly turns the reviewed switch off. No shell app-op or permission mutation is used.

Core and cleanup outputs, exit statuses and bounded evidence archives remain separate. Aggregate success requires both instrumentation processes to finish with `OK (1 test)`, a passing core receipt with every existing mode assertion, and a passing cleanup receipt proving the switch was initially enabled, clicked and observed off in three settled samples. An already-off cleanup no-op cannot pass the transaction. Seeded success retains its existing separate-driver test and internal visible cleanup.

These are lifecycle fixture checks, not proof of public OTA discovery, production signing or full platform functionality.
