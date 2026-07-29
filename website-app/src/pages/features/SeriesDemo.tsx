import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EASE_EXPO, StreamBar, Stage } from './shared';
import { asset } from '@/lib/asset';

interface Episode {
  n: string;
  title: string;
  img: string;
  /** vary the CSS crop so reused posters read as different stills */
  pos: string;
  progress: number;
  watched?: boolean;
}

const EPISODES: Episode[] = [
  { n: 'E01', title: 'The Signal', img: asset('poster-02.jpg'), pos: 'center 20%', progress: 1, watched: true },
  { n: 'E02', title: 'Static Bloom', img: asset('poster-04.jpg'), pos: 'center 35%', progress: 1, watched: true },
  { n: 'E03', title: 'Night Current', img: asset('poster-07.jpg'), pos: 'center 50%', progress: 0.96 },
  { n: 'E04', title: 'Night Relay', img: asset('poster-02.jpg'), pos: 'center 70%', progress: 0 },
  { n: 'E05', title: 'Relay', img: asset('poster-04.jpg'), pos: 'center 85%', progress: 0 },
];

const RING_R = 24;
const RING_C = 2 * Math.PI * RING_R;

/**
 * Chapter 7 demo - episode rail: draggable rail of stills with resume bars +
 * watched stamps; "S01 E03 ends" triggers the auto-play-next countdown overlay.
 */
export default function SeriesDemo() {
  const reduced = useReducedMotion();
  const wrapRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [maxDrag, setMaxDrag] = useState(0);
  const [upNext, setUpNext] = useState(false);
  const [countdown, setCountdown] = useState(2.5);
  const [playing, setPlaying] = useState(false);

  /* measure drag constraints */
  useEffect(() => {
    const measure = () => {
      const wrap = wrapRef.current;
      const rail = railRef.current;
      if (!wrap || !rail) return;
      setMaxDrag(Math.max(0, rail.scrollWidth - wrap.clientWidth));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  /* countdown driver while the overlay is up (5s real → 2.5s demo) */
  useEffect(() => {
    if (!upNext) return;
    setCountdown(2.5);
    if (reduced) return;
    const start = performance.now();
    const id = window.setInterval(() => {
      const left = Math.max(0, 2.5 - (performance.now() - start) / 1000);
      setCountdown(left);
      if (left <= 0) {
        window.clearInterval(id);
        setUpNext(false);
        setPlaying(true);
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [upNext, reduced]);

  return (
    <Stage className="flex flex-col gap-5 p-5">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-ink-3">
          continue · <span className="text-ink-1">Night Signal - S01</span>
        </p>
        <button
          type="button"
          onClick={() => {
            setPlaying(false);
            setUpNext(true);
          }}
          className="rounded-chip border border-line-strong bg-[var(--surface-glass)] px-3 py-1.5 font-mono text-[0.6875rem] tracking-[0.04em] text-brand transition-colors duration-150 hover:bg-[var(--surface-glass-2)]"
        >
          S01 E03 ends ▸
        </button>
      </div>

      {/* draggable episode rail */}
      <div ref={wrapRef} className="overflow-hidden">
        <motion.div
          ref={railRef}
          drag={reduced ? false : 'x'}
          dragConstraints={{ left: -maxDrag, right: 0 }}
          className={cn('flex w-max gap-4', !reduced && 'cursor-grab active:cursor-grabbing')}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.3 }}
          variants={{ hidden: {}, show: { transition: { staggerChildren: reduced ? 0.02 : 0.08 } } }}
        >
          {EPISODES.map((ep) => (
            <motion.article
              key={ep.n}
              variants={{
                hidden: reduced ? { opacity: 0 } : { opacity: 0, y: 28 },
                show: { opacity: 1, y: 0, transition: { duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO } },
              }}
              className="relative w-[212px] shrink-0 overflow-hidden rounded-card border border-line bg-bg-2"
            >
              <div className="relative">
                <img
                  src={ep.img}
                  alt={`${ep.n} - ${ep.title} still`}
                  loading="lazy"
                  draggable={false}
                  className="aspect-video w-full object-cover"
                  style={{ objectPosition: ep.pos }}
                />
                {ep.watched && (
                  <motion.span
                    initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 1.6 }}
                    whileInView={{ opacity: 1, scale: 1 }}
                    viewport={{ once: true }}
                    transition={{ type: 'spring', stiffness: 260, damping: 16, delay: 0.35 }}
                    className="absolute right-2 top-2 flex items-center gap-1 rounded-chip border border-line bg-bg-0/85 px-2 py-0.5 font-mono text-[0.5625rem] tracking-[0.1em] text-brand shadow-glow-brand backdrop-blur-sm"
                  >
                    <Check className="h-3 w-3" />
                    WATCHED
                  </motion.span>
                )}
                {playing && ep.n === 'E04' && (
                  <span className="absolute right-2 top-2 flex items-center gap-1 rounded-chip border border-line bg-bg-0/85 px-2 py-0.5 font-mono text-[0.5625rem] tracking-[0.1em] text-accent2 backdrop-blur-sm">
                    <Play className="h-3 w-3 fill-current" />
                    PLAYING
                  </span>
                )}

                {/* auto-play-next overlay */}
                <AnimatePresence>
                  {upNext && ep.n === 'E04' && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.25 }}
                      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1.5 bg-[rgba(var(--bg-0-rgb),0.86)] backdrop-blur-sm"
                    >
                      <div className="relative h-[60px] w-[60px]">
                        <svg viewBox="0 0 60 60" className="h-full w-full -rotate-90">
                          <circle cx="30" cy="30" r={RING_R} fill="none" stroke="var(--line)" strokeWidth="2.5" />
                          <motion.circle
                            cx="30"
                            cy="30"
                            r={RING_R}
                            fill="none"
                            stroke="var(--brand)"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeDasharray={RING_C}
                            initial={{ strokeDashoffset: RING_C }}
                            animate={{ strokeDashoffset: 0 }}
                            transition={{ duration: reduced ? 0.3 : 2.5, ease: 'linear' }}
                          />
                        </svg>
                        <span className="absolute inset-0 flex items-center justify-center font-mono text-[0.75rem] text-brand">
                          {Math.ceil(countdown)}
                        </span>
                      </div>
                      <p className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-ink-3">up next</p>
                      <p className="px-2 text-center text-[0.8125rem] font-medium leading-tight text-ink-1">
                        E04 - Night Relay
                      </p>
                      <div className="mt-1 flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setUpNext(false);
                            setPlaying(true);
                          }}
                          className="rounded-chip px-2.5 py-1 font-mono text-[0.625rem] text-[var(--ink-on-brand)]"
                          style={{ backgroundImage: 'var(--grad-stream)' }}
                        >
                          Play now
                        </button>
                        <button
                          type="button"
                          onClick={() => setUpNext(false)}
                          className="rounded-chip border border-line-strong px-2.5 py-1 font-mono text-[0.625rem] text-ink-2 transition-colors hover:bg-[var(--surface-glass-2)]"
                        >
                          Cancel
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <div className="p-3">
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <p className="font-mono text-[0.625rem] tracking-[0.08em] text-accent2">{ep.n}</p>
                  <p className="truncate text-[0.8125rem] font-medium text-ink-1">{ep.title}</p>
                </div>
                <StreamBar value={ep.progress} inView delay={0.15} />
              </div>
            </motion.article>
          ))}
        </motion.div>
      </div>

      <p className="font-mono text-[0.6875rem] tracking-[0.04em] text-ink-3">
        drag the rail · end an episode and the next one rolls in 5… 4… 3…
      </p>
    </Stage>
  );
}
