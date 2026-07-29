import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { MonitorPlay, Play } from 'lucide-react';
import { EASE_EXPO, Stage } from './shared';
import { asset } from '@/lib/asset';

const DURATION = 102 * 60 + 4; // 1:42:04
const TICKS = [0.12, 0.34, 0.55, 0.78];
const THUMBS = [asset('poster-02.jpg'), asset('poster-04.jpg'), asset('poster-06.jpg'), asset('poster-07.jpg')];
const HANDOFF = ['VLC', 'IINA'];

function fmt(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/**
 * Chapter 6 demo - "The seek test": mock player chrome over a blurred scene.
 * Hover the timeline for thumbnail previews; click to seek instantly (buffered
 * bar stream-fills, INSTANT badge flashes); VLC / IINA handoff toasts.
 */
export default function PlayerDemo() {
  const reduced = useReducedMotion();
  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [playhead, setPlayhead] = useState(0.32);
  const [buffered, setBuffered] = useState(0.47);
  const [flash, setFlash] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const fraction = (e: { clientX: number }): number => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  const seek = (e: { clientX: number }) => {
    const f = fraction(e);
    setPlayhead(f);
    setBuffered(Math.min(1, f + 0.06 + Math.random() * 0.05));
    if (!reduced) {
      setFlash((n) => n + 1);
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(0), 950);
    }
  };

  const handoff = (app: string) => {
    setToast(`sent to ${app} →`);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1600);
  };

  const snap = reduced
    ? { duration: 0.15 }
    : ({ type: 'spring', stiffness: 520, damping: 40 } as const);

  return (
    <Stage className="p-0">
      <div className="relative flex min-h-[420px] flex-col justify-between overflow-hidden rounded-stage">
        {/* scene backdrop - poster-06 blurred 40% */}
        <img src={asset('poster-06.jpg')} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-cover opacity-40 blur-[6px]" />
        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(var(--bg-0-rgb),0.55), rgba(var(--bg-0-rgb),0.82))' }} />

        {/* top chrome: now playing + handoff chips */}
        <div className="relative z-10 flex items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-2.5">
            <MonitorPlay className="h-4 w-4 text-brand" />
            <p className="font-mono text-[0.6875rem] tracking-[0.04em] text-ink-2">
              now playing · <span className="text-ink-1">The Last Relay</span>
            </p>
          </div>
          <div className="flex gap-1.5">
            {HANDOFF.map((app) => (
              <button
                key={app}
                type="button"
                onClick={() => handoff(app)}
                className="rounded-chip border border-line-strong bg-[var(--surface-glass)] px-2.5 py-1 font-mono text-[0.625rem] tracking-[0.06em] text-brand transition-colors duration-150 hover:bg-[var(--surface-glass-2)]"
              >
                {app} ↗
              </button>
            ))}
          </div>
        </div>

        {/* center play state */}
        <div className="relative z-10 flex items-center justify-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full border border-line-strong bg-[var(--surface-glass)] backdrop-blur-sm">
            <Play className="ml-0.5 h-5 w-5 fill-brand text-brand" />
          </div>
        </div>

        {/* bottom: spec readout + timeline */}
        <div className="relative z-10 p-4 pt-0">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <p className="font-mono text-[0.625rem] tracking-[0.06em] text-ink-3">
              4K · HEVC · MKV · 10-bit · <span className="text-accent2">{fmt(playhead * DURATION)}</span> / {fmt(DURATION)}
            </p>
            <AnimatePresence>
              {flash > 0 && (
                <motion.span
                  key={flash}
                  initial={{ opacity: 0, scale: 0.7 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                  className="rounded-chip border border-line px-2 py-0.5 font-mono text-[0.625rem] tracking-[0.12em] text-accent2 shadow-glow-accent"
                >
                  INSTANT
                </motion.span>
              )}
            </AnimatePresence>
          </div>

          {/* timeline */}
          <div
            ref={trackRef}
            role="slider"
            aria-label="Seek"
            aria-valuenow={Math.round(playhead * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            tabIndex={0}
            onPointerMove={(e) => setHover(fraction(e))}
            onPointerLeave={() => setHover(null)}
            onClick={seek}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') setPlayhead((p) => Math.min(1, p + 0.02));
              if (e.key === 'ArrowLeft') setPlayhead((p) => Math.max(0, p - 0.02));
            }}
            className="group/tl relative flex h-10 cursor-pointer items-end"
          >
            {/* hover thumbnail tooltip */}
            <AnimatePresence>
              {hover !== null && (
                <motion.div
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.92 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18, ease: EASE_EXPO }}
                  className="pointer-events-none absolute bottom-full z-20 mb-2 -translate-x-1/2"
                  style={{ left: `${hover * 100}%` }}
                >
                  <div className="w-[104px] overflow-hidden rounded-md border border-line-strong shadow-card">
                    <img src={THUMBS[Math.min(3, Math.floor(hover * 4))]} alt="" className="aspect-video w-full object-cover" />
                  </div>
                  <p className="mt-1 text-center font-mono text-[0.625rem] tracking-[0.04em] text-ink-1">{fmt(hover * DURATION)}</p>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="relative h-1.5 w-full rounded-full bg-line">
              {/* buffered */}
              <motion.div
                className="absolute inset-y-0 left-0 w-full origin-left rounded-full bg-[rgba(var(--brand-rgb),0.28)]"
                initial={{ scaleX: buffered }}
                animate={{ scaleX: buffered }}
                transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO }}
              />
              {/* played */}
              <motion.div
                className="absolute inset-y-0 left-0 w-full origin-left rounded-full"
                style={{ backgroundImage: 'var(--grad-stream)' }}
                initial={{ scaleX: playhead }}
                animate={{ scaleX: playhead }}
                transition={snap}
              />
              {/* chapter ticks */}
              {TICKS.map((t) => (
                <span key={t} className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-line-strong" style={{ left: `${t * 100}%` }} />
              ))}
              {/* playhead glow dot */}
              <motion.span
                className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand shadow-glow-brand"
                initial={{ left: `${playhead * 100}%` }}
                animate={{ left: `${playhead * 100}%` }}
                transition={snap}
              />
              {/* ring pulse at the drop point */}
              <AnimatePresence>
                {flash > 0 && (
                  <motion.span
                    key={`ring-${flash}`}
                    className="pointer-events-none absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-brand"
                    style={{ left: `${playhead * 100}%` }}
                    initial={{ scale: 0.3, opacity: 0.9 }}
                    animate={{ scale: 2.2, opacity: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.6, ease: 'easeOut' }}
                  />
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* handoff toast */}
        <AnimatePresence>
          {toast && (
            <motion.p
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.2 }}
              className="absolute bottom-16 right-4 z-20 rounded-chip border border-line bg-bg-2 px-3 py-1.5 font-mono text-[0.6875rem] tracking-[0.04em] text-accent2 shadow-card"
            >
              {toast}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </Stage>
  );
}
