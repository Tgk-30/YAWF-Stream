import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const javaHome = process.env.JAVA_HOME;
const javaTool = (name) => javaHome ? join(javaHome, 'bin', name) : name;

const source = readFileSync(new URL('./android-runtime-instrumentation/app/src/main/java/com/yawf/runtimeinstrumentation/FlowPolicy.java', import.meta.url), 'utf8');
const entrypoint = readFileSync(new URL('./android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeFlowTest.java', import.meta.url), 'utf8');
const legacyPair = /\(LEGACY_CANDIDATE_VERSION\.equals\(candidateVersion\)\s*&&\s*LEGACY_PUBLISHED_VERSION\.equals\(publishedVersion\)\)/s;
const currentPair = /\(CURRENT_CANDIDATE_VERSION\.equals\(candidateVersion\)\s*&&\s*CURRENT_PUBLISHED_VERSION\.equals\(publishedVersion\)\)/s;
const nextPair = /\(NEXT_CANDIDATE_VERSION\.equals\(candidateVersion\)\s*&&\s*NEXT_PUBLISHED_VERSION\.equals\(publishedVersion\)\)/s;
const exactVersionPairOracle = /public static boolean isExpectedVersionPair\(String candidateVersion, String publishedVersion\) \{\s*return \(LEGACY_CANDIDATE_VERSION\.equals\(candidateVersion\)\s*&&\s*LEGACY_PUBLISHED_VERSION\.equals\(publishedVersion\)\)\s*\|\| \(CURRENT_CANDIDATE_VERSION\.equals\(candidateVersion\)\s*&&\s*CURRENT_PUBLISHED_VERSION\.equals\(publishedVersion\)\)\s*\|\| \(NEXT_CANDIDATE_VERSION\.equals\(candidateVersion\)\s*&&\s*NEXT_PUBLISHED_VERSION\.equals\(publishedVersion\)\);\s*\}/s;

function assertVersionPairContract(value) {
  assert.match(value, /LEGACY_CANDIDATE_VERSION = "2\.3\.26"/);
  assert.match(value, /LEGACY_PUBLISHED_VERSION = "2\.3\.25"/);
  assert.match(value, /CURRENT_CANDIDATE_VERSION = "2\.3\.27"/);
  assert.match(value, /CURRENT_PUBLISHED_VERSION = "2\.3\.26"/);
  assert.match(value, /NEXT_CANDIDATE_VERSION = "2\.3\.31"/);
  assert.match(value, /NEXT_PUBLISHED_VERSION = "2\.3\.27"/);
  assert.match(value, legacyPair);
  assert.match(value, currentPair);
  assert.match(value, nextPair);
  assert.match(value, exactVersionPairOracle);
  assert.match(entrypoint, /FlowPolicy\.isExpectedVersionPair\(candidateVersion, publishedVersion\)/);
}


test('executes the actual Java predicate against accepted and rejected tuples', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-policy-'));
  try {
    writeFileSync(join(dir, 'Probe.java'), `import com.yawf.runtimeinstrumentation.FlowPolicy;
public final class Probe { public static void main(String[] a) { String[][] yes={{"2.3.26","2.3.25"},{"2.3.27","2.3.26"},{"2.3.31","2.3.27"}}; String[][] no={{"2.3.30","2.3.27"},{"2.3.31","2.3.26"},{"2.3.31","2.3.28"},{"2.3.32","2.3.27"},{null,""},{"",""}}; for(String[] p:yes) if(!FlowPolicy.isExpectedVersionPair(p[0],p[1])) throw new AssertionError("accepted tuple rejected"); for(String[] p:no) if(FlowPolicy.isExpectedVersionPair(p[0],p[1])) throw new AssertionError("rejected tuple accepted"); } }`);
    execFileSync(javaTool('javac'), ['-d', dir, 'scripts/android-runtime-instrumentation/app/src/main/java/com/yawf/runtimeinstrumentation/FlowPolicy.java', join(dir, 'Probe.java')]);
    execFileSync(javaTool('java'), ['-cp', dir, 'Probe']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('executes the 31-to-30 mutation and rejects the fixed tuple', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-policy-mutant-'));
  try {
    const pkg = join(dir, 'com', 'yawf', 'runtimeinstrumentation');
    const mutant = source.replace('NEXT_CANDIDATE_VERSION = "2.3.31"', 'NEXT_CANDIDATE_VERSION = "2.3.30"');
    mkdirSync(pkg, { recursive: true });
    const policy = join(pkg, 'FlowPolicy.java');
    writeFileSync(policy, mutant, { flag: 'w' });
    const probe = join(dir, 'Probe.java');
    writeFileSync(probe, `import com.yawf.runtimeinstrumentation.FlowPolicy; public final class Probe { public static void main(String[] a) { if (FlowPolicy.isExpectedVersionPair("2.3.31", "2.3.27")) throw new AssertionError("mutant admitted fixed tuple"); } }`);
    execFileSync(javaTool('javac'), ['-d', dir, policy, probe]);
    execFileSync(javaTool('java'), ['-cp', dir, 'Probe']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('admits only exact 26/25, 27/26, and 31/27 version pairs', () => {
  assertVersionPairContract(source);
});

for (const [name, mutate] of [
  ['current 27/26 pair', (s) => s.replace(/CURRENT_PUBLISHED_VERSION = "2\.3\.26"/, 'CURRENT_PUBLISHED_VERSION = "2.3.25"')],
  ['legacy 26/25 pair', (s) => s.replace(/LEGACY_PUBLISHED_VERSION = "2\.3\.25"/, 'LEGACY_PUBLISHED_VERSION = "2.3.24"')],
  ['next 31 candidate literal to 30', (s) => s.replace(/NEXT_CANDIDATE_VERSION = "2\.3\.31"/, 'NEXT_CANDIDATE_VERSION = "2.3.30"')],
  ['next 27 stable literal to 26', (s) => s.replace(/NEXT_PUBLISHED_VERSION = "2\.3\.27"/, 'NEXT_PUBLISHED_VERSION = "2.3.26"')],
  ['next 27 stable literal to 28', (s) => s.replace(/NEXT_PUBLISHED_VERSION = "2\.3\.27"/, 'NEXT_PUBLISHED_VERSION = "2.3.28"')],
  ['next pair oracle removal', (s) => s.replace(nextPair, 'false')],
  ['next candidate-only acceptance', (s) => s.replace(nextPair, '(NEXT_CANDIDATE_VERSION.equals(candidateVersion))')],
  ['unknown non-null candidate catch-all', (s) => s.replace(nextPair, (match) => `${match} || candidateVersion != null`)],
]) {
  test(`rejects mutated ${name} admission`, () => {
    const mutant = mutate(source);
    assert.notEqual(mutant, source);
    assert.throws(() => assertVersionPairContract(mutant));
  });
}
