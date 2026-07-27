import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Clapperboard, Copy, RotateCcw, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import theme, {
  applyPreset,
  applyTweaks,
  brandHexFromHue,
  FONT_PAIRINGS,
  FONT_PAIRING_NAMES,
  hueFromHex,
  preloadPairingFonts,
  resetTheme,
  splitWordmark,
  THEME_PRESETS,
  THEME_PRESET_NAMES,
  useThemePreset,
  useThemeTweaks,
} from '@/theme.config';
import type { FontPairingName, ThemePresetName, ThemeTweaks } from '@/theme.config';
import { Slider } from '@/components/ui/slider';
import SectionHeading from '@/components/SectionHeading';
import RingMark from '@/components/RingMark';
import StreamRow from '@/components/StreamRow';
import GlassCard from '@/components/GlassCard';
import Chip from '@/components/Chip';
import { GhostButton, PrimaryButton } from '@/components/Buttons';
import { ControlFlash } from '@/pages/brand/shared';
import { copyWithToast, EASE_EXPO } from '@/pages/brand/utils';
import { asset } from '@/lib/asset';

export type PlaygroundKey = 'preset' | 'name' | 'radius' | 'glow' | 'fonts';

const SLIDER_SKIN = cn(
  '[&_[data-slot=slider-track]]:h-1.5 [&_[data-slot=slider-track]]:bg-[var(--line)] [&_[data-slot=slider-track]]:rounded-full',
  '[&_[data-slot=slider-range]]:bg-brand',
  '[&_[data-slot=slider-thumb]]:size-4 [&_[data-slot=slider-thumb]]:border-brand [&_[data-slot=slider-thumb]]:bg-bg-0',
  '[&_[data-slot=slider-thumb]]:shadow-glow-brand [&_[data-slot=slider-thumb]]:ring-brand/40',
);

interface PlaygroundProps {
  /** control currently lit up from the "one-file rebrand" code card */
  highlight: PlaygroundKey | null;
  onHighlight: (key: PlaygroundKey | null) => void;
}

/** Labeled control wrapper - glows when the config snippet points at it. */
function Control({
  id,
  k,
  label,
  readout,
  highlight,
  onHighlight,
  flash,
  children,
}: {
  id: string;
  k: PlaygroundKey;
  label: string;
  readout?: ReactNode;
  highlight: PlaygroundKey | null;
  onHighlight: (key: PlaygroundKey | null) => void;
  flash: number;
  children: ReactNode;
}) {
  const lit = highlight === k;
  return (
    <div
      id={id}
      data-control={k}
      onMouseEnter={() => onHighlight(k)}
      onMouseLeave={() => onHighlight(null)}
      className={cn(
        'relative rounded-card border p-4 transition-[border-color,box-shadow,background-color] duration-300',
        lit ? 'border-[rgba(var(--brand-rgb),0.6)] bg-[var(--surface-glass-2)] shadow-glow-brand' : 'border-line',
      )}
    >
      <ControlFlash pulse={flash} />
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <span className="font-mono text-[0.6875rem] uppercase tracking-[0.22em] text-ink-3">{label}</span>
        {readout}
      </div>
      {children}
    </div>
  );
}

/** Section 2 - Live Theme Playground: controls (40%) + live mini-site preview (60%). */
export default function ThemePlayground({ highlight, onHighlight }: PlaygroundProps) {
  const reduced = useReducedMotion();
  const preset = useThemePreset();
  const tweaks = useThemeTweaks();

  const [status, setStatus] = useState('preset → stream-teal · #2EE6C8');
  const [pulse, setPulse] = useState(0); // preview RingMark celebratory spin
  const [flash, setFlash] = useState<{ id: string; n: number }>({ id: '', n: 0 }); // per-control radial flash

  useEffect(() => {
    preloadPairingFonts();
  }, []);

  /* derived control values (store is the source of truth) */
  const brandHex = tweaks.brandHex ?? THEME_PRESETS[preset].brand;
  const hue = hueFromHex(brandHex);
  const radius = tweaks.radiusPx ?? parseFloat(theme.radius);
  const glow = tweaks.glow ?? theme.glow;
  const pairing: FontPairingName = tweaks.fontPairing ?? 'grotesk-inter';
  const storeName = tweaks.productName ?? theme.name;

  /* product-name input keeps a local draft so it can be emptied mid-typing;
     `lastSent` distinguishes my own edits from external changes (e.g. reset) */
  const [nameDraft, setNameDraft] = useState(storeName);
  const [lastSent, setLastSent] = useState<string | null>(tweaks.productName);
  if (tweaks.productName !== lastSent) {
    setLastSent(tweaks.productName);
    const next = tweaks.productName ?? theme.name;
    if (nameDraft !== next) setNameDraft(next);
  }

  /* rAF-throttled tweak application for slider drags */
  const pendingRef = useRef<Partial<ThemeTweaks> | null>(null);
  const rafRef = useRef(0);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);
  const scheduleTweaks = (t: Partial<ThemeTweaks>) => {
    pendingRef.current = { ...pendingRef.current, ...t };
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        if (pendingRef.current) {
          applyTweaks(pendingRef.current, { xfade: false });
          pendingRef.current = null;
        }
      });
    }
  };

  const celebrate = (msg: string, controlId: string) => {
    setStatus(msg);
    setPulse((p) => p + 1);
    setFlash((f) => ({ id: controlId, n: f.id === controlId ? f.n + 1 : 1 }));
  };
  const flashFor = (id: string) => (flash.id === id ? flash.n : 0);

  /* ── control handlers ── */
  const pickPreset = (name: ThemePresetName) => {
    applyPreset(name);
    celebrate(`preset → ${name} · ${THEME_PRESETS[name].brand}`, 'pg-preset');
  };

  const hueChange = (h: number) => {
    const hex = brandHexFromHue(h);
    scheduleTweaks({ brandHex: hex });
    setStatus(`hue → ${h}° · ${hex}`);
  };
  const hueCommit = (h: number) => {
    const hex = brandHexFromHue(h);
    applyTweaks({ brandHex: hex }, { xfade: true });
    celebrate(`hue → ${h}° · ${hex}`, 'pg-hue');
  };

  const nameChange = (v: string) => {
    const next = v.slice(0, 24);
    setNameDraft(next);
    setLastSent(next.trim() ? next : null);
    applyTweaks({ productName: next.trim() ? next : null }, { xfade: false });
    celebrate(`name → ${next.trim() || theme.name}`, 'pg-name');
  };

  const radiusChange = (r: number) => {
    scheduleTweaks({ radiusPx: r });
    setStatus(`radius → ${r}px`);
  };
  const radiusCommit = (r: number) => {
    applyTweaks({ radiusPx: r }, { xfade: true });
    celebrate(`radius → ${r}px`, 'pg-radius');
  };

  const glowChange = (g: number) => {
    scheduleTweaks({ glow: g });
    setStatus(`glow → ${g.toFixed(2)}`);
  };
  const glowCommit = (g: number) => {
    applyTweaks({ glow: g }, { xfade: true });
    celebrate(`glow → ${g.toFixed(2)}`, 'pg-glow');
  };

  const pickPairing = (key: FontPairingName) => {
    applyTweaks({ fontPairing: key === 'grotesk-inter' ? null : key }, { xfade: true });
    celebrate(`font → ${FONT_PAIRINGS[key].label}`, 'pg-fonts');
  };

  const resetAll = () => {
    resetTheme();
    celebrate(`reset → stream-teal · ${THEME_PRESETS['stream-teal'].brand}`, 'pg-preset');
  };

  const [wmA, wmB] = splitWordmark(storeName);

  return (
    <section id="playground" className="relative py-[clamp(88px,12vw,152px)]">
      <div className="mx-auto max-w-content px-6 md:px-10">
        <SectionHeading
          eyebrow="// LIVE PLAYGROUND"
          title="Flip it. The whole site follows."
          lede="Every control mutates real CSS custom properties on :root - navbar included - with a 400ms cross-fade, and persists to localStorage."
        />

        <motion.div
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 40, filter: 'blur(8px)' }}
          whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          viewport={{ once: true, amount: 0.25 }}
          transition={{ duration: reduced ? 0.2 : 0.6, ease: EASE_EXPO }}
          className="glass-panel mx-auto mt-12 max-w-[1100px] rounded-stage p-5 md:p-7"
        >
          <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
            {/* ── controls (40%) ── */}
            <div className="flex flex-col gap-4">
              {/* 1 - preset cards */}
              <Control id="pg-preset" k="preset" label="Preset" highlight={highlight} onHighlight={onHighlight} flash={flashFor('pg-preset')}>
                <div role="radiogroup" aria-label="Theme preset" className="flex flex-col gap-2">
                  {THEME_PRESET_NAMES.map((name, i) => {
                    const p = THEME_PRESETS[name];
                    const active = name === preset && !tweaks.brandHex;
                    return (
                      <button
                        key={name}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => pickPreset(name)}
                        className={cn(
                          'border-beam group flex items-center gap-3 rounded-card border px-3.5 py-2.5 text-left',
                          'transition-[border-color,box-shadow,background-color] duration-300',
                          active
                            ? 'border-[rgba(var(--brand-rgb),0.55)] bg-[var(--surface-glass-2)] shadow-glow-brand'
                            : 'border-line bg-[var(--surface-glass)] hover:border-line-strong hover:bg-[var(--surface-glass-2)]',
                        )}
                      >
                        <span className="flex h-4 w-11 shrink-0 overflow-hidden rounded-full border border-line-strong">
                          {[p.brand, p.accent, p.warm].map((c, di) => (
                            <motion.span
                              key={c}
                              className="h-full w-1/3"
                              style={{ background: c }}
                              initial={reduced ? false : { scale: 0 }}
                              animate={{ scale: 1 }}
                              transition={{ delay: 0.3 + i * 0.08 + di * 0.05, type: 'spring', stiffness: 300, damping: 18 }}
                            />
                          ))}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-display text-[0.85rem] font-semibold text-ink-1">
                            {p.label}
                          </span>
                          <span className="block font-mono text-[0.625rem] tracking-[0.04em] text-ink-3">{name}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Control>

              {/* 2 - accent hue */}
              <Control
                id="pg-hue"
                k="preset"
                label="Accent hue"
                highlight={highlight}
                onHighlight={onHighlight}
                flash={flashFor('pg-hue')}
                readout={
                  <button
                    type="button"
                    onClick={() => copyWithToast(brandHex, 'Copied')}
                    title="Copy hex"
                    className="group/hex inline-flex items-center gap-1.5 font-mono text-[0.75rem] tracking-[0.04em] text-brand transition-colors hover:text-accent2"
                  >
                    {brandHex}
                    <Copy className="h-3 w-3 opacity-0 transition-opacity group-hover/hex:opacity-100" />
                  </button>
                }
              >
                <Slider
                  aria-label="Accent hue"
                  min={0}
                  max={360}
                  step={1}
                  value={[hue]}
                  onValueChange={([h]) => hueChange(h)}
                  onValueCommit={([h]) => hueCommit(h)}
                  className={SLIDER_SKIN}
                />
                <div
                  aria-hidden="true"
                  className="mt-2.5 h-1.5 rounded-full"
                  style={{
                    background:
                      'linear-gradient(90deg, #E94949, #E9C149, #79E949, #49E9CE, #49D6E9, #6969EC, #E949E9, #E94949)',
                  }}
                />
              </Control>

              {/* 3 - product name */}
              <Control id="pg-name" k="name" label="Product name" highlight={highlight} onHighlight={onHighlight} flash={flashFor('pg-name')}>
                <input
                  type="text"
                  value={nameDraft}
                  maxLength={24}
                  aria-label="Product name"
                  onChange={(e) => nameChange(e.target.value)}
                  className="w-full rounded-row border border-line bg-bg-0 px-3.5 py-2.5 font-display text-[0.95rem] font-semibold tracking-[-0.01em] text-ink-1 placeholder:text-ink-3"
                  placeholder={theme.name}
                />
                <p className="mt-2 font-mono text-[0.625rem] tracking-[0.04em] text-ink-3">
                  max 24 chars · wordmark, footer watermark + preview update live
                </p>
              </Control>

              {/* 4 - corner radius */}
              <Control
                id="pg-radius"
                k="radius"
                label="Corner radius"
                highlight={highlight}
                onHighlight={onHighlight}
                flash={flashFor('pg-radius')}
                readout={<span className="font-mono text-[0.75rem] tracking-[0.04em] text-brand">{radius}px</span>}
              >
                <Slider
                  aria-label="Corner radius"
                  min={8}
                  max={28}
                  step={1}
                  value={[radius]}
                  onValueChange={([r]) => radiusChange(r)}
                  onValueCommit={([r]) => radiusCommit(r)}
                  className={SLIDER_SKIN}
                />
              </Control>

              {/* 5 - glow */}
              <Control
                id="pg-glow"
                k="glow"
                label="Glow"
                highlight={highlight}
                onHighlight={onHighlight}
                flash={flashFor('pg-glow')}
                readout={<span className="font-mono text-[0.75rem] tracking-[0.04em] text-brand">{glow.toFixed(2)}</span>}
              >
                <Slider
                  aria-label="Glow intensity"
                  min={0}
                  max={1.5}
                  step={0.05}
                  value={[glow]}
                  onValueChange={([g]) => glowChange(g)}
                  onValueCommit={([g]) => glowCommit(g)}
                  className={SLIDER_SKIN}
                />
                <p className="mt-2 font-mono text-[0.625rem] tracking-[0.04em] text-ink-3">0 = flat / print mode</p>
              </Control>

              {/* 6 - font pairing */}
              <Control id="pg-fonts" k="fonts" label="Font pairing" highlight={highlight} onHighlight={onHighlight} flash={flashFor('pg-fonts')}>
                <div role="radiogroup" aria-label="Font pairing" className="flex flex-col gap-1.5">
                  {FONT_PAIRING_NAMES.map((key) => {
                    const fp = FONT_PAIRINGS[key];
                    const active = key === pairing;
                    return (
                      <button
                        key={key}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => pickPairing(key)}
                        className={cn(
                          'rounded-row border px-3 py-2 text-left font-body text-[0.8125rem] transition-[border-color,background-color,color] duration-200',
                          active
                            ? 'border-[rgba(var(--brand-rgb),0.55)] bg-[var(--surface-glass-2)] text-brand'
                            : 'border-line text-ink-2 hover:border-line-strong hover:text-ink-1',
                        )}
                      >
                        {fp.label}
                      </button>
                    );
                  })}
                </div>
              </Control>

              {/* status + reset */}
              <div className="mt-1 flex items-center justify-between gap-3 px-1">
                <p className="brandpg-status truncate font-mono text-[0.75rem] tracking-[0.04em] text-ink-3">{status}</p>
                <button
                  type="button"
                  onClick={resetAll}
                  className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[0.75rem] tracking-[0.04em] text-ink-3 underline decoration-line-strong underline-offset-4 transition-colors hover:text-brand"
                >
                  <RotateCcw className="h-3 w-3" />
                  Reset to Stream Teal
                </button>
              </div>
            </div>

            {/* ── live preview (60%) ── */}
            <div className="relative rounded-stage border border-line bg-bg-1 p-3 md:p-4">
              <div className="flex items-center gap-2 px-1 pb-3">
                <span className="font-mono text-[0.6875rem] tracking-[0.22em] text-ink-3">
                  LIVE PREVIEW - WHOLE SITE FOLLOWS
                </span>
              </div>

              <div className="overflow-hidden rounded-card border border-line bg-bg-0 shadow-card">
                {/* mini navbar */}
                <div className="flex items-center gap-2.5 border-b border-line bg-[var(--surface-glass)] px-3.5 py-2.5">
                  <RingMark size={18} />
                  <span className="font-display text-[0.8rem] font-semibold tracking-[-0.02em] text-ink-1">
                    {wmA}
                    <span className="text-brand">{wmB}</span>
                  </span>
                  <span className="ml-auto hidden items-center gap-1 sm:flex">
                    {['Features', 'Download', 'Brand'].map((l) => (
                      <span
                        key={l}
                        className={cn(
                          'relative rounded-full px-2.5 py-1 font-body text-[0.62rem]',
                          l === 'Brand' ? 'text-ink-1' : 'text-ink-2',
                        )}
                      >
                        {l}
                        {l === 'Brand' && (
                          <span className="absolute -bottom-[1px] left-1/2 h-[3px] w-[3px] -translate-x-1/2 rounded-full bg-brand shadow-glow-brand" />
                        )}
                      </span>
                    ))}
                  </span>
                  <span
                    className="rounded-chip px-2.5 py-1 font-display text-[0.6rem] font-semibold text-[var(--ink-on-brand)]"
                    style={{ backgroundImage: 'var(--grad-stream)' }}
                  >
                    Get the app
                  </span>
                </div>

                {/* mini hero */}
                <div className="relative border-b border-line px-4 py-7 text-center">
                  <div aria-hidden="true" className="absolute inset-0 opacity-25" style={{ background: 'var(--grad-warm)' }} />
                  <div className="relative">
                    <motion.div
                      key={pulse}
                      initial={pulse === 0 || reduced ? false : { rotate: 0 }}
                      animate={{ rotate: pulse === 0 || reduced ? 0 : 360 }}
                      transition={{ duration: 0.6, ease: EASE_EXPO }}
                      className="group inline-block"
                    >
                      <RingMark size={36} />
                    </motion.div>
                    <p className="mt-3 font-display text-[1.15rem] font-bold leading-[1.1] tracking-[-0.02em] text-ink-1">
                      Let&rsquo;s get you <span className="text-gradient">streaming</span>.
                    </p>
                    <div className="mt-4 flex items-center justify-center gap-2.5">
                      <PrimaryButton magnetic={false} className="px-3.5 py-2 text-[0.68rem]">
                        Get the app
                      </PrimaryButton>
                      <GhostButton playIcon={false} className="px-3.5 py-2 text-[0.68rem]">
                        Self-host
                      </GhostButton>
                    </div>
                  </div>
                </div>

                {/* mini rows + card */}
                <div className="flex flex-col gap-2.5 p-3.5">
                  <StreamRow
                    icon={<Zap className="h-4 w-4" />}
                    title="Orbital - 4K REMUX"
                    meta={[
                      { label: 'Instant', variant: 'instant' },
                      { label: 'cached', variant: 'dim' },
                    ]}
                    size="38 GB"
                    href={asset('download')}
                    className="px-3.5 py-3"
                  />
                  <StreamRow
                    icon={<Clapperboard className="h-4 w-4" />}
                    title="Ember Road - 1080p"
                    meta={[
                      { label: 'Instant', variant: 'instant' },
                      { label: 'RD', variant: 'dim' },
                    ]}
                    size="8 GB"
                    href={asset('download')}
                    className="px-3.5 py-3"
                  />
                  <GlassCard beam={false} className="flex items-center justify-between gap-3 p-3.5 hover:-translate-y-0">
                    <span className="min-w-0">
                      <span className="block truncate font-display text-[0.85rem] font-semibold text-ink-1">
                        The Last Relay
                      </span>
                      <span className="block font-mono text-[0.625rem] tracking-[0.04em] text-ink-3">
                        2h 14m · continue S01:E04
                      </span>
                    </span>
                    <Chip variant="warm">8.7</Chip>
                  </GlassCard>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
