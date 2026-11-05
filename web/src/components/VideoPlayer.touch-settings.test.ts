import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("touch playback settings CSS", () => {
  const css = readFileSync("src/components/VideoPlayer.css", "utf8");

  it("reserves a 44px scroll lane outside the implicit range labels", () => {
    const lane = css.match(
      /\.player\.is-touch-player \.player-options-menu\.is-touch-settings \.player-options-sliders\s*\{([^}]*)\}/s,
    )?.[1];

    expect(lane).toMatch(/padding-inline-end:\s*44px;/);
    expect(lane).not.toMatch(/touch-action:/);
  });

  it("forces a 44px touch target on the specifically typed settings ranges", () => {
    const range = css.match(
      /\.player\.is-touch-player \.player-options-menu\.is-touch-settings \.player-options-sliders input\[type="range"\]\s*\{([^}]*)\}/s,
    )?.[1];

    expect(range).toMatch(/min-height:\s*44px;/);
  });

  it("removes native inline range margins from the protected scroll lane", () => {
    const range = css.match(
      /\.player\.is-touch-player \.player-options-menu\.is-touch-settings \.player-options-sliders input\[type="range"\]\s*\{([^}]*)\}/s,
    )?.[1];

    expect(range).toMatch(/margin-inline:\s*0;/);
  });
});
