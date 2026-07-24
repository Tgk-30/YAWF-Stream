import { Download, Link2, ShieldCheck, Tv } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { PrimaryButton } from '@/components/Buttons';
import GlassCard from '@/components/GlassCard';
import SectionHeading from '@/components/SectionHeading';
import { DOWNLOAD_LINKS } from '@/lib/site';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

const STEPS = [
  {
    icon: Download,
    title: 'Install the signed APK',
    body: 'Download the Android TV APK, verify it against SHA256SUMS, then allow your chosen file manager to install this app.',
  },
  {
    icon: Link2,
    title: 'Connect your server',
    body: 'Enter the same LAN, Tailscale, or HTTPS server URL you use on your other devices. Use HTTPS for public remote access.',
  },
  {
    icon: Tv,
    title: 'Play with the TV player',
    body: 'Browse with the D-pad. Playback moves into the native Media3 player with resume, language preferences, subtitles, and buffering controls.',
  },
] as const;

export default function AndroidTVInstall() {
  const reduced = useReducedMotion();

  return (
    <section className="relative py-[clamp(88px,12vw,152px)]">
      <div className="mx-auto max-w-content px-6 md:px-10">
        <SectionHeading
          eyebrow="// ANDROID TV"
          title="Native playback for the big screen."
          lede="The TV app keeps browsing connected to your YAWF Stream server and hands video to Android's native Media3 player."
        >
          <div className="mt-8">
            <PrimaryButton href={DOWNLOAD_LINKS.androidTV}>Download Android TV APK</PrimaryButton>
          </div>
        </SectionHeading>

        <div className="mt-12 grid gap-5 lg:grid-cols-3">
          {STEPS.map((step, index) => {
            const Icon = step.icon;
            return (
              <motion.div
                key={step.title}
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 32 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.45 }}
                transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO, delay: index * 0.1 }}
              >
                <GlassCard className="h-full">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-bg-2 text-brand">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h3 className="display-s mt-4 font-display">{step.title}</h3>
                  <p className="mt-2 text-[0.95rem] leading-[1.7] text-ink-2">{step.body}</p>
                </GlassCard>
              </motion.div>
            );
          })}
        </div>

        <p className="mt-6 flex items-start gap-2 font-mono text-[0.75rem] leading-relaxed tracking-[0.04em] text-ink-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
          The APK uses a stable YAWF Stream signing identity so future updates install over the existing TV app.
        </p>
      </div>
    </section>
  );
}
