import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ServerCoreDriverRef } from '@/components/three/ServerCoreScene';
import { hasWebGL, prefersReducedMotion } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { asset } from '@/lib/asset';

const ServerCoreScene = lazy(() => import('@/components/three/ServerCoreScene'));

interface ServerCoreStageProps {
  driver: ServerCoreDriverRef;
  /** bi-directional hover: glyph → DOM list */
  onGlyphHover?: (index: number | null) => void;
  className?: string;
}

/**
 * Scene C stage - lazy + IO-gated (mounts at 40% visibility, unmounts on
 * exit; the only WebGL canvas on the page). WebGL unavailable / reduced
 * motion / <768px → static `server-core-poster.jpg` over the brand gradient.
 */
export default function ServerCoreStage({ driver, onGlyphHover, className }: ServerCoreStageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [webglOk] = useState(
    () => hasWebGL() && !prefersReducedMotion() && !window.matchMedia('(max-width: 767px)').matches,
  );

  useEffect(() => {
    if (!webglOk) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.intersectionRatio >= 0.4) setInView(true);
        else if (entry.intersectionRatio === 0) setInView(false);
      },
      { threshold: [0, 0.4], rootMargin: '60px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [webglOk]);

  // replay the mount flash when the scene re-enters
  useEffect(() => {
    // eslint-disable-next-line react-hooks/immutability -- driver is a deliberately mutable cross-component ref (RingGate pattern)
    if (!inView) driver.current.intro = 0;
  }, [inView, driver]);

  if (!webglOk) {
    return (
      <div
        className={cn('overflow-hidden rounded-stage border border-line', className)}
        style={{ background: 'radial-gradient(closest-side, rgba(var(--brand-rgb), 0.12), transparent), var(--bg-0)' }}
      >
        <img
          src={asset('server-core-poster.jpg')}
          alt="Server Core - a glass cube with a glowing teal core, device icons orbiting on light trails"
          className="h-full w-full object-cover opacity-90"
          loading="lazy"
        />
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className={cn('relative', className)}
      style={{ background: 'radial-gradient(closest-side, rgba(var(--brand-rgb), 0.08), transparent 72%)' }}
    >
      {inView && (
        <Suspense fallback={null}>
          <ServerCoreScene driver={driver} onGlyphHover={onGlyphHover} />
        </Suspense>
      )}
    </div>
  );
}
