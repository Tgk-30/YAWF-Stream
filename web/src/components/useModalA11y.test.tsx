// @vitest-environment jsdom
//
// Tests the shared dialog a11y hook: focus-on-open, Escape-to-close, and
// focus-restore on close.

import { describe, expect, it, vi } from "vitest";
import { render, renderHook, screen } from "@testing-library/react";
import { useModalA11y } from "./useModalA11y";

function Dialog({ onClose, empty = false }: { onClose: () => void; empty?: boolean }) {
  const ref = useModalA11y<HTMLDivElement>(onClose);
  return (
    <div ref={ref} role="dialog" aria-label="Test" tabIndex={-1}>
      {!empty && <>
        <button type="button">First</button>
        <button type="button">Last</button>
      </>}
    </div>
  );
}

function ScrollableDialog({ open, empty = false }: { open: boolean; empty?: boolean }) {
  return (
    <main data-testid="scrollport">
      <button type="button">Trigger</button>
      {open && <Dialog onClose={() => {}} empty={empty} />}
    </main>
  );
}

// jsdom keeps real focus state but does not scroll ancestors when focus changes.
// Model that default browser side effect only for the target under test.
function modelAncestorFocusScroll(
  scrollport: HTMLElement,
  matches: (element: HTMLElement) => boolean,
) {
  const originalFocus = HTMLElement.prototype.focus;
  return vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    originalFocus.call(this, options);
    if (matches(this) && options?.preventScroll !== true) scrollport.scrollTop = 0;
  });
}

function InactiveDialog({ onClose }: { onClose: () => void }) {
  const ref = useModalA11y<HTMLDivElement>(onClose, false);
  return (
    <div ref={ref} role="dialog" aria-label="Inactive test" tabIndex={-1}>
      <button type="button">Inside</button>
    </div>
  );
}

function SuspendedDialog({
  onClose,
  suspended,
}: {
  onClose: () => void;
  suspended: boolean;
}) {
  const ref = useModalA11y<HTMLDivElement>(onClose, true, suspended);
  return (
    <div ref={ref} role="dialog" aria-label="Suspended test" tabIndex={-1}>
      <button type="button">Inside</button>
    </div>
  );
}

function key(k: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
}

describe("useModalA11y", () => {
  it("focuses the dialog container on open", () => {
    render(<Dialog onClose={() => {}} />);
    expect(screen.getByRole("dialog")).toHaveFocus();
  });

  it("preserves the ancestor scroll position when focusing the opened dialog", () => {
    const { rerender, unmount } = render(<ScrollableDialog open={false} />);
    const scrollport = screen.getByTestId("scrollport");
    screen.getByRole("button", { name: "Trigger" }).focus();
    scrollport.scrollTop = 40;
    const focus = modelAncestorFocusScroll(scrollport, (element) => element.getAttribute("role") === "dialog");
    try {
      rerender(<ScrollableDialog open />);
      expect(screen.getByRole("dialog")).toHaveFocus();
      expect(scrollport.scrollTop).toBe(40);
    } finally {
      unmount();
      focus.mockRestore();
    }
  });

  it("preserves the ancestor scroll position when restoring focus after close", () => {
    const { rerender, unmount } = render(<ScrollableDialog open={false} />);
    const scrollport = screen.getByTestId("scrollport");
    const trigger = screen.getByRole("button", { name: "Trigger" });
    trigger.focus();
    rerender(<ScrollableDialog open />);
    scrollport.scrollTop = 40;
    const focus = modelAncestorFocusScroll(scrollport, (element) => element === trigger);
    try {
      rerender(<ScrollableDialog open={false} />);
      expect(trigger).toHaveFocus();
      expect(scrollport.scrollTop).toBe(40);
    } finally {
      unmount();
      focus.mockRestore();
    }
  });

  it.each([false, true])("keeps empty-dialog Tab trapping from scrolling ancestors (shift=%s)", (shiftKey) => {
    const { unmount } = render(<ScrollableDialog open empty />);
    const scrollport = screen.getByTestId("scrollport");
    scrollport.scrollTop = 40;
    const focus = modelAncestorFocusScroll(scrollport, (element) => element.getAttribute("role") === "dialog");
    try {
      const event = new KeyboardEvent("keydown", {
        key: "Tab", shiftKey, bubbles: true, cancelable: true,
      });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(screen.getByRole("dialog")).toHaveFocus();
      expect(scrollport.scrollTop).toBe(40);
    } finally {
      unmount();
      focus.mockRestore();
    }
  });

  it("supports environments without document by skipping prior-focus capture", () => {
    const onClose = vi.fn();
    const { rerender } = renderHook(
      (props: { active: boolean }) => useModalA11y<HTMLDivElement>(onClose, props.active),
      { initialProps: { active: false } },
    );
    vi.stubGlobal("document", undefined);
    expect(() => rerender({ active: true })).not.toThrow();
    key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    rerender({ active: false });
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);
    key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cycles Tab and Shift+Tab within the dialog", () => {
    render(<Dialog onClose={() => {}} />);
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });

    last.focus();
    key("Tab");
    expect(first).toHaveFocus();

    first.focus();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
    );
    expect(last).toHaveFocus();
  });

  it("does not call onClose for other keys", () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);
    key("Enter");
    key("a");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does nothing while inactive", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const onClose = vi.fn();

    render(<InactiveDialog onClose={onClose} />);
    expect(screen.getByRole("dialog")).not.toHaveFocus();
    key("Escape");
    expect(onClose).not.toHaveBeenCalled();

    document.body.removeChild(trigger);
  });

  it("temporarily yields Escape to a nested modal without resetting focus state", () => {
    const onClose = vi.fn();
    const { rerender } = render(<SuspendedDialog onClose={onClose} suspended />);
    key("Escape");
    expect(onClose).not.toHaveBeenCalled();

    rerender(<SuspendedDialog onClose={onClose} suspended={false} />);
    key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the trigger on unmount", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    const { unmount } = render(<Dialog onClose={() => {}} />);
    expect(screen.getByRole("dialog")).toHaveFocus(); // moved into dialog
    unmount();
    expect(trigger).toHaveFocus(); // restored
    trigger.remove();
  });
});
