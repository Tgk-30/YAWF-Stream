import assert from "node:assert/strict";
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
import {runInNewContext} from "node:vm";
import test from "node:test";
const patcher = await import(process.env.ANDROID_COLD_PATCH_MODULE ? pathToFileURL(process.env.ANDROID_COLD_PATCH_MODULE).href : new URL("./patch_tauri_android.mjs",import.meta.url).href);
const pkg="com.tgk30.debridstreamer";
const activity=patcher.patchedMainActivityForWebViewCompatibilityTest(pkg);
const previous=(patcher.previousColdRecoveryMainActivityForTest||patcher.patchedMainActivityForWebViewCompatibilityTest)(pkg);
const hash=value=>createHash("sha256").update(value).digest("hex");
function method(code,name){
  const start=code.indexOf("  private fun "+name+"(");assert.ok(start>=0,name);
  const next=code.indexOf("\n  private fun ",start+1);
  return code.slice(start,next<0?code.length:next);
}
function fixture(){
  const root=mkdtempSync(join(tmpdir(),"yawf-cold-recovery-"));
  const app=join(root,"web/src-tauri/gen/android/app"),java=join(app,"src/main/java",...pkg.split("."));
  mkdirSync(java,{recursive:true});
  writeFileSync(join(app,"build.gradle.kts"),`android {
    compileSdk = 36
    namespace = "${pkg}"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "true"
        applicationId = "${pkg}"
        minSdk = 24
        targetSdk = 36
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
        }
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
}
`);
  writeFileSync(join(app,"src/main/AndroidManifest.xml"),`<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application android:usesCleartextTraffic="\${usesCleartextTraffic}">
        <activity android:name=".MainActivity" android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode" android:exported="true">
        </activity>
    </application>
</manifest>
`);
  const main=join(java,"MainActivity.kt");writeFileSync(main,previous);
  return {root,app,main};
}

test("migrates the exact current98 Activity and stays idempotent without accepting drift",()=>{
  assert.equal(hash(previous),"b2a8e18e7135aeb3974546e719613517e67a93dfb5de25a2bb63bc2cb381d86c");
  const f=fixture();
  try{
    assert.equal(patcher.patchTauriAndroidProject({root:f.root}).activityChanged,true);
    assert.equal(readFileSync(f.main,"utf8"),activity);
    assert.equal(patcher.patchTauriAndroidProject({root:f.root}).changed,false);
    writeFileSync(f.main,activity.replace("Server navigation","Unreviewed change"));
    const paths=[f.main,join(f.app,"build.gradle.kts"),join(f.app,"src/main/AndroidManifest.xml")];
    const before=paths.map(path=>readFileSync(path,"utf8"));
    assert.throws(()=>patcher.patchTauriAndroidProject({root:f.root}),/does not match/);
    assert.deepEqual(paths.map(path=>readFileSync(path,"utf8")),before);
  }finally{rmSync(f.root,{recursive:true,force:true});}
});

test("registers lowest-priority root recovery before Rust and retains keyboard fullscreen history first",()=>{
  const registration=activity.indexOf("onBackPressedDispatcher.addCallback(this, remoteRecoveryBack)");
  assert.ok(registration>=0&&registration<activity.indexOf("super.onCreate(savedInstanceState)"));
  const callback=activity.slice(activity.indexOf("private val remoteRecoveryBack"),activity.indexOf("  private var imeController"));
  assert.ok(callback.includes("WindowInsetsControllerCompat(window, view).hide(WindowInsetsCompat.Type.ime())"));
  assert.ok(callback.indexOf("if (imeVisible)")<callback.indexOf("if (view.canGoBack())"));
  assert.ok(callback.indexOf("view.goBack()")<callback.indexOf("showRemoteRecoveryDialog(view, page)"));
  assert.ok(callback.includes("view.visibility != View.VISIBLE"));
  const pass=method(activity,"passRemoteRecoveryBack");
  assert.ok(pass.includes("remoteRecoveryBack.isEnabled = false"));
  assert.ok(pass.includes("onBackPressedDispatcher.onBackPressed()"));
  assert.ok(pass.includes("finally"));
  assert.equal(activity.split("fullscreenController = YawfFullscreenController(this, webView)").length-1,1);
});

test("revalidates owned remote root for both actions and fixes Local Mode to bundled origin only",()=>{
  const owned=method(activity,"remoteRecoveryCanAct");
  for(const value of ["isFinishing || isDestroyed","safeAreaWebView !== view","view.url != page || view.canGoBack()","currentTopOrigin(view) ?: return false",'ServerPlayerOrigin("http", "tauri.localhost", 80)'])assert.ok(owned.includes(value),value);
  const dialog=method(activity,"showRemoteRecoveryDialog");
  for(const value of ['setPositiveButton("Retry server")','setNeutralButton("Use Local Mode")','setNegativeButton("Cancel", null)','view.reload()','view.loadUrl("http://tauri.localhost/#yawf-local-mode")'])assert.ok(dialog.includes(value),value);
  assert.equal((dialog.match(/remoteRecoveryCanAct\(view, page\)/g)||[]).length,3);
  assert.equal((dialog.match(/view\.loadUrl\(/g)||[]).length,1);
  assert.doesNotMatch(dialog,/loadUrl\(page|setMessage\(page|Uri\.parse|Intent\(|clearHistory|removeAllCookies|removeSessionCookies/);
  assert.ok(activity.includes("dialog.setOnDismissListener"));
  assert.ok(activity.includes("remoteRecoveryBack.remove()"));
  assert.equal((activity.match(/    dismissRemoteRecoveryDialog\(\)/g)||[]).length,3);
});

test("preserves all existing server-player security updater client and permissions code",()=>{
  for(const name of ["attachServerPlayerBridge","handleServerPlayerMessage","showServerPlayerConfirmation","beginServerPlayerChallenge","completeServerPlayerChallenge","ownsServerPlayerRequest","finishServerPlayerRequest","clearServerPlayerRequest","replyServerPlayer","recordServerPlayerAttempt","canonicalServerPlayerUrl","currentTopOrigin"]){
    assert.equal(method(activity,name),method(previous,name),name);
  }
  const beforeHttp=previous.slice(previous.indexOf("  private fun httpOrigin("),previous.indexOf("  fun showWebFullscreen("));
  assert.ok(activity.includes(beforeHttp));
  assert.deepEqual([...activity.matchAll(/@JavascriptInterface\s+fun (\w+)/g)].map(row=>row[1]),["getInsets","getSystemGestureInsets"]);
  for(const value of ["CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)","androidUpdater.checkManually()"]){
    assert.equal(activity.split(value).length,previous.split(value).length);
  }
  assert.doesNotMatch(activity,/setWebViewClient|webViewClient\s*=|setWebChromeClient|clearHistory|removeAllCookies/);
});

test("bundled entry is pinned to the current HTTP Android scheme and never supplied by server configuration",()=>{
  const conf=JSON.parse(readFileSync(new URL("../web/src-tauri/tauri.conf.json",import.meta.url),"utf8"));
  assert.equal(conf.app.windows[0].useHttpsScheme??false,false);
  const serverMode=readFileSync(new URL("../web/src/lib/serverMode.ts",import.meta.url),"utf8");
  assert.ok(serverMode.includes('const ANDROID_LOCAL_ENTRY_HASH = "#yawf-local-mode"'));
  assert.ok(serverMode.includes('page.protocol === "http:" && page.hostname === "tauri.localhost"'));
  const native=method(activity,"showRemoteRecoveryDialog");
  assert.equal(native.includes("configuredServer"),false);
  assert.ok(native.includes('"http://tauri.localhost/#yawf-local-mode"'));
});

test("startup consumes local entry before saved follow and therefore cannot immediately bounce back",()=>{
  const main=readFileSync(process.env.ANDROID_COLD_MAIN_SOURCE||new URL("../web/src/main.tsx",import.meta.url),"utf8");
  const begin=main.indexOf("consumeAndroidLocalModeEntry();");
  const end=main.indexOf("\nif (isTVMode())",begin);
  const follow=main.indexOf("const follow = followServerURL()");
  assert.ok(begin>=0&&end>follow&&begin<follow);
  const startup=main.slice(begin,end);
  let local=false;const replacements=[];
  runInNewContext(startup,{
    consumeAndroidLocalModeEntry(){local=true;},
    followServerURL(){return local?null:"https://saved.example";},
    URL,
    window:{location:{origin:"http://tauri.localhost",replace(url){replacements.push(url)}}}
  },{timeout:100});
  assert.equal(local,true);assert.deepEqual(replacements,[]);
});
