import { motion, useReducedMotion } from 'framer-motion';
import { Apple, Check, Clock, Fingerprint, PackageCheck, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import GlassCard from '@/components/GlassCard';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

const TITLE_WORDS = ['Signed,', 'notarized,', 'boringly', 'reliable.'];

interface TrustRow {
  icon: LucideIcon;
  label: string;
  note: string;
  held?: boolean;
}

const TRUST_ROWS: TrustRow[] = [
  { icon: ShieldCheck, label: 'signed update manifest', note: 'latest.json · GitHub Releases' },
  { icon: Apple, label: 'macOS notarized builds', note: 'Gatekeeper-approved' },
  { icon: PackageCheck, label: 'Linux AppImage', note: 'signed updater inside' },
  { icon: Fingerprint, label: 'checksums and provenance', note: 'SHA256SUMS · GitHub attestations' },
  { icon: Clock, label: 'Windows signing gate', note: 'held until Authenticode is proven', held: true },
  { icon: Clock, label: 'update on your schedule', note: 'auto-check can be disabled in Settings' },
];

/**
 * Download §3 - Version & trust panel: signed/notarized copy left,
 * animated checklist status card right (check stamps 200ms after each row lands).
 */
export default function TrustPanel() {
  const reduced = useReducedMotion();

  return (
    <section className="relative border-y border-line bg-bg-1 py-[clamp(88px,12vw,152px)]">
      <div className="mx-auto grid max-w-content items-center gap-12 px-6 md:px-10 lg:grid-cols-2">
        {/* left copy - word rise */}
        <div>
          <h2 className="display-m font-display">
            {TITLE_WORDS.map((word, i) => (
              <motion.span
                key={word}
                className="inline-block will-change-transform"
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 28, filter: 'blur(6px)' }}
                whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                viewport={{ once: true, amount: 0.8 }}
                transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: i * 0.07 }}
              >
                {word}
                {i < TITLE_WORDS.length - 1 ? ' ' : ''}
              </motion.span>
            ))}
          </h2>
          <motion.p
            className="mt-5 max-w-[480px] leading-[1.7] text-ink-2"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.8 }}
            transition={{ duration: reduced ? 0.2 : 0.6, ease: EASE_EXPO, delay: 0.3 }}
          >
            Desktop builds check a signed{' '}
            <code className="rounded border border-line bg-[var(--surface-glass)] px-1.5 py-0.5 font-mono text-[0.85em] text-brand">
              latest.json
            </code>{' '}
            from GitHub Releases. macOS builds are notarized, the Linux AppImage has the signed updater, and release
            artifacts include SHA-256 checksums and build provenance. Debian packages are updated manually. Windows
            v1 remains held until Authenticode signing and clean-install verification pass.
          </motion.p>
        </div>

        {/* right - status card with stamped checklist */}
        <motion.div
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 32 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: reduced ? 0.2 : 0.6, ease: EASE_EXPO }}
        >
          <GlassCard beam={false} className="p-4 sm:p-5">
            <p className="px-2 pb-3 pt-1 font-mono text-[0.75rem] uppercase tracking-[0.22em] text-ink-3">
              trust report
            </p>
            <div className="flex flex-col gap-1.5">
              {TRUST_ROWS.map((row, i) => {
                const Icon = row.icon;
                return (
                  <motion.div
                    key={row.label}
                    className="group/row flex items-center gap-3.5 rounded-row border border-transparent px-3 py-3 transition-[background-color,border-color] duration-200 hover:border-line hover:bg-[var(--surface-glass)]"
                    initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, amount: 0.6 }}
                    transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: i * 0.13 }}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-line bg-bg-2 text-ink-2 transition-colors duration-200 group-hover/row:text-brand">
                      <Icon className="h-[18px] w-[18px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-body text-[0.95rem] font-semibold leading-snug text-ink-1">
                        {row.label}
                      </span>
                      <span className="block truncate font-mono text-[0.75rem] tracking-[0.04em] text-ink-3 opacity-0 transition-opacity duration-200 group-hover/row:opacity-100">
                        {row.note}
                      </span>
                    </span>
                    <motion.span
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[rgba(var(--brand-rgb),0.12)] text-brand shadow-glow-brand"
                      initial={{ opacity: 0, scale: reduced ? 1 : 1.6 }}
                      whileInView={{ opacity: 1, scale: 1 }}
                      viewport={{ once: true, amount: 0.6 }}
                      transition={
                        reduced
                          ? { duration: 0.2, delay: i * 0.13 }
                          : { type: 'spring', stiffness: 300, damping: 16, delay: i * 0.13 + 0.7 }
                      }
                    >
                      {row.held ? (
                        <Clock className="h-3.5 w-3.5" strokeWidth={2.5} />
                      ) : (
                        <Check className="h-3.5 w-3.5" strokeWidth={3} />
                      )}
                    </motion.span>
                  </motion.div>
                );
              })}
            </div>
          </GlassCard>
        </motion.div>
      </div>
    </section>
  );
}
