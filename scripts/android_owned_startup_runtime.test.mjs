import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

// Source override is a host-test seam only, never a controller CLI option.
const source=process.env.OWNED_STARTUP_CONTROLLER_TEST_SOURCE||fileURLToPath(new URL('./android_owned_startup_runtime.py',import.meta.url));
const work=mkdtempSync(join(process.env.TMPDIR||tmpdir(),'owned-controller-host-'));
after(()=>rmSync(work,{recursive:true,force:true}));
const fixture=String.raw`
import argparse, importlib.util, json, os, pathlib, struct, tempfile, hashlib, zlib, zipfile, sys, io, unittest.mock as mock
spec=importlib.util.spec_from_file_location('controller',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def dex(name, definition):
 raw=name.encode(); data=bytes([len(raw)])+raw+b'\0'; strings=112; types=116; classes=120 if definition else 0; offset=152 if definition else 120
 b=bytearray(offset+len(data));b[:8]=b'dex\n035\0';struct.pack_into('<III',b,32,len(b),112,0x12345678)
 for at,count,loc in [(56,1,strings),(64,1,types),(96,int(definition),classes),(104,len(data),offset)]:struct.pack_into('<II',b,at,count,loc)
 struct.pack_into('<I',b,strings,offset);struct.pack_into('<I',b,types,0)
 if definition:struct.pack_into('<IIIIIIII',b,classes,0,1,0xffffffff,0,0xffffffff,0,0,0)
 b[offset:]=data;b[12:32]=hashlib.sha1(b[32:]).digest();struct.pack_into('<I',b,8,zlib.adler32(b[12:])&0xffffffff);return bytes(b)

def proof():
 value={key:True for key in m.BOOL_FIELDS};value.update(schemaVersion=1,scope='selected_first_plugin_load_failure_then_one_native_retry',phase='QUALIFIED_SELECTED_STARTUP_RETRY_ONLY',qualification=True,failureCode='',elapsedMs=10000,tapCount=1,targetActivityCreates=1,pluginLoadCount=2);return value

def output(value=None):
 return '\n'.join(['INSTRUMENTATION_STATUS: class='+m.TEST_CLASS,'INSTRUMENTATION_STATUS: test='+m.METHOD,'INSTRUMENTATION_STATUS: numtests=1','INSTRUMENTATION_STATUS: owned_destroy_evidence='+json.dumps(value or proof()),'INSTRUMENTATION_STATUS_CODE: 0','INSTRUMENTATION_RESULT: stream=','OK (1 test)','INSTRUMENTATION_CODE: -1',''])

class Fake(m.System):
 platform='linux'
 def __init__(self,root,admission):
  self.environ={'RUNNER_TEMP':str(root),'GITHUB_ACTIONS':'true','PATH':'/public/tools'};self.admission=admission;self.calls=[];self.bad_cert=False;self.bad_package=False;self.debug=False;self.wrong_runner=False;self.extra=False;self.changed=False;self.changed_command=False;self.timeout=False;self.empty_target_version=False;self.unqualified=False;self.wrong_avd=False;self.instrument_output=None;self.instrument_stderr=b'';self.instrument_exit=0
 def process(self,pid):
  item=next(x for x in [self.admission['emulator'],self.admission['adbServer']]if x['pid']==pid);return item['startTicks']+int(self.changed),[x.encode()for x in item['cmdline']]+([b'foreign']if self.changed_command else [])
 def port_owned(self,pid,port):return pid==2345 and port==5142
 def free(self,root):return 9*1024**3
 def allocation(self,root):return 100000
 def run(self,argv,seconds,limit,guard,env):
  self.calls.append(argv);guard();tool=pathlib.Path(argv[0]).name
  if tool=='adb':
   assert argv[1:7]==['-H','127.0.0.1','-P','5142','-s','emulator-5568'];assert env['ADB_SERVER_SOCKET']=='tcp:127.0.0.1:5142'
   command=argv[7:]
   if command==['devices','-l']:text='List of devices attached\nemulator-5568 device product:public model:public transport_id:1\n'+('other device\n'if self.extra else '')
   elif command==['shell','getprop','ro.build.version.sdk']:text='36\n'
   elif command==['shell','getprop','ro.boot.qemu.avd_name']:text=('foreign36' if self.wrong_avd else 'owned36')+'\n'
   elif command[:4]==['shell','pm','list','packages']:text=''
   elif command[0]=='install':text='Performing Push Install\nSuccess\n'
   elif command[:3]==['shell','am','instrument']:
    if self.timeout:raise m.Refusal('HARD_SUBPROCESS_TIMEOUT')
    if self.instrument_output is not None:return self.instrument_exit,self.instrument_output,self.instrument_stderr
    if self.unqualified:
     value=proof();value.update(qualification=False,phase='LAUNCH_ONCE',failureCode='LAUNCH_ONCE_FAILED');text=output(value)
    else:text=output()
   else:raise AssertionError('unexpected command')
  elif tool=='aapt':
   target=pathlib.Path(argv[-1]).name=='target.apk';package=(m.TARGET if target else m.TEST_PACKAGE);version='2.3.112' if target else '';code='2003112'if target else ''
   if self.empty_target_version and target:version='';code=''
   if self.bad_package and target:package='foreign.package'
   text="package: name='%s' versionCode='%s' versionName='%s'\n"%(package,code,version)
   if target and self.debug:text+='application-debuggable\n'
   if not target:text+="instrumentation: name='%s' targetPackage='%s'\n"%('foreign.runner'if self.wrong_runner else m.RUNNER,m.TARGET)
  elif tool=='apkanalyzer':text='<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="'+m.TEST_PACKAGE+'"><instrumentation android:name="'+('foreign.runner'if self.wrong_runner else m.RUNNER)+'" android:targetPackage="'+m.TARGET+'"/></manifest>'
  elif tool=='apksigner':text='Signer #1 certificate DN: PRIVATE_NOT_RETAINED\nSigner #1 certificate SHA-256 digest: '+('b'*64 if self.bad_cert else 'a'*64)+'\n'
  else:raise AssertionError('unexpected executable')
  return 0,text.encode(),b''

class Fixture:
 def __init__(self):
  self.temporary=tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']);self.root=pathlib.Path(self.temporary.name).resolve();self.job=self.root/'job';self.job.mkdir();self.avd=self.job/'owned36.avd';self.avd.mkdir();sdk=self.root/'sdk'
  for name in ['platform-tools/adb','build-tools/36.0.0/aapt','build-tools/36.0.0/apksigner','cmdline-tools/latest/bin/apkanalyzer']:
   p=sdk/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('fake never executed');p.chmod(0o755)
  android_jar=sdk/'platforms/android-36/android.jar';android_jar.parent.mkdir(parents=True)
  with zipfile.ZipFile(android_jar,'w')as archive:
   for name in ['java/lang/RuntimeException.class','java/lang/IllegalStateException.class','java/lang/Object.class']:archive.writestr(name,b'public SDK fixture class')
  target=self.job/'target.apk';test=self.job/'test.apk'
  for p,name in [(target,'Lproduct/Main;'),(test,'Ltest/Observer;')]:
   with zipfile.ZipFile(p,'w')as archive:archive.writestr('classes.dex',dex(name,True))
  bind=lambda p:{'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size}
  self.adm={'schemaVersion':1,'scope':'ROOT_OWNED_FRESH_HOSTED_API36','freshUserdata':True,'jobRoot':str(self.job),'avdName':'owned36','avdPath':str(self.avd),'serial':'emulator-5568','adbPort':5142,'emulator':{'pid':1234,'startTicks':100,'cmdline':['qemu','-avd','owned36','-datadir',str(self.avd),'-port','5568']},'adbServer':{'pid':2345,'startTicks':200,'cmdline':['adb','-L','tcp:127.0.0.1:5142','server']},'targetApk':bind(target),'testApk':bind(test),'sourceRevision':'1'*40}
  self.file=self.job/'admission.json';self.file.write_text(json.dumps(self.adm));self.fake=Fake(self.root,self.adm)
  self.args=argparse.Namespace(sdk=str(sdk),adb_port=5142,serial='emulator-5568',owned_admission=str(self.file),target_apk=str(target),test_apk=str(test),expected_version='2.3.112',expected_code=2003112,expected_cert='a'*64,evidence_dir=str(self.job/'evidence'),timeout=180)
 def close(self):self.temporary.cleanup()

def rejects(function,code=None):
 try:function()
 except m.Refusal as error:
  if code:assert str(error)==code,(str(error),code)
 else:raise AssertionError('unsafe input accepted')
`;
function run(body){
 const result=spawnSync('python3',['-B','-c',fixture+'\n'+body,source],{encoding:'utf8',timeout:15000,env:{...process.env,TMPDIR:work,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(result.status,0,result.stdout+result.stderr);
}

test('runtime controller refuses wrong host, target, signer and live process/device bindings before install',()=>run(String.raw`
for mode,code in [('platform','HOST_NOT_ADMITTED'),('empty-target-version','TARGET_APK_METADATA'),('package','TARGET_APK_METADATA'),('debug','TARGET_APK_METADATA'),('certificate','APK_CERTIFICATE'),('runner','TEST_INSTRUMENTATION'),('birth','OWNED_PROCESS_CHANGED'),('inventory','DEVICE_INVENTORY'),('guest-name','GUEST_AVD_NAME'),('hash','APK_BINDING'),('cmdline','OWNED_PROCESS_CHANGED'),('reserve','STORAGE_BOUND'),('allocation','STORAGE_BOUND'),('port','CLI_IDENTITY'),('symlink','NONCANONICAL_PATH')]:
 f=Fixture()
 try:
  if mode=='platform':f.fake.platform='darwin'
  if mode=='empty-target-version':f.fake.empty_target_version=True
  if mode=='package':f.fake.bad_package=True
  if mode=='debug':f.fake.debug=True
  if mode=='certificate':f.fake.bad_cert=True
  if mode=='runner':f.fake.wrong_runner=True
  if mode=='birth':f.fake.changed=True
  if mode=='inventory':f.fake.extra=True
  if mode=='guest-name':f.fake.wrong_avd=True
  if mode=='cmdline':f.fake.changed_command=True
  if mode=='reserve':f.fake.free=lambda root:m.RESERVE-1
  if mode=='allocation':f.fake.allocation=lambda root:m.CAP+1
  if mode=='port':f.args.adb_port=5037
  if mode=='symlink':
   link=f.job/'alias.apk';link.symlink_to(f.args.target_apk);f.args.target_apk=str(link)
  if mode=='hash':f.adm['targetApk']['sha256']='0'*64;f.file.write_text(json.dumps(f.adm))
  rejects(lambda:m.Controller(f.args,f.fake).run(),code)
  assert not any('install'in c or 'instrument'in c for c in f.fake.calls)
 finally:f.close()
`));

test('DEX class definitions, not strings or references, control the bundled Tauri refusal',()=>run(String.raw`
assert m.dex_class_counts(dex('Lapp/tauri/plugin/Plugin;',False))==(0,0)
assert m.dex_class_counts(dex('Ltest/Observer;',True))==(1,0)
assert m.dex_class_counts(dex('Lapp/tauri/plugin/Plugin;',True))==(1,1)
f=Fixture()
try:
 p=pathlib.Path(f.args.test_apk)
 with zipfile.ZipFile(p,'w')as archive:archive.writestr('classes.dex',dex('Lapp/tauri/plugin/Plugin;',True))
 rejects(lambda:m.no_tauri_definitions(p),'BUNDLED_TAURI_CLASS_DEFINITION')
 with zipfile.ZipFile(p,'w')as archive:
  archive.writestr('classes.dex',dex('Ltest/Observer;',True));archive.writestr('classes10.dex',dex('Lapp/tauri/plugin/Plugin;',True))
 rejects(lambda:m.no_tauri_definitions(p),'BUNDLED_TAURI_CLASS_DEFINITION')
 broken=bytearray(dex('Ltest/Observer;',True));broken[60:64]=b'\xff'*4
 rejects(lambda:m.dex_class_counts(bytes(broken)),'DEX_INTEGRITY')
finally:f.close()
`));

test('only one complete exact-schema final evidence plus genuine JUnit completion qualifies',()=>run(String.raw`
assert m.evidence(output())==proof()
xml='<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="'+m.TEST_PACKAGE+'"><instrumentation android:name="'+m.RUNNER+'" android:targetPackage="'+m.TARGET+'"/></manifest>'
assert m.test_instrumentation_matches(xml)
for invalid in [xml.replace(m.TARGET,'foreign.target'),xml.replace(m.RUNNER,'foreign.runner'),xml.replace('</manifest>','<instrumentation/></manifest>'),'<manifest>', '<!DOCTYPE a>'+xml]:
 assert not m.test_instrumentation_matches(invalid)
assert m.install_succeeded('Success\n') and m.install_succeeded('Performing Push Install\nSuccess\n')
for text in ['Success\nFailure [x]','Failure [x]\nSuccess','Success\nSuccess','unrecognized\nSuccess','Performing Push Install\n']:
 assert not m.install_succeeded(text)
for field in m.BOOL_FIELDS:
 value=proof();value[field]=False;rejects(lambda:m.evidence(output(value)),'MODULE_FACTS')
for phase,code,wanted in [('LAUNCH_ONCE','LAUNCH_ONCE_FAILED','LAUNCH_ONCE_FAILED'),('LAUNCH_ONCE','https://private.invalid/secret','UNRECOGNIZED_MODULE_FAILURE'),('https://private.invalid/phase','arbitrary secret','UNRECOGNIZED_MODULE_FAILURE')]:
 value=proof();value.update(qualification=False,phase=phase,failureCode=code)
 try:m.evidence(output(value))
 except m.Refusal as error:
  assert error.module_evidence is not None;assert error.module_evidence['failureCode']==wanted
  serialized=json.dumps(error.module_evidence);assert 'private.invalid'not in serialized and 'arbitrary secret'not in serialized
 else:raise AssertionError('unqualified record accepted')
for bad in [{'url':'https://private.invalid/secret'},{'targetPidMatched':'https://private.invalid/secret'}]:
 value=proof();value.update(bad)
 try:m.evidence(output(value))
 except m.Refusal as error:assert error.module_evidence is None
 else:raise AssertionError('unknown keys/arbitrary typed fields leaked')
for change in ['malformed','duplicate-record','unknown-key','false','two-loads','failure','completion','junit','duplicate-key']:
 value=proof();text=output(value)
 if change=='malformed':text=text.replace(json.dumps(value),'{')
 if change=='duplicate-record':text+=text
 if change=='unknown-key':value['url']='https://must-not-be-serialized.invalid';text=output(value)
 if change=='false':value['oldDetachedBeforeTap']=False;text=output(value)
 if change=='two-loads':value['pluginLoadCount']=3;text=output(value)
 if change=='failure':value['qualification']=False;value['phase']='LAUNCH_ONCE';text=output(value)
 if change=='completion':text=text.replace('INSTRUMENTATION_CODE: -1','INSTRUMENTATION_CODE: 0')
 if change=='junit':text=text.replace('OK (1 test)','FAILURES!!!')
 if change=='duplicate-key':text=text.replace('"schemaVersion": 1','"schemaVersion": 1, "schemaVersion": 1')
 rejects(lambda:m.evidence(text))
`));

test('one install each and one instrumentation; hard timeout kills only its own client, never an emulator',()=>run(String.raw`
f=Fixture()
try:
 result=m.Controller(f.args,f.fake).run();assert result['qualification']is True;assert result['scope']==m.SCOPE
 assert len([c for c in f.fake.calls if 'install'in c])==2
 assert len([c for c in f.fake.calls if 'instrument'in c])==1
 assert 'PRIVATE_NOT_RETAINED'not in json.dumps(result)
 assert (pathlib.Path(f.args.evidence_dir)/'OWNED_STARTUP.json').is_file()
finally:f.close()
f=Fixture()
try:
 f.fake.unqualified=True
 argv=['controller']
 for key,value in vars(f.args).items():argv+=['--'+key.replace('_','-'),str(value)]
 with mock.patch.object(m,'System',return_value=f.fake),mock.patch.object(sys,'argv',argv),mock.patch('sys.stdout',new_callable=io.StringIO):
  assert m.main()==1
 saved=json.loads((pathlib.Path(f.args.evidence_dir)/'OWNED_STARTUP.json').read_text());assert saved['qualification']is False;assert saved['moduleEvidence']['qualification']is False;assert saved['moduleEvidence']['failureCode']=='LAUNCH_ONCE_FAILED';assert 'PRIVATE_NOT_RETAINED'not in json.dumps(saved)
finally:f.close()
f=Fixture()
try:
 f.fake.timeout=True;rejects(lambda:m.Controller(f.args,f.fake).run(),'HARD_SUBPROCESS_TIMEOUT');assert len([c for c in f.fake.calls if 'instrument'in c])==1
finally:f.close()
# Run the real bounded subprocess driver against a fake process with real pipe
# descriptors, no actual SDK child. Model a hung startActivitySync/runOnMainSync.
class Child:
 pid=987654;returncode=None
 def __init__(self):
  self.r1,self.w1=os.pipe();self.r2,self.w2=os.pipe();self.stdout=os.fdopen(self.r1,'rb');self.stderr=os.fdopen(self.r2,'rb')
 def poll(self):return self.returncode
 def wait(self,timeout=None):self.returncode=-15;return self.returncode
child=Child();system=m.System();ticks=iter([0,1,2,3]);system.clock=lambda:next(ticks);system.process=lambda pid:(77,[b'owned-client']);signals=[]
try:
 with mock.patch.object(m.subprocess,'Popen',return_value=child),mock.patch.object(m.os,'getpgid',return_value=child.pid),mock.patch.object(m.os,'killpg',side_effect=lambda pid,sig:signals.append((pid,sig))):
  rejects(lambda:system.run(['fake-adb'],0.5,1024,lambda:None,{}),'HARD_SUBPROCESS_TIMEOUT')
 assert signals==[(child.pid,m.signal.SIGTERM)]
finally:os.close(child.w1);os.close(child.w2)
`));


test('fixed instrumentation signals survive missing evidence without retaining arbitrary output',()=>run(String.raw`
private='https://private.invalid/path?token=private-value /private/owner/file PRIVATE_MESSAGE'
expected={'NoClassDefFoundError','ClassNotFoundException','UnsatisfiedLinkError','VerifyError','SecurityException','IllegalStateException','RuntimeException','instrumentationRunFailed','processCrashed','junitStarted','ownedTestClassMentioned','ownedRunnerClassMentioned'}
expected|={'missingAndroidxTest','missingAndroidxAppcompat','missingAndroidxCore','missingTauri','missingKotlin','missingOwnedTest','missingOwnedTarget','missingOther','androidJUnitRunnerMentioned','instrumentationRegistryMentioned','androidJUnit4ClassRunnerMentioned','appCompatActivityMentioned','coreComponentFactoryMentioned','pluginMentioned','pluginManagerMentioned','pluginHandleMentioned'}
expected|={'NoSuchMethodError','NoSuchFieldError','AbstractMethodError','IncompatibleClassChangeError','ExceptionInInitializerError','IllegalAccessError','ClassCastException','AssertionError','OutOfMemoryError','FatalSignal','SIGABRT','SIGSEGV'}
text=('java.lang.NoClassDefFoundError: '+private+'\n'+m.TEST_CLASS+'\n'+m.RUNNER+'\nInstrumentation run failed\nProcess crashed.\nINSTRUMENTATION_STATUS: class='+m.TEST_CLASS+'\nINSTRUMENTATION_STATUS_CODE: 1\n').encode()
facts=m.instrumentation_signals(text,b'java.lang.SecurityException: '+private.encode())
assert set(facts)==expected and all(type(x)is bool for x in facts.values())
assert facts['NoClassDefFoundError']and facts['SecurityException']and facts['instrumentationRunFailed']and facts['processCrashed']and facts['junitStarted']and facts['ownedTestClassMentioned']and facts['ownedRunnerClassMentioned']
assert not facts['ClassNotFoundException'];assert m.instrumentation_signals(b'NotNoClassDefFoundErrorSuffix',b'')['NoClassDefFoundError']is False
for name in expected & set(['ClassNotFoundException','UnsatisfiedLinkError','VerifyError','IllegalStateException','RuntimeException']):
 assert m.instrumentation_signals(('java.lang.'+name+': '+private).encode(),b'')[name]is True
for exit_code,wanted in [(0,'EVIDENCE_COUNT'),(1,'TOOL_REFUSAL')]:
 f=Fixture()
 try:
  f.fake.instrument_output=text;f.fake.instrument_stderr=b'java.lang.SecurityException: '+private.encode();f.fake.instrument_exit=exit_code
  argv=['controller']
  for key,value in vars(f.args).items():argv+=['--'+key.replace('_','-'),str(value)]
  with mock.patch.object(m,'System',return_value=f.fake),mock.patch.object(sys,'argv',argv),mock.patch('sys.stdout',new_callable=io.StringIO)as captured:
   assert m.main()==1
  saved=json.loads((pathlib.Path(f.args.evidence_dir)/'OWNED_STARTUP.json').read_text())
  assert saved['qualification']is False and saved['code']==wanted;assert saved['instrumentationSignals']==facts;assert 'moduleEvidence'not in saved
  serialized=json.dumps(saved)+captured.getvalue();assert all(secret not in serialized for secret in ['private.invalid','private-value','/private/owner','PRIVATE_MESSAGE','java.lang.NoClassDefFoundError:'])
  assert len([c for c in f.fake.calls if 'instrument'in c])==1
 finally:f.close()
# Unknown exceptions, arbitrary frame names and invalid Unicode cannot become values.
unknown=m.instrumentation_signals(('com.private.SecretException: '+private+'\n at com.private.Owner.secretMethod(Owner.java:1)').encode()+b'\xff',b'')
assert set(unknown)==expected and not any(unknown.values());assert private not in json.dumps(unknown)
# Diagnostics never replace the exact evidence or JUnit qualification gate.
rejects(lambda:m.evidence(text.decode()),'EVIDENCE_COUNT')
`));


test('missing-class namespaces require JVM formats and never serialize class names or messages',()=>run(String.raw`
buckets={'missingAndroidxTest','missingAndroidxAppcompat','missingAndroidxCore','missingTauri','missingKotlin','missingOwnedTest','missingOwnedTarget','missingOther'}
cases=[('androidx.test.internal.runner.HiddenRunner','missingAndroidxTest'),('androidx.appcompat.app.AppCompatActivity','missingAndroidxAppcompat'),('androidx.core.app.CoreComponentFactory','missingAndroidxCore'),('app.tauri.plugin.PluginHandle','missingTauri'),('kotlin.jvm.internal.Intrinsics','missingKotlin'),('kotlinx.coroutines.Job','missingKotlin'),('com.yawf.ownedstartup.PrivateTest','missingOwnedTest'),(m.TARGET+'.PrivateActivity','missingOwnedTarget'),('private.person.CustomerName','missingOther')]
for name,bucket in cases:
 for line in ['java.lang.NoClassDefFoundError: Failed resolution of: L'+name.replace('.','/')+';', 'Caused by: java.lang.ClassNotFoundException: Didn\'t find class "'+name+'" on path: /private/owner/data?secret=value', 'ClassNotFoundException: '+name, 'INSTRUMENTATION_RESULT: longMsg=java.lang.NoClassDefFoundError: Failed resolution of: L'+name.replace('.','/')+';']:
  facts=m.instrumentation_signals(line.encode(),b'');assert {k for k in buckets if facts[k]}=={bucket}
  serialized=json.dumps(facts);assert name not in serialized and '/private'not in serialized and 'secret=value'not in serialized;assert all(type(x)is bool for x in facts.values())
for line in ['androidx.test.internal.runner.HiddenRunner','ordinary message Failed resolution of: Landroidx/test/Hidden;','ClassNotFoundException: https://private.invalid/token','ClassNotFoundException: private.person.Name secret-value', 'Failed resolution of: Landroidx/test/'+('A'*65)+';', 'ClassNotFoundException: private..Name', 'ClassNotFoundException: private/person/Name', 'Didn\'t find class "private.person.Name?token=value" on path: /private']:
 facts=m.instrumentation_signals(line.encode(),b'');assert not any(facts[k]for k in buckets),line
required={'androidx.test.runner.AndroidJUnitRunner':'androidJUnitRunnerMentioned','androidx.test.platform.app.InstrumentationRegistry':'instrumentationRegistryMentioned','androidx.test.internal.runner.junit4.AndroidJUnit4ClassRunner':'androidJUnit4ClassRunnerMentioned','androidx.appcompat.app.AppCompatActivity':'appCompatActivityMentioned','androidx.core.app.CoreComponentFactory':'coreComponentFactoryMentioned','app.tauri.plugin.Plugin':'pluginMentioned','app.tauri.plugin.PluginManager':'pluginManagerMentioned','app.tauri.plugin.PluginHandle':'pluginHandleMentioned'}
for name,key in required.items():
 for text in [name,'L'+name.replace('.','/')+';']:
  facts=m.instrumentation_signals(text.encode(),b'');assert facts[key]is True;assert not any(facts[k]for k in buckets)
# The new discrimination also survives the real receipt path with no Bundle.
f=Fixture()
try:
 f.fake.instrument_output=b'java.lang.NoClassDefFoundError: Failed resolution of: Landroidx/test/internal/runner/HiddenRunner;';f.fake.instrument_stderr=b'ClassNotFoundException: private.person.CustomerName'
 argv=['controller']
 for key,value in vars(f.args).items():argv+=['--'+key.replace('_','-'),str(value)]
 with mock.patch.object(m,'System',return_value=f.fake),mock.patch.object(sys,'argv',argv),mock.patch('sys.stdout',new_callable=io.StringIO):assert m.main()==1
 saved=json.loads((pathlib.Path(f.args.evidence_dir)/'OWNED_STARTUP.json').read_text());assert saved['code']=='EVIDENCE_COUNT'and saved['qualification']is False
 assert saved['instrumentationSignals']['missingAndroidxTest']and saved['instrumentationSignals']['missingOther'];assert 'CustomerName'not in json.dumps(saved)and 'HiddenRunner'not in json.dumps(saved)
finally:f.close()
`));


test('fixed linkage and native-crash markers retain booleans only on a pre-JUnit refusal',()=>run(String.raw`
extra={'NoSuchMethodError','NoSuchFieldError','AbstractMethodError','IncompatibleClassChangeError','ExceptionInInitializerError','IllegalAccessError','ClassCastException','AssertionError','OutOfMemoryError','FatalSignal','SIGABRT','SIGSEGV'}
private='https://private.invalid/path?token=secret-value /private/person/file PRIVATE_MESSAGE'
for name in extra-{'FatalSignal','SIGABRT','SIGSEGV'}:
 facts=m.instrumentation_signals(('java.lang.'+name+': '+private).encode(),b'')
 assert facts[name]is True and all(type(v)is bool for v in facts.values())
 assert not any(facts[k]for k in extra-{name});assert private not in json.dumps(facts)
 assert m.instrumentation_signals(('Not'+name+'Suffix').encode(),b'')[name]is False
native=m.instrumentation_signals(('Fatal signal 6 (SIGABRT), '+private).encode(),b'SIGSEGV')
assert native['FatalSignal']and native['SIGABRT']and native['SIGSEGV'];assert private not in json.dumps(native)
for token in ['NotSIGABRTSuffix','NotSIGSEGVSuffix','NotFatal signalSuffix']:
 facts=m.instrumentation_signals(token.encode(),b'');assert not any(facts[k]for k in extra)
f=Fixture()
try:
 f.fake.instrument_output=('java.lang.NoSuchMethodError: '+private).encode();f.fake.instrument_stderr=('Fatal signal 6 (SIGABRT), '+private).encode()
 argv=['controller']
 for key,value in vars(f.args).items():argv+=['--'+key.replace('_','-'),str(value)]
 with mock.patch.object(m,'System',return_value=f.fake),mock.patch.object(sys,'argv',argv),mock.patch('sys.stdout',new_callable=io.StringIO)as captured:assert m.main()==1
 saved=json.loads((pathlib.Path(f.args.evidence_dir)/'OWNED_STARTUP.json').read_text());assert saved['qualification']is False and saved['code']=='EVIDENCE_COUNT'
 signals=saved['instrumentationSignals'];assert signals['NoSuchMethodError']and signals['FatalSignal']and signals['SIGABRT'];assert not signals['junitStarted']
 serialized=json.dumps(saved)+captured.getvalue();assert all(value not in serialized for value in ['private.invalid','secret-value','/private/person','PRIVATE_MESSAGE','java.lang.NoSuchMethodError:'])
finally:f.close()
`));


test('public diagnostic classes require exact APK definitions or SDK entries and discard all runtime text',()=>run(String.raw`
f=Fixture()
try:
 test_apk=pathlib.Path(f.args.test_apk);sdk_jar=pathlib.Path(f.args.sdk)/'platforms/android-36/android.jar'
 with zipfile.ZipFile(test_apk,'a')as archive:archive.writestr('classes2.dex',dex('Lprivate/person/ReferenceOnlyException;',False))
 definitions=m.public_definition_names((pathlib.Path(f.args.target_apk),test_apk),sdk_jar,lambda:None)
 assert definitions=={'product.Main','test.Observer','java.lang.RuntimeException','java.lang.IllegalStateException','java.lang.Object'}
 assert 'private.person.ReferenceOnlyException'not in definitions
 text=('INSTRUMENTATION_RESULT: longMsg=java.lang.IllegalStateException: https://private.invalid/?token=SECRET_MESSAGE\nCaused by: java.lang.RuntimeException: /private/person/file\n at product.Main.privateMethodSecret(PrivateFilename.java:123)\n at test.Observer.otherSecret(Unknown Source)\nCaused by: private.person.ReferenceOnlyException: SECRET_MESSAGE\n at product.MainForged.privateMethod(Secret.java:77)\n at private.person.Owner.privateMethod(Secret.java:1)\njava.lang.Object: arbitrary message').encode()
 facts=m.public_code_diagnostics(text,b'',definitions)
 assert facts['headerClasses']==['java.lang.IllegalStateException','java.lang.RuntimeException','java.lang.Object']
 assert facts['frameClasses']==[{'class':'product.Main','line':123},{'class':'test.Observer','line':None}]
 serialized=json.dumps(facts)
 for secret in ['private.invalid','SECRET_MESSAGE','/private/person','privateMethodSecret','PrivateFilename','otherSecret','ReferenceOnlyException','MainForged','Secret.java']:assert secret not in serialized
 # Exact allowlist is not a prefix grant, and output cardinality is hard bounded.
 names={'public.Type'+str(n)for n in range(30)}
 many='\n'.join('public.Type'+str(n)+': secret\n at public.Type'+str(n)+'.secret(Secret.java:9999999)'for n in range(30))
 bounded=m.public_code_diagnostics(many.encode(),b'',names);assert len(bounded['headerClasses'])==8 and len(bounded['frameClasses'])==12;assert all(row['line']is None for row in bounded['frameClasses'])
 assert m.public_code_diagnostics(b'Caused by: public.Type0Forgery: secret\n at public.Type0Forgery.secret(Secret.java:1)',b'',names)=={'headerClasses':[],'frameClasses':[]}
 # Private visitor does not change default counts, and references never invoke it.
 observed=[];assert m.dex_class_counts(dex('Lprivate/person/ReferenceOnlyException;',False),observed.append)==(0,0);assert observed==[]
 assert m.dex_class_counts(dex('Ltest/Observer;',True),observed.append)==(1,0);assert observed==[b'Ltest/Observer;']
finally:f.close()
f=Fixture()
try:
 f.fake.instrument_output=b'INSTRUMENTATION_RESULT: longMsg=java.lang.IllegalStateException: PRIVATE_MESSAGE\n at product.Main.secretMethod(PrivateFile.java:42)\nCaused by: private.person.NotDefined: PRIVATE_MESSAGE'
 argv=['controller']
 for key,value in vars(f.args).items():argv+=['--'+key.replace('_','-'),str(value)]
 with mock.patch.object(m,'System',return_value=f.fake),mock.patch.object(sys,'argv',argv),mock.patch('sys.stdout',new_callable=io.StringIO)as captured:assert m.main()==1
 saved=json.loads((pathlib.Path(f.args.evidence_dir)/'OWNED_STARTUP.json').read_text());assert saved['code']=='EVIDENCE_COUNT'and saved['qualification']is False
 assert saved['instrumentationPublicCode']=={'headerClasses':['java.lang.IllegalStateException'],'frameClasses':[{'class':'product.Main','line':42}]}
 for secret in ['PRIVATE_MESSAGE','secretMethod','PrivateFile','NotDefined']:assert secret not in json.dumps(saved)+captured.getvalue()
finally:f.close()
`));
