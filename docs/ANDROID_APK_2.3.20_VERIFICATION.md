# Android APK 2.3.20 verification

Scope: native phone/tablet APK update delivery and public download presentation.
This is not a certification of every device, playback provider or codec.

## Exact artifact

- Release: [android-v2.3.20](https://github.com/Tgk-30/YAWF-Stream/releases/tag/android-v2.3.20)
- Source: `661b125353dabd7217ae1830906a4a747f8d9f25`
- Package: `com.tgk30.debridstreamer`
- Version/code: `2.3.20` / `2003020`
- APK: `YAWF.Stream_Android_2.3.20.apk`, 88,468,267 bytes
- SHA-256: `2f8009b236929104854851d3930f4ccbbdb3160a354a035822b023f4b7875963`
- Production signing identity matches the repository phone certificate pin and the public 2.3.9 APK.
- Minimum API 24, target API 36. All four ABIs, 16 KiB ZIP/ELF alignment, compiled private FileProvider resource binding, permissions, absence of instrumentation/test content, and checksums passed the strict verifier.

## Source and candidate gates

- [Full release-source CI](https://github.com/Tgk-30/YAWF-Stream/actions/runs/38996574917): passed.
- [Production signing and exact APK verification](https://github.com/Tgk-30/YAWF-Stream/actions/runs/38996574932): passed.
- Web: 248 files, 4,098 tests; production build, CSS compatibility and bundle budgets passed.
- Rust: 87 tests; locked check, format and strict clippy passed. Fresh audit reported zero vulnerabilities; existing maintenance/unsoundness warnings remain recorded rather than ignored.
- Updater/generation/manifest scripts: 14 tests, including 83 executable production Kotlin JVM assertions and exact Android SDK compilation.
- APK verifier fixtures: 33 tests, including compiled numeric resource references and renamed XML files.
- Actual-source mutations were killed for the installer visibility preflight, external completion notification, once-per-Activity cadence latch, and download-page presentation contracts.
- The exact public ref set and publish ref passed the repository privacy preflight. No history or signing identity was rewritten.

## Isolated Android runtime qualification

| Path | Observed result |
| --- | --- |
| Public 2.3.9 directly to 2.3.20, Android 11 / API 30 | Same-signer manual installation succeeded without uninstalling. A synthetic private app file retained its exact hash. Native update consent appeared. Declining it left automatic checks disabled. |
| Production-signed verification baseline 2.3.18 to public 2.3.20, Android 11 / API 30, arm64, 4 KiB pages | Native discovery, public download, hash/package/version/signer validation, private staging, Android permission screen and system package installer completed. Installed APK bytes matched the published hash exactly. |
| Same native update, Android 16 / API 36, arm64, 16 KiB pages | Completed through the actual Android installer, with the exact published APK installed. This was not an ADB installation of the target version. |
| Automatic result timing | The enabled baseline found the real public update but deferred its offer until the next foreground. The current session did not receive an automatic update modal. |
| Permission denial and recovery | On API 30, returning without enabling unknown-source installation showed a retry/later prompt. Deferring and restarting retained the verified staged update. Enabling permission then allowed installation. |
| Installer cancellation | On API 36, cancelling Android's installer returned to the verified staged update. Retrying and confirming installed successfully. |
| Staged process recovery | Force-stopping and relaunching the API 30 app retained the verified package and reopened the native install prompt. |
| Retained data and cleanup | Both native upgrades retained the synthetic private-file hash and saved updater preferences. Opening the updated app cleared its old staged APK. No real account data or credentials were used. |
| Ungranted URI read | An unrelated test app received FileNotFoundException and no bytes for the staged URI. The staged file's hash was independently confirmed; the Android installer with the native temporary grant subsequently installed it. |
| Long-lived weekly cadence | On installed 2.3.20, advancing only the isolated API 36 emulator clock eight days and returning to the foreground performed a successful new check without a process restart. The process ID stayed unchanged and the success timestamp advanced. The test clock was restored. |

The baseline APK was a private verification artifact, not a separately published
Android release. Updater preference/time fixtures were confined to the fresh
emulators. No phone, existing emulator, real provider account or server was modified.

## Website and channel qualification

- [Website deployment](https://github.com/Tgk-30/YAWF-Stream/actions/runs/38998541406): both mounts passed and deployed from website source `479460a84805`.
- Canonical and legacy download pages expose the Android APK button and exact `android-v2.3.20` asset URL.
- Settled live checks at 320x568, 390x844 and 1440x900 showed no horizontal overflow. The APK button was visible in the initial phone viewport.
- A download made through the live website button matched the published size and SHA-256 exactly.
- Lint, production build, budgets, all four mounted-site checks on both prefixes, and 13 focused presentation/catalog tests passed.
- The desktop latest release remained `v2.3.6-web`. Android TV and server download constants remained on their independently published channels.

## User action and limits

Older APKs cannot bootstrap this updater. Install the new signed APK over the
existing app once, without uninstalling, then enable weekly checks in its native
prompt. Checks run when the app opens or returns to the foreground. Downloads
and Android installation still require confirmation; silent installation is not
claimed.

Runtime qualification covers the initial/automatic Activity-owned flow. The local
Settings shortcut has source, ACL and Android compilation coverage, but its web
navigation path was not part of this runtime qualification. Download interruption
and malformed/mismatched metadata cases have automated source/JVM coverage, not
an exhaustive OS fault-injection matrix. Physical/OEM devices, other runtime ABIs
and live provider playback were not qualified by this update-specific run.
