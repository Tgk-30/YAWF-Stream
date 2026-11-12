# macOS public updater lifecycle qualification

This is a narrow, destructive XCUITest for a disposable GitHub-hosted `macos-15` arm64 runner. It launches an exact private copy of the signed public 2.3.96 app, uses only its visible UI and embedded public updater feed, installs 2.3.102, observes the updater-owned relaunch at the same private path, verifies ordinary user state survived, then quits through Command-Q.

Never execute the UI test on a real user's login or on a self-hosted runner. Local use is limited to host unit tests, project parsing, and `build-for-testing`. The controller and XCTest independently require the GitHub markers plus actual Darwin arm64, macOS 15, Darwin 24, the `runner` account returned by the operating system, its physical `/Users/runner` home, and the fixed physical `$RUNNER_TEMP`. Environment variables alone cannot admit execution. XCTest may replace its sandboxed `HOME`, so Swift verifies the current account with `getpwuid(getuid())` and does not trust or require the `HOME` environment value.

## Evidence boundary

- The admitted baseline is the physical public archive with SHA-256 `32d1b9041c0ddc5ef9201edc9420028bb764be5aa6046071164d6b646ca89901` and size `95584873`. Its signature, notarization, release target, and SLSA statement are separate evidence.
- The SLSA resolved dependency `3cd6e640d17f0a1da89da6c2a9387954bb61663a` identifies the recovery workflow dependency. It is not claimed here as proof of the original binary compile source.
- The signed physical v2.3.96 executable independently embeds the public `latest-macos11.json` endpoint. Its bundled compiled web assets contain `downloadAndInstall`, the update offer text, the Quick setup flow, and the Compact style control used by this test. Read-only source at `3cd6e640d17f0a1da89da6c2a9387954bb61663a` documents the matching normal `check()`, `downloadAndInstall()`, and `relaunch()` design, without claiming that ref compiled the physical archive. The test never replaces that feed or calls either plugin directly.
- GitHub documents standard hosted jobs as fresh virtual machines, with listed exceptions that do not include this `macos-15` standard runner. The workflow must still set the explicit admission marker consumed here.

## Current evidence and title-aware selector revision

Three actual hosted CI attempts are retained as harness failures, not updater or product passes:

- `43298974667`: hosted-environment admission refused before app UI, 1.766 seconds, at 2026-11-12 20:20:09 UTC.
- `43303114330`: unique hittable `Quick setup` selector refused, 65.843 seconds, at 20:46:43 UTC. A bare button name did not describe the observed semantic card.
- `43306264306`: required `Welcome to YAWF Stream` heading selector refused, 38.660 seconds, at 21:05:18 UTC. The actual native AX representation requires title-aware matching, not a label-only assumption.

Their original logs and attachments remain separate. No attempt above qualifies the updater lifecycle. Root verified the public `XCUIElementAttributes.title` property in the installed SDK header. This supports using its public predicate attribute, not undocumented KVC. Current ordinary-control naming matches exact title OR label. Static text tries exact title, then exact label, then exact value, refusing multiple matches at each priority before returning one. This avoids counting a WebKit heading title plus child text value as two controls. Quick setup requires both its title and complete explanation in the same title or label attribute. Installing progress checks title, label and bounded public value fallback. Profile input and persisted selection assertions still use their actual values, not labels substituted for values.

The initial public-attribute JSON attachment precedes the first required UI selector. It records bounded title/label/value strings from at most 20 buttons and 20 static texts, at most 512 characters each, with a 64,000-byte total bound. It does not capture credentials. Six bounded phase screenshots/AX attachments remain in place.

Host verification: 37 tests pass, including all 32 unchanged controller/security baseline tests and the updated UI source contract. Twelve independent source mutations are correctly rejected for title naming, Quick setup copy, Installing value, title priority, exact matching, ambiguity, value fallback/preservation and probe ordering/bounds. These are source-contract checks only. They do not execute XCTest, establish the current native AX tree, prove Quick setup/privacy navigation, or qualify OTA/persistence. Native Quick setup, privacy acknowledgement and the full public updater lifecycle remain pending actual hosted execution and retained evidence. SDK build results are separately root-owned.

## Root-owned workflow recipe

1. Use one `macos-15` arm64 GitHub-hosted job with a 30 minute job timeout. Do not reuse a self-hosted runner or run this job under a local account.
2. Download the exact public 2.3.96 archive and independently obtain the public 2.3.102 macOS 11 archive. Verify their published hashes, sizes, GitHub attestations, strict code signatures, and notarization before this harness.
3. Extract the 2.3.102 archive beneath `$RUNNER_TEMP/reference102/YAWF Stream.app`. Keep every input and derived output beneath `$RUNNER_TEMP`. The controller admits and hashes this disjoint reference before UI launch, rejects overlap with the private candidate, and verifies that the reference did not change during the test.
4. Run `node --test scripts/mac-ota-runtime/controller.test.mjs`.
5. Run the controller's `prepare` command. It rechecks the pinned 2.3.96 archive identity, creates a new private app directory, and verifies the private app before launch:

   ```sh
   export RUNNER_ENVIRONMENT=github-hosted
   node scripts/mac-ota-runtime/controller.mjs prepare \
     --archive96 "$RUNNER_TEMP/downloads/YAWF.Stream_2.3.96_aarch64.app.tar.gz" \
     --runRoot "$RUNNER_TEMP/mac-ota102"
   ```

6. Compile only the ad hoc test helper. This does not build or modify either candidate app:

   ```sh
   xcodebuild build-for-testing \
     -project scripts/mac-ota-runtime/MacOTARuntime.xcodeproj \
     -scheme MacOTARuntime \
     -configuration Release \
     -derivedDataPath "$RUNNER_TEMP/mac-ota-derived" \
     -destination 'platform=macOS,arch=arm64'
   ```

7. Locate the single generated `.xctestrun` under the derived-data Products directory and execute through the controller. Xcode adds a known seven-entry target-app environment even for this targetless test. The controller accepts only those exact generated values and removes the entire target-app environment before execution. It injects configuration into the XCTest runner only, never into YAWF Stream:

   ```sh
   XCTESTRUN="$(find "$RUNNER_TEMP/mac-ota-derived/Build/Products" -name '*.xctestrun' -type f -print -quit)"
   test -n "$XCTESTRUN"
   node scripts/mac-ota-runtime/controller.mjs execute \
     --runRoot "$RUNNER_TEMP/mac-ota102" \
     --xctestrun "$XCTESTRUN" \
     --expected102App "$RUNNER_TEMP/reference102/YAWF Stream.app"
   ```

8. The sandboxed XCTest runner emits the lifecycle receipt as the keep-always attachment named `MacOTARuntimeReceipt`. Xcode 26.3 exports that name as `MacOTARuntimeReceipt_0_<UUID>.json`; the controller requires this anchored SDK naming form rather than guessing a filename. It exports attachments for the exact testcase, requires one exact manifest row and one exact named bounded JSON file, validates the receipt, records its SHA-256 in `verified.json`, and never asks XCTest to write outside its sandbox. Six fixed normal-UI boundaries also retain a window screenshot and an accessibility hierarchy capped at 64,000 characters. These fresh Quick setup screens contain no credentials. Upload the `.xcresult`, `prepared.json`, `receipt-attachments`, and `verified.json` even on failure when present. Never upload browser data, keychains, credentials, or the app's user-data directory.

Success requires all of these observations: exact baseline archive and private path with no symlinked ancestor; no preexisting process with the product bundle identifier; the initial tier Welcome group dismissed through its scoped Skip control; the exact Quick setup semantic card chosen from the persona screen; its privacy and reliability acknowledgement retained; the separate post-setup Welcome tour dismissed normally; Compact density, profile name `OTA Runner`, and fixture title `Inception` added through unique hittable controls; an exact 2.3.102 offer; Install clicked once; installation progress or the old PID exit observed; a different PID relaunched from the same exact path; version 2.3.102; all three state markers persisted; normal Command-Q completed; strict signature and notarization remained valid; and the installed bundle's content manifest matched the independently downloaded public 2.3.102 app. If the offer is no longer visible after seeding, the test permits one normal Command-Q and launch to repeat the normal launch check, and records that branch in its receipt.

This proves only one public signed arm64 macOS 15 manual Install lifecycle under a fresh hosted identity. It does not prove automatic installation, weekly cadence, Intel, older macOS versions, an existing user's data, provider authentication, followed-server behavior, or any Android, Windows, Linux, iOS, or server path.

## Fourth hosted harness failure and immutable diagnostic snapshot

Actual run `43311161277` failed at 2026-11-12 21:34:24 UTC after 12.776 seconds, before the required UI selectors or initial Skip. The optional public-attribute diagnostic enumerated live `allElementsBoundByIndex` references while WebKit changed; index 3 disappeared and XCTest refused its snapshot. This is a retained harness failure, not an OTA or product failure, and it does not supersede the earlier three failures.

The diagnostic now takes one public `Welcome.snapshot()` and traverses only that immutable snapshot's children. Root verified `XCUIElementSnapshot.children` and `snapshotWithError` as public declarations in `XCUIElement.h` lines 339 through 358. It is scoped to the existing Welcome group, not the entire app. Traversal is bounded to depth 32 and 512 visited nodes, at most 20 buttons and 20 static texts, 512 characters per attribute, and 64,000 JSON bytes. A missing Welcome or failed optional snapshot returns without replacing required selector checks. No live index references are retained in the diagnostic. Root owns the separate SDK compile and actual native execution.

The diagnostic source contract now requires this one-snapshot traversal and all bounds. A thirteenth independent source-control mutation reintroduces a live app button index list and is correctly rejected. The other 36 tests are unchanged; all 37 host tests pass. Source checks still do not prove native Quick setup, privacy, OTA, relaunch or persistence success.
