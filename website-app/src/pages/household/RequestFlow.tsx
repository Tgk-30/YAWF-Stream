import { memo, useEffect, useRef, useState } from 'react';
import { AnimatePresence, animate, motion, useReducedMotion } from 'framer-motion';
import { Check, HeartPulse, RotateCcw, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import Chip from '@/components/Chip';
import { PlayGlyph } from '@/components/Buttons';
import { posterSrc } from '@/pages/household/data';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

type Phase = 'idle' | 'pending' | 'approved' | 'declined';

/* ── tiny animated stat bits ───────────────────────────────────────────── */

function CountUp({ to, suffix = '' }: { to: number; suffix?: string }) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    const controls = animate(0, to, { duration: 0.8, ease: 'easeOut', onUpdate: (v) => setVal(Math.round(v)) });
    return () => controls.stop();
  }, [to]);
  return (
    <>
      {val}
      {suffix}
    </>
  );
}

/** Tiny looping sparkline bars - isolated perpetual animation. */
const Sparkline = memo(function Sparkline() {
  const reduced = useReducedMotion();
  const bars = [0.4, 0.75, 0.5, 0.95, 0.6];
  return (
    <span className="ml-1 inline-flex h-3 items-end gap-[2px]" aria-hidden="true">
      {bars.map((h, i) => (
        <motion.span
          key={i}
          className="w-[3px] rounded-sm bg-accent2"
          style={{ height: `${h * 100}%`, transformOrigin: 'bottom' }}
          animate={reduced ? undefined : { scaleY: [1, 0.45, 1] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut', delay: i * 0.18 }}
        />
      ))}
    </span>
  );
});

function StatChip({ label, children, tone = 'accent' }: { label: string; children?: React.ReactNode; tone?: 'accent' | 'ok' }) {
  return (
    <span className="inline-flex items-center rounded-chip border border-line bg-[var(--surface-glass)] px-2.5 py-1 font-mono text-[0.6875rem] tracking-[0.04em] text-ink-2">
      {label}:{' '}
      <span className={tone === 'ok' ? 'text-brand' : 'text-accent2'}>{children}</span>
    </span>
  );
}

/* ── the demo ──────────────────────────────────────────────────────────── */

/**
 * Section 4 - Title requests: replayable review flow.
 * Kids pane sends a request → it travels to the admin inbox with server
 * health stats → approve morphs the button to "Now available ▶", decline
 * shows a gentle note. Keyboard-operable; "reset demo" replays.
 */
export default function RequestFlow() {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>('idle');
  const [queueGone, setQueueGone] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  const request = () => {
    if (phase !== 'idle') return;
    setPhase('pending');
  };

  const resolve = (outcome: 'approved' | 'declined') => {
    if (phase !== 'pending') return;
    setPhase(outcome);
    timerRef.current = window.setTimeout(() => setQueueGone(true), 1100);
  };

  const reset = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setPhase('idle');
    setQueueGone(false);
  };

  const showCard = phase !== 'idle' && !queueGone;

  return (
    <section className="bg-bg-1 py-[clamp(88px,12vw,152px)]">
      <div className="mx-auto grid grid-cols-1 max-w-content items-center gap-12 px-6 md:px-10 lg:grid-cols-2">
        {/* left - the flow demo */}
        <motion.div
          className="glass-panel rounded-stage p-4 md:p-5"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 40, filter: 'blur(8px)' }}
          whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: reduced ? 0.2 : 0.6, ease: EASE_EXPO }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {/* Pane A - Kids profile */}
            <div className="rounded-card border border-line bg-bg-0/60 p-4">
              <p className="mb-3 font-mono text-[0.6875rem] uppercase tracking-[0.18em] text-ink-3">Kids profile</p>
              <div className="overflow-hidden rounded-md border border-line">
                <img
                  src={posterSrc(7)}
                  alt="Orbital - invented sci-fi puzzle poster"
                  loading="lazy"
                  draggable={false}
                  className="aspect-[2/3] w-full object-cover"
                />
              </div>
              <div className="mt-3 flex items-center justify-between gap-2">
                <div>
                  <p className="font-display text-[0.95rem] font-semibold uppercase tracking-[0.02em] text-ink-1">
                    Orbital
                  </p>
                  <p className="font-mono text-[0.6875rem] tracking-[0.04em] text-ink-3">sci-fi puzzle · 13+</p>
                </div>
                <Chip variant="outline" className="px-2 py-0.5 text-[0.625rem]">
                  not in library
                </Chip>
              </div>

              {/* the morphing action */}
              <div className="mt-4 min-h-[44px]">
                <AnimatePresence mode="wait">
                  {phase === 'idle' && (
                    <motion.button
                      key="request"
                      type="button"
                      onClick={request}
                      className="group inline-flex w-full items-center justify-center gap-2.5 rounded-chip px-4 py-3 font-display text-[0.85rem] font-semibold leading-none text-[var(--ink-on-brand)] shadow-glow-brand transition-[transform,box-shadow] duration-200 ease-expo hover:scale-[1.02] active:scale-[0.97]"
                      style={{ backgroundImage: 'var(--grad-stream)' }}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.3, ease: EASE_EXPO }}
                    >
                      Request this title
                      <PlayGlyph />
                    </motion.button>
                  )}
                  {phase === 'pending' && (
                    <motion.span
                      key="requested"
                      className="inline-flex w-full items-center justify-center gap-2 rounded-chip border border-line-strong bg-[var(--surface-glass)] px-4 py-3 font-display text-[0.85rem] font-semibold text-ink-2"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.3, ease: EASE_EXPO }}
                    >
                      Requested ✓
                    </motion.span>
                  )}
                  {phase === 'approved' && (
                    <motion.span
                      key="available"
                      className="relative inline-flex w-full items-center justify-center gap-2 overflow-hidden rounded-chip px-4 py-3 font-display text-[0.85rem] font-semibold text-[var(--ink-on-brand)] shadow-glow-brand"
                      style={{ backgroundImage: 'var(--grad-stream)' }}
                      initial={{ opacity: 0, scale: 0.92 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.35, ease: EASE_EXPO }}
                    >
                      {/* one-time stream-fill sweep */}
                      <motion.span
                        aria-hidden="true"
                        className="absolute inset-0"
                        style={{ background: 'linear-gradient(100deg, transparent 25%, rgba(255,255,255,0.45) 50%, transparent 75%)' }}
                        initial={{ x: '-110%' }}
                        animate={{ x: '110%' }}
                        transition={{ duration: reduced ? 0.2 : 0.8, ease: EASE_EXPO, delay: 0.1 }}
                      />
                      Now available
                      <PlayGlyph />
                    </motion.span>
                  )}
                  {phase === 'declined' && (
                    <motion.span
                      key="declined"
                      className="inline-flex w-full items-center justify-center gap-2 rounded-chip border border-[rgba(var(--warm-rgb),0.4)] bg-[var(--surface-glass)] px-4 py-3 font-display text-[0.85rem] font-semibold text-warm"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.3, ease: EASE_EXPO }}
                    >
                      Declined - ask Alex
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
            </div>

            {/* Pane B - Admin inbox */}
            <div className="flex flex-col rounded-card border border-line bg-bg-0/60 p-4">
              <div className="mb-3 flex items-center justify-between">
                <p className="font-mono text-[0.6875rem] uppercase tracking-[0.18em] text-ink-3">Admin inbox</p>
                <span
                  className={cn(
                    'flex h-5 min-w-5 items-center justify-center rounded-full px-1 font-mono text-[0.625rem]',
                    showCard ? 'bg-[rgba(var(--warm-rgb),0.15)] text-warm' : 'bg-[var(--surface-glass)] text-ink-3',
                  )}
                >
                  {showCard ? 1 : 0}
                </span>
              </div>

              <div className="relative flex-1">
                {/* empty state */}
                {!showCard && (
                  <div className="flex h-full min-h-[180px] flex-col items-center justify-center rounded-row border border-dashed border-line-strong px-3 text-center">
                    <p className="font-mono text-[0.6875rem] leading-[1.6] tracking-[0.04em] text-ink-3">
                      {queueGone ? 'all clear - nothing pending' : 'no pending requests'}
                    </p>
                  </div>
                )}

                {/* the traveling request card */}
                <AnimatePresence>
                  {showCard && (
                    <motion.div
                      key="request-card"
                      className="rounded-row border border-line bg-[var(--surface-glass)] p-3 backdrop-blur-sm"
                      initial={reduced ? { opacity: 0 } : { opacity: 0, x: -56, y: 28, scale: 0.92 }}
                      animate={
                        reduced
                          ? { opacity: 1 }
                          : { opacity: 1, x: [-56, -18, 0], y: [28, -12, 0], scale: 1 }
                      }
                      exit={{ opacity: 0, x: 24, transition: { duration: 0.3 } }}
                      transition={{ duration: 0.6, ease: EASE_EXPO, opacity: { duration: 0.3 } }}
                    >
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-[var(--warm)] bg-bg-2 font-display text-[0.6875rem] font-semibold text-ink-1">
                          K
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-body text-[0.8125rem] font-semibold leading-[1.4] text-ink-1">
                            Kids wants <span className="text-brand">Orbital</span>
                          </p>
                          <p className="font-mono text-[0.625rem] tracking-[0.04em] text-ink-3">just now</p>
                        </div>
                        {/* stamp */}
                        <AnimatePresence>
                          {(phase === 'approved' || phase === 'declined') && (
                            <motion.span
                              key="stamp"
                              className={cn(
                                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border',
                                phase === 'approved'
                                  ? 'border-[rgba(var(--brand-rgb),0.5)] bg-[rgba(var(--brand-rgb),0.12)] text-brand shadow-glow-brand'
                                  : 'border-[rgba(var(--warm-rgb),0.5)] bg-[rgba(var(--warm-rgb),0.1)] text-warm',
                              )}
                              initial={{ scale: 0, rotate: -18 }}
                              animate={{ scale: 1, rotate: 0 }}
                              exit={{ scale: 0 }}
                              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                            >
                              {phase === 'approved' ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </div>

                      {/* admin context strip */}
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        <StatChip label="server health" tone="ok">
                          good
                        </StatChip>
                        <StatChip label="sessions">
                          <CountUp to={2} />
                        </StatChip>
                        <StatChip label="bandwidth">
                          <span className="inline-flex items-center">
                            <CountUp to={34} suffix=" Mb/s" />
                            <Sparkline />
                          </span>
                        </StatChip>
                      </div>

                      {/* admin actions */}
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          onClick={() => resolve('approved')}
                          disabled={phase !== 'pending'}
                          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-chip px-3 py-2 font-display text-[0.75rem] font-semibold text-[var(--ink-on-brand)] transition-[transform,opacity] duration-200 hover:scale-[1.02] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
                          style={{ backgroundImage: 'var(--grad-stream)' }}
                        >
                          <Check className="h-3 w-3" />
                          Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => resolve('declined')}
                          disabled={phase !== 'pending'}
                          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-chip border border-line-strong bg-[var(--surface-glass)] px-3 py-2 font-display text-[0.75rem] font-semibold text-brand transition-[background-color,transform] duration-200 hover:bg-[var(--surface-glass-2)] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
                        >
                          <X className="h-3 w-3" />
                          Decline
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* admin hint */}
              <p className="mt-3 font-mono text-[0.625rem] leading-[1.5] tracking-[0.04em] text-ink-3">
                &quot;can the Pi handle another stream?&quot; - answered before approve.
              </p>
            </div>
          </div>

          {/* reset */}
          <div className="mt-4 flex justify-center">
            <button
              type="button"
              onClick={reset}
              disabled={phase === 'idle'}
              className="inline-flex items-center gap-1.5 font-mono text-[0.75rem] tracking-[0.04em] text-ink-3 transition-colors hover:text-brand disabled:pointer-events-none disabled:opacity-30"
            >
              <RotateCcw className="h-3 w-3" />
              reset demo
            </button>
          </div>
        </motion.div>

        {/* right - copy */}
        <div className="lg:order-first">
          <motion.p
            className="eyebrow"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true, amount: 0.8 }}
            transition={{ duration: reduced ? 0.2 : 0.6 }}
          >
            {'// REQUESTS'}
          </motion.p>
          <motion.h2
            className="display-m mt-4 font-display"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 32, filter: 'blur(8px)' }}
            whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            viewport={{ once: true, amount: 0.8 }}
            transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO }}
          >
            Kids ask. Admins decide.
          </motion.h2>
          <motion.p
            className="mt-5 max-w-[520px] font-body text-[1rem] leading-[1.7] text-ink-2"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.8 }}
            transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: 0.12 }}
          >
            Restricted profiles can request titles instead of adding them. Admins review from one inbox - with server
            health, active sessions, and bandwidth right there, so &quot;can the Pi handle another stream?&quot; is
            answered before you hit approve.
          </motion.p>
          <motion.div
            className="mt-7 flex flex-wrap gap-2.5"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.8 }}
            transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: 0.2 }}
          >
            <Chip variant="outline">request instead of add</Chip>
            <Chip variant="outline">one admin inbox</Chip>
            <Chip variant="outline">health stats in context</Chip>
          </motion.div>
          <motion.div
            className="mt-6 flex items-center gap-2 font-mono text-[0.75rem] tracking-[0.04em] text-ink-3"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.3 }}
          >
            <HeartPulse className="h-3.5 w-3.5 text-brand" />
            try the demo - approve and decline both work
          </motion.div>
        </div>
      </div>
    </section>
  );
}
