import { describe, expect, it, vi } from "vitest";
import { installSuspendOnHidden } from "./suspendOnHidden";

type Listener = (...args: Array<unknown>) => void;

describe("installSuspendOnHidden", () => {
  it("toggles [data-suspended] when document visibility changes and cleans up", () => {
    const listeners = new Map<string, Listener[]>();

    const documentElement = { dataset: {} } as { dataset: Record<string, string> };
    // `Document.hidden` is readonly in lib.dom, so keep the stub's own literal
    // type (mutable `hidden`) and widen only at the call boundary.
    const doc = {
      hidden: false,
      documentElement,
      addEventListener: (event: string, listener: Listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
      removeEventListener: vi.fn(),
    };

    const cleanup = installSuspendOnHidden(doc as unknown as Document);

    expect(documentElement.dataset.suspended).toBeUndefined();
    expect(listeners.get("visibilitychange")).toHaveLength(1);

    doc.hidden = true;
    listeners.get("visibilitychange")?.[0]?.();
    expect(documentElement.dataset.suspended).toBe("");

    doc.hidden = false;
    listeners.get("visibilitychange")?.[0]?.();
    expect(documentElement.dataset.suspended).toBeUndefined();

    cleanup();

    expect(doc.removeEventListener).toHaveBeenCalledWith(
      "visibilitychange",
      listeners.get("visibilitychange")?.[0],
    );
    expect(documentElement.dataset.suspended).toBeUndefined();
  });
});
