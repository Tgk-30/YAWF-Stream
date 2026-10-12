import { CheckCircle2, FileKey2, ShieldCheck, Terminal } from 'lucide-react';
import {
  GITHUB_DESKTOP_RELEASE,
  RELEASE_LINKS,
} from '@/lib/site';

const STEPS = [
  {
    icon: FileKey2,
    title: 'Get the checksum list',
    body: 'Download SHA256SUMS from the matching platform release channel, not a generic latest release.',
  },
  {
    icon: Terminal,
    title: 'Calculate SHA-256',
    body: 'Run sha256sum on Linux or shasum -a 256 on macOS, then compare the complete value.',
  },
  {
    icon: ShieldCheck,
    title: 'Check platform trust',
    body: 'macOS should pass Gatekeeper and notarization. GitHub displays build provenance for attested release files.',
  },
  {
    icon: CheckCircle2,
    title: 'Install the right package',
    body: 'Use the package matching your operating system and CPU. Debian server packages support amd64 and arm64.',
  },
];

export default function Verify() {
  return (
    <section className="border-y border-line bg-bg-1 py-[clamp(88px,12vw,152px)]" id="verify">
      <div className="mx-auto max-w-content px-6 md:px-10">
        <p className="eyebrow">// VERIFY BEFORE INSTALLING</p>
        <h2 className="display-m mt-5 max-w-[760px] font-display">Trust the file you actually downloaded.</h2>
        <p className="mt-5 max-w-[720px] leading-[1.7] text-ink-2">
          A release page, checksum, platform signature, and provenance record answer different questions. Check all
          available signals before running a new build.
        </p>

        <div className="mt-9 grid gap-4 md:grid-cols-2">
          {STEPS.map(({ icon: Icon, title, body }) => (
            <article key={title} className="glass-panel rounded-card p-6">
              <Icon className="h-5 w-5 text-brand" />
              <h3 className="mt-4 font-display text-xl text-ink-1">{title}</h3>
              <p className="mt-2 leading-relaxed text-ink-2">{body}</p>
            </article>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap gap-3">
          <a
            href={RELEASE_LINKS.desktopChecksums}
            className="inline-flex min-h-11 items-center rounded-chip bg-brand px-5 py-3 font-semibold text-[var(--ink-on-brand)]"
          >
            Desktop and TV SHA256SUMS
          </a>
          <a
            href={RELEASE_LINKS.androidPhoneChecksums}
            className="inline-flex min-h-11 items-center rounded-chip border border-line px-5 py-3 font-semibold text-ink-1"
          >
            Android SHA256SUMS
          </a>
          <a
            href={RELEASE_LINKS.serverChecksums}
            className="inline-flex min-h-11 items-center rounded-chip border border-line px-5 py-3 font-semibold text-ink-1"
          >
            Server SHA256SUMS
          </a>
          <a
            href={GITHUB_DESKTOP_RELEASE}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center rounded-chip border border-line px-5 py-3 font-semibold text-ink-1"
          >
            Desktop release and provenance
          </a>
        </div>

        <div className="mt-7 rounded-row border border-line bg-[var(--surface-glass)] p-4 font-mono text-xs leading-relaxed text-ink-2">
          <p>Linux: sha256sum -c SHA256SUMS --ignore-missing</p>
          <p className="mt-2">macOS: shasum -a 256 &lt;downloaded-file&gt;</p>
          <p className="mt-2">
            Provenance: gh attestation verify &lt;downloaded-file&gt; --repo Tgk-30/YAWF-Stream
          </p>
          <p className="mt-2">
            Debian server: install a newer verified .deb manually. It does not use the desktop in-app updater.
          </p>
          <p className="mt-2">
            Server updater: verify the{' '}
            <a href={RELEASE_LINKS.serverUpdateManifest} className="text-brand hover:text-accent2">
              update manifest
            </a>{' '}
            and{' '}
            <a href={RELEASE_LINKS.serverVerification} className="text-brand hover:text-accent2">
              verification record
            </a>{' '}
            before installing the optional Docker helper.
          </p>
        </div>
      </div>
    </section>
  );
}
