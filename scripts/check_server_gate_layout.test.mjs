import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Presentation-source contracts only. These do not render a browser, open an
// IME, exercise authentication, or prove native focus/keyboard scrolling.
const source = readFileSync(
  process.env.SERVER_GATE_CSS_PATH ?? new URL("../web/src/components/ServerModeGate.css", import.meta.url),
  "utf8",
);

function block(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `Missing ${selector}`);
  const open = css.indexOf("{", start);
  let depth = 1;
  for (let index = open + 1; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}" && --depth === 0) return css.slice(open + 1, index);
  }
  assert.fail(`Unclosed ${selector}`);
}

test("server gate owns a bounded legacy-compatible vertical scrollport", () => {
  const gate = block(source, ".server-gate");
  for (const declaration of [
    /box-sizing:\s*border-box\s*;/,
    /height:\s*100vh\s*;/,
    /min-height:\s*0\s*;/,
    /overflow-x:\s*hidden\s*;/,
    /overflow-y:\s*auto\s*;/,
  ]) assert.match(gate, declaration);
});

test("server gate centers fitting desktop cards without shrinking oversized cards", () => {
  const gate = block(source, ".server-gate");
  assert.match(gate, /display:\s*flex\s*;/);
  assert.match(gate, /flex-direction:\s*column\s*;/);
  assert.match(gate, /align-items:\s*center\s*;/);
  const card = block(source, ".server-gate-card");
  for (const declaration of [
    /flex:\s*0\s+0\s+auto\s*;/,
    /margin-top:\s*auto\s*;/,
    /margin-bottom:\s*auto\s*;/,
    /min-width:\s*0\s*;/,
    /max-width:\s*100%\s*;/,
  ]) assert.match(card, declaration);
});

test("server gate reserves all safe areas and reduces gutters on narrow or short screens", () => {
  const gate = block(source, ".server-gate");
  for (const side of ["top", "right", "bottom", "left"]) {
    assert.match(gate, new RegExp(`padding-${side}:\\s*max\\(var\\(--server-gate-gutter\\),\\s*var\\(--safe-area-${side}\\)\\)\\s*;`));
  }
  for (const side of ["top", "bottom"]) {
    assert.match(gate, new RegExp(`scroll-padding-${side}:\\s*max\\(var\\(--server-gate-gutter\\),\\s*var\\(--safe-area-${side}\\)\\)\\s*;`));
  }
  const compact = block(source, "@media (max-width: 600px), (max-height: 500px)");
  assert.match(block(compact, ".server-gate"), /--server-gate-gutter:\s*max\(16px,\s*calc\(16px\s*\*\s*var\(--density-scale\)\)\)\s*;/);
});

test("server gate keeps narrow fields, messages and 44px controls unconstrained", () => {
  const input = block(source, ".server-gate-field input");
  assert.match(input, /min-width:\s*0\s*;/);
  assert.match(input, /width:\s*100%\s*;/);
  assert.match(input, /min-height:\s*44px\s*;/);
  const button = block(source, ".server-gate-button");
  assert.match(button, /min-height:\s*44px\s*;/);
  assert.match(button, /min-width:\s*44px\s*;/);
  assert.match(block(source, ".server-gate-card"), /overflow-wrap:\s*anywhere\s*;/);
});

test("server gate gates dynamic height without invalidating the legacy viewport fallback", () => {
  const dynamic = block(source, "@supports (height: 100dvh)");
  assert.match(block(dynamic, ".server-gate"), /height:\s*100dvh\s*;/);
  assert.doesNotMatch(block(source, ".server-gate"), /\d+dvh/);
  assert.doesNotMatch(source, /calc\([^;{}]*dvh[^;{}]*var\(/);
});
