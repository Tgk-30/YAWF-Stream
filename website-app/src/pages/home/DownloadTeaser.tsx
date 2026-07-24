import { motion, useReducedMotion } from 'framer-motion';
import { AppWindow, Apple, Smartphone, Terminal, Tv } from 'lucide-react';
import BackgroundVideo from '@/components/BackgroundVideo';
import SectionHeading from '@/components/SectionHeading';
import StreamRow from '@/components/StreamRow';
import { PrimaryButton } from '@/components/Buttons';
import { DOWNLOAD_LINKS, VERSION } from '@/lib/site';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];

const ROWS = [
  {
    icon: <Apple className="h-5 w-5" />,
    title: 'macOS - Apple Silicon',
    meta: [
      { label: 'Direct download', variant: 'instant' as const },
      { label: 'notarized', variant: 'dim' as const },
    ],
    size: '.dmg',
    href: DOWNLOAD_LINKS.macosArm,
  },
  {
    icon: <Terminal className="h-5 w-5" />,
    title: 'Linux - AppImage',
    meta: [
      { label: 'Direct download', variant: 'instant' as const },
      { label: 'portable', variant: 'dim' as const },
    ],
    size: '.AppImage',
    href: DOWNLOAD_LINKS.linuxAppImage,
  },
  {
    icon: <Tv className="h-5 w-5" />,
    title: 'Android TV & Google TV',
    meta: [
      { label: 'Native player', variant: 'instant' as const },
      { label: 'D-pad ready', variant: 'dim' as const },
    ],
    size: '.apk',
    href: DOWNLOAD_LINKS.androidTV,
  },
  {
    icon: <Smartphone className="h-5 w-5" />,
    title: 'Phone & tablet PWA',
    meta: [{ label: 'from your server', variant: 'dim' as const }],
    href: '/devices',
  },
];

/** Section 5 - Download teaser: "Pick a stream" split with cascading StreamRows. */
export default function DownloadTeaser() {
  const reduced = useReducedMotion();

  return (
    <section className="relative overflow-hidden py-[clamp(88px,12vw,152px)]">
      {/* bonus: sonar rings echoing the logo, low + scrimmed */}
      <BackgroundVideo src="/debridstreamer/streamrings-loop.mp4" poster="/debridstreamer/streamrings-poster.jpg" opacity={0.22} />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(180deg, var(--bg-0) 0%, color-mix(in srgb, var(--bg-0) 55%, transparent) 50%, var(--bg-0) 100%)',
        }}
      />

      <div className="relative mx-auto grid max-w-content items-center gap-12 px-6 md:px-10 lg:grid-cols-[2fr_3fr]">
        <SectionHeading
          eyebrow="// DOWNLOAD"
          title="Pick a stream."
          lede="Downloads presented the way the app presents sources: fast, clear, instant."
        >
          <div className="mt-8">
            <PrimaryButton to="/download">All downloads</PrimaryButton>
          </div>
          <p className="mt-5 font-mono text-[0.8125rem] tracking-[0.04em] text-ink-3">
            Latest: {VERSION} · GitHub Releases
          </p>
        </SectionHeading>

        <div className="flex flex-col gap-3">
          {ROWS.map((row, i) => (
            <motion.div
              key={row.title}
              initial={reduced ? { opacity: 0 } : { opacity: 0, x: 60 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, amount: 0.6 }}
              transition={{ duration: reduced ? 0.2 : 0.55, ease: EASE_EXPO, delay: i * 0.11 }}
            >
              <StreamRow icon={row.icon} title={row.title} meta={row.meta} size={row.size} href={row.href} />
            </motion.div>
          ))}
          <div className="flex items-start gap-3 rounded-row border border-line bg-[var(--surface-glass)] px-4 py-3">
            <AppWindow className="mt-0.5 h-5 w-5 shrink-0 text-ink-3" />
            <div>
              <p className="font-body text-[0.9rem] font-semibold text-ink-1">Windows release is held</p>
              <p className="mt-1 font-mono text-[0.75rem] leading-relaxed tracking-[0.04em] text-ink-3">
                Publishing after Authenticode signing passes.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
