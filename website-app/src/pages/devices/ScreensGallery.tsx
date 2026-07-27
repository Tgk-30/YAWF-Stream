import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { gsap, useGSAP } from '@/lib/gsap';
import { usePrefersReducedMotion } from '@/lib/motion';
import DeviceFrame from '@/components/DeviceFrame';
import SectionHeading from '@/components/SectionHeading';
import { cn } from '@/lib/utils';
import { asset } from '@/lib/asset';

type FrameId = 'desktop' | 'tablet' | 'phone';

const FRAMES: { id: FrameId; variant: 'desktop' | 'tablet' | 'phone'; src: string; alt: string }[] = [
  { id: 'desktop', variant: 'desktop', src: asset('discover-desktop.png'), alt: 'YAWF Stream Discover screen on desktop' },
  { id: 'tablet', variant: 'tablet', src: asset('discover-tablet.png'), alt: 'YAWF Stream Discover screen on tablet' },
  { id: 'phone', variant: 'phone', src: asset('settings-mobile.png'), alt: 'YAWF Stream settings on phone' },
];

/**
 * Devices §4 - Real screens gallery: three DeviceFrames staged in 3D.
 * Scrubbed fan-out entry, cursor parallax tilt ±3°, click-to-focus z-swap.
 * Reduced motion / mobile → snap-scroll carousel with dots.
 */
export default function ScreensGallery() {
  const reduced = usePrefersReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const deskRef = useRef<HTMLDivElement>(null);
  const tabRef = useRef<HTMLDivElement>(null);
  const phoneRef = useRef<HTMLDivElement>(null);
  const glowBrandRef = useRef<HTMLDivElement>(null);
  const glowWarmRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<FrameId | null>(null);

  /* scrubbed entry - frames start stacked flat (z 0, y 80) and fan out over 400px */
  useGSAP(
    () => {
      if (reduced) return;
      const tl = gsap.timeline({
        scrollTrigger: { trigger: stageRef.current, start: 'top 85%', end: '+=400', scrub: 0.6 },
      });
      tl.fromTo(deskRef.current, { y: 80, scale: 0.96 }, { y: 0, scale: 1, ease: 'none' }, 0)
        .fromTo(
          tabRef.current,
          { y: 80, x: -170, z: 0, rotationY: 0, scale: 0.95 },
          { y: 0, x: 0, z: -80, rotationY: -14, scale: 0.8, ease: 'none' },
          0,
        )
        .fromTo(
          phoneRef.current,
          { y: 80, x: 150, rotationY: 0, scale: 1 },
          { y: 0, x: 0, rotationY: 10, scale: 0.92, ease: 'none' },
          0,
        );
    },
    { scope: sectionRef, dependencies: [reduced] },
  );

  /* cursor parallax tilt ±3° + underlight shift */
  const onPointerMove = (e: ReactPointerEvent) => {
    if (reduced) return;
    const r = stageRef.current?.getBoundingClientRect();
    if (!r) return;
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
    gsap.to(groupRef.current, { rotationY: nx * 3, rotationX: -ny * 3, transformPerspective: 1400, duration: 0.7, ease: 'power2.out' });
    gsap.to(glowBrandRef.current, { x: nx * 26, y: ny * 10, duration: 0.9, ease: 'power2.out' });
    gsap.to(glowWarmRef.current, { x: nx * -20, y: ny * -8, duration: 0.9, ease: 'power2.out' });
  };
  const onPointerLeave = () => {
    if (reduced) return;
    gsap.to(groupRef.current, { rotationX: 0, rotationY: 0, duration: 0.9, ease: 'power2.out' });
    gsap.to([glowBrandRef.current, glowWarmRef.current], { x: 0, y: 0, duration: 0.9, ease: 'power2.out' });
  };

  const toggleFocus = (id: FrameId) => setFocused((f) => (f === id ? null : id));

  const frameProps = (id: FrameId) => ({
    role: 'button' as const,
    tabIndex: 0,
    'aria-pressed': focused === id,
    'aria-label': `Focus the ${id} screenshot`,
    onClick: () => toggleFocus(id),
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleFocus(id);
      }
    },
  });

  return (
    <section ref={sectionRef} className="relative overflow-hidden border-y border-line bg-bg-1 py-[clamp(88px,12vw,152px)]">
      <div className="mx-auto max-w-content px-6 md:px-10">
        <SectionHeading eyebrow="// THE REAL THING" title="Not mockups. The app." className="mx-auto text-center" align="center" />
      </div>

      {/* ── Desktop 3D stage ── */}
      {!reduced && (
        <div className="mx-auto mt-14 hidden max-w-[1200px] px-6 md:block md:px-10">
          <div
            ref={stageRef}
            onPointerMove={onPointerMove}
            onPointerLeave={onPointerLeave}
            className="relative h-[600px] [perspective:1400px]"
          >
            {/* underlights */}
            <div
              ref={glowBrandRef}
              aria-hidden="true"
              className="absolute bottom-[4%] left-1/2 h-24 w-[55%] -translate-x-1/2 rounded-full blur-3xl"
              style={{ background: 'radial-gradient(closest-side, rgba(var(--brand-rgb), 0.22), transparent)' }}
            />
            <div
              ref={glowWarmRef}
              aria-hidden="true"
              className="absolute bottom-[10%] right-[6%] h-20 w-[30%] rounded-full blur-3xl"
              style={{ background: 'radial-gradient(closest-side, rgba(var(--warm-rgb), 0.16), transparent)' }}
            />

            <div ref={groupRef} className="absolute inset-0 [transform-style:preserve-3d]">
              {/* desktop - center */}
              <div ref={deskRef} className="absolute left-1/2 top-[2%] z-[2] ml-[-32%] w-[64%] will-change-transform">
                <div
                  {...frameProps('desktop')}
                  className={cn(
                    'cursor-pointer outline-none transition-[transform,opacity,filter] duration-500 ease-expo',
                    focused && focused !== 'desktop' && 'opacity-60 saturate-50',
                  )}
                  style={{ transform: focused === 'desktop' ? 'translateZ(80px) scale(1.02)' : undefined }}
                >
                  <DeviceFrame variant="desktop" src={asset('discover-desktop.png')} alt="YAWF Stream Discover screen on desktop" />
                </div>
              </div>

              {/* tablet - right-rear */}
              <div ref={tabRef} className="absolute right-[0.5%] top-[18%] z-[1] w-[29%] will-change-transform">
                <div className="[animation:float-y_6.5s_ease-in-out_1.2s_infinite]">
                  <div
                    {...frameProps('tablet')}
                    className={cn(
                      'cursor-pointer outline-none transition-[transform,opacity,filter] duration-500 ease-expo',
                      focused && focused !== 'tablet' && 'opacity-60 saturate-50',
                    )}
                    style={{ transform: focused === 'tablet' ? 'translateZ(140px) scale(1.06)' : undefined }}
                  >
                    <DeviceFrame variant="tablet" src={asset('discover-tablet.png')} alt="YAWF Stream Discover screen on tablet" />
                  </div>
                </div>
              </div>

              {/* phone - left-front */}
              <div ref={phoneRef} className="absolute bottom-[0%] left-[3%] z-[3] w-[21%] will-change-transform">
                <div className="[animation:float-y_5.5s_ease-in-out_infinite]">
                  <div
                    {...frameProps('phone')}
                    className={cn(
                      'cursor-pointer outline-none transition-[transform,opacity,filter] duration-500 ease-expo',
                      focused && focused !== 'phone' && 'opacity-60 saturate-50',
                    )}
                    style={{ transform: focused === 'phone' ? 'translateZ(120px) scale(1.08)' : undefined }}
                  >
                    <DeviceFrame variant="phone" src={asset('settings-mobile.png')} alt="YAWF Stream settings on phone" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <p className="mt-6 text-center font-mono text-[0.75rem] tracking-[0.04em] text-ink-3">
            move to tilt · click a screen to bring it forward
          </p>
        </div>
      )}

      {/* ── Mobile / reduced-motion: snap carousel ── */}
      <SnapCarousel className={reduced ? 'mt-12' : 'mt-12 md:hidden'} />
    </section>
  );
}

/** Snap-scroll carousel with dot navigation (mobile + reduced-motion fallback). */
function SnapCarousel({ className }: { className?: string }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const slideRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idx = slideRefs.current.indexOf(entry.target as HTMLDivElement);
            if (idx >= 0) setActive(idx);
          }
        }
      },
      { root: scroller, threshold: 0.6 },
    );
    slideRefs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);

  const goTo = (i: number) => {
    slideRefs.current[i]?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  };

  const widths = ['w-[86%] sm:w-[70%]', 'w-[58%] sm:w-[46%]', 'w-[46%] sm:w-[36%]'];

  return (
    <div className={className}>
      <div
        ref={scrollerRef}
        className="flex snap-x snap-mandatory items-center gap-6 overflow-x-auto px-6 pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {FRAMES.map((frame, i) => (
          <div
            key={frame.id}
            ref={(el) => {
              slideRefs.current[i] = el;
            }}
            className={cn('shrink-0 snap-center first:ml-auto last:mr-auto', widths[i])}
          >
            <DeviceFrame variant={frame.variant} src={frame.src} alt={frame.alt} reflect={frame.variant === 'desktop'} />
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-center gap-2.5">
        {FRAMES.map((frame, i) => (
          <button
            key={frame.id}
            type="button"
            aria-label={`Show ${frame.id} screenshot`}
            onClick={() => goTo(i)}
            className={cn(
              'h-1.5 rounded-full transition-all duration-300',
              active === i ? 'w-6 bg-brand shadow-glow-brand' : 'w-1.5 bg-ink-3 hover:bg-ink-2',
            )}
          />
        ))}
      </div>
    </div>
  );
}
