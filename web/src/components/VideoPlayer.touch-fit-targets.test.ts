// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";

const css = readFileSync("src/components/VideoPlayer.css", "utf8");

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

it("gives touch settings fit buttons 44px minimum width and height without relying on coarse-pointer media", () => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  // jsdom does not enable the coarse-pointer media query. Exercise the real
  // stylesheet and existing hierarchy without claiming rendered geometry.
  document.body.innerHTML = `
    <div class="player is-touch-player">
      <div class="player-options-menu is-touch-settings">
        <div class="player-options-section player-fit-options-section">
          <div class="player-options-choice-row">
            <button class="chip">Fit</button>
            <button class="chip">Fill screen</button>
            <button class="chip">Stretch</button>
          </div>
        </div>
        <div class="player-options-section"><button class="chip">Other choice</button></div>
      </div>
    </div>`;
  const player = document.querySelector(".player")!;
  const menu = player.querySelector(".player-options-menu")!;
  const fitButtons = menu.querySelectorAll(".player-fit-options-section button");
  expect(fitButtons).toHaveLength(3);
  for (const button of fitButtons) {
    expect(getComputedStyle(button).minWidth).toBe("44px");
    expect(getComputedStyle(button).minHeight).toBe("44px");
  }
  const other = menu.querySelector(".player-options-section:not(.player-fit-options-section) button")!;
  expect(getComputedStyle(other).minWidth).not.toBe("44px");
  expect(getComputedStyle(other).minHeight).not.toBe("44px");

  menu.classList.replace("is-touch-settings", "is-touch-audio-sheet");
  for (const button of fitButtons) {
    expect(getComputedStyle(button).minWidth).not.toBe("44px");
    expect(getComputedStyle(button).minHeight).not.toBe("44px");
  }
  menu.classList.replace("is-touch-audio-sheet", "is-touch-settings");
  player.classList.remove("is-touch-player");
  for (const button of fitButtons) {
    expect(getComputedStyle(button).minWidth).not.toBe("44px");
    expect(getComputedStyle(button).minHeight).not.toBe("44px");
  }
});
