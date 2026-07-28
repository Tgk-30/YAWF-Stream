import { memo, useRef, useState } from 'react';
import { motion, useInView, useReducedMotion } from 'framer-motion';
import { Apple, Check, Copy, Globe, Share, ShieldAlert, Smartphone } from 'lucide-react';
import GlassCard from '@/components/GlassCard';
import RingMark from '@/components/RingMark';
import SectionHeading from '@/components/SectionHeading';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

/* ── Scoped loop keyframes (4s cycles; gated by [data-active] for offscreen pause) ── */
const LOOP_CSS = `
  .dl-loop[data-active='false'] [data-anim] { animation-play-state: paused; }
  .dl-loop [data-anim] { animation-duration: 4s; animation-timing-function: var(--ease-soft); animation-iteration-count: infinite; animation-fill-mode: both; }

  @keyframes dl-share { 0%,8% { transform: translateY(12px); opacity: 0; } 22%,52% { transform: translateY(0); opacity: 1; } 66%,100% { opacity: 0; } }
  @keyframes dl-arc { 0%,30% { stroke-dashoffset: 80; opacity: 0; } 34% { opacity: 1; } 46% { stroke-dashoffset: 0; opacity: 1; } 68%,100% { opacity: 0; } }
  @keyframes dl-stamp { 0%,44% { transform: scale(1.6); opacity: 0; } 54% { transform: scale(0.92); opacity: 1; } 60%,84% { transform: scale(1); opacity: 1; } 94%,100% { transform: scale(1); opacity: 0; } }
  @keyframes dl-slot-glow { 0%,46% { opacity: 0; } 58% { opacity: 1; } 74%,100% { opacity: 0; } }

  @keyframes dl-banner { 0% { transform: translateY(-130%); opacity: 0; } 12%,52% { transform: translateY(0); opacity: 1; } 64%,100% { opacity: 0; } }
  @keyframes dl-ring { 0%,18% { stroke-dashoffset: 63; } 48% { stroke-dashoffset: 0; } 64%,100% { stroke-dashoffset: 0; opacity: 0; } }
  @keyframes dl-grid-stamp { 0%,56% { transform: scale(1.7); opacity: 0; } 66% { transform: scale(0.94); opacity: 1; } 72%,86% { transform: scale(1); opacity: 1; } 96%,100% { opacity: 0; } }

  @keyframes dl-type { 0% { clip-path: inset(0 100% 0 0); animation-timing-function: steps(22, end); } 46%,88% { clip-path: inset(0 0 0 0); } 96%,100% { clip-path: inset(0 100% 0 0); } }
  @keyframes dl-caret { 0%,44% { opacity: 0; } 46%,54% { opacity: 1; } 58%,66% { opacity: 0.15; } 70%,78% { opacity: 1; } 82%,90% { opacity: 0.15; } 94%,100% { opacity: 0; } }
`;

/** iOS loop: share glyph rises, arc draws, Ring Mark stamps into the home-screen slot. */
const IosLoop = memo(function IosLoop({ active }: { active: boolean }) {
  return (
    <div className="dl-loop relative h-40" data-active={active}>
      {/* phone outline */}
      <div className="absolute left-1/2 top-1/2 h-[136px] w-[76px] -translate-x-1/2 -translate-y-1/2 rounded-[20px] border border-line bg-bg-2">
        <span className="absolute left-1/2 top-2 h-1 w-6 -translate-x-1/2 rounded-full bg-[var(--line)]" />
      </div>
      {/* share glyph rising */}
      <span
        data-anim
        className="absolute left-[calc(50%-16px)] top-[62%] flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-bg-2 text-accent2"
        style={{ animationName: 'dl-share' }}
      >
        <Share className="h-3.5 w-3.5" />
      </span>
      {/* dashed home-screen slot */}
      <span className="absolute left-[calc(50%+34px)] top-[8%] flex h-9 w-9 items-center justify-center rounded-xl border border-dashed border-line-strong">
        <span
          data-anim
          className="absolute inset-0 rounded-xl bg-[rgba(var(--brand-rgb),0.25)] blur-md"
          style={{ animationName: 'dl-slot-glow' }}
        />
        <span data-anim className="flex items-center justify-center" style={{ animationName: 'dl-stamp' }}>
          <RingMark size={26} static />
        </span>
      </span>
      {/* arc from share glyph to slot */}
      <svg aria-hidden="true" className="absolute left-1/2 top-[18%] h-16 w-20 -translate-x-[6px]" viewBox="0 0 80 64" fill="none">
        <path
          data-anim
          d="M6 58 C 10 30, 40 26, 62 10"
          stroke="var(--brand)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray="80"
          strokeDashoffset="80"
          style={{ animationName: 'dl-arc' }}
        />
      </svg>
    </div>
  );
});

/** Android loop: install banner slides down, ring fills, icon stamps onto the grid. */
const AndroidLoop = memo(function AndroidLoop({ active }: { active: boolean }) {
  return (
    <div className="dl-loop relative h-40" data-active={active}>
      <div className="absolute left-1/2 top-1/2 h-[136px] w-[76px] -translate-x-1/2 -translate-y-1/2 rounded-[20px] border border-line bg-bg-2">
        {/* home grid dots */}
        <span className="absolute inset-x-3 bottom-3 top-9 grid grid-cols-3 content-start gap-1.5">
          {Array.from({ length: 9 }, (_, i) => (
            <span key={i} className="aspect-square rounded-[4px] border border-line" />
          ))}
        </span>
        {/* stamped icon (center grid slot) */}
        <span
          data-anim
          className="absolute left-[29px] top-[53px] flex h-[18px] w-[18px] items-center justify-center"
          style={{ animationName: 'dl-grid-stamp' }}
        >
          <RingMark size={18} static />
        </span>
      </div>
      {/* install banner */}
      <span
        data-anim
        className="absolute left-[calc(50%-52px)] top-[6%] flex h-8 w-[104px] items-center justify-between rounded-lg border border-line bg-bg-2 px-2.5 shadow-card"
        style={{ animationName: 'dl-banner' }}
      >
        <span className="font-mono text-[0.5625rem] tracking-[0.04em] text-ink-2">Install app</span>
        <svg viewBox="0 0 24 24" className="h-4 w-4 -rotate-90">
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
            style={{ animationName: 'dl-ring' }}
          />
        </svg>
      </span>
    </div>
  );
});

/** Desktop loop: mini URL bar types the server address with a blinking caret. */
const DesktopLoop = memo(function DesktopLoop({ active }: { active: boolean }) {
  return (
    <div className="dl-loop relative flex h-40 items-center justify-center" data-active={active}>
      <div className="w-full max-w-[240px] overflow-hidden rounded-2xl border border-line bg-bg-2 shadow-card">
        <div className="flex h-9 items-center gap-1.5 border-b border-line px-3">
          <span className="h-2 w-2 rounded-full bg-[rgba(var(--brand-rgb),0.6)]" />
          <span className="h-2 w-2 rounded-full bg-[rgba(var(--accent-rgb),0.6)]" />
          <span className="h-2 w-2 rounded-full bg-[rgba(var(--warm-rgb),0.6)]" />
          <span className="ml-2 flex h-6 flex-1 items-center rounded-md bg-bg-0 px-2 font-mono text-[0.6875rem] tracking-[0.02em] text-brand">
            <span data-anim className="inline-block whitespace-nowrap" style={{ animationName: 'dl-type' }}>
              http://your-server:43110
            </span>
            <span data-anim className="ml-0.5 inline-block h-[1em] w-[6px] bg-brand" style={{ animationName: 'dl-caret' }} />
          </span>
        </div>
        <div className="flex h-14 items-center justify-center">
          <RingMark size={22} className="opacity-70" />
        </div>
      </div>
    </div>
  );
});

/** Reduced-motion static scene per platform. */
function StaticScene({ kind }: { kind: 'ios' | 'android' | 'desktop' }) {
  if (kind === 'desktop') {
    return (
      <div className="relative flex h-40 items-center justify-center">
        <div className="w-full max-w-[240px] overflow-hidden rounded-2xl border border-line bg-bg-2">
          <div className="flex h-9 items-center gap-1.5 border-b border-line px-3">
            <span className="h-2 w-2 rounded-full bg-[rgba(var(--brand-rgb),0.6)]" />
            <span className="h-2 w-2 rounded-full bg-[rgba(var(--accent-rgb),0.6)]" />
            <span className="h-2 w-2 rounded-full bg-[rgba(var(--warm-rgb),0.6)]" />
            <span className="ml-2 flex h-6 flex-1 items-center truncate rounded-md bg-bg-0 px-2 font-mono text-[0.6875rem] text-brand">
              http://your-server:43110
            </span>
          </div>
          <div className="flex h-14 items-center justify-center">
            <RingMark size={22} className="opacity-70" />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="relative h-40">
      <div className="absolute left-1/2 top-1/2 flex h-[136px] w-[76px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[20px] border border-line bg-bg-2">
        <RingMark size={30} static />
      </div>
    </div>
  );
}

/* ── Copy hint button ─────────────────────────────────────────────── */
function CopyHint({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
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
      className="mt-auto inline-flex items-center gap-2 pt-5 font-mono text-[0.75rem] tracking-[0.04em] text-ink-3 transition-colors duration-150 hover:text-brand"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-brand" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied ✓' : text}
    </button>
  );
}

const STEPS = [
  {
    index: '01',
    icon: Apple,
    title: 'iPhone / iPad',
    body: 'Open your server URL in Safari → Share → Add to Home Screen.',
    hint: 'Share → Add to Home Screen',
    kind: 'ios' as const,
  },
  {
    index: '02',
    icon: Smartphone,
    title: 'Android',
    body: 'Open your server URL over HTTPS in Chrome or Edge → Install app. Android hides the install option on a plain-HTTP address.',
    hint: 'Install app',
    kind: 'android' as const,
  },
  {
    index: '03',
    icon: Globe,
    title: 'Desktop browser',
    body: 'Use the desktop app - or just point any browser at your server URL.',
    hint: 'http://your-server:43110',
    kind: 'desktop' as const,
  },
];

/**
 * Download §4 - PWA install steps: three step cards with looping mini
 * illustrations (4s cycles, paused offscreen), ghost numerals, copy hints.
 */
export default function PwaSteps() {
  const reduced = useReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);
  const stageInView = useInView(stageRef, { amount: 0.3 });

  return (
    <section className="relative py-[clamp(88px,12vw,152px)]">
      <style>{LOOP_CSS}</style>
      <div className="mx-auto max-w-content px-6 md:px-10">
        <SectionHeading
          eyebrow="// PHONE & TABLET"
          title="No app store. Your server is the store."
          lede="The PWA is served by your own YAWF Stream server - install it straight from the browser."
        />

        <div ref={stageRef} className="mt-12 grid gap-5 md:grid-cols-3">
          {STEPS.map((step, i) => {
            const Icon = step.icon;
            return (
              <motion.div
                key={step.index}
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 40, filter: 'blur(8px)' }}
                whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                viewport={{ once: true, amount: 0.4 }}
                transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: i * 0.12 }}
              >
                <GlassCard className="relative flex h-full flex-col overflow-hidden p-6">
                  {/* ghost numeral + signal-trace underline */}
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute -top-3 right-3 font-display text-[6rem] font-bold leading-none text-[rgba(var(--ink-1-rgb),0.05)]"
                  >
                    {step.index}
                  </span>
                  <motion.span
                    aria-hidden="true"
                    className="absolute left-6 top-[4.9rem] h-px w-16 origin-left"
                    style={{ backgroundImage: 'linear-gradient(90deg, var(--brand), transparent)' }}
                    initial={{ scaleX: reduced ? 1 : 0 }}
                    whileInView={{ scaleX: 1 }}
                    viewport={{ once: true, amount: 0.6 }}
                    transition={{ duration: reduced ? 0.2 : 0.7, ease: EASE_EXPO, delay: i * 0.12 + 0.35 }}
                  />

                  <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-bg-2 text-brand">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h3 className="display-s mt-4 font-display">{step.title}</h3>
                  <p className="mt-2 text-[0.95rem] leading-[1.7] text-ink-2">{step.body}</p>

                  <div className="mt-2">
                    {reduced ? (
                      <StaticScene kind={step.kind} />
                    ) : step.kind === 'ios' ? (
                      <IosLoop active={stageInView} />
                    ) : step.kind === 'android' ? (
                      <AndroidLoop active={stageInView} />
                    ) : (
                      <DesktopLoop active={stageInView} />
                    )}
                  </div>

                  <CopyHint text={step.hint} />
                </GlassCard>
              </motion.div>
            );
          })}
        </div>

        <div className="mt-8 rounded-row border border-line bg-[var(--surface-glass)] p-5">
          <p className="flex items-start gap-3 text-[0.95rem] leading-[1.7] text-ink-2">
            <ShieldAlert className="mt-1 h-4 w-4 shrink-0 text-brand" />
            <span>
              <span className="text-ink-1">Android needs HTTPS.</span> Chrome only offers to install a
              site from a secure origin, and a plain <span className="font-mono text-[0.85em]">http://</span>{' '}
              LAN address is not one. Reach your server over HTTPS through the bundled Caddy compose
              file, a Tailscale name, or any tunnel that terminates TLS, and the install option
              appears. iPhone and iPad are unaffected: Add to Home Screen works either way.
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}
