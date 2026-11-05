import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../web/src/screens/LibraryScreens.css", import.meta.url), "utf8");
function compactInputContract(source) {
  const mobile = source.match(/@media \(max-width: 699px\), \(max-width: 950px\) and \(max-height: 500px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const input = mobile.match(/\.lib-folder-new > \.lib-folder-input \{([^}]*)\}/)?.[1] ?? "";
  return /flex: 1 1 0;/.test(input) && /\n    width: 0;/.test(input) && /min-width: 44px;/.test(input);
}

test("mobile folder input uses remaining width above a 44px target floor", () => {
  assert.ok(compactInputContract(css));
});

test("restoring the pre-shrink 140px basis or losing the mobile target floor is rejected", () => {
  const mutants = [
    css.replace("    flex: 1 1 0;", "    flex: 1 1 140px;"),
    css.replace("    min-width: 44px;", ""),
    css.replace("    min-width: 44px;", "    min-width: 32px;"),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, css);
    assert.equal(compactInputContract(mutant), false);
  }
});

test("paired actions stay bounded and wrap without shrinking target heights", () => {
  const actions = css.match(/\.lib-folder-actions \{([^}]*)\}/)?.[1] ?? "";
  assert.match(actions, /display: inline-flex;/);
  assert.match(actions, /flex-wrap: wrap;/);
  assert.match(actions, /max-width: 100%;/);
  assert.match(css, /\.lib-folder-input \{[^}]*min-height: 44px;/);
});
