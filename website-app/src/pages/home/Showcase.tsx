import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { gsap, useGSAP } from '@/lib/gsap';
import { cn } from '@/lib/utils';
import DeviceFrame from '@/components/DeviceFrame';
import GlassCard from '@/components/GlassCard';
import PosterMarquee from '@/components/PosterMarquee';
import SectionHeading from '@/components/SectionHeading';
import { asset } from '@/lib/asset';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

const STEPS = [
  {
    index: '01',
    title: 'Discover',
    text: 'Trending rows, cinematic detail pages, a release calendar - powered by TMDB artwork.',
  },
  {
    index: '02',
    title: 'Personalize',
    text: 'Give everyone their own watchlist, history, resume points, profile color, and household profile. Server operators can administer profiles and view operational activity.',
  },
  {
    index: '03',
    title: 'Play',
    text: 'Cached streams start instantly in the built-in player. MKV, HEVC, 4K - nothing else to install.',
  },
];

/** Mobile / reduced-motion: static stacked variant with simple rise-ins. */
function ShowcaseFallback() {
  const reduced = useReducedMotion();
  const rise = (i: number) => ({
    initial: reduced ? { opacity: 0 } : { opacity: 0, y: 40, filter: 'blur(8px)' },
    whileInView: { opacity: 1, y: 0, filter: 'blur(0px)' },
    viewport: { once: true, amount: 0.6 },
    transition: { duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: i * 0.09 },
  });

  return (
    <div className="mx-auto max-w-content px-6 py-[clamp(88px,12vw,152px)] md:px-10">
      <SectionHeading
        eyebrow="// SHOWCASE"
        title="See what it does."
        lede="The app is the hero - staged exactly as it looks on your screens."
      />
      <motion.div {...rise(0)} className="mt-12">
        <DeviceFrame variant="desktop" src={asset('discover-desktop.png')} alt="YAWF Stream Discover screen on desktop" />
      </motion.div>
      <div className="mt-10 grid gap-5 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <motion.div key={s.index} {...rise(i + 1)}>
            <GlassCard className="h-full">
              <span className="inline-flex items-center rounded-chip bg-brand px-3 py-1 font-mono text-[0.75rem] tracking-[0.04em] text-[var(--ink-on-brand)]">
                {s.index}
              </span>
              <h3 className="display-s mt-4 font-display">{s.title}</h3>
              <p className="mt-2 font-body text-[0.95rem] text-ink-2">{s.text}</p>
            </GlassCard>
          </motion.div>
        ))}
      </div>
      <motion.div {...rise(4)} className="mt-10 grid grid-cols-2 items-end gap-6">
        <DeviceFrame variant="tablet" src={asset('discover-tablet.png')} alt="YAWF Stream Discover on tablet" />
        <DeviceFrame variant="phone" src={asset('settings-mobile.png')} alt="YAWF Stream settings on phone" />
      </motion.div>
    </div>
  );
}

/** Section 3 - Product showcase: pinned scroll theatre (+200vh). */
export default function Showcase() {
  const reduced = useReducedMotion();
  const sectionRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const tabletRef = useRef<HTMLDivElement>(null);
  const phoneRef = useRef<HTMLDivElement>(null);
  const glareRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<{ rx: (v: number) => void; ry: (v: number) => void } | null>(null);
  const [activeStep, setActiveStep] = useState(0);
  const prevStepRef = useRef(0);

  useGSAP(
    () => {
      if (reduced) return;
      const q = gsap.utils.selector(sectionRef);
      const mm = gsap.matchMedia();

      mm.add('(min-width: 768px)', () => {
        gsap.set(stageRef.current, { transformPerspective: 1000 });
        const rx = gsap.quickTo(stageRef.current, 'rotationX', { duration: 0.5, ease: 'power3.out' });
        const ry = gsap.quickTo(stageRef.current, 'rotationY', { duration: 0.5, ease: 'power3.out' });
        tiltRef.current = { rx, ry };

        const tl = gsap.timeline({
          scrollTrigger: {
            trigger: sectionRef.current,
            start: 'top top',
            end: '+=200%',
            scrub: 0.6,
            pin: true,
            anticipatePin: 1,
            onUpdate: (self) => {
              const step = Math.min(2, Math.floor(self.progress * 3));
              if (step !== prevStepRef.current) {
                prevStepRef.current = step;
                setActiveStep(step);
              }
            },
          },
        });

        tl.from(stageRef.current, { scale: 0.92, y: 60, ease: 'none', duration: 0.15 }, 0)
          .fromTo(q('.showcase-frame img'), { scale: 1 }, { scale: 1.06, ease: 'none', duration: 1 }, 0)
          .to(railRef.current, { scaleY: 1, ease: 'none', duration: 1 }, 0)
          .to(stageRef.current, { y: -40, ease: 'none', duration: 0.2 }, 0.8)
          .from(tabletRef.current, { x: 120, opacity: 0, ease: 'none', duration: 0.2 }, 0.8)
          .from(phoneRef.current, { x: -120, opacity: 0, ease: 'none', duration: 0.2 }, 0.8);

        return () => {
          tiltRef.current = null;
        };
      });

      return () => mm.revert();
    },
    { scope: sectionRef, dependencies: [reduced] },
  );

  const onStageMove = (e: ReactPointerEvent) => {
    const r = stageRef.current?.getBoundingClientRect();
    if (!r) return;
    const px = ((e.clientX - r.left) / r.width) * 100;
    const py = ((e.clientY - r.top) / r.height) * 100;
    tiltRef.current?.ry((px / 100 - 0.5) * 8); // ±4°
    tiltRef.current?.rx(-(py / 100 - 0.5) * 8);
    const glare = glareRef.current;
    if (glare) {
      glare.style.opacity = '1';
      glare.style.background = `radial-gradient(480px at ${px}% ${py}%, rgba(255,255,255,0.08), transparent 60%)`;
    }
  };
  const onStageLeave = () => {
    tiltRef.current?.rx(0);
    tiltRef.current?.ry(0);
    if (glareRef.current) glareRef.current.style.opacity = '0';
  };

  if (reduced) {
    return (
      <section id="showcase" className="relative">
        <ShowcaseFallback />
      </section>
    );
  }

  return (
    <section id="showcase" className="relative">
      {/* stacked variant on small screens */}
      <div className="md:hidden">
        <ShowcaseFallback />
      </div>

      {/* pinned theatre on md+ */}
      <div ref={sectionRef} className="relative hidden md:block">
        <div className="relative flex min-h-[100svh] items-center overflow-hidden">
          {/* depth layer: marquee (top edge) + warm bloom (right) */}
          <div className="absolute inset-x-0 top-0 h-[38%] opacity-[0.12] [mask-image:linear-gradient(180deg,#000,transparent)]">
            <PosterMarquee tilt={false} />
          </div>
          <div
            className="absolute right-0 top-1/2 h-[70%] w-[45%] -translate-y-1/2 opacity-30"
            style={{ background: 'var(--grad-warm)' }}
          />

          <div className="mx-auto grid w-full max-w-stage grid-cols-[minmax(300px,380px)_1fr] items-center gap-14 px-10">
            {/* caption steps + signal rail */}
            <div className="relative flex gap-6">
              <div className="relative w-px self-stretch bg-line">
                <div ref={railRef} className="absolute inset-0 origin-top scale-y-0 bg-brand shadow-glow-brand" />
              </div>
              <div className="relative min-h-[260px] flex-1">
                {STEPS.map((s, i) => (
                  <div
                    key={s.index}
                    className={cn(
                      'absolute inset-0 transition-all duration-500 ease-expo',
                      i === activeStep
                        ? 'translate-y-0 opacity-100'
                        : i < activeStep
                          ? '-translate-y-6 opacity-0'
                          : 'translate-y-6 opacity-0',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-flex items-center rounded-chip border px-3 py-1 font-mono text-[0.75rem] tracking-[0.04em] transition-colors duration-300',
                        i === activeStep ? 'border-transparent bg-brand text-[var(--ink-on-brand)]' : 'border-line text-ink-3',
                      )}
                    >
                      {s.index}
                    </span>
                    <h3 className="display-m mt-4 font-display">{s.title}</h3>
                    <p className="mt-3 font-body text-ink-2">{s.text}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* stage */}
            <div className="relative">
              <div
                ref={stageRef}
                className="relative will-change-transform"
                onPointerMove={onStageMove}
                onPointerLeave={onStageLeave}
              >
                <div className="showcase-frame">
                  <DeviceFrame
                    variant="desktop"
                    src={asset('discover-desktop.png')}
                    alt="YAWF Stream Discover screen on desktop"
                    reflect={false}
                  />
                </div>
                <div
                  ref={glareRef}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 rounded-stage opacity-0 transition-opacity duration-300"
                />
              </div>

              {/* foreshadowing frames */}
              <div ref={tabletRef} className="absolute -right-16 bottom-[-10%] w-[230px] rotate-[4deg]">
                <DeviceFrame variant="tablet" src={asset('discover-tablet.png')} alt="" glow={false} reflect={false} />
              </div>
              <div ref={phoneRef} className="absolute -left-14 bottom-[-6%] w-[140px] -rotate-6">
                <DeviceFrame variant="phone" src={asset('settings-mobile.png')} alt="" glow={false} reflect={false} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
