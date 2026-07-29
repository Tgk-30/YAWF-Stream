import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Download, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import SectionHeading from '@/components/SectionHeading';
import RingMark from '@/components/RingMark';
import { EASE_EXPO } from '@/pages/brand/utils';
import { asset } from '@/lib/asset';

const S = 400 / 48; // construction-stage scale: RingMark viewBox 48 → 400 stage

/** A rule row: mono index + title + one-liner. */
function Rule({ index, title, desc, children }: { index: string; title: string; desc: ReactNode; children?: ReactNode }) {
  return (
    <div className="border-b border-line py-4 first:pt-0 last:border-0">
      <p className="font-body text-[1rem] font-semibold text-ink-1">
        <span className="mr-2 font-mono text-[0.75rem] tracking-[0.04em] text-brand">{index}</span>
        {title}
      </p>
      <p className="mt-1 font-body text-[0.9rem] text-ink-2">{desc}</p>
      {children}
    </div>
  );
}

/** One "don't" tile - hovering plays the violation. */
function DontTile({ caption, children, className }: { caption: string; children: ReactNode; className?: string }) {
  return (
    <motion.div
      whileHover="bad"
      className={cn(
        'group/dont relative flex h-28 flex-col items-center justify-center gap-2 overflow-hidden rounded-row border border-line bg-[var(--surface-glass)] p-3',
        className,
      )}
    >
      <span className="absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full border border-[hsl(var(--destructive))]">
        <X className="h-2.5 w-2.5 text-[hsl(var(--destructive))]" strokeWidth={3} />
      </span>
      {children}
      <span className="font-mono text-[0.625rem] tracking-[0.04em] text-ink-3">{caption}</span>
    </motion.div>
  );
}

/** Mini ring mark with one ring recolored (a "don't" demo). */
function RecoloredMark() {
  return (
    <svg width="40" height="40" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle cx="24" cy="24" r="9.5" pathLength={100} strokeDasharray="58 42" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" />
      <circle
        cx="24" cy="24" r="14" pathLength={100} strokeDasharray="46 54"
        stroke="var(--warm)" strokeWidth="1.5" strokeLinecap="round" transform="rotate(140 24 24)"
        className="opacity-40 transition-opacity duration-200 group-hover/dont:opacity-100"
      />
      <circle cx="24" cy="24" r="18.5" pathLength={100} strokeDasharray="68 32" stroke="var(--brand)" strokeOpacity=".38" strokeWidth="1.5" strokeLinecap="round" transform="rotate(260 24 24)" />
      <path d="M21 18.4v11.2c0 .9.98 1.45 1.74.97l8.6-5.6a1.15 1.15 0 0 0 0-1.94l-8.6-5.6a1.13 1.13 0 0 0-1.74.97Z" className="fill-ink-1" />
    </svg>
  );
}

const GHOST_CLASSES = cn(
  'border-beam group inline-flex items-center justify-center gap-2.5 rounded-chip px-[26px] py-[14px]',
  'border border-line-strong bg-[var(--surface-glass)] font-display text-[0.95rem] font-semibold leading-none tracking-[-0.01em] text-brand backdrop-blur-sm',
  'transition-[background-color,border-color,transform] duration-200 ease-expo hover:bg-[var(--surface-glass-2)] active:scale-[0.97]',
);

/** Section 5 - Logo & the mark: construction stage, usage rules, don'ts, downloads. */
export default function LogoSection() {
  const reduced = useReducedMotion();

  const guide = (delay: number) => ({
    initial: reduced ? { opacity: 0 } : { pathLength: 0, opacity: 0 },
    whileInView: { pathLength: 1, opacity: 1 },
    viewport: { once: true, amount: 0.5 },
    transition: reduced
      ? { duration: 0.2, delay }
      : { pathLength: { duration: 0.5, ease: EASE_EXPO, delay }, opacity: { duration: 0.2, delay } },
  });
  const fade = (delay: number) => ({
    initial: { opacity: 0 },
    whileInView: { opacity: 1 },
    viewport: { once: true, amount: 0.5 },
    transition: { duration: reduced ? 0.2 : 0.4, delay },
  });

  return (
    <section className="relative bg-bg-1 py-[clamp(88px,12vw,152px)]">
      <div className="mx-auto max-w-content px-6 md:px-10">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          {/* left - construction stage */}
          <motion.div
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 40, filter: 'blur(8px)' }}
            whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            viewport={{ once: true, amount: 0.35 }}
            transition={{ duration: reduced ? 0.2 : 0.6, ease: EASE_EXPO }}
            className="brandpg-blueprint group relative mx-auto aspect-square w-full max-w-[440px] rounded-stage border border-line bg-bg-0/60"
          >
            {/* live mark (re-themes with the playground) */}
            <div className="absolute inset-0 flex items-center justify-center">
              <RingMark size={180} />
            </div>

            {/* construction guides */}
            <svg viewBox="0 0 400 400" className="absolute inset-0 h-full w-full" aria-hidden="true">
              {/* concentric construction circles */}
              {[9.5 * S, 14 * S, 18.5 * S].map((r, i) => (
                <motion.circle
                  key={r}
                  cx="200" cy="200" r={r} fill="none"
                  stroke="rgba(var(--accent-rgb), 0.4)" strokeWidth="1"
                  {...guide(i * 0.25)}
                />
              ))}
              {/* play triangle trace */}
              <g transform={`scale(${S})`}>
                <motion.path
                  d="M21 18.4v11.2c0 .9.98 1.45 1.74.97l8.6-5.6a1.15 1.15 0 0 0 0-1.94l-8.6-5.6a1.13 1.13 0 0 0-1.74.97Z"
                  fill="none" stroke="rgba(var(--warm-rgb), 0.65)" strokeWidth="0.35"
                  {...guide(0.85)}
                />
              </g>
              {/* crosshairs */}
              <motion.line x1="200" y1="16" x2="200" y2="384" stroke="rgba(var(--accent-rgb), 0.18)" strokeWidth="1" strokeDasharray="3 6" {...guide(1.05)} />
              <motion.line x1="16" y1="200" x2="384" y2="200" stroke="rgba(var(--accent-rgb), 0.18)" strokeWidth="1" strokeDasharray="3 6" {...guide(1.15)} />
              {/* annotations */}
              <motion.text x="206" y="118" fontFamily="var(--font-mono)" fontSize="10" letterSpacing="1" fill="var(--ink-3)" {...fade(1.3)}>
                ring gap = 0.18×r
              </motion.text>
              <motion.text x="206" y="82" fontFamily="var(--font-mono)" fontSize="10" letterSpacing="1" fill="var(--ink-3)" {...fade(1.45)}>
                r = 1.0×
              </motion.text>
              <motion.text x="232" y="206" fontFamily="var(--font-mono)" fontSize="10" letterSpacing="1" fill="var(--warm)" {...fade(1.6)}>
                play = 0.42×r
              </motion.text>
            </svg>
          </motion.div>

          {/* right - rules */}
          <div>
            <SectionHeading eyebrow="// THE MARK" title="One glyph. Content flowing to you." />

            <div className="mt-8">
              <Rule
                index="01"
                title="The mark"
                desc="A play triangle inside concentric stream rings - the product in one glyph: content flowing to you."
              />
              <Rule
                index="02"
                title="Wordmark"
                desc="YAWF Stream - a two-word name. Stream takes the brand color."
              />
              <Rule index="03" title="Clear space" desc="One ring-width on all sides. Nothing enters the mark's personal space.">
                <div className="mt-3 inline-flex flex-col items-start gap-1.5">
                  <span className="brandpg-clearspace inline-flex rounded-md border border-dashed border-[rgba(var(--accent-rgb),0.55)] p-4">
                    <RingMark size={30} static />
                  </span>
                  <span className="font-mono text-[0.625rem] tracking-[0.04em] text-ink-3">clear space = 1 ring width</span>
                </div>
              </Rule>
            </div>

            {/* don'ts */}
            <div className="mt-6 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <DontTile caption="don't stretch">
                <motion.div
                  variants={{ bad: { scaleX: 1.45, scaleY: 0.72 } }}
                  transition={{ type: 'spring', stiffness: 260, damping: 8 }}
                >
                  <RingMark size={40} static />
                </motion.div>
              </DontTile>
              <DontTile caption="don't recolor one ring">
                <RecoloredMark />
              </DontTile>
              <DontTile caption="no busy light bg">
                <span className="brandpg-busy-bg flex h-12 w-12 items-center justify-center rounded-lg transition-[filter] duration-200 group-hover/dont:saturate-200">
                  <RingMark size={30} static />
                </span>
              </DontTile>
              <DontTile caption="no extra shadows">
                <span className="[filter:drop-shadow(0_10px_16px_rgba(0,0,0,0.9))] transition-[filter] duration-200 group-hover/dont:[filter:drop-shadow(0_18px_26px_rgba(0,0,0,1))]">
                  <RingMark size={40} static />
                </span>
              </DontTile>
            </div>

            {/* downloads */}
            <div className="mt-8 flex flex-wrap gap-3">
              <a href={asset('brand/logo-mark.svg')} download="logo-mark.svg" className={GHOST_CLASSES}>
                <Download className="h-4 w-4" />
                logo-mark.svg
              </a>
              <a href={asset('icon-128.png')} download="icon-128.png" className={GHOST_CLASSES}>
                <Download className="h-4 w-4" />
                icon-128.png
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
