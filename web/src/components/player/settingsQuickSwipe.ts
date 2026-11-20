const MAX_SWIPE_MS = 64;
const NATIVE_SCROLL_GRACE_MS = 72;
const MIN_VERTICAL_PX = 48;
const INTERACTIVE = "button, input, select, textarea, a[href], label, summary, [contenteditable], [role=button], [role=slider], [inert]";

/**
 * WebKit can deliver an entire quick vertical swipe to the page without
 * moving a nested scrollport. Keep native panning and momentum in charge.
 * Only recover a finished, unclaimed swipe on plain settings content.
 */
export function attachQuickSettingsSwipe(body: HTMLDivElement): () => void {
  const doc = body.ownerDocument;
  const win = doc.defaultView;
  if (win == null) return () => {};
  type Gesture = { id: number; x: number; y: number; top: number; at: number; moved: boolean };
  let gesture: Gesture | null = null;
  let pending: number | null = null;
  const cancelPending = () => {
    if (pending != null) win.clearTimeout(pending);
    pending = null;
  };
  const reset = () => {
    gesture = null;
    cancelPending();
  };
  const down = (event: PointerEvent) => {
    if (!event.isTrusted || event.pointerType !== "touch") return;
    reset(); // A new contact, even outside the sheet, invalidates the old swipe.
    const target = event.target;
    if (!event.isPrimary || !(target instanceof Element) || !body.contains(target) ||
        target.closest(INTERACTIVE)) return;
    const top = body.scrollTop;
    if (top < 0) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, top, at: event.timeStamp, moved: false };
  };
  const move = (event: PointerEvent) => {
    if (event.isTrusted && gesture?.id === event.pointerId) gesture.moved = true;
  };
  const cancel = (event: PointerEvent) => {
    // Pointer cancellation is WebKit taking over a native pan.
    if (event.isTrusted && gesture?.id === event.pointerId) reset();
  };
  const up = (event: PointerEvent) => {
    const swipe = gesture;
    if (!event.isTrusted || swipe?.id !== event.pointerId) return;
    gesture = null;
    const elapsed = event.timeStamp - swipe.at;
    const dy = swipe.y - event.clientY;
    const dx = Math.abs(swipe.x - event.clientX);
    if (!swipe.moved || event.defaultPrevented || elapsed < 0 || elapsed > MAX_SWIPE_MS ||
        Math.abs(dy) < MIN_VERTICAL_PX || Math.abs(dy) < 1.5 * dx) return;
    // A compositor scroll can arrive just after pointerup, even without
    // pointercancel. If it does, the scroll listener drops this fallback.
    pending = win.setTimeout(() => {
      pending = null;
      if (!body.isConnected || doc.hidden || body.closest("[inert]") ||
          Math.abs(body.scrollTop - swipe.top) > 1) return;
      const limit = Math.max(0, body.scrollHeight - body.clientHeight);
      if (swipe.top > limit + 1) return;
      const next = Math.min(limit, Math.max(0, swipe.top + dy));
      if (Math.abs(next - swipe.top) > 1) body.scrollTop = next;
    }, NATIVE_SCROLL_GRACE_MS);
  };
  const nativeScrolled = () => {
    // A scroll notification before or after release is enough to defer,
    // including when rubber-banding returns to the original position.
    reset();
  };
  const events = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: cancel } as const;
  for (const type of Object.keys(events) as (keyof typeof events)[]) {
    doc.addEventListener(type, events[type], { capture: true, passive: true });
  }
  body.addEventListener("scroll", nativeScrolled, { passive: true });
  return () => {
    reset();
    for (const type of Object.keys(events) as (keyof typeof events)[]) {
      doc.removeEventListener(type, events[type], true);
    }
    body.removeEventListener("scroll", nativeScrolled);
  };
}
