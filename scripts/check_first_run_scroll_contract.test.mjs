import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../web/src/components/FirstRunWizard.css", import.meta.url), "utf8");
const block = (source, selector) => source.slice(source.indexOf(`${selector} {`)).split("}", 1)[0];
function boundedScrollContract(source) {
  const overlay = block(source, ".first-run");
  const card = block(source, ".first-run-card");
  return /grid-template-rows: minmax\(0, 1fr\);/.test(overlay)
    && /overflow-y: hidden;/.test(overlay)
    && /min-height: 0;/.test(card)
    && /max-height: 100%;/.test(card)
    && /overflow-y: auto;/.test(card)
    && /overscroll-behavior: contain;/.test(card);
}

test("first-run has one bounded card scrollport inside the existing safe-area padding", () => {
  assert.ok(boundedScrollContract(css));
  const overlay = block(css, ".first-run");
  for (const side of ["top", "right", "bottom", "left"]) {
    assert.ok(overlay.includes(`var(--safe-area-${side})`));
  }
  assert.doesNotMatch(css, /--(?:bottom-nav|app-nav).*reserve|162px/);
});

test("losing the definite track, card bound or sole scroll owner is rejected", () => {
  for (const mutant of [
    css.replace("grid-template-rows: minmax(0, 1fr);", ""),
    css.replace("max-height: 100%;", "max-height: none;"),
    css.replace("overflow-y: hidden;", "overflow-y: auto;"),
  ]) {
    assert.notEqual(mutant, css);
    assert.equal(boundedScrollContract(mutant), false);
  }
});

test("all first-run primary and secondary actions retain 44px targets", () => {
  const actions = block(css, ".first-run-primary,\n.first-run-secondary");
  assert.match(actions, /min-width: 44px;/);
  assert.match(actions, /min-height: 44px;/);
});
