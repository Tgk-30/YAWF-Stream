import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const root = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
const pipe = read('web/src-tauri/vendor/wry/src/android/main_pipe.rs');
const runtime = read('web/src-tauri/vendor/tauri-runtime-wry/src/lib.rs');
const android = read('web/src-tauri/vendor/wry/src/android/mod.rs');
const app = read('web/src-tauri/src/android_startup.rs');
const feature = 'android-app-owned-window-destroy';
const work = mkdtempSync(join(tmpdir(), 'yawf-owned-destroy-'));
after(() => rmSync(work, {recursive:true, force:true}));
function between(s, a, b) { const i=s.indexOf(a),j=s.indexOf(b,i);assert.ok(i>=0&&j>i,a);return s.slice(i,j); }
const platform = s => s.replaceAll('target_os = "android"', 'test_android');
const request = between(runtime, 'fn request_android_owned_destroy', '\n#[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]\nfn complete_android_owned_destroy');
const completion = between(runtime, 'fn complete_android_owned_destroy', '\nfn on_window_close(');
const destroy = between(pipe, '  fn on_owned_activity_destroy(', '\n  fn handle_message(');
const uiArm = between(pipe, '      WebViewMessage::DestroyOwned {', '      WebViewMessage::Eval(');
const bindingSource=read('web/src-tauri/vendor/wry/src/android/binding.rs');
const binding=between(bindingSource,'pub unsafe fn onWebviewDestroy(', '\n#[allow(non_snake_case)]\npub unsafe fn handleRequest(').replaceAll('JNIEnv','Env');
const onDestroyArm=between(pipe,'      WebViewMessage::OnDestroy {','\n    }\n    Ok(())\n  }\n}');
const oldMapCleanup=between(android,'pub fn destroy_webview(', '\n#[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]');
const handlers = between(android, 'fn destroy_owned_handlers(', '\n/// Sets up the necessary logic');
// Reuse only the explicit JNI scaffold, not its fake destruction ack/main.
const scaffold = /const source=String.raw`([\s\S]*?)`;/.exec(read('scripts/android_creation_completion.test.mjs'))[1];
const create = between(pipe, '      WebViewMessage::CreateWebView(attrs) => {', '      #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]\n      WebViewMessage::DestroyOwned');
const storedNotification = between(create, '        #[cfg(all(\n          target_os = "android",\n          feature = "android-app-owned-window-destroy",\n          feature = "android-app-create-webview-completion"\n        ))]', '        #[cfg(not(all(target_os = "android", feature = "android-app-owned-window-destroy")))]');
const recv = between(pipe, '  pub fn recv(&mut self)', '\n  #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]\n  fn on_owned_activity_destroy');
const jni = between(pipe, '      WebViewMessage::Jni(f) => {', '      WebViewMessage::LoadUrl(');
const callback = between(app, '        platform.jni_handle().exec(move |env, _activity, webview| {', '        });').split('\n').slice(1).join('\n');
const callBody = between(app, '    let result = env.call_static_method(helper, method, signature, args);', '\n}\n\nfn connect_helper');

// Execute Tauri's unchanged manager cleanup method, not a substitute label ack.
// The cached public crate is already required by the preceding real Cargo CI step.
const cargo=process.env.CARGO_HOME||join(homedir(),'.cargo');
const registry=join(cargo,'registry/src');
const tauriPath=readdirSync(registry).map(name=>join(registry,name,'tauri-2.12.4/src/manager/mod.rs')).find(p=>{try{return readFileSync(p).length>0;}catch{return false;}});
assert.ok(tauriPath,'exact cached public Tauri2.12.4 manager source required');
const tauriManager=between(readFileSync(tauriPath,'utf8'),'  pub(crate) fn on_window_close(&self, label: &str) {','\n  #[cfg(desktop)]\n  pub(crate) fn on_webview_close');

const notifyDestroyed=between(app,'pub(crate) fn window_destroyed(', '\n// Registered only');
const workerDestroyed=between(app,'                    DESTROYED => {', '                    _ => {}');
const workerClear=between(app,'fn clear(', '\nfn fail_and_clear(').replaceAll('JNIEnv','Env');
const binaries = new Map();
function compile(mutation='none') {
 if (binaries.has(mutation)) return binaries.get(mutation);
 let code=scaffold.slice(0,scaffold.indexOf('fn main(){'));
 code=code.replace('let exact=IDENTITY;', 'let exact=view.id==ACCEPTED.load(Ordering::SeqCst);');
 code=code.replace('RECV',recv).replace('CREATE',create).replace('\nJNI\n','\n#[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]\n'+uiArm+jni+onDestroyArm+'\n').replace('CALLBACK',callback).replace('CALL_HELPER',callBody).replace('\nDESTROY\n','\n');
 code=code.replace('WebViewMessage::Other=>{', '#[cfg(not(all(target_os = "android", feature = "android-app-owned-window-destroy")))] WebViewMessage::DestroyOwned{..}=>unreachable!("disabled control never enqueues owned cleanup"),WebViewMessage::Other=>{');
 code=code.replace('impl MainPipe {', 'impl MainPipe {pub(crate) fn send(id:i32,m:WebViewMessage){QUEUE.lock().unwrap().push_back((id,m));}pub(crate) fn try_send_owned(id:i32,m:WebViewMessage)->bool{QUEUE.lock().unwrap().push_back((id,m));true}');
 code=code.replace('fn handle_message(&mut self', '#[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]\n'+destroy.replaceAll('WebviewId','String')+'\nfn handle_message(&mut self');
 code=code.replace('struct ActivityProxy{activity:GlobalRef,webview:Option<GlobalRef>}', 'struct ActivityProxy{activity:GlobalRef,webview:Option<GlobalRef>,webview_id:Option<String>,webview_activity:Option<GlobalRef>,webview_generation:Option<u64>}');
 code=code.replace('id:String,javascript_disabled:bool}', 'id:String,javascript_disabled:bool,owned_generation:u64}').replace('id:"owned".into(),javascript_disabled:false}', 'id:"owned".into(),javascript_disabled:false,owned_generation:1}');
 code=code.replace('enum WebViewMessage{CreateWebView(CreateWebViewAttributes),', 'enum WebViewMessage{OnDestroy{activity_id:i32,webview_id:String,is_changing_configurations:bool,#[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]owned_activity:GlobalRef},DestroyOwned{webview_id:String,callback:Box<dyn FnOnce(bool)+Send>},CreateWebView(CreateWebViewAttributes),');
 code=code.replace('fn new_global_ref(&mut self,v:JObject)->Result<JObject>{self.fail("globalref")?;Ok(v)}', 'fn new_global_ref<V:std::borrow::Borrow<JObject>>(&mut self,v:V)->Result<JObject>{self.fail("globalref")?;Ok(v.borrow().clone())}\n fn is_same_object(&self,a:&JObject,b:&JObject)->Result<bool>{Ok(a.id==b.id)}');
 code=code.replace('fn call_method<S:AsRef<str>>(&mut self,_:&JObject,name:&str,_:S,args:&[JValue])->Result<Value>{', `fn call_method<S:AsRef<str>>(&mut self,owner:&JObject,name:&str,_:S,args:&[JValue])->Result<Value>{
 if name=="notifyOwnedWebViewStored" {
  assert!(PENDING_OWNED.try_lock().is_ok(),"notification cannot hold pending lock");
  let proxies=ACTIVITY_PROXY.try_lock();assert!(proxies.is_ok(),"notification cannot hold proxy lock");let proxies=proxies.unwrap();
  let JValue::Object(view)=args[0]else{panic!()};let proxy=&proxies[&1];
  assert!(proxy.webview.is_some()&&proxy.webview_activity.is_some(),"notification requires completed proxy storage");
  assert_eq!(proxy.activity.id,owner.id);assert_eq!(proxy.webview_activity.as_ref().unwrap().id,owner.id);
  assert_eq!(proxy.webview.as_ref().unwrap().id,view.id);assert_eq!(proxy.webview_generation,Some(1));
  assert_eq!(JAVA_VIEWS.lock().unwrap().get(&owner.id),Some(&view.id));assert_eq!(PARENTS.lock().unwrap().get(&view.id),Some(&owner.id));
  drop(proxies);NOTIFY_ATTEMPTS.fetch_add(1,Ordering::SeqCst);self.fail("notify")?;
  NOTIFICATIONS.lock().unwrap().push((owner.id,view.id));return Ok(Value{object:JObject::null(),boolean:false});
 }
 if name=="isChangingConfigurations"{return Ok(Value{object:JObject::null(),boolean:CHANGING.load(Ordering::SeqCst)});}
 if name=="isDestroyed" {return Ok(Value{object:JObject::null(),boolean:DEAD.lock().unwrap().contains(&owner.id)});}
 if name=="destroyOwnedWebView" {
  self.fail("cleanup")?;
  let JValue::Object(v)=args[0] else {panic!()};
  let JValue::Bool(assigned)=args[1] else {panic!()};
  if DISPOSED.lock().unwrap().contains(&v.id) {return Ok(Value{object:JObject::null(),boolean:true});}
  if assigned && JAVA_VIEWS.lock().unwrap().get(&owner.id).copied()!=Some(v.id) { return Ok(Value{object:JObject::null(),boolean:false}); }
  if !assigned && (JAVA_VIEWS.lock().unwrap().contains_key(&owner.id) || PARENTS.lock().unwrap().contains_key(&v.id)) {return Ok(Value{object:JObject::null(),boolean:false});}
  JAVA_VIEWS.lock().unwrap().remove(&owner.id);PARENTS.lock().unwrap().remove(&v.id);DISPOSED.lock().unwrap().push(v.id);
  if ACCEPTED.load(Ordering::SeqCst)==v.id {ACCEPTED.store(0,Ordering::SeqCst);}
  DESTROYED_OBJECT.store(v.id,Ordering::SeqCst);
  return Ok(Value{object:JObject::null(),boolean:true});
 }
 if name=="setWebView" { let JValue::Object(v)=args[0] else {panic!()};JAVA_VIEWS.lock().unwrap().insert(owner.id,v.id); if !RETRY.load(Ordering::SeqCst)&&FAIL.get().unwrap()=="pre-hook" {return Err("hook refusal");} }
 if name=="setContentView" {let JValue::Object(v)=args[0] else {panic!()};PARENTS.lock().unwrap().insert(v.id,owner.id);if FAIL.get().unwrap()=="stored-conflict"{ACTIVITY_PROXY.lock().unwrap().get_mut(&1).unwrap().activity=JObject{id:9,name:"foreign".into()};}}`);
 code=code.replace('static FAIL:', 'static NOTIFY_ATTEMPTS:AtomicI64=AtomicI64::new(0);static NOTIFICATIONS:Mutex<Vec<(i64,i64)>>=Mutex::new(Vec::new());static FAIL:');
 code=code.replace('static FAIL:', 'static CHANGING:AtomicBool=AtomicBool::new(false);static JAVA_VIEWS:Mutex<BTreeMap<i64,i64>>=Mutex::new(BTreeMap::new());static PARENTS:Mutex<BTreeMap<i64,i64>>=Mutex::new(BTreeMap::new());static DEAD:Mutex<Vec<i64>>=Mutex::new(Vec::new());static DISPOSED:Mutex<Vec<i64>>=Mutex::new(Vec::new());static DESTROYED_OBJECT:AtomicI64=AtomicI64::new(0);\nstatic FAIL:');
 // Preserve actual Rust/JNI error branches with a representable fake error type.
 code=code.replace(' assert_eq!(method,"constructionStored");',' if method=="constructionCleared" {assert!(TAURI_LABEL_REMOVED.load(Ordering::SeqCst),"Tauri manager labels removed before worker clear");let JValue::Long(ticket)=args[0]else{panic!()};CLEARED_TICKET.store(ticket,Ordering::SeqCst);return Ok(Value{object:JObject::null(),boolean:true});}STORED_CALLS.fetch_add(1,Ordering::SeqCst);assert_eq!(method,"constructionStored");');
 code=code.replace('static FAIL:','static STORED_CALLS:AtomicI64=AtomicI64::new(0);static CLEARED_TICKET:AtomicI64=AtomicI64::new(0);static TAURI_LABEL_REMOVED:AtomicBool=AtomicBool::new(false);static LABEL:OnceLock<String>=OnceLock::new();const DESTROYED:i32=6;static FAIL:');
 code=code.replace('impl Value{fn l', 'impl Value{fn i(self)->Result<i32>{Ok(1)}fn l');
 code=code.replace('struct Env{pending:bool}impl Env {', 'struct Env{pending:bool}impl Env {fn get_string(&self,v:&JString)->Result<JavaString>{Ok(JavaString(v.name.clone()))}');
 code=code.replaceAll('jni::errors::Error::NullPtr(', 'jni_error(');
 code += String.raw`
NOTIFY_DESTROYED
WORKER_CLEAR
struct JavaString(String);impl JavaString{fn to_string_lossy(&self)->&str{&self.0}}
type JClass=JObject;use pipe::MainPipe;
fn remove_activity_proxy(id:i32){ACTIVITY_PROXY.lock().unwrap().remove(&id);}
OLD_MAP_CLEANUP
mod binding_fixture{use super::*;
ACTUAL_BINDING
}
fn jni_error(s:&'static str)->&'static str{s}
#[derive(Clone)]struct OwnedWebView{generation:u64,activity:GlobalRef,object:GlobalRef,assigned:bool}
static PENDING_OWNED:Mutex<BTreeMap<(i32,String),Vec<OwnedWebView>>>=Mutex::new(BTreeMap::new());
static WEBVIEW_ATTRIBUTES:Mutex<BTreeMap<i32,CreateWebViewAttributes>>=Mutex::new(BTreeMap::new());
static IPC:Mutex<BTreeMap<String,i32>>=Mutex::new(BTreeMap::new());
static REQUEST_HANDLER:Mutex<BTreeMap<String,i32>>=Mutex::new(BTreeMap::new());
static TITLE_CHANGE_HANDLER:Mutex<BTreeMap<String,i32>>=Mutex::new(BTreeMap::new());
static URL_LOADING_OVERRIDE:Mutex<BTreeMap<String,i32>>=Mutex::new(BTreeMap::new());
static ON_LOAD_HANDLER:Mutex<BTreeMap<String,i32>>=Mutex::new(BTreeMap::new());
static PERMISSION_HANDLER:Mutex<BTreeMap<String,i32>>=Mutex::new(BTreeMap::new());
static ASSET_LOADER_DOMAIN:Mutex<BTreeMap<String,i32>>=Mutex::new(BTreeMap::new());
HANDLERS
use std::{cell::RefCell,rc::Rc};
struct ManagerWindow{webviews:Vec<ManagerWebview>}
impl ManagerWindow{fn webviews(&self)->&[ManagerWebview]{&self.webviews}}
struct ManagerWebview{label:String}impl ManagerWebview{fn label(&self)->&str{&self.label}}
struct ManagerWindows(Mutex<BTreeMap<String,ManagerWindow>>);impl ManagerWindows{fn windows_lock(&self)->std::sync::MutexGuard<'_,BTreeMap<String,ManagerWindow>>{self.0.lock().unwrap()}}
struct ManagerWebviews(Mutex<BTreeMap<String,i32>>);impl ManagerWebviews{fn webviews_lock(&self)->std::sync::MutexGuard<'_,BTreeMap<String,i32>>{self.0.lock().unwrap()}}
struct Listeners(Mutex<Vec<String>>);impl Listeners{fn remove_webview_listeners(&self,label:&str){self.0.lock().unwrap().retain(|v|v!=label);}}
mod ipc{pub mod channel{pub struct ChannelDataIpcQueue(pub std::sync::Mutex<Vec<String>>);impl ChannelDataIpcQueue{pub fn remove_webview_entries(&self,label:&str){self.0.lock().unwrap().retain(|v|v!=label);}}}}
struct State(ipc::channel::ChannelDataIpcQueue);impl State{fn get<T>(&self)->&ipc::channel::ChannelDataIpcQueue{&self.0}}
struct Manager{window:ManagerWindows,webview:ManagerWebviews,state:State,listeners:Listeners}
impl Manager{fn listeners(&self)->&Listeners{&self.listeners}
TAURI_MANAGER
}

type ActivityId=i32;type WindowId=u32;type WebviewId=u32;use std::sync::mpsc::channel;
trait UserEvent:Clone+Send+'static{}impl UserEvent for (){}
enum Message<T>{AndroidOwnedDestroyComplete(WindowId,WebviewId,u64,bool),User(T)}
struct TaoEventLoopProxy<T>(std::marker::PhantomData<T>);
impl<T>Clone for TaoEventLoopProxy<T>{fn clone(&self)->Self{Self(std::marker::PhantomData)}}
static TAO:Mutex<VecDeque<Message<()>>>=Mutex::new(VecDeque::new());
impl<T:UserEvent>TaoEventLoopProxy<Message<T>>{fn send_event(&self,m:Message<T>)->Result<()>{let Message::AndroidOwnedDestroyComplete(w,v,n,s)=m else{panic!()};TAO.lock().unwrap().push_back(Message::AndroidOwnedDestroyComplete(w,v,n,s));Ok(())}}
struct Inner;impl Inner{fn id(&self)->u32{1}}
struct WebviewWrapper{id:u32}
impl WebviewWrapper{fn destroy_owned_async<F:FnOnce(bool)+Send+'static>(&self,f:F)->bool{QUEUE.lock().unwrap().push_back((1,WebViewMessage::DestroyOwned{webview_id:"owned".into(),callback:Box::new(f)}));true}}
struct WindowWrapper{inner:Option<Inner>,webviews:Vec<WebviewWrapper>,android_owned_destroy:Option<(u64,u32)>,label:String,window_event_listeners:std::sync::Arc<Mutex<BTreeMap<u32,Box<dyn Fn(&WindowEvent)+Send>>>>}
struct WindowsStore(RefCell<BTreeMap<u32,WindowWrapper>>);
struct WindowIdStore(std::sync::Arc<Mutex<BTreeMap<u32,u32>>>);
enum WindowEvent{Destroyed}
enum ExitRequestedEventAction{Prevent}
enum ControlFlow{Wait,Exit}
enum RunEvent<T>{WindowEvent{label:String,event:WindowEvent},ExitRequested{code:Option<i32>,tx:mpsc::Sender<ExitRequestedEventAction>},User(T)}
REQUEST
COMPLETE
fn main(){
 let scenario=std::env::args().nth(1).unwrap();FAIL.set(if scenario=="post-hook"{"client".into()}else if scenario=="early-globalref"{"globalref".into()}else{scenario.clone()}).unwrap();PACKAGE.set("test").unwrap();
 ACTIVITY_PROXY.lock().unwrap().insert(1,ActivityProxy{activity:JObject{id:1,name:"Activity".into()},webview:None,webview_id:None,webview_activity:None,webview_generation:None});
 WEBVIEW_ATTRIBUTES.lock().unwrap().insert(1,attrs());
 if scenario=="binding-control" {
  unsafe{binding_fixture::onWebviewDestroy(Env{pending:false},JObject::null(),JObject{id:1,name:"Activity".into()},JObject{id:1,name:"owned".into()});}let mut ui=pipe::MainPipe{env:Env{pending:false}};assert!(ui.recv().is_ok());assert!(ACTIVITY_PROXY.lock().unwrap().is_empty());assert!(!WEBVIEW_ATTRIBUTES.lock().unwrap().contains_key(&1));assert!(DISPOSED.lock().unwrap().is_empty(),"default preserves upstream bookkeeping-only OnDestroy");return;
 }
 if scenario=="binding-early-back" {
  WEBVIEW_ATTRIBUTES.lock().unwrap().clear();unsafe{binding_fixture::onWebviewDestroy(Env{pending:false},JObject::null(),JObject{id:1,name:"Activity".into()},JObject{id:0,name:String::new()});}let mut ui=pipe::MainPipe{env:Env{pending:false}};assert!(ui.recv().is_ok());assert!(ACTIVITY_PROXY.lock().unwrap().is_empty());assert!(TAO.lock().unwrap().is_empty());return;
 }
 if scenario=="null-proof"||scenario=="stale-proof" {
  let(tx,rx)=mpsc::channel();EVENTS.set(tx).unwrap();if scenario=="stale-proof"{CONSTRUCTION.store(2,Ordering::SeqCst);}
  enqueue_proof(1);let mut ui=pipe::MainPipe{env:Env{pending:false}};assert!(ui.recv().is_ok());assert!(!COMMITTED.load(Ordering::SeqCst));assert_eq!(STORED_CALLS.load(Ordering::SeqCst),if scenario=="null-proof"{1}else{0},"current nullable proof must reach Kotlin; stale ticket remains inert");assert_eq!(rx.try_iter().collect::<Vec<_>>(),vec![(CREATION_FAILED,1)]);return;
 }
 for map in [&IPC,&REQUEST_HANDLER,&TITLE_CHANGE_HANDLER,&URL_LOADING_OVERRIDE,&ON_LOAD_HANDLER,&PERMISSION_HANDLER,&ASSET_LOADER_DOMAIN] {map.lock().unwrap().insert("owned".into(),1);map.lock().unwrap().insert("foreign".into(),2);}
 QUEUE.lock().unwrap().push_back((1,WebViewMessage::CreateWebView(attrs())));
 let mut ui=pipe::MainPipe{env:Env{pending:false}};assert!(ui.recv().is_ok());
 let mut allocated=NEXT.load(Ordering::SeqCst)-1;
 if ["pre-hook","post-hook","load","ipc","content","plugin","early-globalref","stored-conflict"].contains(&scenario.as_str()) {
  assert_eq!(NOTIFY_ATTEMPTS.load(Ordering::SeqCst),0,"failed creation never notifies storage");
 }
 if scenario=="stored-conflict" {assert!(ACTIVITY_PROXY.lock().unwrap()[&1].webview.is_none());return;}
 if scenario=="stored-notification"||scenario=="notify"||scenario=="stored-warm" {
  assert_eq!(NOTIFY_ATTEMPTS.load(Ordering::SeqCst),1);assert!(!ui.env.pending,"notification exception must be cleared without losing storage");
  assert!(ACTIVITY_PROXY.lock().unwrap()[&1].webview.is_some());
  assert_eq!(*NOTIFICATIONS.lock().unwrap(),if scenario=="notify"{vec![]}else{vec![(1,allocated)]});
  let(tx,rx)=mpsc::channel();EVENTS.set(tx).unwrap();enqueue_proof(1);assert!(ui.recv().is_ok());
  assert!(COMMITTED.load(Ordering::SeqCst),"notification success/failure cannot replace cold storage ACK");assert_eq!(rx.try_iter().collect::<Vec<_>>(),vec![(ATTACHED,1)]);
  if scenario=="stored-warm" {
   DEAD.lock().unwrap().push(1);ACTIVITY_PROXY.lock().unwrap().get_mut(&1).unwrap().activity=JObject{id:2,name:"warm owner".into()};
   QUEUE.lock().unwrap().push_back((1,WebViewMessage::CreateWebView(attrs())));assert!(ui.recv().is_ok());
   let next=ACTIVITY_PROXY.lock().unwrap()[&1].webview.as_ref().unwrap().id;assert_ne!(next,allocated);
   assert_eq!(*NOTIFICATIONS.lock().unwrap(),vec![(1,allocated),(2,next)],"warm recreation has its own exact storage notification");
   assert_eq!(STORED_CALLS.load(Ordering::SeqCst),1,"warm notification does not fabricate another cold ACK");
  }
  return;
 }
 if scenario=="dead-owner-cleared-error"||scenario=="already-disposed-old" {
  let old=ACTIVITY_PROXY.lock().unwrap()[&1].webview.as_ref().unwrap().clone();
  if scenario=="already-disposed-old" {assert!(ui.env.call_method(&JObject{id:1,name:"old Activity".into()},"destroyOwnedWebView","(Landroid/webkit/WebView;Z)Z",&[JValue::Object(&old),JValue::Bool(true)]).unwrap().z().unwrap());}
  else {JAVA_VIEWS.lock().unwrap().remove(&1);PARENTS.lock().unwrap().remove(&old.id);}
  DEAD.lock().unwrap().push(1);ACTIVITY_PROXY.lock().unwrap().get_mut(&1).unwrap().activity=JObject{id:2,name:"new Activity".into()};
  let before=NEXT.load(Ordering::SeqCst);QUEUE.lock().unwrap().push_back((1,WebViewMessage::CreateWebView(attrs())));assert!(ui.recv().is_ok());
  if scenario=="dead-owner-cleared-error" {assert_eq!(NEXT.load(Ordering::SeqCst),before,"dead Activity plus cleared field is not destruction proof");assert_eq!(ACTIVITY_PROXY.lock().unwrap()[&1].webview.as_ref().unwrap().id,old.id);assert!(TAO.lock().unwrap().is_empty());return;}
  assert_eq!(DISPOSED.lock().unwrap().iter().filter(|&&id|id==old.id).count(),1);assert!(PENDING_OWNED.lock().unwrap().is_empty());allocated=NEXT.load(Ordering::SeqCst)-1;
 }
 if scenario=="rotation"||scenario=="overlap"||scenario=="bound"||scenario=="binding-late-owner"||scenario=="binding-new-owner-dead" {
  let count=if scenario=="rotation"{12}else if scenario=="bound"{8}else{1};
  for index in 1..=count {
   if scenario=="rotation" {DEAD.lock().unwrap().push(index);}
   ACTIVITY_PROXY.lock().unwrap().get_mut(&1).unwrap().activity=JObject{id:index+1,name:"new Activity".into()};
   let before=NEXT.load(Ordering::SeqCst);QUEUE.lock().unwrap().push_back((1,WebViewMessage::CreateWebView(attrs())));assert!(ui.recv().is_ok());
   if scenario=="bound"&&index==8 {assert_eq!(NEXT.load(Ordering::SeqCst),before,"bound refuses BEFORE constructing ninth object");break;}
   allocated=NEXT.load(Ordering::SeqCst)-1;assert_eq!(allocated,before);
   if scenario=="rotation" {assert!(PENDING_OWNED.lock().unwrap().is_empty(),"healthy dead owners are physically retired without growing strong journal");assert_eq!(JAVA_VIEWS.lock().unwrap().len(),1);assert_eq!(DISPOSED.lock().unwrap().len(),index as usize);}
  }
  if scenario=="overlap" {assert_eq!(PENDING_OWNED.lock().unwrap()[&(1,"owned".into())].len(),1);assert!(DISPOSED.lock().unwrap().is_empty(),"live old owner remains intact during same-id creation");}
 }

 if scenario.starts_with("binding-") {
  let old=100;DEAD.lock().unwrap().push(1);
  if scenario=="binding-new-owner-dead"{DEAD.lock().unwrap().push(2);}
  if scenario=="binding-cleared-failure"{JAVA_VIEWS.lock().unwrap().remove(&1);PARENTS.lock().unwrap().remove(&old);}
  CHANGING.store(scenario=="binding-config",Ordering::SeqCst);
  let before=NEXT.load(Ordering::SeqCst);
  unsafe{binding_fixture::onWebviewDestroy(Env{pending:false},JObject::null(),JObject{id:1,name:"old Activity".into()},JObject{id:1,name:"owned".into()});}
  assert_eq!(QUEUE.lock().unwrap().len(),1,"actual binding queues owner-carrying UI message");assert!(ui.recv().is_ok());assert_eq!(NEXT.load(Ordering::SeqCst),before);assert!(TAO.lock().unwrap().is_empty(),"OnDestroy never fabricates logical Destroyed");
  if scenario=="binding-late-owner"||scenario=="binding-new-owner-dead"{assert_eq!(ACTIVITY_PROXY.lock().unwrap()[&1].webview.as_ref().unwrap().id,allocated);assert_eq!(ACTIVITY_PROXY.lock().unwrap()[&1].activity.id,2);assert!(WEBVIEW_ATTRIBUTES.lock().unwrap().contains_key(&1));assert!(IPC.lock().unwrap().contains_key("owned"));assert!(DISPOSED.lock().unwrap().contains(&old));assert!(!DISPOSED.lock().unwrap().contains(&allocated),"late old owner never retires newer owner even if newer is also dead");}
  else if scenario=="binding-nonconfig"{assert!(ACTIVITY_PROXY.lock().unwrap().is_empty());assert!(!WEBVIEW_ATTRIBUTES.lock().unwrap().contains_key(&1));assert!(DISPOSED.lock().unwrap().contains(&old));assert!(IPC.lock().unwrap().contains_key("foreign"));}
  else if scenario=="binding-config"{assert!(ACTIVITY_PROXY.lock().unwrap()[&1].webview.is_none());assert!(WEBVIEW_ATTRIBUTES.lock().unwrap().contains_key(&1));assert!(IPC.lock().unwrap().contains_key("owned"));assert!(DISPOSED.lock().unwrap().contains(&old));}
  else if scenario=="binding-cleared-failure"{assert!(ACTIVITY_PROXY.lock().unwrap()[&1].webview.is_some());assert!(WEBVIEW_ATTRIBUTES.lock().unwrap().contains_key(&1));assert!(!DISPOSED.lock().unwrap().contains(&old));}
  else{panic!("unknown binding case");}return;
 }
 if scenario=="early-globalref" {assert!(JAVA_VIEWS.lock().unwrap().is_empty());assert!(PARENTS.lock().unwrap().is_empty());assert!(PENDING_OWNED.lock().unwrap().is_empty());assert!(ACTIVITY_PROXY.lock().unwrap()[&1].webview.is_none());}

 if scenario!="early-globalref" {assert!(ACTIVITY_PROXY.lock().unwrap()[&1].webview.is_some() || PENDING_OWNED.lock().unwrap().contains_key(&(1,"owned".into())),"early exact journal survives all failed hooks");}
 let(wtx,wrx)=mpsc::channel();EVENTS.set(wtx).unwrap();LABEL.set("main".into()).unwrap();let mut pending=Some((1,WebviewWindow));let mut destroying=Some(1);let helper=JObject::null();
 let labels=Rc::new(RefCell::new(vec!["main".to_string()]));let labels2=labels.clone();let manager=Manager{window:ManagerWindows(Mutex::new(BTreeMap::from([("main".into(),ManagerWindow{webviews:vec![ManagerWebview{label:"owned".into()}]})]))),webview:ManagerWebviews(Mutex::new(BTreeMap::from([("owned".into(),1)]))),state:State(ipc::channel::ChannelDataIpcQueue(Mutex::new(vec!["owned".into(),"foreign".into()]))),listeners:Listeners(Mutex::new(vec!["owned".into(),"foreign".into()]))};let acknowledgements=Rc::new(RefCell::new(0));let ack=acknowledgements.clone();let callback_windows=Rc::new(WindowsStore(RefCell::new(BTreeMap::new())));let windows=callback_windows.clone();
 let mut callback=move|event:RunEvent<()>|match event{RunEvent::WindowEvent{label,event:WindowEvent::Destroyed}=>{assert!(callback_windows.0.borrow().is_empty(),"wrapper removed BEFORE genuine runtime Destroyed");assert_eq!(DESTROYED_OBJECT.load(Ordering::SeqCst),allocated,"native cleanup precedes logical ack");manager.on_window_close(&label);assert!(manager.window.windows_lock().is_empty());assert!(manager.webview.webviews_lock().is_empty());assert_eq!(*manager.listeners.0.lock().unwrap(),vec!["foreign".to_string()]);assert_eq!(*manager.state.0.0.lock().unwrap(),vec!["foreign".to_string()]);labels2.borrow_mut().retain(|v|v!=&label);assert!(labels2.borrow().is_empty());TAURI_LABEL_REMOVED.store(true,Ordering::SeqCst);window_destroyed(&label);*ack.borrow_mut()+=1;},RunEvent::ExitRequested{code,tx}=>{assert!(code.is_none());tx.send(ExitRequestedEventAction::Prevent).unwrap();},_=>{}};
 windows.0.borrow_mut().insert(1,WindowWrapper{inner:Some(Inner),webviews:vec![WebviewWrapper{id:10}],android_owned_destroy:None,label:"main".into(),window_event_listeners:Default::default()});
 let ids=WindowIdStore(Default::default());ids.0.lock().unwrap().insert(1,1);let proxy=TaoEventLoopProxy::<Message<()>>(std::marker::PhantomData);let mut flow=ControlFlow::Wait;
 if scenario=="multi" {windows.0.borrow_mut().get_mut(&1).unwrap().webviews.push(WebviewWrapper{id:11});}
 if scenario=="missing-window" {request_android_owned_destroy(2,&windows,&proxy);assert!(QUEUE.lock().unwrap().is_empty());return;}
 let before_destroy=DESTROYED_OBJECT.load(Ordering::SeqCst);request_android_owned_destroy(1,&windows,&proxy);
 if scenario=="multi" {assert!(QUEUE.lock().unwrap().is_empty());assert_eq!(*acknowledgements.borrow(),0);return;}
 request_android_owned_destroy(1,&windows,&proxy);
 assert_eq!(QUEUE.lock().unwrap().len(),1,"duplicate request cannot enqueue cleanup twice");
 assert_eq!(windows.0.borrow().len(),1,"Tao returns while wrapper still exists");assert_eq!(*acknowledgements.borrow(),0);assert_eq!(DESTROYED_OBJECT.load(Ordering::SeqCst),before_destroy,"Tao must not run UI cleanup or wait");
 if scenario=="foreign-proxy" {ACTIVITY_PROXY.lock().unwrap().get_mut(&1).unwrap().webview_id=Some("foreign".into());}
 if scenario=="foreign-pending" {PENDING_OWNED.lock().unwrap().insert((1,"foreign".into()),vec![OwnedWebView{generation:1,activity:JObject{id:2,name:"foreign Activity".into()},object:JObject{id:999,name:"foreign".into()},assigned:true}]);}
 if scenario=="wrong-attributes" {WEBVIEW_ATTRIBUTES.lock().unwrap().get_mut(&1).unwrap().id="foreign".into();}
 if scenario=="changed-generation" {WEBVIEW_ATTRIBUTES.lock().unwrap().get_mut(&1).unwrap().owned_generation=2;}
 if scenario=="missing-proxy" {ACTIVITY_PROXY.lock().unwrap().clear();}
 assert!(ui.recv().is_ok(),"cleanup JNI failure must not poison FD");
 assert_eq!(windows.0.borrow().len(),1,"UI cannot remove Tao wrapper");assert_eq!(*acknowledgements.borrow(),0);
 let event=TAO.lock().unwrap().pop_front().expect("exactly one UI completion");let Message::AndroidOwnedDestroyComplete(w,v,n,s)=event else{panic!()};
 let should_fail=["cleanup","foreign-proxy","foreign-pending","wrong-attributes","missing-proxy","changed-generation","early-globalref"].contains(&scenario.as_str());assert_eq!(s,!should_fail);
 for (badw,badv,badn) in [(2,v,n),(w,v+1,n),(w,v,n+1)] {complete_android_owned_destroy(badw,badv,badn,s,&windows,&ids,&mut callback,&mut flow);assert_eq!(*acknowledgements.borrow(),0,"wrong window/id/nonce is inert");}
 if scenario=="stale" {windows.0.borrow_mut().get_mut(&1).unwrap().android_owned_destroy=Some((n+1,v));}
 complete_android_owned_destroy(w,v,n,s,&windows,&ids,&mut callback,&mut flow);
 if should_fail||scenario=="stale" {assert_eq!(*acknowledgements.borrow(),0);assert_eq!(windows.0.borrow().len(),1);assert_eq!(labels.borrow().len(),1,"unconfirmed cleanup keeps public label quarantined");return;}
 assert_eq!(*acknowledgements.borrow(),1);assert!(windows.0.borrow().is_empty());assert_eq!(CLEARED_TICKET.load(Ordering::SeqCst),0,"runtime callback only queues worker notification");let(kind,_)=wrx.try_recv().expect("real runtime event forwarded through actual app window_destroyed");let env=&mut ui.env;match kind {WORKER_DESTROYED _=>panic!("unexpected worker event")};assert!(pending.is_none());assert!(destroying.is_none());assert_eq!(CLEARED_TICKET.load(Ordering::SeqCst),1);assert_eq!(CONSTRUCTION.load(Ordering::SeqCst),0);assert!(ids.0.lock().unwrap().is_empty());assert!(labels.borrow().is_empty());
 complete_android_owned_destroy(w,v,n,s,&windows,&ids,&mut callback,&mut flow);assert_eq!(*acknowledgements.borrow(),1,"duplicate completion is inert");
 assert!(JAVA_VIEWS.lock().unwrap().is_empty());assert!(PARENTS.lock().unwrap().is_empty());assert_eq!(ACCEPTED.load(Ordering::SeqCst),0);assert!(PENDING_OWNED.lock().unwrap().is_empty());assert!(ACTIVITY_PROXY.lock().unwrap()[&1].webview.is_none());assert!(ACTIVITY_PROXY.lock().unwrap()[&1].webview_id.is_none());assert!(ACTIVITY_PROXY.lock().unwrap()[&1].webview_activity.is_none());assert!(!WEBVIEW_ATTRIBUTES.lock().unwrap().contains_key(&1));
 for map in [&IPC,&REQUEST_HANDLER,&TITLE_CHANGE_HANDLER,&URL_LOADING_OVERRIDE,&ON_LOAD_HANDLER,&PERMISSION_HANDLER,&ASSET_LOADER_DOMAIN] {assert!(!map.lock().unwrap().contains_key("owned"));assert!(map.lock().unwrap().contains_key("foreign"));}
 // No automatic retry. Only after genuine completion can explicit input create
 // the same logical id; execute the real Create body again for this admission.
 assert!(QUEUE.lock().unwrap().is_empty());let before=NEXT.load(Ordering::SeqCst);QUEUE.lock().unwrap().push_back((1,WebViewMessage::CreateWebView(attrs())));assert!(ui.recv().is_ok());assert_eq!(NEXT.load(Ordering::SeqCst),before,"late already-queued retired Create cannot resurrect after acknowledgement");RETRY.store(true,Ordering::SeqCst);WEBVIEW_ATTRIBUTES.lock().unwrap().insert(1,attrs());QUEUE.lock().unwrap().push_back((1,WebViewMessage::CreateWebView(attrs())));assert!(ui.recv().is_ok());assert!(ACTIVITY_PROXY.lock().unwrap()[&1].webview.is_some());
}
`;
 code=code.replace('OLD_MAP_CLEANUP',oldMapCleanup.replaceAll('WebviewId','String')).replace('ACTUAL_BINDING',binding);
 code=code.replace('TAURI_MANAGER',tauriManager).replace('NOTIFY_DESTROYED',notifyDestroyed).replace('WORKER_CLEAR',workerClear).replace('WORKER_DESTROYED',workerDestroyed);
 code=code.replace('clear(&mut env, &helper, old);','clear(env, &helper, old);');
 code=code.replace('\nHANDLERS\n','\n'+handlers.replaceAll('WebviewId','String')+'\n').replace('\nREQUEST\n','\n'+request+'\n').replace('\nCOMPLETE\n','\n'+completion+'\n');
 if(mutation==='logical-only') code=code.replace('  let webview = &window.webviews[0];', '  window.inner = None; return;\n  let webview = &window.webviews[0];');
 if(mutation==='premature-map') code=code.replace('  });\n}\n\nfn complete_android_owned_destroy', '  });\n  store.remove(&window_id);\n}\n\nfn complete_android_owned_destroy');
 if(mutation==='premature-ack') code=code.replace('callback(result.unwrap_or(false));','callback(true);');
 if(mutation==='no-journal') code=code.replace('PENDING_OWNED\n            .lock()\n            .unwrap()\n            .entry((activity_id, owned_id.clone()))\n            .or_default()\n            .push(OwnedWebView {', 'NO_JOURNAL((activity_id, owned_id.clone()), OwnedWebView {'); // a same-signature no-op, not a compile failure
 if(mutation==='no-proxy-id') code=code.replace('if id == *webview_id && stored_generation == generation =>', 'if true =>');
 if(mutation==='stale-nonce') code=code.replace('|| window.android_owned_destroy != Some((nonce, webview_id))','|| false');
 if(mutation==='null-shortcircuit') code=code.replace('let attached = CONSTRUCTION.load(Ordering::Acquire) == ticket', 'let attached = CONSTRUCTION.load(Ordering::Acquire) == ticket && !webview.is_null()');
 if(mutation==='single-live-fence'||mutation==='combined-live-fences') code=code.replace('!= Some((&owned_id, owned_generation))', '== Some((&owned_id, 999))');
 if(mutation==='combined-live-fences') {const a=code.indexOf('    let generation = {',code.indexOf('fn owned_candidates'));const b=code.indexOf('    let pending =',a);assert.ok(a>0&&b>a);code=code.slice(0,a)+'    let generation = 1;\n'+code.slice(b);}
 if(mutation==='old-ondestroy') {const start=code.indexOf('          let result = self.on_owned_activity_destroy(');const end=code.indexOf('          if result.is_err()',start);assert.ok(start>0&&end>start);code=code.slice(0,start)+'          let result:Result<()> = {if !is_changing_configurations {super::destroy_webview(activity_id,&webview_id);remove_activity_proxy(activity_id);}Ok(())};\n'+code.slice(end);}
 if(mutation==='retire-live') code=code.replace('      if !self\n        .env\n        .call_method(owned.activity.as_obj(), "isDestroyed"', '      if false && !self\n        .env\n        .call_method(owned.activity.as_obj(), "isDestroyed"');
 if(mutation==='drop-cleanup') code+='\nimpl Drop for WebviewWrapper {fn drop(&mut self){QUEUE.lock().unwrap().push_back((1,WebViewMessage::DestroyOwned{webview_id:"owned".into(),callback:Box::new(|_|{})}));}}\n';
 if(mutation==='stored-omitted')code=code.replace('"notifyOwnedWebViewStored",','"omittedStorageNotification",');
 if(mutation==='stored-before-proxy')code=code.replace(storedNotification,'').replace('        #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]\n        {\n          let mut pending = PENDING_OWNED.lock().unwrap();',storedNotification+'        #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]\n        {\n          let mut pending = PENDING_OWNED.lock().unwrap();');
 if(mutation==='stored-with-locks')code=code.replace(storedNotification,'').replace('          proxy.webview = Some(next.object);','          proxy.webview = Some(next.object);\n'+storedNotification);
 if(mutation==='stored-exception-retained')code=code.replace(storedNotification,storedNotification.replace('self.env.exception_clear()?;','// unsafe retained exception'));
 if(mutation==='stored-foreign-owner')code=code.replace('            || !self\n              .env\n              .is_same_object(proxy.activity.as_obj(), activity.as_obj())?','');
 if(mutation==='sync-wait') code=code.replace('  let proxy = proxy.clone();', '  let (_tx,rx)=mpsc::channel::<bool>();rx.recv_timeout(std::time::Duration::from_millis(20)).expect("Tao cannot wait for undrained UI");\n  let proxy = proxy.clone();');
 code+='\n#[allow(non_snake_case)]fn NO_JOURNAL(_: (i32,String),_:OwnedWebView){}\n';
 code=platform(code);
 const file=join(work,mutation+'.rs'),bin=join(work,mutation);writeFileSync(file,code);
 const args=['--edition','2021','--crate-name','owned_destroy','--cfg','feature="android-app-create-webview-completion"','-o',bin,file];if(mutation!=='binding-nonandroid')args.push('--cfg','test_android');if(mutation!=='binding-disabled')args.push('--cfg',`feature="${feature}"`);
 const result=spawnSync(process.env.RUSTC||'rustc',args,{encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stderr);binaries.set(mutation,bin);return bin;
}
const run=(bin,scenario)=>spawnSync(bin,[scenario],{encoding:'utf8',timeout:5000});
for (const scenario of ['success','pre-hook','post-hook','load','ipc','content','plugin','cleanup','foreign-proxy','foreign-pending','wrong-attributes','missing-proxy','missing-window','multi','stale','rotation','overlap','bound','changed-generation','null-proof','stale-proof','early-globalref','dead-owner-cleared-error','already-disposed-old','binding-late-owner','binding-new-owner-dead','binding-config','binding-nonconfig','binding-cleared-failure','binding-early-back']) test(`actual Tao request, Wry UI cleanup, later Tao completion: ${scenario}`,()=>{const r=run(compile(),scenario);assert.equal(r.status,0,r.stdout+r.stderr);});
for(const [mutation,scenario] of [['logical-only','success'],['premature-map','success'],['premature-ack','cleanup'],['no-journal','pre-hook'],['no-proxy-id','foreign-proxy'],['stale-nonce','stale'],['sync-wait','success'],['drop-cleanup','success'],['retire-live','overlap'],['old-ondestroy','binding-late-owner'],['null-shortcircuit','null-proof'],['combined-live-fences','success']]) test(`compiled unsafe owned-destroy mutant refuses behavior: ${mutation}`,()=>{const r=run(compile(mutation),scenario);assert.notEqual(r.status,0,'compiled mutant must fail the same behavior assertions');assert.equal(r.signal,null,r.stderr);});
for(const scenario of ['stored-notification','notify','stored-warm','stored-conflict'])test(`actual post-storage notification leaves native ACK independent: ${scenario}`,()=>{
 const positive=run(compile(),scenario);assert.equal(positive.status,0,positive.stdout+positive.stderr);
});
for(const [mutation,scenario]of [['stored-omitted','stored-warm'],['stored-before-proxy','stored-notification'],['stored-with-locks','stored-notification'],['stored-exception-retained','notify'],['stored-foreign-owner','stored-conflict']])test(`individual causal post-storage notification mutant: ${mutation}`,()=>{
 const positive=run(compile(),scenario);assert.equal(positive.status,0,positive.stdout+positive.stderr);
 const negative=run(compile(mutation),scenario);assert.equal(negative.signal,null);assert.equal(negative.status,101);assert.match(negative.stderr,/panicked/);
});

test('actual build.rs Kotlin generation keeps default templates/rules exact and selects only opt-in alternatives',()=>{
 const build=read('web/src-tauri/vendor/wry/build.rs');
 const body=between(build,'  if target_os == "android" {','\n  let target = ');
 const source=`fn main(){let target_os=std::env::var("CARGO_CFG_TARGET_OS").unwrap();\n${body}\n}`;
 for(const enabled of [false,true]){
  const file=join(work,`build-${enabled}.rs`),bin=join(work,`build-${enabled}`),output=join(work,`generated-${enabled}`);
  writeFileSync(file,source);mkdirSync(output);
  const args=['--edition','2021','--crate-name','owned_template','-o',bin,file];if(enabled)args.push('--cfg',`feature="${feature}"`);
  const compiled=spawnSync(process.env.RUSTC||'rustc',args,{encoding:'utf8',timeout:30000});assert.equal(compiled.status,0,compiled.stderr);
  const env={...process.env,CARGO_CFG_TARGET_OS:'android',CARGO_MANIFEST_DIR:new URL('web/src-tauri/vendor/wry',root).pathname,WRY_ANDROID_KOTLIN_FILES_OUT_DIR:output,WRY_ANDROID_PACKAGE:'test.owned',WRY_ANDROID_LIBRARY:'owned'};
  const r=spawnSync(bin,[],{env,encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);
  for(const entry of readdirSync(new URL('web/src-tauri/vendor/wry/src/android/kotlin',root))){
   const special=enabled&&['WryActivity.kt','proguard-wry.pro'].includes(entry);
   const template=read(`web/src-tauri/vendor/wry/src/android/${special?'owned':'kotlin'}/${entry}`);
   const prefix=entry.endsWith('.kt')?'/* THIS FILE IS AUTO-GENERATED. DO NOT MODIFY!! */\n\n':entry.endsWith('.pro')?'# THIS FILE IS AUTO-GENERATED. DO NOT MODIFY!!\n\n':'String::new()';
   const expected=prefix+template.replaceAll('{{package}}','test.owned').replaceAll('{{package-unescaped}}','test.owned').replaceAll('{{library}}','owned').replaceAll('{{class-extension}}','').replaceAll('{{class-init}}','');
   assert.equal(readFileSync(join(output,entry),'utf8'),expected);
  }
  assert.equal(readFileSync(join(output,'proguard-wry.pro'),'utf8').includes('boolean destroyOwnedWebView(android.webkit.WebView, boolean);'),enabled,'release/R8 JNI method pinned only for this opt-in');
  assert.equal(readFileSync(join(output,'proguard-wry.pro'),'utf8').includes('void notifyOwnedWebViewStored(android.webkit.WebView);'),enabled,'stored notification survives R8 only for this opt-in');
  const unused=join(work,`not-android-${enabled}`);mkdirSync(unused);
  const nonAndroid=spawnSync(bin,[],{env:{...env,CARGO_CFG_TARGET_OS:'linux',WRY_ANDROID_KOTLIN_FILES_OUT_DIR:unused},encoding:'utf8',timeout:5000});assert.equal(nonAndroid.status,0);assert.deepEqual(readdirSync(unused),[]);
 }
});

test('owned destroy enqueue is explicitly nonblocking, never Drop cleanup or app-synthesized Destroyed',()=>{
 const send=between(pipe,'  pub(crate) fn try_send_owned(', '\n  pub(crate) fn send(');
 assert.match(send,/\.try_send\(/);assert.doesNotMatch(send,/\.send\(|recv|wait|join|sleep/);
 assert.match(pipe,/libc::O_NONBLOCK/);
 for(const file of ['web/src-tauri/vendor/wry/src/android/mod.rs','web/src-tauri/vendor/wry/src/lib.rs']){
  const text=read(file);assert.doesNotMatch(text,/impl Drop for (?:InnerWebView|WebView)[\s\S]*destroy_owned/);
 }
 assert.doesNotMatch(app,/WindowEvent::Destroyed|RunEvent::WindowEvent/);
 assert.match(runtime,/Message::Window\(id, WindowMessage::Destroy\)[\s\S]*request_android_owned_destroy/);
});

test('single removed live-attributes fence remains safe because candidate-generation fence is independent',()=>{const r=run(compile('single-live-fence'),'success');assert.equal(r.status,0,r.stderr);});

test('actual runtime Destroy dispatch retains original logical-only behavior when disabled or non-Android',()=>{
 const arm=between(runtime,'      Message::Window(id, WindowMessage::Destroy) => {','\n      #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]\n      Message::AndroidOwnedDestroyComplete');
 const original=runtime.slice(runtime.indexOf('fn on_window_close('),runtime.indexOf('\nfn parse_proxy_url('));
 for(const [android,enabled] of [[true,false],[false,true],[false,false],[true,true]]){
  const file=join(work,`dispatch-${android}-${enabled}.rs`),bin=file+'.bin';
  const text=`use std::{cell::RefCell,collections::BTreeMap};type WindowId=u32;struct WindowWrapper{inner:Option<u32>}struct WindowsStore(RefCell<BTreeMap<u32,WindowWrapper>>);enum WindowMessage{Destroy}enum Message{Window(u32,WindowMessage)}static REQUESTED:std::sync::atomic::AtomicBool=std::sync::atomic::AtomicBool::new(false);fn request_android_owned_destroy(_:u32,_:&WindowsStore,_:&()){REQUESTED.store(true,std::sync::atomic::Ordering::SeqCst);}\n${original}\nfn main(){let windows=&WindowsStore(RefCell::new(BTreeMap::from([(1,WindowWrapper{inner:Some(1)})])));let android_owned_destroy_proxy=&();match Message::Window(1,WindowMessage::Destroy){${arm}}let opted=cfg!(all(test_android,feature="${feature}"));assert_eq!(REQUESTED.load(std::sync::atomic::Ordering::SeqCst),opted);assert_eq!(windows.0.borrow()[&1].inner.is_some(),opted);assert_eq!(windows.0.borrow().len(),1);}`;
  writeFileSync(file,platform(text));const args=['--edition','2021','--crate-name','destroy_dispatch','-o',bin,file];if(android)args.push('--cfg','test_android');if(enabled)args.push('--cfg',`feature="${feature}"`);
  const c=spawnSync(process.env.RUSTC||'rustc',args,{encoding:'utf8',timeout:30000});assert.equal(c.status,0,c.stderr);const r=spawnSync(bin,[],{encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);
 }
});

for(const control of ['binding-disabled','binding-nonandroid'])test(`actual binding/UI OnDestroy retains upstream behavior: ${control}`,()=>{const r=run(compile(control),'binding-control');assert.equal(r.status,0,r.stderr);});
