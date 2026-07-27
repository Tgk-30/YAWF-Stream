import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import Lenis from 'lenis';
import { gsap, ScrollTrigger } from '@/lib/gsap';
import { prefersReducedMotion } from '@/lib/motion';
import { scrollToTop, setLenis } from '@/lib/scroll';
import Layout from '@/components/Layout';
import Home from '@/pages/Home';

const Features = lazy(() => import('@/pages/Features'));
const Download = lazy(() => import('@/pages/Download'));
const SelfHost = lazy(() => import('@/pages/SelfHost'));
const Devices = lazy(() => import('@/pages/Devices'));
const Household = lazy(() => import('@/pages/Household'));
const Brand = lazy(() => import('@/pages/Brand'));
const Help = lazy(() => import('@/pages/Help'));

function RouteLoading() {
  return (
    <div role="status" className="flex min-h-[50vh] items-center justify-center font-mono text-sm text-ink-3">
      Loading page
    </div>
  );
}

/** Resets scroll to top on route change (through Lenis) and re-measures pins. */
function ScrollManager() {
  const { pathname } = useLocation();
  useEffect(() => {
    scrollToTop();
    ScrollTrigger.refresh();
  }, [pathname]);
  return null;
}

export default function App() {
  // Lenis smooth scroll (lerp 0.09) synced with GSAP ScrollTrigger;
  // disabled entirely under prefers-reduced-motion.
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const lenis = new Lenis({ lerp: 0.09 });
    setLenis(lenis);
    lenis.on('scroll', ScrollTrigger.update);
    const raf = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(raf);
    gsap.ticker.lagSmoothing(0);
    return () => {
      gsap.ticker.remove(raf);
      lenis.destroy();
      setLenis(null);
    };
  }, []);

  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/+$/, '')}>
      <ScrollManager />
      <Suspense fallback={<RouteLoading />}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="features" element={<Features />} />
            <Route path="download" element={<Download />} />
            <Route path="self-host" element={<SelfHost />} />
            <Route path="devices" element={<Devices />} />
            <Route path="household" element={<Household />} />
            <Route path="brand" element={<Brand />} />
            <Route path="help" element={<Help />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
