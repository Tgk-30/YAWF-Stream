// Shared modal/popover accessibility hook.
//
// Attach the returned ref to a dialog's root element (give the root
// `tabIndex={-1}` so it can receive focus). On open it moves focus into the
// dialog so screen readers announce it and keyboard Tab stays within the new
// context; while open, Escape closes it; on close it restores focus to whatever
// was focused before the dialog opened. Keeps every dialog's keyboard behavior
// consistent without each one re-implementing the boilerplate.

import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableChildren(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      element.getAttribute("aria-hidden") !== "true" &&
      !element.closest("[inert]"),
  );
}

export function useModalA11y<T extends HTMLElement>(
  onClose: () => void,
  // `active` lets a persistently-mounted dialog (visibility toggled by a prop,
  // e.g. FilterSlideover's `open`) drive focus/Escape on each open/close.
  // Mount-based dialogs leave it at the default (active the whole time mounted).
  active = true,
  // Nested portals can temporarily own the modal interaction without closing
  // the parent. Suspension keeps the parent's original focus-restore target
  // alive while disabling its Escape and Tab handlers.
  suspended = false,
) {
  const ref = useRef<T | null>(null);
  // Keep the latest onClose without re-running the effect (and thus re-stealing
  // focus) every render when the caller passes an inline handler.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;

  useEffect(() => {
    if (!active) return;
    const previouslyFocused =
      typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null;

    // Focus the dialog container itself (rather than auto-focusing the first
    // control, which could be a destructive button): the dialog is announced,
    // and the next Tab enters its controls.
    ref.current?.focus?.({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (suspendedRef.current) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;

      const dialog = ref.current;
      if (dialog == null) return;
      const focusable = focusableChildren(dialog);
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const current = document.activeElement as HTMLElement | null;
      const currentIsFocusable = current != null && focusable.includes(current);

      if (e.shiftKey) {
        if (currentIsFocusable && current !== first) return;
        e.preventDefault();
        last.focus();
        return;
      }

      if (currentIsFocusable && current !== last) return;
      e.preventDefault();
      first.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Restore focus to the trigger so keyboard users aren't dumped at the top.
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [active]);

  return ref;
}
