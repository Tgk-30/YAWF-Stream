import {inverseAndroidOwnedDestroy} from './check_android_owned_destroy_vendor.mjs';
import {checkAndroidCreationVendor} from './check_android_creation_vendor.mjs';
import {createHash} from 'node:crypto';
import {lstatSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const upstreamTree = '249374224cd5e56572d1e803659d03afb1d76a87ad7728fa20dd1bc2f443ebbf';
const patchedTree = '801745cc37bc75365cabf7a0ba993d5a28455c95b47fa1c51db0b60d752db17e';
const archiveSha = '8d61892587aea2a85245bcaec98c6fe46268874c0a0deae5535fb71ca7b93eae';
export const feature = 'android-app-verifies-webview-runtime';
export const originalField = '      webview_runtime_installed: wry::webview_version().is_ok(),';
export const patchedField = `      // Opt-in Android hosts must defer EVERY initial WebView and require actual
      // asynchronous provider startup success before requesting construction.
      // Do not cache an advisory ActivityNotFound result before that host gate.
      #[cfg(all(target_os = "android", feature = "android-app-verifies-webview-runtime"))]
      webview_runtime_installed: true,
      #[cfg(not(all(target_os = "android", feature = "android-app-verifies-webview-runtime")))]
${originalField}`;
const manifestFeature = '# Android-only opt-in: the host gates ALL initial constructors on real async success.\n'+feature+' = ["wry/android-app-create-webview-completion"]\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const treeHash = files => hash(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, sha]) => `${path} ${sha}\n`).join(''));
function inventory(root, relative = '') {
  const result = {};
  for (const name of readdirSync(join(root, relative)).sort()) {
    const path = relative ? `${relative}/${name}` : name;
    const stat = lstatSync(join(root, path));
    assert.ok(!stat.isSymbolicLink(), `No vendor symlinks: ${path}`);
    if (stat.isDirectory()) Object.assign(result, inventory(root, path));
    else {
      assert.ok(stat.isFile(), `No vendor special files: ${path}`);
      result[path] = hash(readFileSync(join(root, path)));
    }
  }
  return result;
}
function exactlyOnce(source, needle) {
  assert.equal(source.split(needle).length, 2, `Expected one exact reviewed patch: ${needle.slice(0, 100)}`);
}

/** Pins the entire upstream inventory and the entire three-file patch, not just anchors. */
export function checkAndroidStartupRuntimeVendor(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const tauri = join(root, 'web/src-tauri');
  const vendor = join(tauri, 'vendor/tauri-runtime-wry');
  const vendorStat = lstatSync(vendor);
  assert.ok(vendorStat.isDirectory() && !vendorStat.isSymbolicLink(), 'Vendor root must be an ordinary directory');
  const provenance = JSON.parse(readFileSync(join(tauri, 'vendor/tauri-runtime-wry.PROVENANCE.json'), 'utf8'));
  assert.equal(provenance.schema, 1);
  assert.equal(provenance.crate, 'tauri-runtime-wry');
  assert.equal(provenance.version, '2.12.2');
  assert.equal(provenance.upstreamArchiveSha256, archiveSha);
  assert.equal(provenance.upstreamTreeSha256, upstreamTree);
  assert.equal(provenance.patchedTreeSha256, patchedTree);
  assert.equal(provenance.patchFeature, feature);
  assert.deepEqual(provenance.patchFiles, ['Cargo.toml', 'Cargo.toml.orig', 'src/lib.rs']);
  assert.equal(treeHash(provenance.upstreamFiles), upstreamTree, 'Pinned official source inventory');
  assert.equal(treeHash(provenance.patchedFiles), patchedTree, 'Pinned reviewed patch inventory');
  const current = inventory(vendor);
  assert.deepEqual(current, provenance.patchedFiles, 'Vendor inventory/content drift');
  const inverse = inverseAndroidOwnedDestroy('tauri-runtime-wry', vendor, current);
  const reconstructed = inverse.files;
  for (const path of provenance.patchFiles) {
    let source = inverse.read(path);
    const patch = path === 'src/lib.rs' ? patchedField : manifestFeature;
    exactlyOnce(source, patch);
    source = source.replace(patch, path === 'src/lib.rs' ? originalField : '');
    reconstructed[path] = hash(source);
  }
  assert.deepEqual(reconstructed, provenance.upstreamFiles, 'Only the three reviewed changes may differ from upstream');
  const cargo = readFileSync(join(tauri, 'Cargo.toml'), 'utf8');
  const android = cargo.split('[target.\'cfg(target_os = "android")\'.dependencies]\n')[1]?.split('\n[')[0];
  assert.ok(android, 'Android target dependencies');
  exactlyOnce(android, `tauri-runtime-wry = { version = "=2.12.2", default-features = false, features = ["${feature}", "android-app-owned-window-destroy"] }`);
  exactlyOnce(cargo, feature);
  exactlyOnce(cargo, 'android-app-owned-window-destroy');
  const overrides = cargo.split('[patch.crates-io]\n')[1]?.split('\n[')[0].split('\n').filter(line => line.trim() && !line.startsWith('#'));
  assert.deepEqual(overrides, ['tauri-runtime-wry = { path = "vendor/tauri-runtime-wry" }', 'wry = { path = "vendor/wry" }'], 'Exactly two reviewed crate path overrides');
  const lock = readFileSync(join(tauri, 'Cargo.lock'), 'utf8');
  const runtime = lock.split('[[package]]').filter(body => /^\s*name = "tauri-runtime-wry"\n/.test(body));
  assert.equal(runtime.length, 1);
  assert.match(runtime[0], /\nversion = "2\.12\.2"\n/);
  assert.doesNotMatch(runtime[0], /\n(?:source|checksum) =/);
  const app = lock.split('[[package]]').find(body => /^\s*name = "debridstreamer"\n/.test(body));
  exactlyOnce(app, ' "tauri-runtime-wry",');
  checkAndroidCreationVendor(root);
  return {crate: provenance.crate, version: provenance.version, archiveSha256: archiveSha, upstreamTreeSha256: upstreamTree, patchedTreeSha256: patchedTree, files: Object.keys(current).length};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--root'), 'Usage: node scripts/check_android_startup_runtime_vendor.mjs [--root PATH]');
  console.log(JSON.stringify(checkAndroidStartupRuntimeVendor(process.argv[3]), null, 2));
}
