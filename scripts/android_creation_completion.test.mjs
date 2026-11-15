import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {originalRecv,patchedRecv,originalPlugin,patchedPlugin,creationFeature,checkAndroidCreationVendor} from './check_android_creation_vendor.mjs';
const root=new URL('../',import.meta.url),runtime=readFileSync(new URL('web/src-tauri/vendor/wry/src/android/main_pipe.rs',root),'utf8');
const app=readFileSync(new URL('web/src-tauri/src/android_startup.rs',root),'utf8');
const work=mkdtempSync(join(tmpdir(),'yawf-creation-proof-'));after(()=>rmSync(work,{recursive:true,force:true}));
function block(text,start,end){const a=text.indexOf(start),b=text.indexOf(end,a);assert.ok(a>=0&&b>a);return text.slice(a,b);}
const recv=block(runtime,'  pub fn recv(&mut self)','\n  fn handle_message(');
const create=block(runtime,'      WebViewMessage::CreateWebView(attrs) => {','      WebViewMessage::Eval(');
const jni=block(runtime,'      WebViewMessage::Jni(f) => {','      WebViewMessage::LoadUrl(');
const callback=block(app,'        platform.jni_handle().exec(move |env, _activity, webview| {','        });').split('\n').slice(1).join('\n');
const destroy=block(app,'fn destroy_pending(', '\nfn clear(');
const bins=new Map();
function build({feature=true,android=true,oldRecv=false,oldPlugin=false,weakIdentity=false}={}) {
 const key=[feature,android,oldRecv,oldPlugin,weakIdentity].join('-');if(bins.has(key))return bins.get(key);
 const source=String.raw`
#![allow(dead_code,unused_imports,unused_variables)]
use std::{collections::{BTreeMap,VecDeque},sync::{Mutex,OnceLock,atomic::{AtomicBool,AtomicI64,Ordering},mpsc}};
type Result<T> = std::result::Result<T,&'static str>;type JniResult<T> = Result<T>;
static FAIL:OnceLock<String>=OnceLock::new();static NEXT:AtomicI64=AtomicI64::new(100);static ACCEPTED:AtomicI64=AtomicI64::new(0);static OWNER:AtomicBool=AtomicBool::new(true);
static FATAL:AtomicI64=AtomicI64::new(0);static DESTROY_BLOCKED:AtomicBool=AtomicBool::new(false);
static RETRY:AtomicBool=AtomicBool::new(false);static DESTROYS:AtomicI64=AtomicI64::new(0);
static PROOFS:AtomicI64=AtomicI64::new(0);static CLEARS:AtomicI64=AtomicI64::new(0);static COMMITS:AtomicI64=AtomicI64::new(0);
static COMMITTED:AtomicBool=AtomicBool::new(false);static CONSTRUCTION:AtomicI64=AtomicI64::new(1);const ATTACHED:i32=3;const CREATION_FAILED:i32=7;
static EVENTS:OnceLock<mpsc::Sender<(i32,i64)>>=OnceLock::new();struct AppHandle;fn bootstrap_failed(_: &AppHandle){FATAL.fetch_add(1,Ordering::SeqCst);}
#[derive(Clone,Debug)]struct JObject {id:i64,name:String}impl JObject {fn null()->Self{Self{id:0,name:String::new()}}fn is_null(&self)->bool{self.id==0}fn as_obj(&self)->&Self{self}}
type GlobalRef=JObject;type JString=JObject;
enum JValue<'a>{Object(&'a JObject),Long(i64),Bool(bool)}impl<'a>From<&'a JObject>for JValue<'a>{fn from(v:&'a JObject)->Self{Self::Object(v)}}impl From<bool>for JValue<'_>{fn from(v:bool)->Self{Self::Bool(v)}}
struct Value{object:JObject,boolean:bool}impl Value{fn l(self)->Result<JObject>{Ok(self.object)}fn z(self)->Result<bool>{Ok(self.boolean)}}
struct Env{pending:bool}impl Env {
 fn fail(&mut self,stage:&str)->Result<()> {if !RETRY.load(Ordering::SeqCst)&&FAIL.get().unwrap()==stage{self.pending=true;Err("injected JNI failure")}else{Ok(())}}
 fn exception_check(&self)->Result<bool>{Ok(self.pending)}fn exception_clear(&mut self)->Result<()>{self.pending=false;CLEARS.fetch_add(1,Ordering::SeqCst);Ok(())}
 fn find_class(&mut self,s:&str)->Result<JObject>{Ok(JObject{id:1,name:s.into()})}
 fn new_string<T:AsRef<str>>(&self,s:T)->Result<JObject>{Ok(JObject{id:1,name:s.as_ref().into()})}
 fn new_object_array(&self,_:i32,_:JObject,_:JObject)->Result<JObject>{Ok(JObject::null())}
 fn set_object_array_element(&self,_:&JObject,_:i32,_:JObject)->Result<()>{Ok(())}
 fn new_object<S:AsRef<str>,C:std::borrow::Borrow<JObject>>(&mut self,class:C,_:S,_:&[JValue])->Result<JObject>{let class:&JObject=class.borrow();let id=if class.name.ends_with("/RustWebView"){NEXT.fetch_add(1,Ordering::SeqCst)}else{1};Ok(JObject{id,name:class.name.clone()})}
 fn call_method<S:AsRef<str>>(&mut self,_:&JObject,name:&str,_:S,args:&[JValue])->Result<Value>{
  if name=="setWebView"{if let JValue::Object(v)=&args[0]{ACCEPTED.store(v.id,Ordering::SeqCst)}}
  let stage=match name{"setWebViewClient"|"setWebChromeClient"=>"client","addJavascriptInterface"=>"ipc","setContentView"=>"content",_=>"other"};self.fail(stage)?;
  Ok(Value{object:JObject::null(),boolean:false})
 }
 fn call_static_method(&mut self,_:&JObject,_:&str,_:&str,_:&[JValue])->Result<Value>{Ok(Value{object:JObject::null(),boolean:false})}
 fn new_global_ref(&mut self,v:JObject)->Result<JObject>{self.fail("globalref")?;Ok(v)}
}
fn call(env:&mut Env,_:&GlobalRef,method:&str,signature:&str,args:&[JValue])->Result<Value>{
 assert_eq!(method,"constructionStored");assert_eq!(signature,"(JLandroid/webkit/WebView;)Z");if !RETRY.load(Ordering::SeqCst)&&FAIL.get().unwrap()=="proof"{env.pending=true;env.exception_clear()?;return Err("callback JNI error");}
 let JValue::Long(ticket)=args[0]else{panic!()};let JValue::Object(view)=args[1]else{panic!()};
 let exact=IDENTITY;
 let good=ticket==CONSTRUCTION.load(Ordering::SeqCst)&&!view.is_null()&&exact&&OWNER.load(Ordering::SeqCst)&&!COMMITTED.load(Ordering::SeqCst);
 if good{COMMITS.fetch_add(1,Ordering::SeqCst);}Ok(Value{object:JObject::null(),boolean:good})
}
#[derive(Clone)]struct ActivityProxy{activity:GlobalRef,webview:Option<GlobalRef>}
static ACTIVITY_PROXY:Mutex<BTreeMap<i32,ActivityProxy>>=Mutex::new(BTreeMap::new());fn activity_proxy(id:i32)->Option<ActivityProxy>{ACTIVITY_PROXY.lock().unwrap().get(&id).cloned()}
struct Script{script:String}struct CreateWebViewAttributes{url:Option<String>,html:Option<String>,devtools:bool,transparent:bool,background_color:Option<(u8,u8,u8,u8)>,headers:Option<()>,on_webview_created:Option<fn(Context)->Result<()>>,autoplay:bool,user_agent:Option<String>,initialization_scripts:Vec<Script>,id:String,javascript_disabled:bool}
struct WebviewWindow;impl WebviewWindow{fn destroy(&self)->Result<()>{DESTROYS.fetch_add(1,Ordering::SeqCst);if DESTROY_BLOCKED.load(Ordering::SeqCst){Err("unconfirmed owned destroy")}else{Ok(())}}}
DESTROY
struct Context<'a>{env:&'a mut Env,activity:&'a JObject,webview:&'a JObject}
fn find_class(_:&mut Env,_:&JObject,name:String)->Result<JObject>{Ok(JObject{id:1,name})}
fn load_url(env:&mut Env,_:&JObject,_:&JObject,_:Option<()>,_:bool)->Result<()>{if FAIL.get().unwrap()=="owner-loss"{OWNER.store(false,Ordering::SeqCst);}env.fail("load")}
fn load_html(env:&mut Env,_:&JObject,_:&JObject)->Result<()>{env.fail("load")}
fn set_background_color(_:&mut Env,_:&JObject,_:(u8,u8,u8,u8))->Result<()>{Ok(())}
enum WebViewMessage{CreateWebView(CreateWebViewAttributes),Jni(Box<dyn FnOnce(&mut Env,&JObject,&JObject)+Send>),Other}
static QUEUE:Mutex<VecDeque<(i32,WebViewMessage)>>=Mutex::new(VecDeque::new());struct Rx;impl Rx{fn try_recv(&self)->Result<(i32,WebViewMessage)>{QUEUE.lock().unwrap().pop_front().ok_or("empty")}}static CHANNEL:((),Rx)=((),Rx);static PACKAGE:OnceLock<&str>=OnceLock::new();
mod pipe {use super::*;pub struct MainPipe{pub env:Env}impl MainPipe {
RECV
fn handle_message(&mut self,package:&str,activity_id:i32,message:WebViewMessage)->JniResult<()>{match message{
CREATE
JNI
WebViewMessage::Other=>{self.env.pending=true;return Err("non-create");}
}Ok(())}
}}
fn attrs()->CreateWebViewAttributes{CreateWebViewAttributes{url:Some("synthetic".into()),html:None,devtools:false,transparent:false,background_color:None,headers:None,on_webview_created:Some(|_|if !RETRY.load(Ordering::SeqCst)&&FAIL.get().unwrap()=="plugin"{Err("non-JNI app/plugin error")}else{Ok(())}),autoplay:true,user_agent:None,initialization_scripts:vec![],id:"owned".into(),javascript_disabled:false}}
fn enqueue_proof(ticket:i64){let helper=JObject::null();let exit_app=AppHandle;QUEUE.lock().unwrap().push_back((1,WebViewMessage::Jni(Box::new(move|env,_activity,webview|{
PROOFS.fetch_add(1,Ordering::SeqCst);
CALLBACK
}))));}
fn main(){let scenario=std::env::args().nth(1).unwrap();FAIL.set(if scenario=="quarantine"{"client".into()}else{scenario.clone()}).unwrap();DESTROY_BLOCKED.store(scenario=="quarantine",Ordering::SeqCst);PACKAGE.set("test").unwrap();let(tx,rx)=mpsc::channel();EVENTS.set(tx).unwrap();
 let old=if scenario=="null"{None}else{Some(JObject{id:7,name:"retained old object".into()})};
 ACTIVITY_PROXY.lock().unwrap().insert(1,ActivityProxy{activity:JObject{id:1,name:"Activity".into()},webview:old});
 if scenario=="dispatch-failure"{drop(rx);QUEUE.lock().unwrap().push_back((1,WebViewMessage::CreateWebView(attrs())));enqueue_proof(1);let mut pipe=pipe::MainPipe{env:Env{pending:false}};assert!(pipe.recv().is_ok());assert!(!COMMITTED.load(Ordering::SeqCst));assert_eq!(FATAL.load(Ordering::SeqCst),1,"dead worker forces explicit fatal exit rather than false COMMITTED");return;}
 if scenario=="non-create"{QUEUE.lock().unwrap().push_back((1,WebViewMessage::Other));}else if scenario!="null"{QUEUE.lock().unwrap().push_back((1,WebViewMessage::CreateWebView(attrs())));}
 enqueue_proof(1);let mut pipe=pipe::MainPipe{env:Env{pending:false}};let result=pipe.recv();
 let opted=cfg!(all(test_android,feature="android-app-create-webview-completion"));let jni_failure=["load","client","ipc","content","globalref","quarantine"].contains(&scenario.as_str());
 if scenario=="non-create"||(!opted&&jni_failure){assert!(result.is_err());assert_eq!(PROOFS.load(Ordering::SeqCst),0);assert!(pipe.env.pending);assert_eq!(CLEARS.load(Ordering::SeqCst),0);}
 else{assert!(result.is_ok(),"opted-in Create error must keep pipe registered");assert_eq!(PROOFS.load(Ordering::SeqCst),1,"post-create queued JNI must execute");
  let succeeds=scenario=="success"||(!opted&&scenario=="plugin");assert_eq!(COMMITTED.load(Ordering::SeqCst),succeeds,"only stored exact accepted object commits");assert_eq!(COMMITS.load(Ordering::SeqCst),i64::from(succeeds));
  if jni_failure{assert_eq!(CLEARS.load(Ordering::SeqCst),1);assert!(!pipe.env.pending);}if scenario=="plugin"{assert_eq!(CLEARS.load(Ordering::SeqCst),0,"non-JNI plugin Err invents no Java exception");}
  let events:Vec<_>=rx.try_iter().collect();assert_eq!(events,vec![(if succeeds{ATTACHED}else{CREATION_FAILED},1)]);
  if succeeds {
   enqueue_proof(1);assert!(pipe.recv().is_ok());assert_eq!(COMMITS.load(Ordering::SeqCst),1,"duplicate completion cannot commit twice");
  } else if jni_failure||scenario=="plugin"||scenario=="proof" {
   let mut pending=Some((1,WebviewWindow));let mut destroying=None;
   destroy_pending(&mut pending,&mut destroying);
   if DESTROY_BLOCKED.load(Ordering::SeqCst){assert!(pending.is_some());assert!(destroying.is_none());assert!(!COMMITTED.load(Ordering::SeqCst));assert_eq!(NEXT.load(Ordering::SeqCst),101,"no second constructor while destroy is unconfirmed");return;}
   destroy_pending(&mut pending,&mut destroying);
   assert_eq!(DESTROYS.load(Ordering::SeqCst),1);assert_eq!(destroying,Some(1));assert!(pending.is_some(),"quarantine remains until actual destroy acknowledgement");
   // Fake owned destruction acknowledgement/manual Retry; the actual Kotlin
   // coordinator separately executes the gate, disabled Retry and explicit input.
   pending=None;destroying=None;assert!(pending.is_none()&&destroying.is_none());
   ACCEPTED.store(0,Ordering::SeqCst);CONSTRUCTION.store(2,Ordering::SeqCst);RETRY.store(true,Ordering::SeqCst);
   QUEUE.lock().unwrap().push_back((1,WebViewMessage::CreateWebView(attrs())));enqueue_proof(2);
   assert!(pipe.recv().is_ok());assert!(COMMITTED.load(Ordering::SeqCst));assert_eq!(COMMITS.load(Ordering::SeqCst),1);
   assert_eq!(rx.try_iter().collect::<Vec<_>>(),vec![(ATTACHED,2)]);
  }
 }
 println!("actual-full-create-and-recv-proof passed: {}",scenario);
}
`;
 let text=source.replace('IDENTITY',weakIdentity?'true':'view.id==ACCEPTED.load(Ordering::SeqCst)')
  .replace('RECV',(oldRecv?recv.replace(patchedRecv,originalRecv):recv).replaceAll('target_os = "android"','test_android'))
  .replace('CREATE',(oldPlugin?create.replace(patchedPlugin,originalPlugin):create).replaceAll('target_os = "android"','test_android'))
  .replace('\nJNI\n','\n'+jni+'\n').replace('CALLBACK',callback).replace('\nDESTROY\n','\n'+destroy+'\n');
 const file=join(work,key+'.rs'),binary=join(work,key);writeFileSync(file,text);
 const args=['--edition','2021','--crate-name','creation_path','-o',binary,file];if(android)args.push('--cfg','test_android');if(feature)args.push('--cfg',`feature="${creationFeature}"`);
 const result=spawnSync(process.env.RUSTC||'/opt/homebrew/bin/rustc',args,{encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);bins.set(key,binary);return binary;
}
function run(config,scenario){return spawnSync(build(config),[scenario],{encoding:'utf8',timeout:5000});}
test('Wry creation vendor entire official inventory and exact Android opt-in delta pinned',()=>assert.equal(checkAndroidCreationVendor().files,84));
for(const scenario of ['success','load','client','ipc','content','plugin','globalref','null','owner-loss','non-create','quarantine','dispatch-failure','proof'])test(`actual entire Wry CreateWebView/recv plus app FIFO callback: ${scenario}`,()=>{const r=run({},scenario);assert.equal(r.status,0,r.stdout+r.stderr);});
for(const config of [{feature:false},{android:false}])for(const scenario of ['success','load','plugin','non-create'])test(`original behavior controls ${JSON.stringify(config)}: ${scenario}`,()=>{const r=run(config,scenario);assert.equal(r.status,0,r.stdout+r.stderr);});
for(const [name,config,scenario]of [['original recv poisons queued post-storage callback',{oldRecv:true},'load'],['original non-JNI plugin swallow falsely stores and commits',{oldPlugin:true},'plugin'],['nonnull old globalref cannot replace exact identity',{weakIdentity:true},'client']])test(`individual causal creation revert: ${name}`,()=>{const r=run(config,scenario);assert.notEqual(r.status,0);assert.match(r.stderr,/panicked/);});
