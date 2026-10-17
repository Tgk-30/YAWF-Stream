import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { androidVersionCode,buildAndroidUpdateManifest } from './build_android_update_manifest.mjs';

test('Android version formula is independent of desktop and server channels',()=>{
 assert.equal(androidVersionCode('2.3.15'),2003015);
 for(const value of ['android-v2.3.15','v2.3.15-web','02.3.15','2.1000.1','2.1.1000','9999.1.1','0.0.0']) assert.throws(()=>androidVersionCode(value));
});
test('manifest binds exact APK bytes, version, package, name and source',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'yawf-android-manifest-'));
 try{
  const apk=join(dir,'YAWF.Stream_Android_2.3.14.apk');const bytes=Buffer.from('test fixture bytes, not a signed APK');await writeFile(apk,bytes);
  const result=await buildAndroidUpdateManifest({apk,version:'2.3.14',sourceRevision:'a'.repeat(40)});
  assert.deepEqual(result,{schemaVersion:1,version:'2.3.14',versionCode:2003014,packageName:'com.tgk30.debridstreamer',sourceRevision:'a'.repeat(40),apk:{name:'YAWF.Stream_Android_2.3.14.apk',sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length}});
  await assert.rejects(buildAndroidUpdateManifest({apk,version:'2.3.15',sourceRevision:'a'.repeat(40)}));
  await assert.rejects(buildAndroidUpdateManifest({apk,version:'2.3.14',sourceRevision:'not-a-source'}));
  await writeFile(apk,'');await assert.rejects(buildAndroidUpdateManifest({apk,version:'2.3.14',sourceRevision:'a'.repeat(40)}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
