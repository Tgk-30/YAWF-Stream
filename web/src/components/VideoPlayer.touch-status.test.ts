import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("touch playback status slot CSS", () => {
  const css = readFileSync("src/components/VideoPlayer.css", "utf8");
  const slots = [...css.matchAll(
    /\.webview-player\.is-touch-player \.player-playback-status\s*\{([^}]*)\}/g,
  )].map((match) => match[1]!);

  it("places the touch pill above the unchanged normal transport targets", () => {
    expect(slots[0]).toMatch(/inset:\s*auto\s+max\(12px, var\(--safe-area-right\)\)\s+calc\(50% \+ 52px\)\s+max\(12px, var\(--safe-area-left\)\);/);
    expect(slots[0]).toMatch(/transform:\s*none;/);
    // 52px reserve clears half of the existing maximum 72px Play target.
    expect(52 - 72 / 2).toBe(16);
  });

  it("aligns the short-height slot above the unchanged 45 percent transport", () => {
    const short = css.match(/@media \(max-height: 500px\)\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(short).toMatch(/\.webview-player\.is-touch-player \.player-playback-status\s*\{\s*bottom:\s*calc\(55% \+ 42px\);/);
    expect(slots[1]).toMatch(/bottom:\s*calc\(55% \+ 42px\);/);
    expect(short).toMatch(/\.player-touch-transport\s*\{\s*top:\s*45%;/);
    expect(short).toMatch(/\.player-touch-play\s*\{\s*width:\s*60px;\s*height:\s*60px;/);
    // Complementary 55% bottom tracks the existing 45% center; 42px clears
    // half of the 60px target with 12px remaining. This is not a rendered rect.
    expect(42 - 60 / 2).toBe(12);
  });

  it("bounds the intrinsic touch pill inside both real horizontal safe areas", () => {
    expect(slots[0]).toMatch(/width:\s*max-content;/);
    expect(slots[0]).toMatch(/max-width:\s*calc\(100% - max\(12px, var\(--safe-area-left\)\) - max\(12px, var\(--safe-area-right\)\)\);/);
    expect(slots[0]).toMatch(/box-sizing:\s*border-box;/);
    expect(slots[0]).toMatch(/margin-inline:\s*auto;/);
  });

  it("preserves desktop centering, status hit transparency and transport sizes", () => {
    const base = css.match(/^\.player-playback-status\s*\{([^}]*)\}/m)?.[1];
    expect(base).toMatch(/inset:\s*50% auto auto 50%;/);
    expect(base).toMatch(/z-index:\s*8;/);
    expect(base).toMatch(/pointer-events:\s*none;/);
    expect(base).toMatch(/transform:\s*translate\(-50%, -50%\);/);
    expect(css).toMatch(/\.player-touch-play\s*\{\s*width:\s*clamp\(64px, 9vw, 72px\);\s*height:\s*clamp\(64px, 9vw, 72px\);/);
    for (const slot of slots) {
      expect(slot).not.toMatch(/pointer-events:|z-index:|font-size:|padding:|display:|visibility:/);
    }
  });
});
