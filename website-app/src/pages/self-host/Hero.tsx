import { memo, useRef } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { gsap, useGSAP } from '@/lib/gsap';
import BackgroundVideo from '@/components/BackgroundVideo';
import { asset } from '@/lib/asset';

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

const HOSTS = ['always-on desktop', 'NAS', 'VPS', 'Raspberry Pi', 'home server'];

/** Gentle ±4px float, 5–7s sine offsets - isolated so loops don't re-render the hero. */
const FloatingChip = memo(function FloatingChip({ label, index }: { label: string; index: number }) {
  const reduced = useReducedMotion();
  return (
    // GSAP owns the entrance on .host-chip; framer owns the float loop on the inner span
    <span className="host-chip inline-block">
      <motion.span
        className="inline-block"
        animate={reduced ? undefined : { y: [0, -4, 0, 4, 0] }}
        transition={{ duration: 5 + index * 0.5, repeat: Infinity, ease: 'easeInOut', delay: index * 0.35 }}
      >
        <span className="border-beam inline-flex items-center gap-2 rounded-chip border border-line bg-[var(--surface-glass)] px-3.5 py-2 font-mono text-[0.75rem] leading-none tracking-[0.04em] text-ink-2 backdrop-blur-sm">
          {label}
        </span>
      </motion.span>
    </span>
  );
});

/**
 * Section 1 - Page hero: 58vh, nebula video band (30% + scrim, 0.25× parallax),
 * char-cascade headline, floating host chips.
 */
export default function Hero() {
  const reduced = useReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);
  const videoWrapRef = useRef<HTMLDivElement>(null);

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
        .from(q('.hero-lede'), { y: 24, opacity: 0, filter: 'blur(6px)', duration: 0.7 }, 0.85)
        .from(q('.host-chip'), { y: 16, opacity: 0, duration: 0.5, stagger: 0.07 }, 1.0);

      // nebula parallax 0.25×
      gsap.fromTo(
        videoWrapRef.current,
        { yPercent: -12 },
        {
          yPercent: 12,
          ease: 'none',
          scrollTrigger: { trigger: sectionRef.current, start: 'top top', end: 'bottom top', scrub: 0.6 },
        },
      );
    },
    { scope: sectionRef, dependencies: [reduced] },
  );

  return (
    <section
      ref={sectionRef}
      className="relative -mt-[var(--nav-offset)] flex min-h-[max(58vh,540px)] items-center justify-center overflow-hidden pt-[var(--nav-offset)]"
    >
      {/* nebula band (30% opacity, poster fallback) + parallax wrap */}
      <div ref={videoWrapRef} className="absolute -inset-y-[14%] inset-x-0">
        <BackgroundVideo src={asset('nebula-drift-loop.mp4')} poster={asset('nebula-drift-poster.jpg')} opacity={0.3} />
      </div>
      <div aria-hidden="true" className="absolute inset-0" style={{ background: 'var(--grad-hero-scrim)' }} />

      <div className="relative z-10 mx-auto w-full max-w-[1080px] px-6 py-24 text-center">
        <p className="hero-eyebrow eyebrow">{'// SELF-HOST'}</p>

        <h1 aria-label="One server. Every screen." className="display-xl mt-6 font-display">
          <span className="hero-line-1 block" aria-hidden="true">
            <CascadeChars text="One server." />
          </span>
          <span
            className="hero-line-2 sheen-once block text-gradient"
            style={{ animationDelay: '1.1s' }}
            aria-hidden="true"
          >
            <CascadeChars text="Every screen." />
          </span>
        </h1>

        <p className="hero-lede lede mx-auto mt-7 max-w-[760px]">
          Run YAWF Stream on an always-on desktop, a NAS, a VPS, a Raspberry Pi, or the home server humming under
          your desk - and every device in the house gets the same private streaming service.
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-2.5">
          {HOSTS.map((h, i) => (
            <FloatingChip key={h} label={h} index={i} />
          ))}
        </div>
      </div>
    </section>
  );
}
