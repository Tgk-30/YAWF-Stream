import { useRef } from 'react';
import { gsap, useGSAP } from '@/lib/gsap';
import { usePrefersReducedMotion } from '@/lib/motion';
import { GITHUB_RELEASES_LATEST, GITHUB_REPO, VERSION } from '@/lib/site';
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

const META_CHIPS: { label: string; href?: string }[] = [
  { label: VERSION, href: GITHUB_RELEASES_LATEST },
  { label: 'MIT', href: `${GITHUB_REPO}/blob/main/LICENSE` },
  { label: 'multi-arch' },
  { label: 'GitHub Releases', href: GITHUB_RELEASES_LATEST },
];

/**
 * Download §1 - Page hero: "Pick a stream."
 * 55vh centered, hero-streams video at 25% + warm bloom, char cascade, 0.3× video parallax.
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
      tl.from(q('.dl-eyebrow'), { y: 16, opacity: 0, duration: 0.5 }, 0.1)
        .fromTo(
          q('.dl-line-1 .char'),
          { yPercent: 110, rotate: 4 },
          { yPercent: 0, rotate: 0, duration: 1.1, stagger: 0.022 },
          0.3,
        )
        .fromTo(
          q('.dl-line-2 .char'),
          { yPercent: 110, rotate: 4 },
          { yPercent: 0, rotate: 0, duration: 1.1, stagger: 0.022 },
          0.45,
        )
        .from(q('.dl-lede'), { y: 24, opacity: 0, filter: 'blur(6px)', duration: 0.7 }, 0.85)
        .from(q('.dl-chip'), { y: 24, opacity: 0, duration: 0.6, stagger: 0.06 }, 1.0);

      /* video parallax 0.3× */
      gsap.fromTo(
        videoWrapRef.current,
        { y: -40 },
        {
          y: 90,
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

      {/* streams video at 25% + parallax */}
      <div ref={videoWrapRef} className="absolute inset-[-60px_0]">
        <BackgroundVideo src="/debridstreamer/hero-streams-loop.mp4" poster="/debridstreamer/hero-streams-poster.jpg" opacity={0.25} />
      </div>
      {/* warm bloom low-center */}
      <div
        aria-hidden="true"
        className="absolute inset-x-0 bottom-[-20%] h-[70%] opacity-50"
        style={{ background: 'var(--grad-warm)' }}
      />
      <div aria-hidden="true" className="absolute inset-0" style={{ background: 'var(--grad-hero-scrim)' }} />

      <div className="relative z-10 mx-auto w-full max-w-[900px] px-6 py-24 text-center">
        <p className="dl-eyebrow eyebrow">{'// DOWNLOAD'}</p>

        <h1 aria-label="Pick a stream." className="display-xl mt-5 font-display">
          <span className="dl-line-1 block" aria-hidden="true">
            <CascadeChars text="Pick a" />
          </span>
          <span className="dl-line-2 sheen-once block text-gradient" style={{ animationDelay: '1.1s' }} aria-hidden="true">
            <CascadeChars text="stream" />
            <span className="char-mask" aria-hidden="true">
              <span className="char text-brand">.</span>
            </span>
          </span>
        </h1>

        <p className="dl-lede lede mx-auto mt-6 max-w-[680px]">
          Free, MIT open source. v2 is available for macOS, Linux, Android TV, Google TV, and any phone or tablet
          through your server-hosted PWA. Windows follows after its signing gate passes.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
          {META_CHIPS.map((chip) =>
            chip.href ? (
              <a key={chip.label} href={chip.href} target="_blank" rel="noreferrer" className="dl-chip group">
                <Chip className="transition-[border-color,color] duration-150 group-hover:border-line-strong group-hover:text-brand">
                  {chip.label}
                </Chip>
              </a>
            ) : (
              <span key={chip.label} className="dl-chip">
                <Chip>{chip.label}</Chip>
              </span>
            ),
          )}
        </div>
      </div>
    </section>
  );
}
