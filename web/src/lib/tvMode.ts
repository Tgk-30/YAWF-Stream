const TV_QUERY_KEY = "tv";

export function isTVMode(location: Pick<Location, "pathname" | "search"> = window.location): boolean {
  const path = location.pathname.replace(/\/+$/, "");
  return (
    path.endsWith("/tv") ||
    new URLSearchParams(location.search).get(TV_QUERY_KEY) === "1"
  );
}

export function isPhoneRemoteRoute(
  location: Pick<Location, "pathname"> = window.location,
): boolean {
  return location.pathname.replace(/\/+$/, "").endsWith("/remote");
}

type FocusCandidate = Pick<HTMLElement, "getBoundingClientRect">;

export function nextSpatialCandidate<T extends FocusCandidate>(
  current: T,
  candidates: readonly T[],
  direction: "left" | "right" | "up" | "down",
): T | null {
  const from = current.getBoundingClientRect();
  const fromX = from.left + from.width / 2;
  const fromY = from.top + from.height / 2;
  let best: { candidate: T; score: number } | null = null;

  for (const candidate of candidates) {
    if (candidate === current) continue;
    const rect = candidate.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const dx = x - fromX;
    const dy = y - fromY;
    const primary =
      direction === "left"
        ? -dx
        : direction === "right"
          ? dx
          : direction === "up"
            ? -dy
            : dy;
    if (primary <= 1) continue;
    const cross =
      direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    // Primary distance keeps navigation moving in the requested direction.
    // The larger cross-axis penalty prefers controls in the same visual row or
    // column instead of jumping diagonally across a ten-foot layout.
    const score = primary + cross * 2.5;
    if (best == null || score < best.score) best = { candidate, score };
  }
  return best?.candidate ?? null;
}

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function installTVSpatialNavigation(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    const direction =
      event.key === "ArrowLeft"
        ? "left"
        : event.key === "ArrowRight"
          ? "right"
          : event.key === "ArrowUp"
            ? "up"
            : event.key === "ArrowDown"
              ? "down"
              : null;
    if (direction == null) return;
    const current = document.activeElement;
    if (!(current instanceof HTMLElement)) return;
    const candidates = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (candidate) => {
        const rect = candidate.getBoundingClientRect();
        return (
          candidate.getAttribute("aria-hidden") !== "true" &&
          rect.width > 0 &&
          rect.height > 0
        );
      },
    );
    const next = nextSpatialCandidate(current, candidates, direction);
    if (next == null) return;
    event.preventDefault();
    next.focus({ preventScroll: true });
    next.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  };
  document.addEventListener("keydown", onKeyDown);
  return () => document.removeEventListener("keydown", onKeyDown);
}
