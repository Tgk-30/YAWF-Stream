import { motion, useReducedMotion } from 'framer-motion';
import BackgroundVideo from '@/components/BackgroundVideo';
import Chip from '@/components/Chip';
import { EASE_EXPO } from '@/pages/brand/utils';
import { asset } from '@/lib/asset';

const CHIPS = ['one config file', '3 presets', 'CSS variables', 'MIT'];

/** Chars in overflow masks, cascading up with a slight rotate (framer edition). */
function CascadeChars({ text, delay = 0 }: { text: string; delay?: number }) {
  const reduced = useReducedMotion();
  return (
    <>
      {[...text].map((c, i) => (
        <span key={i} className="char-mask" aria-hidden="true">
          <motion.span
            className={c === ' ' ? 'char char-space' : 'char'}
            initial={reduced ? { opacity: 0 } : { y: '110%', rotate: 4 }}
            animate={reduced ? { opacity: 1 } : { y: '0%', rotate: 0 }}
            transition={
              reduced
                ? { duration: 0.2, delay: delay + i * 0.008 }
                : { duration: 1.1, ease: EASE_EXPO, delay: delay + i * 0.022 }
            }
          >
            {c === ' ' ? '\u00a0' : c}
          </motion.span>
        </span>
      ))}
    </>
  );
}

/** Section 1 - Page hero: nebula band, "Make it yours.", meta chips. */
export default function BrandHero() {
  const reduced = useReducedMotion();

  return (
    <section className="relative -mt-[var(--nav-offset)] flex min-h-[max(55vh,460px)] items-center justify-center overflow-hidden">
      <div className="absolute inset-0 bg-bg-0" />
      <BackgroundVideo src={asset('nebula-drift-loop.mp4')} poster={asset('nebula-drift-poster.jpg')} opacity={0.3} />
      <div className="absolute inset-0" style={{ background: 'var(--grad-hero-scrim)' }} />

      <div className="relative z-10 mx-auto max-w-[900px] px-6 pb-16 pt-[calc(var(--nav-offset)+44px)] text-center md:px-10">
        <motion.p
          className="eyebrow"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reduced ? 0.2 : 0.6, ease: 'easeOut', delay: 0.25 }}
        >
          {'// BRAND'}
        </motion.p>

        <h1 aria-label="Make it yours." className="display-xl mt-6 font-display">
          <span className="block" aria-hidden="true">
            <CascadeChars text="Make it" delay={0.35} />
          </span>
          <span className="brandpg-shimmer block pb-2" aria-hidden="true">
            <CascadeChars text="yours." delay={0.5} />
          </span>
        </h1>

        <motion.p
          className="lede mx-auto mt-7 max-w-[720px]"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24, filter: 'blur(6px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          transition={{ duration: reduced ? 0.2 : 0.7, ease: EASE_EXPO, delay: 0.85 }}
        >
          YAWF Stream is MIT open source - and so is this site&rsquo;s skin. Name, colors, logo, fonts, corner
          radius, glow: everything resolves from one theme config. Flip it below and watch the whole site follow.
        </motion.p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
          {CHIPS.map((label, i) => (
            <motion.span
              key={label}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: 1.05 + i * 0.06 }}
            >
              <Chip variant={i === 0 ? 'featured' : 'default'}>{label}</Chip>
            </motion.span>
          ))}
        </div>
      </div>
    </section>
  );
}
