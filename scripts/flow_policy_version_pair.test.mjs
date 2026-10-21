import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./android-runtime-instrumentation/app/src/main/java/com/yawf/runtimeinstrumentation/FlowPolicy.java', import.meta.url), 'utf8');
const expectedPair = /\(CURRENT_CANDIDATE_VERSION\.equals\(candidateVersion\)\s*&&\s*CURRENT_PUBLISHED_VERSION\.equals\(publishedVersion\)\)/s;

test('admits only legacy 25 to 26 and current 26 to 27 pairs', () => {
  assert.match(source, /LEGACY_CANDIDATE_VERSION = "2\.3\.26"/);
  assert.match(source, /LEGACY_PUBLISHED_VERSION = "2\.3\.25"/);
  assert.match(source, /CURRENT_CANDIDATE_VERSION = "2\.3\.27"/);
  assert.match(source, /CURRENT_PUBLISHED_VERSION = "2\.3\.26"/);
  assert.match(source, expectedPair);
});

for (const [name, mutate] of [
  ['current pair', (s) => s.replace(/CURRENT_PUBLISHED_VERSION = "2\.3\.26"/, 'CURRENT_PUBLISHED_VERSION = "2.3.25"')],
  ['legacy pair', (s) => s.replace(/LEGACY_PUBLISHED_VERSION = "2\.3\.25"/, 'LEGACY_PUBLISHED_VERSION = "2.3.24"')],
  ['mixed pair acceptance', (s) => s.replace(expectedPair, '(CURRENT_CANDIDATE_VERSION.equals(candidateVersion))')],
]) {
  test(`rejects a mutated ${name} admission`, () => {
    const mutant = mutate(source);
    assert.notEqual(mutant, source);
    assert.throws(() => {
      assert.match(mutant, /LEGACY_CANDIDATE_VERSION = "2\.3\.26"/);
      assert.match(mutant, /LEGACY_PUBLISHED_VERSION = "2\.3\.25"/);
      assert.match(mutant, /CURRENT_CANDIDATE_VERSION = "2\.3\.27"/);
      assert.match(mutant, /CURRENT_PUBLISHED_VERSION = "2\.3\.26"/);
      assert.match(mutant, expectedPair);
    });
  });
}
