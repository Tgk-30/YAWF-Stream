import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const source=readFileSync(new URL('../web/src-tauri/src/android_startup.rs',import.meta.url),'utf8');
const lib=readFileSync(new URL('../web/src-tauri/src/lib.rs',import.meta.url),'utf8');
const policy=readFileSync(new URL('../web/src-tauri/src/android_exit_policy.rs',import.meta.url),'utf8');
const work=mkdtempSync(join(tmpdir(),'yawf-startup-bootstrap-'));after(()=>rmSync(work,{recursive:true,force:true}));
const begin=source.indexOf('pub(crate) fn start('),end=source.indexOf('            let mut pending:',begin);
const prefix=source.slice(begin,end),tail=source.slice(source.indexOf('    if spawned.is_err()',end),source.indexOf('\nfn bootstrap_failed(',end));
const failure=source.slice(source.indexOf('fn bootstrap_failed('),source.indexOf('\nfn queue_storage_proof('));
const keep=source.slice(source.indexOf('pub(crate) fn keep_startup_alive('),source.indexOf('\npub(crate) fn window_destroyed('));
assert.ok(begin>=0&&end>begin);assert.match(prefix,/let exit_app = app.clone\(\)/);assert.doesNotMatch(source,/STARTED\.store\(false/);
const binaries=new Map();
function build(mutation='none') {
 if(binaries.has(mutation))return binaries.get(mutation);
 let first=prefix,last=tail;
 if(mutation==='spawn')last=last.replace('bootstrap_failed(&exit_app);','');
 if(mutation==='connect')first=first.replace('let Ok((vm, helper)) = connect_helper() else {\n                bootstrap_failed(&app);','let Ok((vm, helper)) = connect_helper() else {');
 if(mutation==='attach')first=first.replace('let Ok(mut env) = vm.attach_current_thread_as_daemon() else {\n                bootstrap_failed(&app);','let Ok(mut env) = vm.attach_current_thread_as_daemon() else {');
 if(mutation==='bridge')first=first.replace('if call(&mut env, &helper, "onBridgeReady", "()V", &[]).is_err() {\n                bootstrap_failed(&app);','if call(&mut env, &helper, "onBridgeReady", "()V", &[]).is_err() {');
 if(mutation!=='none')assert.notEqual(first+last,prefix+tail,'Each causal removes only the actual stage exit');
 const text=String.raw`
#![allow(dead_code,unused_variables,unexpected_cfgs)]
use std::sync::{Arc,Mutex,OnceLock,atomic::{AtomicBool,AtomicUsize,Ordering},mpsc};
static STARTED:AtomicBool=AtomicBool::new(false);static COMMITTED:AtomicBool=AtomicBool::new(false);static BOOTSTRAP_EXIT_REQUESTED:AtomicBool=AtomicBool::new(false);
static LABEL:OnceLock<String>=OnceLock::new();static EVENTS:OnceLock<mpsc::Sender<(i32,i64)>>=OnceLock::new();static STAGE:OnceLock<String>=OnceLock::new();static READY:AtomicUsize=AtomicUsize::new(0);
#[derive(Clone)]struct AppHandle{exits:Arc<Mutex<Vec<Option<i32>>>>}impl AppHandle{fn exit(&self,n:i32){self.exits.lock().unwrap().push(Some(n));}}
struct WindowConfig{label:String}struct Env;struct VM;fn connect_helper()->Result<(VM,()),()>{if STAGE.get().unwrap()=="connect"{Err(())}else{Ok((VM,()))}}
impl VM{fn attach_current_thread_as_daemon(&self)->Result<Env,()>{if STAGE.get().unwrap()=="attach"{Err(())}else{Ok(Env)}}}
fn call(_:&mut Env,_:&(),name:&str,sig:&str,_:&[()])->Result<(),()>{assert_eq!(name,"onBridgeReady");assert_eq!(sig,"()V");if STAGE.get().unwrap()=="bridge"{Err(())}else{Ok(())}}
// Only the scheduler boundary is fake: use the exact production pre-loop code.
struct TestBuilder;impl TestBuilder{fn new()->Self{Self}fn name(self,_:String)->Self{self}fn spawn<F:FnOnce()+Send+'static>(self,f:F)->Result<(),()>{if STAGE.get().unwrap()=="spawn"{Err(())}else{f();Ok(())}}}
mod tauri{pub const RESTART_EXIT_CODE:i32=i32::MAX;}
mod policy{use crate::tauri;
POLICY
}
KEEP
FAILURE
PREFIX
READY.fetch_add(1,Ordering::SeqCst);
        });
TAIL
fn main(){let stage=std::env::args().nth(1).unwrap();STAGE.set(stage.clone()).unwrap();let app=AppHandle{exits:Arc::new(Mutex::new(vec![]))};start(app.clone(),WindowConfig{label:"main".into()});
assert!(STARTED.load(Ordering::SeqCst));assert!(!COMMITTED.load(Ordering::SeqCst));assert!(keep_startup_alive(None));assert!(!keep_startup_alive(Some(1)));assert!(!keep_startup_alive(Some(tauri::RESTART_EXIT_CODE)));
if stage=="success"{assert_eq!(READY.load(Ordering::SeqCst),1);assert!(app.exits.lock().unwrap().is_empty());}
else{assert_eq!(*app.exits.lock().unwrap(),vec![Some(1)]);assert_eq!(READY.load(Ordering::SeqCst),0);start(app.clone(),WindowConfig{label:"main".into()});bootstrap_failed(&app);assert_eq!(*app.exits.lock().unwrap(),vec![Some(1)],"poisoned STARTED and exit-once prohibit duplicate worker or restart");}
let mut p=policy::NormalExitPolicy::default();p.exit_requested(Some(1));assert!(p.take_normal_exit());assert!(!p.take_normal_exit());p.exit_requested(Some(tauri::RESTART_EXIT_CODE));assert!(!p.take_normal_exit());p.exit_requested(None);assert!(p.take_normal_exit());p.exit_prevented();assert!(!p.take_normal_exit());COMMITTED.store(true,Ordering::SeqCst);assert!(!keep_startup_alive(None));COMMITTED.store(false,Ordering::SeqCst);STARTED.store(false,Ordering::SeqCst);assert!(!keep_startup_alive(None));println!("actual-bootstrap-preloop passed: {}",stage);
}
`.replace('POLICY',policy.replace(/^\/\/!.*\n/,'' )).replace('KEEP',keep).replace('FAILURE',failure).replace('PREFIX',first.replace('std::thread::Builder::new()','TestBuilder::new()')).replace('TAIL',last);
 const file=join(work,mutation+'.rs'),binary=join(work,mutation);writeFileSync(file,text);
 const r=spawnSync(process.env.RUSTC||'/opt/homebrew/bin/rustc',['--edition','2021','--crate-name','startup_bootstrap','-o',binary,file],{encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);binaries.set(mutation,binary);return binary;
}
function run(stage,mutation='none'){return spawnSync(build(mutation),[stage],{encoding:'utf8',timeout:5000});}
for(const stage of ['spawn','connect','attach','bridge','success'])test(`actual startup pre-loop: ${stage} requests exit1 once or reaches worker`,()=>{const r=run(stage);assert.equal(r.status,0,r.stdout+r.stderr);});
for(const stage of ['spawn','connect','attach','bridge'])test(`individual causal bootstrap revert: ${stage} silent poison`,()=>{const r=run(stage,stage);assert.notEqual(r.status,0);assert.match(r.stderr,/panicked/);});
test('normal Exit/cleanup/_exit and restart policy source remains unchanged',()=>{
 const exit=lib.slice(lib.indexOf('            tauri::RunEvent::Exit => {'),lib.indexOf('            _ => {}',lib.indexOf('            tauri::RunEvent::Exit => {')));
 assert.equal((exit.match(/app.cleanup_before_exit\(\)/g)||[]).length,1);assert.match(exit,/if exit_policy.take_normal_exit\(\)/);assert.match(exit,/libc::_exit\(libc::EXIT_SUCCESS\)/);assert.match(lib,/if android_startup::keep_startup_alive\(code\)/);
});
