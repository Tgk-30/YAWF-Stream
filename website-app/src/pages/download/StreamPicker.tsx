import { useEffect, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { AppWindow, Apple, Server, Smartphone, Terminal, Tv } from 'lucide-react';
import BackgroundVideo from '@/components/BackgroundVideo';
import StreamRow from '@/components/StreamRow';
import type { StreamRowMeta } from '@/components/StreamRow';
import { DOWNLOAD_LINKS, GITHUB_RELEASES_LATEST, VERSION } from '@/lib/site';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];
interface PickerRow {
  id: 'mac-arm' | 'mac-intel' | 'linux' | 'android-tv' | 'server' | 'pwa';
  icon: ReactNode;
  title: string;
  meta: StreamRowMeta[];
  size?: string;
  href: string;
}

const ROWS: PickerRow[] = [
  {
    id: 'mac-arm',
    icon: <Apple className="h-5 w-5" />,
    title: 'macOS - Apple Silicon',
    meta: [
      { label: 'Direct download', variant: 'instant' },
      { label: 'notarized', variant: 'dim' },
    ],
    size: '.dmg',
    href: DOWNLOAD_LINKS.macosArm,
  },
  {
    id: 'mac-intel',
    icon: <Apple className="h-5 w-5" />,
    title: 'macOS - Intel',
    meta: [
      { label: 'Direct download', variant: 'instant' },
      { label: 'notarized', variant: 'dim' },
    ],
    size: '.dmg',
    href: DOWNLOAD_LINKS.macosIntel,
  },
  {
    id: 'linux',
    icon: <Terminal className="h-5 w-5" />,
    title: 'Linux - AppImage',
    meta: [
      { label: 'Direct download', variant: 'instant' },
      { label: 'portable', variant: 'dim' },
    ],
    size: 'amd64',
    href: DOWNLOAD_LINKS.linuxAppImage,
  },
  {
    id: 'android-tv',
    icon: <Tv className="h-5 w-5" />,
    title: 'Android TV & Google TV',
    meta: [
      { label: 'Native Media3 player', variant: 'instant' },
      { label: 'D-pad ready', variant: 'dim' },
    ],
    size: '.apk',
    href: DOWNLOAD_LINKS.androidTV,
  },
  {
    id: 'server',
    icon: <Server className="h-5 w-5" />,
    title: 'Server - Debian or Ubuntu',
    meta: [
      { label: 'Manual package update', variant: 'dim' },
      { label: 'amd64 + arm64', variant: 'dim' },
    ],
    size: '.deb',
    href: DOWNLOAD_LINKS.serverDeb,
  },
  {
    id: 'pwa',
    icon: <Smartphone className="h-5 w-5" />,
    title: 'iPhone · iPad · Android - PWA',
    meta: [
      { label: 'served by your server', variant: 'dim' },
      { label: 'no app store', variant: 'dim' },
    ],
    size: 'install',
    href: '/devices',
  },
];

/**
 * Download section: platform packages presented as the app's stream list.
 */
export default function StreamPicker() {
  const reduced = useReducedMotion();
  const [detected, setDetected] = useState<PickerRow['id'] | 'mac' | 'unknown'>('unknown');

  useEffect(() => {
    let active = true;
    const detect = async () => {
      const ua = navigator.userAgent;
      if (/Android TV|GoogleTV|AFT|BRAVIA|SMART-TV/i.test(ua)) {
        if (active) setDetected('android-tv');
        return;
      }
      if (/iPhone|iPad|iPod|Android/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
        if (active) setDetected('pwa');
        return;
      }
      if (/Linux/i.test(navigator.platform) || /Linux/i.test(ua)) {
        if (active) setDetected('linux');
        return;
      }
      if (/Mac/i.test(navigator.platform) || /Mac OS/i.test(ua)) {
        const uaData = (navigator as Navigator & {
          userAgentData?: {
            getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; bitness?: string }>;
          };
        }).userAgentData;
        const values = await uaData?.getHighEntropyValues?.(['architecture', 'bitness']).catch(() => null);
        const architecture = values?.architecture?.toLowerCase();
        if (active) {
          setDetected(
            architecture?.includes('arm') === true
              ? 'mac-arm'
              : architecture?.includes('x86') === true
                ? 'mac-intel'
                : 'mac',
          );
        }
        return;
      }
      if (active) setDetected('unknown');
    };
    void detect();
    return () => {
      active = false;
    };
  }, []);

  const detectedLabel =
    detected === 'pwa'
      ? 'Mobile browser detected: install the PWA from your server.'
      : detected === 'android-tv'
        ? 'Android TV detected: install the signed TV APK.'
      : detected === 'linux'
        ? 'Linux detected: the amd64 AppImage is the desktop option shown here.'
        : detected === 'mac-arm'
          ? 'Apple Silicon Mac detected.'
          : detected === 'mac-intel'
            ? 'Intel Mac detected.'
            : detected === 'mac'
              ? 'macOS detected. Your browser did not expose the CPU architecture.'
              : 'Platform could not be detected. Choose the package manually.';

  return (
    <section className="relative overflow-hidden py-[clamp(88px,12vw,152px)]">
      {/* sonar stream-rings band behind the picker */}
      <BackgroundVideo src="/debridstreamer/streamrings-loop.mp4" poster="/debridstreamer/streamrings-poster.jpg" opacity={0.2} />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(180deg, var(--bg-0) 0%, color-mix(in srgb, var(--bg-0) 55%, transparent) 50%, var(--bg-0) 100%)',
        }}
      />

      <div className="relative mx-auto max-w-[880px] px-6 md:px-10">
        {/* signal-trace hairline plugging the hero into the list */}
        <motion.span
          aria-hidden="true"
          className="mx-auto -mt-[clamp(44px,6vw,76px)] mb-[clamp(44px,6vw,76px)] block h-16 w-px origin-top"
          style={{ backgroundImage: 'linear-gradient(180deg, transparent, var(--brand))' }}
          initial={{ scaleY: reduced ? 1 : 0 }}
          whileInView={{ scaleY: 1 }}
          viewport={{ once: true, amount: 0.9 }}
          transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO }}
        />

        {/* Honest release summary, without simulated cache or agent status. */}
        <motion.div
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.6 }}
          transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO }}
          className="glass-panel flex flex-col items-start justify-between gap-2 rounded-row px-4 py-3 sm:flex-row sm:items-center sm:gap-3"
        >
          <p className="font-mono text-[0.8125rem] tracking-[0.04em] text-ink-2">
            Choose your platform <span className="text-brand">{VERSION}</span>
          </p>
          <a
            href={GITHUB_RELEASES_LATEST}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 font-mono text-[0.75rem] tracking-[0.04em] text-ink-3 transition-colors hover:text-brand"
          >
            All release files
          </a>
        </motion.div>

        <p className="mt-3 text-center font-mono text-[0.75rem] leading-relaxed tracking-[0.04em] text-ink-3" role="status">
          {detectedLabel} Confirm the package and architecture before installing. The Debian server package has no
          in-app updater.
        </p>

        {/* the platform stream rows */}
        <div className="mt-4 flex flex-col gap-3">
          {ROWS.map((row, i) => (
            <motion.div
              key={row.title}
              className={`relative rounded-row${
                detected === row.id ||
                (detected === 'mac' && (row.id === 'mac-arm' || row.id === 'mac-intel'))
                  ? ' ring-1 ring-brand'
                  : ''
              }`}
              initial={reduced ? { opacity: 0 } : { opacity: 0, x: 80 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, amount: 0.6 }}
              transition={{ duration: reduced ? 0.2 : 0.6, ease: EASE_EXPO, delay: i * 0.12 }}
            >
              <StreamRow
                icon={row.icon}
                title={row.title}
                meta={row.meta}
                size={row.size}
                href={row.href}
                className="active:scale-[0.98]"
              />
              {i === 0 && (
                <motion.span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] origin-left rounded-full"
                  style={{ backgroundImage: 'var(--grad-stream)' }}
                  initial={{ scaleX: 0, opacity: 0 }}
                  whileInView={{ scaleX: [0, 1, 1], opacity: [0, 1, 0] }}
                  viewport={{ once: true, amount: 0.6 }}
                  transition={{ duration: 0.9, ease: EASE_EXPO, delay: reduced ? 0 : 0.7, times: [0, 0.85, 1] }}
                />
              )}
            </motion.div>
          ))}
        </div>

        <motion.div
          className="mt-3 flex items-start gap-3 rounded-row border border-line bg-[var(--surface-glass)] px-4 py-3 text-left"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.7 }}
          transition={{ duration: reduced ? 0.2 : 0.5, ease: EASE_EXPO }}
        >
          <AppWindow className="mt-0.5 h-5 w-5 shrink-0 text-ink-3" />
          <div>
            <p className="font-body text-[0.95rem] font-semibold text-ink-1">Windows release is held</p>
            <p className="mt-1 font-mono text-[0.75rem] leading-relaxed tracking-[0.04em] text-ink-3">
              It will ship after Authenticode signing and clean-install verification pass. No unsigned v1 installer
              will be published.
            </p>
          </div>
        </motion.div>

        <motion.p
          className="mt-6 text-center font-mono text-[0.8125rem] leading-relaxed tracking-[0.04em] text-ink-3"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: reduced ? 0 : 0.5 }}
        >
          Builds are published on GitHub Releases. View the{' '}
          <a
            href={GITHUB_RELEASES_LATEST}
            target="_blank"
            rel="noreferrer"
            className="rounded border border-line bg-[var(--surface-glass)] px-1.5 py-0.5 text-brand transition-colors hover:border-line-strong"
          >
            latest release
          </a>
          .
        </motion.p>
      </div>
    </section>
  );
}
