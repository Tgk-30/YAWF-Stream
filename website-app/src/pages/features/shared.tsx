import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';
import Chip from '@/components/Chip';

export const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];
export const SPRING_UI = { type: 'spring', stiffness: 170, damping: 22 } as const;

export interface ChapterDef {
  id: string;
  nav: string;
  title: string;
  copy: string;
  chips: string[];
}

export const CHAPTERS: ChapterDef[] = [
  {
    id: 'discover',
    nav: 'Discover',
    title: 'Find it before the group chat does.',
    copy: "Browse and search with TMDB: trending rows, cinematic detail pages, and a release calendar that tells you what's coming - before your group chat does.",
    chips: ['TMDB artwork', 'trending rows', 'release calendar', 'search'],
  },
  {
    id: 'privacy',
    nav: 'Privacy',
    title: 'Goes as quiet as you want it.',
    copy: 'Full Local and Offline modes. No telemetry, no update checks in Offline - the app goes as quiet as you want it. Your server, your debrid keys, your data.',
    chips: ['Full Local mode', 'Offline mode', 'zero telemetry', 'no update checks'],
  },
  {
    id: 'profiles',
    nav: 'Profiles',
    title: 'Everyone gets their own seat.',
    copy: 'Everyone gets their own library, history, and watchlist - with an optional household password per profile. The server operator can administer profiles and view operational activity.',
    chips: ['own watchlist + history', 'optional password', 'per-profile overrides'],
  },
  {
    id: 'playback',
    nav: 'Playback',
    title: "Cached means it's already playing.",
    copy: "YAWF Stream checks the caches across all four providers - plus any sources you add - and plays what's already cached. If it's instant, it just starts.",
    chips: ['Real-Debrid', 'AllDebrid', 'Premiumize', 'TorBox', '+ your sources'],
  },
  {
    id: 'player',
    nav: 'Player',
    title: 'Plays everything, installs nothing.',
    copy: 'A real built-in player: MKV, HEVC, 4K, instant seeking, and subtitle styling - no external codecs, nothing to install. Prefer your own? Hand off to VLC or IINA in one click.',
    chips: ['MKV', 'HEVC', '4K', 'instant seek', 'subtitle styling', 'VLC / IINA handoff'],
  },
  {
    id: 'series',
    nav: 'Series',
    title: 'An episode picker that respects your time.',
    copy: 'Stills for every episode, resume bars where you left off, watched marks, and auto-play next when one ends.',
    chips: ['episode stills', 'resume bars', 'watched marks', 'auto-play next'],
  },
  {
    id: 'subtitles',
    nav: 'Subtitles',
    title: 'Subtitles that fit the film.',
    copy: 'OpenSubtitles search built in with size, color, background, language, and timing controls right in the web player.',
    chips: ['OpenSubtitles', 'size controls', 'colors', 'timing'],
  },
  {
    id: 'continue',
    nav: 'Continue',
    title: 'Picks up exactly where you left off.',
    copy: 'Watchlist, history, and resume that actually follow you. Import everything from IMDb or Letterboxd, and see your year in watching with built-in stats.',
    chips: ['watchlist + history', 'resume everywhere', 'IMDb import', 'Letterboxd import', 'watch stats'],
  },
];

/* ── StreamBar - stream-fill progress with glowing head dot ──────────── */

interface StreamBarProps {
  /** 0..1 */
  value: number;
  delay?: number;
  className?: string;
  /** animate when scrolled into view (once); default: animate on value change */
  inView?: boolean;
}

export function StreamBar({ value, delay = 0, className, inView = false }: StreamBarProps) {
  const reduced = useReducedMotion();
  const transition = { duration: reduced ? 0.2 : 0.9, ease: EASE_EXPO, delay: reduced ? 0 : delay };
  return (
    <div className={cn('relative h-0.5 rounded-full bg-line', className)}>
      <motion.div
        className="absolute inset-y-0 left-0 w-full origin-left rounded-full"
        style={{ backgroundImage: 'var(--grad-stream)' }}
        initial={{ scaleX: 0 }}
        {...(inView
          ? { whileInView: { scaleX: value }, viewport: { once: true, amount: 0.6 } }
          : { animate: { scaleX: value } })}
        transition={transition}
      >
        <span className="absolute -right-[3px] top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-brand shadow-glow-brand" />
      </motion.div>
    </div>
  );
}

/* ── Stage - glass demo stage card ───────────────────────────────────── */

export function Stage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('glass-panel relative min-h-[420px] overflow-hidden rounded-stage shadow-card', className)}>
      {children}
    </div>
  );
}

/* ── Chapter - alternating split layout with cinematic entrance ──────── */

interface ChapterProps extends ChapterDef {
  /** 1-based chapter number; odd = media right, even = media left */
  index: number;
  children: ReactNode;
}

export function Chapter({ index, id, title, copy, chips, children }: ChapterProps) {
  const reduced = useReducedMotion();
  const mediaRight = index % 2 === 1;

  return (
    <section id={id} className="scroll-mt-[150px]" aria-label={`${title} - chapter ${index}`}>
      {/* min-w-0 on both children below: a grid track is `auto`, which means
          max-content, so a max-content marquee or a row of shrink-0 cards
          widens the column and scrolls the whole page sideways on a phone. */}
      <div className="grid min-h-[80vh] items-center gap-10 lg:grid-cols-2 lg:gap-16">
        {/* text block */}
        <motion.div
          className={cn('min-w-0', mediaRight ? 'lg:order-1' : 'lg:order-2')}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 40, filter: 'blur(8px)' }}
          whileInView={reduced ? { opacity: 1 } : { opacity: 1, y: 0, filter: 'blur(0px)' }}
          viewport={{ once: true, amount: 0.35 }}
          transition={{ duration: reduced ? 0.2 : 0.6, ease: EASE_EXPO }}
        >
          <p className="eyebrow">{'// '}{String(index).padStart(2, '0')}</p>

          {/* signal-trace hairline connecting index chip to stage */}
          <div className="mt-3 flex items-center gap-2" aria-hidden="true">
            <motion.span
              className="block h-px w-[120px] origin-left"
              style={{ backgroundImage: 'var(--grad-stream)' }}
              initial={{ scaleX: 0 }}
              whileInView={{ scaleX: 1 }}
              viewport={{ once: true, amount: 0.8 }}
              transition={{ duration: reduced ? 0.2 : 0.7, ease: EASE_EXPO, delay: 0.15 }}
            />
            <span className="h-1 w-1 rounded-full bg-brand shadow-glow-brand" />
          </div>

          <h3 className="display-m mt-5 font-display">{title}</h3>
          <p className="mt-4 max-w-[52ch] text-[1rem] leading-[1.7] text-ink-2">{copy}</p>
          <div className="mt-6 flex flex-wrap gap-2">
            {chips.map((chip) => (
              <Chip key={chip}>{chip}</Chip>
            ))}
          </div>
        </motion.div>

        {/* media block */}
        <motion.div
          className={cn('min-w-0', mediaRight ? 'lg:order-2' : 'lg:order-1')}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 32, scale: 0.96 }}
          whileInView={{ opacity: 1, y: 0, scale: 1 }}
          viewport={{ once: true, amount: 0.25 }}
          transition={{ duration: reduced ? 0.2 : 0.6, ease: EASE_EXPO, delay: reduced ? 0 : 0.08 }}
        >
          {children}
        </motion.div>
      </div>
    </section>
  );
}
