/**
 * theme.config.ts - the ONLY file a rebrand touches.
 *
 * The brandability config below is compiled into CSS custom properties on
 * `:root` (`--brand-*`, `--accent-*`, `--ink-*`, `--font-display`, …).
 * Every component references variables only - zero hard-coded hex values.
 *
 * Switching presets cross-fades all color properties over 400ms and persists
 * to localStorage.
 */
import { useSyncExternalStore } from 'react';
import { asset } from '@/lib/asset';

export type ThemePresetName = 'stream-teal' | 'aurora-violet' | 'ember-amber';

const theme = {
  name: 'YAWF Stream',
  company: 'YAWF Group',
  brandMeaning: 'Yours. Always. Wherever. Forever.',
  tagline: 'Your Accounts. Watch Freely.',
  logo: asset('brand/logo-mark.svg'), // play-in-rings mark
  preset: 'stream-teal' as ThemePresetName, // stream-teal | aurora-violet | ember-amber
  fonts: {
    display: "'Space Grotesk', sans-serif",
    body: "'Inter', sans-serif",
    mono: "'JetBrains Mono', monospace",
  },
  radius: '20px', // card corner radius scale base
  glow: 1.0, // global glow intensity multiplier (0 = flat)
};

export default theme;

/* ── Presets ─────────────────────────────────────────────────────────── */

export interface ThemePreset {
  label: string;
  brand: string;
  brandDeep: string;
  accent: string;
  warm: string;
  /** rgb triplet tinting glass fills + hairlines */
  tint: string;
  /** third stop of --grad-stream */
  gradThird: string;
}

export const THEME_PRESETS: Record<ThemePresetName, ThemePreset> = {
  'stream-teal': {
    label: 'Stream Teal',
    brand: '#2EE6C8',
    brandDeep: '#0E8C7A',
    accent: '#3EC9F5',
    warm: '#FFB454',
    tint: '158, 224, 233',
    gradThird: '#8B7CF6',
  },
  'aurora-violet': {
    label: 'Aurora Violet',
    brand: '#8B7CF6',
    brandDeep: '#5E4BD1',
    accent: '#C084FC',
    warm: '#7DD3FC',
    tint: '196, 182, 252',
    gradThird: '#7DD3FC',
  },
  'ember-amber': {
    label: 'Ember Amber',
    brand: '#FFB454',
    brandDeep: '#C26A1F',
    accent: '#FF7A59',
    warm: '#2EE6C8',
    tint: '255, 205, 150',
    gradThird: '#2EE6C8',
  },
};

export const THEME_PRESET_NAMES = Object.keys(THEME_PRESETS) as ThemePresetName[];

const STORAGE_KEY = 'ds-theme-preset';

/* ── Compiler ────────────────────────────────────────────────────────── */

function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function pxScale(base: string, delta: number): string {
  const n = parseFloat(base);
  return `${Math.max(0, n + delta)}px`;
}

/** Compiles config + preset (+ optional playground tweaks) into the `--*` custom property map. */
export function buildThemeVars(presetName: ThemePresetName, tweaks?: ThemeTweaks): Record<string, string> {
  const p = THEME_PRESETS[presetName] ?? THEME_PRESETS[theme.preset];
  const t = tweaks ?? currentTweaks;

  const brand = t.brandHex ?? p.brand;
  const brandDeep = t.brandHex ? deepenHex(t.brandHex) : p.brandDeep;
  const g = t.glow ?? theme.glow;
  const fonts = t.fontPairing ? FONT_PAIRINGS[t.fontPairing] : theme.fonts;
  const radius = t.radiusPx != null ? `${Math.round(t.radiusPx)}px` : theme.radius;

  const brandRgb = hexToRgb(brand);
  const accentRgb = hexToRgb(p.accent);
  const warmRgb = hexToRgb(p.warm);
  const a = (alpha: number) => Math.min(1, alpha * g).toFixed(3);

  return {
    '--surface-glass': `rgba(${p.tint}, 0.045)`,
    '--surface-glass-2': `rgba(${p.tint}, 0.08)`,
    '--line': `rgba(${p.tint}, 0.12)`,
    '--line-strong': `rgba(${p.tint}, 0.22)`,

    '--brand': brand,
    '--brand-deep': brandDeep,
    '--accent': p.accent,
    '--warm': p.warm,
    '--ok': brand,
    '--brand-rgb': brandRgb,
    '--accent-rgb': accentRgb,
    '--warm-rgb': warmRgb,
    '--ink-on-brand': '#04201B',

    '--grad-stream': `linear-gradient(100deg, ${brand} 0%, ${p.accent} 55%, ${p.gradThird} 110%)`,
    '--grad-warm': `radial-gradient(closest-side, rgba(${warmRgb}, 0.35), transparent 70%)`,
    '--grad-ring-conic': `conic-gradient(from 0deg, transparent, ${brand} 18%, transparent 36%)`,

    '--glow-brand': `0 0 24px rgba(${brandRgb}, ${a(0.35)}), 0 0 64px rgba(${brandRgb}, ${a(0.12)})`,
    '--glow-accent': `0 0 24px rgba(${accentRgb}, ${a(0.3)})`,
    '--glow-warm': `0 0 32px rgba(${warmRgb}, ${a(0.25)})`,

    '--font-display': fonts.display,
    '--font-body': fonts.body,
    '--font-mono': theme.fonts.mono,

    '--radius': radius,
    '--r-row': pxScale(radius, -6),
    '--r-card': radius,
    '--r-stage': pxScale(radius, 8),
  };
}

/* ── Runtime application + persistence + subscription ────────────────── */

let currentPreset: ThemePresetName = theme.preset;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function getPreset(): ThemePresetName {
  return currentPreset;
}

export function getStoredPreset(): ThemePresetName | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v && v in THEME_PRESETS ? (v as ThemePresetName) : null;
  } catch {
    return null;
  }
}

function writeVars(presetName: ThemePresetName) {
  const root = document.documentElement;
  const vars = buildThemeVars(presetName);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.theme = presetName;
}

/** Applies a preset. `xfade` enables the 400ms color cross-fade. */
export function applyPreset(presetName: ThemePresetName, opts?: { xfade?: boolean; persist?: boolean }) {
  const { xfade = true, persist = true } = opts ?? {};
  const root = document.documentElement;

  if (xfade) {
    root.classList.add('theme-xfade');
    window.setTimeout(() => root.classList.remove('theme-xfade'), 480);
  }

  // a preset rebases the accent hue - the playground's hue tweak resets
  if (currentTweaks.brandHex) {
    currentTweaks = { ...currentTweaks, brandHex: null };
    persistTweaks();
  }

  writeVars(presetName);
  currentPreset = presetName;

  if (persist) {
    try {
      window.localStorage.setItem(STORAGE_KEY, presetName);
    } catch {
      /* private mode */
    }
  }
  emit();
}

/** Call once before first paint: stored preset + tweaks win, else config defaults. */
export function initTheme() {
  const stored = readStoredTweaks();
  if (stored) currentTweaks = stored;
  ensurePairingFonts(currentTweaks.fontPairing);

  currentPreset = getStoredPreset() ?? theme.preset;
  writeVars(currentPreset);
  applyWordmarkOverride(currentTweaks.productName);
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** React hook: current preset name, re-renders on switch. */
export function useThemePreset(): ThemePresetName {
  return useSyncExternalStore(subscribe, getPreset);
}

/* ════════════════════════════════════════════════════════════════════════
   Theme Playground extension (Brand page) - additive & backward-compatible.
   Everything above keeps its original signature; the playground's live
   re-skinning (hue / radius / glow / fonts / product name) layers on top as
   "tweaks": they persist to localStorage, apply before paint via initTheme(),
   and re-skin the whole site through the same CSS custom properties.
   ════════════════════════════════════════════════════════════════════════ */

/* ── Font pairings ─────────────────────────────────────────────────────── */

export type FontPairingName = 'grotesk-inter' | 'sora-inter' | 'grotesk-instrument';

export interface FontPairing {
  label: string;
  display: string;
  body: string;
  /** Google Fonts stylesheet, injected on demand (not in index.html) */
  href?: string;
}

export const FONT_PAIRINGS: Record<FontPairingName, FontPairing> = {
  'grotesk-inter': {
    label: 'Space Grotesk + Inter',
    display: "'Space Grotesk', sans-serif",
    body: "'Inter', sans-serif",
  },
  'sora-inter': {
    label: 'Sora + Inter',
    display: "'Sora', sans-serif",
    body: "'Inter', sans-serif",
    href: 'https://fonts.googleapis.com/css2?family=Sora:wght@500;700&display=swap',
  },
  'grotesk-instrument': {
    label: 'Space Grotesk + Instrument Sans',
    display: "'Space Grotesk', sans-serif",
    body: "'Instrument Sans', sans-serif",
    href: 'https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&display=swap',
  },
};

export const FONT_PAIRING_NAMES = Object.keys(FONT_PAIRINGS) as FontPairingName[];

/** Injects the Google Fonts stylesheet a pairing needs (idempotent). */
function ensurePairingFonts(pairing: FontPairingName | null): void {
  if (typeof document === 'undefined' || !pairing) return;
  const href = FONT_PAIRINGS[pairing]?.href;
  if (!href) return;
  const id = `ds-fonts-${pairing}`;
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

/** Preloads every pairing's webfonts (called once on playground mount). */
export function preloadPairingFonts(): void {
  FONT_PAIRING_NAMES.forEach(ensurePairingFonts);
}

/* ── Color utilities (hue slider + AA guardrail) ───────────────────────── */

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export function hslToHex(h: number, s: number, l: number): string {
  const sn = clamp01(s / 100);
  const ln = clamp01(l / 100);
  const k = (n: number) => (n + (((h % 360) + 360) % 360) / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x: number) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`.toUpperCase();
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: ((h % 360) + 360) % 360, s: s * 100, l: l * 100 };
}

/** WCAG relative luminance of a hex color. */
export function relativeLuminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

const BG0_HEX = '#04070A';

/** Contrast ratio of a color against the page background `--bg-0`. */
export function contrastOnBg0(hex: string): number {
  const l1 = relativeLuminance(hex);
  const l2 = relativeLuminance(BG0_HEX);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export function hueFromHex(hex: string): number {
  return Math.round(hexToHsl(hex).h);
}

/**
 * Hue slider guardrail: builds a vivid brand color for `hue` and clamps its
 * lightness upward until it meets WCAG AA (≥ 4.5:1) on `--bg-0`.
 */
export function brandHexFromHue(hue: number): string {
  const h = ((hue % 360) + 360) % 360;
  const s = 78;
  let l = 60;
  let hex = hslToHex(h, s, l);
  while (contrastOnBg0(hex) < 4.5 && l < 88) {
    l += 1;
    hex = hslToHex(h, s, l);
  }
  return hex;
}

/** Gradient depth end derived from a custom brand hex. */
function deepenHex(hex: string): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, Math.min(92, s + 6), Math.max(18, l * 0.45));
}

/* ── Tweaks state + persistence ────────────────────────────────────────── */

export interface ThemeTweaks {
  /** custom --brand hex from the hue slider (null = preset brand) */
  brandHex: string | null;
  /** radius scale base in px (null = config radius) */
  radiusPx: number | null;
  /** glow multiplier 0–1.5 (null = config glow) */
  glow: number | null;
  /** font pairing (null = config fonts) */
  fontPairing: FontPairingName | null;
  /** product name (null = config name) */
  productName: string | null;
}

export const DEFAULT_TWEAKS: ThemeTweaks = {
  brandHex: null,
  radiusPx: null,
  glow: null,
  fontPairing: null,
  productName: null,
};

const TWEAKS_KEY = 'ds-theme-tweaks';
let currentTweaks: ThemeTweaks = { ...DEFAULT_TWEAKS };

export function getTweaks(): ThemeTweaks {
  return currentTweaks;
}

function persistTweaks(): void {
  try {
    window.localStorage.setItem(TWEAKS_KEY, JSON.stringify(currentTweaks));
  } catch {
    /* private mode */
  }
}

function readStoredTweaks(): ThemeTweaks | null {
  try {
    const raw = window.localStorage.getItem(TWEAKS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<ThemeTweaks>;
    return {
      brandHex: typeof v.brandHex === 'string' && /^#[0-9a-f]{6}$/i.test(v.brandHex) ? v.brandHex.toUpperCase() : null,
      radiusPx: typeof v.radiusPx === 'number' && v.radiusPx >= 8 && v.radiusPx <= 28 ? v.radiusPx : null,
      glow: typeof v.glow === 'number' && v.glow >= 0 && v.glow <= 1.5 ? v.glow : null,
      fontPairing: v.fontPairing && v.fontPairing in FONT_PAIRINGS ? v.fontPairing : null,
      productName: typeof v.productName === 'string' && v.productName.trim() ? v.productName.slice(0, 24) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Applies playground tweaks on top of the current preset and rewrites :root.
 * `xfade` (400ms cross-fade) suits discrete changes; slider drags leave it off.
 */
export function applyTweaks(partial: Partial<ThemeTweaks>, opts?: { xfade?: boolean; persist?: boolean }): void {
  const { xfade = false, persist = true } = opts ?? {};
  currentTweaks = { ...currentTweaks, ...partial };

  if (partial.fontPairing !== undefined) ensurePairingFonts(currentTweaks.fontPairing);
  if (partial.productName !== undefined) applyWordmarkOverride(currentTweaks.productName);

  if (xfade) {
    const root = document.documentElement;
    root.classList.add('theme-xfade');
    window.setTimeout(() => root.classList.remove('theme-xfade'), 480);
  }

  writeVars(currentPreset);
  if (persist) persistTweaks();
  emit();
}

/** Back to the config defaults: Stream Teal, no tweaks. */
export function resetTheme(): void {
  currentTweaks = { ...DEFAULT_TWEAKS };
  try {
    window.localStorage.removeItem(TWEAKS_KEY);
  } catch {
    /* private mode */
  }
  applyWordmarkOverride(null);
  applyPreset(theme.preset);
}

/** React hook: current tweaks, re-renders on any theme change. */
export function useThemeTweaks(): ThemeTweaks {
  return useSyncExternalStore(subscribe, getTweaks);
}

/* ── Product-name override (navbar + footer wordmarks, no component edits) ── */

/**
 * Splits a product name for the two-tone wordmark at a word boundary or the
 * internal uppercase letter nearest the middle, then falls back to midpoint.
 */
export function splitWordmark(name: string): [string, string] {
  const n = (name.trim() || theme.name).slice(0, 24);
  const wordBreak = n.indexOf(' ');
  if (wordBreak > 0) return [n.slice(0, wordBreak + 1), n.slice(wordBreak + 1)];
  const mid = n.length / 2;
  let best = -1;
  for (let i = 1; i < n.length; i++) {
    if (/[A-Z]/.test(n[i]) && (best === -1 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  const at = best > 0 ? best : Math.ceil(n.length / 2);
  return [n.slice(0, at), n.slice(at)];
}

const WORDMARK_STYLE_ID = 'ds-wordmark-override';

/**
 * Re-skins the shared Navbar/Footer wordmarks + footer watermark without
 * touching those components: injects one <style> that swaps their text via
 * `content: var(--ds-wm-*)`. Default name (or null) removes the override.
 */
function applyWordmarkOverride(name: string | null): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const existing = document.getElementById(WORDMARK_STYLE_ID);
  const trimmed = name?.trim() ?? '';

  if (!trimmed || trimmed === theme.name) {
    existing?.remove();
    root.style.removeProperty('--ds-wm-a');
    root.style.removeProperty('--ds-wm-b');
    root.style.removeProperty('--ds-wm-full');
    return;
  }

  const [a, b] = splitWordmark(trimmed);
  root.style.setProperty('--ds-wm-a', JSON.stringify(a));
  root.style.setProperty('--ds-wm-b', JSON.stringify(b));
  root.style.setProperty('--ds-wm-full', JSON.stringify(trimmed));

  if (!existing) {
    const style = document.createElement('style');
    style.id = WORDMARK_STYLE_ID;
    style.textContent = `
header a[aria-label$="- home"] > span.font-display,
footer a[aria-label$="- home"] > span.font-display { font-size: 0 !important; }
header a[aria-label$="- home"] > span.font-display::before,
footer a[aria-label$="- home"] > span.font-display::before {
  content: var(--ds-wm-a); color: var(--ink-1);
  font-size: var(--ds-wm-size, 1.05rem); letter-spacing: -0.02em;
}
header a[aria-label$="- home"] > span.font-display::after,
footer a[aria-label$="- home"] > span.font-display::after {
  content: var(--ds-wm-b); color: var(--brand);
  font-size: var(--ds-wm-size, 1.05rem); letter-spacing: -0.02em;
}
footer a[aria-label$="- home"] > span.font-display { --ds-wm-size: 1.125rem; }
footer > div[aria-hidden="true"]:last-child { font-size: 0 !important; }
footer > div[aria-hidden="true"]:last-child::before {
  content: var(--ds-wm-full); font-size: clamp(4rem, 14vw, 11rem);
}`;
    document.head.appendChild(style);
  }
}
