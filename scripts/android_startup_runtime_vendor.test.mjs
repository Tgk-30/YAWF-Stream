import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {checkAndroidStartupRuntimeVendor, feature, originalField, patchedField} from './check_android_startup_runtime_vendor.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'yawf-runtime-vendor-'));
after(() => rmSync(work, {recursive: true, force: true}));
const runtimePath = join(root, 'web/src-tauri/vendor/tauri-runtime-wry/src/lib.rs');
const runtime = readFileSync(runtimePath, 'utf8');
test('entire exact upstream crate, licenses, reviewed patch and Android-only Cargo opt-in are pinned', () => {
  assert.equal(checkAndroidStartupRuntimeVendor(root).files, 23);
});
test('unreviewed upstream/patch/provenance, added file and Cargo override drift each refuse', () => {
  const changes = [
    ['upstream', 'vendor/tauri-runtime-wry/LICENSE-MIT', text => text + '\n'],
    ['patch', 'vendor/tauri-runtime-wry/src/lib.rs', text => text.replace('webview_runtime_installed: true,', 'webview_runtime_installed: false,')],
    ['provenance', 'vendor/tauri-runtime-wry.PROVENANCE.json', text => text.replace('249374224cd5e56572d1e803659d03afb1d76a87ad7728fa20dd1bc2f443ebbf', '0'.repeat(64))],
    ['target', 'Cargo.toml', text => text.replace(`features = ["${feature}", "android-app-owned-window-destroy"]`, 'features = []')],
    ['override', 'Cargo.toml', text => text.replace('[patch.crates-io]', '[patch.crates-io]\nwry = { path = "unreviewed" }')],
    ['lock', 'Cargo.lock', text => text.replace('name = "tauri-runtime-wry"\nversion = "2.12.2"', 'name = "tauri-runtime-wry"\nversion = "2.12.3"')],
    ['added', 'vendor/tauri-runtime-wry/extra.rs', () => '// unreviewed'],
  ];
  for (const [name, path, edit] of changes) {
    const fixture = join(work, name);
    mkdirSync(join(fixture, 'web'), {recursive: true});
    cpSync(join(root, 'web/src-tauri/vendor'), join(fixture, 'web/src-tauri/vendor'), {recursive: true});
    for (const file of ['Cargo.toml', 'Cargo.lock']) cpSync(join(root, 'web/src-tauri', file), join(fixture, 'web/src-tauri', file));
    const destination = join(fixture, 'web/src-tauri', path);
    writeFileSync(destination, edit(name === 'added' ? '' : readFileSync(destination, 'utf8')));
    assert.throws(() => checkAndroidStartupRuntimeVendor(fixture), undefined, name);
  }
});
test('vendor symlink escapes refuse without following the link', () => {
  const fixture = join(work, 'symlink');
  mkdirSync(join(fixture, 'web/src-tauri'), {recursive: true});
  cpSync(join(root, 'web/src-tauri/vendor'), join(fixture, 'web/src-tauri/vendor'), {recursive: true});
  const file = join(fixture, 'web/src-tauri/vendor/tauri-runtime-wry/README.md');
  rmSync(file); symlinkSync('/unowned/not-read', file);
  assert.throws(() => checkAndroidStartupRuntimeVendor(fixture), /No vendor symlinks/);
});

// Compile the actual runtime initialization fields and create_webview early
// return, not generated-app substrings. Only platform cfg names are mapped to
// test cfg names so host std can exercise Android and non-Android selections.
// Wry's native provider/Activity lookup is an explicit fake boundary here.
const begin = runtime.indexOf('  if (!context.webview_runtime_installed');
const guardStart = runtime.indexOf('  if !context.webview_runtime_installed {', runtime.indexOf('fn create_webview<'));
const guardEnd = runtime.indexOf('\n  #[allow(unused_mut)]', guardStart);
assert.equal(begin, -1);
assert.ok(guardStart > 0 && guardEnd > guardStart);
const guard = runtime.slice(guardStart, guardEnd);
const platformCfg = source => source.replaceAll('target_os = "android"', 'test_android').replaceAll('target_os = "macos"', 'test_macos');
const binaries = new Map();
function compileRuntime({android = true, optIn = true, original = false, macos = false} = {}) {
  const key = `${android}-${optIn}-${original}-${macos}`;
  if (binaries.has(key)) return binaries.get(key);
  const path = join(work, `runtime-${key}.rs`), binary = join(work, `runtime-${key}`);
  const fields = original ? originalField : patchedField;
  const source = `
use std::sync::atomic::{AtomicUsize, Ordering};
static LOOKUPS: AtomicUsize = AtomicUsize::new(0);
static CONSTRUCTORS: AtomicUsize = AtomicUsize::new(0);
static PROVIDER: AtomicUsize = AtomicUsize::new(0);
#[derive(Debug, PartialEq)] enum Error { ActivityNotFound, ProviderAbsent, WebviewRuntimeNotInstalled }
#[macro_export] macro_rules! warn { ($($x:tt)*) => { () }; }
mod log { pub use crate::warn; }
mod wry {
 pub fn webview_version() -> Result<String, super::Error> {
  super::LOOKUPS.fetch_add(1, super::Ordering::SeqCst);
  match super::PROVIDER.load(super::Ordering::SeqCst) {
   0 => Err(super::Error::ActivityNotFound),
   1 => Err(super::Error::ProviderAbsent),
   _ => Ok("actual-provider-version".into()),
  }
 }
}
struct Context { webview_runtime_installed: bool }
fn context() -> Context { Context { ${platformCfg(fields)} } }
fn create_webview(context: &Context) -> Result<(), Error> {
 ${platformCfg(guard)}
 CONSTRUCTORS.fetch_add(1, Ordering::SeqCst); Ok(())
}
fn main() {
 let case = std::env::args().nth(1).unwrap();
 match case.as_str() {
  "early-back-reentry" => {
   // No current Activity at runtime setup. A later actual successful app
   // callback authorizes reentry in the same runtime, not a fresh Context.
   let saved = context(); assert_eq!(LOOKUPS.load(Ordering::SeqCst), 0, "no advisory lookup before Ready");
   assert_eq!(CONSTRUCTORS.load(Ordering::SeqCst), 0);
   PROVIDER.store(2, Ordering::SeqCst);
   assert_eq!(create_webview(&saved), Ok(()), "old negative cache cannot refuse async-ready reentry");
  }
  "reentry-no-permanent-negative" => {
   let saved = context();
   PROVIDER.store(2, Ordering::SeqCst);
   assert_eq!(create_webview(&saved), Ok(()), "ActivityNotFound must not permanently reject later async-ready reentry");
  }
  "default-negative-cache" => {
   let saved = context(); assert_eq!(LOOKUPS.load(Ordering::SeqCst), 1);
   PROVIDER.store(2, Ordering::SeqCst);
   assert_eq!(create_webview(&saved), Err(Error::WebviewRuntimeNotInstalled));
   assert_eq!(CONSTRUCTORS.load(Ordering::SeqCst), 0);
  }
  "default-provider-absent" => {
   PROVIDER.store(1, Ordering::SeqCst); let saved = context();
   assert_eq!(LOOKUPS.load(Ordering::SeqCst), 1);
   assert_eq!(create_webview(&saved), Err(Error::WebviewRuntimeNotInstalled));
  }
  "default-success" => {
   PROVIDER.store(2, Ordering::SeqCst); let saved = context();
   assert_eq!(LOOKUPS.load(Ordering::SeqCst), 1); assert_eq!(create_webview(&saved), Ok(()));
  }
  "macos-original-fallback" => {
   let saved = context(); assert_eq!(LOOKUPS.load(Ordering::SeqCst), 1);
   assert_eq!(create_webview(&saved), Ok(()));
  }
  _ => panic!("unknown case"),
 }
 println!("actual-runtime-path passed: {}", case);
}
`;
  writeFileSync(path, source);
  const args = ['--edition', '2021', '--crate-name', 'runtime_path_test', '-o', binary, path];
  if (android) args.push('--cfg', 'test_android');
  if (macos) args.push('--cfg', 'test_macos');
  if (optIn) args.push('--cfg', `feature="${feature}"`);
  const result = spawnSync(process.env.RUSTC || '/opt/homebrew/bin/rustc', args, {encoding: 'utf8', timeout: 30000});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  binaries.set(key, binary); return binary;
}
function execute(binary, scenario) { return spawnSync(binary, [scenario], {encoding: 'utf8', timeout: 5000}); }
const cases = [
  ['Android opted in: no Activity at setup, then same-process actual-ready reentry', {}, 'early-back-reentry'],
  ['Android opted in: actual create path cannot retain an early ActivityNotFound refusal', {}, 'reentry-no-permanent-negative'],
  ['Android default: original ActivityNotFound negative cache retained', {optIn: false}, 'default-negative-cache'],
  ['Android default: real provider-absent rejection retained', {optIn: false}, 'default-provider-absent'],
  ['Android default: installed-provider success retained', {optIn: false}, 'default-success'],
  ['non-Android opted in: original advisory query and refusal retained', {android: false}, 'default-negative-cache'],
  ['non-Android default: original provider success retained', {android: false, optIn: false}, 'default-success'],
  ['macOS even if feature unified: original warn-and-create fallback retained', {android: false, macos: true}, 'macos-original-fallback'],
];
for (const [name, config, scenario] of cases) test(`compiled real runtime path: ${name}`, () => {
  const result = execute(compileRuntime(config), scenario);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
test('individual original-upstream revert fails the exact early-Back/no-Activity regression', () => {
  const result = execute(compileRuntime({original: true}), 'early-back-reentry');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no advisory lookup before Ready/);
  assert.doesNotMatch(result.stderr, /compile error|not found/);
});
test('individual original-upstream revert fails later create_webview after ActivityNotFound', () => {
  const result = execute(compileRuntime({original: true}), 'reentry-no-permanent-negative');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ActivityNotFound must not permanently reject/);
});
