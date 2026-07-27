import { useRef } from 'react';
import { gsap, useGSAP } from '@/lib/gsap';
import { usePrefersReducedMotion } from '@/lib/motion';
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

/**
 * Section 1 - Features hero: 62vh cinema-grain band, char cascade headline,
 * video drifts at 0.3× scroll parallax. Full-bleed (opts out of nav offset).
 */
export default function FeaturesHero() {
  const reduced = usePrefersReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);
  const videoWrapRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (reduced) return;
      const q = gsap.utils.selector(sectionRef);

      const tl = gsap.timeline({ delay: 0.2, defaults: { ease: 'expo.out' } });
      tl.from(q('.f-eyebrow'), { opacity: 0, y: 16, duration: 0.6 }, 0.1)
        .fromTo(
          q('.f-line-1 .char'),
          { yPercent: 110, rotate: 4 },
          { yPercent: 0, rotate: 0, duration: 1.1, stagger: 0.022 },
          0.35,
        )
        .fromTo(
          q('.f-line-2 .char'),
          { yPercent: 110, rotate: 4 },
          { yPercent: 0, rotate: 0, duration: 1.1, stagger: 0.022 },
          0.5,
        )
        .from(q('.f-lede'), { y: 24, opacity: 0, filter: 'blur(6px)', duration: 0.7 }, 0.95);

      /* video drift - 0.3× parallax while the band leaves the viewport */
      gsap.to(videoWrapRef.current, {
        yPercent: 22,
        ease: 'none',
        scrollTrigger: { trigger: sectionRef.current, start: 'top top', end: 'bottom top', scrub: true },
      });
    },
    { scope: sectionRef, dependencies: [reduced] },
  );

  return (
    <section
      ref={sectionRef}
      className="relative -mt-[var(--nav-offset)] flex min-h-[max(62vh,480px)] items-center justify-center overflow-hidden"
      aria-label="Features overview"
    >
      {/* cinema-grain band (taller than the section so the parallax never exposes edges) */}
      <div ref={videoWrapRef} className="absolute inset-x-0 -inset-y-[14%]">
        <BackgroundVideo src={asset('cinema-grain-loop.mp4')} poster={asset('cinema-grain-poster.jpg')} opacity={0.35} />
      </div>
      <div className="absolute inset-0" style={{ background: 'var(--grad-hero-scrim)' }} />

      <div className="relative z-10 mx-auto max-w-[980px] px-6 pb-16 pt-[calc(var(--nav-offset)+56px)] text-center">
        <p className="f-eyebrow eyebrow">{'// FEATURES'}</p>

        <h1 aria-label="Nine ways it earns the couch." className="display-xl mt-6 font-display">
          <span className="f-line-1 block" aria-hidden="true">
            <CascadeChars text="Nine ways it" />
          </span>
          <span className="f-line-2 block text-gradient" aria-hidden="true">
            <CascadeChars text="earns the couch." />
          </span>
        </h1>

        <p className="f-lede lede mx-auto mt-7 max-w-[640px]">
          Discovery, playback, subtitles, profiles - the whole streaming stack, running on hardware you own.
        </p>
      </div>
    </section>
  );
}
