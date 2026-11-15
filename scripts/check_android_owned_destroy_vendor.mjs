import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytes=readFileSync(new URL('./android_owned_destroy_vendor_patch.json',import.meta.url));
assert.equal(sha(bytes),'48864b23bebd1912ee12beeeb29d82d083cde627e2bac48703a46c61a4f6829f','Reviewed owned-destroy inverse patch drift');
const reviewed=JSON.parse(bytes);
/** Undo only the reviewed additive correction before prior upstream reconstruction. */
export function inverseAndroidOwnedDestroy(crate,vendor,current) {
 const patch=reviewed[crate];assert.ok(patch,'Only the two approved crates');
 const files={...current},texts=new Map();
 for(const [path,delta]of Object.entries(patch)){
  let text=readFileSync(join(vendor,path),'utf8');
  if(Object.hasOwn(delta,'added')){
   assert.equal(text,delta.added,'Exact feature-only added template/rules');delete files[path];continue;
  }
  for(const {before,after}of [...delta.hunks].reverse()){
   assert.equal(text.split(after).length,2,`Exactly one owned-destroy inverse hunk: ${crate}/${path}`);
   text=text.replace(after,before);
  }
  files[path]=sha(text);texts.set(path,text);
 }
 return {files,read:path=>texts.get(path)??readFileSync(join(vendor,path),'utf8')};
}
