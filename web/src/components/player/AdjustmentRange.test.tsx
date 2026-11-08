// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AdjustmentRange } from "./AdjustmentRange";

afterEach(cleanup);

function setup() {
  const changed = vi.fn();
  function Controlled() {
    const [value, setValue] = useState(0);
    return <AdjustmentRange aria-label="Pan horizontally" min={-50} max={50} step={1} value={value}
      onValueChange={(next) => { changed(next); setValue(next); }} />;
  }
  const view = render(<Controlled />);
  return { ...view, slider: screen.getByRole("slider", { name: "Pan horizontally" }) as HTMLInputElement, changed };
}

function pointer(slider: HTMLElement, type: string, pointerType = "touch", x = 100, y = 100, id = 1, primary = true) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, {
    pointerType: { value: pointerType }, pointerId: { value: id }, isPrimary: { value: primary },
  });
  fireEvent(slider, event);
  return event;
}
function nativeInput(slider: HTMLInputElement, value: number) {
  // Range value changes natively before input, including the initial pointerdown.
  fireEvent.input(slider, { target: { value: String(value) } });
}

describe("AdjustmentRange touch intent", () => {
  it.each(["touch", "pen"])("[vertical] %s buffers the initial native jump and permits vertical scroll/cancel", (type) => {
    const { slider, changed } = setup();
    expect(pointer(slider, "pointerdown", type).defaultPrevented).toBe(false);
    nativeInput(slider, 23);
    expect(changed).not.toHaveBeenCalled(); expect(slider.value).toBe("0");
    expect(pointer(slider, "pointermove", type, 102, 125).defaultPrevented).toBe(false);
    nativeInput(slider, 25);
    pointer(slider, "pointercancel", type, 102, 125);
    expect(changed).not.toHaveBeenCalled(); expect(slider.value).toBe("0");
  });

  it.each(["touch", "pen"])("[horizontal] %s waits for intent then keeps native live drag values", (type) => {
    const { slider, changed } = setup();
    pointer(slider, "pointerdown", type); nativeInput(slider, 23);
    expect(changed).not.toHaveBeenCalled();
    pointer(slider, "pointermove", type, 125, 102); nativeInput(slider, 35);
    expect(changed).toHaveBeenCalledExactlyOnceWith(35); expect(slider.value).toBe("35");
    pointer(slider, "pointerup", type, 125, 102); fireEvent.click(slider);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it.each(["touch", "pen"])("[tap] %s commits a deliberate stationary tap on release", (type) => {
    const { slider, changed } = setup();
    pointer(slider, "pointerdown", type); nativeInput(slider, 23);
    expect(changed).not.toHaveBeenCalled();
    pointer(slider, "pointerup", type); fireEvent.click(slider);
    expect(changed).toHaveBeenCalledExactlyOnceWith(23); expect(slider.value).toBe("23");
  });

  it("[cancel] cancels the pending jump without a surprise commit", () => {
    const { slider, changed } = setup();
    pointer(slider, "pointerdown"); nativeInput(slider, 23); pointer(slider, "pointercancel");
    expect(changed).not.toHaveBeenCalled(); expect(slider.value).toBe("0");
  });

  it("[cancel-live] restores the gesture's original value when an accepted drag is cancelled", () => {
    const { slider, changed } = setup();
    pointer(slider, "pointerdown"); nativeInput(slider, 23);
    pointer(slider, "pointermove", "touch", 125, 100); nativeInput(slider, 35);
    pointer(slider, "pointercancel", "touch", 125, 100);
    expect(changed.mock.calls).toEqual([[35], [0]]); expect(slider.value).toBe("0");
  });

  it("[vertical-release] discards a vertical gesture even if the browser delivers pointerup rather than cancel", () => {
    const { slider, changed } = setup();
    pointer(slider, "pointerdown"); nativeInput(slider, 23);
    pointer(slider, "pointermove", "touch", 102, 125); nativeInput(slider, 25);
    pointer(slider, "pointerup", "touch", 102, 125); fireEvent.click(slider);
    expect(changed).not.toHaveBeenCalled(); expect(slider.value).toBe("0");
  });

  it("[new-gesture] cancelled touch does not veto the next deliberate tap", () => {
    const { slider, changed } = setup();
    pointer(slider, "pointerdown"); nativeInput(slider, 23); pointer(slider, "pointercancel");
    pointer(slider, "pointerdown", "touch", 110, 100, 2); nativeInput(slider, 30);
    pointer(slider, "pointerup", "touch", 110, 100, 2);
    expect(changed).toHaveBeenCalledExactlyOnceWith(30);
  });

  it("[multitouch] an additional contact cancels rather than committing either finger", () => {
    const { slider, changed } = setup();
    pointer(slider, "pointerdown"); nativeInput(slider, 23);
    pointer(slider, "pointerdown", "touch", 140, 100, 2, false); nativeInput(slider, 40);
    pointer(slider, "pointerup", "touch", 140, 100, 2, false);
    pointer(slider, "pointerup");
    expect(changed).not.toHaveBeenCalled(); expect(slider.value).toBe("0");
  });

  it("[nonprimary] ignores a secondary contact whose primary began outside the range", () => {
    const { slider, changed } = setup();
    pointer(slider, "pointerdown", "touch", 140, 100, 2, false); nativeInput(slider, 40);
    pointer(slider, "pointerup", "touch", 140, 100, 2, false);
    expect(changed).not.toHaveBeenCalled(); expect(slider.value).toBe("0");
  });

  it("[primary-up-first] blocks the remaining secondary contact until both are gone", () => {
    const { slider, changed } = setup();
    pointer(slider, "pointerdown"); nativeInput(slider, 23);
    pointer(slider, "pointerdown", "touch", 140, 100, 2, false); nativeInput(slider, 40);
    pointer(slider, "pointerup"); nativeInput(slider, 41);
    pointer(slider, "pointerup", "touch", 140, 100, 2, false);
    expect(changed).not.toHaveBeenCalled(); expect(slider.value).toBe("0");
  });

  it("[unmount] does not publish a pending adjustment on unmount", () => {
    const { slider, changed, unmount } = setup();
    pointer(slider, "pointerdown"); nativeInput(slider, 23); unmount();
    pointer(slider, "pointerup"); expect(changed).not.toHaveBeenCalled();
  });

  it("[mouse] retains immediate native mouse adjustment", () => {
    const { slider, changed } = setup();
    pointer(slider, "pointerdown", "mouse"); nativeInput(slider, 23);
    expect(changed).toHaveBeenCalledExactlyOnceWith(23);
  });

  it("[keyboard] keeps native arrow and no-pointer accessibility input", () => {
    const { slider, changed } = setup();
    fireEvent.keyDown(slider, { key: "ArrowRight" }); nativeInput(slider, 1);
    nativeInput(slider, 20);
    expect(changed.mock.calls).toEqual([[1], [20]]);
  });

  it("[keyboard-after-touch] keyboard input remains usable after an abandoned pending gesture", () => {
    const { slider, changed } = setup();
    pointer(slider, "pointerdown"); nativeInput(slider, 23);
    fireEvent.keyDown(slider, { key: "ArrowRight" }); nativeInput(slider, 1);
    expect(changed).toHaveBeenCalledExactlyOnceWith(1);
  });
});

it("[wiring] retains all four native adjustment ranges and their vertical-pan CSS", () => {
  const source = readFileSync("src/components/VideoPlayer.tsx", "utf8");
  const sheet = source.slice(source.indexOf('<div className="player-options-section player-options-sliders">'), source.indexOf('{hlsLevels.length > 1 && ('));
  expect(sheet.match(/<AdjustmentRange\b/g)).toHaveLength(4);
  expect(sheet).not.toContain('type="range"');
  for (const field of ["zoom", "panX", "panY"]) expect(sheet).toContain(`onValueChange={(value) => onPresentationChange({ ${field}: value })}`);
  expect(sheet).toContain("onValueChange={setSubtitlePosition}");
  const css = readFileSync("src/components/VideoPlayer.css", "utf8");
  expect(css.match(/\.player-options-sliders input\[type="range"\] \{([^}]+)\}/)?.[1]).toContain("touch-action: pan-y");
  expect(css).toContain("padding-inline-end: 44px");
});
