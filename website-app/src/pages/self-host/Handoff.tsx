import { memo, useLayoutEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Smartphone } from 'lucide-react';
import { GhostButton } from '@/components/Buttons';
import { asset } from '@/lib/asset';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

/** Animated scan-line sweep across the QR card (2.6s loop) - isolated. */
const ScanLine = memo(function ScanLine() {
  const reduced = useReducedMotion();
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackH, setTrackH] = useState(240);

  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => setTrackH(el.offsetHeight);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  if (reduced) return null;

  return (
    <div ref={trackRef} aria-hidden="true" className="pointer-events-none absolute inset-3 overflow-hidden rounded-[calc(var(--r-stage)-8px)]">
      <motion.div
        className="absolute inset-x-0 top-0 h-10"
        style={{
          background:
            'linear-gradient(180deg, transparent, rgba(var(--brand-rgb), 0.22) 55%, rgba(var(--brand-rgb), 0.65) 92%, rgba(var(--brand-rgb), 0.9))',
          filter: 'blur(1px)',
        }}
        animate={{ y: [-40, trackH] }}
        transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
      />
    </div>
  );
});

/**
 * Section 5 - Desktop handoff (QR). Tilted glass stage, hover straightens,
 * scan-line loop, phone outline "receiving" the scan.
 */
export default function Handoff() {
  const reduced = useReducedMotion();

  return (
    <section className="py-[clamp(88px,12vw,152px)]">
      <div className="mx-auto grid grid-cols-1 max-w-content items-center gap-12 px-6 md:px-10 lg:grid-cols-2">
        {/* left - copy */}
        <div>
          <motion.p
            className="eyebrow"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true, amount: 0.8 }}
            transition={{ duration: reduced ? 0.2 : 0.6 }}
          >
            {'// HANDOFF'}
          </motion.p>
          <motion.h2
            className="display-m mt-4 font-display"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 32, filter: 'blur(8px)' }}
            whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            viewport={{ once: true, amount: 0.8 }}
            transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO }}
          >
            From desktop to phone in one scan.
          </motion.h2>
          <motion.p
            className="mt-5 max-w-[520px] font-body text-[1rem] leading-[1.7] text-ink-2"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.8 }}
            transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: 0.12 }}
          >
            Start the server from Settings and the desktop app hands every phone and tablet a hosted PWA: a setup URL
            plus a QR code. Scan, add to home screen, done.
          </motion.p>
          <motion.div
            className="mt-8"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.8 }}
            transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: 0.22 }}
          >
            <GhostButton to="/devices">Devices &amp; PWA</GhostButton>
          </motion.div>
        </div>

        {/* right - tilted QR stage */}
        <div style={{ perspective: '1000px' }}>
          <motion.div
            className="relative mx-auto max-w-[520px]"
            initial={reduced ? { opacity: 0 } : { opacity: 0, rotateY: -20 }}
            whileInView={{ opacity: 1, rotateY: -8 }}
            whileHover={reduced ? undefined : { rotateY: 0 }}
            viewport={{ once: true, amount: 0.7 }}
            transition={
              reduced
                ? { duration: 0.2 }
                : { duration: 0.8, ease: EASE_EXPO, rotateY: { type: 'spring', stiffness: 170, damping: 22 } }
            }
            style={{ transformStyle: 'preserve-3d' }}
          >
            <div className="glass-panel relative overflow-hidden rounded-stage p-3 shadow-card">
              <img
                src={asset('qr-handoff.jpg')}
                alt="Desktop app showing a glowing QR code card with a short setup URL"
                loading="lazy"
                draggable={false}
                className="block w-full rounded-[calc(var(--r-stage)-8px)]"
              />
              <ScanLine />
            </div>

            {/* brand underlight */}
            <div
              aria-hidden="true"
              className="absolute -bottom-10 left-1/2 -z-10 h-24 w-3/4 -translate-x-1/2 rounded-full blur-2xl"
              style={{ background: 'radial-gradient(closest-side, rgba(var(--brand-rgb), 0.3), transparent)' }}
            />

            {/* phone outline receiving the scan */}
            <motion.div
              aria-hidden="true"
              className="absolute -bottom-7 -right-4 flex h-24 w-12 flex-col items-center justify-center gap-1.5 rounded-[22px] border border-line-strong bg-bg-1/90 shadow-card backdrop-blur-sm md:-right-8"
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: reduced ? 0.2 : 0.6, ease: EASE_EXPO, delay: 0.5 }}
            >
              <Smartphone className="h-4 w-4 text-brand" />
            </motion.div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
