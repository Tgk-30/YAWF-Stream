import { Bug, Download, KeyRound, LifeBuoy, LockKeyhole, PlayCircle, Server } from 'lucide-react';
import { GITHUB_BUG_REPORT, GITHUB_REPO } from '@/lib/site';

const FAQ = [
  {
    question: 'Why am I seeing sample titles?',
    answer:
      'Discover labels bundled samples when no TMDB key is configured or the live catalog fails. Add or validate the TMDB key under Settings, API keys. Sample titles are never returned as live search results.',
  },
  {
    question: 'Why does my server URL work in a browser but not in the app?',
    answer:
      'Confirm the complete HTTP or HTTPS address, including port 43110 for the default server. Cloudflare Access and other identity proxies must allow both the webview and playback requests. You can forget the saved server from the unavailable screen and reconnect.',
  },
  {
    question: 'What should I do when playback fails?',
    answer:
      'Try another cached source first. Then open Settings, Help & updates, run the provider checks, and export diagnostics. The diagnostic file removes credentials and private URLs before it is saved.',
  },
  {
    question: 'Can the server operator see what I watch?',
    answer:
      'Yes. The operator can administer profiles and can see operational activity such as active stream filenames, audit events, and usage records. A profile password is a household access control, not end-to-end encryption from the operator.',
  },
  {
    question: 'Where are provider credentials sent?',
    answer:
      'Credentials are stored encrypted on the server and sent only to the provider they belong to. Local desktop credentials stay on that device but are still sent to the configured provider when the app makes an authorized request.',
  },
  {
    question: 'Does every Linux package update itself?',
    answer:
      'No. AppImage builds use the signed in-app updater. Debian desktop and server packages are updated manually by installing a newer package or following the documented package-manager procedure.',
  },
  {
    question: 'How do I install the mobile app?',
    answer:
      'Open your YAWF Stream server in Safari on iPhone or iPad, or Chrome on Android, and use Add to Home Screen or Install app. On Android this requires HTTPS: Chrome hides the install option on a plain http:// address, so a LAN IP alone will not work. iPhone and iPad can add to the home screen either way.',
  },
  {
    question: 'How do I recover an owner account or restore a backup?',
    answer:
      'Use the recovery runbook in the repository documentation. Recovery commands must be run locally on the server so remote users cannot reset the owner account.',
  },
];

const ACTIONS = [
  {
    icon: KeyRound,
    title: 'Catalog or provider problem',
    body: 'Validate the saved key or token, then run read-only provider checks from the desktop app.',
  },
  {
    icon: Server,
    title: 'Server unavailable',
    body: 'Check /api/health, the server logs, secure-cookie settings, and the configured public URL.',
  },
  {
    icon: PlayCircle,
    title: 'Playback problem',
    body: 'Try another cached source, capture the exact player message, then export diagnostics.',
  },
  {
    icon: Download,
    title: 'Install or update problem',
    body: 'Confirm the package type, architecture, signature, and whether that package supports in-app updates.',
  },
];

export default function Help() {
  return (
    <div className="mx-auto max-w-content px-6 pb-[clamp(88px,12vw,152px)] pt-36 md:px-10">
      <section className="max-w-[780px]">
        <p className="eyebrow">// HELP & RECOVERY</p>
        <h1 className="display-xl mt-5 font-display">Fix the problem, then tell us what happened.</h1>
        <p className="mt-6 max-w-[680px] text-lg leading-relaxed text-ink-2">
          Start with the recovery path that matches the failure. If it still fails, export diagnostics from the app
          before opening a bug report.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <a
            href={GITHUB_BUG_REPORT}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-2 rounded-chip bg-brand px-5 py-3 font-semibold text-[var(--ink-on-brand)]"
          >
            <Bug className="h-4 w-4" />
            Report a bug
          </a>
          <a
            href={`${GITHUB_REPO}/blob/main/docs/recovery.md`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-2 rounded-chip border border-line px-5 py-3 font-semibold text-ink-1"
          >
            <LockKeyhole className="h-4 w-4" />
            Recovery runbook
          </a>
        </div>
      </section>

      <section className="mt-16 grid gap-4 md:grid-cols-2" aria-labelledby="help-first-steps">
        <h2 id="help-first-steps" className="sr-only">
          First recovery steps
        </h2>
        {ACTIONS.map(({ icon: Icon, title, body }) => (
          <article key={title} className="glass-panel rounded-card p-6">
            <Icon className="h-5 w-5 text-brand" />
            <h3 className="mt-4 font-display text-xl text-ink-1">{title}</h3>
            <p className="mt-2 leading-relaxed text-ink-2">{body}</p>
          </article>
        ))}
      </section>

      <section className="mt-20" aria-labelledby="faq-title">
        <div className="flex items-center gap-3">
          <LifeBuoy className="h-6 w-6 text-brand" />
          <h2 id="faq-title" className="display-m font-display">
            Frequently asked questions
          </h2>
        </div>
        <div className="mt-8 divide-y divide-line rounded-card border border-line bg-[var(--surface-glass)]">
          {FAQ.map((item) => (
            <details key={item.question} className="group p-5">
              <summary className="cursor-pointer list-none pr-8 font-semibold text-ink-1">
                {item.question}
              </summary>
              <p className="mt-3 max-w-[860px] leading-relaxed text-ink-2">{item.answer}</p>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
