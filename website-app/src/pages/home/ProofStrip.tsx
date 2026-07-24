import { motion, useReducedMotion } from 'framer-motion';
import { MonitorSmartphone, Server, Users, Zap } from 'lucide-react';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

const ITEMS = [
  { icon: Server, title: 'Self-hosted', text: 'Your server, your debrid keys, your data.', instant: false },
  { icon: Zap, title: 'Instant', text: 'Plays already-cached streams - no waiting.', instant: true },
  { icon: Users, title: 'Profiles', text: 'Separate libraries per person, optional passwords.', instant: false },
  { icon: MonitorSmartphone, title: 'Everywhere', text: 'Desktop, mobile PWA, and native Android TV.', instant: false },
];

/** Section 2 - Proof strip: 4 StatChips on a --bg-1 band. */
export default function ProofStrip() {
  const reduced = useReducedMotion();

  return (
    <section className="relative bg-bg-1">
      <div className="signal-divider" />
      <div className="mx-auto grid max-w-content grid-cols-1 gap-x-6 gap-y-8 px-6 py-16 sm:grid-cols-2 lg:grid-cols-4 md:px-10">
        {ITEMS.map((item, i) => {
          const Icon = item.icon;
          return (
            <motion.div
              key={item.title}
              custom={i}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 40, filter: 'blur(8px)' }}
              whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              viewport={{ once: true, amount: 0.8 }}
              transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: i * 0.09 }}
              className="group border-t border-line pt-6 transition-[transform,background-color] duration-200 ease-expo hover:-translate-y-[3px]"
            >
              <Icon
                className="h-6 w-6 text-brand transition-[filter] duration-200 group-hover:[filter:drop-shadow(0_0_8px_rgba(var(--brand-rgb),0.55))]"
                strokeWidth={1.5}
              />
              <p className="mt-4 font-body text-[1rem] font-semibold leading-[1.6] text-ink-1">{item.title}</p>
              <p className="mt-1 font-body text-[0.95rem] text-ink-2">{item.text}</p>
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}
