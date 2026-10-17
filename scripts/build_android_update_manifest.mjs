#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export function androidVersionCode(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Invalid Android version');
  const [a,b,c] = version.split('.').map(Number);
  const code = a * 1_000_000 + b * 1_000 + c;
  if (b>999 || c>999 || !Number.isSafeInteger(code) || code<1 || code>2147483647) throw new Error('Invalid Android version code');
  return code;
}

/** Run only after production APK signature, manifest, payload and alignment verification. */
export async function buildAndroidUpdateManifest({ apk, version, sourceRevision }) {
  const versionCode = androidVersionCode(version);
  const name = `YAWF.Stream_Android_${version}.apk`;
  if (basename(apk)!==name || !/^[0-9a-f]{40}$/.test(sourceRevision)) throw new Error('APK identity or source revision is invalid');
  const info = await stat(apk);
  if (!info.isFile() || info.size<1 || info.size>160*1024*1024) throw new Error('APK size is invalid');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(apk)) hash.update(chunk);
  const after = await stat(apk);
  if (after.size!==info.size || after.mtimeMs!==info.mtimeMs || after.ino!==info.ino) throw new Error('APK changed while hashing');
  return {schemaVersion:1,version,versionCode,packageName:'com.tgk30.debridstreamer',sourceRevision,apk:{name,sha256:hash.digest('hex'),size:info.size}};
}

if (process.argv[1]===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  const values={};
  for(let i=0;i<args.length;i+=2) {
    if (!['--apk','--version','--source','--output'].includes(args[i]) || !args[i+1] || values[args[i]]) throw new Error('Use --apk --version --source --output exactly once');
    values[args[i]]=args[i+1];
  }
  if(Object.keys(values).length!==4) throw new Error('Missing manifest build arguments');
  const manifest=await buildAndroidUpdateManifest({apk:values['--apk'],version:values['--version'],sourceRevision:values['--source']});
  await writeFile(values['--output'],JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
}
