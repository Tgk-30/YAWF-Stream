import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Lock, LockOpen, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import Chip from '@/components/Chip';
import { POSTERS, posterSrc, ratingLabel } from '@/pages/household/data';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];
const SPRING = { type: 'spring', stiffness: 300, damping: 30 } as const;

const LEVELS = [
  { label: 'Everyone', value: 0 },
  { label: '7+', value: 7 },
  { label: '13+', value: 13 },
  { label: '16+', value: 16 },
  { label: '18+', value: 18 },
];

type ProfileId = 'Kids' | 'Alex';

/** 4-dot passcode sheet - any 4 digits unlock the switch to Alex. */
function PasscodeSheet({ onUnlock, onClose }: { onUnlock: () => void; onClose: () => void }) {
  const [entered, setEntered] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(onUnlock, 650);
    return () => window.clearTimeout(t);
  }, [done, onUnlock]);

  const digit = () => {
    if (done) return;
    const next = entered + 1;
    setEntered(next);
    if (next >= 4) setDone(true);
  };

  return (
    <motion.div
      className="absolute inset-x-3 bottom-3 z-20 rounded-card border border-line-strong bg-bg-1/95 p-4 shadow-card backdrop-blur-md"
      initial={{ y: 48, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 48, opacity: 0 }}
      transition={{ duration: 0.3, ease: EASE_EXPO }}
      role="dialog"
      aria-label="Parental lock passcode"
    >
      <div className="mb-3 flex items-center justify-between">
        <p className="font-mono text-[0.75rem] tracking-[0.04em] text-ink-2">
          {done ? <span className="text-brand">unlocked ✓</span> : 'parental lock - enter passcode'}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close passcode sheet"
          className="flex h-6 w-6 items-center justify-center rounded-md border border-line text-ink-3 transition-colors hover:text-ink-1"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="mb-3 flex items-center justify-center gap-2" aria-label={`${entered} of 4 digits entered`}>
        {[0, 1, 2, 3].map((i) => (
          <motion.span
            key={i}
            className={cn('h-2.5 w-2.5 rounded-full border', i < entered ? 'border-brand bg-brand' : 'border-line-strong bg-transparent')}
            animate={i < entered ? { scale: [1, 1.5, 1] } : { scale: 1 }}
            transition={{ duration: 0.25 }}
          />
        ))}
      </div>
      <div className="grid grid-cols-5 gap-1.5">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((d) => (
          <button
            key={d}
            type="button"
            onClick={digit}
            aria-label={`Digit ${d}`}
            className="flex h-8 items-center justify-center rounded-md border border-line bg-[var(--surface-glass)] font-mono text-[0.75rem] text-ink-2 transition-[background-color,border-color,color,transform] duration-150 hover:border-line-strong hover:text-brand active:scale-95"
          >
            {d}
          </button>
        ))}
      </div>
    </motion.div>
  );
}

/**
 * Section 3 - Kids & maturity limits: the interactive dial demo.
 * Selecting a segment dims/blurs/desaturates every poster above the cap;
 * the parental lock gates the profile switcher behind a passcode sheet.
 * Default state: 13+ with lock on. Fully live and replayable.
 */
export default function KidsDial() {
  const reduced = useReducedMotion();
  const [cap, setCap] = useState(13);
  const [locked, setLocked] = useState(true);
  const [profile, setProfile] = useState<ProfileId>('Kids');
  const [sheetOpen, setSheetOpen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  const effectiveCap = profile === 'Alex' ? 18 : cap;
  const hiddenCount = POSTERS.filter((p) => p.rating > effectiveCap).length;

  const switchProfile = (next: ProfileId) => {
    if (next === profile) return;
    if (next === 'Alex' && locked) {
      setSheetOpen(true);
      return;
    }
    setProfile(next);
  };

  const status = locked
    ? profile === 'Alex'
      ? 'full access - relock when you leave'
      : 'locked - kids mode'
    : profile === 'Alex'
      ? 'unlocked - full access'
      : 'kids mode - lock off';

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
            {'// KIDS'}
          </motion.p>
          <motion.h2
            className="display-m mt-4 font-display"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 32, filter: 'blur(8px)' }}
            whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            viewport={{ once: true, amount: 0.8 }}
            transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO }}
          >
            A maturity ceiling, not a locked door.
          </motion.h2>
          <motion.p
            className="mt-5 max-w-[520px] font-body text-[1rem] leading-[1.7] text-ink-2"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.8 }}
            transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: 0.12 }}
          >
            Kid profiles cap the rating they can browse and play. Everything above the cap simply isn&apos;t there -
            and a parental lock stops clever switcheroos when adults leave the room.
          </motion.p>
          <motion.div
            className="mt-7 flex flex-wrap gap-2.5"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.8 }}
            transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: 0.2 }}
          >
            <Chip variant="outline">rating cap per profile</Chip>
            <Chip variant="outline">parental lock to switch out</Chip>
            <Chip variant="outline">no admin screens for kids</Chip>
          </motion.div>
        </div>

        {/* right - the dial demo */}
        <motion.div
          ref={stageRef}
          className="glass-panel relative overflow-hidden rounded-stage p-4 md:p-6"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 40, filter: 'blur(8px)' }}
          whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: reduced ? 0.2 : 0.6, ease: EASE_EXPO }}
        >
          {/* header: profile + status */}
          <div className="mb-4 flex items-center justify-between gap-3">
            <Chip variant={profile === 'Kids' ? 'warm' : 'featured'}>{profile} profile</Chip>
            <AnimatePresence mode="wait">
              <motion.span
                key={status}
                className={cn('font-mono text-[0.6875rem] tracking-[0.04em]', locked && profile === 'Kids' ? 'text-warm' : 'text-accent2')}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.25 }}
                aria-live="polite"
              >
                {status}
              </motion.span>
            </AnimatePresence>
          </div>

          {/* segmented maturity dial */}
          <div
            role="radiogroup"
            aria-label="Maturity cap"
            className="relative flex overflow-x-auto rounded-chip border border-line bg-[var(--surface-glass)] p-1"
          >
            {LEVELS.map((l) => {
              const active = cap === l.value;
              return (
                <button
                  key={l.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setCap(l.value)}
                  className="relative flex-1 whitespace-nowrap rounded-chip px-3 py-1.5 font-mono text-[0.75rem] tracking-[0.04em]"
                >
                  {active && (
                    <motion.span
                      layoutId="kids-dial-pill"
                      className="absolute inset-0 rounded-chip border border-line-strong bg-[var(--surface-glass-2)]"
                      transition={reduced ? { duration: 0.15 } : SPRING}
                    />
                  )}
                  <span className={cn('relative z-10 transition-colors duration-200', active ? 'text-brand' : 'text-ink-3 hover:text-ink-2')}>
                    {l.label}
                  </span>
                </button>
              );
            })}
          </div>

          {/* counter */}
          <div className="mt-3 flex items-center justify-between" aria-live="polite">
            <AnimatePresence mode="wait">
              <motion.span
                key={hiddenCount}
                className={cn('font-mono text-[0.75rem] tracking-[0.04em]', hiddenCount > 0 ? 'text-warm' : 'text-accent2')}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.25 }}
              >
                {hiddenCount} of 8 titles hidden
              </motion.span>
            </AnimatePresence>
            <span className="font-mono text-[0.6875rem] tracking-[0.04em] text-ink-3">
              cap applies to browse + play
            </span>
          </div>

          {/* poster wall */}
          <div className="mt-4 grid grid-cols-4 gap-2.5 md:gap-3">
            {POSTERS.map((p, i) => {
              const hidden = p.rating > effectiveCap;
              return (
                <motion.figure
                  key={p.n}
                  animate={
                    hidden
                      ? { opacity: 0.28, filter: 'blur(3px) saturate(0.2)' }
                      : { opacity: 1, filter: 'blur(0px) saturate(1)' }
                  }
                  transition={{ duration: reduced ? 0.2 : 0.3, delay: reduced ? 0 : i * 0.04 }}
                >
                  <div className="relative overflow-hidden rounded-md border border-line">
                    <img
                      src={posterSrc(p.n)}
                      alt={p.title}
                      loading="lazy"
                      draggable={false}
                      className="aspect-[2/3] w-full object-cover"
                    />
                    <span
                      className={cn(
                        'absolute left-1 top-1 rounded border px-1 py-px font-mono text-[0.5625rem] tracking-[0.06em]',
                        hidden ? 'border-line bg-bg-0/80 text-ink-3' : 'border-line-strong bg-bg-0/80 text-brand',
                      )}
                    >
                      {ratingLabel(p.rating)}
                    </span>
                  </div>
                  <figcaption className="mt-1 truncate text-center font-mono text-[0.5625rem] uppercase tracking-[0.08em] text-ink-3">
                    {p.title}
                  </figcaption>
                </motion.figure>
              );
            })}
          </div>

          {/* footer: profile switcher + parental lock */}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <div className="flex rounded-chip border border-line bg-[var(--surface-glass)] p-1" role="group" aria-label="Profile switcher">
              {(['Kids', 'Alex'] as const).map((p) => {
                const active = profile === p;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => switchProfile(p)}
                    aria-pressed={active}
                    className="relative flex items-center gap-1.5 whitespace-nowrap rounded-chip px-3.5 py-1.5 font-mono text-[0.75rem] tracking-[0.04em]"
                  >
                    {active && (
                      <motion.span
                        layoutId="kids-profile-pill"
                        className="absolute inset-0 rounded-chip border border-line-strong bg-[var(--surface-glass-2)]"
                        transition={reduced ? { duration: 0.15 } : SPRING}
                      />
                    )}
                    <span className={cn('relative z-10 flex items-center gap-1.5', active ? 'text-brand' : 'text-ink-3 hover:text-ink-2')}>
                      {p === 'Kids' && locked && <Lock className="h-3 w-3 text-warm" />}
                      {p}
                    </span>
                  </button>
                );
              })}
            </div>
            <label className="flex cursor-pointer items-center gap-2.5 font-mono text-[0.75rem] tracking-[0.04em] text-ink-2">
              {locked ? <Lock className="h-3.5 w-3.5 text-warm" /> : <LockOpen className="h-3.5 w-3.5 text-accent2" />}
              parental lock
              <Switch
                checked={locked}
                onCheckedChange={setLocked}
                aria-label="Parental lock"
                className="data-[state=checked]:bg-[var(--warm)] data-[state=unchecked]:bg-bg-2 data-[state=unchecked]:border-line-strong"
              />
            </label>
          </div>

          {/* passcode sheet */}
          <AnimatePresence>
            {sheetOpen && (
              <PasscodeSheet
                onUnlock={() => {
                  setSheetOpen(false);
                  setProfile('Alex');
                }}
                onClose={() => setSheetOpen(false)}
              />
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </section>
  );
}
