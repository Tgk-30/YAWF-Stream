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

def focus_snapshot():
 return dict(attempted=False,available=False,focusCategory='unavailable',updaterDialogFocus='unavailable',rootCount=0,attachedRootCount=0,visibleRootCount=0,focusedRootCount=0,mainAttached=False,mainVisible=False,mainFocused=False,mainNotFocusable=False,mainNotTouchable=False)

def focused_snapshot():
 value=focus_snapshot();value.update(attempted=True,available=True,focusCategory='other-owned-root',updaterDialogFocus='yes',rootCount=2,attachedRootCount=2,visibleRootCount=2,focusedRootCount=1,mainAttached=True,mainVisible=True);return value

def tap_timing():
 return dict(tapTimeoutMs=100,minimumHoldMs=117,longPressTimeoutMs=400,deadlineOffsetMs=183,actualHoldMs=130,enqueuedOffsetMs=10,enteredOffsetMs=11,completedOffsetMs=12,sampleCount=1)

def async_main_probe():
 return dict(instrumentationThreadIsMain=None,handlerSameMainLooper=None,callbackSameMainLooper=None,enqueuedOffsetMs=None,enteredOffsetMs=None,completedOffsetMs=None,closedOffsetMs=None,outcome='not-attempted')

def observed_async_probe(outcome='pressed'):
 return dict(instrumentationThreadIsMain=False,handlerSameMainLooper=True,callbackSameMainLooper=True,enqueuedOffsetMs=13,enteredOffsetMs=14,completedOffsetMs=15,closedOffsetMs=127,outcome=outcome)

def proof():
 value={key:True for key in m.BOOL_FIELDS};value.update(schemaVersion=1,scope='selected_first_plugin_load_failure_then_one_native_retry',phase='QUALIFIED_SELECTED_STARTUP_RETRY_ONLY',qualification=True,failureCode='',elapsedMs=10000,tapCount=1,targetActivityCreates=1,pluginLoadCount=2,retryDownCallElapsedMs=10,retryPressedObservationOutcome='pressed',retryAdmissionFirstBlockingReason='none',retryAdmissionLastBlockingReason='none',retryAdmissionElapsedMs=17,retryAdmissionSampleCount=2,retryFocusSnapshot=focus_snapshot(),retryTapTiming=tap_timing(),retryAsyncMainProbe=async_main_probe());return value

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
     value=proof();value.update(qualification=False,phase='LAUNCH_ONCE',failureCode='LAUNCH_ONCE_FAILED',retryDownPressed=False,retryOriginalButtonDetachedAfterUp=False,retryDownCallElapsedMs=None,retryPressedObservationOutcome='not-attempted',retryAdmissionAdmitted=False,retryAdmissionFirstBlockingReason='not-started',retryAdmissionLastBlockingReason='not-started',retryAdmissionElapsedMs=0,retryAdmissionSampleCount=0);text=output(value)
    else:text=output()
   else:raise AssertionError('unexpected command')
  elif tool=='aapt':
   target=pathlib.Path(argv[-1]).name=='target.apk';package=(m.TARGET if target else m.TEST_PACKAGE);version='2.3.114' if target else '';code='2003114'if target else ''
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
  self.args=argparse.Namespace(sdk=str(sdk),adb_port=5142,serial='emulator-5568',owned_admission=str(self.file),target_apk=str(target),test_apk=str(test),expected_version='2.3.114',expected_code=2003114,expected_cert='a'*64,evidence_dir=str(self.job/'evidence'),timeout=180)
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

test('test APK rejects AndroidX definitions in every DEX without rejecting references or retaining class names',()=>run(String.raw`
names=['Landroidx/test/runner/AndroidJUnitRunner;','Landroidx/startup/InitializationProvider;','Landroidx/appcompat/app/AppCompatActivity;','Landroidx/private/CustomerName;']
f=Fixture()
try:
 p=pathlib.Path(f.args.test_apk)
 for name in names:
  assert m.dex_class_counts(dex(name,False))==(0,0)
  assert m.dex_class_counts(dex(name,True))==(1,0)
  with zipfile.ZipFile(p,'w')as archive:
   archive.writestr('classes.dex',dex('Landroidxish/Observer;',True));archive.writestr('classes10.dex',dex(name,False))
  assert m.no_tauri_definitions(p)=={'dexFiles':2,'classDefinitions':1,'tauriClassDefinitions':0}
  for entry in ['classes.dex','classes10.dex']:
   with zipfile.ZipFile(p,'w')as archive:
    archive.writestr(entry,dex(name,True))
   try:m.no_tauri_definitions(p)
   except m.Refusal as error:
    assert str(error)=='BUNDLED_ANDROIDX_CLASS_DEFINITION'
    assert error.module_evidence is None
    assert name not in str(error) and 'CustomerName'not in str(error)
   else:raise AssertionError('bundled AndroidX definition accepted')
finally:f.close()
`));

test('pressed and original-button detachment are mandatory typed facts and partial negatives stay unqualified',()=>run(String.raw`
fields=('retryDownPressed','retryOriginalButtonDetachedAfterUp')
assert all(field in m.BOOL_FIELDS for field in fields)
for field in fields:
 value=proof();value[field]=False;rejects(lambda:m.evidence(output(value)),'MODULE_FACTS')
 for malformed in ['missing','wrong-type']:
  value=proof()
  if malformed=='missing':value.pop(field)
  else:value[field]='https://private.invalid/input?token=PRIVATE_INPUT'
  try:m.evidence(output(value))
  except m.Refusal as error:
   assert str(error)==('EVIDENCE_SCHEMA'if malformed=='missing'else'EVIDENCE_TYPE')
   assert error.module_evidence is None and 'PRIVATE_INPUT'not in str(error)
  else:raise AssertionError('unobserved input fact accepted')
for pressed,detached in [(False,False),(True,False),(False,True),(True,True)]:
 value=proof();value.update(qualification=False,phase='ONE_VERIFIED_NATIVE_TAP',failureCode='ONE_VERIFIED_NATIVE_TAP_FAILED',pluginLoadCount=1,elapsedMs=1500,retryDownPressed=pressed,retryOriginalButtonDetachedAfterUp=detached,retryPressedObservationOutcome='pressed'if pressed else'unpressed')
 try:m.evidence(output(value))
 except m.Refusal as error:
  assert str(error)=='MODULE_UNQUALIFIED'
  assert error.module_evidence['qualification']is False
  assert error.module_evidence[fields[0]]is pressed and error.module_evidence[fields[1]]is detached
  assert error.module_evidence['phase']=='ONE_VERIFIED_NATIVE_TAP'
 else:raise AssertionError('partial input facts became startup qualification')
`));

test('diagnostic outcomes preserve pending versus negative and reject unknown or malformed facts before retention',()=>run(String.raw`
outcomes={'not-attempted','budget-skipped','observation-timeout','state-mismatch','unpressed','pressed','observation-error'}
assert m.PRESSED_OBSERVATION_OUTCOMES==outcomes
for outcome in outcomes:
 value=proof();value.update(qualification=False,phase='ONE_VERIFIED_NATIVE_TAP',failureCode='ONE_VERIFIED_NATIVE_TAP_FAILED',pluginLoadCount=1,retryDownPressed=outcome=='pressed',retryOriginalButtonDetachedAfterUp=False,retryPressedObservationOutcome=outcome,retryDownCallElapsedMs=None if outcome=='not-attempted'else 10)
 try:m.evidence(output(value))
 except m.Refusal as error:
  assert str(error)=='MODULE_UNQUALIFIED'and error.module_evidence['qualification']is False
  assert error.module_evidence['retryPressedObservationOutcome']==outcome
  assert error.module_evidence['retryDownCallElapsedMs']==value['retryDownCallElapsedMs']
  assert error.module_evidence['retryDownPressed']is(outcome=='pressed')
 else:raise AssertionError('partial diagnostics became qualification')
for field in ['retryDownCallElapsedMs','retryPressedObservationOutcome']:
 value=proof();value.pop(field)
 try:m.evidence(output(value))
 except m.Refusal as error:assert str(error)=='EVIDENCE_SCHEMA'and error.module_evidence is None
 else:raise AssertionError('missing diagnostic accepted')
for bad in [True,False,-1,150001,1.5,'10',[],{},'https://private.invalid/?token=PRIVATE_DIAGNOSTIC']:
 value=proof();value.update(qualification=False,retryDownCallElapsedMs=bad)
 try:m.evidence(output(value))
 except m.Refusal as error:assert str(error)=='EVIDENCE_TYPE'and error.module_evidence is None
 else:raise AssertionError('malformed duration accepted')
for bad in [None,True,1,[],{},'pending','PRESSED','https://private.invalid/?token=PRIVATE_DIAGNOSTIC']:
 value=proof();value.update(qualification=False,retryPressedObservationOutcome=bad)
 try:m.evidence(output(value))
 except m.Refusal as error:
  assert str(error)==('EVIDENCE_INPUT_OUTCOME'if type(bad)is str else'EVIDENCE_TYPE')
  assert error.module_evidence is None and 'PRIVATE_DIAGNOSTIC'not in str(error)
 else:raise AssertionError('unknown outcome accepted')
for outcome in outcomes-{'pressed'}:
 value=proof();value['retryPressedObservationOutcome']=outcome
 rejects(lambda:m.evidence(output(value)),'MODULE_INPUT_FACTS')
value=proof();value['retryDownCallElapsedMs']=None
rejects(lambda:m.evidence(output(value)),'MODULE_INPUT_FACTS')
for elapsed in [0,10]:
 value=proof();value['retryDownCallElapsedMs']=elapsed
 assert m.evidence(output(value))==value
`));

test('tap timing schema retains bounded unknowns and refuses malformed or inconsistent observations',()=>run(String.raw`
assert m.evidence(output())==proof()
configured=proof();configured['retryTapTiming'].update(tapTimeoutMs=120,minimumHoldMs=137,longPressTimeoutMs=500,actualHoldMs=160)
assert m.evidence(output(configured))==configured
pending={name:None for name in m.TAP_TIMING_FIELDS};pending['sampleCount']=0
for timing in [pending,dict(tap_timing(),enteredOffsetMs=None,completedOffsetMs=None,sampleCount=0),dict(tap_timing(),completedOffsetMs=None),dict(tap_timing(),completedOffsetMs=190)]:
 value=proof();value.update(qualification=False,retryTapTiming=timing,retryDownPressed=False,retryPressedObservationOutcome='observation-timeout')
 try:m.evidence(output(value))
 except m.Refusal as error:
  assert str(error)=='MODULE_UNQUALIFIED'and error.module_evidence['retryTapTiming']==timing
 else:raise AssertionError('partial timing became qualification')
value=proof();value.pop('retryTapTiming');rejects(lambda:m.evidence(output(value)),'EVIDENCE_SCHEMA')
for timing in [None,[],dict(tap_timing(),private='PRIVATE_TIMING'),{key:val for key,val in tap_timing().items()if key!='sampleCount'}]:
 value=proof();value['retryTapTiming']=timing
 try:m.evidence(output(value))
 except m.Refusal as error:assert str(error)=='TAP_TIMING_SCHEMA'and error.module_evidence is None
 else:raise AssertionError('unknown timing schema retained')
for field in m.TAP_TIMING_FIELDS|{'sampleCount'}:
 for bad in [True,False,-1,150001,1.5,'https://private.invalid/?token=PRIVATE_TIMING',[],{}]:
  value=proof();value['retryTapTiming'][field]=bad
  try:m.evidence(output(value))
  except m.Refusal as error:assert str(error)=='TAP_TIMING_TYPE'and error.module_evidence is None and 'PRIVATE_TIMING'not in str(error)
  else:raise AssertionError('malformed timing retained')
for changes in [dict(minimumHoldMs=116),dict(deadlineOffsetMs=200),dict(tapTimeoutMs=None),dict(enqueuedOffsetMs=184),dict(enteredOffsetMs=9),dict(completedOffsetMs=10),dict(sampleCount=0),dict(enteredOffsetMs=None)]:
 value=proof();value['retryTapTiming'].update(changes)
 try:m.evidence(output(value))
 except m.Refusal as error:assert str(error)=='TAP_TIMING_STATE'and error.module_evidence is None
 else:raise AssertionError('inconsistent timing retained')
for timing in [pending,dict(tap_timing(),actualHoldMs=None),dict(tap_timing(),actualHoldMs=116),dict(tap_timing(),actualHoldMs=201),dict(tap_timing(),longPressTimeoutMs=150,deadlineOffsetMs=132,actualHoldMs=150),dict(tap_timing(),enqueuedOffsetMs=14,enteredOffsetMs=15,completedOffsetMs=16),dict(tap_timing(),completedOffsetMs=184),dict(tap_timing(),completedOffsetMs=131)]:
 value=proof();value['retryTapTiming']=timing
 rejects(lambda:m.evidence(output(value)),'MODULE_TAP_TIMING')
`));

test('tap timing guards reject individual privacy and qualification mutants after original positives',()=>run(String.raw`
original=pathlib.Path(m.__file__).read_text()
def probe(api,timing,code):
 value=proof();value['retryTapTiming']=timing
 try:api['evidence'](output(value))
 except api['Refusal']as error:
  assert str(error)==code
  if code.startswith('TAP_'):assert error.module_evidence is None
 else:raise AssertionError('timing guard lost')
mutants=[
 ('set(value) == TAP_TIMING_FIELDS | {"sampleCount"}','True',dict(tap_timing(),private='PRIVATE_TIMING'),'TAP_TIMING_SCHEMA'),
 ('type(value[name]) is int and 0 <= value[name] <= 150000','type(value[name]) is int and 0 <= value[name]',dict(tap_timing(),actualHoldMs=150001),'TAP_TIMING_TYPE'),
 ('0 <= value["sampleCount"] <= 12','0 <= value["sampleCount"]',dict(tap_timing(),sampleCount=13),'TAP_TIMING_TYPE'),
 ('deadline == min(200, long_press - 1) - 17','True',dict(tap_timing(),deadlineOffsetMs=200),'TAP_TIMING_STATE'),
 ('enqueued <= entered <= deadline','entered <= deadline',dict(tap_timing(),enteredOffsetMs=9),'TAP_TIMING_STATE'),
 ('timing["minimumHoldMs"] <= timing["actualHoldMs"] <= 200','timing["minimumHoldMs"] <= timing["actualHoldMs"]',dict(tap_timing(),actualHoldMs=201),'MODULE_TAP_TIMING'),
 ('timing["enqueuedOffsetMs"] + timing["minimumHoldMs"] <= timing["actualHoldMs"]','True',dict(tap_timing(),enqueuedOffsetMs=14,enteredOffsetMs=15,completedOffsetMs=16),'MODULE_TAP_TIMING'),
 ('timing["completedOffsetMs"] <= timing["deadlineOffsetMs"]','True',dict(tap_timing(),actualHoldMs=190,completedOffsetMs=184),'MODULE_TAP_TIMING'),
 ('timing["completedOffsetMs"] <= timing["actualHoldMs"]','True',dict(tap_timing(),completedOffsetMs=131),'MODULE_TAP_TIMING'),
]
for before,after,timing,code in mutants:
 probe(vars(m),timing,code);assert original.count(before)==1
 api={'__name__':'owned_tap_timing_mutant','__file__':m.__file__}
 exec(compile(original.replace(before,after,1),'<owned-tap-timing-mutant>','exec'),api)
 try:probe(api,timing,code)
 except AssertionError:pass
 else:raise AssertionError('timing guard mutant survived')
`));

test('paired async main diagnostic is strictly bounded, retained and never substitutes ordinary pressed proof',()=>run(String.raw`
assert m.evidence(output())==proof()
pending=dict(observed_async_probe('observation-timeout'),callbackSameMainLooper=None,enteredOffsetMs=None,completedOffsetMs=None)
unavailable=dict(async_main_probe(),instrumentationThreadIsMain=False,closedOffsetMs=127,outcome='unavailable')
wrong_handler=dict(unavailable,handlerSameMainLooper=False,outcome='state-mismatch')
wrong_callback=dict(observed_async_probe('state-mismatch'),callbackSameMainLooper=False)
for diagnostic in [async_main_probe(),unavailable,wrong_handler,wrong_callback,pending,dict(pending,callbackSameMainLooper=True,enteredOffsetMs=14),dict(unavailable,outcome='observation-error')]+[observed_async_probe(outcome)for outcome in ['pressed','unpressed','state-mismatch','observation-error']]:
 value=proof();value['retryAsyncMainProbe']=diagnostic
 assert m.evidence(output(value))==value,'optional async negative must not weaken or replace ordinary evidence'
 value['qualification']=False
 try:m.evidence(output(value))
 except m.Refusal as error:assert str(error)=='MODULE_UNQUALIFIED'and error.module_evidence['retryAsyncMainProbe']==diagnostic
 else:raise AssertionError('async diagnostic qualified a negative case')
for outcome in m.PRESSED_OBSERVATION_OUTCOMES-{'pressed'}:
 value=proof();value.update(retryPressedObservationOutcome=outcome,retryAsyncMainProbe=observed_async_probe())
 rejects(lambda:m.evidence(output(value)),'MODULE_INPUT_FACTS')
value=proof();value.update(retryDownPressed=False,retryAsyncMainProbe=observed_async_probe())
rejects(lambda:m.evidence(output(value)),'MODULE_FACTS')
value=proof();value.update(retryPressedObservationOutcome='observation-timeout',retryDownPressed=False,retryAsyncMainProbe=observed_async_probe(),retryTapTiming=dict(tap_timing(),enteredOffsetMs=None,completedOffsetMs=None,sampleCount=0),qualification=False,phase='ONE_VERIFIED_NATIVE_TAP',failureCode='ONE_VERIFIED_NATIVE_TAP_FAILED')
try:m.evidence(output(value))
except m.Refusal as error:
 assert str(error)=='MODULE_UNQUALIFIED'and error.module_evidence['retryAsyncMainProbe']['outcome']=='pressed'
 assert error.module_evidence['retryTapTiming']['sampleCount']==0 and error.module_evidence['retryPressedObservationOutcome']=='observation-timeout'
else:raise AssertionError('async-only entry became ordinary proof')
for diagnostic in [None,[],dict(observed_async_probe(),private='PRIVATE_ASYNC'),{key:value for key,value in observed_async_probe().items()if key!='outcome'}]:
 value=proof();value['retryAsyncMainProbe']=diagnostic
 try:m.evidence(output(value))
 except m.Refusal as error:assert str(error)=='ASYNC_MAIN_PROBE_SCHEMA'and error.module_evidence is None
 else:raise AssertionError('private async schema retained')
for field in m.ASYNC_MAIN_PROBE_BOOLS:
 for bad in [0,1,'PRIVATE_ASYNC',[],{}]:
  value=proof();value['retryAsyncMainProbe']=dict(observed_async_probe(),**{field:bad})
  try:m.evidence(output(value))
  except m.Refusal as error:assert str(error)=='ASYNC_MAIN_PROBE_TYPE'and error.module_evidence is None
  else:raise AssertionError('arbitrary async bool retained')
for field in m.ASYNC_MAIN_PROBE_TIMES:
 for bad in [True,False,-1,150001,1.5,'PRIVATE_ASYNC',[],{}]:
  value=proof();value['retryAsyncMainProbe']=dict(observed_async_probe(),**{field:bad})
  try:m.evidence(output(value))
  except m.Refusal as error:assert str(error)=='ASYNC_MAIN_PROBE_TYPE'and error.module_evidence is None
  else:raise AssertionError('arbitrary async timing retained')
for bad in [None,True,1,[],{},'PRIVATE_ASYNC']:
 value=proof();value['retryAsyncMainProbe']=dict(observed_async_probe(),outcome=bad)
 try:m.evidence(output(value))
 except m.Refusal as error:assert str(error)=='ASYNC_MAIN_PROBE_OUTCOME'and error.module_evidence is None
 else:raise AssertionError('arbitrary async outcome retained')
for changes in [dict(outcome='not-attempted'),dict(outcome='unavailable'),dict(outcome='observation-timeout'),dict(instrumentationThreadIsMain=None),dict(handlerSameMainLooper=False),dict(callbackSameMainLooper=False),dict(closedOffsetMs=None),dict(closedOffsetMs=131),dict(enqueuedOffsetMs=9),dict(enteredOffsetMs=12),dict(completedOffsetMs=13),dict(completedOffsetMs=128),dict(enteredOffsetMs=None),dict(completedOffsetMs=None)]:
 value=proof();value['retryAsyncMainProbe']=dict(observed_async_probe(),**changes)
 try:m.evidence(output(value))
 except m.Refusal as error:assert str(error)=='ASYNC_MAIN_PROBE_STATE'and error.module_evidence is None
 else:raise AssertionError('inconsistent async diagnostic retained')
`));

test('actual async schema and ordinary-only qualification reject individual mutants after original positives',()=>run(String.raw`
original=pathlib.Path(m.__file__).read_text()
def probe(api,diagnostic,code,normal='pressed'):
 value=proof();value.update(retryAsyncMainProbe=diagnostic,retryPressedObservationOutcome=normal)
 try:
  if normal=='validate-only':api['validate_async_main_probe'](diagnostic,dict(tap_timing(),actualHoldMs=150002))
  else:api['evidence'](output(value))
 except api['Refusal']as error:
  assert str(error)==code
  if code.startswith('ASYNC_'):assert error.module_evidence is None
 else:raise AssertionError('async guard lost')
mutants=[
 ('set(value) == ASYNC_MAIN_PROBE_KEYS','True',dict(observed_async_probe(),private='PRIVATE_ASYNC'),'ASYNC_MAIN_PROBE_SCHEMA','pressed'),
 ('type(value[name]) is bool for name in ASYNC_MAIN_PROBE_BOOLS','value[name] in (False, True) for name in ASYNC_MAIN_PROBE_BOOLS',dict(async_main_probe(),instrumentationThreadIsMain=False,handlerSameMainLooper=0,closedOffsetMs=127,outcome='observation-error'),'ASYNC_MAIN_PROBE_TYPE','pressed'),
 ('type(value[name]) is int and value[name] >= 0 and value[name] <= 150000','type(value[name]) is int and value[name] >= 0',dict(observed_async_probe(),closedOffsetMs=150001),'ASYNC_MAIN_PROBE_TYPE','validate-only'),
 ('value["outcome"] in ASYNC_MAIN_PROBE_OUTCOMES','True',dict(observed_async_probe(),outcome='PRIVATE_ASYNC'),'ASYNC_MAIN_PROBE_OUTCOME','pressed'),
 ('closed <= actual_hold','True',dict(observed_async_probe(),closedOffsetMs=131),'ASYNC_MAIN_PROBE_STATE','pressed'),
 ('timing["enqueuedOffsetMs"] <= enqueued <= min(deadline, closed)','enqueued <= min(deadline, closed)',dict(observed_async_probe(),enqueuedOffsetMs=9),'ASYNC_MAIN_PROBE_STATE','pressed'),
 ('entered <= completed <= min(deadline, closed)','entered <= completed',dict(observed_async_probe(),completedOffsetMs=128),'ASYNC_MAIN_PROBE_STATE','pressed'),
 ('value["callbackSameMainLooper"] is True and completed is not None','completed is not None',dict(observed_async_probe(),callbackSameMainLooper=False),'ASYNC_MAIN_PROBE_STATE','pressed'),
 ('value["retryPressedObservationOutcome"] == "pressed"','(value["retryPressedObservationOutcome"] == "pressed" or value["retryAsyncMainProbe"]["outcome"] == "pressed")',observed_async_probe(),'MODULE_INPUT_FACTS','observation-timeout'),
]
for before,after,diagnostic,code,normal in mutants:
 probe(vars(m),diagnostic,code,normal);assert original.count(before)==1
 api={'__name__':'owned_async_mutant','__file__':m.__file__}
 exec(compile(original.replace(before,after,1),'<owned-async-mutant>','exec'),api)
 try:probe(api,diagnostic,code,normal)
 except AssertionError:pass
 else:raise AssertionError('async diagnostic mutant survived')
`));

test('admission history and bounds are mandatory, private unknown facts are refused before retention',()=>run(String.raw`
reasons={'not-started','none','owner','liveness','identity','fault','cleanup','focus','screen-asleep','keyguard-locked','attachment','interaction','listener','dimensions','root','visible-bounds','intersection','unstable-geometry','observation-timeout','observation-error','deadline','sample-limit','sample-interval'}
assert m.ADMISSION_REASONS==reasons
for reason in reasons:
 value=proof();value.update(qualification=False,phase='ONE_VERIFIED_NATIVE_TAP',failureCode='ONE_VERIFIED_NATIVE_TAP_FAILED',pluginLoadCount=1,tapCount=0,retryDownPressed=False,retryOriginalButtonDetachedAfterUp=False,retryDownCallElapsedMs=None,retryPressedObservationOutcome='not-attempted',retryAdmissionAdmitted=False,retryAdmissionFirstBlockingReason=reason,retryAdmissionLastBlockingReason=reason,retryAdmissionElapsedMs=0 if reason=='not-started'else 34,retryAdmissionSampleCount=0 if reason=='not-started'else 2)
 try:m.evidence(output(value))
 except m.Refusal as error:
  assert str(error)=='MODULE_UNQUALIFIED'
  assert error.module_evidence['retryAdmissionFirstBlockingReason']==reason
  assert error.module_evidence['retryAdmissionLastBlockingReason']==reason
  assert error.module_evidence['retryAdmissionAdmitted']is False
  assert error.module_evidence['tapCount']==0 and error.module_evidence['retryDownCallElapsedMs']is None
 else:raise AssertionError('negative admission qualified')
fields=('retryAdmissionFirstBlockingReason','retryAdmissionLastBlockingReason','retryAdmissionElapsedMs','retryAdmissionSampleCount')
for field in fields:
 value=proof();value.pop(field);rejects(lambda:m.evidence(output(value)),'EVIDENCE_SCHEMA')
for field in fields[:2]:
 for bad in [None,True,1,[],{},'READY','https://private.invalid/?token=PRIVATE_ADMISSION']:
  value=proof();value.update(qualification=False);value[field]=bad
  try:m.evidence(output(value))
  except m.Refusal as error:
   assert str(error)==('EVIDENCE_ADMISSION_REASON'if type(bad)is str else'EVIDENCE_TYPE')
   assert error.module_evidence is None and 'PRIVATE_ADMISSION'not in str(error)
  else:raise AssertionError('unknown admission reason retained')
for field,cap in [('retryAdmissionElapsedMs',2000),('retryAdmissionSampleCount',128)]:
 for bad in [None,True,-1,cap+1,1.5,'PRIVATE_ADMISSION',[],{}]:
  value=proof();value.update(qualification=False);value[field]=bad
  try:m.evidence(output(value))
  except m.Refusal as error:assert str(error)=='EVIDENCE_TYPE'and error.module_evidence is None
  else:raise AssertionError('malformed admission count retained')
for change in [{'retryAdmissionSampleCount':1},{'retryAdmissionElapsedMs':0},{'retryAdmissionElapsedMs':2000}]+[{'retryAdmissionLastBlockingReason':reason}for reason in m.ADMISSION_REFUSALS]:
 value=proof();value.update(change);rejects(lambda:m.evidence(output(value)),'MODULE_ADMISSION_FACTS')
`));

test('pending admission cannot qualify and its actual boolean is mandatory and strictly typed',()=>run(String.raw`
pending=proof();pending.update(retryAdmissionAdmitted=False,retryAdmissionFirstBlockingReason='unstable-geometry',retryAdmissionLastBlockingReason='unstable-geometry',retryAdmissionElapsedMs=17,retryAdmissionSampleCount=2)
try:m.evidence(output(pending))
except m.Refusal as error:
 assert str(error)=='MODULE_FACTS'and error.module_evidence['retryAdmissionAdmitted']is False
else:raise AssertionError('two different valid bounds qualified while pending')
pending.update(qualification=False,phase='ONE_VERIFIED_NATIVE_TAP',failureCode='ONE_VERIFIED_NATIVE_TAP_FAILED',tapCount=0,pluginLoadCount=1,retryDownPressed=False,retryOriginalButtonDetachedAfterUp=False,retryDownCallElapsedMs=None,retryPressedObservationOutcome='not-attempted')
try:m.evidence(output(pending))
except m.Refusal as error:
 assert str(error)=='MODULE_UNQUALIFIED'and error.module_evidence==pending
else:raise AssertionError('pending negative qualified')
value=proof();value.pop('retryAdmissionAdmitted')
try:m.evidence(output(value))
except m.Refusal as error:assert str(error)=='EVIDENCE_SCHEMA'and error.module_evidence is None
else:raise AssertionError('missing admission boolean accepted')
for bad in [None,0,1,0.0,1.0,'false','PRIVATE_ADMISSION',[],{}]:
 value=proof();value.update(qualification=False,retryAdmissionAdmitted=bad)
 try:m.evidence(output(value))
 except m.Refusal as error:assert str(error)=='EVIDENCE_TYPE'and error.module_evidence is None
 else:raise AssertionError('nonboolean admission retained')
`));

test('actual admission schema rejects independent privacy, sample-count, time and identity mutants',()=>run(String.raw`
original=pathlib.Path(m.__file__).read_text()
def expect(api,value,code,private=False):
 try:api['evidence'](output(value))
 except api['Refusal']as error:
  assert str(error)==code
  if private:assert error.module_evidence is None
 else:raise AssertionError('admission guard lost')
def private_reason(api):
 value=proof();value.update(qualification=False,retryAdmissionFirstBlockingReason='PRIVATE_ADMISSION')
 expect(api,value,'EVIDENCE_ADMISSION_REASON',True)
def private_count(api):
 value=proof();value.update(qualification=False,retryAdmissionElapsedMs='PRIVATE_ADMISSION')
 expect(api,value,'EVIDENCE_TYPE',True)
def one_sample(api):
 value=proof();value['retryAdmissionSampleCount']=1;expect(api,value,'MODULE_ADMISSION_FACTS')
def expired(api):
 value=proof();value['retryAdmissionElapsedMs']=2000;expect(api,value,'MODULE_ADMISSION_FACTS')
def identity(api):
 value=proof();value['retryAdmissionLastBlockingReason']='identity';expect(api,value,'MODULE_ADMISSION_FACTS')
def pending(api):
 value=proof();value.update(retryAdmissionAdmitted=False,retryAdmissionFirstBlockingReason='unstable-geometry',retryAdmissionLastBlockingReason='unstable-geometry',retryAdmissionElapsedMs=17,retryAdmissionSampleCount=2)
 expect(api,value,'MODULE_FACTS')
for before,after,probe in [
 ('require(value[name] in ADMISSION_REASONS, "EVIDENCE_ADMISSION_REASON")','require(True, "EVIDENCE_ADMISSION_REASON")',private_reason),
 ('require(type(value[name]) is int and 0 <= value[name] <= cap, "EVIDENCE_TYPE")','require(True, "EVIDENCE_TYPE")',private_count),
 ('value["retryAdmissionSampleCount"] >= 2','True',one_sample),
 ('17 <= value["retryAdmissionElapsedMs"] < 2000','True',expired),
 ('value[name] in ADMISSION_REFUSALS','False',identity),
 ('all(value[name] for name in BOOL_FIELDS)','all(value[name] for name in BOOL_FIELDS if name != "retryAdmissionAdmitted")',pending),
]:
 probe(vars(m));assert original.count(before)==1
 api={'__name__':'owned_admission_schema_mutant','__file__':m.__file__}
 exec(compile(original.replace(before,after,1),'<owned-admission-schema-mutant>','exec'),api)
 try:probe(api)
 except AssertionError:pass
 else:raise AssertionError('admission schema mutant survived')
`));

test('optional focus snapshots preserve unavailable states and reject private or malformed values before retention',()=>run(String.raw`
for snapshot in [focus_snapshot(),dict(focus_snapshot(),attempted=True),focused_snapshot(),dict(focused_snapshot(),updaterDialogFocus='unavailable'),dict(focused_snapshot(),focusCategory='target-main',updaterDialogFocus='no',mainFocused=True),dict(focused_snapshot(),focusCategory='none-owned',updaterDialogFocus='no',focusedRootCount=0),dict(focused_snapshot(),focusCategory='ambiguous',updaterDialogFocus='unavailable',rootCount=3,attachedRootCount=3,visibleRootCount=3,focusedRootCount=2)]:
 value=proof();value['retryFocusSnapshot']=snapshot;assert m.evidence(output(value))==value
 value.update(qualification=False,phase='ONE_VERIFIED_NATIVE_TAP',failureCode='ONE_VERIFIED_NATIVE_TAP_FAILED',tapCount=0)
 try:m.evidence(output(value))
 except m.Refusal as error:
  assert str(error)=='MODULE_UNQUALIFIED'and error.module_evidence['retryFocusSnapshot']==snapshot
 else:raise AssertionError('optional focus diagnostics qualified a negative run')
for bad in [None,[],True,'PRIVATE_FOCUS',dict(focus_snapshot(),private='PRIVATE_FOCUS')]:
 value=proof();value['retryFocusSnapshot']=bad
 try:m.evidence(output(value))
 except m.Refusal as error:assert str(error)=='FOCUS_SNAPSHOT_SCHEMA'and error.module_evidence is None
 else:raise AssertionError('unknown focus snapshot retained')
for key in m.FOCUS_SNAPSHOT_KEYS:
 value=proof();value['retryFocusSnapshot'].pop(key);rejects(lambda:m.evidence(output(value)),'FOCUS_SNAPSHOT_SCHEMA')
for key in m.FOCUS_MAIN_FIELDS|{'attempted','available'}:
 for bad in [0,1,None,'PRIVATE_FOCUS',[],{}]:
  value=proof();value['retryFocusSnapshot'][key]=bad
  try:m.evidence(output(value))
  except m.Refusal as error:assert str(error)=='FOCUS_SNAPSHOT_TYPE'and error.module_evidence is None
  else:raise AssertionError('malformed focus boolean retained')
for key in m.FOCUS_COUNT_FIELDS:
 for bad in [-1,33,True,1.5,None,'PRIVATE_FOCUS',[],{}]:
  value=proof();value['retryFocusSnapshot'][key]=bad
  try:m.evidence(output(value))
  except m.Refusal as error:assert str(error)=='FOCUS_SNAPSHOT_TYPE'and error.module_evidence is None
  else:raise AssertionError('malformed focus count retained')
for key in ['focusCategory','updaterDialogFocus']:
 for bad in ['https://private.invalid/?token=PRIVATE_FOCUS',None,True,{},[]]:
  value=proof();value['retryFocusSnapshot'][key]=bad
  try:m.evidence(output(value))
  except m.Refusal as error:assert str(error)=='FOCUS_SNAPSHOT_CATEGORY'and error.module_evidence is None and'PRIVATE_FOCUS'not in str(error)
  else:raise AssertionError('private focus category retained')
for snapshot in [dict(focus_snapshot(),mainNotFocusable=True),dict(focus_snapshot(),updaterDialogFocus='no'),dict(focused_snapshot(),attempted=False),dict(focused_snapshot(),focusedRootCount=0),dict(focused_snapshot(),visibleRootCount=3),dict(focused_snapshot(),mainAttached=False),dict(focused_snapshot(),mainFocused=True),dict(focused_snapshot(),focusCategory='target-main',mainFocused=True)]:
 value=proof();value['retryFocusSnapshot']=snapshot;rejects(lambda:m.evidence(output(value)),'FOCUS_SNAPSHOT_STATE')
`));

test('actual focus schema rejects independent shape, privacy, count and unavailable-state mutants',()=>run(String.raw`
original=pathlib.Path(m.__file__).read_text()
def probe(api,snapshot,code):
 value=proof();value['retryFocusSnapshot']=snapshot
 try:api['evidence'](output(value))
 except api['Refusal']as error:assert str(error)==code and error.module_evidence is None
 else:raise AssertionError('focus diagnostic guard lost')
for before,after,snapshot,code in [
 ('type(value) is dict and set(value) == FOCUS_SNAPSHOT_KEYS','type(value) is dict',dict(focus_snapshot(),private='PRIVATE_FOCUS'),'FOCUS_SNAPSHOT_SCHEMA'),
 ('value["updaterDialogFocus"] in {"yes", "no", "unavailable"}','True',dict(focused_snapshot(),updaterDialogFocus='PRIVATE_FOCUS'),'FOCUS_SNAPSHOT_CATEGORY'),
 ('0 <= value[name] <= 32 for name in FOCUS_COUNT_FIELDS','0 <= value[name] for name in FOCUS_COUNT_FIELDS',dict(focused_snapshot(),rootCount=33,attachedRootCount=33,visibleRootCount=33),'FOCUS_SNAPSHOT_TYPE'),
 ('not any(value[name] for name in FOCUS_MAIN_FIELDS | FOCUS_COUNT_FIELDS)','True',dict(focus_snapshot(),mainNotFocusable=True),'FOCUS_SNAPSHOT_STATE'),
]:
 probe(vars(m),snapshot,code);assert original.count(before)==1
 api={'__name__':'owned_focus_schema_mutant','__file__':m.__file__}
 exec(compile(original.replace(before,after,1),'<owned-focus-schema-mutant>','exec'),api)
 try:probe(api,snapshot,code)
 except AssertionError:pass
 else:raise AssertionError('focus schema mutant survived')
`));

test('actual controller diagnostic guards reject individual semantic and privacy mutants',()=>run(String.raw`
original=pathlib.Path(m.__file__).read_text()
def expect_refusal(api,value,code,private=False):
 try:api['evidence'](output(value))
 except api['Refusal']as error:
  assert str(error)==code
  if private:assert error.module_evidence is None
 else:raise AssertionError('diagnostic refusal lost')
def unknown_outcome(api):
 value=proof();value.update(qualification=False,retryPressedObservationOutcome='https://private.invalid/?token=PRIVATE_DIAGNOSTIC')
 expect_refusal(api,value,'EVIDENCE_INPUT_OUTCOME',True)
def malformed_duration(api):
 value=proof();value.update(qualification=False,retryDownCallElapsedMs='PRIVATE_DIAGNOSTIC')
 expect_refusal(api,value,'EVIDENCE_TYPE',True)
def pending_cannot_qualify(api):
 value=proof();value['retryPressedObservationOutcome']='not-attempted'
 expect_refusal(api,value,'MODULE_INPUT_FACTS')
def unknown_duration_cannot_qualify(api):
 value=proof();value['retryDownCallElapsedMs']=None
 expect_refusal(api,value,'MODULE_INPUT_FACTS')
def pending_is_preserved(api):
 value=proof();value.update(qualification=False,phase='ONE_VERIFIED_NATIVE_TAP',failureCode='ONE_VERIFIED_NATIVE_TAP_FAILED',retryDownPressed=False,retryPressedObservationOutcome='not-attempted',retryDownCallElapsedMs=None)
 try:api['evidence'](output(value))
 except api['Refusal']as error:
  assert str(error)=='MODULE_UNQUALIFIED'
  assert error.module_evidence['retryPressedObservationOutcome']=='not-attempted'
  assert error.module_evidence['retryDownCallElapsedMs']is None
 else:raise AssertionError('pending observation qualified')
mutants=[
 ('require(value["retryPressedObservationOutcome"] in PRESSED_OBSERVATION_OUTCOMES, "EVIDENCE_INPUT_OUTCOME")','require(True, "EVIDENCE_INPUT_OUTCOME")',unknown_outcome),
 ('require(value["retryDownCallElapsedMs"] is None or\n            (type(value["retryDownCallElapsedMs"]) is int and 0 <= value["retryDownCallElapsedMs"] <= 150000), "EVIDENCE_TYPE")','require(True, "EVIDENCE_TYPE")',malformed_duration),
 ('value["retryPressedObservationOutcome"] == "pressed"','True',pending_cannot_qualify),
 ('type(value["retryDownCallElapsedMs"]) is int, "MODULE_INPUT_FACTS")','True, "MODULE_INPUT_FACTS")',unknown_duration_cannot_qualify),
 ('safe = dict(value)','safe = dict(value)\n    safe["retryPressedObservationOutcome"] = "unpressed"',pending_is_preserved),
 ('safe = dict(value)','safe = dict(value)\n    safe["retryDownCallElapsedMs"] = 0 if safe["retryDownCallElapsedMs"] is None else safe["retryDownCallElapsedMs"]',pending_is_preserved),
]
for before,after,probe in mutants:
 probe(vars(m))
 assert original.count(before)==1
 api={'__name__':'owned_diagnostic_mutant','__file__':m.__file__}
 exec(compile(original.replace(before,after,1),'<owned-diagnostic-mutant>','exec'),api)
 try:probe(api)
 except AssertionError:pass
 else:raise AssertionError('individual diagnostic mutant survived')
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
