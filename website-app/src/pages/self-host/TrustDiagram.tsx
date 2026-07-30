import { memo, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { motion, useInView, useReducedMotion } from 'framer-motion';
import { Box, KeyRound, Laptop, ShieldCheck, Smartphone, Tv } from 'lucide-react';
import { cn } from '@/lib/utils';
import RingMark from '@/components/RingMark';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(() => window.matchMedia('(min-width: 768px)').matches);
  useLayoutEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = () => setDesktop(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return desktop;
}

/** Measures the connector length so packets travel in px (transform-only). */
function useLength(vertical: boolean): [{ current: HTMLDivElement | null }, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [len, setLen] = useState(120);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setLen(vertical ? el.offsetHeight : el.offsetWidth);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [vertical]);
  return [ref, len];
}

/** Traveling packet dots along the connector - isolated perpetual loop. */
const Packets = memo(function Packets({ dist, vertical, count = 2, duration = 2.2 }: { dist: number; vertical: boolean; count?: number; duration?: number }) {
  const reduced = useReducedMotion();
  if (reduced) return null;
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <motion.span
          key={i}
          aria-hidden="true"
          className="absolute left-0 top-0 h-1.5 w-1.5 rounded-full bg-accent2 shadow-glow-accent"
          style={vertical ? { left: '50%', marginLeft: -3, top: 0 } : { top: '50%', marginTop: -3, left: 0 }}
          animate={vertical ? { y: [-6, dist + 6], opacity: [0, 1, 1, 0] } : { x: [-6, dist + 6], opacity: [0, 1, 1, 0] }}
          transition={{ duration, repeat: Infinity, ease: 'linear', delay: (i * duration) / count, times: [0, 0.12, 0.88, 1] }}
        />
      ))}
    </>
  );
});

/** The punchline: a key tries to cross B→C and bounces back (2.4s loop). */
const BlockedKey = memo(function BlockedKey({ dist, vertical, active }: { dist: number; vertical: boolean; active: boolean }) {
  const reduced = useReducedMotion();
  const stop = Math.max(0, dist * 0.68);
  const travel = vertical ? { y: [0, stop, 0] } : { x: [0, stop, 0] };
  return (
    <motion.div
      className="group/key absolute z-10"
      style={vertical ? { left: '50%', top: 0, marginLeft: -14 } : { top: '50%', left: 0, marginTop: -14 }}
      animate={active && !reduced ? travel : undefined}
      transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut', times: [0, 0.45, 1] }}
      tabIndex={0}
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-full border border-[rgba(var(--warm-rgb),0.5)] bg-bg-1 text-warm shadow-glow-warm">
        <KeyRound className="h-3.5 w-3.5" />
      </span>
      <span className="pointer-events-none absolute -top-2 left-1/2 z-10 -translate-x-1/2 -translate-y-full max-w-[calc(100vw-2rem)] whitespace-normal rounded-row sm:whitespace-nowrap border border-line bg-bg-1 px-2.5 py-1 font-mono text-[0.6875rem] tracking-[0.04em] text-ink-2 opacity-0 shadow-card transition-opacity duration-200 group-hover/key:opacity-100 group-focus-visible/key:opacity-100">
        encrypted at rest · never transmitted
      </span>
    </motion.div>
  );
});

interface ConnectorProps {
  label: string;
  /** draw delay (traces draw sequentially A→B then B→C) */
  delay: number;
  blocked?: boolean;
}

function Connector({ label, delay, blocked = false }: ConnectorProps) {
  const reduced = useReducedMotion();
  const desktop = useIsDesktop();
  const wrapRef = useRef<HTMLDivElement>(null);
  const vertical = !desktop;
  const [trackRef, len] = useLength(vertical);
  const inView = useInView(wrapRef, { once: true, amount: 0.8 });

  return (
    <div
      ref={wrapRef}
      className={cn(
        'relative flex shrink-0 items-center justify-center',
        vertical ? 'h-20 w-full flex-col' : 'h-16 min-w-[72px] flex-1 flex-col',
      )}
    >
      <span className="mb-1.5 whitespace-nowrap font-mono text-[0.6875rem] tracking-[0.14em] text-ink-3">
        {label}
      </span>
      <div ref={trackRef} className={cn('relative', vertical ? 'h-10 w-px' : 'h-px w-full')}>
        {/* the trace itself, drawn on entry */}
        <motion.span
          aria-hidden="true"
          className={cn('absolute bg-line-strong', vertical ? 'inset-y-0 left-0 w-px' : 'inset-x-0 top-0 h-px')}
          initial={{ scaleX: vertical ? 1 : 0, scaleY: vertical ? 0 : 1 }}
          whileInView={{ scaleX: 1, scaleY: 1 }}
          viewport={{ once: true, amount: 0.8 }}
          style={{ transformOrigin: vertical ? 'top' : 'left' }}
          transition={{ duration: reduced ? 0.2 : 0.9, ease: EASE_EXPO, delay }}
        />
        {inView && (blocked ? (
          <>
            {/* network boundary */}
            <span
              aria-hidden="true"
              className={cn(
                'absolute border-dashed border-line-strong',
                vertical ? 'inset-x-[-7px] top-[68%] border-t' : 'inset-y-[-7px] left-[68%] border-l',
              )}
            />
            <span
              aria-hidden="true"
              className={cn(
                'absolute flex h-5 w-5 items-center justify-center rounded-full border border-line bg-bg-1 text-brand',
                vertical ? 'left-1/2 top-[68%] -translate-x-1/2 -translate-y-1/2' : 'left-[68%] top-1/2 -translate-x-1/2 -translate-y-1/2',
              )}
            >
              <ShieldCheck className="h-3 w-3" />
            </span>
            <BlockedKey dist={len} vertical={vertical} active={inView} />
          </>
        ) : (
          <Packets dist={len} vertical={vertical} />
        ))}
      </div>
    </div>
  );
}

interface ZoneProps {
  label: string;
  caption?: string;
  tooltip: string;
  delay: number;
  glow?: boolean;
  children: ReactNode;
}

function Zone({ label, caption, tooltip, delay, glow = false, children }: ZoneProps) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className="group/zone relative flex-1"
      tabIndex={0}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 40, filter: 'blur(8px)' }}
      whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      viewport={{ once: true, amount: 0.6 }}
      transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay }}
    >
      <div
        className={cn(
          'glass-panel flex h-full flex-col items-center justify-center gap-3 rounded-card p-5 text-center',
          'transition-[background-color,border-color] duration-300 group-hover/zone:border-line-strong group-hover/zone:bg-[var(--surface-glass-2)]',
          glow && 'border-[rgba(var(--brand-rgb),0.35)]',
        )}
      >
        <p className="font-mono text-[0.75rem] uppercase tracking-[0.22em] text-ink-3">{label}</p>
        <div className="flex items-center justify-center gap-3">{children}</div>
        {caption && <p className="font-mono text-[0.6875rem] leading-[1.6] tracking-[0.04em] text-ink-3">{caption}</p>}
      </div>
      <span className="pointer-events-none absolute -top-3 left-1/2 z-10 -translate-x-1/2 -translate-y-full max-w-[calc(100vw-2rem)] whitespace-normal rounded-row sm:whitespace-nowrap border border-line bg-bg-1 px-3 py-1.5 font-mono text-[0.75rem] tracking-[0.04em] text-ink-2 opacity-0 shadow-card transition-opacity duration-200 group-hover/zone:opacity-100 group-focus-visible/zone:opacity-100">
        {tooltip}
      </span>
    </motion.div>
  );
}

const PROVIDERS = ['RD', 'AD', 'PZ', 'TB'];

/**
 * Section 4 - Security model ("the trust diagram", DOM/SVG - not WebGL).
 * Packets flow A→B freely; the B→C key bounces off the network boundary.
 */
export default function TrustDiagram() {
  const reduced = useReducedMotion();

  const titleWords = ['What', 'leaves', 'your', 'network:'];

  return (
    <section className="bg-bg-1 py-[clamp(88px,12vw,152px)]">
      <div className="mx-auto max-w-content px-6 md:px-10">
        <div className="mx-auto max-w-[720px] text-center">
          <motion.p
            className="eyebrow"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true, amount: 0.8 }}
            transition={{ duration: reduced ? 0.2 : 0.6 }}
          >
            {'// SECURITY MODEL'}
          </motion.p>
          <h2 className="display-m mt-4 font-display">
            {titleWords.map((word, i) => (
              <motion.span
                key={word}
                className="inline-block will-change-transform"
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 32, filter: 'blur(8px)' }}
                whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                viewport={{ once: true, amount: 0.8 }}
                transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: i * 0.07 }}
              >
                {word}{' '}
              </motion.span>
            ))}
            <motion.span
              className="text-gradient inline-block will-change-transform"
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 32, filter: 'blur(8px)' }}
              whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              viewport={{ once: true, amount: 0.8 }}
              transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: titleWords.length * 0.07 }}
            >
              nothing that matters.
            </motion.span>
          </h2>
        </div>

        <div className="mx-auto mt-16 flex max-w-[1080px] flex-col items-stretch md:flex-row md:items-center">
          <Zone label="Your devices" tooltip="phones · TVs · laptops - playback only, zero keys" delay={0}>
            <Smartphone className="h-6 w-6 text-ink-2" strokeWidth={1.5} />
            <Tv className="h-6 w-6 text-ink-2" strokeWidth={1.5} />
            <Laptop className="h-6 w-6 text-ink-2" strokeWidth={1.5} />
          </Zone>

          <Connector label="HTTPS · your LAN" delay={0.35} />

          <Zone
            label="Your server"
            caption="logins · profiles · encrypted keys · sessions"
            tooltip="the only place keys exist - encrypted at rest"
            delay={0.12}
            glow
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-[rgba(var(--brand-rgb),0.4)] bg-bg-2 text-brand shadow-glow-brand">
              <Box className="h-5 w-5" strokeWidth={1.5} />
            </span>
            <RingMark size={26} />
          </Zone>

          <Connector label="server IP only" delay={0.9} blocked />

          <Zone label="Providers" tooltip="Real-Debrid · AllDebrid · Premiumize · TorBox" delay={0.24}>
            {PROVIDERS.map((p) => (
              <span
                key={p}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-bg-2 font-mono text-[0.6875rem] tracking-[0.04em] text-ink-2"
              >
                {p}
              </span>
            ))}
          </Zone>
        </div>
      </div>
    </section>
  );
}
