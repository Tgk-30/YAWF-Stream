import { motion, useReducedMotion } from 'framer-motion';
import { GITHUB_DESKTOP_RELEASE, GITHUB_REPO, VERSION } from '@/lib/site';
import RingMark from '@/components/RingMark';
import { GhostButton, PrimaryButton } from '@/components/Buttons';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

/** Download §6 - Closing CTA: "Installed in minutes. Yours forever." */
export default function ClosingCta() {
  const reduced = useReducedMotion();
  const words = ['Installed', 'in', 'minutes.'];

  return (
    <section className="relative overflow-hidden py-[clamp(96px,14vw,168px)]">
      {/* warm projector bloom */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-[-30%] h-[80%] opacity-40"
        style={{ background: 'var(--grad-warm)' }}
      />

      <div className="relative mx-auto max-w-[820px] px-6 text-center">
        <h2 className="display-l font-display">
          {words.map((word, i) => (
            <motion.span
              key={word}
              className="inline-block will-change-transform"
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 40, filter: 'blur(8px)' }}
              whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              viewport={{ once: true, amount: 0.75 }}
              transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: i * 0.09 }}
            >
              {word}{' '}
            </motion.span>
          ))}
          <motion.span
            className="text-gradient inline-block will-change-transform"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 40, filter: 'blur(8px)' }}
            whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            viewport={{ once: true, amount: 0.75 }}
            transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: words.length * 0.09 }}
          >
            Yours forever.
          </motion.span>
        </h2>

        <motion.div
          className="mt-10 flex flex-wrap items-center justify-center gap-4"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.75 }}
          transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: 0.35 }}
        >
          <PrimaryButton href={GITHUB_DESKTOP_RELEASE}>
            <RingMark size={15} static className="transition-transform duration-500 ease-expo group-hover:rotate-[360deg]" />
            Get desktop {VERSION}
          </PrimaryButton>
          <GhostButton to="/self-host">Self-host instead</GhostButton>
        </motion.div>

        <motion.p
          className="mt-7 font-mono text-[0.8125rem] tracking-[0.04em] text-ink-3"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.5 }}
        >
          MIT licensed ·{' '}
          <a
            href={GITHUB_REPO}
            target="_blank"
            rel="noreferrer"
            className="text-brand transition-colors hover:text-accent2"
          >
            source on GitHub
          </a>
        </motion.p>
      </div>
    </section>
  );
}
