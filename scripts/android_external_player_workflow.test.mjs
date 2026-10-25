import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/android-current-runtime.yml', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('./android_external_player_server_fixture.mts', import.meta.url), 'utf8');
const driver = readFileSync(new URL('./android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeExternalPlayerFlowTest.java', import.meta.url), 'utf8');
const settingsTransaction = readFileSync(new URL('./android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeExternalSettingsTransaction.java', import.meta.url), 'utf8');
const externalLegalSnapshot = readFileSync(new URL('./android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeExternalLegalSnapshot.java', import.meta.url), 'utf8');
function topLevelJob(source, name) {
  const begin = source.indexOf(`  ${name}:\n`);
  assert.ok(begin >= 0, `Missing workflow job: ${name}`);
  const after = source.slice(begin + 1);
  const next = after.search(/^  [A-Za-z0-9_-]+:\n/m);
  return source.slice(begin, next >= 0 ? begin + 1 + next : source.length);
}

const job = topLevelJob(workflow, 'external-player-fixture');

function methodBody(source, signature) {
  const signatureIndex = source.indexOf(signature);
  assert.ok(signatureIndex >= 0, `Missing method signature: ${signature}`);
  const open = source.indexOf('{', signatureIndex + signature.length);
  assert.ok(open >= 0, `Missing method body: ${signature}`);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') depth--;
    if (depth === 0) return source.slice(open + 1, index);
  }
  assert.fail(`Unclosed method body: ${signature}`);
}

function mutateMethod(source, signature, before, after) {
  const body = methodBody(source, signature);
  const changedBody = body.replace(before, after);
  assert.notEqual(changedBody, body, `Mutation did not change ${signature}`);
  const bodyOffset = source.indexOf(body, source.indexOf(signature));
  return source.slice(0, bodyOffset) + changedBody + source.slice(bodyOffset + body.length);
}

function marker(source, begin, end, indent = 10) {
  const selected = source.split(`${begin}\n`)[1]?.split(end)[0];
  assert.ok(selected != null, `Missing marker ${begin}`);
  return selected.split('\n').map(line => line.replace(new RegExp(`^ {${indent}}`), '')).join('\n');
}

function workflowContract(w, j) {
  assert.match(w, /permissions:\n  contents: read\n  actions: read/);
  assert.match(w, /description: Test the exact public phone59 external-player flow with its exact released web UI and server source on a fresh supported API36 emulator/);
  assert.match(j, /if: github\.ref_type == 'branch' && inputs\.external_player_fixture == true && inputs\.permission_fixture != true/);
  assert.match(j, /SYSTEM_IMAGE_PACKAGE: system-images;android-36;google_apis;x86_64/);
  assert.match(j, /name: Exact public phone59 external player on fresh API36/);
  assert.match(j, /PRODUCT_APK: public-phone59\.apk/);
  assert.match(j, /PRODUCT_SHA256: 5fe550e66658f3c9ae172c087c656d69e126af2892df05ca15e7e021594dae47/);
  assert.match(j, /PRODUCT_SIZE: "88644481"/);
  assert.match(j, /PRODUCT_SOURCE: ac885bb98b2672614beb801b5aea11eb2f98ab40/);
  assert.match(j, /HOSTED_UI_SOURCE: ac885bb98b2672614beb801b5aea11eb2f98ab40/);
  assert.match(j, /SERVER_RUNTIME_SOURCE: ac885bb98b2672614beb801b5aea11eb2f98ab40/);
  assert.match(j, /PRODUCT_VERSION: 2\.3\.59/);
  assert.match(j, /PRODUCT_VERSION_CODE: "2003059"/);
  assert.match(j, /PRODUCT_SIGNER_SHA256: 233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a/);
  assert.match(j, /PRODUCT_RELEASE_TAG: android-v2\.3\.59/);
  assert.match(j, /AVD_NAME: yawf-external-phone59-api36/);
  assert.match(j, /releases\/download\/\$PRODUCT_RELEASE_TAG\/YAWF\.Stream_Android_\$PRODUCT_VERSION\.apk/);
  assert.match(j, /test "\$\(wc -c < "\$PRODUCT_APK" \| tr -d ' '\)" = "\$PRODUCT_SIZE"/);
  assert.match(j, /interoperability=exact-public-phone59-with-exact-ac885-hosted-ui-and-server-runtime/);
  assert.match(j, /name: android-phone59-external-player-runtime-evidence/);
  assert.doesNotMatch(j, /phone27|phone42|2\.3\.27|2\.3\.42|2003027|2003042|f3e983929d|9fc94a237d|3e1f72c2/);
  assert.match(j, /VLC_URL: https:\/\/download\.videolan\.org\/pub\/videolan\/vlc-android\/3\.7\.1\/VLC-Android-3\.7\.1-x86_64\.apk/);
  assert.match(j, /VLC_CHECKSUM_URL: https:\/\/download\.videolan\.org\/pub\/videolan\/vlc-android\/3\.7\.1\/VLC-Android-3\.7\.1-x86_64\.apk\.sha256/);
  assert.match(j, /VLC_SHA256: 4646633ede40c4784c5584087cffc5c60cc45b16966ae0b36cedd784d7c4a11e/);
  assert.match(j, /VLC_SIZE: "49444910"/);
  assert.match(j, /VLC_SIGNER_SHA256: c8768d2cea0c4b622e419b4b4715981946821e4ebc035fb41776cad395a7f68e/);
  assert.match(j, /VLC_PACKAGE: org\.videolan\.vlc/);
  assert.match(j, /VLC_VERSION: 3\.7\.1/);
  assert.match(j, /VLC_VERSION_CODE: "13070108"/);
  assert.match(j, /VLC_INTENT_ACTIVITY: org\.videolan\.vlc\.StartActivity/);
  assert.match(j, /VLC_PLAYBACK_ACTIVITY: org\.videolan\.vlc\.gui\.video\.VideoPlayerActivity/);
  assert.match(j, /--proto '=https' --proto-redir '=https'/);
  assert.match(j, /test "\$\(cat "\$VLC_APK\.sha256"\)" = "\$VLC_SHA256 \*\$VLC_APK"/);
  assert.match(j, /printf '%s  %s\\n' "\$VLC_SHA256" "\$VLC_APK" \| sha256sum --check -/);
  assert.match(j, /test "\$\(wc -c < "\$VLC_APK" \| tr -d ' '\)" = "\$VLC_SIZE"/);
  assert.match(j, /test "\$signer" = "\$VLC_SIGNER_SHA256"/);
  assert.match(j, /Pinned VLC StartActivity lost HTTP\/HTTPS video intent support/);
  assert.match(j, /playback=activities\[os\.environ\['VLC_PLAYBACK_ACTIVITY'\]\]/);
  assert.match(j, /runtimePass=false/);

  assert.match(j, /validate_webview_provider\(provider,minimum_major=90,expected_package='com\.google\.android\.webview',expected_version=None\)/);
  assert.ok(j.indexOf('major=validate_webview_provider') < j.indexOf('adb -s "$EMULATOR_SERIAL" install "$PRODUCT_APK"'));
  assert.match(j, /--certificate-pin public-phone-source\/web\/src-tauri\/SIGNING_CERT_SHA256/);
  assert.match(j, /test "\$source_pin" = "\$PRODUCT_SIGNER_SHA256"/);
  assert.match(j, /test "\$actual_signer" = "\$PRODUCT_SIGNER_SHA256"/);
  assert.match(j, /test "\$installed_sha" = "\$PRODUCT_SHA256"/);
  assert.match(j, /test "\$vlc_installed_sha" = "\$VLC_SHA256"/);
  assert.ok(j.indexOf('stock-video-handlers.txt') < j.indexOf('install "$VLC_APK"'));
  assert.ok(j.indexOf('install "$VLC_APK"') < j.indexOf('video-handlers-with-vlc.txt'));
  assert.match(j, /# BEGIN EXTERNAL_VLC_HANDLER_POLICY/);
  assert.match(j, /assert cursor==len\(lines\)/);
  assert.match(j, /assert len\(components\)==reported/);
  assert.match(j, /Duplicate Activity component/);
  assert.match(j, /Fresh image no longer has the exact recorded sole Photos handler/);
  assert.match(j, /Installed handler set differs from exact Photos plus admitted VLC/);
  assert.match(j, /'stockPhotosFailurePreserved':True/);
  assert.match(j, /'realChooserRequired':True/);
  assert.match(j, /test "\$handler_activity_count" = 2/);
  assert.match(j, /-e externalHandlerPlaybackActivity "\$handler_playback_activity"/);

  const installs = [...j.matchAll(/adb[^\n]*\binstall(?:-multiple|-multi-package)?\b[^\n]*/g)].map(match => match[0]);
  assert.deepEqual(installs, [
    'adb -s "$EMULATOR_SERIAL" install "$PRODUCT_APK" | tee "$EVIDENCE/product-install.txt"',
    'adb -s "$EMULATOR_SERIAL" install "$HARNESS_APP_APK"',
    'adb -s "$EMULATOR_SERIAL" install "$HARNESS_TEST_APK"',
    'adb -s "$EMULATOR_SERIAL" install "$VLC_APK" | tee "$EVIDENCE/vlc-install.txt"',
  ]);
  assert.doesNotMatch(j, /\b(?:pm\s+install|cmd\s+package\s+(?:install|grant)|pm\s+grant|appops\s+set|pm\s+(?:disable|hide)|set-home-activity|add-preferred-activity)\b/);
  assert.doesNotMatch(j, /secrets\.|contents: write|packages: write|adb root|settings put|run-as com\.tgk30/);

  assert.match(j, /adb -s "\$EMULATOR_SERIAL" logcat -c/);
  assert.match(j, /collect_bounded_player_logcat/);
  assert.ok(j.indexOf('collect_bounded_player_logcat') < j.indexOf('emu kill'));
  assert.match(j, /logcat -d -v threadtime -t 12000/);
  assert.match(j, /if index>=12000: break/);
  assert.match(j, /if total\+len\(encoded\)>8\*1024\*1024: break/);
  assert.match(j, /\[redacted-capability\]/);
  assert.match(j, /\[redacted-url\]/);
  assert.match(j, /\[redacted-sensitive\]/);
  assert.match(j, /rawPersisted=false/);
  assert.match(j, /for name in smoke-result\.json external-capability-runtime\.json media-probe\.json/);
  assert.match(j, /dumpsys','activity','activities/);
  assert.match(j, /manifestPlaybackActivityObserved/);
  assert.match(j, /'rawActivityDumpPersisted':False/);
  assert.match(j, /assert activity\['targetPackageObserved'\] is True/);
  assert.match(j, /assert activity\['manifestPlaybackActivityObserved'\] is True/);
  assert.match(j, /assert activity\['rawActivityDumpPersisted'\] is False/);

  assert.match(j, /# BEGIN EXTERNAL_DESTINATION_RECEIPT_POLICY/);
  assert.match(j, /assert all\(type\(value\) is bool for value in destination\)/);
  assert.match(j, /assert destination == \(True,False\)/);
  assert.match(j, /checks\['expectedHandlerForegroundObserved'\] is True/);
  assert.match(j, /checks\['vlcPlayerSurfaceObserved'\] is True/);
  assert.match(j, /checks\['permissionGrantUsed'\] is False/);
  assert.match(j, /checks\['semanticSeekGesturePerformed'\] is True/);
  assert.match(j, /checks\['singleBackReturnedToProduct'\] is True/);
  assert.match(j, /checks\['playbackActionsRailObserved'\] is True/);
  assert.match(j, /0<=checks\['playbackActionsRailPanAttempts'\]<=3/);
  assert.match(j, /if checks\['playbackActionsRailPanAttempts'\]==0:/);
  assert.match(j, /checks\['playbackActionsRailObserved'\] is False/);
  assert.match(j, /checks\['playbackSettingsClickCount'\]==1/);
  assert.match(j, /r\['settingsRailObservationEventsOmitted'\]==0/);
  assert.match(j, /r\['settingsTransactionTimingEventsOmitted'\]==0/);
  assert.match(j, /settings_click\['idleBeforeMs'\]==0 and settings_click\['idleAfterMs'\]==0/);
  assert.match(j, /event\['phase'\]=='live'.*status'\)==206/s);
  assert.match(j, /event\['lifecycle'\]\['finishObserved'\] is True/);
  assert.match(j, /event\['lifecycle'\]\['prematureCloseObserved'\] is False/);
  assert.match(j, /decodedPlaybackClaimed'\] is False/);

  assert.match(j, /\(cd public-phone-source\/web && npm ci && npm run build\)/);
  assert.match(j, /\(cd public-phone-source\/server && npm ci\)/);
  assert.match(j, /public-phone-source\/server\/node_modules\/tsx\/dist\/cli\.mjs scripts\/android_external_player_server_fixture\.mts/);
  assert.match(j, /--repo "\$GITHUB_WORKSPACE\/public-phone-source"/);
  assert.match(j, /source-runtime-admission\.json/);
  assert.match(j, /fixtureHarnessSource/);
  assert.match(j, /hostedUiSource/);
  assert.match(j, /serverRuntimeSource/);
  assert.match(j, /servedStaticWebDist/);
  assert.match(j, /dynamicWebRoutes/);
  assert.match(j, /assert smoke\['webDistInventory'\]==source\['hostedUi'\]\['webDist'\]\['files'\]/);
  assert.match(j, /assert smoke\['servedStaticWebDist'\]==source\['hostedUi'\]\['servedStaticWebDist'\]/);
  assert.match(j, /assert smoke\['dynamicWebRoutes'\]==source\['hostedUi'\]\['dynamicWebRoutes'\]/);
}

function fixtureContract(f) {
  assert.match(f, /realpathSync\(raw\) !== raw/);
  assert.match(f, /if \(readdirSync\(ARTIFACT_DIR\)\.length !== 0\)/);
  assert.match(f, /EXTERNAL_RECEIPT_LIMIT = 128/);
  assert.match(f, /type ExternalReceiptEvent =/);
  assert.match(f, /method: "GET" \| "HEAD"/);
  assert.match(f, /acceptClass: "absent" \| "video-mp4" \| "video-wildcard" \| "wildcard" \| "other"/);
  assert.match(f, /userAgentClass: "absent" \| "vlc-android" \| "google-photos" \| "fixture-inject" \| "other"/);
  assert.match(f, /finishObserved: boolean/);
  assert.match(f, /prematureCloseObserved: boolean/);
  assert.match(f, /const method: "GET" \| "HEAD" = methodValue/);
  assert.match(f, /start != null && end != null && end < start/);
  assert.match(f, /request\.raw\.once\("aborted"/);
  assert.match(f, /reply\.raw\.once\("finish"/);
  assert.match(f, /reply\.raw\.once\("close"/);
  assert.match(f, /app\.addHook\("onRequest"/);
  assert.match(f, /app\.addHook\("onResponse"/);
  assert.match(f, /MEDIA_PROBE_PATH/);
  assert.match(f, /spawnSync\("ffprobe"/);
  assert.match(f, /format=format_name,duration,size:stream=index,codec_type,codec_name,profile,level,codec_tag_string,pix_fmt,width,height,r_frame_rate,sample_rate,channels/);
  assert.match(f, /video\?\.codec_name !== "h264"/);
  assert.match(f, /video\.pix_fmt !== "yuv420p"/);
  assert.match(f, /audio\?\.codec_name !== "aac"/);
  assert.match(f, /writeMediaProbe\(\)/);
  assert.match(f, /exactly segment000\.ts through segment011\.ts/);
  assert.match(f, /drawtext=fontfile=/);
  assert.match(f, /externalFull\.headers\["content-type"\] !== "video\/mp4"/);
  assert.match(f, /externalFull\.headers\["accept-ranges"\] !== "bytes"/);
  assert.match(f, /externalFull\.headers\["content-disposition"\] != null/);
  assert.match(f, /MAX_WEB_DIST_FILES = 512/);
  assert.match(f, /MAX_WEB_DIST_BYTES = 64 \* 1024 \* 1024/);
  assert.match(f, /EXPECTED_WEB_DIST_FILES = 85/);
  assert.match(f, /EXPECTED_STATIC_WEB_DIST_FILES = 84/);
  assert.match(f, /function admittedWebDist\(\)/);
  assert.match(f, /function admittedServerModeOverride\(/);
  assert.match(f, /function verifyStaticWebAsset\(/);
  assert.match(f, /function verifyServerModeOverride\(/);
  assert.match(f, /function assertCompleteWebAccounting\(/);
  assert.match(f, /const SERVER_MODE_ROUTE = "\/server-mode\.js"/);
  assert.match(f, /const SERVER_MODE_BODY = "globalThis\.__DEBRIDSTREAMER_SERVER_URL__ = globalThis\.location\.origin;\\n"/);
  assert.match(f, /const SERVER_MODE_CONTENT_TYPE = "text\/javascript; charset=utf-8"/);
  assert.match(f, /const SERVER_MODE_CACHE_CONTROL = "no-store"/);
  assert.match(f, /const SERVER_MODE_DIST_STUB_BYTES = 247/);
  assert.match(f, /const SERVER_MODE_DIST_STUB_SHA256 = "beb74b650355356f4bf15582982ba9f9f30532bb38337a3604d29bf29c136101"/);
  assert.match(f, /source\.split\(SERVER_MODE_SOURCE_BINDING\)\.length !== 2/);
  assert.match(f, /servedStatic\.length \+ dynamicRoutes\.length !== inventory\.length/);
  assert.match(f, /servedStatic\.length !== EXPECTED_STATIC_WEB_DIST_FILES/);
  assert.match(f, /Compiled static web asset response differs from its exact admitted dist bytes/);
  assert.match(f, /Dynamic server-mode route differs from its exact source-bound override profile/);
  assert.match(f, /servedSha256 !== entry\.sha256/);
  assert.match(f, /servedStaticWebDist/);
  assert.match(f, /dynamicWebRoutes/);
  assert.doesNotMatch(f, /externalReceiptEvents\.push\([^)]*(?:rawUrl|externalPath|capability)/s);
  assert.doesNotMatch(f, /\/Volumes\/Work\/|\/private\/tmp\/ds-/);
}

function public59PinsContract(j) {
  assert.match(j, /PRODUCT_SHA256: 5fe550e66658f3c9ae172c087c656d69e126af2892df05ca15e7e021594dae47/);
  assert.match(j, /PRODUCT_SIZE: "88644481"/);
  assert.match(j, /PRODUCT_SOURCE: ac885bb98b2672614beb801b5aea11eb2f98ab40/);
  assert.match(j, /PRODUCT_VERSION_CODE: "2003059"/);
  assert.match(j, /PRODUCT_SIGNER_SHA256: 233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a/);
}

function exactReleasedSourceContract(j) {
  assert.match(j, /HOSTED_UI_SOURCE: ac885bb98b2672614beb801b5aea11eb2f98ab40/);
  assert.match(j, /SERVER_RUNTIME_SOURCE: ac885bb98b2672614beb801b5aea11eb2f98ab40/);
  assert.match(j, /\(cd public-phone-source\/web && npm ci && npm run build\)/);
  assert.match(j, /public-phone-source\/server\/node_modules\/tsx\/dist\/cli\.mjs scripts\/android_external_player_server_fixture\.mts/);
  assert.match(j, /--repo "\$GITHUB_WORKSPACE\/public-phone-source"/);
  assert.match(j, /assert release_source==os\.environ\['PRODUCT_SOURCE'\]==os\.environ\['HOSTED_UI_SOURCE'\]==os\.environ\['SERVER_RUNTIME_SOURCE'\]/);
  assert.match(j, /web=inventory\(Path\('web\/dist'\),512,64\*1024\*1024\)/);
  assert.match(j, /server=inventory\(Path\('server\/src'\),2048,32\*1024\*1024\)/);
  assert.match(j, /assert web\['fileCount'\]==85/);
  assert.match(j, /assert len\(served_static\)==84/);
  assert.match(j, /'packageLockSha256':sha256\(root\/'server\/package-lock\.json'\)/);
  assert.match(j, /'role':'test-only-separate-from-app'/);
  assert.match(j, /server_mode_binding=/);
  assert.match(j, /'bytes':247/);
  assert.match(j, /'sha256':'beb74b650355356f4bf15582982ba9f9f30532bb38337a3604d29bf29c136101'/);
  assert.match(j, /'profile':'server-mode-origin-override'/);
  assert.match(j, /'why':'production-server-origin-injection-overrides-local-mode-dist-stub'/);
  assert.match(j, /assert smoke\['webDistInventory'\]==source\['hostedUi'\]\['webDist'\]\['files'\]/);
  assert.match(j, /assert smoke\['servedStaticWebDist'\]==source\['hostedUi'\]\['servedStaticWebDist'\]/);
  assert.match(j, /assert smoke\['dynamicWebRoutes'\]==source\['hostedUi'\]\['dynamicWebRoutes'\]/);
  assert.match(j, /assert len\(smoke\['servedStaticWebDist'\]\)==84/);
}

function servedWebDistContract(f) {
  assert.match(f, /MAX_WEB_DIST_FILES = 512/);
  assert.match(f, /MAX_WEB_DIST_BYTES = 64 \* 1024 \* 1024/);
  assert.match(f, /servedSha256 !== entry\.sha256/);
  assert.match(f, /webDistInventory/);
  assert.match(f, /servedStaticWebDist/);
  assert.match(f, /dynamicWebRoutes/);
}

const serverModeRoute = '/server-mode.js';
const serverModeBody = 'globalThis.__DEBRIDSTREAMER_SERVER_URL__ = globalThis.location.origin;\n';
const serverModeDistStubSha256 = 'beb74b650355356f4bf15582982ba9f9f30532bb38337a3604d29bf29c136101';
const serverModeSourceBinding = `  app.get("/server-mode.js", async (_request, reply) => {
    reply.header("content-type", "text/javascript; charset=utf-8");
    reply.header("cache-control", "no-store");
    return reply.send(
      "globalThis.__DEBRIDSTREAMER_SERVER_URL__ = globalThis.location.origin;\\n",
    );
  });`;

function executableFixtureHelper(signature, parameters, constants = {}) {
  const body = methodBody(fixture, signature);
  const names = ['createHash', 'Buffer', ...Object.keys(constants)];
  const values = [createHash, Buffer, ...Object.values(constants)];
  return Function(...names, `return function (${parameters}) {${body}}`)(...values);
}

function exactServerModeAdmission() {
  const admit = executableFixtureHelper(
    'function admittedServerModeOverride(',
    'source, distStub',
    { SERVER_MODE_ROUTE: serverModeRoute, SERVER_MODE_BODY: serverModeBody,
      SERVER_MODE_CONTENT_TYPE: 'text/javascript; charset=utf-8',
      SERVER_MODE_CACHE_CONTROL: 'no-store', SERVER_MODE_SOURCE_BINDING: serverModeSourceBinding,
      SERVER_MODE_DIST_STUB_BYTES: 247, SERVER_MODE_DIST_STUB_SHA256: serverModeDistStubSha256 },
  );
  return admit(serverModeSourceBinding, {
    path: 'server-mode.js', bytes: 247, sha256: serverModeDistStubSha256,
  });
}

function settingsRailPolicyProbe(source) {
  const body = methodBody(source, 'private static String chooseNextSettingsAction(');
  const directory = mkdtempSync(join(tmpdir(), 'yawf-settings-rail-policy-'));
  const javaSource = `public final class SettingsRailPolicyProbe {
    private static final int MAX_PLAYBACK_ACTIONS_RAIL_PANS = 3;
    private static String chooseNextSettingsAction(
        boolean settingsVisible, boolean railVisible, boolean revealVisible,
        boolean revealTapPerformed, int railPanAttempts) {${body}}
    private static void expect(String expected, String actual) {
      if (!expected.equals(actual)) throw new AssertionError(expected + " != " + actual);
    }
    private static void expectFailure(boolean settings, boolean rail, boolean reveal,
        boolean revealed, int pans) {
      try {
        chooseNextSettingsAction(settings, rail, reveal, revealed, pans);
        throw new AssertionError("invalid state was admitted");
      } catch (AssertionError expected) {
        if ("invalid state was admitted".equals(expected.getMessage())) throw expected;
      }
    }
    public static void main(String[] args) {
      expect("wait", chooseNextSettingsAction(false, false, false, false, 0));
      expect("reveal", chooseNextSettingsAction(false, false, true, false, 0));
      expect("wait", chooseNextSettingsAction(false, false, true, true, 0));
      expect("pan-rail", chooseNextSettingsAction(false, true, false, false, 0));
      expect("pan-rail", chooseNextSettingsAction(false, true, false, false, 2));
      expect("click-settings", chooseNextSettingsAction(true, false, false, false, 0));
      expect("click-settings", chooseNextSettingsAction(true, false, false, false, 1));
      expectFailure(false, false, false, false, -1);
      expectFailure(false, true, false, false, 3);
      expectFailure(false, false, false, false, 4);
    }
  }`;
  const file = join(directory, 'SettingsRailPolicyProbe.java');
  writeFileSync(file, javaSource);
  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome ? join(javaHome, 'bin', 'javac') : 'javac';
  const java = javaHome ? join(javaHome, 'bin', 'java') : 'java';
  const compile = spawnSync(javac, ['-d', directory, file], { encoding: 'utf8' });
  if (compile.status !== 0) return compile;
  return spawnSync(java, ['-cp', directory, 'SettingsRailPolicyProbe'], { encoding: 'utf8' });
}

function playbackSettingsObservation(d, transactionSource, legalSource) {
  assert.equal((d.match(/openPlaybackSettingsTransaction\(\);/g) ?? []).length, 1);
  assert.match(d, /MEDIA_WAIT_MS = 60_000/);
  assert.match(d, /PLAYER_DIALOG_LABEL =\s*\n?\s*"Playing Synthetic Fixture Movie \(2026\)"/);
  assert.match(d, /PLAYBACK_SETTINGS_LABEL = "Playback settings"/);
  const call = methodBody(d, 'private void openPlaybackSettingsTransaction()');
  assert.match(call, /RuntimeExternalSettingsTransaction\.Result result = RuntimeExternalSettingsTransaction\.open\(/);
  assert.match(call, /return instrumentation\.getUiAutomation\(\)\.clearCache\(\)/);
  assert.match(call, /RuntimeExternalPlayerFlowTest\.this\s*\.assertNoOutOfScopeApprovalForSettingsTransaction\(\)/);
  assert.match(call, /return observePlaybackSettingsTransaction\(\)/);
  assert.match(call, /recordSettingsTransactionTiming\(/);
  assert.match(call, /recordSettingsClickTiming\(/);
  assert.match(call, /recordSettingsRailObservation\(/);
  assert.match(call, /RuntimeExternalPlayerFlowTest\.this\.log\(message\)/);
  assert.match(call, /MEDIA_WAIT_MS/);
  assert.match(call, /checks\.put\("playbackActionsRailPanAttempts", result\.railPanAttempts\)/);
  assert.match(call, /checks\.put\("playbackSettingsClickCount", result\.settingsClickCount\)/);
  assert.match(d, /MAX_SETTINGS_TRANSACTION_TIMING_EVENTS = 64/);
  assert.match(d, /MAX_SETTINGS_RAIL_OBSERVATIONS = 16/);
  assert.match(d, /receipt\.put\("settingsTransactionTimings", new JSONArray\(settingsTransactionTimings\)\)/);
  assert.match(d, /"settingsTransactionTimingEventsOmitted"/);
  assert.match(d, /receipt\.put\("settingsClickTiming", settingsClickTiming\)/);
  assert.match(d, /receipt\.put\("settingsRailObservations", new JSONArray\(settingsRailObservations\)\)/);

  const observation = methodBody(
    d,
    'private RuntimeExternalSettingsTransaction.Observation observePlaybackSettingsTransaction()',
  );
  assert.match(observation, /UiObject2 playerDialog = findUniqueExactProductDialog\(PLAYER_DIALOG_LABEL\)/);
  assert.match(observation, /playerDialog == null \|\| !hasVisibleBounds\(playerDialog\)/);
  assert.match(observation, /findLabeledClickableWithin\(\s*playerDialog, PLAYBACK_SETTINGS_LABEL, PLAYBACK_SETTINGS_LABEL\)/);
  assert.match(observation, /settings != null && hasVisibleBounds\(settings\)/);
  assert.match(observation, /assertVisibleBounds\(settings, PLAYBACK_SETTINGS_LABEL\)/);
  assert.match(observation, /Observation\.settings\(settings::click\)/);
  assert.match(observation, /UiObject2 rail = findUniquePlaybackActionsRailWithin\(playerDialog\)/);
  assert.match(observation, /Observation\.railPan\(\s*\(\) -> rail\.scroll\(Direction\.RIGHT, 0\.72f\)\)/);
  assert.match(observation, /assertVisibleBounds\(playerDialog, "playing movie dialog"\)/);
  assert.match(observation, /Observation\.reveal\(playerDialog::click\)/);
  assert.doesNotMatch(observation, /\.click\s*\(|device\.click|capture\(/);

  const helperBody = methodBody(
    transactionSource,
    'static Result open(Environment environment, long timeoutMs)',
  );
  assert.match(helperBody, /configurator\.setWaitForIdleTimeout\(TRANSACTION_IDLE_TIMEOUT_MS\)/);
  assert.match(helperBody, /Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.UPSIDE_DOWN_CAKE/);
  assert.match(helperBody, /if \(!cacheCleared\)/);
  const apiGuard = helperBody.indexOf('Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE');
  const cacheRefresh = helperBody.indexOf('environment.clearAccessibilityCache()');
  const policyGuard = helperBody.indexOf('runFreshLegalGuard(environment, configurator, "fresh-legal-guard")');
  const freshObservation = helperBody.indexOf('environment.observePlaybackSettings()');
  assert.ok(apiGuard < cacheRefresh && cacheRefresh < policyGuard && policyGuard < freshObservation);
  assert.doesNotMatch(helperBody, /environment\.assertNoOutOfScopeApproval\(\)/);
  assert.match(helperBody, /observation\.revealTarget != null/);
  assert.equal((helperBody.match(/observation\.revealTarget\.click\(\)/g) ?? []).length, 1);
  assert.equal((helperBody.match(/observation\.railPanTarget\.click\(\)/g) ?? []).length, 1);
  assert.equal((helperBody.match(/observation\.settingsTarget\.click\(\)/g) ?? []).length, 1);
  for (const stage of ['cache', 'fresh-legal-guard', 'fresh-input-legal-guard',
    'settings-acquisition', 'reveal-click', 'playback-actions-rail-pan-']) {
    assert.match(helperBody, new RegExp(`"${stage}"`));
  }
  const policy = methodBody(
    transactionSource,
    'private static String chooseNextSettingsAction(',
  );
  assert.match(policy, /railPanAttempts < 0/);
  assert.match(policy, /railPanAttempts >= MAX_PLAYBACK_ACTIONS_RAIL_PANS/);
  assert.match(policy, /revealVisible && !revealTapPerformed/);
  assert.match(helperBody, /environment\.recordSettingsClickTiming\(/);
  assert.match(helperBody, /finally \{\s*configurator\.setWaitForIdleTimeout\(previousIdleTimeoutMs\)/);

  const transactionGuard = methodBody(
    d,
    'private void assertNoOutOfScopeApprovalForSettingsTransaction()',
  );
  assert.match(transactionGuard, /RuntimeExternalLegalSnapshot\.assertNoBindingTermsVisible\(\s*instrumentation\.getUiAutomation\(\), BINDING_TERMS\)/);
  for (const packageName of [
    'com.android.permissioncontroller',
    'com.google.android.permissioncontroller',
    'com.android.settings',
    'com.google.android.packageinstaller',
    'com.android.packageinstaller',
  ]) assert.match(transactionGuard, new RegExp(`foreground\\.equals\\("${packageName.replaceAll('.', '\\.')}"\\)`));
  assert.match(legalSource, /automation\.getRootInActiveWindow\(\)/);
  assert.match(legalSource, /automation\.getWindowsOnAllDisplays\(\)/);
  assert.match(legalSource,
    /PREFETCHING_STRATEGY\s*=\s*\n?\s*AccessibilityNodeInfo\.FLAG_PREFETCH_DESCENDANTS_BREADTH_FIRST/);
  assert.match(legalSource, /window\.getRoot\(PREFETCHING_STRATEGY\)/);
  assert.match(legalSource, /node\.getChild\(childIndex, PREFETCHING_STRATEGY\)/);
  assert.doesNotMatch(legalSource, /FLAG_PREFETCH_UNINTERRUPTIBLE/);
  assert.match(legalSource, /MAX_NODES = 4_096/);
  assert.match(legalSource, /MAX_TRAVERSAL_MS = 1_000L/);
  assert.match(legalSource, /node\.isVisibleToUser\(\)/);
  assert.match(legalSource, /node\.getText\(\)/);
  assert.match(legalSource, /node\.getContentDescription\(\)/);
  assert.doesNotMatch(legalSource, /androidx\.test\.uiautomator\.(?:By|UiDevice)|findObjects?\(/);
}

function playbackSettingsPanelObservation(d) {
  assert.match(d, /EXTERNAL_PLAYER_LABEL =\s*\n?\s*"Open in external player Choose VLC or another installed video app"/);
  const runFlow = methodBody(d, 'private void runFlow()');
  assert.match(runFlow, /transition\("production-player-visible"\);\s*capture\("production-player"\);\s*openPlaybackSettingsTransaction\(\);\s*waitForUniquePlaybackSettingsDialog\(\);/);
  const capturePlayer = runFlow.indexOf('capture("production-player")');
  const transaction = runFlow.indexOf('openPlaybackSettingsTransaction()');
  const requirePanel = runFlow.indexOf('waitForUniquePlaybackSettingsDialog()');
  const capturePanel = runFlow.indexOf('capture("playback-settings-panel")');
  const scopedScroll = runFlow.indexOf('scrollPlaybackSettingsUntilLabeledClickable(');
  const captureExternal = runFlow.indexOf('capture("external-control-visible")');
  assert.ok(capturePlayer < transaction && transaction < requirePanel);
  assert.ok(requirePanel < capturePanel && capturePanel < scopedScroll);
  assert.ok(scopedScroll < captureExternal);
  assert.match(runFlow, /scrollPlaybackSettingsUntilLabeledClickable\(\s*EXTERNAL_PLAYER_LABEL, EXTERNAL_PLAYER_LABEL\)/);
  assert.doesNotMatch(runFlow, /scrollUntilLabeledClickable\(\s*(?:"Open in external player"|EXTERNAL_PLAYER_LABEL)/);

  const scopedLabel = methodBody(d, 'private UiObject2 findLabeledClickableWithin(');
  assert.match(scopedLabel, /Pattern labelPattern = exactLabel\(label\)/);
  assert.match(scopedLabel, /boundary\.findObjects\(By\.text\(labelPattern\)\)/);
  assert.match(scopedLabel, /boundary\.findObjects\(By\.desc\(labelPattern\)\)/);
  assert.match(scopedLabel, /if \(candidates\.size\(\) > 1\)/);

  const dialogFinder = methodBody(d, 'private UiObject2 findUniqueExactProductDialog(String label)');
  assert.match(dialogFinder, /By\.clazz\("android\.app\.Dialog"\)\s*\.pkg\(PRODUCT_PACKAGE\)\s*\.text\(exactLabel\(label\)\)/);
  assert.match(dialogFinder, /if \(dialogs\.size\(\) > 1\)/);

  const waitDialog = methodBody(d, 'private UiObject2 waitForUniquePlaybackSettingsDialog()');
  assert.match(waitDialog, /instrumentation\.getUiAutomation\(\)\.clearCache\(\)\);\s*assertNoOutOfScopeApproval\(\)/);
  assert.match(waitDialog, /findUniqueExactProductDialog\(PLAYBACK_SETTINGS_LABEL\)/);
  assert.match(waitDialog, /assertVisibleBounds\(dialog, "Playback settings dialog"\)/);

  const scoped = methodBody(d, 'private UiObject2 scrollPlaybackSettingsUntilLabeledClickable(');
  assert.match(scoped, /for \(int attempt = 0; attempt < 12; attempt\+\+\)/);
  assert.match(scoped, /instrumentation\.getUiAutomation\(\)\.clearCache\(\)\);\s*assertNoOutOfScopeApproval\(\)/);
  assert.match(scoped, /requireUniqueExactProductDialog\(\s*PLAYBACK_SETTINGS_LABEL, "Playback settings dialog"\)/);
  assert.match(scoped, /findLabeledClickableWithin\(dialog, label, description\)/);
  assert.match(scoped, /if \(found != null && hasVisibleBounds\(found\)\) \{\s*assertVisibleBounds\(found, description\);\s*return found;/);
  assert.match(scoped, /findUniqueScrollableWithin\(dialog, description\)/);
  assert.doesNotMatch(scoped, /findLabeledClickable\(label\)|device\.findObject\(\s*By\.scrollable/);

  const scrollable = methodBody(d, 'private UiObject2 findUniqueScrollableWithin(');
  assert.match(scrollable, /if \(dialog\.isScrollable\(\)\) candidates\.add\(dialog\)/);
  assert.match(scrollable, /dialog\.findObjects\(\s*By\.scrollable\(true\)\.pkg\(PRODUCT_PACKAGE\)\)/);
  assert.match(scrollable, /1,\s*candidates\.size\(\)/);
  assert.doesNotMatch(scrollable, /device\.findObject|device\.findObjects/);
}

function driverContract(
  d,
  transactionSource = settingsTransaction,
  legalSource = externalLegalSnapshot,
) {
  playbackSettingsObservation(d, transactionSource, legalSource);
  playbackSettingsPanelObservation(d);
  assert.match(d, /VLC_PACKAGE = "org\.videolan\.vlc"/);
  assert.match(d, /VLC_INTENT_ACTIVITY = "org\.videolan\.vlc\.StartActivity"/);
  assert.match(d, /VLC_PLAYBACK_ACTIVITY =\s*\n?\s*"org\.videolan\.vlc\.gui\.video\.VideoPlayerActivity"/);
  assert.match(d, /FULLSCREEN_TIP_TITLE = "Viewing full screen"/);
  assert.match(d, /FULLSCREEN_TIP_DESCRIPTION =\s*\n?\s*"To exit, swipe down from the top of your screen"/);
  assert.match(d, /FULLSCREEN_TIP_BUTTON = "Got it"/);
  assert.match(d, /VLC_NO_FILE_ACCESS = "No file access"/);
  assert.match(d, /VLC_NOTIFICATION_TITLE = "Notification permission"/);
  assert.equal((d.match(/openPlayer\.click\(\)/g) ?? []).length, 1);
  assert.match(d, /waitFor\(By\.text\(FIXTURE_ORIGIN_MESSAGE\)/);
  assert.match(d, /checks\.put\("decodedPlaybackClaimed", false\)/);
  assert.match(d, /receipt\.put\("decodedPlaybackClaimed", false\)/);
  assert.match(d, /handler-playback-t1/);
  assert.match(d, /handler-playback-t2/);
  assert.match(d, /handler-after-seek/);
  assert.match(d, /By\.clazz\("android\.widget\.SeekBar"\)\.pkg\(handlerPackage\)/);
  assert.match(d, /device\.pressBack\(\);\s*waitForForegroundPackage\(PRODUCT_PACKAGE/);
  assert.match(d, /checks\.put\("realAndroidChooserObserved", false\)/);
  assert.match(d, /checks\.put\("soleHandlerDirectLaunchObserved", false\)/);
  assert.match(d, /realAndroidChooserObserved && !soleHandlerDirectLaunchObserved/);

  const metadata = methodBody(d, 'private static boolean hasCompleteHandlerMetadata(');
  for (const field of ['label', 'packageName', 'activity', 'playbackActivity', 'activityCount']) {
    assert.match(metadata, new RegExp(`!${field}\\.isEmpty\\(\\)`));
    assert.match(metadata, new RegExp(`${field}\\.isEmpty\\(\\)`));
  }
  assert.match(metadata, /return noneProvided \|\| allProvided/);
  const admission = methodBody(d, 'private void requireHandlerAdmission()');
  assert.match(admission, /"VLC", handlerLabel/);
  assert.match(admission, /VLC_PACKAGE, handlerPackage/);
  assert.match(admission, /VLC_INTENT_ACTIVITY, handlerActivity/);
  assert.match(admission, /VLC_PLAYBACK_ACTIVITY, handlerPlaybackActivity/);
  assert.match(admission, /handlerActivityCount >= 2/);

  const resolver = methodBody(d, 'private void resolveExternalDestination()');
  assert.match(resolver, /long deadline = SystemClock\.uptimeMillis\(\) \+ SHORT_WAIT_MS/);
  assert.match(resolver, /while \(SystemClock\.uptimeMillis\(\) < deadline\)/);
  assert.match(resolver, /findTextOrDescription\("Open external player"\)/);
  assert.match(resolver, /realAndroidChooserObserved = true/);
  assert.match(resolver, /chooser == null \? null : findLabeledClickable\(handlerLabel\)/);
  assert.match(resolver, /long remaining = deadline - SystemClock\.uptimeMillis\(\)/);
  assert.match(resolver, /Math\.min\(2_000, remaining\)/);
  assert.doesNotMatch(resolver, /soleHandlerDirectLaunchObserved = true|accept-sole-handler-direct-launch/);
  const destination = methodBody(d, 'private static String chooseExternalDestinationAction(');
  assert.match(destination, /if \(chooserVisible && chooserHandlerVisible\) return "select-chooser-handler"/);
  assert.match(destination, /return "wait"/);

  const onboarding = methodBody(d, 'private void settleVlcFirstRunAndReachPlayer()');
  assert.match(onboarding, /long deadline = SystemClock\.uptimeMillis\(\) \+ MEDIA_WAIT_MS/);
  assert.match(onboarding, /while \(SystemClock\.uptimeMillis\(\) < deadline\)/);
  assert.match(onboarding, /!fullscreenTipDismissed/);
  assert.equal((onboarding.match(/fullscreenTip\.click\(\)/g) ?? []).length, 1);
  assert.match(onboarding, /denyExactOptionalVlcPermissionIfPresent\(\)/);
  assert.match(onboarding, /VLC_PACKAGE\.equals\(currentPackage\(\)\)/);
  assert.match(onboarding, /By\.res\(VLC_PACKAGE, "player_root"\)\.pkg\(VLC_PACKAGE\)/);
  assert.match(onboarding, /clickVlcOnboardingControl\(VLC_NO_FILE_ACCESS/);
  assert.match(onboarding, /clickVlcOnboardingControl\("Skip", "VLC optional notification Skip"\)/);
  assert.match(onboarding, /fail\("Timed out waiting for VLC's manifest-derived video player surface"\)/);

  const permission = methodBody(d, 'private boolean denyExactOptionalVlcPermissionIfPresent()');
  assert.match(permission, /com\.android\.permissioncontroller/);
  assert.match(permission, /Allow VLC to send you notifications\?/);
  assert.match(permission, /Allow VLC to access photos and videos on this device\?/);
  assert.match(permission, /permission_deny_button/);
  assert.match(permission, /assertEquals\("Expected one exact permission denial button", 1, denyButtons\.size\(\)\)/);
  assert.doesNotMatch(permission, /permission_allow|grantRuntimePermission/);

  const fullscreen = methodBody(d, 'private UiObject2 findExactFullscreenTipButton()');
  assert.match(fullscreen, /By\.res\(SYSTEM_UI_PACKAGE, "immersive_cling_title"\)/);
  assert.match(fullscreen, /By\.res\(SYSTEM_UI_PACKAGE, "immersive_cling_description"\)/);
  assert.match(fullscreen, /By\.res\(SYSTEM_UI_PACKAGE, "ok"\)/);
  assert.match(fullscreen, /\.clickable\(true\)\s*\.enabled\(true\)/);
  assert.match(fullscreen, /assertEquals\("Expected one exact fullscreen tip button", 1, buttons\.size\(\)\)/);
  assert.doesNotMatch(d, /evaluateJavascript|executeShellCommand|grantRuntimePermission|shared_prefs/);
}

test('workflow pins exact public phone59 APK identity', () => public59PinsContract(job));
test('workflow builds and serves exact released ac885 source', () => exactReleasedSourceContract(job));
test('fixture verifies every bounded compiled web asset as served', () => servedWebDistContract(fixture));
test('executes exact source-bound server-mode override admission', () => {
  const admission = exactServerModeAdmission();
  assert.equal(admission.route, serverModeRoute);
  assert.equal(admission.servedOverride.sha256, createHash('sha256').update(serverModeBody).digest('hex'));
  assert.equal(admission.source.path, 'server/src/app.ts');
});
test('rejects wrong server-mode override body', () => {
  const verify = executableFixtureHelper(
    'function verifyServerModeOverride(', 'admission, served, contentType, cacheControl',
    { SERVER_MODE_ROUTE: serverModeRoute, SERVER_MODE_BODY: serverModeBody },
  );
  assert.throws(() => verify(exactServerModeAdmission(), Buffer.from('wrong\n'),
    'text/javascript; charset=utf-8', 'no-store'));
  assert.throws(() => fixtureContract(fixture.replace(
    'const SERVER_MODE_BODY = "globalThis.__DEBRIDSTREAMER_SERVER_URL__ = globalThis.location.origin;\\n"',
    'const SERVER_MODE_BODY = "wrong\\n"')));
});
test('rejects wrong server-mode override route', () => {
  const verify = executableFixtureHelper(
    'function verifyServerModeOverride(', 'admission, served, contentType, cacheControl',
    { SERVER_MODE_ROUTE: serverModeRoute, SERVER_MODE_BODY: serverModeBody },
  );
  assert.throws(() => verify({ ...exactServerModeAdmission(), route: '/other.js' },
    Buffer.from(serverModeBody), 'text/javascript; charset=utf-8', 'no-store'));
  assert.throws(() => fixtureContract(fixture.replace(
    'const SERVER_MODE_ROUTE = "/server-mode.js"', 'const SERVER_MODE_ROUTE = "/other.js"')));
});
test('rejects corruption of an ordinary static asset', () => {
  const verify = executableFixtureHelper('function verifyStaticWebAsset(', 'entry, served');
  const body = Buffer.from('expected');
  const entry = { path: 'assets/app.js', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  assert.throws(() => verify(entry, Buffer.from('corrupt!')));
  assert.throws(() => fixtureContract(fixture.replace('servedSha256 !== entry.sha256', 'false')));
});
test('rejects static exclusion bypass and reordered inventory', () => {
  const verify = executableFixtureHelper(
    'function assertCompleteWebAccounting(', 'inventory, servedStatic, dynamicRoutes',
    { SERVER_MODE_ROUTE: serverModeRoute, EXPECTED_STATIC_WEB_DIST_FILES: 2 },
  );
  const dynamic = exactServerModeAdmission();
  const first = { path: 'assets/app.js', bytes: 1, sha256: '1'.repeat(64) };
  const last = { path: 'index.html', bytes: 1, sha256: '2'.repeat(64) };
  assert.doesNotThrow(() => verify([first, last, dynamic.distStub], [first, last], [dynamic]));
  assert.throws(() => verify([first, last, dynamic.distStub], [last], [dynamic]));
  assert.throws(() => verify([last, first, dynamic.distStub], [first, last], [dynamic]));
  assert.throws(() => fixtureContract(fixture.replace(
    'servedStatic.length + dynamicRoutes.length !== inventory.length', 'false')));
});
test('rejects server-mode source mismatch', () => {
  const admit = executableFixtureHelper(
    'function admittedServerModeOverride(', 'source, distStub',
    { SERVER_MODE_ROUTE: serverModeRoute, SERVER_MODE_BODY: serverModeBody,
      SERVER_MODE_CONTENT_TYPE: 'text/javascript; charset=utf-8',
      SERVER_MODE_CACHE_CONTROL: 'no-store', SERVER_MODE_SOURCE_BINDING: serverModeSourceBinding,
      SERVER_MODE_DIST_STUB_BYTES: 247, SERVER_MODE_DIST_STUB_SHA256: serverModeDistStubSha256 },
  );
  assert.throws(() => admit(serverModeSourceBinding.replace('no-store', 'public'), {
    path: 'server-mode.js', bytes: 247, sha256: serverModeDistStubSha256,
  }));
  assert.throws(() => fixtureContract(fixture.replace(
    'source.split(SERVER_MODE_SOURCE_BINDING).length !== 2', 'false')));
});
test('executes pure bounded settings rail transaction policy and rejects mutants', () => {
  assert.equal(settingsRailPolicyProbe(settingsTransaction).status, 0);
  for (const mutant of [
    mutateMethod(settingsTransaction, 'private static String chooseNextSettingsAction(',
      'railPanAttempts < 0', 'false'),
    mutateMethod(settingsTransaction, 'private static String chooseNextSettingsAction(',
      'railPanAttempts >= MAX_PLAYBACK_ACTIONS_RAIL_PANS',
      'railPanAttempts > MAX_PLAYBACK_ACTIONS_RAIL_PANS'),
    mutateMethod(settingsTransaction, 'private static String chooseNextSettingsAction(',
      'revealVisible && !revealTapPerformed', 'revealVisible'),
  ]) {
    assert.notEqual(mutant, settingsTransaction);
    assert.notEqual(settingsRailPolicyProbe(mutant).status, 0);
  }
});
test('clicks directly observed exact settings without manufacturing a rail pan', () => {
  assert.equal(settingsRailPolicyProbe(settingsTransaction).status, 0);
  const policy = methodBody(
    settingsTransaction, 'private static String chooseNextSettingsAction(');
  assert.doesNotMatch(policy, /if \(settingsVisible\) \{\s*if \(railPanAttempts <= 0\)/);
  assert.match(settingsTransaction,
    /railPanAttempts == 0 && railObservationCount != 0/);
  assert.match(settingsTransaction,
    /railPanAttempts > 0 && railObservationCount < railPanAttempts/);
  const forcedPanPrerequisite = mutateMethod(
    settingsTransaction,
    'private static String chooseNextSettingsAction(',
    'if (settingsVisible) {',
    'if (settingsVisible) {\n            if (railPanAttempts <= 0) {\n                throw new AssertionError("forced rail pan prerequisite");\n            }',
  );
  assert.notEqual(forcedPanPrerequisite, settingsTransaction);
  assert.notEqual(settingsRailPolicyProbe(forcedPanPrerequisite).status, 0);
});
test('driver admits only the exact visible player action rail and no coordinate fallback', () => {
  const observation = methodBody(
    driver, 'private RuntimeExternalSettingsTransaction.Observation observePlaybackSettingsTransaction()');
  assert.match(observation, /findUniquePlaybackActionsRailWithin\(playerDialog\)/);
  assert.match(observation, /Observation\.railPan\(\s*\(\) -> rail\.scroll\(Direction\.RIGHT, 0\.72f\)\)/);
  assert.doesNotMatch(observation, /device\.swipe|device\.click/);
  const rail = methodBody(driver, 'private UiObject2 findUniquePlaybackActionsRailWithin(');
  assert.match(rail, /dialog\.findObjects\(/);
  assert.match(rail, /By\.clazz\("android\.view\.View"\)/);
  assert.match(rail, /\.pkg\(PRODUCT_PACKAGE\)/);
  assert.match(rail, /\.text\(exactLabel\(PLAYBACK_ACTIONS_LABEL\)\)/);
  assert.match(rail, /\.scrollable\(true\)/);
  assert.match(rail, /hasVisibleBounds\(candidate\)/);
  assert.match(rail, /bounds\.width\(\) <= bounds\.height\(\)/);
  assert.match(rail, /candidates\.size\(\) > 1/);
});
test('transaction freshly guards every input and records bounded rail observations', () => {
  const transaction = methodBody(
    settingsTransaction, 'static Result open(Environment environment, long timeoutMs)');
  assert.match(settingsTransaction, /MAX_PLAYBACK_ACTIONS_RAIL_PANS = 3/);
  assert.match(transaction, /"fresh-input-legal-guard"/);
  assert.equal((transaction.match(/runFreshLegalGuard\(/g) ?? []).length, 4);
  assert.equal((transaction.match(/observation\.settingsTarget\.click\(\)/g) ?? []).length, 1);
  assert.equal((transaction.match(/observation\.revealTarget\.click\(\)/g) ?? []).length, 1);
  assert.equal((transaction.match(/observation\.railPanTarget\.click\(\)/g) ?? []).length, 1);
  assert.match(transaction, /environment\.recordRailObservation\(/);
  assert.match(transaction, /if \(observation\.railPanTarget != null\) railObservationCount\+\+/);
  assert.match(transaction, /railPanAttempts\+\+/);
  assert.match(transaction, /return new Result\(/);
  assert.match(driver, /MAX_SETTINGS_RAIL_OBSERVATIONS = 16/);
  assert.match(driver, /settingsRailObservationEventsOmitted/);
  assert.match(driver, /receipt\.put\("settingsRailObservations", new JSONArray\(settingsRailObservations\)\)/);
  assert.match(driver, /checks\.put\("playbackActionsRailPanAttempts", result\.railPanAttempts\)/);
});
test('workflow pins and admits only the exact official VLC fixture handler', () => workflowContract(workflow, job));
test('external workflow contract is bounded before the following distinct job', () => {
  assert.doesNotMatch(job, /^  touch-player-fixture:/m);
  assert.match(job, /# BEGIN EXTERNAL_VLC_HANDLER_POLICY/);
  assert.notEqual(
    job,
    job.replace('VLC_SHA256: 4646633e', 'VLC_SHA256: a646633e'),
    'external-job mutation must remain observable within the bounded section',
  );
  assert.throws(() => workflowContract(
    workflow,
    job.replace('VLC_SHA256: 4646633e', 'VLC_SHA256: a646633e'),
  ));
});
test('executes the VLC minimum SDK admission against aapt2 badging', () => {
  const line = job.split('\n').find(value => value.includes('minSdkVersion:'))?.trim();
  assert.ok(line, 'Missing exact minimum SDK admission');
  const directory = mkdtempSync(join(tmpdir(), 'yawf-vlc-badging-'));
  const path = join(directory, 'vlc-badging.txt');
  function admit(contents, command = line) {
    writeFileSync(path, contents);
    return spawnSync('bash', ['-c', command], {
      encoding: 'utf8', env: { ...process.env, EVIDENCE: directory },
    }).status;
  }
  const actualFormat = "package: name='org.videolan.vlc' versionCode='13070108' versionName='3.7.1'\nminSdkVersion:'17'\ntargetSdkVersion:'36'\nnative-code: 'x86_64'\n";
  assert.equal(admit(actualFormat), 0);
  for (const invalid of [
    actualFormat.replace("minSdkVersion:'17'", "minSdkVersion:'18'"),
    actualFormat.replace("minSdkVersion:'17'\n", ''),
    actualFormat.replace("minSdkVersion:'17'", "prefix-minSdkVersion:'17'"),
    actualFormat.replace("minSdkVersion:'17'", "minSdkVersion:'17' trailing"),
    actualFormat.replace("minSdkVersion:'17'", "sdkVersion:'17'"),
  ]) assert.notEqual(admit(invalid), 0);
  assert.notEqual(admit(actualFormat, line.replace('minSdkVersion:', 'sdkVersion:')), 0);
});
test('fixture emits bounded token-free media and HTTP diagnostics', () => fixtureContract(fixture));
test('driver preserves the strict product, chooser, VLC, seek, and Back flow', () => driverContract(driver));

for (const [name, original, mutate, contract] of [
  ['product APK hash', job, s => s.replace('PRODUCT_SHA256: 5fe550', 'PRODUCT_SHA256: afe550'), s => workflowContract(workflow, s)],
  ['product source', job, s => s.replace('PRODUCT_SOURCE: ac885b', 'PRODUCT_SOURCE: bc885b'), s => workflowContract(workflow, s)],
  ['hosted UI source', job, s => s.replace('HOSTED_UI_SOURCE: ac885b', 'HOSTED_UI_SOURCE: bc885b'), s => workflowContract(workflow, s)],
  ['server runtime source', job, s => s.replace('SERVER_RUNTIME_SOURCE: ac885b', 'SERVER_RUNTIME_SOURCE: bc885b'), s => workflowContract(workflow, s)],
  ['product version', job, s => s.replace('PRODUCT_VERSION: 2.3.59', 'PRODUCT_VERSION: 2.3.58'), s => workflowContract(workflow, s)],
  ['product version code', job, s => s.replace('PRODUCT_VERSION_CODE: "2003059"', 'PRODUCT_VERSION_CODE: "2003058"'), s => workflowContract(workflow, s)],
  ['product signer', job, s => s.replace('PRODUCT_SIGNER_SHA256: 233ff9', 'PRODUCT_SIGNER_SHA256: a33ff9'), s => workflowContract(workflow, s)],
  ['product release tag', job, s => s.replace('PRODUCT_RELEASE_TAG: android-v2.3.59', 'PRODUCT_RELEASE_TAG: android-v2.3.58'), s => workflowContract(workflow, s)],
  ['product APK size', job, s => s.replace('PRODUCT_SIZE: "88644481"', 'PRODUCT_SIZE: "1"'), s => workflowContract(workflow, s)],
  ['wrong hosted UI build root', job, s => s.replace('(cd public-phone-source/web && npm ci && npm run build)', '(cd web && npm ci && npm run build)'), s => workflowContract(workflow, s)],
  ['wrong server dependency root', job, s => s.replace('(cd public-phone-source/server && npm ci)', '(cd server && npm ci)'), s => workflowContract(workflow, s)],
  ['wrong fixture module loader', job, s => s.replace('public-phone-source/server/node_modules/tsx/dist/cli.mjs', 'server/node_modules/tsx/dist/cli.mjs'), s => workflowContract(workflow, s)],
  ['wrong fixture served source', job, s => s.replace('--repo "$GITHUB_WORKSPACE/public-phone-source"', '--repo "$GITHUB_WORKSPACE"'), s => workflowContract(workflow, s)],
  ['VLC APK hash', job, s => s.replace('VLC_SHA256: 4646633e', 'VLC_SHA256: a646633e'), s => workflowContract(workflow, s)],
  ['VLC signer', job, s => s.replace('VLC_SIGNER_SHA256: c8768d2c', 'VLC_SIGNER_SHA256: a8768d2c'), s => workflowContract(workflow, s)],
  ['VLC size', job, s => s.replace('VLC_SIZE: "49444910"', 'VLC_SIZE: "1"'), s => workflowContract(workflow, s)],
  ['VLC host', job, s => s.replace('https://download.videolan.org/pub/videolan/', 'https://example.invalid/'), s => workflowContract(workflow, s)],
  ['VLC checksum admission', job, s => s.replace('test "$(cat "$VLC_APK.sha256")" = "$VLC_SHA256 *$VLC_APK"', ':'), s => workflowContract(workflow, s)],
  ['VLC package', job, s => s.replace('VLC_PACKAGE: org.videolan.vlc', 'VLC_PACKAGE: com.example.vlc'), s => workflowContract(workflow, s)],
  ['VLC intent activity', job, s => s.replace('VLC_INTENT_ACTIVITY: org.videolan.vlc.StartActivity', 'VLC_INTENT_ACTIVITY: org.videolan.vlc.OtherActivity'), s => workflowContract(workflow, s)],
  ['VLC playback activity', job, s => s.replace('VLC_PLAYBACK_ACTIVITY: org.videolan.vlc.gui.video.VideoPlayerActivity', 'VLC_PLAYBACK_ACTIVITY: org.videolan.vlc.StartActivity'), s => workflowContract(workflow, s)],
  ['extra third-party install', job, s => `${s}\n          adb -s "$EMULATOR_SERIAL" install third-party.apk\n`, s => workflowContract(workflow, s)],
  ['runtime permission grant', job, s => `${s}\n          adb shell pm grant org.videolan.vlc android.permission.READ_MEDIA_VIDEO\n`, s => workflowContract(workflow, s)],
  ['preferred intent', job, s => `${s}\n          adb shell cmd package add-preferred-activity org.videolan.vlc\n`, s => workflowContract(workflow, s)],
  ['disabled stock handler', job, s => `${s}\n          adb shell pm disable com.google.android.apps.photos\n`, s => workflowContract(workflow, s)],
  ['false chooser receipt', job, s => s.replace('assert destination == (True,False)', 'assert destination != (False,False)'), s => workflowContract(workflow, s)],
  ['lost completed response oracle', job, s => s.replace("event['lifecycle']['finishObserved'] is True", 'True'), s => workflowContract(workflow, s)],
  ['lost early-close oracle', job, s => s.replace("event['lifecycle']['prematureCloseObserved'] is False", 'True'), s => workflowContract(workflow, s)],
  ['lost exact playback activity oracle', job, s => s.replace("assert activity['manifestPlaybackActivityObserved'] is True", 'assert True'), s => workflowContract(workflow, s)],
  ['unbounded logcat lines', job, s => s.replace('if index>=12000: break', 'if False: break'), s => workflowContract(workflow, s)],
  ['wrong VLC driver package', driver, s => s.replace('VLC_PACKAGE = "org.videolan.vlc"', 'VLC_PACKAGE = "com.example.vlc"'), driverContract],
  ['wrong fullscreen overlay title', driver, s => s.replace('FULLSCREEN_TIP_TITLE = "Viewing full screen"', 'FULLSCREEN_TIP_TITLE = "Full screen"'), driverContract],
  ['direct launch bypass', driver, s => s.replace('return "wait";', 'return "accept-sole-handler-direct-launch";'), driverContract],
  ['unbounded chooser resolver', driver, s => s.replace('while (SystemClock.uptimeMillis() < deadline)', 'while (true)'), driverContract],
  ['partial playback metadata', driver, s => s.replace('                && !playbackActivity.isEmpty()\n', ''), driverContract],
  ['multiple handler count weakened', driver, s => s.replace('handlerActivityCount >= 2', 'handlerActivityCount >= 1'), driverContract],
  ['settings transaction callsite bypass', driver, s => s.replace(
    'openPlaybackSettingsTransaction();',
    'waitForLabeledClickable(PLAYBACK_SETTINGS_LABEL, MEDIA_WAIT_MS, PLAYBACK_SETTINGS_LABEL).click();'), driverContract],
  ['settings refresh API guard', settingsTransaction, s => s.replace(
    'Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE',
    'false'), h => driverContract(driver, h)],
  ['ignored accessibility cache result', settingsTransaction, s => s.replace(
    'if (!cacheCleared)',
    'if (false)'), h => driverContract(driver, h)],
  ['external legal window-root prefetch', externalLegalSnapshot, s => s.replace(
    'window.getRoot(PREFETCHING_STRATEGY)',
    'window.getRoot()'), h => driverContract(driver, settingsTransaction, h)],
  ['external legal child prefetch', externalLegalSnapshot, s => s.replace(
    'node.getChild(childIndex, PREFETCHING_STRATEGY)',
    'node.getChild(childIndex)'), h => driverContract(driver, settingsTransaction, h)],
  ['settings cache refresh ordering', settingsTransaction, s => s.replace(
    '                long cacheStartedAtMs = SystemClock.uptimeMillis();',
    '                environment.assertNoOutOfScopeApproval();\n                long cacheStartedAtMs = SystemClock.uptimeMillis();'), h => driverContract(driver, h)],
  ['settings refresh exact label', driver, s => s.replace('PLAYBACK_SETTINGS_LABEL = "Playback settings"', 'PLAYBACK_SETTINGS_LABEL = "Settings"'), driverContract],
  ['settings observation input replay', driver, s => s.replace('UiObject2 settings = findLabeledClickableWithin(', 'device.click(500, 500);\n        UiObject2 settings = findLabeledClickableWithin('), driverContract],
  ['settings deadline relaxation', driver, s => s.replace('MEDIA_WAIT_MS = 60_000', 'MEDIA_WAIT_MS = 600_000'), driverContract],
  ['capture inserted after settings transaction', driver, s => s.replace(
    'openPlaybackSettingsTransaction();\n        waitForUniquePlaybackSettingsDialog();',
    'openPlaybackSettingsTransaction();\n        capture("post-settings-transaction");\n        waitForUniquePlaybackSettingsDialog();'), driverContract],
  ['player capture moved after settings acquisition', driver, s => s.replace(
    'capture("production-player");\n        openPlaybackSettingsTransaction();',
    'openPlaybackSettingsTransaction();\n        capture("production-player");'), driverContract],
  ['player dialog readiness made fail-fast', driver, s => s.replace(
    'UiObject2 playerDialog = findUniqueExactProductDialog(PLAYER_DIALOG_LABEL);',
    'UiObject2 playerDialog = requireUniqueExactProductDialog(PLAYER_DIALOG_LABEL, "playing movie dialog");'), driverContract],
  ['invisible player dialog admitted', driver, s => s.replace('playerDialog == null || !hasVisibleBounds(playerDialog)', 'false'), driverContract],
  ['repeated reveal tap', settingsTransaction, s => s.replace(
    'revealVisible && !revealTapPerformed',
    'revealVisible'), h => driverContract(driver, h)],
  ['unscoped playing dialog', driver, s => s.replace(
    '.pkg(PRODUCT_PACKAGE)\n                        .text(exactLabel(label))',
    '.text(exactLabel(label))'), driverContract],
  ['settings dialog admission removed', driver, s => s.replace(
    'waitForUniquePlaybackSettingsDialog();',
    'waitForTextOrDescription(PLAYBACK_SETTINGS_LABEL, SHORT_WAIT_MS, PLAYBACK_SETTINGS_LABEL);'), driverContract],
  ['settings panel capture moved after scroll', driver, s => s.replace(
    'capture("playback-settings-panel");\n        UiObject2 external = scrollPlaybackSettingsUntilLabeledClickable(',
    'UiObject2 external = scrollPlaybackSettingsUntilLabeledClickable(\n                EXTERNAL_PLAYER_LABEL, EXTERNAL_PLAYER_LABEL);\n        capture("playback-settings-panel");\n        UiObject2 ignoredExternal = scrollPlaybackSettingsUntilLabeledClickable('), driverContract],
  ['settings scroll escapes dialog', driver, s => s.replace(
    'dialog.findObjects(\n                By.scrollable(true).pkg(PRODUCT_PACKAGE))',
    'device.findObjects(\n                By.scrollable(true).pkg(PRODUCT_PACKAGE))'), driverContract],
  ['generic external-control fallback', driver, s => s.replace(
    'scrollPlaybackSettingsUntilLabeledClickable(\n                EXTERNAL_PLAYER_LABEL, EXTERNAL_PLAYER_LABEL)',
    'scrollUntilLabeledClickable(\n                EXTERNAL_PLAYER_LABEL, EXTERNAL_PLAYER_LABEL)'), driverContract],
  ['settings visible-bounds admission removed', driver, s => s.replace('found != null && hasVisibleBounds(found)', 'found != null'), driverContract],
  ['external action label shortened', driver, s => s.replace('Open in external player Choose VLC or another installed video app', 'Open in external player'), driverContract],
  ['dialog-scoped label made inexact', driver, s => mutateMethod(
    s,
    'private UiObject2 findLabeledClickableWithin(',
    'Pattern labelPattern = exactLabel(label);',
    'Pattern labelPattern = Pattern.compile(label);'), driverContract],
  ['disabled fullscreen button admitted', driver, s => s.replace(
    'By.res(SYSTEM_UI_PACKAGE, "ok")\n                        .pkg(SYSTEM_UI_PACKAGE)\n                        .text(exactLabel(FULLSCREEN_TIP_BUTTON))\n                        .clazz("android.widget.Button")\n                        .clickable(true)\n                        .enabled(true))',
    'By.res(SYSTEM_UI_PACKAGE, "ok")\n                        .pkg(SYSTEM_UI_PACKAGE)\n                        .text(exactLabel(FULLSCREEN_TIP_BUTTON))\n                        .clazz("android.widget.Button")\n                        .clickable(true))'), driverContract],
  ['repeated fullscreen tip allowed', driver, s => s.replace('!fullscreenTipDismissed);', 'true);'), driverContract],
  ['permission grant selector', driver, s => s.replace('permission_deny_button', 'permission_allow_button'), driverContract],
  ['storage access granted', driver, s => s.replace('VLC_NO_FILE_ACCESS = "No file access"', 'VLC_NO_FILE_ACCESS = "Allow access"'), driverContract],
  ['semantic seek removed', driver, s => s.replace('By.clazz("android.widget.SeekBar").pkg(handlerPackage)', 'By.clazz("android.view.View").pkg(handlerPackage)'), driverContract],
  ['fake decode claim', driver, s => s.replace('receipt.put("decodedPlaybackClaimed", false)', 'receipt.put("decodedPlaybackClaimed", true)'), driverContract],
  ['unbounded receipt', fixture, s => s.replace('EXTERNAL_RECEIPT_LIMIT = 128', 'EXTERNAL_RECEIPT_LIMIT = 99999'), fixtureContract],
  ['raw method type', fixture, s => s.replace('const method: "GET" | "HEAD" = methodValue', 'const method = methodValue'), fixtureContract],
  ['missing ffprobe', fixture, s => s.replace('spawnSync("ffprobe"', 'spawnSync("true"'), fixtureContract],
  ['missing exact MP4 content type', fixture, s => s.replace('externalFull.headers["content-type"] !== "video/mp4"', 'false'), fixtureContract],
  ['served source byte mismatch admitted', fixture, s => s.replace('servedSha256 !== entry.sha256', 'false'), fixtureContract],
  ['descending byte range admitted', fixture, s => s.replace('    (start != null && end != null && end < start)', '    false'), fixtureContract],
]) {
  test(`independently rejects ${name} mutant`, () => {
    contract(original);
    const changed = mutate(original);
    assert.notEqual(changed, original);
    assert.throws(() => contract(changed));
  });
}

function requestRangePolicyProbe(source) {
  const boundedBody = methodBody(source, 'function boundedHeaderInteger(');
  const rangeBody = methodBody(source, 'function requestRangeClass(');
  const directory = mkdtempSync(join(tmpdir(), 'yawf-external-range-'));
  const probe = `
function boundedHeaderInteger(value) {${boundedBody}}
function requestRangeClass(value) {${rangeBody}}
const cases = [
  [undefined, {present:false}],
  ["bytes=10-", {present:true,valid:true,start:10,end:null}],
  ["bytes=-500", {present:true,valid:true,start:null,end:500}],
  ["bytes=10-20", {present:true,valid:true,start:10,end:20}],
  ["bytes=10-1", {present:true,valid:false}],
  ["bytes=9007199254740992-", {present:true,valid:false}],
  ["bytes=0-1,2-3", {present:true,valid:false}],
  ["bytes=garbage", {present:true,valid:false}],
];
for (const [input, expected] of cases) {
  const actual=requestRangeClass(input);
  if (JSON.stringify(actual)!==JSON.stringify(expected)) {
    throw new Error(String(input)+": "+JSON.stringify(actual)+" != "+JSON.stringify(expected));
  }
}
`;
  const file = join(directory, 'request-range-probe.mjs');
  writeFileSync(file, probe);
  return spawnSync(process.execPath, [file], { encoding: 'utf8' });
}

test('executes the actual bounded Range classifier and rejects descending ranges', () => {
  const baseline = requestRangePolicyProbe(fixture);
  assert.equal(baseline.status, 0, baseline.stderr);
  const mutant = fixture.replace(
    '    (start != null && end != null && end < start)',
    '    false');
  assert.notEqual(mutant, fixture);
  assert.notEqual(requestRangePolicyProbe(mutant).status, 0);
});

function handlerPolicy(code, stockDump, admittedDump) {
  const evidence = mkdtempSync(join(tmpdir(), 'yawf-vlc-handler-'));
  writeFileSync(join(evidence, 'stock-video-handlers.txt'), stockDump);
  writeFileSync(join(evidence, 'video-handlers-with-vlc.txt'), admittedDump);
  const execution = spawnSync('python3', ['-c', code], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    env: {
      ...process.env,
      EVIDENCE: evidence,
      VLC_PACKAGE: 'org.videolan.vlc',
      VLC_INTENT_ACTIVITY: 'org.videolan.vlc.StartActivity',
      VLC_PLAYBACK_ACTIVITY: 'org.videolan.vlc.gui.video.VideoPlayerActivity',
    },
  });
  const receipt = execution.status === 0
    ? JSON.parse(readFileSync(join(evidence, 'vlc-handler-query-admission.json'), 'utf8'))
    : null;
  return { execution, receipt };
}

const details = '    priority=0 preferredOrder=0 match=0x608000 specificIndex=-1 isDefault=true\n';
const photos = '    com.google.android.apps.photos/.pager.HostPhotoPagerActivity\n';
const vlc = '    org.videolan.vlc/.StartActivity\n';
const onePhotos = `1 activities found:\n  Activity #0:\n${details}${photos}`;
const photosPlusVlc = `2 activities found:\n  Activity #0:\n${details}${photos}  Activity #1:\n${details}${vlc}`;

test('executes strict stock Photos plus exact VLC activity admission', () => {
  const code = marker(job, '# BEGIN EXTERNAL_VLC_HANDLER_POLICY', '# END EXTERNAL_VLC_HANDLER_POLICY');
  const valid = handlerPolicy(code, onePhotos, photosPlusVlc);
  assert.equal(valid.execution.status, 0, valid.execution.stderr);
  assert.equal(valid.receipt.activityCount, 2);
  assert.equal(valid.receipt.realChooserRequired, true);
  assert.equal(valid.receipt.targetPackage, 'org.videolan.vlc');
  assert.equal(valid.receipt.manifestDeclaredPlaybackActivity, 'org.videolan.vlc.gui.video.VideoPlayerActivity');

  const bad = [
    ['wrong stock', onePhotos.replace('com.google.android.apps.photos', 'com.example.photos'), photosPlusVlc],
    ['missing VLC', onePhotos, onePhotos],
    ['extra handler', onePhotos, photosPlusVlc.replace('2 activities found:', '3 activities found:') + `  Activity #2:\n${details}    com.example.video/.PlayerActivity\n`],
    ['count mismatch', onePhotos, photosPlusVlc.replace('2 activities found:', '3 activities found:')],
    ['malformed component', onePhotos, photosPlusVlc.replace('org.videolan.vlc/.StartActivity', 'org.videolan.vlc/.Bad-Activity')],
    ['duplicate component', onePhotos, photosPlusVlc.replace(vlc, photos)],
    ['unknown detail row', onePhotos, photosPlusVlc.replace('priority=0', 'unexpected=1')],
    ['truncated record', onePhotos, '2 activities found:\n  Activity #0:\n' + details + photos + '  Activity #1:\n'],
  ];
  for (const [name, stock, admitted] of bad) {
    const result = handlerPolicy(code, stock, admitted);
    assert.notEqual(result.execution.status, 0, `${name} was admitted`);
  }
});

function destinationReceiptPolicy(code, checks) {
  return spawnSync('python3', ['-c', `import json,os\nchecks=json.loads(os.environ['CHECKS'])\n${code}`], {
    encoding: 'utf8', env: { ...process.env, CHECKS: JSON.stringify(checks) },
  });
}

test('executes exact boolean chooser-only receipt validation', () => {
  const code = marker(job, '# BEGIN EXTERNAL_DESTINATION_RECEIPT_POLICY', '# END EXTERNAL_DESTINATION_RECEIPT_POLICY');
  assert.equal(destinationReceiptPolicy(code, {
    realAndroidChooserObserved: true, soleHandlerDirectLaunchObserved: false,
  }).status, 0);
  for (const checks of [
    { realAndroidChooserObserved: false, soleHandlerDirectLaunchObserved: true },
    { realAndroidChooserObserved: false, soleHandlerDirectLaunchObserved: false },
    { realAndroidChooserObserved: true, soleHandlerDirectLaunchObserved: true },
    { realAndroidChooserObserved: 'true', soleHandlerDirectLaunchObserved: false },
    { realAndroidChooserObserved: true, soleHandlerDirectLaunchObserved: 'false' },
  ]) {
    assert.notEqual(destinationReceiptPolicy(code, checks).status, 0);
  }
});

function resolverPolicyProbe(source) {
  const body = methodBody(source, 'private static String chooseExternalDestinationAction(');
  const metadataBody = methodBody(source, 'private static boolean hasCompleteHandlerMetadata(');
  const directory = mkdtempSync(join(tmpdir(), 'yawf-vlc-resolver-'));
  const javaSource = `public final class ResolverPolicyProbe {
    private static String chooseExternalDestinationAction(boolean chooserVisible, boolean chooserHandlerVisible) {${body}}
    private static boolean hasCompleteHandlerMetadata(
        String label, String packageName, String activity, String playbackActivity, String activityCount) {${metadataBody}}
    private static void expect(String expected, String actual) {
      if (!expected.equals(actual)) throw new AssertionError(expected + " != " + actual);
    }
    public static void main(String[] args) {
      expect("wait", chooseExternalDestinationAction(false, false));
      expect("wait", chooseExternalDestinationAction(true, false));
      expect("wait", chooseExternalDestinationAction(false, true));
      expect("select-chooser-handler", chooseExternalDestinationAction(true, true));
      if (!hasCompleteHandlerMetadata("", "", "", "", "")) throw new AssertionError("empty metadata rejected");
      if (!hasCompleteHandlerMetadata("VLC", "org.videolan.vlc", "org.videolan.vlc.StartActivity", "org.videolan.vlc.gui.video.VideoPlayerActivity", "2")) throw new AssertionError("complete metadata rejected");
      if (hasCompleteHandlerMetadata("", "org.videolan.vlc", "org.videolan.vlc.StartActivity", "org.videolan.vlc.gui.video.VideoPlayerActivity", "2")) throw new AssertionError("missing label admitted");
      if (hasCompleteHandlerMetadata("VLC", "", "org.videolan.vlc.StartActivity", "org.videolan.vlc.gui.video.VideoPlayerActivity", "2")) throw new AssertionError("missing package admitted");
      if (hasCompleteHandlerMetadata("VLC", "org.videolan.vlc", "", "org.videolan.vlc.gui.video.VideoPlayerActivity", "2")) throw new AssertionError("missing intent activity admitted");
      if (hasCompleteHandlerMetadata("VLC", "org.videolan.vlc", "org.videolan.vlc.StartActivity", "", "2")) throw new AssertionError("missing playback activity admitted");
      if (hasCompleteHandlerMetadata("VLC", "org.videolan.vlc", "org.videolan.vlc.StartActivity", "org.videolan.vlc.gui.video.VideoPlayerActivity", "")) throw new AssertionError("missing count admitted");
    }
  }`;
  const file = join(directory, 'ResolverPolicyProbe.java');
  writeFileSync(file, javaSource);
  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome ? join(javaHome, 'bin', 'javac') : 'javac';
  const java = javaHome ? join(javaHome, 'bin', 'java') : 'java';
  const compile = spawnSync(javac, ['-d', directory, file], { encoding: 'utf8' });
  if (compile.status !== 0) return compile;
  return spawnSync(java, ['-cp', directory, 'ResolverPolicyProbe'], { encoding: 'utf8' });
}

test('executes chooser state and complete metadata policy against mutants', () => {
  assert.equal(resolverPolicyProbe(driver).status, 0);
  for (const mutant of [
    driver.replace('if (chooserVisible && chooserHandlerVisible)', 'if (chooserHandlerVisible)'),
    driver.replace('return "wait";', 'return "select-chooser-handler";'),
    driver.replace('                && !playbackActivity.isEmpty()\n', ''),
    driver.replace('                && !activityCount.isEmpty();', ';'),
  ]) {
    assert.notEqual(mutant, driver);
    assert.notEqual(resolverPolicyProbe(mutant).status, 0);
  }
});

function enginePolicy(code, providerDump) {
  const evidence = mkdtempSync(join(tmpdir(), 'yawf-external-engine-'));
  writeFileSync(join(evidence, 'stock-webview.txt'), providerDump);
  return spawnSync('python3', ['-c', code], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
    env: { ...process.env, EVIDENCE: evidence },
  });
}

test('executes the actual minimum-engine admission before native UI', () => {
  const code = marker(job, '# BEGIN EXTERNAL_STOCK_WEBVIEW_POLICY', '# END EXTERNAL_STOCK_WEBVIEW_POLICY');
  const dump = version => `Current WebView package (name, version): (com.google.android.webview, ${version})`;
  assert.equal(enginePolicy(code, dump('133.0.6943.49')).status, 0);
  assert.notEqual(enginePolicy(code, dump('83.0.4103.106')).status, 0);
  assert.notEqual(enginePolicy(code, dump('133.0.6943.49').replace('com.google.android.webview', 'unexpected.webview')).status, 0);
  assert.notEqual(enginePolicy(code, 'provider unavailable').status, 0);
});
