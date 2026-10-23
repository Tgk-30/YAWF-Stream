// @vitest-environment jsdom
//
// A11y regression: the role="slider" scrub bar must support keyboard seeking.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ScrubBar, formatTime } from "./ScrubBar";

function setup(currentTime = 100, duration = 600) {
  const onSeek = vi.fn();
  render(
    <ScrubBar
      currentTime={currentTime}
      duration={duration}
      preview={null}
      onHover={() => {}}
      onLeave={() => {}}
      onSeek={onSeek}
    />,
  );
  return { slider: screen.getByRole("slider", { name: "Seek" }), onSeek };
}

function key(el: Element, k: string) {
  el.dispatchEvent(
    new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
  );
}

describe("ScrubBar keyboard seeking", () => {
  it("nudges ±5s with arrow keys", () => {
    const { slider, onSeek } = setup(100, 600);
    key(slider, "ArrowRight");
    expect(onSeek).toHaveBeenLastCalledWith(105);
    key(slider, "ArrowLeft");
    expect(onSeek).toHaveBeenLastCalledWith(95);
  });

  it("jumps ±60s with PageUp/PageDown", () => {
    const { slider, onSeek } = setup(100, 600);
    key(slider, "PageUp");
    expect(onSeek).toHaveBeenLastCalledWith(160);
    key(slider, "PageDown");
    expect(onSeek).toHaveBeenLastCalledWith(40);
  });

  it("Home/End jump to the bounds and clamp", () => {
    const { slider, onSeek } = setup(100, 600);
    key(slider, "Home");
    expect(onSeek).toHaveBeenLastCalledWith(0);
    key(slider, "End");
    expect(onSeek).toHaveBeenLastCalledWith(600);
  });

  it("clamps at the ends (never seeks below 0 or past duration)", () => {
    const { slider, onSeek } = setup(2, 600);
    key(slider, "ArrowLeft"); // 2 - 5 = -3 → 0
    expect(onSeek).toHaveBeenLastCalledWith(0);
  });

  it("exposes a human-readable time via aria-valuetext", () => {
    const { slider } = setup(125, 600);
    expect(slider).toHaveAttribute("aria-valuetext", "2:05");
  });

  it("uses a compositor-friendly scale transform for progress", () => {
    const { slider } = setup(150, 600);
    const fill = slider.querySelector(".scrubbar-fill") as HTMLElement;
    expect(fill.style.transform).toBe("scaleX(0.25)");
    expect(fill.style.width).toBe("");
  });

  it("ignores keys with no live duration", () => {
    const { slider, onSeek } = setup(0, 0);
    key(slider, "ArrowRight");
    expect(onSeek).not.toHaveBeenCalled();
  });
});

describe("ScrubBar pointer flow", () => {
  it("tracks hover state and calls onHover with clamped timeline", () => {
    const onHover = vi.fn();
    const onLeave = vi.fn();
    const onSeek = vi.fn();

    const { container } = render(
      <ScrubBar
        currentTime={100}
        duration={600}
        preview={{ time: 250, image: null }}
        onHover={onHover}
        onLeave={onLeave}
        onSeek={onSeek}
      />,
    );

    const slider = screen.getByRole("slider", { name: "Seek" });
    slider.getBoundingClientRect = vi.fn(() => ({
      left: 10,
      width: 200,
    } as DOMRect));

    fireEvent.pointerMove(slider, { clientX: 110 });
    expect(onHover).toHaveBeenCalledWith(300);
    expect(container.querySelector(".scrub-tooltip")).toBeTruthy();

    fireEvent.pointerLeave(slider);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("seeks on click and clamps pointer positions outside the bar", () => {
    const onHover = vi.fn();
    const onLeave = vi.fn();
    const onSeek = vi.fn();

    render(
      <ScrubBar
        currentTime={50}
        duration={600}
        preview={null}
        onHover={onHover}
        onLeave={onLeave}
        onSeek={onSeek}
      />,
    );

    const slider = screen.getByRole("slider", { name: "Seek" });
    slider.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      width: 100,
    } as DOMRect));

    fireEvent.pointerDown(slider, { clientX: 120 });
    expect(onSeek).toHaveBeenCalledWith(600);
    expect(onHover).not.toHaveBeenCalled();

    onSeek.mockClear();
    fireEvent.pointerDown(slider, { clientX: -40 });
    expect(onSeek).toHaveBeenCalledWith(0);
  });

  it("captures the pointer and seeks continuously while dragging outside the rail", () => {
    const onSeek = vi.fn();
    const onScrubbingChange = vi.fn();

    render(
      <ScrubBar
        currentTime={50}
        duration={600}
        preview={null}
        onHover={() => {}}
        onLeave={() => {}}
        onSeek={onSeek}
        onScrubbingChange={onScrubbingChange}
      />,
    );

    const slider = screen.getByRole("slider", { name: "Seek" }) as HTMLElement;
    slider.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      width: 100,
    } as DOMRect));
    slider.setPointerCapture = vi.fn();
    slider.hasPointerCapture = vi.fn(() => true);
    slider.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(slider, { clientX: 20, pointerId: 7 });
    fireEvent.pointerMove(slider, { clientX: 75, pointerId: 7 });
    fireEvent.pointerLeave(slider, { pointerId: 7 });
    fireEvent.pointerMove(slider, { clientX: 120, pointerId: 7 });
    fireEvent.pointerUp(slider, { clientX: 120, pointerId: 7 });

    expect(slider.setPointerCapture).toHaveBeenCalledWith(7);
    expect(onSeek.mock.calls.map(([time]) => time)).toEqual([120, 450, 600, 600]);
    expect(onScrubbingChange.mock.calls).toEqual([[true], [false]]);
    expect(slider.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it.each(["pointerCancel", "lostPointerCapture"] as const)(
    "ends an active drag on %s",
    (eventName) => {
      const onSeek = vi.fn();
      const onScrubbingChange = vi.fn();
      render(
        <ScrubBar
          currentTime={50}
          duration={600}
          preview={null}
          onHover={() => {}}
          onLeave={() => {}}
          onSeek={onSeek}
          onScrubbingChange={onScrubbingChange}
        />,
      );
      const slider = screen.getByRole("slider", { name: "Seek" }) as HTMLElement;
      slider.getBoundingClientRect = vi.fn(() => ({ left: 0, width: 100 } as DOMRect));
      slider.setPointerCapture = vi.fn();
      slider.hasPointerCapture = vi.fn(() => true);
      slider.releasePointerCapture = vi.fn();

      fireEvent.pointerDown(slider, { clientX: 20, pointerId: 7 });
      fireEvent[eventName](slider, { pointerId: 7 });
      fireEvent.pointerMove(slider, { clientX: 80, pointerId: 7 });

      expect(onSeek.mock.calls.map(([time]) => time)).toEqual([120]);
      expect(onScrubbingChange.mock.calls).toEqual([[true], [false]]);
    },
  );

  it("previews a deferred pointer gesture without preparing until its own release", () => {
    const onSeek = vi.fn();
    const onSeekPreview = vi.fn();
    const props = { currentTime: 50, duration: 600, preview: null, onHover: vi.fn(), onLeave: vi.fn(), onSeek, onSeekPreview };
    const { rerender } = render(<ScrubBar {...props} />);
    const slider = screen.getByRole("slider", { name: "Seek" });
    slider.getBoundingClientRect = vi.fn(() => ({ left: 0, width: 100 } as DOMRect));
    fireEvent.pointerDown(slider, { clientX: 20, pointerId: 7 });
    fireEvent.pointerMove(slider, { clientX: 75, pointerId: 7 });
    expect(onSeekPreview.mock.calls.map(([time]) => time)).toEqual([120, 450]);
    expect(onSeek).not.toHaveBeenCalled();
    rerender(<ScrubBar {...props} currentTime={60} />);
    expect(slider).toHaveAttribute("aria-valuenow", "450");
    expect(slider.querySelector(".scrubbar-fill")).toHaveStyle({ transform: "scaleX(0.75)" });
    fireEvent.pointerDown(slider, { clientX: 90, pointerId: 8 });
    expect(onSeekPreview).toHaveBeenCalledTimes(2);
    fireEvent.pointerUp(slider, { clientX: 90, pointerId: 8 });
    expect(onSeek).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider, { clientX: 80, pointerId: 7 });
    expect(onSeek.mock.calls).toEqual([[480]]);
    expect(slider).toHaveAttribute("aria-valuenow", "60");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onSeek).toHaveBeenLastCalledWith(65);
    expect(onSeekPreview).toHaveBeenCalledTimes(2);
  });

  it("cancels a disabled deferred gesture even when reenabled before pointer release", () => {
    const onSeek = vi.fn();
    const onScrubbingChange = vi.fn();
    const props = { currentTime: 50, duration: 600, preview: null, onHover: vi.fn(), onLeave: vi.fn(), onSeek, onSeekPreview: vi.fn(), onScrubbingChange };
    const { rerender } = render(<ScrubBar {...props} />);
    const slider = screen.getByRole("slider", { name: "Seek" });
    slider.getBoundingClientRect = vi.fn(() => ({ left: 0, width: 100 } as DOMRect));
    fireEvent.pointerDown(slider, { clientX: 20, pointerId: 7 });
    rerender(<ScrubBar {...props} disabled />);
    expect(onScrubbingChange.mock.calls).toEqual([[true], [false]]);
    rerender(<ScrubBar {...props} />);
    fireEvent.pointerUp(slider, { clientX: 80, pointerId: 7 });
    expect(onSeek).not.toHaveBeenCalled();
    expect(slider).toHaveAttribute("aria-valuenow", "50");
  });

  it("does not seek from a zero-width layout box", () => {
    const { slider, onSeek } = setup(50, 600);
    slider.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      width: 0,
    } as DOMRect));

    fireEvent.pointerDown(slider, { clientX: 0, pointerId: 1 });
    expect(onSeek).not.toHaveBeenCalled();
  });
});

describe("formatTime", () => {
  it("formats M:SS and H:MM:SS, guards invalid", () => {
    expect(formatTime(65)).toBe("1:05");
    expect(formatTime(3661)).toBe("1:01:01");
    expect(formatTime(-1)).toBe("0:00");
    expect(formatTime(NaN)).toBe("0:00");
  });
});
