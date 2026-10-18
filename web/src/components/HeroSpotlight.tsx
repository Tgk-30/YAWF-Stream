// Cinematic billboard hero: auto-rotates through a few featured titles with a
// crossfade + slow Ken Burns zoom on the backdrop, a layered scrim for legibility,
// large title, badges, Play/Details, and bar indicators. Pauses on hover,
// keyboard focus, or explicit request. Falls back to a single item. Animation
// is pure CSS (see the route-frame note in App).

import { useEffect, useRef, useState } from "react";
import { MediaPreview as MediaPreviewNS } from "../models/media";
import type { MediaPreview } from "../models/media";
import { Icon } from "./Icon";
import "./HeroSpotlight.css";

/** One backdrop layer in the crossfade stack. `seq` keys the layer (item ids
 *  repeat when the carousel rotates back to a title). */
interface BackdropLayer {
  seq: number;
  id: string;
  url: string | null;
}

interface HeroSpotlightProps {
  /** One or more featured items; rotates when >1. */
  items?: MediaPreview[];
  item?: MediaPreview;
  /** Optional overview for the active item (page supplies when available). */
  overview?: string | null;
  onPlay?: (item: MediaPreview) => void;
  onDetails?: (item: MediaPreview) => void;
  intervalMs?: number;
  /** Park the rotation while an overlay covers this screen - a covered
   *  carousel still invalidates the overlay's backdrop blur every frame. */
  suspended?: boolean;
}

/**
 * Content-aware accent: sample the backdrop down to a tiny canvas and average
 * the vivid (saturated, mid-luminance) pixels into one dominant RGB. Used to
 * recolor the hero chrome per title (the Apple-TV / Disney+ signature). Returns
 * null when the canvas is tainted (no CORS) or there isn't enough vivid color - 
 * the caller then falls back to the global accent.
 */
function extractDominantRGB(img: HTMLImageElement): string | null {
  try {
    const w = 24;
    const h = 14;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const cr = data[i];
      const cg = data[i + 1];
      const cb = data[i + 2];
      const max = Math.max(cr, cg, cb);
      const min = Math.min(cr, cg, cb);
      const sat = max === 0 ? 0 : (max - min) / max;
      const lum = (cr + cg + cb) / 3;
      // Skip near-black, near-white, and washed-out pixels - keep the vivid ones.
      if (lum < 30 || lum > 226 || sat < 0.25) continue;
      r += cr;
      g += cg;
      b += cb;
      n += 1;
    }
    if (n < 6) return null;
    r = Math.round(r / n);
    g = Math.round(g / n);
    b = Math.round(b / n);
    // Lift very dark averages so the glow reads against the dark scrim.
    const lift = Math.max(0, 96 - (r + g + b) / 3);
    return `${Math.min(255, r + lift)}, ${Math.min(255, g + lift)}, ${Math.min(255, b + lift)}`;
  } catch {
    return null; // tainted canvas (no CORS) - fall back to the global accent.
  }
}

// Accent extraction is pure per-URL - cache results so rotating back to a title
// (every ~42s on a 6-item carousel) doesn't re-download and re-scan the full
// bitmap each pass. Failed extractions are cached too (null) so hopeless
// backdrops aren't re-probed. Small FIFO cap keeps it bounded across screens.
const accentCache = new Map<string, string | null>();
const ACCENT_CACHE_MAX = 64;
const FAILED_BACKDROP_CACHE_MAX = 64;

function cacheAccent(url: string, value: string | null) {
  if (accentCache.size >= ACCENT_CACHE_MAX && !accentCache.has(url)) {
    const oldest = accentCache.keys().next().value;
    if (oldest != null) accentCache.delete(oldest);
  }
  accentCache.set(url, value);
}

function addFailedBackdrop(
  failed: ReadonlySet<string>,
  url: string,
): ReadonlySet<string> {
  if (failed.has(url)) return failed;

  const next = new Set(failed);
  if (next.size >= FAILED_BACKDROP_CACHE_MAX) {
    const oldest = next.values().next().value;
    if (oldest != null) next.delete(oldest);
  }
  next.add(url);
  return next;
}

export function HeroSpotlight({
  items,
  item,
  overview,
  onPlay,
  onDetails,
  // 12s cadence - the 4s Ken Burns still plays per slide, but the blur-sampled
  // animation duty cycle drops from 57% to 33% (measured +6-7 points of device
  // GPU while idle on Discover). Trivially reversible.
  intervalMs = 12000,
  suspended = false,
}: HeroSpotlightProps) {
  const list = (items && items.length > 0 ? items : item ? [item] : []).slice(0, 6);
  const [index, setIndex] = useState(0);
  const [rotationPaused, setRotationPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  // Keep failed backdrop URLs bounded to this mounted carousel. A remount gets
  // a fresh chance, while revisiting a failed slide during this session stays
  // on the gradient instead of retrying the same request.
  const [failedBackdrops, setFailedBackdrops] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // PERF: park the carousel entirely while the window is hidden - otherwise it
  // keeps rotating (and preloading + probing backdrops) forever in a window
  // nobody can see.
  const [hidden, setHidden] = useState(() => document.hidden);
  const heroRef = useRef<HTMLDivElement>(null);
  const active = list[Math.min(index, list.length - 1)];
  const backdrop = active ? MediaPreviewNS.backdropURL(active) : null;
  const backdropFailed = backdrop != null && failedBackdrops.has(backdrop);
  const displayBackdrop = backdropFailed ? null : backdrop;

  // Backdrop crossfade layers, oldest first. The incoming layer fades in ON TOP
  // of the previous one, which stays fully opaque underneath until it is covered
  // and then drops out on animationend - so there is never a luminance dip or a
  // frame of empty hero, even if a dot is clicked mid-crossfade.
  const [layers, setLayers] = useState<BackdropLayer[]>(() =>
    active ? [{ seq: 1, id: active.id, url: displayBackdrop }] : [],
  );

  useEffect(() => {
    if (!active) return;
    setLayers((prev) => {
      // Idempotent: never stack the same slide twice in a row (StrictMode
      // re-runs mount effects). `seq` is derived from the tail so it stays
      // unique across the live list without an impure ref bump.
      const last = prev[prev.length - 1];
      if (last && last.id === active.id) return prev;
      return [...prev, { seq: (last?.seq ?? 0) + 1, id: active.id, url: displayBackdrop }];
    });
  }, [active, displayBackdrop]);

  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    if (
      list.length <= 1 ||
      rotationPaused ||
      hovered ||
      focusWithin ||
      hidden ||
      suspended
    ) {
      return;
    }
    const t = setInterval(() => setIndex((i) => (i + 1) % list.length), intervalMs);
    return () => clearInterval(t);
  }, [
    list.length,
    rotationPaused,
    hovered,
    focusWithin,
    hidden,
    suspended,
    intervalMs,
  ]);

  // Invisible polish: preload the next backdrop so the crossfade never flashes a
  // half-loaded image. This is a single image the carousel is about to show in
  // ~12s while visible, so we preload it when the hero is not hidden or covered
  // (the same bytes, a beat earlier) rather than gating on smart-preload; only
  // the expensive code-chunk preloads stay gated (see App). The Image is held
  // and detached on cleanup so an in-flight preload doesn't keep loading (and
  // pinning memory) after the hero unmounts or advances. Keyed on the URL string
  // (`list` is a fresh slice every render - using it as a dep re-ran this effect,
  // and re-issued the preload, on every single render).
  const nextBackdrop =
    list.length > 1 ? MediaPreviewNS.backdropURL(list[(index + 1) % list.length]) : null;
  const nextBackdropFailed =
    nextBackdrop != null && failedBackdrops.has(nextBackdrop);
  useEffect(() => {
    if (!nextBackdrop || nextBackdropFailed || hidden || suspended) return;
    const img = new Image();
    img.src = nextBackdrop;
    return () => {
      img.src = "";
    };
  }, [nextBackdrop, nextBackdropFailed, hidden, suspended]);

  // Per-title accent: recolor the hero chrome from the backdrop's dominant color.
  // Uses a separate CORS probe image so the *displayed* backdrop is never at risk
  // (if CORS/extraction fails, the global accent stays).
  useEffect(() => {
    const el = heroRef.current;
    if (el) el.style.removeProperty("--title-accent-rgb");
    if (!backdrop || backdropFailed || el == null || hidden || suspended) return;
    // Cache hit: no network fetch, no bitmap scan - just set the property.
    if (accentCache.has(backdrop)) {
      const cached = accentCache.get(backdrop);
      if (cached != null) el.style.setProperty("--title-accent-rgb", cached);
      return;
    }
    let cancelled = false;
    const probe = new Image();
    probe.crossOrigin = "anonymous";
    probe.onload = () => {
      if (cancelled) return;
      const rgb = extractDominantRGB(probe);
      cacheAccent(backdrop, rgb);
      if (rgb && heroRef.current) heroRef.current.style.setProperty("--title-accent-rgb", rgb);
    };
    probe.onerror = () => {
      if (cancelled) return;
      cacheAccent(backdrop, null);
    };
    probe.src = backdrop;
    return () => {
      cancelled = true;
      // Fully detach so an in-flight download/decode can't complete (and pin the
      // bitmap) after rotation - mirrors the preload cleanup above.
      probe.onload = null;
      probe.onerror = null;
      probe.src = "";
    };
  }, [backdrop, backdropFailed, hidden, suspended]);

  if (!active) return null;
  const rating = MediaPreviewNS.ratingString(active);

  return (
    <div
      className="hero"
      ref={heroRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocusWithin(false);
        }
      }}
    >
      {/* Backdrop crossfade + Ken Burns, both pure CSS.
          PERF: the Ken Burns scale used to run `intervalMs/1000 + 1` = 8s - 
          longer than the 7s rotation, so the zoom NEVER went idle (each new
          slide started a zoom that outlived the slide). A fixed 4s zoom
          completes with ~3s of genuine idle per cycle. */}
      {layers.map((layer) => (
        <div
          key={layer.seq}
          className="hero-backdrop-layer"
          onAnimationEnd={(e) => {
            // Only the fade-in settles the crossfade; the Ken Burns animation on
            // the same element also fires animationend (at 4s) - ignore it.
            if (e.animationName !== "heroBackdropIn") return;
            setLayers((prev) => {
              const i = prev.findIndex((l) => l.seq === layer.seq);
              return i <= 0 ? prev : prev.slice(i);
            });
          }}
        >
          {layer.url ? (
            <img
              className="hero-backdrop"
              src={layer.url}
              alt=""
              draggable={false}
              decoding="async"
              onError={() => {
                const failedUrl = layer.url;
                if (!failedUrl) return;
                setFailedBackdrops((failed) => addFailedBackdrop(failed, failedUrl));
                setLayers((previous) =>
                  previous.map((entry) =>
                    entry.url === failedUrl ? { ...entry, url: null } : entry,
                  ),
                );
              }}
              /* `fetchpriority` (lowercase) is the LCP resource hint React 18
                 forwards to the DOM without warning; the camelCase `fetchPriority`
                 prop is React 19-only and logs an unknown-prop warning under 18. */
              {...({ fetchpriority: "high" } as Record<string, string>)}
            />
          ) : (
            <div className="hero-backdrop hero-gradient" />
          )}
        </div>
      ))}

      <div className="hero-scrim" />
      <div className="hero-vignette" />

      <div key={active.id} className="hero-content">
        <div className="hero-badges">
          <span className="chip hero-featured">
            Featured
          </span>
          {active.year != null && (
            <>
              <span className="hero-meta-separator" aria-hidden="true" />
              <span className="hero-year">{active.year}</span>
            </>
          )}
          {rating !== "" && (
            <>
              <span className="hero-meta-separator" aria-hidden="true" />
              <span className="hero-rating">
                <Icon name="star" size={12} className="t-warning" />
                {rating}
              </span>
            </>
          )}
        </div>

        <h1 className="hero-title">{active.title}</h1>
        {overview && <p className="hero-overview">{overview}</p>}

        <div className="hero-actions">
          <button type="button" className="btn btn-prominent hero-play" onClick={() => onPlay?.(active)}>
            <Icon name="play" size={16} />
            Play
          </button>
          <button type="button" className="btn hero-info" onClick={() => onDetails?.(active)}>
            <Icon name="info" size={16} />
            More info
          </button>
        </div>
      </div>

      {list.length > 1 && (
        <div className="hero-dots" role="group" aria-label="Featured titles">
          <button
            type="button"
            className="hero-carousel-toggle"
            aria-pressed={rotationPaused}
            aria-label={
              rotationPaused
                ? "Resume featured title rotation"
                : "Pause featured title rotation"
            }
            onClick={() => setRotationPaused((current) => !current)}
          >
            <Icon name={rotationPaused ? "play" : "pause"} size={12} />
          </button>
          {list.map((it, i) => (
            <button
              key={it.id}
              type="button"
              className={"hero-dot" + (i === index ? " is-active" : "")}
              aria-pressed={i === index}
              aria-label={`${it.title}, featured ${i + 1} of ${list.length}`}
              onClick={() => setIndex(i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
