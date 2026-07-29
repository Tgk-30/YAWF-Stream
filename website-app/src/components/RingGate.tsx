import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { RingGateDriverRef } from '@/components/three/RingGateScene';
import { hasWebGL, prefersReducedMotion } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { asset } from '@/lib/asset';

export type { RingGateDriver, RingGateDriverRef } from '@/components/three/RingGateScene';

const RingGateScene = lazy(() => import('@/components/three/RingGateScene'));

interface RingGateProps {
  driver: RingGateDriverRef;
  className?: string;
}

/**
 * Scene A - Ring Gate (lazy, IO-gated).
 * WebGL unavailable / reduced-motion → static `ring-gate-poster.jpg` over gradient.
 * Canvas unmounts when scrolled out of view (one WebGL scene per page budget).
 */
export default function RingGate({ driver, className }: RingGateProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [webglOk] = useState(() => hasWebGL() && !prefersReducedMotion());

  useEffect(() => {
    if (!webglOk) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, [webglOk]);

  if (!webglOk) {
    return (
      <div
        className={cn('overflow-hidden', className)}
        style={{ background: 'radial-gradient(closest-side, rgba(var(--brand-rgb), 0.12), transparent), var(--bg-0)' }}
      >
        <img src={asset('ring-gate-poster.jpg')} alt="" className="h-full w-full object-cover opacity-80" />
      </div>
    );
  }

  return (
    <div ref={ref} className={className}>
      {inView && (
        <Suspense fallback={null}>
          <RingGateScene driver={driver} />
        </Suspense>
      )}
    </div>
  );
}
