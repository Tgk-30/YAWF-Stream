import type { JSX } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Copy } from 'lucide-react';
import { FONT_PAIRINGS, useThemeTweaks } from '@/theme.config';
import SectionHeading from '@/components/SectionHeading';
import GlassCard from '@/components/GlassCard';
import { VERSION } from '@/lib/site';
import { copyWithToast, EASE_EXPO } from '@/pages/brand/utils';

const SCALE_ROWS = [
  { style: 'Display XL', spec: 'clamp(2.9rem, 7.2vw, 6.2rem) / 0.98 / -0.035em' },
  { style: 'Display L', spec: 'clamp(2.2rem, 4.6vw, 3.9rem) / 1.02 / -0.03em' },
  { style: 'Display M', spec: 'clamp(1.5rem, 2.6vw, 2.1rem) / 1.15 / -0.02em' },
  { style: 'Lede', spec: 'clamp(1.05rem, 1.6vw, 1.25rem) / 1.65 / 0' },
  { style: 'Mono caption', spec: '0.8125rem / 1.5 / +0.04em' },
];

const firstFamily = (stack: string) => stack.replace(/'/g, '').split(',')[0].trim();

/** Section 4 - Typography: role tokens + scale rules + live specimen. */
export default function TypographySection() {
  const reduced = useReducedMotion();
  const tweaks = useThemeTweaks();
  const pairing = FONT_PAIRINGS[tweaks.fontPairing ?? 'grotesk-inter'];

  const fonts = [
    { role: 'Display', name: firstFamily(pairing.display), desc: 'the voice - tight, geometric, a little sci-fi' },
    { role: 'Body', name: firstFamily(pairing.body), desc: 'the workhorse - paragraphs, UI, everything readable' },
    { role: 'Mono', name: firstFamily("'JetBrains Mono', monospace"), desc: 'labels, terminals, version numbers' },
  ];

  const specimen: { key: string; shorthand: string; node: JSX.Element }[] = [
    {
      key: 'display',
      shorthand: "font: 700 clamp(2.2rem,4.6vw,3.9rem)/1.02 var(--font-display); letter-spacing: -0.03em;",
      node: (
        <p className="display-l font-display">
          Let&rsquo;s get you <span className="text-gradient">streaming</span>.
        </p>
      ),
    },
    {
      key: 'lede',
      shorthand: 'font: 400 clamp(1.05rem,1.6vw,1.25rem)/1.65 var(--font-body); color: var(--ink-2);',
      node: (
        <p className="lede">
          One config drives name, colors, fonts, radius and glow - this sentence is set in the body face you just
          picked, and it re-flows the moment you pick another.
        </p>
      ),
    },
    {
      key: 'eyebrow',
      shorthand:
        'font: 500 0.75rem/1.4 var(--font-mono); letter-spacing: 0.22em; text-transform: uppercase; color: var(--brand);',
      node: <p className="eyebrow">{'// EYEBROW · ALWAYS MONO'}</p>,
    },
    {
      key: 'caption',
      shorthand: 'font: 400 0.8125rem/1.5 var(--font-mono); letter-spacing: 0.04em; color: var(--ink-3);',
      node: <p className="font-mono text-[0.8125rem] tracking-[0.04em] text-ink-3">Desktop {VERSION} · MIT</p>,
    },
  ];

  return (
    <section className="relative border-t border-line py-[clamp(88px,12vw,152px)]">
      <div className="mx-auto max-w-content px-6 md:px-10">
        <SectionHeading eyebrow="// TYPE" title="Three voices, one config." />

        <div className="mt-12 grid gap-10 lg:grid-cols-2">
          {/* left - font roles + scale rules */}
          <div>
            <div className="flex flex-col gap-5">
              {fonts.map((f, i) => (
                <motion.div
                  key={f.role}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, amount: 0.6 }}
                  transition={{ duration: reduced ? 0.2 : 0.45, ease: EASE_EXPO, delay: i * 0.08 }}
                  className="flex items-baseline gap-4 border-b border-line pb-4"
                >
                  <span className="w-16 shrink-0 font-mono text-[0.6875rem] uppercase tracking-[0.22em] text-ink-3">
                    {f.role}
                  </span>
                  <div>
                    <p
                      className="text-[1.35rem] font-semibold text-ink-1"
                      style={{
                        fontFamily:
                          f.role === 'Display'
                            ? 'var(--font-display)'
                            : f.role === 'Body'
                              ? 'var(--font-body)'
                              : 'var(--font-mono)',
                      }}
                    >
                      {f.name}
                    </p>
                    <p className="mt-0.5 font-body text-[0.875rem] text-ink-2">{f.desc}</p>
                  </div>
                </motion.div>
              ))}
            </div>

            <p className="mt-8 font-mono text-[0.75rem] uppercase tracking-[0.22em] text-ink-3">
              <span className="text-brand">▸</span> Scale rules
            </p>
            <div className="mt-4 flex flex-col">
              {SCALE_ROWS.map((row) => (
                <div
                  key={row.style}
                  className="flex items-baseline justify-between gap-4 border-b border-line py-2.5 last:border-0"
                >
                  <span className="font-body text-[0.875rem] font-semibold text-ink-1">{row.style}</span>
                  <span className="text-right font-mono text-[0.75rem] tracking-[0.02em] text-ink-3">{row.spec}</span>
                </div>
              ))}
            </div>
          </div>

          {/* right - live specimen (cross-fades on pairing change) */}
          <motion.div
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 32 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: reduced ? 0.2 : 0.55, ease: EASE_EXPO, delay: 0.15 }}
          >
            <GlassCard beam={false} className="flex h-full flex-col justify-center gap-6 p-8 hover:-translate-y-0">
              <p className="font-mono text-[0.6875rem] uppercase tracking-[0.22em] text-ink-3">
                Live specimen - {pairing.label} · click a line to copy its CSS
              </p>
              <motion.div
                key={pairing.label}
                initial={{ opacity: 0, filter: reduced ? 'blur(0px)' : 'blur(6px)' }}
                animate={{ opacity: 1, filter: 'blur(0px)' }}
                transition={{ duration: 0.25, ease: 'easeOut' }}
                className="flex flex-col gap-6"
              >
                {specimen.map((line, i) => (
                  <motion.button
                    key={line.key}
                    type="button"
                    onClick={() => copyWithToast(line.shorthand, 'Copied')}
                    title={`Copy ${line.key} CSS`}
                    initial={reduced ? { opacity: 0 } : { opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, amount: 0.6 }}
                    transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: i * 0.1 }}
                    className="group/spec relative rounded-row px-2 py-1 text-left transition-colors duration-150 hover:bg-[var(--surface-glass-2)]"
                  >
                    {line.node}
                    <Copy className="absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3 opacity-0 transition-opacity duration-150 group-hover/spec:opacity-100" />
                  </motion.button>
                ))}
              </motion.div>
            </GlassCard>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
