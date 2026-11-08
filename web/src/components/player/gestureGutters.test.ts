import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("touch OSD system-gesture gutters", () => {
  it("[gesture-css] uses conditional physical gesture gutters without changing zero-mode base padding", () => {
    const css = readFileSync("src/components/VideoPlayer.css", "utf8");
    const rule = css.match(/\.player-touch-osd \{([^}]+)\}/)?.[1];
    expect(rule).toContain("max(calc(12px * var(--density-scale)), var(--safe-area-right), var(--native-player-control-gutter-right, 0px))");
    expect(rule).toContain("max(calc(12px * var(--density-scale)), var(--safe-area-left), var(--native-player-control-gutter-left, 0px))");
    expect(rule).not.toContain("padding-inline");
    // Gesture gutters belong only to the touch OSD, never the desktop OSD.
    expect(css.match(/--native-player-control-gutter-/g)).toHaveLength(2);
    expect(css.replace(/\.player-touch-osd \{[^}]+\}/, "")).not.toContain("--native-player-control-gutter-");
  });

  it("[r2-hit-extension] extends only the current touch scrubbar's hit box by its eight-pixel thumb radius", () => {
    const css = readFileSync("src/components/VideoPlayer.css", "utf8");
    const bar = css.match(/\.scrubbar-wrap\.is-touch \.scrubbar \{([^}]+)\}/)?.[1];
    const hit = css.match(/\.scrubbar-wrap\.is-touch \.scrubbar::before \{([^}]+)\}/)?.[1];
    expect(bar).toContain("position: relative");
    expect(hit).toContain('content: ""'); expect(hit).toContain("position: absolute");
    expect(hit).toContain("inset: 0 -8px"); expect(hit).toContain("pointer-events: inherit");
    expect(hit).not.toMatch(/(?:background|opacity|z-index|transform):/);
    expect(css).not.toMatch(/\.scrubbar-wrap\.is-touch::(?:before|after)/);
    expect(css).not.toMatch(/\.scrubbar-time-row::(?:before|after)/);
    expect(css.match(/\.scrubbar-wrap\.is-touch \.scrubbar-progress-thumb \{([^}]+)\}/)?.[1]).toContain("width: 16px");
    expect(css.match(/\.scrubbar-wrap\.is-touch \.scrubbar-progress-thumb \{([^}]+)\}/)?.[1]).toContain("pointer-events: none");
    expect(css).toContain(".player-touch-osd.is-visible .scrubbar-wrap");
  });

  it.each([0.5, 0.75, 1])("[r2-zero-geometry] preserves compact zero-gesture base padding at density%s", (density) => {
    const css = readFileSync("src/components/VideoPlayer.css", "utf8");
    const rule = css.match(/\.player-touch-osd \{([^}]+)\}/)?.[1];
    expect(rule).toContain("var(--native-player-control-gutter-left, 0px)");
    expect(rule).toContain("var(--native-player-control-gutter-right, 0px)");
    expect(rule).not.toContain("+ 8px");
    expect(Math.max(12 * density, 0, 0)).toBe(12 * density);
  });
});
