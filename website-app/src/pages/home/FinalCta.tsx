import { useRef } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Github } from 'lucide-react';
import { gsap, useGSAP } from '@/lib/gsap';
import { GITHUB_REPO } from '@/lib/site';
import BackgroundVideo from '@/components/BackgroundVideo';
import RingMark from '@/components/RingMark';
import { GhostButton, PrimaryButton } from '@/components/Buttons';
import { asset } from '@/lib/asset';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

/** Section 8 - Final CTA band over the cinema-grain loop. */
export default function FinalCta() {
  const reduced = useReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);
  const bloomRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (reduced) return;
      // warm bloom slowly scales 0.8 → 1.1 on scroll-through
      gsap.fromTo(
        bloomRef.current,
        { scale: 0.8 },
        {
          scale: 1.1,
          ease: 'none',
          scrollTrigger: { trigger: sectionRef.current, start: 'top bottom', end: 'bottom top', scrub: 0.6 },
        },
      );
    },
    { scope: sectionRef, dependencies: [reduced] },
  );

  const words = ['Your', 'server.', 'Your', 'streams.'];

  return (
    <section ref={sectionRef} className="relative flex min-h-[70vh] items-center justify-center overflow-hidden py-24">
      <BackgroundVideo src={asset('cinema-grain-loop.mp4')} poster={asset('cinema-grain-poster.jpg')} opacity={0.35} />
      <div ref={bloomRef} aria-hidden="true" className="absolute inset-0 opacity-60" style={{ background: 'var(--grad-warm)' }} />
      <div aria-hidden="true" className="absolute inset-0" style={{ background: 'var(--grad-hero-scrim)' }} />

      <div className="relative z-10 mx-auto max-w-[820px] px-6 text-center">
        <motion.p
          className="eyebrow"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true, amount: 0.75 }}
          transition={{ duration: reduced ? 0.2 : 0.6 }}
        >
          {'// READY WHEN YOU ARE'}
        </motion.p>

        <h2 className="display-l mt-5 font-display">
          {words.map((word, i) => (
            <motion.span
              key={`${word}-${i}`}
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
            Your rules.
          </motion.span>
        </h2>

        <motion.div
          className="mt-10 flex flex-wrap items-center justify-center gap-4"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.75 }}
          transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: 0.35 }}
        >
          <PrimaryButton to="/download">
            <RingMark size={15} static className="transition-transform duration-500 ease-expo group-hover:rotate-[360deg]" />
            Download YAWF Stream
          </PrimaryButton>
          <GhostButton href={GITHUB_REPO} playIcon={false}>
            <Github className="h-4 w-4" />
            Star on GitHub
          </GhostButton>
        </motion.div>

        <motion.p
          className="mt-7 font-mono text-[0.8125rem] tracking-[0.04em] text-ink-3"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.5 }}
        >
          MIT licensed · self-hosted · made for the whole house.
        </motion.p>
      </div>
    </section>
  );
}
