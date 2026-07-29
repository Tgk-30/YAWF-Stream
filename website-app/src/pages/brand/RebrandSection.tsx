import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GITHUB_REPO } from '@/lib/site';
import SectionHeading from '@/components/SectionHeading';
import { copyWithToast, EASE_EXPO } from '@/pages/brand/utils';
import type { PlaygroundKey } from '@/pages/brand/ThemePlayground';

type Tok = { t: string; c?: 'k' | 's' | 'c' | 'n' | 'p' };
interface CodeLine {
  toks: Tok[];
  key?: PlaygroundKey;
}

/* The exact theme.config.ts block from the design system, hand-tokenized:
   keys → ink-1 · strings → brand · comments → ink-3 · numbers → warm · punctuation → ink-2 */
const LINES: CodeLine[] = [
  { toks: [{ t: '// theme.config.ts - the ONLY file a rebrand touches', c: 'c' }] },
  { toks: [{ t: 'export default', c: 'k' }, { t: ' {', c: 'p' }] },
  {
    key: 'name',
    toks: [
      { t: '  name', c: 'k' }, { t: ': ', c: 'p' }, { t: '"YAWF Stream"', c: 's' }, { t: ',', c: 'p' },
      { t: '          // wordmark, one word, camel case', c: 'c' },
    ],
  },
  {
    toks: [
      { t: '  tagline', c: 'k' }, { t: ': ', c: 'p' }, { t: '"Let\'s get you streaming."', c: 's' }, { t: ',', c: 'p' },
    ],
  },
  {
    toks: [
      { t: '  logo', c: 'k' }, { t: ': ', c: 'p' }, { t: "asset('brand/logo-mark.svg')", c: 's' }, { t: ',', c: 'p' },
      { t: '    // play-in-rings mark', c: 'c' },
    ],
  },
  {
    key: 'preset',
    toks: [
      { t: '  preset', c: 'k' }, { t: ': ', c: 'p' }, { t: '"stream-teal"', c: 's' }, { t: ',', c: 'p' },
      { t: '           // stream-teal | aurora-violet | ember-amber', c: 'c' },
    ],
  },
  { key: 'fonts', toks: [{ t: '  fonts', c: 'k' }, { t: ': {', c: 'p' }] },
  {
    key: 'fonts',
    toks: [{ t: '    display', c: 'k' }, { t: ': ', c: 'p' }, { t: '"\'Space Grotesk\', sans-serif"', c: 's' }, { t: ',', c: 'p' }],
  },
  {
    key: 'fonts',
    toks: [{ t: '    body', c: 'k' }, { t: ': ', c: 'p' }, { t: '"\'Inter\', sans-serif"', c: 's' }, { t: ',', c: 'p' }],
  },
  {
    key: 'fonts',
    toks: [{ t: '    mono', c: 'k' }, { t: ': ', c: 'p' }, { t: '"\'JetBrains Mono\', monospace"', c: 's' }, { t: ',', c: 'p' }],
  },
  { key: 'fonts', toks: [{ t: '  },', c: 'p' }] },
  {
    key: 'radius',
    toks: [
      { t: '  radius', c: 'k' }, { t: ': ', c: 'p' }, { t: '"20px"', c: 's' }, { t: ',', c: 'p' },
      { t: '                  // card corner radius scale base', c: 'c' },
    ],
  },
  {
    key: 'glow',
    toks: [
      { t: '  glow', c: 'k' }, { t: ': ', c: 'p' }, { t: '1.0', c: 'n' }, { t: ',', c: 'p' },
      { t: '                       // global glow intensity multiplier (0 = flat)', c: 'c' },
    ],
  },
  { toks: [{ t: '}', c: 'p' }] },
];

const RAW = LINES.map((l) => l.toks.map((t) => t.t).join('')).join('\n');

const TOK_CLASS: Record<NonNullable<Tok['c']>, string> = {
  k: 'text-ink-1',
  s: 'text-brand',
  c: 'text-ink-3',
  n: 'text-warm',
  p: 'text-ink-2',
};

interface RebrandSectionProps {
  highlight: PlaygroundKey | null;
  onHighlight: (key: PlaygroundKey | null) => void;
}

/** Section 7 - "Rebrand in one file": copy + annotated, syntax-tinted config card. */
export default function RebrandSection({ highlight, onHighlight }: RebrandSectionProps) {
  const reduced = useReducedMotion();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await copyWithToast(RAW, 'Copied');
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <section className="relative bg-bg-1 py-[clamp(88px,12vw,152px)]">
      <div className="mx-auto grid max-w-[1100px] items-center gap-12 px-6 md:px-10 lg:grid-cols-2">
        {/* left - copy */}
        <div>
          <SectionHeading eyebrow="// REBRAND" title="One file. Whole new brand." />
          <motion.p
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.7 }}
            transition={{ duration: reduced ? 0.2 : 0.55, ease: EASE_EXPO, delay: 0.15 }}
            className="mt-5 font-body text-[1rem] leading-[1.7] text-ink-2"
          >
            Fork the repo, edit{' '}
            <code className="rounded-md border border-line bg-bg-0 px-1.5 py-0.5 font-mono text-[0.85em] text-brand">
              theme.config.ts
            </code>{' '}
            - name, logo path, preset (or your own HSL), fonts, radius, glow - and every pixel of the site follows.
            No hunting through components; nothing is hard-coded.
          </motion.p>
          <motion.p
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.7 }}
            transition={{ duration: reduced ? 0.2 : 0.55, ease: EASE_EXPO, delay: 0.25 }}
            className="mt-4 font-body text-[0.9rem] leading-[1.7] text-ink-3"
          >
            Hover a key on the right - the playground control it drives lights up.
          </motion.p>
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, delay: 0.35 }}
          >
            <a
              href={GITHUB_REPO}
              target="_blank"
              rel="noreferrer"
              className="group/link mt-7 inline-flex items-center gap-2 font-mono text-[0.8125rem] tracking-[0.04em] text-brand transition-colors hover:text-accent2"
            >
              Fork on GitHub
              <ArrowUpRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover/link:-translate-y-0.5 group-hover/link:translate-x-0.5" />
            </a>
          </motion.div>
        </div>

        {/* right - annotated config card (TerminalBlock chrome, tinted) */}
        <motion.div
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 40, filter: 'blur(8px)' }}
          whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          viewport={{ once: true, amount: 0.35 }}
          transition={{ duration: reduced ? 0.2 : 0.6, ease: EASE_EXPO }}
          className="relative overflow-hidden rounded-card border border-line bg-bg-0 shadow-card"
        >
          {/* window chrome */}
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <span className="h-2.5 w-2.5 rounded-full bg-[rgba(var(--brand-rgb),0.8)]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[rgba(var(--accent-rgb),0.8)]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[rgba(var(--warm-rgb),0.8)]" />
            <span className="ml-2 font-mono text-[0.75rem] tracking-[0.04em] text-ink-3">theme.config.ts</span>
            <button
              type="button"
              onClick={copy}
              aria-label="Copy config"
              className={cn(
                'ml-auto inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 font-mono text-[0.75rem] text-ink-3',
                'transition-colors duration-150 hover:border-line-strong hover:text-brand',
                copied && 'border-[rgba(var(--brand-rgb),0.5)] text-brand',
              )}
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          </div>

          <motion.div
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.7 }}
            variants={{ hidden: {}, show: { transition: { staggerChildren: reduced ? 0.01 : 0.06, delayChildren: 0.1 } } }}
            className="overflow-x-auto p-5 font-mono text-[0.82rem] leading-[1.75]"
          >
            {LINES.map((line, i) => {
              const lit = line.key != null && highlight === line.key;
              return (
                <motion.div
                  key={i}
                  variants={{
                    hidden: reduced ? { opacity: 0 } : { opacity: 0, y: 8 },
                    show: { opacity: 1, y: 0, transition: { duration: reduced ? 0.15 : 0.35, ease: EASE_EXPO } },
                  }}
                  onMouseEnter={line.key ? () => onHighlight(line.key!) : undefined}
                  onMouseLeave={line.key ? () => onHighlight(null) : undefined}
                  className={cn(
                    'whitespace-pre rounded-md px-2 -mx-2 transition-[background-color,box-shadow] duration-200',
                    line.key && 'cursor-pointer',
                    lit && 'bg-[var(--surface-glass-2)] shadow-[inset_2px_0_0_var(--brand)]',
                  )}
                >
                  {line.toks.map((tok, j) => (
                    <span key={j} className={tok.c ? TOK_CLASS[tok.c] : 'text-ink-2'}>
                      {tok.t}
                    </span>
                  ))}
                  {line.toks.length === 0 ? ' ' : null}
                </motion.div>
              );
            })}
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
