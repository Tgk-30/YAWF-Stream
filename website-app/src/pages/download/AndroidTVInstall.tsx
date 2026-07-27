import { AlertTriangle, Link2, Settings2, ShieldCheck, Tv, Undo2 } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { PrimaryButton } from '@/components/Buttons';
import GlassCard from '@/components/GlassCard';
import SectionHeading from '@/components/SectionHeading';
import { DOWNLOAD_LINKS } from '@/lib/site';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

const STEPS = [
  {
    icon: Settings2,
    title: 'Allow one sideload app',
    body: 'Fire TV: Settings > My Fire TV > Developer Options > Install unknown apps, then enable Downloader. Google TV: Settings > Apps > Security and restrictions > Unknown sources, then enable Downloader.',
  },
  {
    icon: Link2,
    title: 'Fetch the signed APK',
    body: 'Open Downloader, type the URL below, and install when the prompt appears. There is no browser or terminal on a TV, so sideloading is the install path.',
  },
  {
    icon: Tv,
    title: 'Connect and play',
    body: 'Enter the same LAN, Tailscale, or HTTPS server URL you use elsewhere. Browse with the D-pad. Playback moves into the native Media3 player with resume, language preferences, subtitles, and buffering controls.',
  },
  {
    icon: Undo2,
    title: 'Change the server later',
    body: 'Press Menu on the remote at any time to return to the address screen. If the saved server stops responding, the app offers Try again and Change server instead of stranding you. Google TV and Chromecast remotes have no Menu key, so use the on-screen button there.',
  },
] as const;

export default function AndroidTVInstall() {
  const reduced = useReducedMotion();

  return (
    <section className="relative py-[clamp(88px,12vw,152px)]">
      <div className="mx-auto max-w-content px-6 md:px-10">
        <SectionHeading
          eyebrow="// ANDROID TV AND FIRE TV"
          title="Native playback for the big screen."
          lede="The TV app keeps browsing connected to your YAWF Stream server and hands video to Android's native Media3 player. It needs a running YAWF Stream server, so set that up first."
        >
          <div className="mt-8">
            <PrimaryButton href={DOWNLOAD_LINKS.androidTV}>Download Android TV APK</PrimaryButton>
          </div>
        </SectionHeading>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
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

        <div className="mt-7 rounded-row border border-line bg-[var(--surface-glass)] p-4 font-mono text-xs leading-relaxed text-ink-2">
          <p className="text-ink-1">Enter this in Downloader</p>
          <p className="mt-2 break-all">{DOWNLOAD_LINKS.androidTV}</p>
          <p className="mt-3">
            Prefer a keyboard: adb connect &lt;tv-ip&gt;:5555 then adb install -r &lt;downloaded-apk&gt;
          </p>
        </div>

        <div className="mt-5 rounded-row border border-line bg-[var(--surface-glass)] p-4">
          <p className="flex items-start gap-2 text-[0.95rem] leading-[1.7] text-ink-2">
            <AlertTriangle className="mt-1 h-4 w-4 shrink-0 text-brand" />
            <span>
              <span className="text-ink-1">Needs Android 6.0 or newer.</span> That covers Fire TV Stick 4K, 4K Max,
              Lite, 3rd generation, and Fire TV Cube, plus Android TV and Google TV devices. It does not cover Fire OS 5
              hardware, so the 2nd generation Fire TV Stick, the Fire TV Stick Basic Edition, and the original Fire TV
              boxes cannot install it.
            </span>
          </p>
        </div>

        <p className="mt-6 flex items-start gap-2 font-mono text-[0.75rem] leading-relaxed tracking-[0.04em] text-ink-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
          The APK uses a stable YAWF Stream signing identity so future updates install over the existing TV app. Verify
          it against SHA256SUMS from a computer before sideloading if you want the checksum trail.
        </p>
      </div>
    </section>
  );
}
