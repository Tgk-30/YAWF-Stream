import {inverseAndroidOwnedDestroy} from './check_android_owned_destroy_vendor.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, lstatSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
export const creationFeature = 'android-app-create-webview-completion';
export const manifestFeature = '# Android app opt-in: retain the pipe for post-storage identity acknowledgement.\n'+creationFeature+' = []\n';
export const originalRecv = '      self.handle_message(package, activity_id, message)?;';
export const patchedRecv = `      #[cfg(all(target_os = "android", feature = "android-app-create-webview-completion"))]
      {
        let creating = matches!(&message, WebViewMessage::CreateWebView(_));
        if let Err(error) = self.handle_message(package, activity_id, message) {
          if !creating {
            return Err(error);
          }
          // Only this opted-in app acknowledges creation from a later FIFO JNI
          // message. A failed create must not unregister the pipe before it.
          if self.env.exception_check()? {
            self.env.exception_clear()?;
          }
        }
      }
      #[cfg(not(all(target_os = "android", feature = "android-app-create-webview-completion")))]
${originalRecv}`;
export const originalPlugin = `            tracing::warn!("failed to run webview created hook: {_e}");`;
export const patchedPlugin = originalPlugin+`
            #[cfg(all(target_os = "android", feature = "android-app-create-webview-completion"))]
            {
              // A failed app/plugin hook is not a stored, usable WebView for
              // this opt-in host, even when it returned a non-JNI error.
              if self.env.exception_check()? {
                self.env.exception_clear()?;
              }
              return Ok(());
            }`;
const hash = data => createHash('sha256').update(data).digest('hex');
const tree = files => hash(Object.entries(files).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([p,h])=>`${p} ${h}\n`).join(''));
function inventory(root, relative='') {
  const rows={};
  for(const name of readdirSync(join(root,relative)).sort()) {
    const path=relative?`${relative}/${name}`:name, stat=lstatSync(join(root,path));
    assert.ok(!stat.isSymbolicLink(),'No Wry vendor symlinks');
    if(stat.isDirectory())Object.assign(rows,inventory(root,path));
    else {assert.ok(stat.isFile(),'No Wry vendor special files');rows[path]=hash(readFileSync(join(root,path)));}
  }
  return rows;
}
export function checkAndroidCreationVendor(root=resolve(dirname(fileURLToPath(import.meta.url)),'..')) {
  const tauri=join(root,'web/src-tauri'),vendor=join(tauri,'vendor/wry');
  const stat=lstatSync(vendor);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());
  const p=JSON.parse(readFileSync(join(tauri,'vendor/wry.PROVENANCE.json'),'utf8'));
  assert.equal(p.schema,1);assert.equal(p.crate,'wry');assert.equal(p.version,'0.57.0');
  assert.equal(p.upstreamArchiveSha256,'a819957a01b3119af85e638a38d242af76dbc87d130dca67bfd0441072e21ff0');
  assert.equal(p.upstreamTreeSha256,'81150226bcaee84520d6e2c79e0b0925d2430c461e81ba18d36dfb81140c6906');
  assert.equal(p.patchedTreeSha256,'6feec215173ea5e574741128c4065a4363f0131f1364d5e9548e0c4f0f4efa1a');
  assert.deepEqual(p.patchFiles,['Cargo.toml','Cargo.toml.orig','build.rs','src/android/binding.rs','src/android/main_pipe.rs','src/android/mod.rs','src/android/owned/WryActivity.kt','src/android/owned/proguard-wry.pro','src/lib.rs']);
  assert.equal(tree(p.upstreamFiles),p.upstreamTreeSha256);assert.equal(tree(p.patchedFiles),p.patchedTreeSha256);
  const current=inventory(vendor);assert.deepEqual(current,p.patchedFiles,'Entire Wry patch inventory/content drift');
  const inverse=inverseAndroidOwnedDestroy('wry',vendor,current);
  const reconstructed=inverse.files;
  for(const name of ['Cargo.toml','Cargo.toml.orig','src/android/main_pipe.rs']) {
    let text=inverse.read(name);
    for(const [after,before]of name.endsWith('.rs')?[[patchedRecv,originalRecv],[patchedPlugin,originalPlugin]]:[[manifestFeature,'']]) {
      assert.equal(text.split(after).length,2,'Exactly one reviewed Wry delta');text=text.replace(after,before);
    }
    reconstructed[name]=hash(text);
  }
  assert.deepEqual(reconstructed,p.upstreamFiles,'Only reviewed Wry deltas may differ');
  const lock=readFileSync(join(tauri,'Cargo.lock'),'utf8');const entry=lock.split('[[package]]').filter(x=>/^\s*name = "wry"\n/.test(x));
  assert.equal(entry.length,1);assert.match(entry[0],/\nversion = "0\.57\.0"\n/);assert.doesNotMatch(entry[0],/\n(?:source|checksum) =/);
  return {crate:p.crate,version:p.version,files:Object.keys(current).length,upstreamTreeSha256:p.upstreamTreeSha256,patchedTreeSha256:p.patchedTreeSha256};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(checkAndroidCreationVendor(),null,2));
