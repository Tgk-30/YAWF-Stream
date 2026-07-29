import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Link } from 'react-router';
import { Apple, ChevronDown, Smartphone, Terminal } from 'lucide-react';
import { gsap, useGSAP } from '@/lib/gsap';
import { usePrefersReducedMotion } from '@/lib/motion';
import { scrollToTarget } from '@/lib/scroll';
import { DOWNLOAD_LINKS, GITHUB_RELEASES_LATEST, VERSION } from '@/lib/site';
import RingGate from '@/components/RingGate';
import type { RingGateDriver } from '@/components/RingGate';
import BackgroundVideo from '@/components/BackgroundVideo';
import Chip from '@/components/Chip';
import { GhostButton, PrimaryButton } from '@/components/Buttons';
import { asset } from '@/lib/asset';

const QUICK_LINKS = [
  { label: 'macOS', icon: Apple, href: DOWNLOAD_LINKS.macos },
  { label: 'Linux', icon: Terminal, href: DOWNLOAD_LINKS.linux },
  { label: 'Phone & tablet PWA', icon: Smartphone, href: '/devices' },
];

/** Chars wrapped in overflow-hidden masks for the cascade (parent must carry text styles). */
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
 * Section 1 - Hero: "Your Accounts. Watch Freely."
 * Ring Gate 3D over the streams video, GSAP load choreography, +120vh scrubbed pin.
 */
export default function Hero() {
  const reduced = usePrefersReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const videoWrapRef = useRef<HTMLDivElement>(null);
  const driverRef = useRef<RingGateDriver>({ scroll: 0, pointerX: 0, pointerY: 0, intro: 0 });

  useGSAP(
    () => {
      if (reduced) {
        driverRef.current.intro = 1;
        return;
      }
      const q = gsap.utils.selector(sectionRef);

      /* ── load choreography (starts after 150ms) ── */
      const tl = gsap.timeline({ delay: 0.15, defaults: { ease: 'expo.out' } });
      tl.from(q('.hero-chip'), { y: 24, opacity: 0, duration: 0.6, stagger: 0.07 }, 0.3)
        .fromTo(
          q('.hero-line-1 .char'),
          { yPercent: 110, rotate: 4 },
          { yPercent: 0, rotate: 0, duration: 1.1, stagger: 0.022 },
          0.45,
        )
        .fromTo(
          q('.hero-line-2 .char'),
          { yPercent: 110, rotate: 4 },
          { yPercent: 0, rotate: 0, duration: 1.1, stagger: 0.022 },
          0.58,
        )
        .from(q('.hero-lede'), { y: 24, opacity: 0, filter: 'blur(6px)', duration: 0.7 }, 0.9)
        .from(q('.hero-cta'), { y: 24, opacity: 0, duration: 0.6, stagger: 0.09 }, 1.05)
        .fromTo(q('.hero-cta-primary'), { filter: 'brightness(1)' }, { filter: 'brightness(1.35)', duration: 0.4, yoyo: true, repeat: 1 }, 1.5)
        .from(q('.hero-quick, .hero-version'), { y: 12, opacity: 0, duration: 0.5, stagger: 0.05 }, 1.25)
        .from(q('.hero-cue'), { opacity: 0, duration: 0.6 }, 1.5)
        .fromTo(driverRef.current, { intro: 0 }, { intro: 1, duration: 1.4, ease: 'power2.out' }, 0.15);

      /* ── scroll scrub: pinned +120vh, dolly "through the rings" ── */
      const st = gsap.timeline({
        scrollTrigger: {
          trigger: sectionRef.current,
          start: 'top top',
          end: '+=120%',
          scrub: 0.6,
          pin: true,
          anticipatePin: 1,
          onUpdate: (self) => {
            driverRef.current.scroll = self.progress;
          },
        },
      });
      st.to(contentRef.current, { y: -80, opacity: 0, ease: 'none', duration: 0.7 }, 0).to(
        videoWrapRef.current,
        { opacity: 0.34, ease: 'none', duration: 1 },
        0,
      );
    },
    { scope: sectionRef, dependencies: [reduced] },
  );

  const onPointerMove = (e: ReactPointerEvent) => {
    const r = sectionRef.current?.getBoundingClientRect();
    if (!r) return;
    driverRef.current.pointerX = ((e.clientX - r.left) / r.width) * 2 - 1;
    driverRef.current.pointerY = -(((e.clientY - r.top) / r.height) * 2 - 1);
  };

  return (
    <section
      ref={sectionRef}
      onPointerMove={onPointerMove}
      className="relative -mt-[var(--nav-offset)] flex min-h-[max(100svh,640px)] items-center justify-center overflow-hidden"
    >
      {/* 1 - base + warm bloom behind the core */}
      <div className="absolute inset-0 bg-bg-0" />
      <div className="absolute inset-0 opacity-30" style={{ background: 'var(--grad-warm)' }} />

      {/* 2 - streams video + legibility scrim */}
      <div ref={videoWrapRef} className="absolute inset-0">
        <BackgroundVideo src={asset('hero-streams-loop.mp4')} poster={asset('hero-streams-poster.jpg')} opacity={0.45} />
      </div>
      <div className="absolute inset-0" style={{ background: 'var(--grad-hero-scrim)' }} />

      {/* 3 - Ring Gate (center-right on desktop, faint + centered on mobile) */}
      <RingGate driver={driverRef} className="absolute inset-0 opacity-30 md:translate-x-[12vw] md:opacity-100" />

      {/* 4 - content */}
      <div ref={contentRef} className="relative z-10 mx-auto w-full max-w-[1080px] px-6 py-28 text-center">
        <a
          href={GITHUB_RELEASES_LATEST}
          target="_blank"
          rel="noreferrer"
          className="hero-version inline-flex items-center gap-2 rounded-chip border border-line bg-[var(--surface-glass)] px-3.5 py-1.5 font-mono text-[0.75rem] tracking-[0.04em] text-ink-3 backdrop-blur-sm transition-colors duration-150 hover:border-line-strong hover:text-brand"
        >
          {VERSION} - latest builds on GitHub Releases
        </a>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
          <span className="hero-chip">
            <Chip variant="featured">Featured</Chip>
          </span>
          <span className="hero-chip">
            <Chip>Self-hosted</Chip>
          </span>
          <span className="hero-chip">
            <Chip>MIT · open source</Chip>
          </span>
        </div>

        <h1 aria-label="Your Accounts. Watch Freely." className="display-xl mt-9 font-display">
          <span className="hero-line-1 block" aria-hidden="true">
            <CascadeChars text="Your Accounts." />
          </span>
          <span
            className="hero-line-2 block text-brand"
            aria-hidden="true"
          >
            <CascadeChars text="Watch Freely." />
          </span>
        </h1>

        <p className="hero-lede lede mx-auto mt-7 max-w-[720px]">
          A private streaming hub for the services you already use. Connect Real-Debrid, AllDebrid, Premiumize, or
          TorBox, browse a cinematic catalog, and play instantly cached streams in a built-in player. Your server,
          your accounts, your household.
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-4">
          <span className="hero-cta hero-cta-primary inline-block">
            <PrimaryButton to="/download">View downloads</PrimaryButton>
          </span>
          <span className="hero-cta inline-block">
            <GhostButton onClick={() => scrollToTarget('#showcase')} playIcon={false}>
              See what it does
              <ChevronDown className="h-4 w-4 transition-transform duration-200 group-hover:translate-y-[2px]" />
            </GhostButton>
          </span>
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
          {QUICK_LINKS.map((q) => {
            const Icon = q.icon;
            const classes =
              'hero-quick border-beam group inline-flex items-center gap-2 rounded-chip border border-line bg-[var(--surface-glass)] px-3.5 py-2 font-mono text-[0.75rem] tracking-[0.04em] text-ink-2 backdrop-blur-sm transition-[transform,border-color,color] duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:text-brand';
            const inner = (
              <>
                <Icon className="h-3.5 w-3.5" />
                {q.label}
              </>
            );
            return q.href.startsWith('http') ? (
              <a key={q.label} href={q.href} target="_blank" rel="noreferrer" className={classes}>
                {inner}
              </a>
            ) : (
              <Link key={q.label} to={q.href} className={classes}>
                {inner}
              </Link>
            );
          })}
        </div>
      </div>

      {/* scroll cue */}
      <div className="hero-cue absolute bottom-7 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-2.5">
        <span className="font-mono text-[0.6875rem] tracking-[0.22em] text-ink-3">SCROLL</span>
        <span className="scroll-cue-line" />
      </div>
    </section>
  );
}
