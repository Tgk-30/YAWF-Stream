import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import test, { after } from 'node:test';
import { patchedMainActivityForWebViewCompatibilityTest } from './patch_tauri_android.mjs';

const activity = patchedMainActivityForWebViewCompatibilityTest('com.tgk30.debridstreamer');
function between(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing production section: ${start}`);
  return source.slice(first, last);
}
function production(source) {
  const bridge = between(source, 'data class YawfInsetSnapshot(', '\n\nclass MainActivity');
  const refresh = between(source, '  private fun refreshSafeAreaInsets(', '  private fun detachSafeAreaBridge()');
  const detach = source.slice(source.indexOf('  private fun detachSafeAreaBridge()'), source.lastIndexOf('\n}'));
  const fields = source.split('\n').filter(line => /private val safeAreaSnapshot =|private val safeAreaBridge =/.test(line)).join('\n');
  const constants = source.split('\n').filter(line => /^private const val (EMPTY_SAFE_AREA|SAFE_AREA_CHANGE_SCRIPT|SAFE_AREA_BRIDGE_NAME|SERVER_PLAYER_BRIDGE_NAME) =/.test(line)).join('\n');
  return `package com.tgk30.debridstreamer
import java.util.concurrent.atomic.AtomicReference
import android.os.Build
import android.os.Looper
import android.view.View
import android.view.ViewTreeObserver
import android.webkit.WebView
import android.webkit.JavascriptInterface
import androidx.annotation.Keep
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
${constants}
${bridge}
class TestActivity {
${fields}
 private var safeAreaWebView: WebView? = null
 private var safeAreaLayoutListener: View.OnLayoutChangeListener? = null
 private var safeAreaGlobalLayoutListener: ViewTreeObserver.OnGlobalLayoutListener? = null
 private var serverPlayerPending: Any? = null
 private var serverPlayerListenerWebView: WebView? = null
 private val serverPlayerAttempts = mutableListOf<Long>()
 private fun finishServerPlayerRequest(pending: Any, status: String) {}
 fun own(view: WebView) { safeAreaWebView = view }
 fun refresh(view: WebView) { refreshSafeAreaInsets(view) }
 fun detach() { detachSafeAreaBridge() }
 fun bridge() = safeAreaBridge
${refresh}
${detach}
}
`;
}

// Host doubles execute the generated production bridge, refresh and detach bodies.
// They do not establish Android's actual inset values, touch layout or OS gestures.
const stubs = {
  'keep.kt': `package androidx.annotation
annotation class Keep`,
  'os.kt': `package android.os
object Build { object VERSION { var SDK_INT = 36 }; object VERSION_CODES { const val Q = 29 } }
object Looper { private val main = Any(); var onMain = true
 fun myLooper(): Any = if (onMain) main else Any()
 fun getMainLooper() = main
}`,
  'view.kt': `package android.view
open class View { interface OnLayoutChangeListener }
class ViewTreeObserver { interface OnGlobalLayoutListener
 val isAlive = true
 fun removeOnGlobalLayoutListener(listener: OnGlobalLayoutListener) {}
}`,
  'webview.kt': `package android.webkit
annotation class JavascriptInterface
class WebView {
 var insets: androidx.core.view.WindowInsetsCompat? = null
 val posted = mutableListOf<() -> Unit>()
 val events = mutableListOf<String>()
 var onEvent: (() -> Unit)? = null
 val viewTreeObserver = android.view.ViewTreeObserver()
 fun post(task: () -> Unit) { posted.add(task) }
 fun evaluateJavascript(script: String, callback: Any?) { events.add(script); onEvent?.invoke() }
 fun removeOnLayoutChangeListener(listener: android.view.View.OnLayoutChangeListener) {}
 fun removeJavascriptInterface(name: String) {}
}`,
  'compat.kt': `package androidx.core.view
data class Insets(val top: Int, val right: Int, val bottom: Int, val left: Int)
class WindowInsetsCompat(val persistent: Insets, val gestures: Insets) {
 val requestedTypes = mutableListOf<Int>()
 fun getInsets(types: Int): Insets { requestedTypes.add(types); return if (types == 32) gestures else persistent }
 object Type { fun systemBars() = 7; fun displayCutout() = 16; fun systemGestures() = 32 }
}
object ViewCompat { fun getRootWindowInsets(view: android.webkit.WebView) = view.insets }`,
  'webkit.kt': `package androidx.webkit
object WebViewFeature { const val WEB_MESSAGE_LISTENER = "listener"; fun isFeatureSupported(name: String) = true }
object WebViewCompat { fun removeWebMessageListener(view: android.webkit.WebView, name: String) {} }`,
  'behavior.kt': `package com.tgk30.debridstreamer
import android.os.Build
import android.os.Looper
import android.webkit.WebView
import androidx.core.view.Insets
import androidx.core.view.WindowInsetsCompat
private fun expect(value: Any?, wanted: Any?, label: String) { check(value == wanted) { "$label expected=$wanted actual=$value" } }
private fun json(top: Int, right: Int, bottom: Int, left: Int) = "{\\"top\\":$top,\\"right\\":$right,\\"bottom\\":$bottom,\\"left\\":$left}"
private val empty = json(0,0,0,0)
fun main() {
 val host = TestActivity(); val a = WebView(); val bridge = host.bridge()
 expect(bridge.getInsets(),empty,"initial safe");expect(bridge.getSystemGestureInsets(),empty,"initial gestures")
 val pairs = mutableListOf<Pair<String,String>>()
 a.onEvent = { pairs.add(bridge.getInsets() to bridge.getSystemGestureInsets()) }
 host.own(a)
 a.insets = WindowInsetsCompat(Insets(66,0,24,0),Insets(0,78,48,90))
 host.refresh(a)
 expect(bridge.getInsets(),json(66,0,24,0),"persistent mask")
 expect(bridge.getSystemGestureInsets(),json(0,78,48,90),"gesture mask and physical sides")
 expect(pairs.last(),json(66,0,24,0) to json(0,78,48,90),"both published before event")
 host.refresh(a);expect(a.events.size,1,"unchanged snapshot silent")
 a.insets = WindowInsetsCompat(Insets(66,0,24,0),Insets(0,96,48,102))
 host.refresh(a);expect(a.events.size,2,"gesture-only change dispatches")
 expect(pairs.last(),json(66,0,24,0) to json(0,96,48,102),"gesture-only pair")
 a.insets = WindowInsetsCompat(Insets(0,66,0,0),Insets(0,84,24,72))
 host.refresh(a);expect(pairs.last(),json(0,66,0,0) to json(0,84,24,72),"rotation current root")
 a.insets = WindowInsetsCompat(Insets(-1,-2,-3,-4),Insets(-5,-6,-7,-8))
 host.refresh(a);expect(pairs.last(),empty to empty,"negative values clamped")
 val stranger = WebView();stranger.insets=WindowInsetsCompat(Insets(99,98,97,96),Insets(95,94,93,92))
 host.refresh(stranger);expect(bridge.getInsets(),empty,"unowned safe ignored");expect(bridge.getSystemGestureInsets(),empty,"unowned gestures ignored")
 Build.VERSION.SDK_INT=28
 val legacy = WindowInsetsCompat(Insets(30,60,0,0),Insets(78,78,78,78));a.insets=legacy;host.refresh(a)
 expect(bridge.getInsets(),json(30,60,0,0),"legacy persistent retained")
 expect(bridge.getSystemGestureInsets(),empty,"legacy does not invent gestures")
 expect(legacy.requestedTypes.contains(32),false,"legacy skips compat gesture fallback")
 Build.VERSION.SDK_INT=36
 a.insets=WindowInsetsCompat(Insets(50,0,20,0),Insets(0,78,20,78));host.refresh(a)
 Looper.onMain=false;host.refresh(a);expect(a.posted.size,1,"off-main refresh posts")
 host.detach();expect(bridge.getInsets(),empty,"detach clears safe");expect(bridge.getSystemGestureInsets(),empty,"detach clears gestures")
 Looper.onMain=true;host.own(stranger);host.refresh(stranger)
 val current=bridge.getInsets() to bridge.getSystemGestureInsets()
 a.posted.single().invoke();expect(bridge.getInsets() to bridge.getSystemGestureInsets(),current,"stale posted owner ignored")
 stranger.insets=null;host.refresh(stranger)
 expect(bridge.getInsets() to bridge.getSystemGestureInsets(),current,"missing root does not publish")
 host.detach();host.detach()
 expect(bridge.getInsets(),empty,"nullable detach resets safe");expect(bridge.getSystemGestureInsets(),empty,"nullable detach resets gestures")
 println("Generated native inset behavior passed")
}
`,
};

function below(root, accept) {
  if (!existsSync(root)) return [];
  return readdirSync(root,{withFileTypes:true}).flatMap(e => { const p=join(root,e.name); return e.isDirectory()?below(p,accept):accept(p)?[p]:[]; });
}
function tools(t) {
  const cache=join(process.env.GRADLE_USER_HOME || join(homedir(),'.gradle'),'caches/modules-2/files-2.1');
  const jar = coordinate => { const [,name,version]=coordinate.split('/');return below(join(cache,coordinate),p=>version?basename(p)===`${name}-${version}.jar`:p.endsWith('.jar'))[0]; };
  const compiler=below(join(cache,'org.jetbrains.kotlin/kotlin-compiler-embeddable'),p=>/kotlin-compiler-embeddable-[^/]+\.jar$/.test(p)).sort((a,b)=>b.localeCompare(a,'en',{numeric:true})).find(p=>{ const v=/kotlin-compiler-embeddable-([^/]+)\.jar$/.exec(p)?.[1];return v&&jar(`org.jetbrains.kotlin/kotlin-stdlib/${v}`)&&below(join(cache,`org.jetbrains.kotlin/kotlin-compiler-embeddable/${v}`),p=>p.endsWith('.pom')).length; });
  const version=compiler&&/kotlin-compiler-embeddable-([^/]+)\.jar$/.exec(compiler)[1];
  const pom=version&&below(join(cache,`org.jetbrains.kotlin/kotlin-compiler-embeddable/${version}`),p=>p.endsWith('.pom'))[0];
  const dependencies=pom?[...readFileSync(pom,'utf8').matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].flatMap(([,body])=>{const field=n=>new RegExp(`<${n}>([^<]+)</${n}>`).exec(body)?.[1].trim();if(!['compile','runtime'].includes(field('scope')||'compile'))return [];const c=['groupId','artifactId','version'].map(field);assert.ok(c.every(v=>v&&/^[\w.+-]+$/.test(v)));return [c.join('/')];}):[];
  const stdlib=version&&jar(`org.jetbrains.kotlin/kotlin-stdlib/${version}`);const annotations=jar('org.jetbrains/annotations');
  const runtime=[compiler,annotations,...dependencies.map(jar)];const java=join(process.env.JAVA_HOME||'/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home','bin','java');
  if (!stdlib||!dependencies.length||runtime.some(p=>!p)||!existsSync(java)) {assert.notEqual(process.env.YAWF_REQUIRE_ANDROID_GESTURE_BEHAVIOR,'1','Required Kotlin toolchain missing');t.skip('Kotlin compiler cache or Java unavailable');return null;}
  return {java,stdlib,annotations,runtime:runtime.join(delimiter)};
}
const work=mkdtempSync(join(process.env.TMPDIR||tmpdir(),'yawf-gesture-insets-'));
after(()=>rmSync(work,{recursive:true,force:true}));
const stubPaths=Object.entries(stubs).map(([name,text])=>{const p=join(work,name);writeFileSync(p,text);return p;});
const compiled = new Map();
function execute(t,source,name) {
  const tool=tools(t);if(!tool)return null;
  if (compiled.has(name)) {
    return spawnSync(tool.java,['-cp',[compiled.get(name),tool.stdlib].join(delimiter),'com.tgk30.debridstreamer.BehaviorKt'],{encoding:'utf8',timeout:10000});
  }
  const dir=join(work,name);mkdirSync(dir);const file=join(dir,'production.kt');const jar=join(dir,'behavior.jar');writeFileSync(file,production(source));
  const built=spawnSync(tool.java,['-cp',tool.runtime,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[tool.stdlib,tool.annotations].join(delimiter),'-d',jar,file,...stubPaths],{encoding:'utf8',timeout:60000});
  assert.equal(built.status,0,`Generated Kotlin must compile before behavior: ${built.stdout}\n${built.stderr}`);
  compiled.set(name, jar);
  return spawnSync(tool.java,['-cp',[jar,tool.stdlib].join(delimiter),'com.tgk30.debridstreamer.BehaviorKt'],{encoding:'utf8',timeout:10000});
}
test('generated numeric bridge publishes current persistent and gesture pairs with lifecycle fences',t=>{const result=execute(t,activity,'positive');if(result)assert.equal(result.status,0,result.stdout+result.stderr);});
for (const [name,before,after] of [
  ['wrong-bridge-getter','fun getSystemGestureInsets(): String = snapshot.get().systemGestures','fun getSystemGestureInsets(): String = snapshot.get().safeArea'],
  ['legacy-gesture-fallback','Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q','true'],
  ['wrong-inset-type','windowInsets.getInsets(WindowInsetsCompat.Type.systemGestures())','windowInsets.getInsets(WindowInsetsCompat.Type.systemBars())'],
  ['gesture-only-event-lost','safeAreaSnapshot.getAndSet(nextSnapshot) != nextSnapshot','safeAreaSnapshot.getAndSet(nextSnapshot).safeArea != nextSnapshot.safeArea'],
  ['gesture-negative-not-clamped','gestures.left.coerceAtLeast(0)','gestures.left'],
  ['detach-not-reset','safeAreaSnapshot.set(YawfInsetSnapshot(EMPTY_SAFE_AREA, EMPTY_SAFE_AREA))','// missing snapshot reset'],
  ['unowned-refresh','    if (safeAreaWebView !== webView) return','    // missing WebView owner guard'],
]) {
  test(`behavior rejects ${name}`,t=>{assert.equal(activity.split(before).length,2,'mutation must match exactly once');const result=execute(t,activity.replace(before,after),name);if(result){assert.notEqual(result.status,0,'mutant must fail executed behavior, not compilation');assert.match(result.stderr,/IllegalStateException/);const control=execute(t,activity,'positive');assert.equal(control.status,0,'paired unchanged source must still pass in a fresh JVM');}});
}
