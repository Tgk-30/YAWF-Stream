import { useLayoutEffect, useRef } from "react";

/** New routes start at top; another profile must not inherit the old scroll. */
export function useRouteScrollReset(route: string, profileKey: string) {
  const scrollportRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    // Run after the destination commits (and can clamp the old overflow), but
    // before paint. No delayed reset may overwrite a later user scroll.
    if (scrollportRef.current) scrollportRef.current.scrollTop = 0;
  }, [route, profileKey]);
  return scrollportRef;
}
