import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = new URL("./run_android_owned_startup_hosted.py", import.meta.url);
const fixture = String.raw`
import ast, types, sys
tree=ast.parse(open(sys.argv[1]).read())
main=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='main')
cleanup=next(n for n in main.body if isinstance(n,ast.FunctionDef) and n.name=='cleanup')
signals=[];reaped=[];rows={};descendants={};mismatches=set()
class Process:
 def __init__(self,pid):self.pid=pid;self.exit=None
 def poll(self):return self.exit
 def wait(self,timeout):self.exit=0;reaped.append(self.pid);return 0
def alive(process,birth):
 if process.pid in mismatches:raise RuntimeError('IDENTITY_MISMATCH')
 assert birth==process.pid*10
def require(value,code):
 if not value:raise RuntimeError(code)
def killpg(pid,sig):signals.append(pid)
def kill(pid,sig):signals.append(pid)
def waitpid(pid,flags):rows.pop(pid);reaped.append(pid);return pid,0
class FakePath:
 def __init__(self,path):self.pid=None
 def __truediv__(self,part):
  if str(part).isdigit():self.pid=int(part)
  return self
 def read_text(self):
  if self.pid not in rows:raise FileNotFoundError()
  parent,birth=rows[self.pid];return '99 (owned) S '+str(parent)+' '+'0 '*17+str(birth)
def identity(pid):
 if pid not in rows:raise FileNotFoundError()
 return rows[pid][1],[]
class System:
 def run(self,argv,seconds,limit,guard,env):guard();return 0,b'',b''
owned=[]
namespace={'owned':owned,'descendants':descendants,'alive':alive,'require':require,'collect_descendants':lambda:None,
 'device':['private-adb-only'],'env':{},'module':types.SimpleNamespace(System=System,process_identity=identity),
 'os':types.SimpleNamespace(getpid=lambda:100,killpg=killpg,kill=kill,waitpid=waitpid,WNOHANG=1),
 'signal':types.SimpleNamespace(SIGTERM=15,SIGKILL=9),
 'subprocess':types.SimpleNamespace(TimeoutExpired=TimeoutError),
 'Path':FakePath,'time':types.SimpleNamespace(monotonic=lambda:0,sleep=lambda _:None)}
exec(compile(ast.fix_missing_locations(ast.Module(body=[cleanup],type_ignores=[])),'<isolated-cleanup>','exec'),namespace)
cleanup=namespace['cleanup']
`;

function run(body) {
  const result = spawnSync("python3", ["-B", "-c", fixture + "\n" + body, source.pathname], {
    encoding: "utf8", timeout: 10000, maxBuffer: 131072,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test("one cleanup identity refusal cannot signal it or skip later owned roles", () => run(String.raw`
for pid,label in [(22,'adb-server'),(11,'emulator'),(33,'controller')]:owned.append((Process(pid),pid*10,label))
mismatches.add(11)
facts=cleanup()
assert signals==[33,22],signals
assert next(x for x in facts if x['role']=='emulator')['ownedChildReaped'] is False
assert next(x for x in facts if x['role']=='adb-server')['ownedChildReaped'] is True
assert next(x for x in facts if x['role']=='controller')['ownedChildReaped'] is True
`));

test("adopted clients are birth-fenced and each cleanup is independent", () => run(String.raw`
rows.update({44:(100,440),55:(100,999),66:(100,660)})
descendants.update({44:440,55:550,66:660})
facts=cleanup()
assert signals==[44,66],signals
assert reaped==[44,66],reaped
assert facts==[{'role':'adopted-descendants','ownedChildReaped':False}],facts
`));

test("recipe retains provenance gates, subreaper and a ledger-owned controller", () => {
  const text = readFileSync(source, "utf8");
  assert.match(text, /for name in \([^\n]+"build-binding"\)/);
  for (const gate of ["FINAL_APK_BUILD_BINDING", "SAME_JOB_API_BUILD_REQUIRED", "API_INPUT_BUILD_BINDING",
    "TEST_MODULE_SOURCE_BINDING", "FINAL_TEST_DEX_BINDING", "ORIGINAL_NINE_GIB_START_RESERVE"])
    assert.ok(text.includes(gate), gate);
  assert.match(text, /prctl\(36, 1, 0, 0, 0\)/);
  assert.match(text, /controller, controller_birth = launch\(/);
  assert.match(text, /collect_descendants\(\)[\s\S]+"ROOT_CONTROLLER_TIMEOUT"/);
  assert.match(text, /signal\.signal\(signal\.SIGTERM, interrupted\)/);
});
