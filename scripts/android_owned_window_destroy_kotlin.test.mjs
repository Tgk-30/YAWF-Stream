import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {basename,delimiter,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

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

const work=mkdtempSync(join(process.env.TMPDIR||tmpdir(),'yawf-owned-template-'));
after(()=>rmSync(work,{recursive:true,force:true}));
const root=fileURLToPath(new URL('../',import.meta.url));
const template=readFileSync(join(root,'web/src-tauri/vendor/wry/src/android/owned/WryActivity.kt'),'utf8');
const compiled=new Map();
const stubs={
'annotation.kt':`package android.annotation
annotation class SuppressLint(vararg val value: String)
`,
'content.kt':`package android.content
open class Context
class Intent { var extras: android.os.Bundle? = null; constructor(); constructor(c: Context, cls: Class<*>); fun putExtra(k: String,v: Int){} }
`,
'os.kt':`package android.os
class Bundle { fun getInt(k:String)=0; fun putInt(k:String,v:Int){} }
object Build { object VERSION { const val SDK_INT=36 }; object VERSION_CODES { const val O=26; const val N=24 } }
class Looper { companion object { private val main=Looper();fun myLooper()=main;fun getMainLooper()=main } }
`,
'view.kt':`package android.view
import android.content.Context
open class View(val context:Context){var parent:Any?=null}
open class ViewGroup(c:Context):View(c){fun removeView(v:View){check(v.parent===this);v.parent=null}}
`,
'webview.kt':`package android.webkit
open class WebView(c:android.content.Context):android.view.View(c){var destroyed=0;var pauses=0;var resumes=0;var failDestroy=false
 fun canGoBack()=false;fun goBack(){};fun onPause(){pauses++};fun onResume(){resumes++};fun destroy(){check(!failDestroy){"destroy failure"};destroyed++}
 companion object {fun getCurrentWebViewPackage():Info?=Info()};class Info{val versionName="public"}
}
`,
'back.kt':`package androidx.activity
open class OnBackPressedCallback(var isEnabled:Boolean){var removed=false;open fun handleOnBackPressed(){};fun remove(){removed=true;isEnabled=false}}
class OnBackPressedDispatcher {val callbacks=mutableListOf<OnBackPressedCallback>();fun active()=callbacks.count{it.isEnabled&&!it.removed};fun addCallback(owner:Any,cb:OnBackPressedCallback){callbacks.add(cb)};fun dispatch(fallback:()->Unit){val current=callbacks.lastOrNull{it.isEnabled&&!it.removed};if(current==null)fallback()else current.handleOnBackPressed()} }
`,
'results.kt':`package androidx.activity.result
class ActivityResult
class ActivityResultLauncher<I>{fun launch(value:I){}}
`,
'contracts.kt':`package androidx.activity.result.contract
open class ActivityResultContract<I,O>
object ActivityResultContracts {
 class RequestMultiplePermissions:ActivityResultContract<Array<String>,Map<String,Boolean>>()
 class StartActivityForResult:ActivityResultContract<android.content.Intent,androidx.activity.result.ActivityResult>()
}
`,
'appcompat.kt':`package androidx.appcompat.app
import android.content.Intent
import android.os.Bundle
open class AppCompatActivity:android.content.Context(){
 val onBackPressedDispatcher=androidx.activity.OnBackPressedDispatcher();val intent=Intent();val packageManager=PackageManager()
 open fun onCreate(b:Bundle?){};open fun onStart(){};open fun onWindowFocusChanged(v:Boolean){};open fun onSaveInstanceState(b:Bundle){};open fun onPause(){};open fun onResume(){};open fun onStop(){};open fun onDestroy(){};open fun onLowMemory(){};open fun onNewIntent(i:Intent){};var backs=0;fun onBackPressed(){onBackPressedDispatcher.dispatch{backs++}};fun startActivity(i:Intent){}
 fun <I,O> registerForActivityResult(c:androidx.activity.result.contract.ActivityResultContract<I,O>,f:(O)->Unit)=androidx.activity.result.ActivityResultLauncher<I>()
}
class PackageManager{fun getPackageInfo(name:String,flags:Int)=Info()};class Info{val versionName="public"}
`,
'lifecycle.kt':`package androidx.lifecycle
interface LifecycleOwner
interface DefaultLifecycleObserver{fun onCreate(owner:LifecycleOwner){}}
class Lifecycle{fun addObserver(v:Any){}}
class ProcessLifecycleOwner{val lifecycle=Lifecycle();companion object{fun get()=ProcessLifecycleOwner()}}
`,
'owned.kt':`package com.tgk30.debridstreamer
import android.webkit.WebView
class RustWebView(c:android.content.Context):WebView(c){val id="owned"}
object Logger{fun warn(s:String){}}
object Rust {
 var destroyedId="unset"
 fun onFirstActivityCreate(){};fun onFirstActivityCreateWry(){};fun onCreate(a:Any){};fun onStart(a:Any){};fun onWindowFocusChanged(a:Any,b:Boolean){};fun onPause(a:Any){};fun onResume(a:Any){};fun onStop(a:Any){};fun onDestroy(a:Any){};fun onWebviewDestroy(a:Any,id:String){destroyedId=id};fun onLowMemory(){};fun onNewIntent(i:Any){}
}
class Owned:WryActivity(){
 var accepted:WebView?=null;var refuse=false;var failHook=false;var hookCount=0
 var storedHooks=0;var failStored=false
 override fun onWebViewCreate(webView:WebView){check(!refuse){"pre-hook refusal"};accepted=webView}
 override fun onOwnedWebViewStored(webView:WebView){
  check(!isOwnedWebViewStored(webView)){"receipt cannot precede successful hook return"}
  check(accepted===webView){"only exact assigned object reaches stored hook"}
  storedHooks++;check(!failStored){"injected stored hook failure"}
 }
 override fun onOwnedWebViewDestroy(webView:WebView){
  check(webView.parent==null){"detach before app cleanup"}
  val prior=(webView as RustWebView).pauses;onPause();check(webView.pauses==prior){"mWebView must be cleared before app hook"}
  check(!failHook){"cleanup hook failure"};if(accepted===webView)accepted=null;hookCount++
 }
}
fun main(args:Array<String>){
 val scenario=args.single();val a=Owned();val v=RustWebView(a);val parent=android.view.ViewGroup(a)
 if(scenario=="pre-hook")a.refuse=true
 if(scenario!="unassigned"&&scenario!="unassigned-mounted"){try{a.setWebView(v)}catch(e:IllegalStateException){check(scenario=="pre-hook")};v.parent=parent}
 if(scenario.startsWith("stored-")){
  check(!a.isOwnedWebViewStored(v)){"assignment is not storage"}
  if(scenario=="stored-foreign"){
   val foreign=RustWebView(a);a.notifyOwnedWebViewStored(foreign);check(a.storedHooks==0);check(!a.isOwnedWebViewStored(foreign));check(!a.isOwnedWebViewStored(v));return
  }
  if(scenario=="stored-hook-failure"){
   a.failStored=true;var failed=false;try{a.notifyOwnedWebViewStored(v)}catch(e:IllegalStateException){failed=true}
   check(failed&&a.storedHooks==1);check(!a.isOwnedWebViewStored(v)){"throwing observer never publishes readiness"}
   failed=false;try{a.notifyOwnedWebViewStored(v)}catch(e:IllegalStateException){failed=true}
   check(failed&&a.storedHooks==2);check(!a.isOwnedWebViewStored(v)){"duplicate failed observer remains unavailable"};return
  }
  a.notifyOwnedWebViewStored(v);check(a.isOwnedWebViewStored(v));check(a.storedHooks==1)
  a.notifyOwnedWebViewStored(v);check(a.storedHooks==1){"duplicate notification is inert"}
  check(a.destroyOwnedWebView(v,true));check(!a.isOwnedWebViewStored(v)){"exact cleanup revokes storage receipt"}
  val next=RustWebView(a);a.setWebView(next);check(!a.isOwnedWebViewStored(next));a.notifyOwnedWebViewStored(v);check(a.storedHooks==1)
  a.notifyOwnedWebViewStored(next);check(a.isOwnedWebViewStored(next));check(a.storedHooks==2);return
 }
 if(scenario=="foreign"){
  val foreign=RustWebView(a);check(!a.destroyOwnedWebView(foreign,true));check(foreign.destroyed==0);check(v.destroyed==0);check(v.parent===parent);check(a.accepted===v);check(a.onBackPressedDispatcher.active()==1){"foreign target cannot remove healthy Back callback"};return
 }
 if(scenario=="unassigned-mounted"){v.parent=parent;check(!a.destroyOwnedWebView(v,false));check(v.destroyed==0);check(v.parent===parent);return}
 if(scenario=="hook-error"||scenario=="destroy-error"){
  a.failHook=scenario=="hook-error";v.failDestroy=scenario=="destroy-error"
  var failed=false;try{a.destroyOwnedWebView(v,true)}catch(e:IllegalStateException){failed=true};check(failed){"cleanup errors cannot acknowledge"};check(v.destroyed==0);if(scenario=="destroy-error"){v.failDestroy=false;check(!a.destroyOwnedWebView(v,true)){"cleared field after failed destroy is not a positive ack"};check(v.destroyed==0)};return
 }
 check(a.destroyOwnedWebView(v,scenario!="unassigned"));check(v.parent==null);check(v.destroyed==1);check(a.accepted==null);check(a.hookCount==1)
 check(a.onBackPressedDispatcher.active()==0){"owned Back callback removed before retry"};a.onBackPressed();check(a.backs==1){"Back falls through after exact cleanup"};
 a.onPause();a.onResume();check(v.pauses==0&&v.resumes==0){"lifecycle no longer retains destroyed view"};a.onDestroy();check(Rust.destroyedId=="")
 check(a.destroyOwnedWebView(v,true));check(v.destroyed==1){"exact disposed acknowledgement cannot destroy twice"}
 a.refuse=false;val next=RustWebView(a);a.setWebView(next);check(a.destroyOwnedWebView(v,true));check(a.accepted===next);check(next.destroyed==0){"disposed old object never clears newer owner"};check(a.onBackPressedDispatcher.active()==1){"same-Activity retry has exactly one active Back callback"}
}
`,
};
function compile(t,mutation='none') {
 const tools=toolchain(t);if(!tools)return null;
 if(compiled.has(mutation))return {...tools,output:compiled.get(mutation)};
 const dir=join(work,mutation);mkdirSync(dir);
 let text=template.replaceAll('{{package}}','com.tgk30.debridstreamer').replace('{{class-extension}}','');
 if(mutation==='retained-mWebView')text=text.replace('            mWebView = null','            // unsafe retained owner');
 if(mutation==='no-detach')text=text.replace('            parent.removeView(target)','            // unsafe attached object').replace('            if (target.parent != null) return false','');
 if(mutation==='premature-disposed-ack')text=text.replace('        target.destroy()\n        mOwnedDisposed = WeakReference(target)', '        mOwnedDisposed = WeakReference(target)\n        target.destroy()');
 if(mutation==='retained-back-callback')text=text.replace('            mOwnedBackCallback?.remove()\n            mOwnedBackCallback = null','');
 if(mutation==='foreign-object')text=text.replace('            if (mWebView !== target) return false','');
 if(mutation==='stored-foreign')text=text.replace('mWebView !== webView || mStoredWebView?.get() === webView','mStoredWebView?.get() === webView');
 if(mutation==='stored-duplicate')text=text.replace('mWebView !== webView || mStoredWebView?.get() === webView','mWebView !== webView');
 if(mutation==='stored-premature')text=text.replace('        onOwnedWebViewStored(webView)','        mStoredWebView = WeakReference(webView)\n        onOwnedWebViewStored(webView)');
 const files=[];for(const [name,body]of Object.entries({...stubs,'WryActivity.kt':text})){const p=join(dir,name);writeFileSync(p,body);files.push(p);}
 const output=join(dir,'template.jar');
 const r=spawnSync(tools.java,[`-Djava.io.tmpdir=${work}`,'-cp',tools.runtime,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[tools.stdlib,tools.annotations].join(delimiter),'-d',output,...files],{encoding:'utf8',timeout:60000});
 assert.equal(r.status,0,r.stdout+r.stderr);compiled.set(mutation,output);return {...tools,output};
}
function run(tools,scenario){return spawnSync(tools.java,[`-Djava.io.tmpdir=${work}`,'-cp',[tools.output,tools.stdlib].join(delimiter),'com.tgk30.debridstreamer.OwnedKt',scenario],{encoding:'utf8',timeout:10000});}
for(const scenario of ['success','pre-hook','unassigned','foreign','unassigned-mounted','hook-error','destroy-error'])test(`actual alternate WryActivity exact-object cleanup: ${scenario}`,t=>{const c=compile(t);if(!c)return;const r=run(c,scenario);assert.equal(r.status,0,r.stdout+r.stderr);});
for(const [mutation,scenario]of [['retained-mWebView','success'],['no-detach','success'],['foreign-object','foreign'],['premature-disposed-ack','destroy-error'],['retained-back-callback','success']])test(`compiled Kotlin cleanup mutant fails behavior: ${mutation}`,t=>{const c=compile(t,mutation);if(!c)return;const r=run(c,scenario);assert.notEqual(r.status,0);assert.match(r.stderr,/IllegalStateException/);});
for(const [scenario,mutation]of [['stored-success','stored-duplicate'],['stored-foreign','stored-foreign'],['stored-hook-failure','stored-premature']])test(`actual Wry storage notification and individual causal mutant: ${scenario}`,t=>{
 const original=compile(t);if(!original)return;const positive=run(original,scenario);assert.equal(positive.status,0,positive.stdout+positive.stderr);
 const changed=compile(t,mutation);const negative=run(changed,scenario);assert.equal(negative.signal,null);assert.equal(negative.status,1);assert.match(negative.stderr,/IllegalStateException/);
});
