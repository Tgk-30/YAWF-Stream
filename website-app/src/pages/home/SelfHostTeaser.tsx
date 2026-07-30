import { motion, useReducedMotion } from 'framer-motion';
import Chip from '@/components/Chip';
import SectionHeading from '@/components/SectionHeading';
import TerminalBlock from '@/components/TerminalBlock';
import { GhostButton } from '@/components/Buttons';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

const TERMINAL_LINES = [
  { text: 'mkdir debridstreamer && cd debridstreamer' },
  { text: 'curl -fsSLO https://raw.githubusercontent.com/Tgk-30/YAWF-Stream/main/deploy/compose/docker-compose.ghcr.yml' },
  { text: 'curl -fsSL https://raw.githubusercontent.com/Tgk-30/YAWF-Stream/main/deploy/compose/.env.example -o .env' },
  { text: 'docker compose -f docker-compose.ghcr.yml up -d' },
];

const META_CHIPS = ['multi-arch: amd64 + arm64', 'prebuilt image', 'native Node + systemd too'];

/** Section 6 - Self-host teaser: Docker quickstart terminal + pitch. */
export default function SelfHostTeaser() {
  const reduced = useReducedMotion();

  return (
    <section className="bg-bg-1 py-[clamp(88px,12vw,152px)]">
      <div className="mx-auto grid grid-cols-1 max-w-content items-center gap-12 px-6 md:px-10 lg:grid-cols-2">
        <div>
          <TerminalBlock title="docker - quickstart" lines={TERMINAL_LINES} />
          <div className="mt-5 flex flex-wrap gap-2.5">
            {META_CHIPS.map((chip, i) => (
              <motion.span
                key={chip}
                initial={{ opacity: 0, y: reduced ? 0 : 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.8 }}
                transition={{ duration: reduced ? 0.2 : 0.4, ease: EASE_EXPO, delay: 0.6 + i * 0.09 }}
              >
                <Chip variant="outline">{chip}</Chip>
              </motion.span>
            ))}
          </div>
        </div>

        <SectionHeading
          eyebrow="// SELF-HOST"
          title="One server. Every screen."
          lede="Run it on an always-on desktop, NAS, VPS, Raspberry Pi, or home server. Credentials stay encrypted on your server and are sent only to the providers they belong to."
          className="lg:order-first"
        >
          <div className="mt-8">
            <GhostButton to="/self-host">Self-hosting guide</GhostButton>
          </div>
        </SectionHeading>
      </div>
    </section>
  );
}
