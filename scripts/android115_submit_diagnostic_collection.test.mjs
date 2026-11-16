import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/android115-unfaulted-qa.yml', import.meta.url), 'utf8');
const start = '          # BEGIN OPTIONAL SUBMIT CALL DIAGNOSTIC\n';
const end = '          # END OPTIONAL SUBMIT CALL DIAGNOSTIC\n';
assert.equal(workflow.split(start).length, 2);
assert.equal(workflow.split(end).length, 2);
const block = workflow.slice(workflow.indexOf(start), workflow.indexOf(end) + end.length);
const body = block.slice(block.indexOf('\n', block.indexOf("<<'PY_SUBMIT_DIAGNOSTIC'")) + 1,
  block.indexOf('          PY_SUBMIT_DIAGNOSTIC\n')).replace(/^          /gm, '');
const runner = String.raw`
import json, os, pathlib, subprocess, sys, tempfile, types
from unittest import mock
body=sys.stdin.read()
scope='android-synthetic-login-submit-dispatch-diagnostic'
valid={'schemaVersion':1,'scope':scope,'returnedCallElapsedMs':1500,'dispatchResult':True,'physicalHoldMeasured':False,'qualification':False}
def encoded(value): return json.dumps(value).encode()
cases=[]
for elapsed in [0,100,250,251,1500,900000]:
    cases.append(('elapsed-'+str(elapsed),encoded(dict(valid,returnedCallElapsedMs=elapsed)),True,'normal'))
cases.append(('false-result',encoded(dict(valid,dispatchResult=False)),True,'normal'))
for label, value in [
    ('extra-field',dict(valid,privateMarker='not-for-retention')),
    ('wrong-scope',dict(valid,scope='unrecognized')),
    ('wrong-version',dict(valid,schemaVersion=2)),
    ('bool-version',dict(valid,schemaVersion=True)),
    ('bool-elapsed',dict(valid,returnedCallElapsedMs=True)),
    ('float-elapsed',dict(valid,returnedCallElapsedMs=1.5)),
    ('negative-elapsed',dict(valid,returnedCallElapsedMs=-1)),
    ('too-large-elapsed',dict(valid,returnedCallElapsedMs=900001)),
    ('string-result',dict(valid,dispatchResult='true')),
    ('physical-claim',dict(valid,physicalHoldMeasured=True)),
    ('qualification-claim',dict(valid,qualification=True)),
    ('not-object',[]),
]: cases.append((label,encoded(value),False,'normal'))
cases += [
    ('duplicate-key',encoded(valid)[:-1]+b',"dispatchResult":false}',False,'normal'),
    ('nan',encoded(valid).replace(b'1500',b'NaN'),False,'normal'),
    ('invalid-utf8',b'\xff',False,'normal'),
    ('empty',b'',False,'normal'),
    ('oversize',encoded(valid)+b' '*(1025-len(encoded(valid))),False,'normal'),
    ('missing',b'',False,'missing'),
    ('timeout',b'',False,'timeout'),
    ('existing-target',encoded(valid),False,'existing'),
    ('aggregate-cap',encoded(valid),False,'cap'),
    ('symlink-output',encoded(valid),False,'symlink'),
    ('file-output',encoded(valid),False,'file'),
]
with tempfile.TemporaryDirectory(prefix='submit-diagnostic-contract-') as temp:
    root=pathlib.Path(temp)
    for index,(label,data,expected,mode) in enumerate(cases):
        case=root/str(index);case.mkdir();out=case/'out'
        if mode=='symlink':
            actual=case/'actual';actual.mkdir();out.symlink_to(actual,target_is_directory=True)
        elif mode=='file': out.write_text('keep')
        else: out.mkdir()
        target=out/'login-submit-dispatch-diagnostic.json'
        if mode=='existing':target.write_bytes(b'keep')
        if mode=='cap':
            with (out/'retained').open('wb') as stream:stream.truncate(42*1024*1024)
        before=target.read_bytes() if target.is_file() else None
        calls=[]
        def fake_run(command,**options):
            calls.append((command,options))
            assert command==['adb','-H','127.0.0.1','-P','5142','-s','emulator-5568','exec-out','run-as','com.yawf.runtimeinstrumentation','cat','files/login-submit-dispatch-diagnostic.json']
            assert options=={'stdout':subprocess.PIPE,'stderr':subprocess.DEVNULL,'timeout':10,'check':False}
            if mode=='timeout':raise subprocess.TimeoutExpired('adb',10)
            return types.SimpleNamespace(returncode=1 if mode=='missing' else 0,stdout=data)
        with mock.patch.dict(os.environ,{'EVIDENCE':str(out),'ADB_SERVER_PORT':'5142','EMULATOR_SERIAL':'emulator-5568'}),mock.patch('subprocess.run',fake_run):
            exec(compile(body,'owned-optional-collector','exec'),{})
        after=target.read_bytes() if target.is_file() else None
        retained=after is not None and after!=before
        assert len(calls)==1, 'COLLECTOR_EXPECTATION call-count '+label
        assert retained is expected, 'COLLECTOR_EXPECTATION retention '+label
        if expected:
            assert json.loads(after)==json.loads(data), 'COLLECTOR_EXPECTATION value '+label
            assert len(after)<=1024 and b'privateMarker' not in after
        if mode=='existing':assert after==before
        if mode=='symlink':assert list(actual.iterdir())==[]
        if mode=='file':assert out.read_text()=='keep'
print('COLLECTOR_SCENARIOS_PASSED',len(cases))
`;

function run(source) {
  if (process.platform === 'darwin') assert.ok(resolve(tmpdir()).startsWith('/Volumes/Work/'));
  return spawnSync('python3', ['-I', '-B', '-c', runner], {
    input: source, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
  });
}

test('optional sibling diagnostic retains only closed scalar schema within original aggregate budget', () => {
  const result = run(body);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /COLLECTOR_SCENARIOS_PASSED 30/);
});

const mutations = [
  ['extra fields', " and set(value)=={'schemaVersion','scope','returnedCallElapsedMs','dispatchResult','physicalHoldMeasured','qualification'}", ''],
  ['raw byte cap', '0<len(result.stdout)<=1024', 'len(result.stdout)>0'],
  ['scope', "value['scope']=='android-synthetic-login-submit-dispatch-diagnostic'", 'True'],
  ['physical claim', "value['physicalHoldMeasured'] is False", 'True'],
  ['aggregate cap', '<=42*1024*1024', '<=999*1024*1024'],
];
for (const [label, before, after] of mutations) {
  test(`optional diagnostic semantic mutant rejects ${label}`, () => {
    assert.equal(body.split(before).length, 2);
    const result = run(body.replace(before, after));
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COLLECTOR_EXPECTATION/);
  });
}

test('optional collector cannot replace the unchanged native failure gate', () => {
  const root = mkdtempSync(join(tmpdir(), 'submit-diagnostic-shell-'));
  try {
    for (const [raw, expectedMarker] of [[block, true], [block.replace("<<'PY_SUBMIT_DIAGNOSTIC' || true", "<<'PY_SUBMIT_DIAGNOSTIC'"), false]]) {
      const source = raw.replace(/^          /gm, '');
      const script = `set -euo pipefail\npython3() { return 7; }\ninstrumentation_status=1\n${source}\nprintf 'NATIVE_GATE_REACHED\\n'\ntest "$instrumentation_status" -eq 0\nprintf 'INCORRECT_SUCCESS\\n'\n`;
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8', timeout: 5000, env: { ...process.env, EVIDENCE: root },
      });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout.includes('NATIVE_GATE_REACHED'), expectedMarker);
      assert.doesNotMatch(result.stdout, /INCORRECT_SUCCESS/);
    }
  } finally { rmSync(root, { recursive: true }); }
});
