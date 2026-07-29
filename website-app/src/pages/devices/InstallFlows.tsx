import { memo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { motion, useInView, useReducedMotion } from 'framer-motion';
import { Check, Copy, Share } from 'lucide-react';
import Chip from '@/components/Chip';
import RingMark from '@/components/RingMark';
import { cn } from '@/lib/utils';
import { asset } from '@/lib/asset';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

/* ── Scoped 5s loop keyframes (paused offscreen via [data-active]) ── */
const LOOP_CSS = `
  .dv-loop[data-active='false'] [data-anim] { animation-play-state: paused; }
  .dv-loop [data-anim] { animation-duration: 5s; animation-timing-function: var(--ease-soft); animation-iteration-count: infinite; animation-fill-mode: both; }

  @keyframes dv-url-type { 0% { clip-path: inset(0 100% 0 0); animation-timing-function: steps(14, end); } 22%,88% { clip-path: inset(0 0 0 0); } 96%,100% { clip-path: inset(0 100% 0 0); } }
  @keyframes dv-sheet { 0%,26% { transform: translateY(112%); opacity: 0; } 36%,72% { transform: translateY(0); opacity: 1; } 82%,100% { transform: translateY(0); opacity: 0; } }
  @keyframes dv-ios-fly { 0%,42% { transform: translate(0, 0) scale(0.6); opacity: 0; } 48% { opacity: 1; } 62% { transform: translate(0, -68px) scale(1.12); opacity: 1; } 68%,86% { transform: translate(0, -68px) scale(1); opacity: 1; } 96%,100% { transform: translate(0, -68px) scale(1); opacity: 0; } }
  @keyframes dv-slot-glow { 0%,58% { opacity: 0; } 70% { opacity: 1; } 86%,100% { opacity: 0; } }

  @keyframes dv-banner { 0% { transform: translateY(-140%); opacity: 0; } 12%,48% { transform: translateY(0); opacity: 1; } 60%,100% { opacity: 0; } }
  @keyframes dv-ring { 0%,14% { stroke-dashoffset: 63; } 44% { stroke-dashoffset: 0; } 58%,100% { stroke-dashoffset: 0; opacity: 0; } }
  @keyframes dv-stamp { 0%,52% { transform: scale(1.7); opacity: 0; } 62% { transform: scale(0.94); opacity: 1; } 68%,86% { transform: scale(1); opacity: 1; } 96%,100% { opacity: 0; } }

  @keyframes dv-web-type { 0% { clip-path: inset(0 100% 0 0); animation-timing-function: steps(18, end); } 30%,88% { clip-path: inset(0 0 0 0); } 96%,100% { clip-path: inset(0 100% 0 0); } }
  @keyframes dv-web-caret { 0%,28% { opacity: 0; } 32%,40% { opacity: 1; } 44%,52% { opacity: 0.15; } 56%,64% { opacity: 1; } 68%,76% { opacity: 0.15; } 80%,86% { opacity: 1; } 92%,100% { opacity: 0; } }
  @keyframes dv-web-fade { 0%,34% { opacity: 0; transform: scale(1.05); } 48%,84% { opacity: 1; transform: scale(1); } 94%,100% { opacity: 0; transform: scale(1); } }
`;

/* ── Shared bits ──────────────────────────────────────────────────── */

function PhoneShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative mx-auto h-[230px] w-[124px] rounded-[26px] border border-line bg-bg-2 shadow-card">
      <span className="absolute left-1/2 top-2.5 h-3 w-12 -translate-x-1/2 rounded-full bg-bg-0" />
      {children}
    </div>
  );
}

/** iOS loop: URL types → share sheet rises → icon flies to the home grid → glow settle. */
const IosMedia = memo(function IosMedia({ active }: { active: boolean }) {
  return (
    <div className="dv-loop relative flex h-[280px] items-center justify-center" data-active={active}>
      <PhoneShell>
        {/* URL bar typing */}
        <span className="absolute inset-x-3 top-8 flex h-6 items-center rounded-md bg-bg-0 px-2 font-mono text-[0.5625rem] text-brand">
          <span data-anim className="inline-block whitespace-nowrap" style={{ animationName: 'dv-url-type' }}>
            192.168.1.20:43110
          </span>
        </span>
        {/* home grid with dashed target slot */}
        <span className="absolute inset-x-3 bottom-3 top-[68px] grid grid-cols-3 content-start gap-1.5">
          {Array.from({ length: 6 }, (_, i) => (
            <span
              key={i}
              className={cn('aspect-square rounded-[6px]', i === 4 ? 'border border-dashed border-line-strong' : 'border border-line')}
            />
          ))}
        </span>
        {/* slot glow on settle */}
        <span
          data-anim
          className="absolute left-[46px] top-[102px] h-8 w-8 rounded-lg bg-[rgba(var(--brand-rgb),0.3)] blur-md"
          style={{ animationName: 'dv-slot-glow' }}
        />
        {/* share sheet */}
        <span
          data-anim
          className="absolute inset-x-2 bottom-2 flex h-16 flex-col items-center gap-1.5 rounded-t-xl border border-line bg-bg-2 pt-2.5 shadow-card"
          style={{ animationName: 'dv-sheet' }}
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-line bg-bg-0 text-accent2">
            <Share className="h-3.5 w-3.5" />
          </span>
          <span className="font-mono text-[0.5rem] tracking-[0.04em] text-ink-3">Add to Home Screen</span>
        </span>
        {/* flying icon - sheet to grid slot */}
        <span
          data-anim
          className="absolute bottom-[30px] left-1/2 ml-[-14px] flex h-7 w-7 items-center justify-center"
          style={{ animationName: 'dv-ios-fly' }}
        >
          <RingMark size={26} static />
        </span>
      </PhoneShell>
    </div>
  );
});

/** Android loop: install banner slides down → progress ring fills → icon stamps on grid. */
const AndroidMedia = memo(function AndroidMedia({ active }: { active: boolean }) {
  return (
    <div className="dv-loop relative flex h-[280px] items-center justify-center" data-active={active}>
      <PhoneShell>
        <span className="absolute inset-x-3 bottom-3 top-9 grid grid-cols-3 content-start gap-1.5">
          {Array.from({ length: 9 }, (_, i) => (
            <span key={i} className="aspect-square rounded-[6px] border border-line" />
          ))}
        </span>
        {/* stamped icon (center grid slot) */}
        <span
          data-anim
          className="absolute left-[48px] top-[72px] flex h-7 w-7 items-center justify-center"
          style={{ animationName: 'dv-stamp' }}
        >
          <RingMark size={26} static />
        </span>
      </PhoneShell>
      {/* install banner */}
      <span
        data-anim
        className="absolute left-[calc(50%-75px)] top-[26px] flex h-10 w-[150px] items-center justify-between rounded-xl border border-line bg-bg-2 px-3 shadow-card"
        style={{ animationName: 'dv-banner' }}
      >
        <span className="font-mono text-[0.625rem] tracking-[0.04em] text-ink-2">Install app</span>
        <svg viewBox="0 0 24 24" className="h-5 w-5 -rotate-90">
          <circle cx="12" cy="12" r="10" fill="none" stroke="var(--line)" strokeWidth="2.5" />
          <circle
            data-anim
            cx="12"
            cy="12"
            r="10"
            fill="none"
            stroke="var(--brand)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray="63"
            strokeDashoffset="63"
            style={{ animationName: 'dv-ring' }}
          />
        </svg>
      </span>
    </div>
  );
});

/** Browser loop: URL bar types, then the frame cross-fades into the real Discover screen. */
const BrowserMedia = memo(function BrowserMedia({ active }: { active: boolean }) {
  return (
    <div className="dv-loop relative flex h-[280px] items-center justify-center" data-active={active}>
      <div className="w-full max-w-[340px] overflow-hidden rounded-2xl border border-line bg-bg-2 shadow-card">
        <div className="flex h-10 items-center gap-1.5 border-b border-line px-3.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[rgba(var(--brand-rgb),0.6)]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[rgba(var(--accent-rgb),0.6)]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[rgba(var(--warm-rgb),0.6)]" />
          <span className="ml-2 flex h-6 flex-1 items-center rounded-md bg-bg-0 px-2 font-mono text-[0.6875rem] tracking-[0.02em] text-brand">
            <span data-anim className="inline-block whitespace-nowrap" style={{ animationName: 'dv-web-type' }}>
              http://your-server
            </span>
            <span data-anim className="ml-0.5 inline-block h-[1em] w-[6px] bg-brand" style={{ animationName: 'dv-web-caret' }} />
          </span>
        </div>
        <div className="relative h-[172px]">
          <span className="absolute inset-0 flex items-center justify-center">
            <RingMark size={34} className="opacity-50" />
          </span>
          <img
            data-anim
            src={asset('discover-desktop.png')}
            alt="YAWF Stream Discover screen loading in the browser"
            loading="lazy"
            draggable={false}
            className="absolute inset-0 h-full w-full object-cover opacity-0"
            style={{ animationName: 'dv-web-fade' }}
          />
        </div>
      </div>
    </div>
  );
});

/** Reduced-motion static scenes (final loop state). */
function StaticMedia({ kind }: { kind: 'ios' | 'android' | 'browser' }) {
  if (kind === 'browser') {
    return (
      <div className="relative flex h-[280px] items-center justify-center">
        <div className="w-full max-w-[340px] overflow-hidden rounded-2xl border border-line bg-bg-2 shadow-card">
          <div className="flex h-10 items-center gap-1.5 border-b border-line px-3.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[rgba(var(--brand-rgb),0.6)]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[rgba(var(--accent-rgb),0.6)]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[rgba(var(--warm-rgb),0.6)]" />
            <span className="ml-2 flex h-6 flex-1 items-center rounded-md bg-bg-0 px-2 font-mono text-[0.6875rem] text-brand">
              http://your-server
            </span>
          </div>
          <img src={asset('discover-desktop.png')} alt="YAWF Stream Discover screen in a browser" loading="lazy" className="h-[172px] w-full object-cover" />
        </div>
      </div>
    );
  }
  return (
    <div className="relative flex h-[280px] items-center justify-center">
      <PhoneShell>
        <span className="absolute inset-x-3 bottom-3 top-9 grid grid-cols-3 content-start gap-1.5">
          {Array.from({ length: 9 }, (_, i) => (
            <span key={i} className={cn('aspect-square rounded-[6px]', i === 4 ? 'border border-[rgba(var(--brand-rgb),0.6)]' : 'border border-line')} />
          ))}
        </span>
        <span className="absolute left-[48px] top-[72px] flex h-7 w-7 items-center justify-center">
          <RingMark size={26} static />
        </span>
      </PhoneShell>
    </div>
  );
}

/* ── Copy hint button ─────────────────────────────────────────────── */
function CopyHintButton({ hint }: { hint: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="mt-7 inline-flex items-center gap-2 font-mono text-[0.75rem] tracking-[0.04em] text-ink-3 transition-colors duration-150 hover:text-brand"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-brand" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied ✓' : 'copy install hint'}
    </button>
  );
}

/* ── Chapters ─────────────────────────────────────────────────────── */

interface Chapter {
  id: string;
  title: string;
  steps: string[];
  tip: string;
  hint: string;
  kind: 'ios' | 'android' | 'browser';
}

const CHAPTERS: Chapter[] = [
  {
    id: 'ios',
    title: 'Safari does the honors.',
    steps: [
      'Open your server URL in Safari',
      'Tap Share',
      'Add to Home Screen',
      'Launch YAWF Stream from the icon',
    ],
    tip: 'full-screen, offline shell, your server does the work',
    hint: 'Open server URL in Safari → Share → Add to Home Screen',
    kind: 'ios',
  },
  {
    id: 'android',
    title: 'Chrome or Edge, one banner.',
    steps: [
      'Open your server URL over HTTPS',
      'Tap Install app (or menu → Install)',
      "It's on your home screen",
    ],
    tip: 'Android only offers this from a secure origin, so plain http:// shows no install option',
    hint: 'Open server URL in Chrome/Edge → Install app',
    kind: 'android',
  },
  {
    id: 'browser',
    title: 'Prefer no install at all?',
    steps: [
      'Use the desktop app - or open any browser',
      'Point it at your server URL',
      'Sign in to your profile. Everything else is identical',
    ],
    tip: 'the app IS the website - self-hosted',
    hint: 'Use the desktop app or any browser at your server URL',
    kind: 'browser',
  },
];

function ChapterBlock({ chapter, flip }: { chapter: Chapter; flip: boolean }) {
  const reduced = useReducedMotion() ?? false;
  const mediaRef = useRef<HTMLDivElement>(null);
  const mediaInView = useInView(mediaRef, { amount: 0.35 });
  const words = chapter.title.split(' ');

  return (
    <article id={chapter.id} className="grid scroll-mt-28 items-center gap-10 lg:grid-cols-2 lg:gap-14">
      {/* text */}
      <div className={cn(flip && 'lg:order-2')}>
        <h3 className="display-m font-display">
          {words.map((word, i) => (
            <motion.span
              key={`${word}-${i}`}
              className="inline-block will-change-transform"
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 28, filter: 'blur(6px)' }}
              whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              viewport={{ once: true, amount: 0.75 }}
              transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: i * 0.07 }}
            >
              {word}
              {i < words.length - 1 ? ' ' : ''}
            </motion.span>
          ))}
        </h3>

        <ol className="mt-7 flex flex-col">
          {chapter.steps.map((step, i) => (
            <li key={step} className="relative flex gap-4 pb-5 last:pb-0">
              {/* signal-trace tick between numerals - draws sequentially */}
              {i < chapter.steps.length - 1 && (
                <motion.span
                  aria-hidden="true"
                  className="absolute bottom-0 left-[15px] top-9 w-px origin-top"
                  style={{ backgroundImage: 'linear-gradient(180deg, var(--brand), var(--line))' }}
                  initial={{ scaleY: reduced ? 1 : 0 }}
                  whileInView={{ scaleY: 1 }}
                  viewport={{ once: true, amount: 0.8 }}
                  transition={{ duration: reduced ? 0.2 : 0.4, ease: EASE_EXPO, delay: 0.35 + i * 0.4 }}
                />
              )}
              <motion.span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line-strong bg-[var(--surface-glass)] font-mono text-[0.75rem] text-brand"
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true, amount: 0.8 }}
                transition={
                  reduced
                    ? { duration: 0.2, delay: i * 0.15 }
                    : { type: 'spring', stiffness: 260, damping: 18, delay: 0.15 + i * 0.4 }
                }
              >
                {i + 1}
              </motion.span>
              <motion.p
                className="pt-1 leading-[1.7] text-ink-2"
                initial={reduced ? { opacity: 0 } : { opacity: 0, x: 16 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, amount: 0.8 }}
                transition={{ duration: reduced ? 0.2 : 0.45, ease: EASE_EXPO, delay: 0.2 + i * 0.4 }}
              >
                {step}
              </motion.p>
            </li>
          ))}
        </ol>

        <motion.div
          className="mt-6"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: reduced ? 0 : 0.2 + chapter.steps.length * 0.4 }}
        >
          <Chip variant="instant">{chapter.tip}</Chip>
        </motion.div>

        <CopyHintButton hint={chapter.hint} />
      </div>

      {/* media stage - scale .95→1, y 40→0, 80ms after text */}
      <motion.div
        ref={mediaRef}
        className={cn(flip && 'lg:order-1')}
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 40, scale: 0.95 }}
        whileInView={{ opacity: 1, y: 0, scale: 1 }}
        viewport={{ once: true, amount: 0.35 }}
        transition={{ duration: reduced ? 0.2 : 0.6, ease: EASE_EXPO, delay: 0.08 }}
      >
        <div className="glass-panel relative overflow-hidden rounded-stage p-4 sm:p-6">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-[-30%] h-[60%] opacity-30"
            style={{ background: 'var(--grad-warm)' }}
          />
          {reduced ? (
            <StaticMedia kind={chapter.kind} />
          ) : chapter.kind === 'ios' ? (
            <IosMedia active={mediaInView} />
          ) : chapter.kind === 'android' ? (
            <AndroidMedia active={mediaInView} />
          ) : (
            <BrowserMedia active={mediaInView} />
          )}
        </div>
      </motion.div>
    </article>
  );
}

/**
 * Devices §3 - Install flows: iOS / Android / Desktop browser chapters with
 * looping step illustrations (5s cycles, paused offscreen) + copyable hints.
 */
export default function InstallFlows() {
  return (
    <section id="install-flows" className="relative scroll-mt-20 py-[clamp(88px,12vw,152px)]">
      <style>{LOOP_CSS}</style>
      <div className="mx-auto flex max-w-content flex-col gap-[clamp(88px,11vw,144px)] px-6 md:px-10">
        {CHAPTERS.map((chapter, i) => (
          <ChapterBlock key={chapter.id} chapter={chapter} flip={i % 2 === 1} />
        ))}
      </div>
    </section>
  );
}
