import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./android-runtime-instrumentation/app/src/main/java/com/yawf/runtimeinstrumentation/FlowPolicy.java', import.meta.url), 'utf8');
const legacyPair = /\(LEGACY_CANDIDATE_VERSION\.equals\(candidateVersion\)\s*&&\s*LEGACY_PUBLISHED_VERSION\.equals\(publishedVersion\)\)/s;
const currentPair = /\(CURRENT_CANDIDATE_VERSION\.equals\(candidateVersion\)\s*&&\s*CURRENT_PUBLISHED_VERSION\.equals\(publishedVersion\)\)/s;
const nextPair = /\(NEXT_CANDIDATE_VERSION\.equals\(candidateVersion\)\s*&&\s*NEXT_PUBLISHED_VERSION\.equals\(publishedVersion\)\)/s;
const exactVersionPairOracle = /public static boolean isExpectedVersionPair\(String candidateVersion, String publishedVersion\) \{\s*return \(LEGACY_CANDIDATE_VERSION\.equals\(candidateVersion\)\s*&&\s*LEGACY_PUBLISHED_VERSION\.equals\(publishedVersion\)\)\s*\|\| \(CURRENT_CANDIDATE_VERSION\.equals\(candidateVersion\)\s*&&\s*CURRENT_PUBLISHED_VERSION\.equals\(publishedVersion\)\)\s*\|\| \(NEXT_CANDIDATE_VERSION\.equals\(candidateVersion\)\s*&&\s*NEXT_PUBLISHED_VERSION\.equals\(publishedVersion\)\);\s*\}/s;

function assertVersionPairContract(value) {
  assert.match(value, /LEGACY_CANDIDATE_VERSION = "2\.3\.26"/);
  assert.match(value, /LEGACY_PUBLISHED_VERSION = "2\.3\.25"/);
  assert.match(value, /CURRENT_CANDIDATE_VERSION = "2\.3\.27"/);
  assert.match(value, /CURRENT_PUBLISHED_VERSION = "2\.3\.26"/);
  assert.match(value, /NEXT_CANDIDATE_VERSION = "2\.3\.29"/);
  assert.match(value, /NEXT_PUBLISHED_VERSION = "2\.3\.27"/);
  assert.match(value, legacyPair);
  assert.match(value, currentPair);
  assert.match(value, nextPair);
  assert.match(value, exactVersionPairOracle);
}

test('admits only exact 26/25, 27/26, and 29/27 version pairs', () => {
  assertVersionPairContract(source);
});

for (const [name, mutate] of [
  ['current 27/26 pair', (s) => s.replace(/CURRENT_PUBLISHED_VERSION = "2\.3\.26"/, 'CURRENT_PUBLISHED_VERSION = "2.3.25"')],
  ['legacy 26/25 pair', (s) => s.replace(/LEGACY_PUBLISHED_VERSION = "2\.3\.25"/, 'LEGACY_PUBLISHED_VERSION = "2.3.24"')],
  ['next 29 candidate literal to 27', (s) => s.replace(/NEXT_CANDIDATE_VERSION = "2\.3\.29"/, 'NEXT_CANDIDATE_VERSION = "2.3.27"')],
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
