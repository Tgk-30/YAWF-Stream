import { motion, useReducedMotion } from 'framer-motion';
import SectionHeading from '@/components/SectionHeading';
import { GhostButton } from '@/components/Buttons';
import { asset } from '@/lib/asset';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

const AVATARS = [
  { initials: 'A', name: 'Alex', tip: 'Alex - Admin', color: 'var(--brand)' },
  { initials: 'S', name: 'Sam', tip: 'Sam - Standard', color: 'var(--accent)' },
  { initials: 'K', name: 'Kids', tip: 'Kids - maturity cap on', color: 'var(--warm)' },
  { initials: 'G', name: 'Guest', tip: 'Guest - temporary access', color: 'var(--brand-deep)' },
];

/** Section 7 - Household teaser: living-room card + avatar chips on a trace line. */
export default function HouseholdTeaser() {
  const reduced = useReducedMotion();

  return (
    <section className="py-[clamp(88px,12vw,152px)]">
      <div className="mx-auto max-w-content px-6 md:px-10">
        <motion.div
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 32, scale: 0.97 }}
          whileInView={{ opacity: 1, y: 0, scale: 1 }}
          viewport={{ once: true, amount: 0.35 }}
          transition={{ duration: reduced ? 0.2 : 0.7, ease: EASE_EXPO }}
          className="glass-panel relative overflow-hidden rounded-stage"
        >
          {/* right-half art (desktop) / top banner (mobile) */}
          <div className="relative h-[220px] md:hidden">
            <img src={asset('living-room-glow.jpg')} alt="" className="h-full w-full object-cover" loading="lazy" />
          </div>
          <div aria-hidden="true" className="absolute inset-y-0 right-0 hidden w-1/2 md:block">
            <img
              src={asset('living-room-glow.jpg')}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
              style={{
                WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 45%)',
                maskImage: 'linear-gradient(90deg, transparent, #000 45%)',
              }}
            />
          </div>

          <div className="relative z-10 max-w-[560px] p-8 md:p-14">
            <SectionHeading
              eyebrow="// HOUSEHOLD"
              title="Profiles for the whole house."
              lede="Everyone gets their own watchlist, history, and resume - with kids' maturity limits, a parental lock, and title requests admins can approve."
            >
              <div className="mt-8">
                <GhostButton to="/household">Meet the household</GhostButton>
              </div>
            </SectionHeading>
          </div>

          {/* avatar chips on a signal-trace line */}
          <div className="relative z-10 flex items-center gap-4 px-8 pb-9 md:absolute md:bottom-12 md:right-14 md:p-0">
            <div aria-hidden="true" className="signal-divider absolute inset-x-0 top-1/2 -translate-y-1/2" />
            {AVATARS.map((a, i) => (
              <motion.span
                key={a.name}
                title={a.tip}
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.5 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true, amount: 0.8 }}
                transition={{ type: 'spring', stiffness: 170, damping: 22, delay: 0.3 + i * 0.12 }}
                className="relative flex h-11 w-11 cursor-default items-center justify-center rounded-full border-2 bg-bg-2 font-mono text-[0.8125rem] text-ink-1 transition-shadow duration-200"
                style={{ borderColor: a.color }}
              >
                {a.initials}
              </motion.span>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}
