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

## Fifth hosted harness failure and composite persona card

Actual run `43314842842` failed at 2026-11-12 21:56:33 UTC after 39.830 seconds. It successfully dismissed the initial Welcome through Skip and found the persona heading. The retained screenshot shows the Quick setup card, but the driver next required a redundant standalone StaticText named Quick setup. The semantic control is a composite button, so that extra precondition refused before selecting it. This remains a harness failure, not a product or updater pass.

The correction removes only that redundant standalone StaticText requirement. The exact persona heading remains required, followed immediately by capture 02. The existing composite Quick setup button still requires its name and full explanatory copy in the same title or label, with the same unique/hittable guard. No target app, updater, timing, privacy acknowledgement or state-persistence behavior changes. A direct source regression rejects reintroducing the removed precondition. Host verification passes 37 tests and 14 independent source mutation controls. Actual native Quick setup/privacy and the complete OTA lifecycle remain pending root's compiled hosted run.

## Sixth hosted harness failure and responsive Settings category

Actual run `43317159778` failed at 2026-11-12 22:11:39 UTC after 54.769 seconds while requiring a hittable Appearance button. Its actual AX shows a PopUpButton titled exactly `SETTINGS CATEGORY`, with value `Install & setup`, at the fixed 1024-pixel runner width. Source Settings.css hides desktop category chips at max-width 1099px and shows the category select. The absent desktop Appearance button is therefore the wrong responsive UI target, not proof that the category or updater is broken.

Pre/post Appearance and Profiles navigation now uses a shared ordinary UI helper: require the unique hittable exact-named category popup, click it, retain a screenshot and AX phase immediately BEFORE querying its option, click a unique hittable exact-named Appearance or Profiles menu item within the app, then require the popup's exact selected value. Only those two categories are accepted. It does not set a value, preference, JS or API state and does not invent a wide-layout fallback. All Compact, profile, watchlist, updater and persistence assertions remain unchanged.

The popup is observed; the opened option's MenuItem role is still a prospective native selector, not observed proof. If the role or menu attribution differs, the pre-query screenshot/AX will preserve that next refusal. Host verification passes 38 tests and 18 independent source controls, including reversion to the old desktop button, incorrect popup role, missing pre-query capture and omitted selected-value verification. Root owns SDK compile and actual native execution. No OTA success is claimed.

## Seventh hosted harness failure and observed Compact preset role

Actual run `43318538014` failed at 2026-11-12 22:20:59 UTC after 58.022 seconds on the requested Compact control button. Retained AX `7EB6A904...txt` shows an on-screen `Appearance styles` Group and its CheckBox with exact title and label `Apply Compact control style`, value 0. The driver incorrectly searched Buttons for that aria-pressed preset.

Both the seed and post-update assertion now require the unique exact-named Appearance styles group, then its unique hittable exact-named CheckBox. The seed uses the same ordinary click. The existing selected-value 1/true/NSNumber/selected-state assertion and complete Compact preset meaning remain unchanged; no preference, JS, API, updater or other state behavior changes. Host verification passes 40 tests. Two additional independent source reverts, one for seed and one for the persisted check, are correctly rejected, alongside the existing 18 controls. Root owns SDK compile and the next actual hosted lifecycle run. The seventh failure remains a harness failure, not an OTA or product pass.

## Eighth hosted harness failure and scoped profile center input

Actual run `43320203481` failed at 2026-11-12 22:31:02 UTC after 57.949 seconds when typing the profile name without keyboard focus. Retained AX shows the exact NAME text field, value You, at frame 178/551/784/45. Root's video inspection found the synthesized click at 570/596, the field's bottom edge, and Command-A selecting the page rather than the field. This remains a UI-driver failure, not an updater or product pass.

The revised input first activates the admitted private app and captures the current screen/AX. It freshly requires the unique hittable exact-named NAME field with value You, the unique app window, and a nonzero finite field frame fully contained in that window. It then uses only the public field-relative normalized center coordinate 0.5/0.5, not guessed absolute coordinates, followed by app-level Command-A and typing the fixed name OTA Runner once. It captures after typing and requires that SAME exact field's value to read back OTA Runner before Save or any remaining state/updater flow. There is no input fallback, retry, private focus API, KVC, JS or preferences mutation.

The normal center input remains prospective until root's compiled hosted execution. All other Compact/profile/watchlist/updater/persistence guards are unchanged. Host verification passes 40 tests, including 23 independent source controls in total: the previous 20 plus center-input, contained-frame and exact typed-readback regressions. The old value-based profile guard control remains adapted to actual value rather than a label. No native focus, persistence or OTA success is claimed by these source checks.

## Ninth failure retained; bounded baseline-state paste workaround

Actual run `43322014024` failed at 2026-11-12 22:43:17 UTC after 70.179 seconds on the exact NAME readback guard. Root's retained video showed center focus working while character-by-character typing reverted the controlled value, ending as `You nr` rather than OTA Runner. This is retained as evidence of a real profile-name editing defect, not waived as a passing typing test. The independent product fix at `1af07af26bb1...` has source/test/build evidence, but its native candidate verification remains pending.

For the separate public updater persistence test, the baseline name is now deliberately seeded with ONE ordinary paste, not character-by-character editing. Exact NAME/value You, fresh finite window-contained field frame, app activation and public element-relative center click remain required. After Command-A, the code repeats the fresh hosted-runner admission before accessing NSPasteboard.general. It clears only this fresh VM clipboard, verifies clear/change-count/empty types, writes only the literal OTA Runner as .string once, and reads back only that just-written literal. It sends one Command-V, captures after paste, and requires the same exact NAME field to read back OTA Runner before Save. A defer clears this test VM clipboard. It never reads or restores a prior personal clipboard, requests TCC access, uses a private API, retries, falls back to typing, or changes app preferences through hidden interfaces.

This is an explicitly scoped baseline-state-seed workaround. A future successful run qualifies ordinary persisted-state retention and the public updater/archive lifecycle only. It does NOT qualify baseline keyboard editing, native behavior of the new product fix, or an application release. All three persisted-state checks and all signature/archive/update/relaunch guards remain unchanged. Root owns SDK compile and actual hosted execution. Host verification passes 41 tests and 28 independent source controls, including fresh clipboard admission, successful clear, literal readback, deferred clear, and rejection of typing fallback.


## Scoped Detail toggle roles before the next hosted run

The public96 Detail markup uses aria-pressed on Watchlist, the same pattern already observed as a macOS CheckBox for Compact. The updater state-seeding query now permits only Button or CheckBox roles with the exact Watchlist name inside the unique Inception details group. It refuses duplicate semantic targets, performs one click, then requires the exact In watchlist control to report selected state. This is a source-backed prospective selector correction, not a retained native Watchlist failure or a successful updater claim. A pre-ranked-card phase capture preserves evidence if that card is clipped; no speculative scrolling fallback was added.

## Mac11 split update-notice witness, run10 kept separate

Prior actual AX `A9262641...txt` lines 82 through 88 shows one notice Group with DIRECT StaticText values `Update v`, `2.3.102`, and ` available`, plus direct Install and Dismiss update notification buttons. It does not contain a combined StaticText `Update v2.3.102 available`. The Mac10 immutable run `43329680658` subsequently failed after481.091 native test seconds because that combined StaticText was unavailable. Root retained the original run, downloaded its artifact and exported97 attachments. Its actual AX again shows the split notice. This edit does not modify that failed run, its inputs or the existing180-second/normal-reopen deadlines.

The new finder reads a public immutable app.snapshot and copies only a bounded hierarchy: at most 1024 nodes, depth 32, and 512 characters per public title/label/string value. It requires one app window and exactly ONE matching notice group within it. Only DIRECT children may supply the three exact expected-version text parts and exact Install/Dismiss buttons. Each physical child counts once even when multiple public attributes match; the three text nodes and two buttons must be distinct. It never assembles text from unrelated or nested groups. Missing/altered/duplicated parts refuse; multiple qualifying groups throw. Notice and button frames must be finite, nonzero and contained in the app window; buttons must also be inside the notice.

The normal 180-second first wait and one Command-Q/reopen path remain unchanged in scope. Captures precede the first query and retain missing/ambiguous-query evidence. After an offer is found, the driver obtains the global unique hittable Install, takes a fresh notice witness, rechecks global uniqueness/hittability and its fully contained frame, then performs the one ordinary Install click. All existing archive/source, three persisted states, replacement PID/path/version, updater-owned relaunch and normal quit guards remain unchanged. No private AX/KVC, JS, preferences or new updater API calls are used.

After root reported 244 terminal, host-only tests compiled the ACTUAL extracted pure Swift witness with Foundation/CoreGraphics, not XCTest/AppKit or native UI. Thirteen semantic fixtures pass: split values, matching title/label/value counted once, altered version, missing part, cross-group/nested assembly, ambiguous notices, duplicate part, one node impersonating three parts, duplicate Install, outside-window/zero frames, depth and node bounds. Four separately compiled causal mutants correctly fail altered-version, missing-part, descendant-scope and ambiguity fixtures. Lightweight source controls also protect distinct nodes, Install containment, bounds and fresh snapshots. Total 44 host tests and 38 individual source/compiled controls pass. A resource-only DS_MAC_NOTICE_SKIP_SWIFT_HOST=1 switch skips the compiler test during an explicitly held diagnostic window; it was NOT set for the final 44/44 run. All compiler outputs/module caches used Work TMPDIR locally.

This is source and host-algorithm evidence, not proof that native Mac11 selected an offer or completed OTA. Root owns the full SDK compile and hosted native run. The baseline paste workaround remains limited to state seeding, not keyboard-editing qualification or native validation of the independent profile product fix.

Mac11 final review closure additionally requires the live Install frame to equal the fresh witness installFrame exactly, alongside finite/hittable/global-unique and notice/window containment guards immediately before the one click. An individual source mutation removing this equality is correctly rejected. Final host rerun: 44/44 pass, 13 compiled semantic fixtures, 4 compiled causal controls, 39 total source/compiled controls. The actual run10 failure/481.091 seconds/97 retained attachments above remain unchanged. No native execution is claimed.
