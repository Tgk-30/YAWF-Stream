import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  process.env.STREAM_PICKER_CSS_PATH ?? new URL("../web/src/components/StreamPicker.css", import.meta.url),
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

test("mobile cache warning reserves readable text width and a separate touch action row", () => {
  const mobile = block(source, "@media (max-width: 620px)");
  const warning = block(mobile, ".streams-cache-warning");
  assert.match(warning, /display:\s*grid\s*;/);
  assert.match(warning, /grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s*;/);
  assert.match(warning, /align-items:\s*start\s*;/);
  assert.match(block(mobile, ".streams-cache-warning > span"), /min-width:\s*0\s*;/);
  const action = block(mobile, ".streams-cache-warning .btn");
  for (const declaration of [
    /grid-column:\s*2\s*;/,
    /grid-row:\s*2\s*;/,
    /justify-self:\s*start\s*;/,
    /min-height:\s*44px\s*;/,
    /max-width:\s*100%\s*;/,
    /margin-left:\s*0\s*;/,
    /white-space:\s*normal\s*;/,
  ]) assert.match(action, declaration);
  // The desktop row keeps its original inline action and flexible notice.
  assert.match(block(source, ".streams-cache-warning"), /display:\s*flex\s*;/);
  assert.match(block(source, ".streams-cache-warning > span"), /flex:\s*1\s*;/);
  assert.match(block(source, ".streams-cache-warning .btn"), /flex:\s*0\s+0\s+auto\s*;/);
});
