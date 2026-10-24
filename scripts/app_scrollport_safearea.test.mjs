import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../web/src/${path}`, import.meta.url), "utf8");
const app = read("App.css");
const search = read("components/GlobalSearch.css");
const profile = read("components/ProfileMenu.css");
const library = read("screens/LibraryScreens.css");
const consumed = "--app-content-safe-top-consumed";
const tablet = { width: 1180, height: 820, standalone: true, coarse: true };

// This is a source arithmetic/cascade contract, not a browser geometry oracle.
// Only the exact selectors and media features used by these four layouts apply.
function blocks(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const result = [];
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf("{", cursor);
    if (open < 0) break;
    let end = open + 1;
    let depth = 1;
    while (end < css.length && depth) {
      if (css[end] === "{") depth += 1;
      if (css[end] === "}") depth -= 1;
      end += 1;
    }
    assert.equal(depth, 0, "balanced source CSS");
    result.push({ header: css.slice(cursor, open).trim(), body: css.slice(open + 1, end - 1) });
    cursor = end;
  }
  return result;
}

function matches(query, viewport) {
  return query.split(",").some((alternative) => alternative.split(/\s+and\s+/).every((feature) => {
    const match = /^\(([^:]+):\s*([^\)]+)\)$/.exec(feature.trim());
    if (!match) return false;
    const [, name, value] = match;
    if (name === "display-mode") return value === (viewport.standalone ? "standalone" : "browser");
    if (name === "pointer") return value === (viewport.coarse ? "coarse" : "fine");
    const dimension = /^(min|max)-(width|height)$/.exec(name);
    if (!dimension) return false;
    const actual = viewport[dimension[2]];
    return dimension[1] === "min" ? actual >= parseFloat(value) : actual <= parseFloat(value);
  }));
}

function declarations(css, selector, viewport = tablet) {
  const result = {};
  for (const { header, body } of blocks(css)) {
    if (header.startsWith("@media ")) {
      if (matches(header.slice(7), viewport)) Object.assign(result, declarations(body, selector, viewport));
    } else if (header === "@supports (height: 100dvh)") {
      if (viewport.dynamicViewport !== false) Object.assign(result, declarations(body, selector, viewport));
    } else if (header === selector) {
      for (const entry of body.split(";")) {
        const colon = entry.indexOf(":");
        if (colon >= 0) result[entry.slice(0, colon).trim()] = entry.slice(colon + 1).trim();
      }
    }
  }
  return result;
}

function splitAtDepthZero(value, pattern) {
  let depth = 0;
  const parts = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    if (value[index] === ")") depth -= 1;
    if (!depth && pattern.test(value[index])) {
      parts.push(value.slice(start, index), value[index]);
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function pixels(value, vars, viewport = tablet) {
  value = String(value).trim();
  const variable = /^var\((--[\w-]+)(?:,\s*(.+))?\)$/.exec(value);
  if (variable) {
    const replacement = vars[variable[1]] ?? variable[2];
    assert.notEqual(replacement, undefined, `known ${variable[1]}`);
    return pixels(replacement, vars, viewport);
  }
  if (value.startsWith("calc(")) return pixels(value.slice(5, -1), vars, viewport);
  const extrema = /^(max|min)\((.*)\)$/.exec(value);
  if (extrema && splitAtDepthZero(value, /[+*-]/).length === 1) {
    const values = splitAtDepthZero(extrema[2], /,/).filter((part) => part !== ",");
    return Math[extrema[1]](...values.map((part) => pixels(part, vars, viewport)));
  }
  const sum = splitAtDepthZero(value, /[+-]/);
  if (sum.length > 1) {
    let result = pixels(sum[0], vars, viewport);
    for (let index = 1; index < sum.length; index += 2) {
      result += (sum[index] === "+" ? 1 : -1) * pixels(sum[index + 1], vars, viewport);
    }
    return result;
  }
  const product = splitAtDepthZero(value, /\*/);
  if (product.length > 1) return product.filter((part) => part !== "*").reduce((result, part) => result * pixels(part, vars, viewport), 1);
  assert.match(value, /^-?\d+(?:\.\d+)?(?:px|rem|d?vh)?$/, `supported CSS length: ${value}`);
  return /d?vh$/.test(value) ? parseFloat(value) / 100 * viewport.height : parseFloat(value) * (value.endsWith("rem") ? 16 : 1);
}

function variables(safeTop, compact = false) {
  return { "--safe-area-top": `${safeTop}px`, "--sp-md": compact ? "10px" : "12px", "--sp-sm": compact ? "6px" : "8px", "--density-scale": compact ? "0.84" : "1" };
}

test("standalone coarse non-phone scrollport starts below safe top and ends at the viewport", () => {
  for (const viewport of [tablet, { ...tablet, width: 820, height: 1180 }, { ...tablet, width: 700, height: 501 }, { ...tablet, width: 951, height: 480 }, { ...tablet, dynamicViewport: false }]) {
    const rule = declarations(app, ".app-content", viewport);
    for (const safeTop of [32, 8, 0]) {
      const vars = { ...variables(safeTop), ...rule };
      const top = pixels(rule["margin-top"] ?? "0px", vars, viewport);
      assert.equal(top, safeTop, `scrollport top ${viewport.width}x${viewport.height}, inset ${safeTop}`);
      assert.equal(pixels(rule.height, vars, viewport), viewport.height - safeTop, "height consumes inset exactly once");
      assert.equal(top + pixels(rule.height, vars, viewport), viewport.height, "bottom stays in viewport");
    }
  }
});

for (const [label, css, selector] of [["search", search, ".global-search"], ["profile", profile, ".profile-menu"]]) {
  test(`${label} subtracts consumed inset after the full max without changing initial viewport position`, () => {
    const rule = declarations(css, selector);
    for (const compact of [false, true]) for (const safeTop of [8, 32, 0]) {
      const vars = variables(safeTop, compact);
      const original = Math.max(parseFloat(vars["--sp-md"]), safeTop);
      assert.equal(pixels(rule.top, { ...vars, [consumed]: "0px" }), original, "unconsumed position is unchanged");
      assert.equal(safeTop + pixels(rule.top, { ...vars, [consumed]: `${safeTop}px` }), original, `consumed position, safeTop ${safeTop}, compact ${compact}`);
    }
  });
}

test("library subtracts consumed inset without changing the floating-row bound or initial header", () => {
  const rule = declarations(library, ".lib-screen");
  assert.equal(rule["--lib-floating-row-height"], "calc(44px + var(--sp-sm) + var(--sp-sm) + 2px)");
  for (const compact of [false, true]) for (const safeTop of [8, 32, 0]) {
    const vars = { ...variables(safeTop, compact), ...rule };
    const expected = Math.max(parseFloat(vars["--sp-md"]), safeTop) + pixels(rule["--lib-floating-row-height"], vars) + parseFloat(vars["--sp-md"]);
    assert.equal(pixels(rule["padding-top"], { ...vars, [consumed]: "0px" }), expected, "unconsumed header");
    assert.equal(safeTop + pixels(rule["padding-top"], { ...vars, [consumed]: `${safeTop}px` }), expected, `consumed header, safeTop ${safeTop}, compact ${compact}`);
  }
});

test("browser fine pointer phone and short landscape retain their existing scrollport", () => {
  for (const viewport of [{ ...tablet, standalone: false }, { ...tablet, coarse: false }, { ...tablet, width: 412, height: 915 }, { ...tablet, width: 699 }, { ...tablet, width: 700, height: 500 }, { ...tablet, width: 950, height: 500 }]) {
    const rule = declarations(app, ".app-content", viewport);
    const vars = { ...variables(32), ...rule };
    assert.equal(pixels(rule["margin-top"] ?? "0px", vars, viewport), 0, JSON.stringify(viewport));
    assert.equal(pixels(rule.height, vars, viewport), viewport.height);
    assert.equal(pixels(rule[consumed] ?? "0px", vars, viewport), 0);
    if (viewport.width <= 699 || (viewport.width <= 950 && viewport.height <= 500)) {
      assert.equal(rule["padding-top"], "var(--safe-area-top)");
      assert.equal(rule["padding-bottom"], "var(--mobile-nav-reserve)");
      assert.equal(rule["scroll-padding-bottom"], "var(--mobile-nav-reserve)");
      assert.equal(declarations(search, ".global-search", viewport).position, "sticky");
    }
  }
});

test("safe-top consumption preserves fixed descendants global inset and existing bottom reserves", () => {
  for (const selector of [".app", ".app-content"]) {
    const rule = declarations(app, selector);
    for (const property of ["transform", "filter", "backdrop-filter", "-webkit-backdrop-filter", "perspective", "contain", "will-change", "clip-path"]) {
      assert.equal(rule[property], undefined, `${selector} must not change fixed containing blocks or clip overlays: ${property}`);
    }
    assert.equal(rule["--safe-area-top"], undefined, "fixed overlays still receive the global inset");
  }
  const standalone = blocks(app).find(({ header }) => header.includes("display-mode: standalone"));
  if (standalone) {
    assert.doesNotMatch(standalone.body, /(?:padding|scroll-padding)-(?:top|bottom)\s*:/, "do not duplicate phone/nav reserves");
    assert.match(standalone.body, /height:\s*calc\(100vh - var\(--app-content-safe-top-consumed\)\)/, "legacy viewport height");
    assert.match(standalone.body, /@supports \(height: 100dvh\)\s*\{\s*\.app-content\s*\{\s*height:\s*calc\(100dvh - var\(--app-content-safe-top-consumed\)\)/, "unsupported dynamic units cannot invalidate the var() fallback");
  }
});
