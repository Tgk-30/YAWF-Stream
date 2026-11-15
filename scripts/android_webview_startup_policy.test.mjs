import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {basename,delimiter,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {currentStartupMainActivityForTest} from './patch_tauri_android.mjs';

function below(root,predicate) {
  if (!existsSync(root)) return [];
  return readdirSync(root,{withFileTypes:true}).flatMap(entry=>{
    const path=join(root,entry.name);
    return entry.isDirectory()?below(path,predicate):predicate(path)?[path]:[];
  });
}
function compilerRuntimeCoordinates(pom) {
  return [...pom.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].flatMap(([,body])=>{
    const field=name=>new RegExp(`<${name}>([^<]+)</${name}>`).exec(body)?.[1].trim();
    if (!['compile','runtime'].includes(field('scope')||'compile')) return [];
    const coordinate=['groupId','artifactId','version'].map(field);
    assert.ok(coordinate.every(value=>value&&/^[\w.+-]+$/.test(value)),'Unsupported cached compiler dependency');
    return [coordinate.join('/')];
  });
}
function toolchain(t) {
  const cache=join(process.env.GRADLE_USER_HOME||join(homedir(),'.gradle'),'caches/modules-2/files-2.1');
  const jar=coordinate=>{const [,artifact,version]=coordinate.split('/');return below(join(cache,coordinate),p=>version?basename(p)===`${artifact}-${version}.jar`:p.endsWith('.jar'))[0];};
  const pom=version=>below(join(cache,`org.jetbrains.kotlin/kotlin-compiler-embeddable/${version}`),p=>p.endsWith(`kotlin-compiler-embeddable-${version}.pom`))[0];
  const compiler=below(join(cache,'org.jetbrains.kotlin/kotlin-compiler-embeddable'),p=>/kotlin-compiler-embeddable-[^/]+\.jar$/.test(p)).sort((a,b)=>b.localeCompare(a,'en',{numeric:true})).find(p=>{
    const v=/kotlin-compiler-embeddable-([^/]+)\.jar$/.exec(p)[1];return pom(v)&&jar(`org.jetbrains.kotlin/kotlin-stdlib/${v}`)&&jar(`org.jetbrains.kotlin/kotlin-script-runtime/${v}`);
  });
  const version=compiler&&/kotlin-compiler-embeddable-([^/]+)\.jar$/.exec(compiler)[1];
  const stdlib=version&&jar(`org.jetbrains.kotlin/kotlin-stdlib/${version}`);const annotations=jar('org.jetbrains/annotations');
  const dependencies=version?compilerRuntimeCoordinates(readFileSync(pom(version),'utf8')):[];
  const components=[compiler,annotations,...dependencies.map(jar)];
  const java=join(process.env.JAVA_HOME||'/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home','bin','java');
  if(components.some(p=>!p)||!stdlib||!existsSync(java)) {
    assert.notEqual(process.env.YAWF_REQUIRE_ANDROID_STARTUP_BEHAVIOR,'1','Required cached pure Kotlin startup compiler missing; no network fallback');
    t.skip('Kotlin compiler cache or Java unavailable');return null;
  }
  return {java,runtime:components.join(delimiter),stdlib,annotations,version};
}
const work=mkdtempSync(join(process.env.TMPDIR||tmpdir(),'yawf-startup-policy-'));
after(()=>rmSync(work,{recursive:true,force:true}));
const production=fileURLToPath(new URL('./android/YawfWebViewStartupGate.kt',import.meta.url));
const behavior=fileURLToPath(new URL('./android/YawfWebViewStartupGateBehaviorTest.kt',import.meta.url));
const compiled=new Map();
function compile(t,text,name='production') {
  const tools=toolchain(t);if(!tools)return null;
  if(compiled.has(name))return {...tools,output:compiled.get(name)};
  const dir=join(work,name);mkdirSync(dir);const source=join(dir,'YawfWebViewStartupGate.kt'),output=join(dir,'behavior.jar');writeFileSync(source,text);
  const result=spawnSync(tools.java,[`-Djava.io.tmpdir=${work}`,'-cp',tools.runtime,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[tools.stdlib,tools.annotations].join(delimiter),'-d',output,source,behavior],{encoding:'utf8',timeout:60000});
  assert.equal(result.status,0,result.stdout+result.stderr);compiled.set(name,output);return {...tools,output};
}
function run(tools,scenario) {
  return spawnSync(tools.java,[`-Djava.io.tmpdir=${work}`,'-cp',[tools.output,tools.stdlib].join(delimiter),'com.tgk30.debridstreamer.YawfWebViewStartupGateBehaviorTestKt',scenario],{encoding:'utf8',timeout:10000});
}
const scenarios=['success-once','failure','timeout','callback-at-deadline','inactive','replacement-owner','resume-after-deadline','explicit-retry','retry-while-running','back-cancel','foreign-owner','clock-regression'];
for(const scenario of scenarios)test(`pure Kotlin native startup admission: ${scenario}`,t=>{
  const tools=compile(t,readFileSync(production,'utf8'));if(!tools)return;
  const result=run(tools,scenario);assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,new RegExp('Startup policy passed: '+scenario));
});
const mutations=[
  ['no-success-required','phase != Phase.READY || !observe(nowMillis)','false || !observe(nowMillis)','success-once'],
  ['ignore-active-owner','activeOwner !== owner || attempt != generation','false || attempt != generation','inactive'],
  ['stale-owner-pause','if (activeOwner === owner) activeOwner = null','activeOwner = null','replacement-owner'],
  ['late-callback','if (expire(nowMillis)) return false','if (false) return false','callback-at-deadline'],
  ['ignore-generation','if (attempt != generation || phase != Phase.WARMING','if (false || phase != Phase.WARMING','explicit-retry'],
  ['auto-retry','val allowed = phase == Phase.IDLE ||','val allowed = phase == Phase.FAILED || phase == Phase.IDLE ||','failure'],
  ['back-resurrection','phase = Phase.CANCELLED','phase = Phase.WARMING','back-cancel'],
  ['foreign-claim','activeOwner !== owner || attempt != generation','false || attempt != generation','foreign-owner'],
  ['late-ready','(phase == Phase.WARMING || phase == Phase.READY)','(phase == Phase.WARMING)','resume-after-deadline'],
  ['overlap-retry','val allowed = phase == Phase.IDLE ||','val allowed = phase == Phase.WARMING || phase == Phase.IDLE ||','retry-while-running'],
  ['missing-deadline','nowMillis >= deadlineMillis','false','timeout'],
  ['backdated-result','if (attempt != generation || phase != Phase.WARMING || !observe(nowMillis))','if (attempt != generation || phase != Phase.WARMING)','clock-regression'],
];
for(const [name,old,replacement,scenario] of mutations)test(`individual causal Kotlin revert: ${name}`,t=>{
  const source=readFileSync(production,'utf8');assert.ok(source.includes(old),name);
  const tools=compile(t,source.replace(old,replacement),name);if(!tools)return;
  const result=run(tools,scenario);assert.notEqual(result.status,0,'Unsafe mutant must fail the specific behavioral regression');assert.match(result.stderr,/IllegalStateException/);
});

const coordinatorSource=fileURLToPath(new URL('./android/YawfWebViewStartup.kt',import.meta.url));
const activitySource=currentStartupMainActivityForTest('com.tgk30.debridstreamer');
const wrySource=readFileSync(new URL('../web/src-tauri/vendor/wry/src/android/owned/WryActivity.kt',import.meta.url),'utf8');
function kotlinMethod(source,signature) {
 const start=source.indexOf(signature),open=source.indexOf('{',start);assert.ok(start>=0&&open>start,signature);
 let depth=1,end=open+1;for(;depth&&end<source.length;end++){if(source[end]==='{')depth++;else if(source[end]==='}')depth--;}
 assert.equal(depth,0,signature);return source.slice(start,end);
}
function updaterLifecycle(source) {
 return ['fun resumeAndroidUpdaterAfterStartup()', 'private fun pauseAndroidUpdaterAfterStartup()',
  'override fun onResume()', 'override fun onPause()', 'override fun onOwnedWebViewStored(webView: WebView)',
  'override fun onOwnedWebViewDestroy(webView: WebView)', 'fun checkAndroidUpdates()']
  .map(signature=>kotlinMethod(source,signature)).join('\n');
}
const notifyStored=kotlinMethod(wrySource,'fun notifyOwnedWebViewStored(webView: WebView)');
const storedPredicate=/fun isOwnedWebViewStored\(webView: WebView\): Boolean =\n[^\n]+/.exec(wrySource)?.[0];
assert.ok(storedPredicate);
const nativeStubs={
 'context.kt':`package android.content
open class Context
`,
 'os.kt':`package android.os
object SystemClock { var clock = 0L; fun uptimeMillis() = clock; fun elapsedRealtime() = clock }
class Looper { companion object { private val main = Looper(); fun myLooper() = main; fun getMainLooper() = main } }
class Handler(looper: Looper) {
 fun post(action: () -> Unit): Boolean { tasks.add(SystemClock.clock to action); return true }
 fun postAtTime(action: () -> Unit, at: Long): Boolean { tasks.add(at to action); return true }
 companion object {
  private val tasks = mutableListOf<Pair<Long, () -> Unit>>()
  fun flush() { var count = 0; while (true) { val index = tasks.indexOfFirst { it.first <= SystemClock.clock }; if (index < 0) return; check(++count < 1000); tasks.removeAt(index).second() } }
 }
}
`,
 'graphics.kt':`package android.graphics
object Color { const val WHITE = -1; fun rgb(r: Int, g: Int, b: Int) = r + g + b }
`,
 'view.kt':`package android.view
import android.content.Context
import android.os.Handler
import android.os.Looper
open class View(val context: Context) {
 val viewTreeObserver = ViewTreeObserver()
 var accessibilityLiveRegion = 0
 var isEnabled = true
 private var listener: ((View) -> Unit)? = null
 fun setOnClickListener(callback: (View) -> Unit) { listener = callback }
 fun click() { check(isEnabled); listener?.invoke(this) }
 fun setPadding(a: Int, b: Int, c: Int, d: Int) {}
 fun setBackgroundColor(color: Int) {}
 fun post(callback: () -> Unit) { Handler(Looper.getMainLooper()).post(callback) }
 companion object { const val ACCESSIBILITY_LIVE_REGION_POLITE = 1 }
}
class ViewTreeObserver {
 interface OnDrawListener { fun onDraw() }
 var isAlive = true
 private val listeners = mutableListOf<OnDrawListener>()
 fun addOnDrawListener(listener: OnDrawListener) { listeners.add(listener) }
 fun removeOnDrawListener(listener: OnDrawListener) { listeners.remove(listener) }
 fun draw() { listeners.toList().forEach { it.onDraw() } }
}
`,
 'widgets.kt':`package android.widget
import android.content.Context
import android.view.View
open class TextView(context: Context) : View(context) { var text = ""; var textSize = 0f; fun setTextColor(color: Int) {} }
class Button(context: Context) : TextView(context)
class LinearLayout(context: Context) : View(context) {
 var orientation = 0; val children = mutableListOf<View>()
 fun addView(view: View) { children.add(view) }
 companion object { const val VERTICAL = 1 }
}
`,
 'keep.kt':`package androidx.annotation
annotation class Keep
`,
 'webkit.kt':`package androidx.webkit
import android.content.Context
import java.util.concurrent.Executor
class WebViewStartUpResult
class WebViewStartupException : RuntimeException()
interface WebViewOutcomeReceiver<T, E> { fun onResult(result: T); fun onError(error: E) }
class WebViewStartUpConfig(val executor: Executor, val runUi: Boolean) {
 class Builder(val executor: Executor) { private var runUi = true; fun setShouldRunUiThreadStartUpTasks(value: Boolean): Builder { runUi = value; return this }; fun build() = WebViewStartUpConfig(executor, runUi) }
}
object WebViewCompat {
 val callbacks = mutableListOf<WebViewOutcomeReceiver<WebViewStartUpResult, WebViewStartupException>>()
 val contexts = mutableListOf<Context>(); val executors = mutableListOf<Executor>()
 fun startUpWebView(context: Context, config: WebViewStartUpConfig, callback: WebViewOutcomeReceiver<WebViewStartUpResult, WebViewStartupException>) {
  check(config.runUi); contexts.add(context); executors.add(config.executor); callbacks.add(callback)
 }
}
`,
 'webview.kt':`package android.webkit
import android.content.Context
import android.view.View
class WebView(context: Context) : View(context)
`,
 'main.kt':`package com.tgk30.debridstreamer
import android.content.Context
import android.view.View
import android.webkit.WebView
import java.lang.ref.WeakReference
open class ActivityBoundary : Context() {
 open fun onResume() {}; open fun onPause() {}
 open fun onOwnedWebViewStored(webView: WebView) {}; open fun onOwnedWebViewDestroy(webView: WebView) {}
}
class UpdaterBoundary {
 var resumes=0;var pauses=0;var pendingManual=false;var foreground=false
 fun onResume(){resumes++;foreground=true};fun onPause(){pauses++;foreground=false}
 fun checkManually(){pendingManual=true}
}
class MainActivity : ActivityBoundary() {
 val applicationContext = Context()
 var isFinishing = false; var isDestroyed = false; var isChangingConfigurations = false
 var content: View? = null
 private lateinit var androidUpdater: UpdaterBoundary
 private var androidUpdaterResumed=false
 private var mWebView:WebView?=null
 private var mStoredWebView:WeakReference<WebView>?=null
 val updater:UpdaterBoundary get()=androidUpdater
 fun assign(view:WebView){mWebView=view;mStoredWebView=null;if(!::androidUpdater.isInitialized)androidUpdater=UpdaterBoundary()}
 fun dispose(view:WebView){check(mWebView===view);mWebView=null;mStoredWebView=null;onOwnedWebViewDestroy(view)}
 fun showWebViewCompatibilityDialog() {};fun dismissRemoteRecoveryDialog() {}
 fun runOnUiThread(block:()->Unit){block()}
 ${notifyStored}
 ${storedPredicate}
 ACTUAL_UPDATER_LIFECYCLE
 fun setContentView(view: View) { content = view }
 fun finish() { isFinishing = true }
}
object StartupHarness { val events = mutableListOf<Pair<Int, Long>>(); fun signal(kind: Int, ticket: Long) { events.add(kind to ticket) } }
`,
 'coordinatorBehavior.kt':`package com.tgk30.debridstreamer
import android.webkit.WebView
import android.os.Handler
import android.os.SystemClock
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewStartUpResult
import androidx.webkit.WebViewStartupException
private fun expect(value: Boolean, message: String) { check(value) { message } }
private fun draw(activity: MainActivity) { activity.content!!.viewTreeObserver.draw(); Handler.flush() }
private fun launch(): MainActivity {
 val count = WebViewCompat.callbacks.size
 val activity = MainActivity(); YawfWebViewStartup.bind(activity); YawfWebViewStartup.showLoadingIfNeeded(activity); YawfWebViewStartup.onResume(activity)
 expect(WebViewCompat.callbacks.size == count, "no engine startup before first native draw")
 draw(activity); return activity
}
private fun ready(): Long {
 WebViewCompat.callbacks.last().onResult(WebViewStartUpResult()); Handler.flush()
 expect(StartupHarness.events.any { it.first == 1 }, "actual success offers readiness to the registered native listener")
 return StartupHarness.events.last { it.first == 1 }.second
}
private fun authorize(ticket: Long) { YawfWebViewStartup.authorizeConstruction(ticket); Handler.flush(); expect(StartupHarness.events.any { it == 2 to ticket }, "owner checked on UI before constructor queue") }
private fun retry(activity: MainActivity) {
 val button = (activity.content as LinearLayout).children.filterIsInstance<Button>().single { it.text == "Retry startup" }
 expect(button.isEnabled, "explicit Retry available"); button.click(); draw(activity)
}
private fun accept(activity:MainActivity,view:WebView) {
 activity.assign(view);expect(YawfWebViewStartup.onWebViewCreate(activity,view),"exact Activity hook accepted")
}
private fun receiptCleared():Boolean {
 val field=YawfWebViewStartup.javaClass.getDeclaredField("storedWebView");field.isAccessible=true
 return field.get(YawfWebViewStartup)==null
}
private fun processCommitTicket():Long {
 val field=YawfWebViewStartup.javaClass.getDeclaredField("processCommittedTicket");field.isAccessible=true
 return field.getLong(YawfWebViewStartup)
}
fun main(args: Array<String>) {
 SystemClock.clock = 1L
 val lateBridge = args.single() == "late-native-listener" || args.single() == "bridge-after-early-back"
 if (!lateBridge) { YawfWebViewStartup.onBridgeReady(); Handler.flush() }
 val activity = launch()
 expect(WebViewCompat.callbacks.size == 1, "one async request after native first draw")
 expect(WebViewCompat.contexts.single() === activity.applicationContext, "only application context enters startup API")
 expect(StartupHarness.events.isEmpty(), "no Main construction before actual success")
 when (args.single()) {
  "late-native-listener" -> {
   WebViewCompat.callbacks.single().onResult(WebViewStartUpResult()); Handler.flush()
   expect(StartupHarness.events.isEmpty(), "native signal not called before private registration")
   YawfWebViewStartup.onBridgeReady(); Handler.flush()
   expect(StartupHarness.events.count { it.first == 1 } == 1, "late native listener receives retained success exactly once")
   val ticket = StartupHarness.events.single { it.first == 1 }.second
   authorize(ticket); val webView = WebView(activity); expect(YawfWebViewStartup.onWebViewCreate(activity, webView), "initial success retained until late listener registration"); Handler.flush(); expect(!YawfWebViewStartup.isAttached(ticket), "hook is not storage"); expect(YawfWebViewStartup.constructionStored(ticket, webView), "post-storage identity proof")
   expect(YawfWebViewStartup.isAttached(ticket), "late listener handoff commits only real callback")
  }
  "bridge-after-early-back" -> {
   YawfWebViewStartup.onPause(activity); activity.isDestroyed = true; YawfWebViewStartup.onDestroy(activity)
   WebViewCompat.callbacks.single().onResult(WebViewStartUpResult()); Handler.flush()
   YawfWebViewStartup.onBridgeReady(); Handler.flush()
   expect(StartupHarness.events.isEmpty(), "listener binding with no Activity does not launch stale owner")
   val next = launch()
   val ticket = ready(); authorize(ticket)
   val webView = WebView(next); expect(YawfWebViewStartup.onWebViewCreate(next, webView), "process listener survives registration after early Back"); Handler.flush(); expect(!YawfWebViewStartup.isAttached(ticket), "hook is not storage"); expect(YawfWebViewStartup.constructionStored(ticket, webView), "post-storage identity proof")
   expect(YawfWebViewStartup.isAttached(ticket), "reentry actual callback commits")
  }
  "native-first-frame" -> {
   expect(activity.content is LinearLayout, "ordinary native loading while API pending")
   val back = (activity.content as LinearLayout).children.filterIsInstance<Button>().single { it.text == "Go back" }; back.click()
   expect(activity.isFinishing, "native Back usable while engine pending")
  }
  "callback-only-completion" -> {
   val ticket = ready(); authorize(ticket)
   expect(!YawfWebViewStartup.isAttached(ticket), "queue authorization is not completion")
   val webView = WebView(activity)
   expect(YawfWebViewStartup.onWebViewCreate(activity, webView), "actual owned callback admitted")
   expect(!YawfWebViewStartup.isAttached(ticket), "hook acceptance is not storage proof")
   activity.setContentView(webView); Handler.flush()
   expect(!YawfWebViewStartup.isAttached(ticket), "even Handler tail is not Wry storage proof")
   expect(YawfWebViewStartup.constructionStored(ticket, webView), "matching post-storage object acknowledged")
   expect(YawfWebViewStartup.isAttached(ticket), "post-storage proof commits once")
   expect(!YawfWebViewStartup.constructionStored(ticket, webView), "duplicate proof cannot commit")
   expect(StartupHarness.events.none { it.first == 3 }, "Java hook never signals premature completion")
  }
  "updater-cold-ack" -> {
   val ticket=ready();authorize(ticket);val view=WebView(activity);accept(activity,view)
   activity.checkAndroidUpdates();expect(activity.updater.pendingManual,"existing native manual intent retained")
   activity.notifyOwnedWebViewStored(view);Handler.flush()
   expect(activity.updater.resumes==0,"native storage notification alone is not cold ACK")
   expect(YawfWebViewStartup.constructionStored(ticket,view),"actual cold storage proof commits")
   Handler.flush();expect(activity.updater.resumes==0,"Java storage ACK alone cannot activate before native dispatch commits")
   YawfWebViewStartup.constructionCommitted(ticket,view)
   expect(activity.updater.resumes==0,"updater work cannot run inside post-send receipt")
   Handler.flush();expect(activity.updater.resumes==1&&activity.updater.pendingManual,"successful cold startup forwards readiness without losing manual intent")
   expect(!YawfWebViewStartup.constructionStored(ticket,view),"duplicate proof remains refused")
   YawfWebViewStartup.constructionCommitted(ticket,view)
   activity.notifyOwnedWebViewStored(view);activity.resumeAndroidUpdaterAfterStartup();Handler.flush()
   expect(activity.updater.resumes==1,"one foreground activation despite duplicate edges")
   activity.onPause();expect(!activity.updater.foreground,"pause forwarded after revocation")
   activity.onResume();Handler.flush();expect(activity.updater.resumes==2,"real later resume still forwarded")
  }
  "updater-failed-retry" -> {
   val ticket=ready();authorize(ticket);val first=WebView(activity);accept(activity,first)
   expect(!YawfWebViewStartup.constructionStored(ticket,null),"failed plugin/storage cannot commit")
   YawfWebViewStartup.constructionFailed(ticket);Handler.flush();activity.dispose(first)
   YawfWebViewStartup.constructionCleared(ticket);Handler.flush();draw(activity)
   expect(activity.updater.resumes==0,"failed construction never starts updater foreground UI")
   retry(activity);val nextTicket=ready();authorize(nextTicket);val next=WebView(activity);accept(activity,next)
   activity.notifyOwnedWebViewStored(next);Handler.flush();expect(activity.updater.resumes==0,"retry also waits for actual ACK")
   expect(YawfWebViewStartup.constructionStored(nextTicket,next),"retry exact storage commits")
   YawfWebViewStartup.constructionCommitted(nextTicket,next)
   Handler.flush();expect(activity.updater.resumes==1,"successful retry enables unchanged updater consent flow")
  }
  "updater-notification-failed" -> {
   val ticket=ready();authorize(ticket);val view=WebView(activity);accept(activity,view)
   // The observer ran, but the final Wry hook did not return successfully.
   YawfWebViewStartup.onOwnedWebViewStored(activity,view)
   expect(YawfWebViewStartup.constructionStored(ticket,view),"observer failure does not replace valid cold ACK")
   YawfWebViewStartup.constructionCommitted(ticket,view)
   Handler.flush();activity.resumeAndroidUpdaterAfterStartup()
   expect(YawfWebViewStartup.isAttached(ticket)&&activity.updater.resumes==0,"native storage stays committed but failed observer is unavailable")
  }
  "updater-paused-publication" -> {
   val ticket=ready();authorize(ticket);val view=WebView(activity);accept(activity,view);activity.notifyOwnedWebViewStored(view)
   expect(YawfWebViewStartup.constructionStored(ticket,view),"storage commits before pause")
   YawfWebViewStartup.constructionCommitted(ticket,view)
   activity.onPause();Handler.flush();expect(activity.updater.resumes==0,"queued activation cannot cross pause")
   activity.onResume();Handler.flush();expect(activity.updater.resumes==1,"current stored view can activate after real resume")
  }
  "updater-warm-owner" -> {
   val ticket=ready();authorize(ticket);val first=WebView(activity);accept(activity,first);activity.notifyOwnedWebViewStored(first)
   expect(YawfWebViewStartup.constructionStored(ticket,first),"old owner stores before replacement")
   YawfWebViewStartup.constructionCommitted(ticket,first)
   val next=MainActivity();YawfWebViewStartup.bind(next);next.onResume()
   expect(receiptCleared(),"owner rebind drops prior stored receipt")
   expect(processCommitTicket()==ticket,"legitimate native process commit survives warm rebind")
   Handler.flush();expect(activity.updater.resumes==0,"late old-owner activation is inert")
   val view=WebView(next);accept(next,view);next.resumeAndroidUpdaterAfterStartup()
   expect(next.updater.resumes==0,"warm process attachment is not new-owner storage")
   next.notifyOwnedWebViewStored(view);expect(next.updater.resumes==0,"warm observer only queues foreground work")
   Handler.flush();expect(next.updater.resumes==1,"warm recreation activates its own committed object")
   YawfWebViewStartup.onOwnedWebViewDestroy(activity,first);next.resumeAndroidUpdaterAfterStartup()
   expect(next.updater.resumes==1&&YawfWebViewStartup.isUpdaterReady(next),"old cleanup cannot revoke replacement readiness")
  }
  "updater-destroyed-publication" -> {
   val ticket=ready();authorize(ticket);val view=WebView(activity);accept(activity,view);activity.notifyOwnedWebViewStored(view)
   expect(YawfWebViewStartup.constructionStored(ticket,view),"storage before destroy")
   YawfWebViewStartup.constructionCommitted(ticket,view)
   activity.isDestroyed=true;Handler.flush();expect(activity.updater.resumes==0,"destroyed owner cannot receive queued activation")
   YawfWebViewStartup.onDestroy(activity);expect(receiptCleared(),"destroy releases stored receipt")
  }
  "updater-disposed-publication" -> {
   val ticket=ready();authorize(ticket);val view=WebView(activity);accept(activity,view);activity.notifyOwnedWebViewStored(view)
   expect(YawfWebViewStartup.constructionStored(ticket,view),"storage before exact cleanup")
   YawfWebViewStartup.constructionCommitted(ticket,view)
   activity.dispose(view);expect(receiptCleared(),"exact owned destruction releases stored receipt")
   Handler.flush();expect(activity.updater.resumes==0,"disposed view cannot activate updater")
  }
  "updater-foreign-receipt" -> {
   val ticket=ready();authorize(ticket);val view=WebView(activity);accept(activity,view)
   YawfWebViewStartup.onOwnedWebViewStored(activity,WebView(activity))
   expect(receiptCleared(),"foreign object cannot establish owner receipt")
   activity.notifyOwnedWebViewStored(view);expect(YawfWebViewStartup.constructionStored(ticket,view),"correct later receipt still commits")
   YawfWebViewStartup.constructionCommitted(ticket,view)
   Handler.flush();expect(activity.updater.resumes==1,"foreign notification cannot poison valid activation")
  }
  "updater-fatal-dispatch-rebind" -> {
   val ticket=ready();authorize(ticket);val view=WebView(activity);accept(activity,view);activity.notifyOwnedWebViewStored(view)
   expect(YawfWebViewStartup.constructionStored(ticket,view),"Java storage can precede fatal native dispatch failure")
   Handler.flush();expect(activity.updater.resumes==0,"no post-send receipt means no foreground activation")
   val next=MainActivity();YawfWebViewStartup.bind(next);next.onResume();val warm=WebView(next);accept(next,warm);next.notifyOwnedWebViewStored(warm)
   YawfWebViewStartup.constructionCommitted(ticket,view)
   Handler.flush();expect(next.updater.resumes==0,"warm owner cannot convert missing process commit into readiness")
   expect(processCommitTicket()==0L,"old owner receipt cannot retroactively qualify replacement")
  }
  "updater-postcommit-exact" -> {
   val ticket=ready();authorize(ticket);val view=WebView(activity);accept(activity,view);activity.notifyOwnedWebViewStored(view)
   YawfWebViewStartup.constructionCommitted(ticket,view);Handler.flush();expect(activity.updater.resumes==0,"notification before Java ACK refuses")
   expect(YawfWebViewStartup.constructionStored(ticket,view),"exact Java ACK")
   YawfWebViewStartup.constructionCommitted(ticket+1,view);Handler.flush();expect(activity.updater.resumes==0&&processCommitTicket()==0L,"wrong commit ticket refuses")
   YawfWebViewStartup.constructionCommitted(ticket,null);Handler.flush();expect(activity.updater.resumes==0&&processCommitTicket()==0L,"null commit object refuses")
   YawfWebViewStartup.constructionCommitted(ticket,WebView(activity));Handler.flush();expect(activity.updater.resumes==0&&processCommitTicket()==0L,"wrong commit object refuses")
   YawfWebViewStartup.constructionCommitted(ticket,view);Handler.flush();expect(activity.updater.resumes==1,"exact post-send proof activates")
   YawfWebViewStartup.constructionCommitted(ticket,view);Handler.flush();expect(activity.updater.resumes==1,"duplicate commit receipt is inert")
  }
  "failure-manual-retry" -> {
   WebViewCompat.callbacks.single().onError(WebViewStartupException()); Handler.flush(); draw(activity)
   expect(StartupHarness.events.none { it.first == 1 }, "failure is not an actual readiness success")
   expect(WebViewCompat.callbacks.size == 1, "failure never automatically retries")
   retry(activity); expect(WebViewCompat.callbacks.size == 2, "one explicit retry")
   expect(WebViewCompat.executors[0] === WebViewCompat.executors[1], "one process background executor")
   WebViewCompat.callbacks[0].onResult(WebViewStartUpResult()); Handler.flush()
   expect(StartupHarness.events.none { it.first == 1 }, "old success cannot complete retry")
   ready()
  }
  "deadline-and-late-callback" -> {
   SystemClock.clock = 20_001L; Handler.flush(); draw(activity)
   expect(WebViewCompat.callbacks.size == 1, "timeout never automatically retries")
   WebViewCompat.callbacks.single().onResult(WebViewStartUpResult()); Handler.flush()
   expect(StartupHarness.events.none { it.first == 1 }, "late success never queues Main")
   retry(activity); expect(WebViewCompat.callbacks.size == 2, "timeout permits explicit retry")
  }
  "configuration-owner-rebind" -> {
   YawfWebViewStartup.onPause(activity); activity.isChangingConfigurations = true; YawfWebViewStartup.onDestroy(activity)
   val next = MainActivity(); YawfWebViewStartup.bind(next); YawfWebViewStartup.showLoadingIfNeeded(next); YawfWebViewStartup.onResume(next); draw(next)
   expect(WebViewCompat.callbacks.size == 1, "rotation retains in-flight API rather than automatic new attempt")
   val ticket = ready(); authorize(ticket)
   expect(!YawfWebViewStartup.onWebViewCreate(activity, WebView(activity)), "old Activity callback refused")
   val webView = WebView(next); expect(YawfWebViewStartup.onWebViewCreate(next, webView), "replacement owner actual callback admitted"); Handler.flush(); expect(!YawfWebViewStartup.isAttached(ticket), "hook not committed"); expect(YawfWebViewStartup.constructionStored(ticket, webView), "post-storage proof")
   expect(YawfWebViewStartup.isAttached(ticket), "replacement acknowledged")
  }
  "back-and-same-process-reentry" -> {
   YawfWebViewStartup.onPause(activity); activity.isDestroyed = true; YawfWebViewStartup.onDestroy(activity)
   WebViewCompat.callbacks.single().onResult(WebViewStartUpResult()); Handler.flush()
   expect(StartupHarness.events.none { it.first == 1 }, "destroyed owner never launches on late success")
   val next = launch(); expect(WebViewCompat.callbacks.size == 2, "normal new user entry works without process kill or state clearing")
   val ticket = ready(); authorize(ticket); val webView = WebView(next); expect(YawfWebViewStartup.onWebViewCreate(next, webView), "reentry callback accepted"); Handler.flush(); expect(YawfWebViewStartup.constructionStored(ticket, webView), "post-storage proof")
  }
  "queued-owner-loss-quarantine" -> {
   val ticket = ready(); authorize(ticket); YawfWebViewStartup.onPause(activity)
   expect(!YawfWebViewStartup.isConstructionAuthorized(ticket), "revoked owner rejected before queue if observed")
   expect(!YawfWebViewStartup.onWebViewCreate(activity, WebView(activity)), "unavoidable already-queued callback must still refuse")
   val stale = View(activity); activity.setContentView(stale); Handler.flush()
   expect(activity.content !== stale && activity.content is LinearLayout, "posted native error survives Wry's later setContentView")
   expect(!YawfWebViewStartup.isAttached(ticket), "queue/owner race is not qualified")
   expect(StartupHarness.events.count { it == 4 to ticket } == 1, "only owned uncommitted queue is cancelled once")
  }
  "deadline-between-queue-and-hook" -> {
   val ticket = ready(); authorize(ticket); SystemClock.clock = 20_001L
   expect(!YawfWebViewStartup.onWebViewCreate(activity, WebView(activity)), "actual callback checks absolute deadline again")
   Handler.flush(); expect(!YawfWebViewStartup.isAttached(ticket), "late real callback is not completion")
  }
  "paused-success-no-launch" -> {
   YawfWebViewStartup.onPause(activity); WebViewCompat.callbacks.single().onResult(WebViewStartUpResult()); Handler.flush()
   expect(StartupHarness.events.none { it.first == 1 }, "background result cannot launch")
   YawfWebViewStartup.onResume(activity); Handler.flush()
   expect(StartupHarness.events.any { it.first == 1 }, "normal resume within original deadline can use actual readiness")
  }
  "stored-null" , "stored-stale", "owner-loss-after-hook" , "storage-failure-retry" -> {
   val ticket = ready(); authorize(ticket); val accepted = WebView(activity)
   expect(YawfWebViewStartup.onWebViewCreate(activity, accepted), "hook accepts exact current object")
   Handler.flush(); expect(!YawfWebViewStartup.isAttached(ticket), "no premature hook completion")
   if (args.single() == "owner-loss-after-hook") YawfWebViewStartup.onPause(activity)
   val proof = if (args.single() == "stored-null") null else if (args.single() == "stored-stale") WebView(activity) else accepted
   if (args.single() != "storage-failure-retry") expect(!YawfWebViewStartup.constructionStored(ticket, proof), "null/stale/owner-lost proof refuses")
   else {
    expect(!YawfWebViewStartup.constructionStored(ticket, null), "failed Wry create cannot store")
    YawfWebViewStartup.constructionFailed(ticket); Handler.flush(); draw(activity)
    expect(!YawfWebViewStartup.isAttached(ticket), "failure never commits")
    val retryButton = (activity.content as LinearLayout).children.filterIsInstance<Button>().single { it.text == "Retry startup" }
    expect(!retryButton.isEnabled, "no retry before owned destruction acknowledgement")
    YawfWebViewStartup.constructionCleared(ticket); Handler.flush(); draw(activity)
    expect(WebViewCompat.callbacks.size == 1, "cleanup never auto-retries")
    retry(activity); val nextTicket = ready(); authorize(nextTicket); val next = WebView(activity)
    expect(YawfWebViewStartup.onWebViewCreate(activity, next), "explicit retry accepts new object")
    expect(!YawfWebViewStartup.constructionStored(nextTicket, accepted), "old globalref cannot qualify retry")
    expect(YawfWebViewStartup.constructionStored(nextTicket, next), "exact retry storage commits")
   }
  }
  "owned-cleanup-reference" -> {
   val ticket = ready(); authorize(ticket); val accepted = WebView(activity)
   expect(YawfWebViewStartup.onWebViewCreate(activity, accepted), "accepted object captured")
   YawfWebViewStartup.onPause(activity)
   fun field(name: String): Any? = YawfWebViewStartup.javaClass.getDeclaredField(name).let { it.isAccessible = true; it.get(YawfWebViewStartup) }
   val queued = field("queuedTicket"); val cleanup = field("cleanupTicket")
   expect(cleanup == ticket, "quarantine already armed")
   YawfWebViewStartup.onOwnedWebViewDestroy(MainActivity(), accepted)
   expect(field("acceptedWebView") === accepted, "foreign Activity cannot release owned reference")
   YawfWebViewStartup.onOwnedWebViewDestroy(activity, WebView(activity))
   expect(field("acceptedWebView") === accepted, "foreign object cannot release accepted reference")
   YawfWebViewStartup.onOwnedWebViewDestroy(activity, accepted)
   expect(field("acceptedWebView") == null, "exact Java cleanup releases accepted object")
   expect(field("queuedTicket") == queued && field("cleanupTicket") == cleanup, "object cleanup never clears ticket/quarantine before true logical Destroyed")
   expect(!YawfWebViewStartup.isAttached(ticket), "cleanup cannot commit")
  }
  else -> error("unknown coordinator scenario")
 }
 println("Startup coordinator passed: "+args.single())
}
`,
};
let coordinatorCompiled;
function compileCoordinator(t,helperText,activityText) {
 const tools=toolchain(t);if(!tools)return null;
 if(coordinatorCompiled&&!helperText&&!activityText)return {...tools,output:coordinatorCompiled};
 const dir=mkdtempSync(join(work,'coordinator-'));const paths=Object.entries(nativeStubs).map(([name,text])=>{const p=join(dir,name);writeFileSync(p,text.replace('ACTUAL_UPDATER_LIFECYCLE',updaterLifecycle(activityText||activitySource)));return p;});
 const helper=join(dir,'YawfWebViewStartup.kt');let source=helperText||readFileSync(coordinatorSource,'utf8');
 const native='@Keep @JvmStatic private external fun nativeSignal(kind: Int, ticket: Long)';
 assert.ok(source.includes(native),'exact private JNI boundary only');source=source.replace(native,'@Keep @JvmStatic private fun nativeSignal(kind: Int, ticket: Long) { StartupHarness.signal(kind, ticket) }');writeFileSync(helper,source);
 const output=join(dir,'behavior.jar');const built=spawnSync(tools.java,[`-Djava.io.tmpdir=${work}`,'-cp',tools.runtime,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[tools.stdlib,tools.annotations].join(delimiter),'-d',output,production,helper,...paths],{encoding:'utf8',timeout:60000});
 assert.equal(built.status,0,built.stdout+built.stderr);if(!helperText&&!activityText)coordinatorCompiled=output;return {...tools,output};
}
function runCoordinator(tools,scenario) {return spawnSync(tools.java,[`-Djava.io.tmpdir=${work}`,'-cp',[tools.output,tools.stdlib].join(delimiter),'com.tgk30.debridstreamer.CoordinatorBehaviorKt',scenario],{encoding:'utf8',timeout:10000});}
for(const scenario of ['native-first-frame','callback-only-completion','failure-manual-retry','deadline-and-late-callback','configuration-owner-rebind','back-and-same-process-reentry','queued-owner-loss-quarantine','deadline-between-queue-and-hook','paused-success-no-launch','late-native-listener','bridge-after-early-back','stored-null','stored-stale','owner-loss-after-hook','storage-failure-retry','owned-cleanup-reference'])test(`actual Kotlin startup coordinator with fake platform/JNI boundary: ${scenario}`,t=>{
 const tools=compileCoordinator(t);if(!tools)return;const result=runCoordinator(tools,scenario);assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/Startup coordinator passed/);
});

const coordinatorMutations=[
 ['owned-cleanup-retains-reference','if (acceptedActivity?.get() === activity && acceptedWebView === webView) clearAccepted(acceptedTicket)','if (false) clearAccepted(acceptedTicket)','owned-cleanup-reference'],
 ['stored-object-identity','webView == null || acceptedWebView !== webView || request != acceptedTicket','webView == null || false || request != acceptedTicket','stored-stale'],
 ['stored-null-proof','webView == null || acceptedWebView !== webView','false || false','stored-null'],
 ['post-hook-owner-loss-combined-fences','!usable(activity) || queuedTicket != request || cleanupTicket != 0L || attachedTicket != 0L ||\n      !gate.claimHandoff(ownerKey, gate.generation, now())','false','owner-loss-after-hook'],
 ['first-frame-required','|| !firstFrame ||','|| false ||','native-first-frame'],
 ['back-remains-usable','gate.cancel(ownerKey); activity.finish()','gate.cancel(ownerKey); Unit','native-first-frame'],
 ['no-queued-completion','    acceptedOwnerKey = ownerKey\n    return true','    acceptedOwnerKey = ownerKey\n    main.post { attachedTicket = ticket }\n    return true','callback-only-completion'],
 ['failure-is-not-success','override fun onError(error: WebViewStartupException) { complete(currentGate, attempt, false) }','override fun onError(error: WebViewStartupException) { complete(currentGate, attempt, true) }','failure-manual-retry'],
 ['no-timeout-auto-retry','if (gate.tick(now()) == YawfWebViewStartupGate.Phase.TIMED_OUT) {\n        owner.get()','if (gate.tick(now()) == YawfWebViewStartupGate.Phase.TIMED_OUT) {\n        retryRequested = true\n        owner.get()','deadline-and-late-callback'],
 ['exact-current-activity','private fun owns(activity: MainActivity): Boolean = owner.get() === activity','private fun owns(activity: MainActivity): Boolean = true','configuration-owner-rebind'],
 ['same-process-reentry','      gate = YawfWebViewStartupGate()','      gate = gate','back-and-same-process-reentry'],
 ['queued-owner-loss','if (!owns(activity) || queuedTicket == 0L || attachedTicket != 0L) return','if (true || !owns(activity) || queuedTicket == 0L || attachedTicket != 0L) return','queued-owner-loss-quarantine'],
 ['hook-deadline','gate.tick(now()) != YawfWebViewStartupGate.Phase.READY','gate.phase != YawfWebViewStartupGate.Phase.READY','deadline-between-queue-and-hook'],
 ['inactive-ready-signal','if (bridgeBound && usable(activity) && cleanupTicket == 0L','if (bridgeBound && owns(activity) && cleanupTicket == 0L','paused-success-no-launch'],
 ['late-listener-replay','      bridgeBound = true\n      offerReady()','      bridgeBound = true\n      Unit','late-native-listener'],
 ['early-back-listener-bind','      bridgeBound = true\n      offerReady()','      bridgeBound = owner.get() != null\n      offerReady()','bridge-after-early-back'],
];
for(const [name,old,replacement,scenario] of coordinatorMutations)test(`${name === 'post-hook-owner-loss-combined-fences' ? 'combined-fence causal coordinator revert' : 'individual causal coordinator revert'}: ${name}`,t=>{
 const source=readFileSync(coordinatorSource,'utf8');assert.ok(source.includes(old),name);
 const tools=compileCoordinator(t,source.replace(old,replacement));if(!tools)return;
 const result=runCoordinator(tools,scenario);assert.notEqual(result.status,0,'Unsafe in-memory coordinator mutant must fail');assert.match(result.stderr,/IllegalStateException/);
});

const updaterMutations=[
 ['cold-ack-required','updater-cold-ack','helper','owns(activity) && resumed && attachedTicket != 0L && storedWebView?.get() === webView &&','owns(activity) && resumed && storedWebView?.get() === webView &&'],
 ['commit-readiness-edge','updater-failed-retry','helper','    processCommittedTicket = request\n    acknowledgedWebView = null\n    postUpdaterActivation(activity, webView)','    processCommittedTicket = request\n    acknowledgedWebView = null'],
 ['successful-observer-return','updater-notification-failed','helper',' && activity.isOwnedWebViewStored(webView)',''],
 ['foreground-required','updater-paused-publication','helper','owns(activity) && resumed && attachedTicket != 0L &&','owns(activity) && attachedTicket != 0L &&'],
 ['rebind-clears-receipt','updater-warm-owner','helper','    ownerKey = Any()\n    storedWebView = null','    ownerKey = Any()'],
 ['warm-storage-edge','updater-warm-owner','helper','    val previous = storedWebView?.get()','    if (attachedTicket != 0L) return\n    val previous = storedWebView?.get()'],
 ['destroyed-owner-refused','updater-destroyed-publication','helper','!activity.isFinishing && !activity.isDestroyed && activity.isOwnedWebViewStored(webView)','!activity.isFinishing && activity.isOwnedWebViewStored(webView)'],
 ['exact-cleanup-releases-receipt','updater-disposed-publication','helper','    if (owns(activity) && storedWebView?.get() === webView) storedWebView = null',''],
 ['foreign-object-refused','updater-foreign-receipt','helper','if (attachedTicket == 0L && (acceptedWebView !== webView || acceptedActivity?.get() !== activity ||','if (attachedTicket == 0L && (acceptedActivity?.get() !== activity ||'],
 ['single-foreground-forward','updater-cold-ack','activity','androidUpdaterResumed || ',''],
 ['pause-resets-forwarding','updater-cold-ack','activity','private fun pauseAndroidUpdaterAfterStartup() {\n    androidUpdaterResumed = false','private fun pauseAndroidUpdaterAfterStartup() {'],
 ['native-process-commit-required','updater-fatal-dispatch-rebind','helper','      processCommittedTicket == attachedTicket &&\n',''],
 ['rebind-drops-pending-ack','updater-fatal-dispatch-rebind','helper','    ownerKey = Any()\n    storedWebView = null\n    acknowledgedWebView = null','    ownerKey = Any()\n    storedWebView = null'],
 ['warm-retains-native-commit','updater-warm-owner','helper','    ownerKey = Any()\n    storedWebView = null\n    acknowledgedWebView = null','    ownerKey = Any()\n    storedWebView = null\n    acknowledgedWebView = null\n    processCommittedTicket = 0L'],
 ['postcommit-request-identity','updater-postcommit-exact','helper','request <= 0L || request != attachedTicket || processCommittedTicket != 0L','request <= 0L || processCommittedTicket != 0L'],
 ['postcommit-object-identity','updater-postcommit-exact','helper','webView == null || acknowledgedWebView?.get() !== webView || activity.isFinishing','webView == null || activity.isFinishing'],
];
const postActivation=kotlinMethod(readFileSync(coordinatorSource,'utf8'),'private fun postUpdaterActivation(activity: MainActivity, webView: WebView)');
updaterMutations.push(['observer-not-inline','updater-cold-ack','helper',postActivation,postActivation.replace('main.post {','run inline@ {').replace('return@post','return@inline')]);
for(const [name,scenario,target,before,after]of updaterMutations)test(`actual committed-updater lifecycle with individual causal mutant: ${name}`,t=>{
 const original=compileCoordinator(t);if(!original)return;
 const positive=runCoordinator(original,scenario);assert.equal(positive.status,0,positive.stdout+positive.stderr);assert.match(positive.stdout,/Startup coordinator passed/);
 const source=target==='activity'?activitySource:readFileSync(coordinatorSource,'utf8');assert.equal(source.split(before).length,2,'unique actual-source mutation '+name);
 const changed=source.replace(before,after);
 const mutant=target==='activity'?compileCoordinator(t,undefined,changed):compileCoordinator(t,changed);
 const negative=runCoordinator(mutant,scenario);assert.equal(negative.signal,null);assert.equal(negative.status,1);assert.match(negative.stderr,/IllegalStateException/);
 assert.doesNotMatch(negative.stderr,/NoClassDefFoundError|ExceptionInInitializerError|OutOfMemoryError/);
});
