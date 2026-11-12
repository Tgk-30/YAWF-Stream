import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("modal surface legibility", () => {
  it.each([
    ["CommandPalette", "cmdk-panel"],
    ["FirstRunWizard", "first-run-card"],
  ])("backs the %s tint with an opaque theme surface", (component, selector) => {
    const css = readFileSync(new URL(`./${component}.css`, import.meta.url), "utf8");
    const panelRule = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`, "s"))?.[1] ?? "";
    const backgrounds = [...panelRule.matchAll(/^\s*background:\s*([^;]+);/gm)]
      .map(([, value]) => value.replace(/\s+/g, " ").trim());

    expect(backgrounds).toEqual([
      "linear-gradient(var(--glass-tint-hero), var(--glass-tint-hero)), var(--bg-2, rgb(12, 13, 18))",
    ]);
  });
});
