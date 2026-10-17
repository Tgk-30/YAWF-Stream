import { motion, useReducedMotion } from 'framer-motion';
import SectionHeading from '@/components/SectionHeading';
import { GhostButton, PrimaryButton } from '@/components/Buttons';
import { VERSION } from '@/lib/site';
import { EASE_EXPO } from './shared';

/**
 * Section 11 - closing CTA: "Seen enough? Pick a stream."
 * Signal divider on top, primary → /download, ghost → /self-host.
 */
export default function ClosingCta() {
  const reduced = useReducedMotion();

  return (
    <section className="relative bg-bg-1">
      <div className="signal-divider absolute inset-x-0 top-0" aria-hidden="true" />
      {/* projector-warm bloom */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-72 opacity-40"
        style={{ background: 'var(--grad-warm)' }}
      />

      <div className="relative mx-auto flex max-w-content flex-col items-center px-6 py-[clamp(88px,12vw,152px)] text-center md:px-10">
        <SectionHeading
          align="center"
          eyebrow="// READY WHEN YOU ARE"
          title={
            <>
              Seen enough? <span className="text-gradient">Pick a stream.</span>
            </>
          }
        />

        <motion.div
          className="mt-10 flex flex-wrap items-center justify-center gap-4"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.6 }}
          transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: 0.15 }}
        >
          <PrimaryButton to="/download">Download YAWF Stream</PrimaryButton>
          <GhostButton to="/self-host">Self-host it</GhostButton>
        </motion.div>

        <motion.p
          className="mt-7 font-mono text-[0.75rem] tracking-[0.04em] text-ink-3"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4, delay: reduced ? 0 : 0.35 }}
        >
          Free · MIT · desktop {VERSION}
        </motion.p>
      </div>
    </section>
  );
}
