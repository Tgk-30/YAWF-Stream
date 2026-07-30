import { useEffect, useRef, useState } from 'react';
import { motion, useInView, useReducedMotion } from 'framer-motion';
import { Download, PackageCheck, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

const STATUS_AUTO = 'auto-check on - updates land quietly';
const STATUS_MANUAL = 'manual mode - check when you want';

/** Retypes the status line whenever it changes (34 chars/s; instant when reduced). */
function useRetype(text: string, active: boolean, reduced: boolean) {
  const [out, setOut] = useState('');
  useEffect(() => {
    if (!active || reduced) return;
    let i = 0;
    const timer = window.setInterval(() => {
      i += 1;
      setOut(text.slice(0, i));
      if (i >= text.length) window.clearInterval(timer);
    }, 30);
    return () => window.clearInterval(timer);
  }, [text, active, reduced]);
  if (reduced) return text;
  return active ? out : '';
}

/** Demo toggle - spring slide knob. */
function AutoCheckToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Auto-check for updates"
      onClick={() => onChange(!on)}
      className={cn(
        'relative h-7 w-12 shrink-0 rounded-chip border transition-colors duration-300',
        on ? 'border-brand bg-[rgba(var(--brand-rgb),0.18)] shadow-glow-brand' : 'border-line bg-bg-2',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-1 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full transition-transform duration-300 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)]',
          on ? 'translate-x-5 bg-brand' : 'translate-x-0 bg-ink-3',
        )}
      />
    </button>
  );
}

const NODES = [
  { cx: 40, label: 'download', Icon: Download },
  { cx: 160, label: 'install', Icon: PackageCheck },
  { cx: 280, label: 'relaunch', Icon: RefreshCw },
];

/**
 * Download §5 - Updates: 3-step download → install → relaunch flow with a
 * traveling packet, plus a functional auto-check demo toggle (dims to 40%,
 * retypes the status when flipped to manual).
 */
export default function Updates() {
  const reduced = useReducedMotion();
  const [auto, setAuto] = useState(true);
  const flowRef = useRef<HTMLDivElement>(null);
  const inView = useInView(flowRef, { amount: 0.5 });
  const status = useRetype(auto ? STATUS_AUTO : STATUS_MANUAL, inView, reduced ?? false);

  return (
    <section className="relative py-[clamp(88px,12vw,152px)]">
      <div className="mx-auto grid grid-cols-1 max-w-content items-center gap-12 px-6 md:px-10 lg:grid-cols-2">
        {/* left copy */}
        <div>
          <h2 className="display-m font-display">
            {['Updates', 'that', 'respect', 'the', 'projector.'].map((word, i) => (
              <motion.span
                key={word}
                className="inline-block will-change-transform"
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 28, filter: 'blur(6px)' }}
                whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                viewport={{ once: true, amount: 0.8 }}
                transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: i * 0.07 }}
              >
                {word}{' '}
              </motion.span>
            ))}
          </h2>
          <motion.p
            className="mt-5 max-w-[480px] leading-[1.7] text-ink-2"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.8 }}
            transition={{ duration: reduced ? 0.2 : 0.6, ease: EASE_EXPO, delay: 0.3 }}
          >
            The in-app updater downloads, installs, and relaunches. Movie night never dies mid-film: checks are
            quiet, installs are one click, and auto-check can be turned off entirely.
          </motion.p>

          {/* functional demo toggle */}
          <motion.div
            className="mt-8 flex items-center gap-4"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: reduced ? 0 : 0.45 }}
          >
            <AutoCheckToggle on={auto} onChange={setAuto} />
            <span className="font-body text-[0.95rem] font-semibold text-ink-1">Auto-check for updates</span>
          </motion.div>
          <p className="mt-3 font-mono text-[0.8125rem] tracking-[0.04em] text-ink-3">
            <span aria-live="polite">{status}</span>
          </p>
        </div>

        {/* right - flow diagram (dims to 40% in manual mode) */}
        <motion.div
          ref={flowRef}
          animate={{ opacity: auto ? 1 : 0.4 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
          className="glass-panel rounded-card p-6"
        >
          <svg viewBox="0 0 320 88" className="w-full" role="img" aria-label="download → install → relaunch">
            {/* signal trace - draws on entry (800ms) */}
            <motion.line
              x1={66}
              y1={36}
              x2={254}
              y2={36}
              stroke="var(--line-strong)"
              strokeWidth={1.5}
              initial={{ pathLength: 0 }}
              whileInView={{ pathLength: 1 }}
              viewport={{ once: true, amount: 0.6 }}
              transition={{ duration: reduced ? 0.2 : 0.8, ease: EASE_EXPO }}
            />
            {/* traveling packet dot (2.8s loop) */}
            {!reduced && auto && inView && (
              <motion.circle
                r={3.5}
                cy={36}
                fill="var(--warm)"
                style={{ filter: 'drop-shadow(0 0 5px var(--warm))' }}
                animate={{ cx: [66, 254], opacity: [0, 1, 1, 0] }}
                transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut', times: [0, 0.12, 0.88, 1] }}
              />
            )}
            {/* glass nodes - pop stagger 100ms after the trace lands */}
            {NODES.map((node, i) => (
              <motion.g
                key={node.label}
                style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
                initial={{ scale: reduced ? 1 : 0, opacity: 0 }}
                whileInView={{ scale: 1, opacity: 1 }}
                viewport={{ once: true, amount: 0.6 }}
                transition={
                  reduced
                    ? { duration: 0.2, delay: i * 0.1 }
                    : { type: 'spring', stiffness: 260, damping: 18, delay: 0.5 + i * 0.1 }
                }
              >
                <circle
                  cx={node.cx}
                  cy={36}
                  r={26}
                  style={{ fill: 'var(--surface-glass)', stroke: 'var(--line-strong)' }}
                  strokeWidth={1}
                />
                <node.Icon x={node.cx - 11} y={25} width={22} height={22} color="var(--brand)" strokeWidth={1.8} />
                <text
                  x={node.cx}
                  y={80}
                  textAnchor="middle"
                  style={{ fill: 'var(--ink-3)', fontFamily: 'var(--font-mono)', fontSize: '10px', letterSpacing: '0.08em' }}
                >
                  {node.label}
                </text>
              </motion.g>
            ))}
          </svg>
        </motion.div>
      </div>
    </section>
  );
}
