import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const source = readFileSync(process.env.SERVER97_WORKFLOW_FIXTURE || new URL('../.github/workflows/server97-native-install.yml', import.meta.url), 'utf8');
const previousRepair = "from pathlib import Path\nimport re\nroot = Path('/etc/apt')\nazure = re.compile(r'(?<!\\S)https?://azure\\.archive\\.ubuntu\\.com/ubuntu/?(?=\\s|$)')\nchanged = 0\nfor relative in ['sources.list', 'sources.list.d/ubuntu.sources', 'apt-mirrors.txt', 'apt-mirrors-security.txt']:\n    path = root / relative\n    if path.is_symlink():\n        raise SystemExit('Unexpected Ubuntu source indirection')\n    if not path.exists():\n        continue\n    before = path.read_text()\n    if relative.endswith('.sources'):\n        stanzas = re.split(r'(\\n[ \\t]*\\n)', before)\n        for i in range(0, len(stanzas), 2):\n            stanza = stanzas[i]\n            suites = re.findall(r'^Suites:[ \\t]*(.*)$', stanza, re.M)\n            security = bool(suites and all(s.endswith('-security') for s in suites[0].split()))\n            uri = 'https://security.ubuntu.com/ubuntu' if security else 'https://archive.ubuntu.com/ubuntu'\n            def replace_uris(match):\n                value = match.group()\n                comment = re.search(r'(?<!\\S)#', value)\n                return azure.sub(uri, value[:comment.start()]) + value[comment.start():] if comment else azure.sub(uri, value)\n            stanzas[i] = re.sub(r'^URIs:.*$', replace_uris, stanza, flags=re.M)\n        after = ''.join(stanzas)\n    else:\n        lines = []\n        for line in before.splitlines(keepends=True):\n            if relative.endswith('.txt'):\n                match = re.match(r'^[ \\t]*(\\S+)', line)\n                security = relative == 'apt-mirrors-security.txt'\n            else:\n                match = re.match(r'^[ \\t]*deb(?:-src)?[ \\t]+(?:\\[[^\\]\\n]*\\][ \\t]+)?(\\S+)', line)\n                remainder = line[match.end(1):].split() if match else []\n                security = bool(remainder and remainder[0].endswith('-security'))\n            if match and azure.fullmatch(match.group(1)):\n                uri = 'https://security.ubuntu.com/ubuntu' if security else 'https://archive.ubuntu.com/ubuntu'\n                line = line[:match.start(1)] + uri + line[match.end(1):]\n            lines.append(line)\n        after = ''.join(lines)\n    if after != before:\n        path.write_text(after)\n        changed += 1\nprint('Canonical Ubuntu source files repaired:', changed)";
const previousRepairSHA256 = 'a0ed53e2e9770414335e99e6e4439ef52cabae7adc6dcc6f8c12b6c911d79191';
const original = readFileSync(new URL('../.github/workflows/deb-release.yml', import.meta.url), 'utf8');
const names = ['Verify and install exact candidate', 'Verify installed service metadata',
  'Smoke exact installed payload as service user', 'Start, restart, and inspect the systemd service'];
function step(text, name) {
  const marker = `      - name: ${name}\n`, start = text.indexOf(marker);
  assert.ok(start >= 0, name); assert.equal(text.indexOf(marker, start + marker.length), -1);
  const end = text.indexOf('\n      - name:', start + marker.length);
  return text.slice(start, end < 0 ? text.length : end);
}
function validate(text) {
  assert.ok(text.includes('permissions:\n  contents: read\n  actions: read\n'));
  assert.doesNotMatch(text, /secrets\.|: write|pull_request|workflow_run|schedule:|npm |build_deb|force-depends|allow-unauthenticated|allow-insecure|trusted=yes|AllowUnauthenticated|AllowInsecure|Check-Valid-Until/i);
  const native = text.slice(text.indexOf('\n  native-install:\n'));
  for (const fragment of ["github.event_name == 'workflow_dispatch'", "github.repository == 'Tgk-30/YAWF-Stream'",
    "github.repository_owner == 'Tgk-30'", "github.actor == 'Tgk-30'", "github.ref_type == 'branch'",
    "github.ref == 'refs/heads/codex/server97-native-install'", 'needs: host-contracts',
    'runner: [ubuntu-22.04, ubuntu-24.04]', 'runs-on: ${{ matrix.runner }}', 'timeout-minutes: 15',
    'ref: c5d6106efe0ea7a7a62197ff5f6957006d1e026f', 'persist-credentials: false',
    'name: debridstreamer-server-deb', 'repository: Tgk-30/YAWF-Stream', 'run-id: 43049144954', 'github-token: ${{ github.token }}',
    "test \"$(stat -c '%s' \"$candidate\")\" = 4252472",
    '7588c5fa126942982b6179d46ffdf37311a909c5740de0a64804170d53db278e  $candidate',
    'test ! -L "$candidate"', 'sha256sum --check -',
    '      - name: Retain bounded non-secret failure diagnostics\n        if: always()',
    '      - name: Upload native installation evidence even on failure\n        if: always()']) assert.ok(native.includes(fragment), fragment);
  assert.ok(native.indexOf('Admit fixed97 bytes') < native.indexOf('Verify and install exact candidate'));
  assert.ok(native.indexOf('Repair only exact Ubuntu URI tokens') < native.indexOf('Install bounded disposable'));
  const prereq = step(text, 'Install bounded disposable Node24 and FFmpeg prerequisites');
  for (const fragment of ['timeout-minutes: 8\n', '--connect-timeout 10 --max-time 60',
    'Acquire::http::Timeout "30";', 'Acquire::https::Timeout "30";', 'Acquire::Retries "1";', 'DPkg::Lock::Timeout "60";',
    "dpkg-query -W -f='${Status}' nodejs", "dpkg-query -W -f='${Version}' nodejs", ' ge 24',
    'signed-by=/usr/share/keyrings/nodesource.gpg', 'gpg --batch --yes --dearmor',
    'https://deb.nodesource.com/node_24.x nodistro main', 'sudo apt-get -o APT::Update::Error-Mode=any update', 'sudo apt-get install -y nodejs ffmpeg']) assert.ok(prereq.includes(fragment), fragment);
  assert.equal((prereq.match(/dpkg-query -W -f='\$\{Status\}' nodejs/g) ?? []).length, 2);
  assert.doesNotMatch(prereq.replace(/            # BEGIN fixed Ubuntu HTTPS preflight[\s\S]*?            # END fixed Ubuntu HTTPS preflight\n/, ''), /while |until |for |setup_24|\| sudo.*bash/);
  assert.equal((prereq.match(/curl /g) ?? []).length, 2);
  assert.ok(prereq.includes("--proto '=https' --connect-timeout 10 --max-time 30 --max-filesize 1048576"));
  assert.ok(prereq.includes('. /etc/os-release'));
  assert.ok(prereq.includes('case "$VERSION_CODENAME" in jammy|noble)'));
  assert.ok(prereq.includes('sys.stdin.buffer.read(1048581)'));
  assert.ok(prereq.includes('data.endswith(b"\\n200")'));
  assert.ok(prereq.includes('-----BEGIN PGP SIGNED MESSAGE-----'));
  assert.ok(native.includes('${{ runner.temp }}/ubuntu-mirror-preflight/*.InRelease'));
  const repair = step(text, 'Repair only exact Ubuntu URI tokens to HTTPS mirror');
  assert.ok(repair.includes("['sources.list', 'sources.list.d/ubuntu.sources', 'apt-mirrors.txt', 'apt-mirrors-security.txt']"));
  assert.ok(repair.includes("Path('/etc/apt')"));
  assert.ok(repair.includes('https://mirrors.edge.kernel.org/ubuntu'));
  assert.ok(repair.includes('azure\\.archive\\.ubuntu\\.com|archive\\.ubuntu\\.com|security\\.ubuntu\\.com'));
  assert.doesNotMatch(repair, /rglob|glob\(|unlink|Signed-By:|Components:/);
  for (const name of names) assert.equal(step(text, name), step(original, name), name);
}
test('exact immutable artifact, manual native scope, least privilege and bounded prerequisites', () => validate(source));
for (const name of names) test(`native product verification preserved byte-for-byte: ${name}`, () => {
  assert.equal(step(source, name), step(original, name));
});
for (const [name, from, to] of [
  ['manual guard', "github.event_name == 'workflow_dispatch'", "github.event_name == 'push'"],
  ['branch', "github.ref == 'refs/heads/codex/server97-native-install'", "github.ref == 'refs/heads/main'"],
  ['actor', "github.actor == 'Tgk-30'", "github.actor != ''"],
  ['repo', "github.repository == 'Tgk-30/YAWF-Stream'", "github.repository != ''"],
  ['owner', "github.repository_owner == 'Tgk-30'", "github.repository_owner != ''"],
  ['source pin', 'ref: c5d6106efe0ea7a7a62197ff5f6957006d1e026f', 'ref: main'],
  ['run pin', 'run-id: 43049144954', 'run-id: 1'],
  ['artifact name', 'name: debridstreamer-server-deb', 'name: latest'],
  ['token boundary', 'github-token: ${{ github.token }}', 'github-token: unbound'],
  ['size', '= 4252472', '= 1'],
  ['hash', '7588c5fa126942982b6179d46ffdf37311a909c5740de0a64804170d53db278e', '0'.repeat(64)],
  ['job deadline', 'timeout-minutes: 15', 'timeout-minutes: 60'],
  ['prerequisite deadline', 'timeout-minutes: 8', 'timeout-minutes: 80'],
  ['curl bound', '--connect-timeout 10 --max-time 60', '--connect-timeout 10'],
  ['APT timeout', 'Acquire::http::Timeout "30";', 'Acquire::http::Timeout "0";'],
  ['APT retries', 'Acquire::Retries "1";', 'Acquire::Retries "10";'],
  ['APT lock', 'DPkg::Lock::Timeout "60";', 'DPkg::Lock::Timeout "-1";'],
  ['dependency admission', "dpkg-query -W -f='${Status}' nodejs", 'echo installed'],
  ['signature validation', 'signed-by=/usr/share/keyrings/nodesource.gpg', 'trusted=yes'],
  ['mirror allowlist', "['sources.list', 'sources.list.d/ubuntu.sources', 'apt-mirrors.txt', 'apt-mirrors-security.txt']", "['sources.list', 'sources.list.d/other.list']"],
  ['failure evidence', '      - name: Upload native installation evidence even on failure\n        if: always()', '      - name: Upload native installation evidence even on failure\n        if: success()'],
  ['product assertion', 'test -f /opt/debridstreamer/server/dist/index.cjs', 'true # omitted installed entry check'],
]) test(`individual negative: ${name}`, () => {
  const start=source.indexOf('\n  native-install:\n');const job=source.slice(start);const changed=job.replace(from,to);
  assert.notEqual(changed,job);assert.throws(()=>validate(source.slice(0,start)+changed));
});
function repairProgram() {
  const body=step(source,'Repair only exact Ubuntu URI tokens to HTTPS mirror');
  const match=body.match(/          sudo python3 - <<'PYTHON'\n([\s\S]*?)\n          PYTHON/);assert.ok(match);
  return match[1].split('\n').map(line=>line.slice(10)).join('\n');
}
function withFixture(fn) {
  const root=mkdtempSync(join(tmpdir(),'server97-mirrors-'));
  try { mkdirSync(join(root,'sources.list.d'));fn(root); } finally {rmSync(root,{recursive:true,force:true});}
}
test('mirror repair changes only exact Azure Ubuntu URIs and preserves suites/components/GPG/other repos',()=>withFixture(root=>{
  const list='deb [signed-by=/key.gpg] http://azure.archive.ubuntu.com/ubuntu jammy main universe\n'
    +'deb https://azure.archive.ubuntu.com/ubuntu/ jammy-security main\n'
    +'deb https://other.example/ubuntu jammy main\n# http://azure.archive.ubuntu.com/ubuntu jammy main\n';
  const deb822='Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu\nSuites: noble noble-updates noble-backports\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\n'
    +'Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu\nSuites: noble-security\nComponents: main\nSigned-By: /key.gpg\n';
  writeFileSync(join(root,'sources.list'),list);writeFileSync(join(root,'sources.list.d/ubuntu.sources'),deb822);
  writeFileSync(join(root,'sources.list.d/other.list'),'http://azure.archive.ubuntu.com/ubuntu');
  const result=spawnSync('python3',['-c',repairProgram().replace("Path('/etc/apt')",`Path(${JSON.stringify(root)})`)],{encoding:'utf8',timeout:5000,maxBuffer:65536});
  assert.equal(result.status,0,result.stderr);
  assert.equal(readFileSync(join(root,'sources.list'),'utf8'),list.replace('http://azure.archive.ubuntu.com/ubuntu jammy','https://mirrors.edge.kernel.org/ubuntu jammy').replace('https://azure.archive.ubuntu.com/ubuntu/ jammy-security','https://mirrors.edge.kernel.org/ubuntu jammy-security'));
  assert.equal(readFileSync(join(root,'sources.list.d/ubuntu.sources'),'utf8'),deb822.replace('http://azure.archive.ubuntu.com/ubuntu','https://mirrors.edge.kernel.org/ubuntu').replace('http://azure.archive.ubuntu.com/ubuntu','https://mirrors.edge.kernel.org/ubuntu'));
  assert.equal(readFileSync(join(root,'sources.list.d/other.list'),'utf8'),'http://azure.archive.ubuntu.com/ubuntu');
}));
test('mirror repair rejects symlink without following it',()=>withFixture(root=>{
  const target=join(root,'untouched');writeFileSync(target,'owned fixture');symlinkSync(target,join(root,'sources.list'));
  const r=spawnSync('python3',['-c',repairProgram().replace("Path('/etc/apt')",`Path(${JSON.stringify(root)})`)],{encoding:'utf8',timeout:5000,maxBuffer:65536});
  assert.notEqual(r.status,0);assert.equal(readFileSync(target,'utf8'),'owned fixture');
}));
test('all generated bash blocks parse without executing installation or network',()=>{
  const blocks=[...source.matchAll(/        run: \|\n([\s\S]*?)(?=\n      - |$)/g)];assert.ok(blocks.length>=8);
  for(const [,body]of blocks){const code=body.split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');
    const r=spawnSync('bash',['-n'],{input:code,encoding:'utf8',timeout:5000,maxBuffer:65536});assert.equal(r.status,0,r.stderr);}
});

test('rejects broader permissions and credential expressions',()=>{
  for(const [from,to]of [['actions: read','actions: write'],['contents: read','contents: write'],['${{ github.token }}','${{ secrets.PRIVATE_TOKEN }}']]) {
    const changed=source.replace(from,to);assert.notEqual(changed,source);assert.throws(()=>validate(changed));
  }
});

for (const [format, relative, content] of [
  ['list', 'sources.list', 'deb [signed-by=/key.gpg arch=amd64] https://other.example/cache/http://azure.archive.ubuntu.com/ubuntu jammy main # http://azure.archive.ubuntu.com/ubuntu\n'],
  ['deb822', 'sources.list.d/ubuntu.sources', 'Types: deb\nURIs: https://other.example/cache/http://azure.archive.ubuntu.com/ubuntu http://azure.archive.ubuntu.com/ubuntu#fragment\nSuites: noble\nComponents: main\nSigned-By: /key.gpg\n# http://azure.archive.ubuntu.com/ubuntu\n'],
]) test(`complete URI fence preserves embedded Azure suffix: ${format}, rejects old unbounded matching`,()=>withFixture(root=>{
  const path=join(root,relative);writeFileSync(path,content);
  const program=repairProgram().replace("Path('/etc/apt')",`Path(${JSON.stringify(root)})`);
  const run=p=>{const r=spawnSync('python3',['-c',p],{encoding:'utf8',timeout:5000,maxBuffer:65536});assert.equal(r.status,0,r.stderr);return readFileSync(path,'utf8');};
  assert.equal(run(program),content);
  // Individually red control: restore the old missing-boundary matching behavior.
  const oldMatching=program.replace('(?<!\\S)','').replace('ubuntu.fullmatch(match.group(1))','ubuntu.search(match.group(1))');
  assert.notEqual(oldMatching,program);writeFileSync(path,content);
  assert.throws(()=>assert.equal(run(oldMatching),content));
}));
test('only the two exact optional mirror lists are repaired, preserving qualifiers/comments/other hosts',()=>withFixture(root=>{
  for(const [name,canonical]of [['apt-mirrors.txt','https://mirrors.edge.kernel.org/ubuntu'],['apt-mirrors-security.txt','https://mirrors.edge.kernel.org/ubuntu']]) {
    const input='  http://azure.archive.ubuntu.com/ubuntu/ priority:1\nhttps://other.example/cache/http://azure.archive.ubuntu.com/ubuntu priority:2\n# http://azure.archive.ubuntu.com/ubuntu\nhttps://other.example/ubuntu\n';
    writeFileSync(join(root,name),input);
  }
  writeFileSync(join(root,'unrelated-mirrors.txt'),'http://azure.archive.ubuntu.com/ubuntu\n');
  const r=spawnSync('python3',['-c',repairProgram().replace("Path('/etc/apt')",`Path(${JSON.stringify(root)})`)],{encoding:'utf8',timeout:5000,maxBuffer:65536});assert.equal(r.status,0,r.stderr);
  for(const [name,canonical]of [['apt-mirrors.txt','https://mirrors.edge.kernel.org/ubuntu'],['apt-mirrors-security.txt','https://mirrors.edge.kernel.org/ubuntu']]) {
    assert.equal(readFileSync(join(root,name),'utf8'),`  ${canonical} priority:1\nhttps://other.example/cache/http://azure.archive.ubuntu.com/ubuntu priority:2\n# http://azure.archive.ubuntu.com/ubuntu\nhttps://other.example/ubuntu\n`);
  }
  assert.equal(readFileSync(join(root,'unrelated-mirrors.txt'),'utf8'),'http://azure.archive.ubuntu.com/ubuntu\n');
}));
for(const name of ['apt-mirrors.txt','apt-mirrors-security.txt']) test(`optional mirror list symlink rejected: ${name}`,()=>withFixture(root=>{
  const target=join(root,'untouched');writeFileSync(target,'owned fixture');symlinkSync(target,join(root,name));
  const r=spawnSync('python3',['-c',repairProgram().replace("Path('/etc/apt')",`Path(${JSON.stringify(root)})`)],{encoding:'utf8',timeout:5000,maxBuffer:65536});
  assert.notEqual(r.status,0);assert.equal(readFileSync(target,'utf8'),'owned fixture');
}));

function executeRepair(program, root) {
  return spawnSync('python3', ['-c', program.replace("Path('/etc/apt')", `Path(${JSON.stringify(root)})`)],
    {encoding:'utf8',timeout:5000,maxBuffer:65536});
}
test('previous repair control is the exact immutable failing implementation',()=>{
  assert.equal(createHash('sha256').update(previousRepair).digest('hex'),previousRepairSHA256);
});
for(const host of ['azure.archive.ubuntu.com','archive.ubuntu.com','security.ubuntu.com'])
  test(`exact ${host} tokens become the HTTPS mirror in all four files; previous repair individually RED`,()=>withFixture(root=>{
    const address=`http://${host}/ubuntu`, secure=`https://${host}/ubuntu/`, mirror='https://mirrors.edge.kernel.org/ubuntu';
    const list=(a,b)=>`deb [signed-by=/key.gpg arch=amd64] ${a} jammy main universe # ${address}\ndeb-src ${b} jammy-security main\n`;
    const deb822=(a,b)=>`Types: deb\nURIs: ${a} ${b} # ${address}\n ${a}\nSuites: noble noble-updates noble-backports noble-security\nComponents: main universe\nSigned-By: /key.gpg\n# ${address}\n`;
    const inputs={'sources.list':list(address,secure),'sources.list.d/ubuntu.sources':deb822(address,secure),
      'apt-mirrors.txt':`${address} priority:1\n# ${address}\n`,'apt-mirrors-security.txt':`${secure} priority:1\n# ${address}\n`};
    const wanted={'sources.list':list(mirror,mirror),'sources.list.d/ubuntu.sources':deb822(mirror,mirror),
      'apt-mirrors.txt':`${mirror} priority:1\n# ${address}\n`,'apt-mirrors-security.txt':`${mirror} priority:1\n# ${address}\n`};
    const reset=()=>Object.entries(inputs).forEach(([name,value])=>writeFileSync(join(root,name),value));
    const oracle=()=>Object.entries(wanted).forEach(([name,value])=>assert.equal(readFileSync(join(root,name),'utf8'),value));
    reset();let run=executeRepair(repairProgram(),root);assert.equal(run.status,0,run.stderr);oracle();
    reset();run=executeRepair(previousRepair,root);assert.equal(run.status,0,run.stderr);assert.throws(oracle);
  }));
test('exact token repair preserves malicious hosts suffixes comments options and key fields',()=>withFixture(root=>{
  const rows=['https://archive.ubuntu.com.evil/ubuntu','https://archive.ubuntu.com:443/ubuntu',
    'https://archive.ubuntu.com/ubuntu/extra','https://archive.ubuntu.com/ubuntu?query=1',
    'https://security.ubuntu.com/ubuntu#fragment','https://foreign.example/cache/http://archive.ubuntu.com/ubuntu',
    'https://user@archive.ubuntu.com/ubuntu'];
  const input=rows.map(uri=>`deb [signed-by=/key.gpg] ${uri} noble main # http://archive.ubuntu.com/ubuntu\n`).join('')
    +'# deb http://archive.ubuntu.com/ubuntu noble main\n';
  const deb822='Types: deb\nURIs: '+rows.join(' ')+'\nSuites: noble-security\nComponents: main\nSigned-By: http://archive.ubuntu.com/ubuntu\n# http://security.ubuntu.com/ubuntu\n';
  writeFileSync(join(root,'sources.list'),input);writeFileSync(join(root,'sources.list.d/ubuntu.sources'),deb822);
  const run=executeRepair(repairProgram(),root);assert.equal(run.status,0,run.stderr);
  assert.equal(readFileSync(join(root,'sources.list'),'utf8'),input);assert.equal(readFileSync(join(root,'sources.list.d/ubuntu.sources'),'utf8'),deb822);
}));
function preflightProgram(text=source) {
  const body=step(text,'Install bounded disposable Node24 and FFmpeg prerequisites');
  const match=body.match(/            # BEGIN fixed Ubuntu HTTPS preflight\n([\s\S]*?)            # END fixed Ubuntu HTTPS preflight/);
  assert.ok(match,'bounded prerequisite preflight must exist');
  return match[1].split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');
}
function runPreflight(root,codename,extra={}) {
  const bin=join(root,'bin');mkdirSync(bin,{recursive:true});
  writeFileSync(join(root,'os-release'),`VERSION_CODENAME=${codename}\n`);
  writeFileSync(join(bin,'curl'),`#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
with Path(os.environ['CURL_CALLS']).open('a') as out: out.write(json.dumps(sys.argv[1:])+'\\n')
body = b'-----BEGIN PGP SIGNED MESSAGE-----\\nHash: SHA512\\n\\nsynthetic signed-prefix fixture\\n'
if os.environ.get('MOCK_BODY') == 'html': body = b'<html>not an InRelease</html>'
if os.environ.get('MOCK_BODY') == 'large': body = b'x' * 1048582
try:
    sys.stdout.buffer.write(body + b'\\n' + os.environ.get('MOCK_STATUS','200').encode())
except BrokenPipeError: pass
sys.exit(int(os.environ.get('MOCK_EXIT','0')))
`,{mode:0o700});
  const code=preflightProgram().replace('/etc/os-release',join(root,'os-release'));
  return spawnSync('bash',['-euo','pipefail','-c',code],{env:{...process.env,PATH:`${bin}:${process.env.PATH}`,RUNNER_TEMP:root,
    CURL_CALLS:join(root,'calls.jsonl'),...extra},encoding:'utf8',timeout:5000,maxBuffer:65536});
}
for(const codename of ['jammy','noble'])test(`four exact bounded HTTPS InRelease preflights for actual ${codename}`,()=>withFixture(root=>{
  const run=runPreflight(root,codename);assert.equal(run.status,0,run.stderr);
  const calls=readFileSync(join(root,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const suites=[codename,`${codename}-updates`,`${codename}-backports`,`${codename}-security`];
  assert.equal(calls.length,4);
  calls.forEach((args,index)=>{assert.equal(args.at(-1),`https://mirrors.edge.kernel.org/ubuntu/dists/${suites[index]}/InRelease`);
    for(const [key,wanted]of [['--proto','=https'],['--connect-timeout','10'],['--max-time','30'],['--max-filesize','1048576']])assert.equal(args[args.indexOf(key)+1],wanted);
    assert.ok(args.includes('--fail'));assert.ok(!args.includes('--location'));
    const body=readFileSync(join(root,'ubuntu-mirror-preflight',`${suites[index]}.InRelease`));assert.ok(body.length<=1048576);assert.ok(body.toString().startsWith('-----BEGIN PGP SIGNED MESSAGE-----\n'));
  });
  const metadata=run.stdout.trim().split('\n').map(JSON.parse);assert.equal(metadata.length,4);
  metadata.forEach((row,index)=>{assert.deepEqual(Object.keys(row).sort(),['bytes','clearSignedPrefix','sha256','suite']);assert.equal(row.suite,suites[index]);assert.equal(row.clearSignedPrefix,true)});
  const without=source.replace(/            # BEGIN fixed Ubuntu HTTPS preflight[\s\S]*?            # END fixed Ubuntu HTTPS preflight\n/,'');
  assert.throws(()=>preflightProgram(without));
}));
for(const [name,config]of [['HTTP failure',{MOCK_STATUS:'503'}],['HTML body',{MOCK_BODY:'html'}],['oversized body',{MOCK_BODY:'large'}],['curl failure',{MOCK_EXIT:'28'}]])
 test(`preflight fails closed without APT: ${name}`,()=>withFixture(root=>{const run=runPreflight(root,'jammy',config);assert.notEqual(run.status,0)}));
test('unknown codename refuses before any curl and APT index errors are fatal',()=>withFixture(root=>{
  const run=runPreflight(root,'unadmitted');assert.notEqual(run.status,0);
  assert.throws(()=>readFileSync(join(root,'calls.jsonl')));
  assert.ok(source.includes('sudo apt-get -o APT::Update::Error-Mode=any update'));
  assert.throws(()=>validate(source.replace('sudo apt-get -o APT::Update::Error-Mode=any update','sudo apt-get update')));
}));
