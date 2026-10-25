import { readFileSync } from "node:fs";
import postcss, { type AnyNode, type Root, type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./MediaCard.css", import.meta.url), "utf8");
const hoverMedia = "(hover: hover) and (pointer: fine)";

type HoverRequirement = {
  selector: string;
  declarations: Readonly<Record<string, string>>;
};

type HoverContractViolation = {
  kind: "inventory" | "context" | "declaration";
  selector?: string;
  property?: string;
  expected?: string;
  actual?: string;
};

// This is the complete desktop-only interaction inventory. Keep every selector
// once, directly under the exact fine-pointer hover capability query.
const desktopHoverInventory: readonly HoverRequirement[] = [
  {
    selector: ".media-card:hover",
    declarations: { transform: "translateY(-14px) scale(1.08)" },
  },
  {
    selector: ".media-card:hover .media-card-poster",
    declarations: {
      "border-color": "rgba(var(--accent-rgb), 0.55)",
      "box-shadow": "0 24px 54px -12px rgba(0, 0, 0, 0.66), 0 0 0 1px rgba(var(--accent-rgb), 0.45), 0 10px 40px rgba(var(--accent-rgb), 0.32)",
    },
  },
  {
    selector: ".media-card:hover .media-card-rank",
    declarations: { transform: "scale(1.08)" },
  },
  {
    selector: ".media-card:hover .media-card-reveal",
    declarations: { "pointer-events": "auto", opacity: "1" },
  },
  {
    selector: ".media-card:hover .media-card-reveal-inner",
    declarations: { opacity: "1", transform: "translateY(0)" },
  },
  {
    selector: ".media-card-play:hover",
    declarations: {
      transform: "scale(1.08)",
      background: "rgba(var(--accent-rgb), 1)",
      color: "#fff",
      "box-shadow": "0 6px 20px rgba(var(--accent-rgb), 0.55)",
    },
  },
  {
    selector: ".media-card-more:hover",
    declarations: {
      transform: "scale(1.08)",
      background: "rgba(255, 255, 255, 0.26)",
    },
  },
  {
    selector: ".media-card:hover .media-card-title",
    declarations: { color: "var(--text-primary)" },
  },
];

function parse(source = css): Root {
  return postcss.parse(source, { from: "MediaCard.css" });
}

function mediaParameters(rule: Rule): string[] {
  const parameters: string[] = [];
  let parent: AnyNode | undefined = rule.parent;
  while (parent != null) {
    if (parent.type === "atrule" && parent.name === "media") {
      parameters.push(parent.params.replace(/\s+/g, " ").trim());
    }
    parent = parent.parent;
  }
  return parameters;
}

function matchingRules(root: Root, selector: string): Rule[] {
  const rules: Rule[] = [];
  root.walkRules((rule) => {
    if (rule.selector === selector) rules.push(rule);
  });
  return rules;
}

function declarationValue(rule: Rule, property: string): string | undefined {
  let value: string | undefined;
  rule.walkDecls(property, (declaration) => {
    value = declaration.value.replace(/\s+/g, " ").trim();
  });
  return value;
}

function hoverRules(root: Root): Rule[] {
  const rules: Rule[] = [];
  root.walkRules((rule) => {
    if (rule.selector.includes(":hover")) rules.push(rule);
  });
  return rules;
}

function hoverContractViolations(source: string): HoverContractViolation[] {
  const root = parse(source);
  const expectedSelectors = desktopHoverInventory.map(({ selector }) => selector);
  const actualSelectors = hoverRules(root).map((rule) => rule.selector);
  const violations: HoverContractViolation[] = [];

  if (JSON.stringify(actualSelectors) !== JSON.stringify(expectedSelectors)) {
    violations.push({
      kind: "inventory",
      expected: expectedSelectors.join(" | "),
      actual: actualSelectors.join(" | "),
    });
  }

  for (const requirement of desktopHoverInventory) {
    const matches = matchingRules(root, requirement.selector);
    if (matches.length !== 1) {
      violations.push({
        kind: "inventory",
        selector: requirement.selector,
        expected: "exactly once",
        actual: `${matches.length} matches`,
      });
      continue;
    }

    const rule = matches[0];
    if (JSON.stringify(mediaParameters(rule)) !== JSON.stringify([hoverMedia])) {
      violations.push({
        kind: "context",
        selector: requirement.selector,
        expected: hoverMedia,
        actual: mediaParameters(rule).join(" > ") || "ungated",
      });
    }

    for (const [property, expected] of Object.entries(requirement.declarations)) {
      const actual = declarationValue(rule, property);
      if (actual !== expected) {
        violations.push({
          kind: "declaration",
          selector: requirement.selector,
          property,
          expected,
          actual: actual ?? "missing",
        });
      }
    }
  }

  return violations;
}

function ungateDesktopHoverRules(source: string): string {
  const root = parse(source);
  root.walkAtRules("media", (media) => {
    if (media.params.replace(/\s+/g, " ").trim() !== hoverMedia) return;
    media.replaceWith(...(media.nodes ?? []).map((node) => node.clone()));
  });
  return root.toString();
}

function removeAllDesktopHoverRules(source: string): string {
  const root = parse(source);
  hoverRules(root).forEach((rule) => rule.remove());
  return root.toString();
}

function removeRequiredDeclaration(
  source: string,
  selector: string,
  property: string,
): string {
  const root = parse(source);
  const rule = matchingRules(root, selector).find(
    (candidate) => JSON.stringify(mediaParameters(candidate)) === JSON.stringify([hoverMedia]),
  );
  if (rule == null) throw new Error(`Missing mutation target: ${selector}`);

  let removed = false;
  rule.walkDecls(property, (declaration) => {
    declaration.remove();
    removed = true;
  });
  if (!removed) throw new Error(`Missing mutation declaration: ${selector} ${property}`);

  return root.toString();
}

function hasViolation(
  violations: readonly HoverContractViolation[],
  expected: Partial<HoverContractViolation>,
): boolean {
  return violations.some((violation) =>
    Object.entries(expected).every(
      ([key, value]) => violation[key as keyof HoverContractViolation] === value,
    ),
  );
}

describe("MediaCard hover capability contract", () => {
  it("keeps the original ungated predecessor RED", () => {
    const predecessorViolations = hoverContractViolations(ungateDesktopHoverRules(css));

    expect(predecessorViolations).not.toEqual([]);
    expect(
      desktopHoverInventory.every((requirement) =>
        hasViolation(predecessorViolations, {
          kind: "context",
          selector: requirement.selector,
          actual: "ungated",
        }),
      ),
    ).toBe(true);
  });

  it("keeps the CSS candidate GREEN with the exact desktop hover inventory", () => {
    expect(hoverContractViolations(css)).toEqual([]);
  });

  it("keeps the keyboard focus ring and reveal outside hover-only media", () => {
    const root = parse();
    const focusRing = matchingRules(root, ".media-card:focus-visible .media-card-poster");
    const focusReveal = matchingRules(root, ".media-card:focus-visible .media-card-reveal");
    const focusRevealInner = matchingRules(root, ".media-card:focus-visible .media-card-reveal-inner");

    expect(focusRing).toHaveLength(1);
    expect(mediaParameters(focusRing[0])).toEqual([]);
    expect(declarationValue(focusRing[0], "outline")).toBe(
      "2px solid var(--focus-ring-color)",
    );
    expect(declarationValue(focusRing[0], "outline-offset")).toBe("3px");
    expect(focusReveal).toHaveLength(1);
    expect(mediaParameters(focusReveal[0])).toEqual([]);
    expect(declarationValue(focusReveal[0], "pointer-events")).toBe("auto");
    expect(declarationValue(focusReveal[0], "opacity")).toBe("1");
    expect(focusRevealInner).toHaveLength(1);
    expect(mediaParameters(focusRevealInner[0])).toEqual([]);
    expect(declarationValue(focusRevealInner[0], "transform")).toBe("translateY(0)");
  });

  it("keeps all hover selectors out of ungated and coarse-pointer rules", () => {
    const ungatedSelectors = hoverRules(parse())
      .filter((rule) => JSON.stringify(mediaParameters(rule)) !== JSON.stringify([hoverMedia]))
      .map((rule) => rule.selector);
    const coarseExpansions: string[] = [];

    parse().walkAtRules("media", (media) => {
      if (!/(pointer:\s*coarse|hover:\s*none)/.test(media.params)) return;
      media.walkRules((rule) => {
        if (!rule.selector.includes(".media-card-reveal")) return;
        const expandsReveal = ["opacity", "pointer-events", "transform"].some(
          (property) => declarationValue(rule, property) != null,
        );
        if (expandsReveal) coarseExpansions.push(rule.selector);
      });
    });

    expect(ungatedSelectors).toEqual([]);
    expect(coarseExpansions).toEqual([]);
  });

  it("rejects delete-all and every essential-declaration mutation with structured counterexamples", () => {
    const counterexamples: Array<Record<string, unknown>> = [];
    const deletedHoverViolations = hoverContractViolations(removeAllDesktopHoverRules(css));

    expect(deletedHoverViolations).not.toEqual([]);
    expect(
      hasViolation(deletedHoverViolations, {
        kind: "inventory",
        expected: desktopHoverInventory.map(({ selector }) => selector).join(" | "),
        actual: "",
      }),
    ).toBe(true);
    counterexamples.push({
      mutation: "delete-all-desktop-hover-rules",
      violations: deletedHoverViolations,
    });

    for (const requirement of desktopHoverInventory) {
      for (const [property, expected] of Object.entries(requirement.declarations)) {
        const violations = hoverContractViolations(
          removeRequiredDeclaration(css, requirement.selector, property),
        );

        expect(violations).not.toEqual([]);
        expect(
          hasViolation(violations, {
            kind: "declaration",
            selector: requirement.selector,
            property,
            expected,
            actual: "missing",
          }),
        ).toBe(true);
        counterexamples.push({
          mutation: "remove-essential-hover-declaration",
          selector: requirement.selector,
          property,
          violations,
        });
      }
    }

    // This test output is the review log for player55: the assertions above
    // execute every counterexample instead of merely reporting a source diff.
    console.info(JSON.stringify({ suite: "player55", counterexamples }));
  });
});
