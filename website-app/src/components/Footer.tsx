import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import theme, { applyPreset, THEME_PRESETS, THEME_PRESET_NAMES, useThemePreset } from '@/theme.config';
import { GITHUB_DOCKER, GITHUB_ISSUES, GITHUB_RELEASES, GITHUB_RELEASES_LATEST, GITHUB_REPO, VERSION } from '@/lib/site';
import RingMark from '@/components/RingMark';
import Chip from '@/components/Chip';
import BackgroundVideo from '@/components/BackgroundVideo';
import { asset } from '@/lib/asset';

const COLUMNS: { heading: string; links: { label: string; to: string; external?: boolean }[] }[] = [
  {
    heading: 'Product',
    links: [
      { label: 'Features', to: '/features' },
      { label: 'Download', to: '/download' },
      { label: 'Devices', to: '/devices' },
      { label: 'Household', to: '/household' },
      { label: 'Help & FAQ', to: '/help' },
    ],
  },
  {
    heading: 'Self-host',
    links: [
      { label: 'Guide', to: '/self-host' },
      { label: 'Docker', to: GITHUB_DOCKER, external: true },
      { label: 'Releases', to: GITHUB_RELEASES, external: true },
    ],
  },
  {
    heading: 'Project',
    links: [
      { label: 'Source', to: GITHUB_REPO, external: true },
      { label: 'Issues', to: GITHUB_ISSUES, external: true },
      { label: 'Latest release', to: GITHUB_RELEASES_LATEST, external: true },
    ],
  },
];

function FooterLink({ label, to, external }: { label: string; to: string; external?: boolean }) {
  const classes = 'font-body text-[0.9rem] text-ink-2 transition-colors duration-150 hover:text-brand';
  if (external) {
    return (
      <a href={to} target="_blank" rel="noreferrer" className={classes}>
        {label}
      </a>
    );
  }
  return (
    <Link to={to} className={classes}>
      {label}
    </Link>
  );
}

/** Global footer - signal divider, watermark wordmark, link grid, preset dots, nebula backdrop. */
export default function Footer() {
  const preset = useThemePreset();

  return (
    <footer className="relative mt-auto overflow-hidden bg-bg-1">
      <BackgroundVideo src={asset('nebula-drift-loop.mp4')} poster={asset('nebula-drift-poster.jpg')} opacity={0.2} />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ background: 'linear-gradient(180deg, var(--bg-1) 0%, transparent 45%, var(--bg-1) 92%)' }}
      />

      <div className="signal-divider relative z-10" />

      <div className="relative z-10 mx-auto max-w-content px-6 pb-10 pt-16 md:px-10">
        <div className="grid gap-12 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Link to="/" className="group inline-flex items-center gap-2.5" aria-label="YAWF Stream - home">
              <RingMark size={34} />
              <span className="font-display text-lg font-semibold tracking-[-0.02em] text-ink-1">
                YAWF <span className="text-brand">Stream</span>
              </span>
            </Link>
            <p className="mt-4 max-w-[260px] font-body text-[0.9rem] text-ink-2">
              MIT licensed open-source project. {theme.tagline}
            </p>
            <Chip className="mt-5" variant="outline">
              {VERSION}
            </Chip>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <p className="font-mono text-[0.75rem] uppercase tracking-[0.22em] text-ink-3">{col.heading}</p>
              <ul className="mt-4 flex flex-col gap-2.5">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <FooterLink {...link} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-start justify-between gap-5 border-t border-line pt-6 sm:flex-row sm:items-center">
          <p className="font-mono text-[0.8125rem] tracking-[0.04em] text-ink-3">
            © {new Date().getFullYear()} YAWF Group. All rights reserved.
          </p>
          <p className="font-mono text-[0.8125rem] tracking-[0.04em] text-ink-3">{theme.brandMeaning}</p>
          <div className="flex items-center gap-2.5" role="group" aria-label="Theme presets">
            {THEME_PRESET_NAMES.map((name) => (
              <button
                key={name}
                type="button"
                title={THEME_PRESETS[name].label}
                aria-label={`Theme: ${THEME_PRESETS[name].label}`}
                onClick={() => applyPreset(name)}
                className={cn(
                  'h-3.5 w-3.5 rounded-full border border-white/15 transition-transform duration-150 hover:scale-125',
                  preset === name && 'ring-2 ring-brand ring-offset-2 ring-offset-bg-1',
                )}
                style={{ background: THEME_PRESETS[name].brand }}
              />
            ))}
          </div>
        </div>
        <div className="mt-6 flex max-w-[720px] items-center gap-4 text-ink-3">
          <a href="https://www.themoviedb.org/" target="_blank" rel="noreferrer">
            <img src={asset('tmdb.svg')} alt="The Movie Database (TMDB)" className="h-10 w-auto" />
          </a>
          <p className="font-body text-xs leading-relaxed">
            This product uses the TMDB API but is not endorsed or certified by TMDB.
          </p>
        </div>
      </div>

      {/* giant watermark wordmark */}
      <div
        aria-hidden="true"
        className="pointer-events-none relative z-0 -mt-2 select-none overflow-hidden text-center font-display font-bold leading-[0.8] text-[rgba(var(--ink-1-rgb),0.04)]"
        style={{
          fontSize: 'clamp(4rem, 14vw, 11rem)',
          WebkitMaskImage: 'linear-gradient(180deg, transparent 0%, #000 60%)',
          maskImage: 'linear-gradient(180deg, transparent 0%, #000 60%)',
        }}
      >
        {theme.name}
      </div>
    </footer>
  );
}
