import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(new URL("../website-app/package.json", import.meta.url));
const postcss = require("postcss");
const tailwindcss = require("tailwindcss");
const source = readFileSync(
  process.env.DS_STREAM_PICKER_SOURCE ??
    new URL("../website-app/src/pages/download/StreamPicker.tsx", import.meta.url),
  "utf8",
);
const sectionClasses = source.match(/<section className="([^"]+)"/)[1].split(/\s+/);

test("picker clips both axes without a focus-scroll container where supported", () => {
  assert.ok(sectionClasses.includes("overflow-hidden"), "retain legacy paint clipping");
  assert.ok(sectionClasses.includes("supports-[overflow:clip]:overflow-clip"));
  assert.ok(!sectionClasses.some((name) => /overflow-[xy]-/.test(name)));
});

test("Tailwind emits a supported two-axis clip override after the hidden fallback", async () => {
  const result = await postcss([
    tailwindcss({ content: [{ raw: source, extension: "tsx" }], corePlugins: { preflight: false } }),
  ]).process("@tailwind utilities;", { from: undefined });
  let hidden;
  let clip;
  result.root.walkDecls("overflow", (declaration) => {
    if (declaration.parent.selector === ".overflow-hidden") hidden = declaration;
    if (declaration.value === "clip" && declaration.parent.parent.name === "supports") {
      assert.match(declaration.parent.parent.params, /^\(overflow:\s*clip\)$/);
      clip = declaration;
    }
  });
  assert.ok(hidden, "legacy clipping utility must be emitted");
  assert.ok(clip, "the enhancement must use overflow shorthand, not one axis");
  assert.ok(result.css.indexOf(hidden.parent.toString()) < result.css.indexOf(clip.parent.toString()));
});

test("picker keeps its entrance, page padding and ordinary keyboard navigation", () => {
  assert.ok(sectionClasses.includes("py-[clamp(88px,12vw,152px)]"));
  assert.match(source, /initial=\{reduced \? \{ opacity: 0 \} : \{ opacity: 0, x: 80 \}\}/);
  assert.match(source, /whileInView=\{\{ opacity: 1, x: 0 \}\}/);
  assert.doesNotMatch(source, /onFocus=|onKeyDown=|tabIndex=|scrollLeft|scrollTo\(/);
});
