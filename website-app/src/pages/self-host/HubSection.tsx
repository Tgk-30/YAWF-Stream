import { memo, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Globe, KeyRound, LockKeyhole, ServerCog, ShieldCheck, Users } from 'lucide-react';
import { gsap, useGSAP } from '@/lib/gsap';
import { usePrefersReducedMotion } from '@/lib/motion';
import { cn } from '@/lib/utils';
import ServerCoreStage from '@/pages/self-host/ServerCoreStage';
import type { ServerCoreDriver } from '@/components/three/ServerCoreScene';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

const RESPONSIBILITIES = [
  { icon: KeyRound, title: 'Logins & sessions', line: 'every sign-in, every stream session, brokered in one place.' },
  { icon: Users, title: 'Profile isolation', line: "each person's library stays theirs." },
  { icon: LockKeyhole, title: 'Encrypted credentials', line: 'debrid keys stored encrypted, never synced away.' },
  { icon: Globe, title: 'Provider-facing IP', line: "providers see the server's IP - not your devices'." },
  { icon: ServerCog, title: 'Stream broker', line: 'devices ask; the server resolves, caches, and serves.' },
];

/** Warm glow pulse on the callout - isolated perpetual loop. */
const GlowPulse = memo(function GlowPulse() {
  const reduced = useReducedMotion();
  if (reduced) return null;
  return (
    <motion.span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 rounded-card"
      animate={{ boxShadow: ['0 0 0px rgba(var(--warm-rgb), 0)', 'var(--glow-warm)', '0 0 0px rgba(var(--warm-rgb), 0)'] }}
      transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
    />
  );
});

/**
 * Section 2 - Server Core (3D) + "what the server owns".
 * Scroll scrub rotates the rig 180°; list ↔ glyph bi-directional hover.
 */
export default function HubSection() {
  const reduced = usePrefersReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);
  const driverRef = useRef<ServerCoreDriver>({ scroll: 0, pointerX: 0, pointerY: 0, intro: 0, highlight: -1 });
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    driverRef.current.highlight = active ?? -1;
  }, [active]);

  useGSAP(
    () => {
      if (reduced) return;
      // scroll-scrubbed 180° turn across the section
      gsap.to(driverRef.current, {
        scroll: 1,
        ease: 'none',
        scrollTrigger: { trigger: sectionRef.current, start: 'top bottom', end: 'bottom top', scrub: 0.6 },
      });
    },
    { scope: sectionRef, dependencies: [reduced] },
  );

  const onPointerMove = (e: ReactPointerEvent) => {
    const r = sectionRef.current?.getBoundingClientRect();
    if (!r) return;
    driverRef.current.pointerX = ((e.clientX - r.left) / r.width) * 2 - 1;
    driverRef.current.pointerY = -(((e.clientY - r.top) / r.height) * 2 - 1);
  };

  return (
    <section
      ref={sectionRef}
      onPointerMove={onPointerMove}
      className="relative overflow-hidden py-[clamp(88px,12vw,152px)]"
    >
      <div className="mx-auto grid min-h-[90vh] max-w-content grid-cols-1 items-center gap-10 px-6 md:px-10 lg:grid-cols-[55%_45%] lg:gap-6">
        {/* left - Scene C */}
        <ServerCoreStage
          driver={driverRef}
          onGlyphHover={setActive}
          className="h-[380px] md:h-[560px]"
        />

        {/* right - copy + responsibility list */}
        <div className="lg:pl-6">
          <motion.p
            className="eyebrow"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true, amount: 0.8 }}
            transition={{ duration: reduced ? 0.2 : 0.6 }}
          >
            {'// THE HUB'}
          </motion.p>
          <motion.h2
            className="display-m mt-4 font-display"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 32, filter: 'blur(8px)' }}
            whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            viewport={{ once: true, amount: 0.8 }}
            transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO }}
          >
            The server runs the show.
          </motion.h2>

          <ul className="mt-8 space-y-2.5">
            {RESPONSIBILITIES.map((item, i) => {
              const Icon = item.icon;
              const isActive = active === i;
              return (
                <motion.li
                  key={item.title}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: 28 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, amount: 0.6 }}
                  transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: i * 0.09 }}
                >
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onMouseLeave={() => setActive(null)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                    className={cn(
                      'group flex w-full items-center gap-4 rounded-row border px-4 py-3 text-left',
                      'transition-[background-color,border-color,transform] duration-300 ease-expo',
                      isActive
                        ? 'border-line-strong bg-[var(--surface-glass-2)] shadow-glow-brand'
                        : 'border-line bg-[var(--surface-glass)] hover:bg-[var(--surface-glass-2)]',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line bg-bg-2 transition-all duration-300',
                        isActive ? 'text-brand shadow-glow-brand' : 'text-ink-2 group-hover:text-brand',
                      )}
                    >
                      <Icon className="h-5 w-5" strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0">
                      <span className="block font-body text-[1rem] font-semibold leading-[1.5] text-ink-1">
                        {item.title}
                      </span>
                      <span className="block truncate font-body text-[0.875rem] leading-[1.5] text-ink-2">
                        {item.line}
                      </span>
                    </span>
                  </button>
                </motion.li>
              );
            })}
          </ul>

          <motion.div
            className="relative mt-6 rounded-card border border-[rgba(var(--warm-rgb),0.35)] bg-[var(--surface-glass)] p-5"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.8 }}
            transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: 0.5 }}
          >
            <GlowPulse />
            <div className="relative flex items-center gap-3.5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[rgba(var(--warm-rgb),0.4)] bg-bg-2 text-warm shadow-glow-warm">
                <ShieldCheck className="h-5 w-5" strokeWidth={1.75} />
              </span>
              <p className="font-body text-[1rem] font-semibold leading-[1.6] text-ink-1">
                Credentials stay encrypted on your server and go only to the providers they belong to.
              </p>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
