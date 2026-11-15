# Owned startup destroy/retry instrumentation

This is a standalone **test-only** Android app and instrumentation APK. The instrumentation targets the ordinary installed package `com.tgk30.debridstreamer`; it does not bundle or replace the product. Its sole claim is that one selected Tauri plugin callback failure, after accepted WebView creation begins, can be followed by one native Retry tap and successful creation of a distinct WebView in the same Activity/process. It does not test streaming, ANR recovery, every plugin ordering, provider setup, server behavior, or general lifecycle correctness.

## Exact Tauri API input

The test must compile against the exact public Tauri Android API from crate `tauri 2.12.4`, but runtime classes must come from the installed production APK. Android library/AAR `compileOnly` is intentionally not used. Supply a separately produced API **JAR** containing the API project's compiled `classes.jar` contents, and a JSON source receipt binding that JAR to the source crate/version/checksum and source hashes below. No Tauri classes are copied into this project, and the test app must not use `implementation` for the API.

Required environment variables (or matching Gradle properties):

- `TAURI_ANDROID_API_CLASSES_JAR`: absolute path to the exact API JAR.
- `TAURI_ANDROID_API_CLASSES_JAR_SHA256`: lowercase SHA-256 of that JAR.
- `TAURI_ANDROID_API_SOURCE_RECEIPT`: path to a JSON receipt with `schemaVersion: 1`, `crateName: "tauri"`, `crateVersion: "2.12.4"`, `crateChecksum: "f316751027fc2644221d1a448564d519efb07067fda584879d9cda966391d212"`, matching `classesJarSha256`, non-empty `buildEnvironment`, and `sourceFiles` equal to the pinned map in `app/build.gradle.kts`.

The receipt producer must build from the checksum-verified crate source and extract only the Android library's `classes.jar` from its resulting AAR. Record the actual build environment and verify the extracted JAR hash. The harness task `verifyTauriAndroidApiInput` fails closed if the JAR/receipt is missing, mismatched, or from another source. This repository does not produce that JAR and no Gradle/Android build has been run as part of source preparation.

AndroidX AppCompat appears only as a regular `androidTestImplementation` because Tauri's `Plugin` API signatures mention `AppCompatActivity`; it is not a `compileOnly` AAR. The only `compileOnly` inputs are the checksum-bound Tauri API JAR in the app and instrumentation compile classpaths.

## Test protocol and refusal behavior

The custom runner injects the test plugin after the target Activity's `onCreate` returns and before its first resume/draw. The test plugin's first `load(WebView)` callback inspects the live Tauri `HashMap` and proceeds only when its own key is actually first in the current iteration order. Otherwise the run refuses with `FAULT_NOT_FIRST`; it never assumes the map's order. First callback captures the old WebView and throws once. A second callback records a distinct new WebView; any further callback refuses.

The test waits for the observed, unique, visible, enabled `Retry startup` button. Before interaction it requires the first WebView detached, Wry's sole WebView-typed field cleared, the startup helper's sole accepted-WebView field cleared, and no WebView in the decor tree. It then takes one fresh button-bounds sample and dispatches exactly one touchscreen down/up pair with `Instrumentation.sendPointerSync`. It does not invoke `performClick`, accessibility-index actions, JavaScript, setup/provider flows, or a retry loop. A stale/ambiguous/missing target fails closed.

Success requires the same target process and Activity, exactly two plugin loads, a distinct attached second WebView, the old WebView still detached, Wry and Activity references pointing to the new object, exactly one decor WebView, no Retry button, and the plugin handle marked loaded after the callback returns. The status payload is a bounded JSON object with fixed-schema booleans/counts and no URL, title, configuration, credential, screenshot, or exception text. Failure status is not success evidence.

The test has an overall 150-second cooperative deadline (failure UI 60 seconds, retry 90 seconds), one launch, and one tap. These limits cover polling only. `Instrumentation.startActivitySync` and `runOnMainSync` can block and do not self-preempt a stuck UI thread or ANR; Root must impose an independent outer instrumentation-command timeout. There are no test retries. Root owns compilation, exact APK/certificate binding, instrumentation execution, and runtime-result interpretation. Until those occur this is preparation only, not a native runtime pass.

The runner obtains the manager from the target Activity's kept inherited `getPluginManager()` accessor and passes that exact instance to plugin registration and map inspection. PluginHandle instance and loaded state are found by unique declared field type, not unpinned getter names. Reflection intentionally fails closed if the installed minified package does not expose the expected unique Wry/helper WebView-typed fields or Tauri manager structures. The API JAR proves compile-time signatures only. The product's R8 keep rules and actual signed/minified APK classloader/reflection linkage must be verified during Root's runtime gate. In particular, availability of the test plugin's `load(WebView)` override through the real minified classloader is an open runtime gate, not guaranteed by this preparation; no product keep rule is added here.
