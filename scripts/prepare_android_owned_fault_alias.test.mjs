import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const source=process.env.OWNED_ALIAS_TEST_SOURCE||fileURLToPath(new URL('./prepare_android_owned_fault_alias.py',import.meta.url));
const work=mkdtempSync(join(process.env.TMPDIR||tmpdir(),'owned-alias-host-'));after(()=>rmSync(work,{recursive:true,force:true}));
const base=String.raw`
import argparse,importlib.util,pathlib,sys,os,json,hashlib,tempfile,shutil,zipfile,io
sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent));sys.path.insert(0,str(pathlib.Path(sys.argv[2])/'scripts'))
spec=importlib.util.spec_from_file_location('alias',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
original_module=pathlib.Path(sys.argv[2])/'scripts/android-owned-destroy-instrumentation'
def code(name,alias,call=False,opcode='invoke-virtual'):
 return '.class public abstract L'+name.replace('.','/')+';\n.super Ljava/lang/Object;\n# virtual methods\n.method public '+(alias+m.METHOD if name==m.PLUGIN else 'dispatch()V')+'\n    .registers 2\n'+('    '+opcode+' {v0, p1}, Lapp/tauri/plugin/Plugin;->'+alias+m.METHOD+'\n'if call else '')+'    return-void\n.end method\n'
class Tool:
 platform='linux'
 def __init__(self,root,alias):self.environ={'GITHUB_ACTIONS':'true','RUNNER_TEMP':str(root)};self.alias=alias;self.missing=False;self.opcode='invoke-virtual';self.calls=[]
 def analyze(self,executable,name,apk,guard,temporary):
  assert name in m.CLASSES;assert executable.name=='apkanalyzer';assert apk.name=='YAWF.Stream_Android_2.3.114.apk';guard();self.calls.append(name)
  return code(name,self.alias,not self.missing and name==m.CLASSES[0],self.opcode)
class Fixture:
 def __init__(self,alias='a'):
  self.tmp=tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']);self.root=pathlib.Path(self.tmp.name).resolve();self.inputs=self.root/'input';self.phone=self.inputs/'phone';self.api=self.inputs/'api';self.phone.mkdir(parents=True);self.api.mkdir();self.module=self.root/'module';shutil.copytree(original_module,self.module);self.output=self.root/'build';sdk=self.root/'sdk';tool=sdk/'cmdline-tools/latest/bin/apkanalyzer';tool.parent.mkdir(parents=True);tool.write_text('fake never executed');tool.chmod(0o755)
  self.args=argparse.Namespace(inputs=str(self.inputs),source='1'*40,run='12345',module=str(self.module),output=str(self.output),sdk=str(sdk));self.tools=Tool(self.root,alias)
  self.mapping='app.tauri.plugin.Plugin -> app.tauri.plugin.Plugin:\n    1:1:void load(android.webkit.WebView):0:0 -> '+alias+'\nother.Class -> z:\n'
  self.runtime=code(m.PLUGIN,alias)
  apk=b'fake ordinary APK from selected run';(self.phone/'YAWF.Stream_Android_2.3.114.apk').write_bytes(apk)
  self.manifest={'schemaVersion':1,'version':'2.3.114','versionCode':2003114,'packageName':'com.tgk30.debridstreamer','sourceRevision':self.args.source,'apk':{'name':'YAWF.Stream_Android_2.3.114.apk','sha256':m.sha(apk),'size':len(apk)}}
  jar=io.BytesIO()
  with zipfile.ZipFile(jar,'w')as archive:
   for name in ['Plugin','PluginManager','PluginHandle']:archive.writestr('app/tauri/plugin/'+name+'.class',b'public fixture class')
  (self.api/'tauri-android-api-classes.jar').write_bytes(jar.getvalue())
  self.receipt={'schemaVersion':1,'crateName':'tauri','crateVersion':'2.12.4','crateChecksum':m.CRATE,'archiveSha256':m.CRATE,'sourceFiles':m.SOURCE_FILES,'classesJarSha256':m.sha(jar.getvalue()),'buildEnvironment':'fake-public-producer','jarEntryCount':3,'jarClassCount':3}
  self.binding={'schemaVersion':1,'scope':'COMPILE_ONLY_API_OUTPUT_NOT_RUNTIME_QUALIFICATION','source':self.args.source,'runId':self.args.run,'ordinaryApkBuildInSameJob':True,'producerTaskInvokedInThisJob':True,'producerTask':':tauri-android:bundleLibCompileToJarRelease','gradleProject':':tauri-android','freshCompilationClaim':False,'minifiedHookAvailabilityClaim':False}
  metadata=lambda name:{'id':1 if 'candidate'in name else 2,'name':name,'size_in_bytes':1,'digest':'sha256:'+'2'*64}
  self.candidate={'source':self.args.source,'runId':self.args.run,'artifacts':{n:metadata(n)for n in ['android-phone-verification-candidate','android-phone-api-fixture']}}
  self.refresh()
 def refresh(self):
  (self.inputs/'candidate-run.json').write_text(json.dumps(self.candidate));(self.phone/'android-update.json').write_text(json.dumps(self.manifest))
  (self.api/'android-r8-mapping.txt').write_text(self.mapping);(self.api/'plugin-runtime-code.txt').write_text(self.runtime)
  self.binding.update(releaseMappingSha256=m.sha(self.mapping.encode()),pluginRuntimeCodeSha256=m.sha(self.runtime.encode()));(self.api/'api-build-binding.json').write_text(json.dumps(self.binding));(self.api/'api-source-receipt.json').write_text(json.dumps(self.receipt))
  for folder in [self.phone,self.api]:
   files=sorted(p for p in folder.iterdir()if p.name!='SHA256SUMS');(folder/'SHA256SUMS').write_text(''.join(m.sha(p.read_bytes())+'  '+p.name+'\n'for p in files))
 def close(self):self.tmp.cleanup()
def rejected(f,wanted=None):
 try:m.prepare(f.args,f.tools)
 except m.Refusal as e:
  if wanted:assert str(e)==wanted,(str(e),wanted)
 else:raise AssertionError('unqualified adapter accepted')
 assert not f.output.exists(),'refusal must not write prepared output'
`;
function run(body){const r=spawnSync('python3',['-B','-c',base+'\n'+body,source,root],{encoding:'utf8',timeout:20000,env:{...process.env,TMPDIR:work,PYTHONDONTWRITEBYTECODE:'1'}});assert.equal(r.status,0,r.stdout+r.stderr);}
test('test-only alias bridge preserves ten exact originals and binds callsites; unchanged load needs no bridge',()=>run(String.raw`
for alias in ['a','load']:
 f=Fixture(alias)
 try:
  result=m.prepare(f.args,f.tools);assert result['scope']==m.SCOPE;assert result['faultAlias']==alias;assert len(result['originalModuleFiles'])==10;assert result['originalModuleFiles']==m.MODULE_FILES;assert set(result['adaptedModuleFiles'])==set(m.MODULE_FILES);assert f.tools.calls==list(m.CLASSES)
  original=(f.module/m.FAULT).read_text();copied=(f.output/'module'/m.FAULT).read_text();assert '    @Override\n    public void load(WebView webView)'in copied
  if alias=='a':assert 'public void a(WebView value) { load(value); }'in copied;assert copied!=original
  else:assert copied==original
  for name in m.MODULE_FILES:
   if name!=m.FAULT:assert result['adaptedModuleFiles'][name]==result['originalModuleFiles'][name]
  assert result['candidate']['source']==f.args.source;assert result['candidate']['runId']==f.args.run;assert 'finalTestApk'not in result
 finally:f.close()
`));
test('mapping ambiguity, nonvirtual/nonextensible methods, wrong signature, unsafe alias and collisions refuse',()=>run(String.raw`
for mode in ['ambiguous','renamed','final-class','private','static','final-method','wrong-signature','unsafe','keyword','collision']:
 alias={'unsafe':'bad-name','keyword':'return','collision':'loadCount'}.get(mode,'a');f=Fixture(alias)
 try:
  if mode=='ambiguous':f.mapping=f.mapping.replace('other.Class -> z:','    void load(android.webkit.WebView) -> b\nother.Class -> z:')
  if mode=='renamed':f.mapping=f.mapping.replace('Plugin -> app.tauri.plugin.Plugin:','Plugin -> renamed.Plugin:')
  if mode=='final-class':f.runtime=f.runtime.replace('.class public abstract','.class public final')
  if mode=='private':f.runtime=f.runtime.replace('.method public a(','.method private a(')
  if mode=='static':f.runtime=f.runtime.replace('.method public a(','.method public static a(')
  if mode=='final-method':f.runtime=f.runtime.replace('.method public a(','.method public final a(')
  if mode=='wrong-signature':f.runtime=f.runtime.replace('(Landroid/webkit/WebView;)V','(Ljava/lang/Object;)V')
  f.refresh();rejected(f);assert not f.tools.calls
 finally:f.close()
`));
test('source/run/hash/API binding and unexpected source or links refuse before any tool or copy',()=>run(String.raw`
for mode in ['source','run','hash','crate','extra','symlink']:
 f=Fixture()
 try:
  if mode=='source':f.candidate['source']='3'*40;f.refresh()
  if mode=='run':f.binding['runId']='23456';f.refresh()
  if mode=='hash':(f.api/'plugin-runtime-code.txt').write_text(f.runtime+'\n')
  if mode=='crate':f.receipt['crateChecksum']='0'*64;f.refresh()
  if mode=='extra':(f.module/'unexpected.java').write_text('unexpected source')
  if mode=='symlink':p=f.module/'README.md';p.unlink();p.symlink_to(original_module/'README.md')
  rejected(f);assert not f.tools.calls
 finally:f.close()
`));
test('actual virtual callsite is required, not a dead declaration, comment or nonvirtual invocation',()=>run(String.raw`
for mode in ['missing','static','direct','super']:
 f=Fixture()
 try:
  if mode=='missing':f.tools.missing=True
  else:f.tools.opcode='invoke-'+mode
  rejected(f,'VIRTUAL_DISPATCH_CALLSITE_MISSING')
 finally:f.close()
f=Fixture()
try:
 assert m.virtual_calls(code(m.CLASSES[0],'a',True).replace('invoke-virtual','    # invoke-virtual'),m.CLASSES[0],'a')==0
 range_code=code(m.CLASSES[0],'a',True,'invoke-virtual/range').replace('{v0, p1}','{v0 .. v1}');assert m.virtual_calls(range_code,m.CLASSES[0],'a')==1
finally:f.close()
`));
