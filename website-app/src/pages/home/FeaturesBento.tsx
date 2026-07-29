import type { CSSProperties } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Captions, Compass, History, ListVideo, MonitorPlay, ShieldCheck, Users, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import GlassCard from '@/components/GlassCard';
import SectionHeading from '@/components/SectionHeading';
import { asset } from '@/lib/asset';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

/** Animated resume bar - stream-fill from left, 900ms expo, glowing head dot. */
function ResumeBar({ value, delay = 0 }: { value: number; delay?: number }) {
  const reduced = useReducedMotion();
  return (
    <div className="stream-fill">
      <motion.span
        initial={{ scaleX: 0, opacity: reduced ? 0 : 1 }}
        whileInView={{ scaleX: value, opacity: 1 }}
        viewport={{ once: true, amount: 0.8 }}
        transition={{ duration: reduced ? 0.2 : 0.9, ease: EASE_EXPO, delay }}
        style={{ transformOrigin: 'left' }}
      />
    </div>
  );
}

/** Mini poster strip - continuous CSS marquee inside the Discover card. */
function MiniMarquee() {
  const posters = Array.from({ length: 8 }, (_, i) => asset(`poster-0${i + 1}.jpg`));
  return (
    <div className="marquee mt-5" aria-hidden="true">
      <div
        className="marquee-track gap-2.5 pr-2.5"
        style={{ '--marquee-duration': '32s' } as CSSProperties}
      >
        {[...posters, ...posters].map((src, i) => (
          <img
            key={`${src}-${i}`}
            src={src}
            alt=""
            loading="lazy"
            draggable={false}
            className="aspect-[2/3] w-14 shrink-0 rounded-md border border-line object-cover md:w-16"
          />
        ))}
      </div>
    </div>
  );
}

/** Mini provider constellation - 4 nodes beam packets into the cache core. */
function MiniConstellation() {
  const nodes = [
    { x: 18, y: 16 },
    { x: 142, y: 14 },
    { x: 14, y: 82 },
    { x: 146, y: 86 },
  ];
  const c = { x: 80, y: 50 };
  return (
    <svg viewBox="0 0 160 100" className="mt-4 w-full" aria-hidden="true">
      {nodes.map((n, i) => (
        <g key={i}>
          <line
            x1={n.x}
            y1={n.y}
            x2={c.x}
            y2={c.y}
            stroke="var(--line-strong)"
            strokeWidth="1"
            strokeDasharray="3 5"
            className="dash-flow"
          />
          <circle r="2.2" fill="var(--warm)">
            <animateMotion dur={`${2 + i * 0.45}s`} repeatCount="indefinite" path={`M ${n.x} ${n.y} L ${c.x} ${c.y}`} />
          </circle>
          <circle cx={n.x} cy={n.y} r="5" fill="var(--bg-2)" stroke="var(--brand)" strokeWidth="1.2" />
        </g>
      ))}
      <circle cx={c.x} cy={c.y} r="14" fill="none" stroke="var(--brand)" strokeOpacity="0.3" />
      <circle cx={c.x} cy={c.y} r="8" fill="var(--brand)" style={{ filter: 'drop-shadow(0 0 8px var(--brand))' }} />
    </svg>
  );
}

interface BentoCard {
  id: string;
  icon: typeof Compass;
  title: string;
  copy: string;
  tag: string;
  span: string;
  widget?: 'marquee' | 'constellation' | 'specs' | 'series' | 'resume' | 'avatars' | 'subs';
}

const CARDS: BentoCard[] = [
  {
    id: 'discover',
    icon: Compass,
    title: 'Discover',
    copy: 'Trending rows, cinematic detail pages, a release calendar - powered by TMDB artwork.',
    tag: 'TMDB artwork',
    span: 'sm:col-span-2 lg:col-span-4 lg:row-span-2',
    widget: 'marquee',
  },
  {
    id: 'playback',
    icon: Zap,
    title: 'Playback',
    copy: 'Real-Debrid, AllDebrid, Premiumize, TorBox - cached streams converge into one tap.',
    tag: '4 providers',
    span: 'lg:col-span-2 lg:row-span-2',
    widget: 'constellation',
  },
  {
    id: 'player',
    icon: MonitorPlay,
    title: 'Player',
    copy: 'A built-in player that handles anything - and hands off to VLC / IINA when you want.',
    tag: 'nothing to install',
    span: 'lg:col-span-2 lg:row-span-2',
    widget: 'specs',
  },
  {
    id: 'privacy',
    icon: ShieldCheck,
    title: 'Privacy',
    copy: 'Full Local & Offline modes - no telemetry, ever.',
    tag: 'zero telemetry',
    span: 'lg:col-span-2',
  },
  {
    id: 'series',
    icon: ListVideo,
    title: 'Series',
    copy: 'Episode tracking with stills, progress, and next-up picks.',
    tag: 'next-up',
    span: 'lg:col-span-2',
    widget: 'series',
  },
  {
    id: 'profiles',
    icon: Users,
    title: 'Profiles',
    copy: 'A library per person - optional passwords, kids mode.',
    tag: 'whole house',
    span: 'lg:col-span-2',
    widget: 'avatars',
  },
  {
    id: 'continue',
    icon: History,
    title: 'Continue',
    copy: 'Watchlist, history, resume. Import from IMDb or Letterboxd.',
    tag: 'IMDb · Letterboxd',
    span: 'sm:col-span-2 lg:col-span-4',
    widget: 'resume',
  },
  {
    id: 'subtitles',
    icon: Captions,
    title: 'Subtitles',
    copy: 'OpenSubtitles search and complete styling control.',
    tag: 'styled your way',
    span: 'lg:col-span-2',
    widget: 'subs',
  },
];

function Widget({ kind }: { kind?: BentoCard['widget'] }) {
  switch (kind) {
    case 'marquee':
      return <MiniMarquee />;
    case 'constellation':
      return <MiniConstellation />;
    case 'specs':
      return (
        <div className="mt-4 flex flex-wrap gap-2">
          {['MKV', 'HEVC', '4K', 'instant seek', 'subtitle styling'].map((s) => (
            <span
              key={s}
              className="rounded-md border border-line bg-bg-0 px-2 py-1 font-mono text-[0.75rem] tracking-[0.04em] text-ink-2"
            >
              {s}
            </span>
          ))}
        </div>
      );
    case 'series':
      return (
        <div className="mt-4 space-y-3">
          <div className="flex gap-2.5">
            {[asset('poster-03.jpg'), asset('poster-06.jpg')].map((src) => (
              <img key={src} src={src} alt="" loading="lazy" className="aspect-[2/3] w-10 rounded-md border border-line object-cover" />
            ))}
          </div>
          <ResumeBar value={0.62} />
        </div>
      );
    case 'resume':
      return (
        <div className="mt-4 grid gap-3 sm:grid-cols-3 sm:gap-5">
          {[0.74, 0.38, 0.52].map((v, i) => (
            <ResumeBar key={v} value={v} delay={0.15 + i * 0.12} />
          ))}
        </div>
      );
    case 'avatars':
      return (
        <div className="mt-4 flex -space-x-2">
          {['var(--brand)', 'var(--accent)', 'var(--warm)', 'var(--brand-deep)'].map((color, i) => (
            <span
              key={color}
              className="flex h-8 w-8 items-center justify-center rounded-full border-2 bg-bg-2 font-mono text-[0.6875rem] text-ink-1"
              style={{ borderColor: color }}
            >
              {['A', 'S', 'K', 'G'][i]}
            </span>
          ))}
        </div>
      );
    case 'subs':
      return (
        <div className="mt-4">
          <span className="inline-block rounded-md border border-line bg-bg-0 px-3 py-1.5 font-body text-[0.85rem] font-semibold text-ink-1 [text-shadow:0_1px_2px_rgba(0,0,0,0.9)]">
            Styled your way
          </span>
        </div>
      );
    default:
      return null;
  }
}

/** Section 4 - Features bento: 9-feature preview grid linking to /features. */
export default function FeaturesBento() {
  const reduced = useReducedMotion();

  return (
    <section className="relative py-[clamp(88px,12vw,152px)]">
      <div className="mx-auto max-w-content px-6 md:px-10">
        <SectionHeading
          eyebrow="// FEATURES"
          title="Everything a streamer should be."
          lede="Nine reasons your server becomes the best screen in the house."
          link={{ to: '/features', label: 'All features' }}
        />

        <div className="mt-14 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-6">
          {CARDS.map((card, i) => {
            const Icon = card.icon;
            return (
              <motion.div
                key={card.id}
                className={cn(card.span)}
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 40, filter: 'blur(8px)' }}
                whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                viewport={{ once: true, amount: 0.25 }}
                transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: i * 0.07 }}
              >
                <GlassCard to={`/features#${card.id}`} className="flex h-full flex-col">
                  <Icon
                    className="h-6 w-6 text-brand transition-[filter] duration-200 group-hover:[filter:drop-shadow(0_0_8px_rgba(var(--brand-rgb),0.55))]"
                    strokeWidth={1.5}
                  />
                  <h3 className="display-s mt-4 font-display">{card.title}</h3>
                  <p className="mt-2 font-body text-[0.95rem] leading-[1.7] text-ink-2">{card.copy}</p>
                  <Widget kind={card.widget} />
                  <p className="mt-auto pt-4 font-mono text-[0.75rem] tracking-[0.04em] text-ink-3">{card.tag}</p>
                </GlassCard>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
