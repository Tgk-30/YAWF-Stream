import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("touch OSD system-gesture gutters", () => {
  it("[gesture-css] reserves the physical gesture strips plus the eight-pixel thumb radius on each side", () => {
    const css = readFileSync("src/components/VideoPlayer.css", "utf8");
    const rule = css.match(/\.player-touch-osd \{([^}]+)\}/)?.[1];
    expect(rule).toContain("max(calc(12px * var(--density-scale)), var(--safe-area-right), calc(var(--native-system-gesture-right, 0px) + 8px))");
    expect(rule).toContain("max(calc(12px * var(--density-scale)), var(--safe-area-left), calc(var(--native-system-gesture-left, 0px) + 8px))");
    expect(rule).not.toContain("padding-inline");
    // Gesture gutters belong only to the touch OSD, never the desktop OSD.
    expect(css.match(/--native-system-gesture-/g)).toHaveLength(2);
    expect(css.replace(/\.player-touch-osd \{[^}]+\}/, "")).not.toContain("--native-system-gesture-");
  });
});
