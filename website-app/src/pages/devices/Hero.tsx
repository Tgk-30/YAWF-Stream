import { useRef } from 'react';
import { gsap, useGSAP } from '@/lib/gsap';
import { usePrefersReducedMotion } from '@/lib/motion';
import BackgroundVideo from '@/components/BackgroundVideo';
import Chip from '@/components/Chip';

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

const PLATFORM_CHIPS = ['macOS', 'Linux', 'Android TV', 'Google TV', 'iPhone & iPad', 'Android', 'any browser'];

/**
 * Devices §1 - Page hero: "Every screen in the house, served."
 * 55vh centered, nebula at 25% + warm bloom, char cascade, chips float-in then
 * 5s sine float, nebula parallax 0.25×.
 */
export default function Hero() {
  const reduced = usePrefersReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);
  const videoWrapRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (reduced) return;
      const q = gsap.utils.selector(sectionRef);

      const tl = gsap.timeline({ delay: 0.15, defaults: { ease: 'expo.out' } });
      tl.from(q('.dv-eyebrow'), { y: 16, opacity: 0, duration: 0.5 }, 0.1)
        .fromTo(
          q('.dv-line-1 .char'),
          { yPercent: 110, rotate: 4 },
          { yPercent: 0, rotate: 0, duration: 1.1, stagger: 0.022 },
          0.3,
        )
        .fromTo(
          q('.dv-line-2 .char'),
          { yPercent: 110, rotate: 4 },
          { yPercent: 0, rotate: 0, duration: 1.1, stagger: 0.022 },
          0.48,
        )
        .from(q('.dv-lede'), { y: 24, opacity: 0, filter: 'blur(6px)', duration: 0.7 }, 0.9)
        .from(q('.dv-chip'), { y: 20, opacity: 0, duration: 0.6, stagger: 0.06 }, 1.05);

      /* nebula parallax 0.25× */
      gsap.fromTo(
        videoWrapRef.current,
        { y: -30 },
        {
          y: 75,
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
      className="relative -mt-[var(--nav-offset)] flex min-h-[calc(55vh+var(--nav-offset))] items-center justify-center overflow-hidden pt-[var(--nav-offset)]"
    >
      <div className="absolute inset-0 bg-bg-0" />

      {/* nebula at 25% + parallax */}
      <div ref={videoWrapRef} className="absolute inset-[-50px_0]">
        <BackgroundVideo src="/debridstreamer/nebula-drift-loop.mp4" poster="/debridstreamer/nebula-drift-poster.jpg" opacity={0.25} />
      </div>
      {/* warm bloom behind headline */}
      <div
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 h-[70%] w-[80%] -translate-x-1/2 -translate-y-1/2 opacity-40"
        style={{ background: 'var(--grad-warm)' }}
      />
      <div aria-hidden="true" className="absolute inset-0" style={{ background: 'var(--grad-hero-scrim)' }} />

      <div className="relative z-10 mx-auto w-full max-w-[960px] px-6 py-24 text-center">
        <p className="dv-eyebrow eyebrow">{'// DEVICES'}</p>

        <h1 aria-label="Every screen in the house, served." className="display-xl mt-5 font-display">
          <span className="dv-line-1 block" aria-hidden="true">
            <CascadeChars text="Every screen" />
          </span>
          <span className="dv-line-1 block" aria-hidden="true">
            <CascadeChars text="in the house," />
          </span>
          <span className="dv-line-2 sheen-once block text-gradient" style={{ animationDelay: '1.2s' }} aria-hidden="true">
            <CascadeChars text="served" />
            <span className="char-mask" aria-hidden="true">
              <span className="char text-brand">.</span>
            </span>
          </span>
        </h1>

        <p className="dv-lede lede mx-auto mt-6 max-w-[720px]">
          Desktop apps for macOS and Linux, a native Android TV and Google TV app, and a mobile PWA your own server
          hosts. Windows is held until its signing gate passes. Browser TV mode pairs with a phone remote, while every
          screen keeps one library and resume position.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
          {PLATFORM_CHIPS.map((label, i) => (
            <span key={label} className="dv-chip inline-block">
              <span
                className="inline-block [animation:float-y_5s_ease-in-out_infinite]"
                style={{ animationDelay: `${1.4 + i * 0.35}s` }}
              >
                <Chip variant={i >= 2 && i <= 5 ? 'instant' : 'default'}>{label}</Chip>
              </span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
