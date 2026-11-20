// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachQuickSettingsSwipe } from "./settingsQuickSwipe";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture(top = 0) {
  vi.useFakeTimers();
  const body = document.createElement("div");
  const content = document.createElement("p");
  const control = document.createElement("button");
  document.body.append(body);
  body.append(content, control);
  const scroll = vi.fn((next: number) => { top = next; });
  Object.defineProperties(body, {
    scrollTop: { get: () => top, set: scroll },
    scrollHeight: { value: 700 },
    clientHeight: { value: 400 },
  });
  const listening = vi.spyOn(document, "addEventListener");
  const cleanup = attachQuickSettingsSwipe(body);
  const emit = (name: string, timeStamp: number, clientY: number, overrides: Partial<PointerEvent> = {}) => {
    const listener = listening.mock.calls.find(([type]) => type === name)?.[1];
    if (typeof listener !== "function") throw new Error("Missing listener");
    listener({
      isTrusted: true, isPrimary: true, pointerType: "touch", pointerId: 4,
      clientX: 110, clientY, timeStamp, target: content, defaultPrevented: false, ...overrides,
    } as PointerEvent);
  };
  const start = (overrides: Partial<PointerEvent> = {}) => emit("pointerdown", 1000, 420, overrides);
  const swipe = (overrides: Partial<PointerEvent> = {}, releaseAt = 1030) => {
    emit("pointermove", 1014, 365);
    emit("pointerup", releaseAt, 300, overrides);
  };
  return { body, cleanup, control, emit, start, swipe, scroll, setNativeTop: (next: number) => { top = next; } };
}

describe("iPad settings quick vertical swipe", () => {
  it("moves once after an unclaimed release, without changing the live gesture", () => {
    const q = fixture();
    q.start();
    q.emit("pointermove", 1014, 355);
    expect(q.scroll).not.toHaveBeenCalled();
    q.emit("pointerup", 1020, 300);
    vi.advanceTimersByTime(60);
    expect(q.scroll).not.toHaveBeenCalled();
    vi.advanceTimersByTime(140);
    expect(q.scroll.mock.calls).toEqual([[120]]);
    q.cleanup();
  });

  it("does not double-scroll if native scrolling arrives after release", () => {
    const q = fixture();
    q.start(); q.swipe();
    vi.advanceTimersByTime(42);
    q.setNativeTop(96);
    q.body.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(220);
    expect(q.body.scrollTop).toBe(96);
    expect(q.scroll).not.toHaveBeenCalled();
    q.cleanup();
  });

  it("leaves native cancellation and compositor position changes alone", () => {
    const q = fixture();
    q.start(); q.emit("pointercancel", 1020, 360); q.swipe();
    vi.advanceTimersByTime(220);
    expect(q.scroll).not.toHaveBeenCalled();
    q.start(); q.swipe();
    q.setNativeTop(75); // Native movement can be observable before scroll delivery.
    vi.advanceTimersByTime(220);
    expect(q.scroll).not.toHaveBeenCalled();
    q.cleanup();
  });

  it("clamps movement at both boundaries without reversing an edge swipe", () => {
    const q = fixture(260);
    q.start(); q.swipe();
    vi.advanceTimersByTime(220);
    expect(q.scroll).toHaveBeenLastCalledWith(300);
    q.start(); q.swipe();
    vi.advanceTimersByTime(220);
    expect(q.scroll).toHaveBeenCalledTimes(1);
    q.emit("pointerdown", 2000, 120);
    q.emit("pointermove", 2012, 300);
    q.emit("pointerup", 2020, 460);
    vi.advanceTimersByTime(220);
    expect(q.scroll.mock.calls).toEqual([[300], [0]]);
    q.cleanup();
  });

  it("ignores taps, slow swipes, horizontal movement, and interactive starts", () => {
    const q = fixture();
    q.start(); q.emit("pointerup", 1010, 420);
    q.start(); q.swipe({}, 1250);
    q.start(); q.swipe({ clientX: 430 });
    q.start({ target: q.control }); q.swipe();
    q.start({ pointerType: "mouse" }); q.swipe();
    q.start({ isTrusted: false }); q.swipe();
    q.start(); q.swipe({ defaultPrevented: true });
    vi.advanceTimersByTime(220);
    expect(q.scroll).not.toHaveBeenCalled();
    q.cleanup();
  });

  it("recovers an unclaimed vertical swipe from an opted-in fit button or its child", () => {
    const q = fixture();
    q.control.setAttribute("data-player-fit-choice", "");
    const content = document.createElement("span");
    q.control.append(content);
    q.start({ target: content }); q.swipe();
    vi.advanceTimersByTime(60);
    expect(q.scroll).not.toHaveBeenCalled();
    vi.advanceTimersByTime(140);
    expect(q.scroll.mock.calls).toEqual([[120]]);
    q.cleanup();
  });

  it("keeps fit taps and inert or disabled fit buttons out of the swipe fallback", () => {
    const q = fixture();
    q.control.setAttribute("data-player-fit-choice", "");
    q.start({ target: q.control }); q.emit("pointerup", 1010, 423);
    q.control.disabled = true;
    q.start({ target: q.control }); q.swipe();
    q.control.disabled = false;
    q.control.setAttribute("inert", "");
    q.start({ target: q.control }); q.swipe();
    vi.advanceTimersByTime(220);
    expect(q.scroll).not.toHaveBeenCalled();
    q.cleanup();
  });

  it("defers to native cancellation or actual movement even on a fit button", () => {
    const q = fixture();
    q.control.setAttribute("data-player-fit-choice", "");
    q.start({ target: q.control }); q.emit("pointercancel", 1020, 330); q.swipe();
    q.start({ target: q.control }); q.swipe();
    q.setNativeTop(63);
    q.body.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(220);
    expect(q.scroll).not.toHaveBeenCalled();
    expect(q.body.scrollTop).toBe(63);
    q.cleanup();
  });

  it("retires a pending swipe when another finger lands or the settings close", () => {
    const q = fixture();
    q.start(); q.swipe();
    q.emit("pointerdown", 1040, 380, { pointerId: 5, isPrimary: false });
    vi.advanceTimersByTime(220);
    expect(q.scroll).not.toHaveBeenCalled();
    q.start(); q.swipe();
    q.cleanup();
    q.body.remove();
    vi.advanceTimersByTime(220);
    expect(q.scroll).not.toHaveBeenCalled();
  });
});
