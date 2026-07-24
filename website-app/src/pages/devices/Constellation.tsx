import { useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion, useScroll, useTransform } from 'framer-motion';
import { Globe, Laptop, Monitor, Smartphone, Tablet, Tv } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import RingMark from '@/components/RingMark';
import { scrollToTarget } from '@/lib/scroll';
import { cn } from '@/lib/utils';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];
const CENTER = { x: 500, y: 310 };

type DeviceKind = 'native' | 'PWA' | 'browser';

interface DeviceNode {
  id: string;
  name: string;
  desc: string;
  kind: DeviceKind;
  icon: LucideIcon;
  x: number;
  y: number;
  /** perpendicular bend of the curved trace (viewBox units) */
  bend: number;
  hint: string;
}

const NODES: DeviceNode[] = [
  { id: 'tv', name: 'TV', desc: 'native Android TV app + browser TV mode', kind: 'native', icon: Tv, x: 500, y: 106, bend: 26, hint: 'Install the TV APK → connect your server' },
  { id: 'desktop', name: 'Desktop', desc: 'macOS · Linux apps · Windows planned', kind: 'native', icon: Monitor, x: 790, y: 208, bend: -26, hint: 'Get the app → it finds your server' },
  { id: 'laptop', name: 'Laptop', desc: 'same apps, same server', kind: 'native', icon: Laptop, x: 790, y: 412, bend: 26, hint: 'Get the app → it finds your server' },
  { id: 'tablet', name: 'Tablet', desc: 'Add to Home Screen', kind: 'PWA', icon: Tablet, x: 500, y: 514, bend: -26, hint: 'Share → Add to Home Screen' },
  { id: 'phone', name: 'Phone', desc: 'PWA + remote for the TV', kind: 'PWA', icon: Smartphone, x: 210, y: 412, bend: 26, hint: 'Open /remote → pair with the TV' },
  { id: 'browser', name: 'Guest browser', desc: 'point anything at your URL', kind: 'browser', icon: Globe, x: 210, y: 208, bend: -26, hint: 'Type your server URL → sign in' },
];

/** Curved trace from the center disc edge to the device card edge. */
function tracePath(node: DeviceNode): string {
  const dx = node.x - CENTER.x;
  const dy = node.y - CENTER.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const sx = CENTER.x + ux * 76;
  const sy = CENTER.y + uy * 76;
  const ex = node.x - ux * 94;
  const ey = node.y - uy * 94;
  const mx = (sx + ex) / 2 - uy * node.bend;
  const my = (sy + ey) / 2 + ux * node.bend;
  return `M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`;
}

function kindClasses(kind: DeviceKind): string {
  if (kind === 'native') return 'text-brand';
  if (kind === 'PWA') return 'text-accent2';
  return 'text-warm';
}

/** Center node - Ring Mark in a glowing glass disc; click scrolls to install flows. */
function CenterNode({ inView, active, reduced }: { inView: boolean; active: string | null; reduced: boolean }) {
  return (
    <motion.button
      type="button"
      onClick={() => scrollToTarget('#install-flows')}
      aria-label="Your server - jump to install flows"
      className="group absolute left-1/2 top-1/2 z-10 flex h-[132px] w-[132px] flex-col items-center justify-center gap-1.5 rounded-full border border-line-strong bg-[var(--surface-glass-2)] text-center shadow-glow-brand backdrop-blur-md"
      style={{ x: '-50%', y: '-50%' }}
      initial={{ scale: reduced ? 1 : 0.7, opacity: 0 }}
      animate={inView ? { scale: 1, opacity: 1 } : {}}
      transition={reduced ? { duration: 0.2 } : { type: 'spring', stiffness: 200, damping: 18 }}
    >
      {/* entry glow flash */}
      {inView && !reduced && (
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-full border border-brand"
          initial={{ scale: 1, opacity: 0.8 }}
          animate={{ scale: 2, opacity: 0 }}
          transition={{ duration: 1, ease: 'easeOut', delay: 0.6 }}
        />
      )}
      {/* center pulse whenever a device is hovered */}
      <AnimatePresence>
        {active && !reduced && (
          <motion.span
            key={active}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-full border border-brand"
            initial={{ scale: 1, opacity: 0.6 }}
            animate={{ scale: 1.45, opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
          />
        )}
      </AnimatePresence>
      <RingMark size={40} className="transition-transform duration-500 ease-expo group-hover:scale-110" />
      <span className="font-mono text-[0.6875rem] uppercase tracking-[0.18em] text-ink-2">your server</span>
    </motion.button>
  );
}

/** One device card (shared by radial + timeline layouts). */
function DeviceCard({
  node,
  active,
  onActivate,
  onDeactivate,
  className,
}: {
  node: DeviceNode;
  active: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
  className?: string;
}) {
  const Icon = node.icon;
  return (
    <button
      type="button"
      onMouseEnter={onActivate}
      onMouseLeave={onDeactivate}
      onFocus={onActivate}
      onBlur={onDeactivate}
      onClick={onActivate}
      aria-label={`${node.name} - ${node.hint}`}
      className={cn(
        'group flex flex-col items-center gap-1 rounded-card border bg-[var(--surface-glass)] px-4 py-3 text-center backdrop-blur-md transition-[background-color,border-color] duration-200',
        active ? 'border-line-strong bg-[var(--surface-glass-2)]' : 'border-line',
        className,
      )}
    >
      <Icon className={cn('h-5 w-5 transition-colors duration-200', active ? 'text-brand' : 'text-ink-2')} />
      <span className="display-s font-display text-[1.05rem] leading-tight">{node.name}</span>
      <span className="font-mono text-[0.6875rem] leading-snug tracking-[0.02em] text-ink-3">{node.desc}</span>
      <span className={cn('mt-0.5 rounded-chip border border-line px-2 py-0.5 font-mono text-[0.625rem] uppercase tracking-[0.14em]', kindClasses(node.kind))}>
        {node.kind}
      </span>
    </button>
  );
}

/** Floating mono hint chip shown for the active device. */
function HintChip({ node, below }: { node: DeviceNode; below: boolean }) {
  return (
    <motion.span
      className={cn(
        'pointer-events-none absolute left-1/2 z-20 w-max max-w-[240px] -translate-x-1/2 whitespace-nowrap rounded-chip border border-line-strong bg-bg-2 px-3 py-1.5 font-mono text-[0.6875rem] tracking-[0.03em] text-brand shadow-card',
        below ? 'top-[calc(100%+8px)]' : 'bottom-[calc(100%+8px)]',
      )}
      initial={{ opacity: 0, y: below ? -6 : 6, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: below ? -4 : 4, scale: 0.95 }}
      transition={{ duration: 0.22, ease: EASE_EXPO }}
    >
      {node.hint}
    </motion.span>
  );
}

/**
 * Devices §2 - The device constellation: DOM/SVG radial diagram (no WebGL).
 * Center server disc, six device cards on an ellipse, curved traces with
 * traveling packet dashes. Mobile collapses to a vertical timeline.
 */
export default function Constellation() {
  const reduced = useReducedMotion() ?? false;
  const sectionRef = useRef<HTMLElement>(null);
  const diagramRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [active, setActive] = useState<string | null>(null);

  /* ±1° drift on scroll (scrub) */
  const { scrollYProgress } = useScroll({ target: sectionRef, offset: ['start end', 'end start'] });
  const drift = useTransform(scrollYProgress, [0, 1], reduced ? [0, 0] : [-1, 1]);

  return (
    <section ref={sectionRef} className="relative py-[clamp(88px,12vw,152px)]">
      <div className="mx-auto max-w-[1100px] px-6 md:px-10">
        {/* ── Desktop: radial constellation ── */}
        <motion.div
          ref={diagramRef}
          style={{ rotate: drift }}
          className="relative hidden aspect-[1000/620] md:block"
        >
          <motion.div
            className="absolute inset-0"
            initial={false}
            animate={inView ? 'show' : 'hidden'}
            onViewportEnter={() => setInView(true)}
            viewport={{ once: true, amount: 0.35 }}
          >
            {/* traces + packets */}
            <svg viewBox="0 0 1000 620" className="absolute inset-0 h-full w-full" fill="none" aria-hidden="true">
              {NODES.map((node, i) => {
                const d = tracePath(node);
                const isActive = active === node.id;
                return (
                  <g key={node.id}>
                    <motion.path
                      d={d}
                      stroke={isActive ? 'var(--brand)' : 'var(--line-strong)'}
                      strokeWidth={isActive ? 2 : 1.5}
                      style={isActive ? { filter: 'drop-shadow(0 0 5px var(--brand))' } : undefined}
                      variants={{
                        hidden: { pathLength: reduced ? 1 : 0, opacity: 0 },
                        show: {
                          pathLength: 1,
                          opacity: 1,
                          transition: { duration: reduced ? 0.2 : 0.7, ease: EASE_EXPO, delay: reduced ? 0 : 0.35 + i * 0.1 },
                        },
                      }}
                    />
                    {/* traveling packet dashes (infinite 3s-cycle dash flow, staggered) */}
                    <motion.path
                      d={d}
                      stroke={isActive ? 'var(--brand)' : 'var(--warm)'}
                      strokeWidth={isActive ? 2.5 : 2}
                      strokeLinecap="round"
                      strokeDasharray="2 18"
                      className="dash-flow"
                      style={{ animationDuration: `${2.4 + i * 0.35}s`, animationDelay: `${i * 0.4}s` }}
                      variants={{
                        hidden: { opacity: 0 },
                        show: { opacity: isActive ? 1 : 0.75, transition: { duration: 0.4, delay: reduced ? 0 : 1.0 + i * 0.1 } },
                      }}
                    />
                  </g>
                );
              })}
            </svg>

            <CenterNode inView={inView} active={active} reduced={reduced} />

            {/* device cards popping at trace ends */}
            {NODES.map((node, i) => (
              <motion.div
                key={node.id}
                className="absolute z-10 w-[168px]"
                style={{ left: `${node.x / 10}%`, top: `${node.y / 6.2}%`, x: '-50%', y: '-50%' }}
                variants={{
                  hidden: { scale: reduced ? 1 : 0.6, opacity: 0 },
                  show: {
                    scale: 1,
                    opacity: 1,
                    transition: reduced
                      ? { duration: 0.2, delay: i * 0.08 }
                      : { type: 'spring', stiffness: 240, damping: 18, delay: 0.75 + i * 0.1 },
                  },
                }}
              >
                <DeviceCard
                  node={node}
                  active={active === node.id}
                  onActivate={() => setActive(node.id)}
                  onDeactivate={() => setActive((a) => (a === node.id ? null : a))}
                  className="w-full"
                />
                <AnimatePresence>
                  {active === node.id && <HintChip node={node} below={node.y < CENTER.y} />}
                </AnimatePresence>
              </motion.div>
            ))}
          </motion.div>
        </motion.div>

        {/* ── Mobile: vertical timeline (same copy, same trace language) ── */}
        <motion.div
          className="flex flex-col items-center md:hidden"
          initial={false}
          animate={inView ? 'show' : 'hidden'}
          onViewportEnter={() => setInView(true)}
          viewport={{ once: true, amount: 0.15 }}
        >
          <motion.div
            variants={{ hidden: { opacity: 0, scale: reduced ? 1 : 0.7 }, show: { opacity: 1, scale: 1, transition: { duration: 0.4, ease: EASE_EXPO } } }}
            className="flex h-[104px] w-[104px] flex-col items-center justify-center gap-1 rounded-full border border-line-strong bg-[var(--surface-glass-2)] shadow-glow-brand"
          >
            <RingMark size={32} />
            <span className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-ink-2">your server</span>
          </motion.div>

          {NODES.map((node, i) => (
            <div key={node.id} className="flex flex-col items-center">
              {/* descending trace segment */}
              <motion.span
                aria-hidden="true"
                className="block h-8 w-px origin-top"
                style={{ backgroundImage: 'linear-gradient(180deg, var(--brand), var(--line-strong))' }}
                variants={{
                  hidden: { scaleY: reduced ? 1 : 0, opacity: 0 },
                  show: { scaleY: 1, opacity: 1, transition: { duration: reduced ? 0.2 : 0.4, ease: EASE_EXPO, delay: i * 0.12 } },
                }}
              />
              <motion.div
                className="relative w-full max-w-[320px]"
                variants={{
                  hidden: { scale: reduced ? 1 : 0.6, opacity: 0 },
                  show: {
                    scale: 1,
                    opacity: 1,
                    transition: reduced
                      ? { duration: 0.2, delay: i * 0.12 }
                      : { type: 'spring', stiffness: 240, damping: 18, delay: 0.15 + i * 0.12 },
                  },
                }}
              >
                <DeviceCard
                  node={node}
                  active={active === node.id}
                  onActivate={() => setActive(node.id)}
                  onDeactivate={() => setActive((a) => (a === node.id ? null : a))}
                  className="w-full"
                />
                <AnimatePresence>{active === node.id && <HintChip node={node} below />}</AnimatePresence>
              </motion.div>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
