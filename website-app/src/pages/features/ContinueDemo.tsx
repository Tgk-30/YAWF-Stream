import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, animate, motion, useInView, useReducedMotion } from 'framer-motion';
import { Check, Download } from 'lucide-react';
import { EASE_EXPO, StreamBar, Stage } from './shared';
import { asset } from '@/lib/asset';

const RESUME = [
  { title: 'Night Signal', img: asset('poster-01.jpg'), meta: '42 min left', progress: 0.34 },
  { title: 'Orbital', img: asset('poster-03.jpg'), meta: '1:08 left', progress: 0.67 },
  { title: 'Ember Road', img: asset('poster-05.jpg'), meta: '18 min left', progress: 0.82 },
];

const STATS = [
  { value: 142, label: 'hours watched', tip: '142h ≈ 5.9 days. Worth it.' },
  { value: 38, label: 'films', tip: '38 openings, 38 endings.' },
  { value: 12, label: 'series', tip: '12 worlds visited.' },
  { value: 4, label: 'devices', tip: 'One server, every screen.' },
];

const IMPORT_LINES = [
  'night-signal.2024.2160p.mkv',
  'paper-harvest.2023.1080p.mkv',
  'orbital.2025.2160p.mkv',
  'the-clockwork-sea.2022.1080p.mkv',
  'ember-road.2023.2160p.mkv',
  'the-last-relay.2024.1080p.mkv',
];

/** expo count-up on scroll into view (1.2s) */
function Counter({ value }: { value: number }) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-15% 0px' });
  const [n, setN] = useState(0);

  useEffect(() => {
    if (!inView) return;
    if (reduced) {
      setN(value);
      return;
    }
    const controls = animate(0, value, {
      duration: 1.2,
      ease: EASE_EXPO,
      onUpdate: (v) => setN(Math.round(v)),
    });
    return () => controls.stop();
  }, [inView, value, reduced]);

  return <span ref={ref}>{n}</span>;
}

/**
 * Chapter 9 demo - "Your year in the dark": resume cards, animated stat
 * counters with playful tooltips, and a replayable IMDb / Letterboxd import.
 */
export default function ContinueDemo() {
  const reduced = useReducedMotion();
  const [run, setRun] = useState<{ source: string; id: number; count: number } | null>(null);

  const startImport = (source: string) => {
    setRun({ source, id: (run?.id ?? 0) + 1, count: source === 'IMDb' ? 214 : 186 });
  };

  return (
    <Stage className="flex flex-col gap-6 p-5">
      <div className="grid gap-6 sm:grid-cols-2">
        {/* resume cards */}
        <div className="flex flex-col gap-3">
          <p className="font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-ink-3">resume everywhere</p>
          {RESUME.map((r, i) => (
            <motion.div
              key={r.title}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.5 }}
              transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: i * 0.08 }}
              className="flex items-center gap-3 rounded-card border border-line bg-bg-1/70 p-2.5"
            >
              <img src={r.img} alt="" loading="lazy" draggable={false} className="h-16 w-11 shrink-0 rounded-md border border-line object-cover" />
              <div className="min-w-0 flex-1">
                <div className="mb-1.5 flex items-baseline justify-between gap-2">
                  <p className="truncate text-[0.875rem] font-medium text-ink-1">{r.title}</p>
                  <p className="shrink-0 font-mono text-[0.625rem] text-ink-3">{r.meta}</p>
                </div>
                <StreamBar value={r.progress} inView delay={0.2 + i * 0.1} />
              </div>
            </motion.div>
          ))}
        </div>

        {/* stats cluster */}
        <div className="grid grid-cols-2 content-start gap-3">
          {STATS.map((s, i) => (
            <motion.div
              key={s.label}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.5 }}
              transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: 0.1 + i * 0.07 }}
              className="group relative rounded-card border border-line bg-bg-1/70 p-4"
            >
              <p className="display-m font-display text-[1.6rem] text-brand">
                <Counter value={s.value} />
              </p>
              <p className="mt-1 font-mono text-[0.625rem] uppercase tracking-[0.1em] text-ink-3">{s.label}</p>
              <span className="pointer-events-none absolute -top-9 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-bg-2 px-2 py-1 font-mono text-[0.625rem] text-ink-2 opacity-0 shadow-card transition-opacity duration-150 group-hover:opacity-100">
                {s.tip}
              </span>
            </motion.div>
          ))}
        </div>
      </div>

      {/* import strip */}
      <div className="rounded-card border border-line bg-bg-1/70 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-ink-3">bring your history</span>
          {['IMDb', 'Letterboxd'].map((source) => (
            <button
              key={source}
              type="button"
              onClick={() => startImport(source)}
              className="border-beam flex items-center gap-1.5 rounded-chip border border-line-strong bg-[var(--surface-glass)] px-3 py-1.5 font-mono text-[0.6875rem] tracking-[0.04em] text-brand transition-colors duration-150 hover:bg-[var(--surface-glass-2)]"
            >
              <Download className="h-3 w-3" />
              Import from {source}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          {run && (
            <motion.ul
              key={run.id}
              className="mt-4 flex flex-col gap-1.5"
              initial="hidden"
              animate="show"
              exit={{ opacity: 0, transition: { duration: 0.15 } }}
              variants={{ hidden: {}, show: { transition: { staggerChildren: reduced ? 0.01 : 0.06 } } }}
            >
              {IMPORT_LINES.map((line) => (
                <motion.li
                  key={line}
                  variants={{
                    hidden: reduced ? { opacity: 0 } : { opacity: 0, x: -10 },
                    show: { opacity: 1, x: 0, transition: { duration: 0.25, ease: EASE_EXPO } },
                  }}
                  className="flex items-center gap-2 font-mono text-[0.6875rem] tracking-[0.02em] text-ink-3"
                >
                  <Check className="h-3 w-3 text-brand" />
                  {line}
                </motion.li>
              ))}
              <motion.li
                variants={{
                  hidden: { opacity: 0 },
                  show: { opacity: 1, transition: { duration: 0.3, delay: 0.15 } },
                }}
                className="mt-1 font-mono text-[0.75rem] tracking-[0.04em] text-accent2"
              >
                Imported {run.count} items ✓ <span className="text-ink-3">· from {run.source}</span>
              </motion.li>
            </motion.ul>
          )}
        </AnimatePresence>
      </div>
    </Stage>
  );
}
