# Disposable iPad native-input QA harness

Source preparation only. This is a simulator-only UIKit counter app and XCTest
UI runner, not a YAWF iOS product, App Store build, playback test or installed-PWA
qualification. No third-party packages, production keys or signing configuration
are used. The checked-in project disables signing and permits only
`iphonesimulator`, with iPad device family 2 and deployment target 26.5.

## Root-owned device admission

Root creates a NEW blank uniquely named iPad later. Never select, reuse, erase,
move or change an existing device. Prefer a custom set under Work if Xcode can
discover it. `simctl --set` is documented, but this Xcode's `xcodebuild` help does
not document a custom-set switch. Do not assume an undocumented override works.

The default set is a real directory at
`~/Library/Developer/CoreSimulator/Devices`, not on Work. If custom-set discovery
fails, root may explicitly approve ONE new uniquely named blank default-set
device. That does not authorize changing global defaults, moving a device set,
or touching the existing YAWF Safari QA device or any other simulator.

Record a creation receipt in owned Work evidence:

```json
{
  "schemaVersion": 1,
  "createdFor": "ipad-native-qa",
  "createdFresh": true,
  "udid": "ROOT-CREATED-UDID",
  "name": "YAWF-iPad-NativeQA-ROOT-RUN-UUID",
  "runtimeIdentifier": "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  "deviceSetPath": "/Volumes/Work/ROOT-OWNED-PATH/Devices",
  "rootApprovedDefaultSet": false
}
```

The receipt is root's explicit fresh-device attestation, not a heuristic inferred
from no observed activity. Capture `simctl --set "$SET" list devices -j` and
`xcodebuild -project "$PROJECT" -scheme NativeQA -showdestinations` into separate
owned Work files. Run the read-only metadata preflight:

```sh
node scripts/ipad-native-qa/preflight.mjs \
  "$E/ownership.json" "$E/devices.json" "$E/destinations.txt"
```

It must admit the exact UDID, name, iPad type, runtime and data-path metadata, and
find that exact UDID in the AVAILABLE iOS Simulator destinations. Fail closed if
undiscoverable. No name-based or default-device fallback is permitted. XCTest
independently requires the exact root-provided `SIMULATOR_UDID` and device name;
an automatically created clone is not accepted. Disable parallelization in both
the project and command. Never run against `booted` or a physical device.

## Root-only build and test commands, NOT executed by source preparation

Use Xcode explicitly without changing `xcode-select` or host settings:

```sh
export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
PROJECT="$W/scripts/ipad-native-qa/NativeQA.xcodeproj"
# W, E, UDID and DEVICE_NAME must come from the admitted owned receipt.
# E and all generated products/results must be on Work.
xcodebuild build-for-testing -project "$PROJECT" -scheme NativeQA \
  -sdk iphonesimulator -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath "$E/DerivedData" -parallel-testing-enabled NO \
  -maximum-concurrent-test-simulator-destinations 1 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  QA_EXPECTED_UDID="$UDID" QA_OWNED_DEVICE_NAME="$DEVICE_NAME" \
  QA_HTTP_PROBE_URL="$QA_HTTP_PROBE_URL" \
  QA_EXPECTED_FIXTURE_ID="$QA_EXPECTED_FIXTURE_ID" \
  QA_EXPECTED_SOURCE_REVISION=262881ed48a0e7810f3fc06b79961cd7a870d134
```

Inspect only the generated owned `.xctestrun` and confirm the shared scheme's five
environment macros resolved to these exact public test values. Do not run with
unresolved macros, change a Safari launch environment, grant permissions or
enable Developer Tools access. Root selects the exact generated `.xctestrun`:

```sh
xcodebuild test-without-building -xctestrun "$OWNED_XCTESTRUN" \
  -destination "platform=iOS Simulator,id=$UDID" -destination-timeout 30 \
  -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1 \
  -test-timeouts-enabled YES -default-test-execution-time-allowance 120 \
  -maximum-test-execution-time-allowance 120 \
  -resultBundlePath "$E/native-input.xcresult" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
```

Root can initially select only
`-only-testing:SafariNativeInputTests/SafariNativeInputTests/testNativeCounterInput`.
That test requires no HTTP adapter. It launches only the owned anchor and
requires three actual native taps, successive independent label/value assertions
and a retained screenshot. Safari's test repeats this control before Safari;
there is no dependency on test ordering or a previous pass.

## Safari and independent arrival contract

`testSafariPublicFixtureLogin` requires explicit root-provided
`QA_HTTP_PROBE_URL=http://127.0.0.1:43178/__qa/arrival`,
`QA_EXPECTED_FIXTURE_ID=<public fixture-instance UUID>` and the exact fixture
source revision. There is NO adapter implementation in this harness. The live
synthetic fixture must not be restarted or modified by this task.

Root's separately staged future GET adapter must return only:

```json
{
  "schemaVersion": 1,
  "fixtureInstanceId": "PUBLIC-FIXTURE-INSTANCE-UUID",
  "sourceRevision": "262881ed48a0e7810f3fc06b79961cd7a870d134",
  "loginSuccessCount": 0
}
```

Increment only after a successful known synthetic fixture login. Never record
cookies, tokens, request bodies, usernames or passwords in this probe. Serialize
fixture login attempts during this gate; an uncorrelated global counter is not
per-consumer attribution. The test reads the baseline, performs ordinary native
Safari input and requires exactly baseline+1, matching instance/source, and a
visible, hittable Watchlist control. A missing/404 adapter or missing configuration
is a failure, not a skipped or successful Safari test.

The test first validates the existing GET `/api/health` contract:
`ok=true`, `ready=true`, `version=2.3.76`, `setupRequired=false`,
`setupTokenRequired=false`. Public, synthetic-only credentials are
`fixture-owner` / `fixture-owner-password`, with OTP empty. They are not user or
provider credentials. Safari opens the ordinary loopback URL through public
`XCUIApplication.open`, types into actual Username/Password fields, taps Sign in,
may tap the ordinary nonbinding Welcome tour Skip, and taps visible Watchlist.

No JavaScript, cookie, profile, preference, private API or direct login HTTP
injection is used. Probe traffic is GET-only, ephemeral and cookieless, bounded
to 5 seconds/4096 bytes, and redirects are rejected. No HTTP health result or
Safari launch alone can pass the input gate. Unexpected terms, authentication,
privacy, Developer Tools or security screens cause failure, never acceptance.
The current host's Developer Tools mode is disabled; locked-host bootstrap and
unsigned runner compatibility remain actual-runtime questions for root. Do not
change security settings to make a test pass.

## Source-only checks and limits

```sh
node --test scripts/ipad_native_qa.test.mjs
```

These checks validate metadata guards, public probe schema, source contracts,
Swift parsing, plist/scheme syntax and Xcode project listing only. They do not
build or launch the anchor/runner, sign artifacts, boot/create simulators, or
qualify locked-host input. Root must retain actual `.xcresult` counts and native
screenshots before reporting a native pass. Playback, PWA Add to Home Screen,
standalone storage and physical iPad behavior are separate later gates.

## Hosted counter-only canary

`.github/workflows/ipad-native-qa.yml` permits manual dispatch and same-repository draft pull requests affecting only
this workflow or the harness paths. It has read-only repository permissions. It uses the existing installed Xcode26.5/iOS26.5 toolchain on the
`macos-26` ARM runner. It never downloads runtimes, changes security settings,
uses a developer account, signs a release, or publishes an iOS product.

`hosted-run.mjs` admits the actual toolchain and at least8GiB free disk before
creating one newly named default-set iPad(A16). It records the returned UUID
before boot/build. The existing `validateOwnership` policy remains unchanged;
the hosted wrapper supplies fresh evidence from its exact canonical
`RUNNER_TEMP/ipad-native-qa-RUN_ID-RUN_ATTEMPT` directory instead of weakening
the separate local Work-only CLI. Preexisting simulator identity/state metadata
must match before and after. Cleanup uses only the newly recorded UUID and
refuses mismatched or preexisting ownership.

The generated `.xctestrun` must contain one expected UI-test target, five resolved
public QA settings and only the expected products under that run's DerivedData.
Application bundle identifiers, ARM64 executable hashes and the test-run hash
are retained. The loopback URL/fixture UUID are explicitly unused placeholders:
no server, HTTP adapter, Safari test, authentication or playback is started.
Only `testNativeCounterInput` is selected. A pass requires the actual owned
XCTest destination, exactly1passed/0failed/0skipped tests, the exact counter method
and an exported retained Counter3 PNG. Failure screenshots are attached before
teardown terminates the anchor. Command logs and complete bounded `.xcresult`
are retained even when the transaction fails; DerivedData is not uploaded.
Artifact-budget, cleanup or preexisting-device-drift failures fail the job. An
`always()` cleanup-only workflow step revalidates the creation receipt after a
controller interruption. It never creates/builds/tests or selects a fallback.
Native child processes receive only a small noncredential environment; CI
credentials and arbitrary launch overrides are not forwarded.

Source/host contracts only:

```sh
node --test scripts/ipad-native-qa/hosted-run.test.mjs
```

After review, root may push a draft pull request to execute the narrow hosted
job without merging main. Once the workflow is registered, root may also dispatch:

```sh
gh workflow run ipad-native-qa.yml --ref codex/ipad-hosted77
```

No hosted native run has been performed by source preparation. An unsigned
runner launch or result-format incompatibility is a failed canary, not permission
to enable automation/security settings or manufacture a pass. This first canary
cannot qualify Safari login, PWA installation/storage, codecs, audio or player UX.
