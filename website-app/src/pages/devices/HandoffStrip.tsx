import { useRef } from 'react';
import { motion, useInView, useReducedMotion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { GhostButton } from '@/components/Buttons';
import { asset } from '@/lib/asset';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

/**
 * Devices §5 - Handoff recap: QR strip. Desktop app hands phones a setup
 * URL + QR - scan, Add to Home Screen, done. Scan-line sweep starts at 70%
 * visibility; QR hover straightens + glows.
 */
export default function HandoffStrip() {
  const reduced = useReducedMotion();
  const qrRef = useRef<HTMLDivElement>(null);
  const qrInView = useInView(qrRef, { once: true, amount: 0.7 });

  return (
    <section className="relative py-[clamp(88px,12vw,152px)]">
      <div className="mx-auto max-w-content px-6 md:px-10">
        <motion.div
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: reduced ? 0.2 : 0.6, ease: EASE_EXPO }}
          className="glass-panel flex flex-col items-center gap-8 rounded-card p-8 sm:flex-row sm:gap-10 sm:p-10"
        >
          {/* QR art with scan-line sweep */}
          <div ref={qrRef} className="group shrink-0 [perspective:600px]">
            <div className="relative w-[240px] -rotate-2 overflow-hidden rounded-2xl border border-line shadow-card transition-[transform,box-shadow] duration-500 ease-expo group-hover:rotate-0 group-hover:shadow-glow-brand">
              <img
                src={asset('qr-handoff.jpg')}
                alt="Desktop app showing a glowing QR code that hands the setup URL to a phone"
                loading="lazy"
                draggable={false}
                className="block w-full"
              />
              {!reduced && qrInView && (
                <motion.span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 top-0 h-10"
                  style={{
                    background:
                      'linear-gradient(180deg, transparent, rgba(var(--brand-rgb), 0.35) 55%, rgba(var(--brand-rgb), 0.7))',
                  }}
                  initial={{ y: -48 }}
                  animate={{ y: [-48, 220] }}
                  transition={{ duration: 2.6, repeat: Infinity, ease: 'linear', repeatDelay: 0.5 }}
                />
              )}
            </div>
          </div>

          {/* copy */}
          <div className="text-center sm:text-left">
            <h2 className="display-s font-display">From desktop to phone in one scan.</h2>
            <p className="mt-3 max-w-[460px] leading-[1.7] text-ink-2">
              The desktop app can start the server from Settings and hands phones a setup URL + QR - scan, Add to
              Home Screen, done.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3 sm:justify-start">
              <GhostButton to="/self-host" playIcon={false} className="px-5 py-3 text-[0.85rem]">
                Self-host details
                <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1" />
              </GhostButton>
              <GhostButton to="/download" className="px-5 py-3 text-[0.85rem]">
                Get the desktop app
              </GhostButton>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
