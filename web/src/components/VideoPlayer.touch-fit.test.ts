// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";

const css = readFileSync("src/components/VideoPlayer.css", "utf8");

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

it("keeps existing fit choices visible in touch Playback settings without exposing them in the Audio sheet", () => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  // Exercise the real stylesheet and the existing section/choice hierarchy.
  // This checks CSS visibility, not viewport geometry or native hit targets.
  document.body.innerHTML = `
    <div class="player is-touch-player">
      <div class="player-options-menu is-touch-settings" role="dialog">
        <div class="player-options-head"><button>Close</button></div>
        <div class="player-options-section player-audio-options-section">Audio</div>
        <div class="player-options-section player-fit-options-section">
          <span>Video fit</span>
          <div class="player-options-choice-row">
            <button class="chip" aria-pressed="true">Fit</button>
            <button class="chip" aria-pressed="false">Fill screen</button>
            <button class="chip" aria-pressed="false">Stretch</button>
          </div>
        </div>
      </div>
    </div>`;
  const menu = document.querySelector<HTMLElement>(".player-options-menu")!;
  const fit = menu.querySelector<HTMLElement>(".player-fit-options-section")!;
  const audio = menu.querySelector<HTMLElement>(".player-audio-options-section")!;
  expect(fit).toBeVisible();
  for (const button of fit.querySelectorAll("button")) expect(button).toBeVisible();
  expect(audio).not.toBeVisible();
  expect(getComputedStyle(menu).overflowY).toBe("auto");
  expect(getComputedStyle(menu.querySelector(".player-options-head")!).position).toBe("sticky");
  // Preserve existing wrapping choices and the coarse-pointer 44px contract.
  expect(getComputedStyle(fit.querySelector(".player-options-choice-row")!).flexWrap).toBe("wrap");
  expect(css).toMatch(/@media \(pointer: coarse\)\s*\{[\s\S]*?\.player-options-choice-row \.chip,[^{]+\{\s*min-height:\s*44px;/);
  expect(css).toMatch(/\.player\.is-touch-player \.player-options-menu\.is-touch-settings \.player-options-sliders\s*\{\s*padding-inline-end:\s*44px;/);

  menu.classList.replace("is-touch-settings", "is-touch-audio-sheet");
  expect(fit).not.toBeVisible();
  expect(audio).toBeVisible();
  menu.classList.remove("is-touch-audio-sheet");
  document.querySelector(".player")!.classList.remove("is-touch-player");
  expect(fit).toBeVisible();
});
