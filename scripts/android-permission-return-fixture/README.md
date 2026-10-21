# Android permission-return lifecycle fixture

This isolated debug fixture exercises one narrow updater boundary on a fresh API 36 emulator:

1. Seed a syntactically valid newer candidate in the updater's private persisted format at `PHASE_STAGED`.
2. Let the exact reviewed updater parse that state and show `Update ready to install`.
3. Use the ordinary `Install` action to open the fixture package's real Android `Allow from this source` page.
4. Change one staged byte without changing its length, enable permission through the visible Settings switch, and press Back once.
5. Require the Activity's real lifecycle forwarding to reach the updater's full verification path, clear the rejected staged file, return persisted state to preparing, and show reviewed retry UI without exposing a package-installer surface.
6. Reopen the same scoped Settings page and visibly turn the permission off.

`prepare_fixture_source.mjs` accepts only updater source revision `9fc94a237d99b849cfc18a01085bb487915dd978` with SHA-256 `bf42027e5f1aa0715d51ef68b87f4c6c209173465613896357071eebc599b565`, and rewrites only its package declaration for `com.yawf.permissionreturnfixture`. The transformed fixture source SHA-256 is pinned to `13204e15181c05d62f492ba074962a314ef2623415c7181528f595a8eca30c93`. The fixture has no `INTERNET` permission, no feed, no signing input, no valid replacement APK, and no direct verification hook. Its persisted JSON is consumed by the updater's own candidate parser when the Activity resumes.

## Scope

Passing proves the candidate updater's permission-return lifecycle and fail-closed full-verifier rejection of the changed synthetic stage in this fixture. The synthetic staged bytes are not a valid APK, so this result does not uniquely prove that the digest comparison, rather than a later package-identity check, caused rejection. It does prove staged-file removal, an unset permission-return marker, `PHASE_PREPARING`, reviewed retry UI, no installer, and visible permission cleanup. It does not prove public OTA discovery or download, package installation, signer continuity, update data preservation, or ordinary production-app presentation.

The proposed workflow is manual-only and read-only. Its checkout revision, updater digest, transformed digest and both fixture `BuildConfig` source hashes are bound to the same final integrated updater source.

## Negative control

The bounded workflow matrix builds a negative-control variant that forwards the initial `onResume` normally, then omits only the `onResume` edge where the persisted `awaiting_install_permission` marker proves return from the unknown-source trip. It must reach the ready UI, same-length tamper, and enabled permission, but retain staged bytes and fail to reach verifier-recovery UI. Both variants visibly revoke permission. Do not alter the pinned updater source for this control, and do not treat the control build as product evidence.

## Seeded success fixture

The success fixture is a separate positive transaction. It does not combine its result with either tamper result:

| Transaction | Fixture build | Required outcome |
| --- | --- | --- |
| Changed synthetic-stage recovery | `app` debug | Full verification rejects the changed non-APK stage, removes it, returns state to preparing, shows bounded reviewed retry UI, and opens no installer. |
| Return-resume omission | `app` negative control | The initial resume runs, only the permission-return resume is omitted, tampered bytes remain staged, and verifier recovery does not occur. |
| Seeded success | `success-fixture` baseline 90.0.1 plus target 90.0.2, driven by `success-driver` | Real permission return reaches full verification and the OS installer, then the driver confirms the update identity and preserved state. |

The target fixture must be built first. Only the baseline flavor consumes the generated `success-target.apk` asset, so the target cannot recursively contain itself. `SuccessFixtureActivity` checks the asset's exact build-supplied SHA-256 and size before copying it into private staged storage. It seeds the updater's normal persisted candidate format, records consent declined with automatic checks off, and writes a private canary. It does not have `INTERNET` permission and does not invoke a private verifier or installer API.

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
  :success-fixture:assembleBaselineDebug \
  :success-driver:assembleDebug \
  :success-driver:assembleDebugAndroidTest
```

Before dispatch, the root-owned workflow must also verify the baseline and target are signed by the same workflow-controlled default debug signer, verify the baseline identity is 90.0.1/code 90000001, install only the baseline, driver and driver test APKs on a fresh API 36 emulator, and run `SuccessPermissionReturnFlowTest` from `com.yawf.permissionreturndriver.test`. The workflow must not ADB-push or ADB-install the target asset.

A passing success fixture uses the real valid target APK and therefore proves the fixture's successful cryptographic and package-identity verification path, lifecycle continuation, system installer handoff, fixture update identity, private canary preservation, updater cleanup and permission cleanup. It does not prove public discovery, download, production signing, production package update, production presentation, or user-data migration beyond the fixture canary.
