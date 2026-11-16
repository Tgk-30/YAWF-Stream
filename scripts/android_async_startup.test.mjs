import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const reference=await import(new URL('./patch_tauri_android.mjs',import.meta.url));
const patcher=process.env.ANDROID_STARTUP_PATCHER?await import(pathToFileURL(process.env.ANDROID_STARTUP_PATCHER)):reference;
const pkg='com.tgk30.debridstreamer';
const current=reference.previousAsyncStartupMainActivityForTest(pkg);
const accepted=reference.previousStartupActivitiesForTest(pkg);
function fixture(source=current){
 const root=mkdtempSync(join(process.env.TMPDIR||tmpdir(),'yawf-async-startup-'));const app=join(root,'web/src-tauri/gen/android/app');const java=join(app,'src/main/java',...pkg.split('.'));mkdirSync(java,{recursive:true});
 const main=join(java,'MainActivity.kt'),gradle=join(app,'build.gradle.kts'),manifest=join(app,'src/main/AndroidManifest.xml');writeFileSync(main,source);
 writeFileSync(gradle,`android {
    compileSdk = 36
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
 writeFileSync(manifest,`<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application android:usesCleartextTraffic="\${usesCleartextTraffic}">
        <activity android:name=".MainActivity" android:windowSoftInputMode="adjustResize" android:exported="true" android:launchMode="singleTask" android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|assetsPaths">
            <intent-filter><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent-filter>
            <intent-filter android:autoVerify="false"><action android:name="android.intent.action.VIEW" /><category android:name="android.intent.category.DEFAULT" /><category android:name="android.intent.category.BROWSABLE" /><data android:scheme="yawf" android:host="open" /></intent-filter>
        </activity>
    </application>
</manifest>
`);return{root,app,java,main,gradle,manifest};
}
function files(root){return readdirSync(root,{withFileTypes:true}).flatMap(x=>{const p=join(root,x.name);return x.isDirectory()?files(p):[p];});}
function snapshot(root){return Object.fromEntries(files(root).map(p=>[p.slice(root.length),readFileSync(p,'utf8')]));}
function withFixture(run,source){const f=fixture(source);try{return run(f);}finally{rmSync(f.root,{recursive:true,force:true});}}
function method(source,name){const start=source.indexOf('  override fun '+name);assert.ok(start>=0);return source.slice(start,source.indexOf('\n  }',start)+5);}
test('current107 migration adds stable async coordinator and defers every provider query until actual callback',()=>withFixture(f=>{
 const result=patcher.patchTauriAndroidProject({root:f.root});assert.equal(result.changed,true);const source=readFileSync(f.main,'utf8');const create=method(source,'onCreate');assert.ok(create.includes('YawfWebViewStartup.bind(this)'));assert.ok(create.indexOf('super.onCreate(savedInstanceState)')<create.indexOf('YawfWebViewStartup.showLoadingIfNeeded(this)'));assert.doesNotMatch(create,/inspectWebViewCompatibility|YawfAndroidUpdater.attach|WebViewCompat\./);const hook=method(source,'onWebViewCreate');assert.ok(hook.indexOf('YawfWebViewStartup.onWebViewCreate(this, webView)')<hook.indexOf('inspectWebViewCompatibility()'));assert.ok(existsSync(join(f.java,'YawfWebViewStartup.kt')));assert.ok(existsSync(join(f.java,'YawfWebViewStartupGate.kt')));assert.match(readFileSync(f.gradle,'utf8'),/webkit:1\.16\.0/);assert.equal(patcher.patchTauriAndroidProject({root:f.root}).changed,false);
}));
test('every previously accepted Activity template upgrades strictly and remains idempotent',()=>{
 assert.equal(accepted.length,12);for(const source of accepted)withFixture(f=>{patcher.patchTauriAndroidProject({root:f.root});assert.ok(readFileSync(f.main,'utf8').includes('YawfWebViewStartup.showLoadingIfNeeded(this)'));assert.equal(patcher.patchTauriAndroidProject({root:f.root}).changed,false);},source);
});
test('startup keeps launcher/deep-link filters, public Main/singleTask, opaque delivery and ordinary synchronous lifecycle intact',()=>withFixture(f=>{
 const original=readFileSync(f.manifest,'utf8');patcher.patchTauriAndroidProject({root:f.root});const changed=readFileSync(f.manifest,'utf8');const filters=x=>[...x.matchAll(/<intent-filter\b[\s\S]*?<\/intent-filter>/g)].map(x=>x[0]);assert.deepEqual(filters(changed),filters(original));assert.equal((changed.match(/android:name="\.MainActivity"/g)||[]).length,1);assert.ok(changed.includes('android:exported="true"'));assert.ok(changed.includes('android:launchMode="singleTask"'));assert.doesNotMatch(changed,/Bootstrap|noHistory|excludeFromRecents|finishOnTaskLaunch/);const source=readFileSync(f.main,'utf8');assert.doesNotMatch(source,/override fun onNewIntent|intent\.extras|intent\.data/);assert.equal((method(source,'onCreate').match(/super\.onCreate\(savedInstanceState\)/g)||[]).length,1);assert.ok(method(source,'onResume').indexOf('super.onResume()')<method(source,'onResume').indexOf('YawfWebViewStartup.onResume(this)'));assert.ok(method(source,'onResume').includes('if (YawfWebViewStartup.isAttachedTo(this))'));
}));
test('unknown startup helper, Activity, manifest or WebKit drift refuses before any generated write',()=>{
 for(const kind of ['helper','gate','activity','manifest','version','duplicate'])withFixture(f=>{
  if(kind==='helper')writeFileSync(join(f.java,'YawfWebViewStartup.kt'),'user-owned drift');
  if(kind==='gate')writeFileSync(join(f.java,'YawfWebViewStartupGate.kt'),'user-owned gate drift');
  if(kind==='activity')writeFileSync(f.main,current+'\n// user-owned drift\n');
  if(kind==='manifest')writeFileSync(f.manifest,readFileSync(f.manifest,'utf8').replace('android:exported="true"','android:name=".MainActivity" android:exported="true"'));
  if(kind==='version')writeFileSync(f.gradle,readFileSync(f.gradle,'utf8').replace('webkit:1.14.0','webkit:1.17.0'));
  if(kind==='duplicate')writeFileSync(f.gradle,readFileSync(f.gradle,'utf8').replace('    implementation("androidx.appcompat','    implementation("androidx.webkit:webkit:1.16.0")\n    implementation("androidx.appcompat'));
  const before=snapshot(f.root);assert.throws(()=>patcher.patchTauriAndroidProject({root:f.root}));assert.deepEqual(snapshot(f.root),before,kind);
 });
});
test('Android context changes only saved main create flag, while loop stays live and exact config is later built',()=>{
 const lib=readFileSync(new URL('../web/src-tauri/src/lib.rs',import.meta.url),'utf8');const rust=readFileSync(new URL('../web/src-tauri/src/android_startup.rs',import.meta.url),'utf8');assert.ok(lib.indexOf('android_startup::defer_main_window(&mut context)')<lib.indexOf('.build(context)'));assert.ok(lib.includes('tauri::RunEvent::Ready'));assert.ok(lib.includes('android_startup::start(app.clone(), config)'));assert.ok(lib.includes('exit_policy.exit_prevented()'));assert.ok(lib.includes('.run(tauri::generate_context!())'));assert.ok(rust.includes('let original = main.clone();'));assert.ok(rust.includes('main.create = false;'));assert.ok(rust.includes('WebviewWindowBuilder::from_config(&app, &config)'));assert.ok(rust.includes('receive_startup_event(&receiver, &pending, destroying, &mut destroy_retry)'));assert.doesNotMatch(rust,/thread::sleep|_exit|kill\(|get_webview_window.*unwrap|env\.find_class/);assert.ok(rust.includes('"getClassLoader"'));assert.ok(rust.includes('"loadClass"'));assert.ok(rust.includes('register_native_methods'));assert.ok(rust.includes('pending = Some((ticket, window));'));assert.ok(rust.includes('window.destroy()'));
});
test('private helper keeps one executor, current application context, native first draw/error/Back and real attachment acknowledgement',()=>{
 const s=readFileSync(new URL('./android/YawfWebViewStartup.kt',import.meta.url),'utf8');assert.equal((s.match(/newSingleThreadExecutor\(/g)||[]).length,1);assert.ok(s.includes('activity.applicationContext'));assert.ok(s.includes('WebViewOutcomeReceiver<WebViewStartUpResult, WebViewStartupException>'));assert.ok(s.includes('setShouldRunUiThreadStartUpTasks(true)'));assert.ok(s.includes('ViewTreeObserver.OnDrawListener'));assert.ok(s.includes('@Keep @JvmStatic private external fun nativeSignal(kind: Int, ticket: Long)'));assert.ok(s.includes('acceptedGate = gate'));assert.ok(s.includes('acceptedWebView = webView'));assert.ok(s.includes('acceptedWebView !== webView'));assert.ok(s.includes('constructionStored'));
 const hook=s.slice(s.indexOf('  fun onWebViewCreate('),s.indexOf('  @Keep @JvmStatic fun constructionStored'));assert.doesNotMatch(hook,/attachedTicket =|claimHandoff|signal\(ATTACHED/);
assert.ok(s.includes('gate.claimHandoff(ownerKey, gate.generation, now())'));assert.doesNotMatch(s,/JavascriptInterface|WebViewFeature|CookieManager|WebSettings|\bWebView\(|getCurrentWebViewPackage|Intent|SharedPreferences|Log\./);
});

test('generated updater foreground wiring preserves native manual entry and revokes readiness before pause or destroy',()=>withFixture(f=>{
 patcher.patchTauriAndroidProject({root:f.root});const source=readFileSync(f.main,'utf8');
 const wiring=code=>{
  const hook=method(code,'onWebViewCreate'),resume=method(code,'onResume'),pause=method(code,'onPause'),destroy=method(code,'onDestroy');
  const ordered=(body,first,second)=>body.indexOf(first)>=0&&body.indexOf(second)>body.indexOf(first);
  return !hook.includes('androidUpdater.onResume()') && hook.includes('YawfAndroidUpdater.attach(this)') &&
   resume.includes('resumeAndroidUpdaterAfterStartup()') &&
   code.includes('if (!::androidUpdater.isInitialized || androidUpdaterResumed || !YawfWebViewStartup.isUpdaterReady(this)) return') &&
   code.includes('androidUpdaterResumed = true\n    androidUpdater.onResume()') &&
   code.includes('androidUpdaterResumed = false\n    if (::androidUpdater.isInitialized) androidUpdater.onPause()') &&
   ordered(pause,'YawfWebViewStartup.onPause(this)','pauseAndroidUpdaterAfterStartup()') &&
   ordered(pause,'pauseAndroidUpdaterAfterStartup()','super.onPause()') &&
   ordered(destroy,'YawfWebViewStartup.onDestroy(this)','androidUpdater.onDestroy()') &&
   code.includes('runOnUiThread { if (::androidUpdater.isInitialized) androidUpdater.checkManually() }') &&
   code.includes('YawfWebViewStartup.onOwnedWebViewDestroy(this, webView)\n    pauseAndroidUpdaterAfterStartup()\n    super.onOwnedWebViewDestroy(webView)');
 };
 assert.equal(wiring(source),true);
 for(const [before,after]of [
  ['!YawfWebViewStartup.isUpdaterReady(this)','false'],
  ['androidUpdaterResumed = true\n    androidUpdater.onResume()','androidUpdater.onResume()'],
  ['YawfWebViewStartup.onPause(this)','Unit'],
  ['YawfWebViewStartup.onDestroy(this)','Unit'],
  ['androidUpdater.checkManually()','Unit'],
 ]){assert.equal(source.split(before).length,2);assert.equal(wiring(source.replace(before,after)),false);}
}));

test('only exact prior committed-updater helper migrates and remains idempotent',()=>withFixture(f=>{
 const currentHelper=readFileSync(new URL('./android/YawfWebViewStartup.kt',import.meta.url),'utf8');
 const start=currentHelper.indexOf('  fun isUpdaterReady('),end=currentHelper.indexOf('  fun onWebViewCreate(',start);
 assert.ok(start>0&&end>start);
 let previous=currentHelper.slice(0,start)+currentHelper.slice(end);
 const commitStart=previous.indexOf('  @Keep @JvmStatic fun constructionCommitted('),commitEnd=previous.indexOf('  fun onOwnedWebViewDestroy(',commitStart);
 assert.ok(commitStart>0&&commitEnd>commitStart);previous=previous.slice(0,commitStart)+previous.slice(commitEnd);
 for(const addition of [
  '  private var storedWebView: WeakReference<WebView>? = null\n',
  '  private var acknowledgedWebView: WeakReference<WebView>? = null\n',
  '  private var processCommittedTicket = 0L\n',
  '    storedWebView = null\n', '    acknowledgedWebView = null\n',
  '    acknowledgedWebView = acceptedWebView?.let { WeakReference(it) }\n',
  '    if (owns(activity) && storedWebView?.get() === webView) storedWebView = null\n',
  '    if (owns(activity) && acknowledgedWebView?.get() === webView) acknowledgedWebView = null\n',
 ]){assert.ok(previous.includes(addition));previous=previous.replaceAll(addition,'');}
 assert.equal(createHash('sha256').update(previous).digest('hex'),'e1f383b14b0efb28316c2b61f9a8e40a6b103a026f35e85f9dac984f209f73a6','fixture reconstructs exact former source, not an accepted approximation');
 const helper=join(f.java,'YawfWebViewStartup.kt');writeFileSync(helper,previous);
 assert.equal(patcher.patchTauriAndroidProject({root:f.root}).changed,true);assert.equal(readFileSync(helper,'utf8'),currentHelper);
 assert.equal(patcher.patchTauriAndroidProject({root:f.root}).changed,false);
 writeFileSync(helper,previous+'\n// unrecognized change\n');const before=snapshot(f.root);
 assert.throws(()=>patcher.patchTauriAndroidProject({root:f.root}));assert.deepEqual(snapshot(f.root),before);
},accepted.at(-1)));
