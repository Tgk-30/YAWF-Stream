import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion, useScroll, useTransform } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import Chip from '@/components/Chip';
import { POSTER_META } from './data';
import { SPRING_UI, Stage } from './shared';
import { asset } from '@/lib/asset';

interface Peek {
  i: number;
  x: number;
  y: number;
}

/**
 * Chapter 1 demo - "Poster currents": the real Discover screenshot in a mini
 * browser frame (parallax-zoom scrubbed through the chapter) + a live poster
 * marquee strip; hovering a poster pauses the flow and opens a detail popover.
 */
export default function DiscoverDemo() {
  const reduced = useReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);
  const [peek, setPeek] = useState<Peek | null>(null);
  const closeTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  /* screenshot parallax-zoom 1 → 1.05 scrubbed through the chapter */
  const { scrollYProgress } = useScroll({ target: stageRef, offset: ['start end', 'end start'] });
  const zoom = useTransform(scrollYProgress, [0, 1], [1, 1.05]);

  const openPeek = (i: number, el: HTMLElement) => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    const stage = stageRef.current;
    if (!stage) return;
    const r = el.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    /* keep the 224px-wide popover inside the stage */
    const rawX = r.left - sr.left + r.width / 2;
    const x = Math.min(Math.max(rawX, 120), sr.width - 120);
    setPeek({ i, x, y: r.top - sr.top - 10 });
  };

  const scheduleClose = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setPeek(null), 140);
  };

  const posters = [...POSTER_META, ...POSTER_META];
  const meta = peek ? POSTER_META[peek.i % POSTER_META.length] : null;

  return (
    <Stage className="flex flex-col p-0">
      <div ref={stageRef} className="relative flex min-h-[420px] flex-col">
        {/* mini browser frame - real app screenshot, 60% of stage height */}
        <div className="relative h-[258px] shrink-0 overflow-hidden border-b border-line">
          <div className="absolute inset-x-0 top-0 z-10 flex h-8 items-center gap-1.5 border-b border-line bg-bg-2/90 px-3 backdrop-blur-sm">
            <span className="h-2 w-2 rounded-full bg-[rgba(var(--brand-rgb),0.6)]" />
            <span className="h-2 w-2 rounded-full bg-[rgba(var(--accent-rgb),0.6)]" />
            <span className="h-2 w-2 rounded-full bg-[rgba(var(--warm-rgb),0.6)]" />
            <span className="mx-auto flex h-5 w-1/2 items-center justify-center rounded bg-bg-0 font-mono text-[0.625rem] tracking-[0.04em] text-ink-3">
              debridstreamer.local/discover
            </span>
            <span className="w-8" />
          </div>
          <motion.img
            src={asset('discover-desktop.png')}
            alt="YAWF Stream Discover screen"
            loading="lazy"
            draggable={false}
            className="h-full w-full object-cover object-top"
            style={reduced ? undefined : { scale: zoom }}
          />
        </div>

        {/* live poster strip */}
        <div className="relative flex-1">
          <div className="marquee flex h-full items-center" style={{ ['--marquee-duration' as string]: '46s' }}>
            <div className="marquee-track gap-3 px-3">
              {posters.map((m, i) => (
                <div
                  key={`${m.src}-${i}`}
                  className="w-[92px] shrink-0"
                  onPointerEnter={(e) => openPeek(i, e.currentTarget)}
                  onPointerLeave={scheduleClose}
                >
                  <div className="overflow-hidden rounded-lg border border-line transition-[transform,box-shadow] duration-300 ease-expo hover:scale-[1.06] hover:border-line-strong hover:shadow-glow-brand">
                    <img src={m.src} alt={m.title} loading="lazy" draggable={false} className="aspect-[2/3] w-full object-cover" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <p className="pointer-events-none absolute bottom-2 right-3 font-mono text-[0.625rem] tracking-[0.04em] text-ink-3">
            hover a poster - detail pages peek through
          </p>
        </div>

        {/* detail-page peek popover (stage-level so the marquee mask never clips it) */}
        <AnimatePresence>
          {peek && meta && (
            <div
              className="absolute z-20 -translate-x-1/2 -translate-y-full"
              style={{ left: peek.x, top: peek.y }}
              onPointerEnter={() => {
                if (closeTimer.current) {
                  window.clearTimeout(closeTimer.current);
                  closeTimer.current = null;
                }
              }}
              onPointerLeave={scheduleClose}
            >
              <motion.div
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 4 }}
                transition={reduced ? { duration: 0.2 } : SPRING_UI}
                className="glass-panel w-56 rounded-card p-4 shadow-card"
              >
                <p className="display-s text-[0.95rem]">{meta.title}</p>
                <div className="mt-2 flex items-center gap-2">
                  <span className="font-mono text-[0.6875rem] text-ink-3">{meta.year}</span>
                  <Chip variant="warm">{meta.rating.toFixed(1)}</Chip>
                </div>
                <p className="mt-2 font-mono text-[0.6875rem] tracking-[0.04em] text-accent2">{meta.genre}</p>
                <p className="mt-2 text-[0.8rem] leading-[1.55] text-ink-2">{meta.synopsis}</p>
                <div className="group/more relative mt-3 w-fit">
                  <button
                    type="button"
                    className="flex items-center gap-1.5 rounded-chip border border-line-strong px-2.5 py-1 font-mono text-[0.6875rem] text-brand transition-colors hover:bg-[var(--surface-glass-2)]"
                  >
                    More info
                    <ArrowRight className="h-3 w-3" />
                  </button>
                  <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-bg-2 px-2 py-1 font-mono text-[0.625rem] text-ink-2 opacity-0 transition-opacity duration-150 group-hover/more:opacity-100">
                    That&apos;s in the app →
                  </span>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    </Stage>
  );
}
