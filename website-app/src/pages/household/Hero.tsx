import { useRef } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Lock } from 'lucide-react';
import { gsap, useGSAP } from '@/lib/gsap';
import { THEME_PRESETS, useThemePreset } from '@/theme.config';
import BackgroundVideo from '@/components/BackgroundVideo';
import Chip from '@/components/Chip';
import { asset } from '@/lib/asset';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

/** Chars wrapped in overflow-hidden masks for the cascade (parent carries text styles). */
function CascadeChars({ text }: { text: string }) {
  return (
    <>
      {[...text].map((c, i) => (
        <span key={i} className="char-mask" aria-hidden="true">
          <span className={c === ' ' ? 'char char-space' : 'char'}>{c === ' ' ? '\u00a0' : c}</span>
        </span>
      ))}
    </>
  );
}

interface AvatarSpec {
  name: string;
  role: string;
  /** CSS color for the ring */
  ring: string;
  lock?: boolean;
  capped?: boolean;
}

function AvatarChip({ spec, index }: { spec: AvatarSpec; index: number }) {
  const reduced = useReducedMotion();
  const delay = 1.0 + index * 0.11;
  return (
    <motion.div
      className="group/av relative flex items-center gap-2.5"
      tabIndex={0}
      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.5 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={
        reduced ? { duration: 0.2, delay: 0.2 } : { type: 'spring', stiffness: 170, damping: 22, delay }
      }
    >
      <span className="relative block h-11 w-11">
        {/* ring draws on entry */}
        <svg viewBox="0 0 48 48" className="absolute -inset-[3px] h-[54px] w-[54px]" aria-hidden="true">
          <motion.circle
            cx="24"
            cy="24"
            r="21"
            fill="none"
            stroke={spec.ring}
            strokeWidth="2"
            strokeLinecap="round"
            initial={{ pathLength: reduced ? 1 : 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.5, ease: 'easeOut', delay: reduced ? 0 : delay + 0.15 }}
          />
        </svg>
        <span className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-bg-2 font-display text-[0.85rem] font-semibold text-ink-1">
          {spec.name.slice(0, 1)}
        </span>
        {spec.lock && (
          <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border border-[rgba(var(--warm-rgb),0.5)] bg-bg-1 text-warm opacity-0 shadow-glow-warm transition-opacity duration-200 group-hover/av:opacity-100 group-focus-visible/av:opacity-100">
            <Lock className="h-2.5 w-2.5" />
          </span>
        )}
      </span>
      <span className="hidden flex-col sm:flex">
        <span className="flex items-center gap-2 font-body text-[0.875rem] font-semibold leading-[1.3] text-ink-1">
          {spec.name}
          {spec.capped && (
            <Chip variant="warm" className="px-2 py-0.5 text-[0.625rem]">
              capped
            </Chip>
          )}
        </span>
        <span className="font-mono text-[0.6875rem] leading-[1.4] tracking-[0.04em] text-ink-3">{spec.role}</span>
      </span>
      {/* role tooltip */}
      <span className="pointer-events-none absolute -top-2 left-1/2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-row border border-line bg-bg-1 px-2.5 py-1 font-mono text-[0.6875rem] tracking-[0.04em] text-ink-2 opacity-0 shadow-card transition-opacity duration-200 group-hover/av:opacity-100 group-focus-visible/av:opacity-100">
        {spec.name} - {spec.role}
      </span>
    </motion.div>
  );
}

/**
 * Section 1 - Household hero: living-room art over cinema-grain video,
 * clip-path wipe reveal, char cascade, avatar row with ring draws.
 */
export default function Hero() {
  const reduced = useReducedMotion();
  const preset = useThemePreset();
  const sectionRef = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      if (reduced) return;
      const q = gsap.utils.selector(sectionRef);
      const tl = gsap.timeline({ delay: 0.15, defaults: { ease: 'expo.out' } });
      tl.from(q('.hero-eyebrow'), { opacity: 0, duration: 0.6 }, 0.1)
        .fromTo(
          q('.hero-line-1 .char'),
          { yPercent: 110, rotate: 4 },
          { yPercent: 0, rotate: 0, duration: 1.1, stagger: 0.022 },
          0.35,
        )
        .fromTo(
          q('.hero-line-2 .char'),
          { yPercent: 110, rotate: 4 },
          { yPercent: 0, rotate: 0, duration: 1.1, stagger: 0.022 },
          0.5,
        )
        .from(q('.hero-lede'), { y: 24, opacity: 0, filter: 'blur(6px)', duration: 0.7 }, 0.85);
    },
    { scope: sectionRef, dependencies: [reduced] },
  );

  const AVATARS: AvatarSpec[] = [
    { name: 'Alex', role: 'Admin', ring: 'var(--brand)' },
    { name: 'Sam', role: 'Member', ring: 'var(--accent)' },
    { name: 'Maya', role: 'Member', ring: THEME_PRESETS[preset].gradThird },
    { name: 'Kids', role: 'Restricted · 13+ cap', ring: 'var(--warm)', lock: true, capped: true },
    { name: 'Guest', role: 'Guest', ring: 'var(--ink-3)' },
  ];

  return (
    <section
      ref={sectionRef}
      className="relative -mt-[var(--nav-offset)] flex min-h-[max(62vh,580px)] items-center overflow-hidden pt-[var(--nav-offset)]"
    >
      {/* cinema-grain video behind the room art (25%, screen blend) */}
      <BackgroundVideo src={asset('cinema-grain-loop.mp4')} poster={asset('cinema-grain-poster.jpg')} opacity={0.25} />

      {/* right - living-room art bleeding to edge, wiped in from the right */}
      <motion.div
        aria-hidden="true"
        className="absolute inset-y-0 right-0 hidden w-[58%] md:block"
        initial={reduced ? { opacity: 0 } : { clipPath: 'inset(0 0 0 100%)', scale: 1.06 }}
        animate={reduced ? { opacity: 1 } : { clipPath: 'inset(0 0 0 0%)', scale: 1 }}
        transition={{ duration: 1.1, ease: EASE_EXPO, delay: 0.2 }}
      >
        <img
          src={asset('living-room-glow.jpg')}
          alt=""
          className="h-full w-full object-cover"
          style={{
            maskImage:
              'linear-gradient(90deg, transparent 0%, #000 34%), linear-gradient(180deg, #000 62%, transparent 100%)',
            maskComposite: 'intersect',
            WebkitMaskImage:
              'linear-gradient(90deg, transparent 0%, #000 34%), linear-gradient(180deg, #000 62%, transparent 100%)',
            WebkitMaskComposite: 'source-in',
          }}
        />
      </motion.div>
      {/* mobile top banner */}
      <motion.div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-[240px] md:hidden"
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.5 }}
        transition={{ duration: 0.8 }}
        style={{
          backgroundImage: `url(${asset('living-room-glow.jpg')})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          maskImage: 'linear-gradient(180deg, #000 0%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(180deg, #000 0%, transparent 100%)',
        }}
      />
      <div aria-hidden="true" className="absolute inset-0" style={{ background: 'var(--grad-hero-scrim)' }} />

      {/* left - content */}
      <div className="relative z-10 mx-auto w-full max-w-content px-6 py-24 md:px-10">
        <div className="max-w-[620px]">
          <p className="hero-eyebrow eyebrow">{'// HOUSEHOLD'}</p>

          <h1 aria-label="Profiles for the whole house." className="display-xl mt-6 font-display">
            <span className="hero-line-1 block" aria-hidden="true">
              <CascadeChars text="Profiles for the" />
            </span>
            <span
              className="hero-line-2 sheen-once block text-gradient"
              style={{ animationDelay: '1.1s' }}
              aria-hidden="true"
            >
              <CascadeChars text="whole house." />
            </span>
          </h1>

          <p className="hero-lede lede mt-7 max-w-[560px]">
            One server, every person. Personal watchlists, histories, and resume points - plus the controls that make
            a shared screen safe for the smallest viewers.
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-x-5 gap-y-4">
            {AVATARS.map((a, i) => (
              <AvatarChip key={a.name} spec={a} index={i} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
