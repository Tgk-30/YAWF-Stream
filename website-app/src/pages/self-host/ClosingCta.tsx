import { motion, useReducedMotion } from 'framer-motion';
import { scrollToTarget } from '@/lib/scroll';
import BackgroundVideo from '@/components/BackgroundVideo';
import { GhostButton, PrimaryButton } from '@/components/Buttons';
import { asset } from '@/lib/asset';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

/** Section 6 - Closing CTA over the cinema-grain loop. */
export default function ClosingCta() {
  const reduced = useReducedMotion();

  return (
    <section className="relative flex min-h-[64vh] items-center justify-center overflow-hidden py-24">
      <BackgroundVideo src={asset('cinema-grain-loop.mp4')} poster={asset('cinema-grain-poster.jpg')} opacity={0.25} />
      <div aria-hidden="true" className="absolute inset-0 opacity-50" style={{ background: 'var(--grad-warm)' }} />
      <div aria-hidden="true" className="absolute inset-0" style={{ background: 'var(--grad-hero-scrim)' }} />

      <div className="relative z-10 mx-auto max-w-[820px] px-6 text-center">
        <motion.p
          className="eyebrow"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true, amount: 0.75 }}
          transition={{ duration: reduced ? 0.2 : 0.6 }}
        >
          {'// YOUR MOVE'}
        </motion.p>

        <h2 className="display-l mt-5 font-display">
          <motion.span
            className="inline-block will-change-transform"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 40, filter: 'blur(8px)' }}
            whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            viewport={{ once: true, amount: 0.75 }}
            transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO }}
          >
            Your hardware.{' '}
          </motion.span>
          <motion.span
            className="text-gradient inline-block will-change-transform"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 40, filter: 'blur(8px)' }}
            whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            viewport={{ once: true, amount: 0.75 }}
            transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: 0.09 }}
          >
            Your Netflix.
          </motion.span>
        </h2>

        <motion.div
          className="mt-10 flex flex-wrap items-center justify-center gap-4"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.75 }}
          transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: 0.25 }}
        >
          <PrimaryButton onClick={() => scrollToTarget('#deploy')}>Deploy with Docker</PrimaryButton>
          <GhostButton to="/download">Get the desktop app</GhostButton>
        </motion.div>

        <motion.p
          className="mt-7 font-mono text-[0.8125rem] tracking-[0.04em] text-ink-3"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.4 }}
        >
          Ubuntu guide · compose · native · .deb - all in the repo.
        </motion.p>
      </div>
    </section>
  );
}
