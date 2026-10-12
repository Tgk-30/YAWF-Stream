import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowUpRight, Package, Power } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  DOWNLOAD_LINKS,
  GITHUB_UBUNTU_GUIDE,
  RELEASE_LINKS,
  SERVER_RELEASE,
  SERVER_SOURCE_FILES,
} from '@/lib/site';
import SectionHeading from '@/components/SectionHeading';
import TerminalBlock from '@/components/TerminalBlock';
import StreamRow from '@/components/StreamRow';
import DeviceFrame from '@/components/DeviceFrame';
import Chip from '@/components/Chip';
import { asset } from '@/lib/asset';

const EASE_EXPO = [0.16, 1, 0.3, 1] as [number, number, number, number];
const DOCKER_LINES = [
  {
    text: `( set -eu; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' 0; curl -fsSL ${SERVER_SOURCE_FILES.dockerCompose} -o "$tmp/docker-compose.ghcr.yml"; curl -fsSL ${SERVER_SOURCE_FILES.envExample} -o "$tmp/.env"; sudo mkdir -m 0755 /srv/yawf; sudo install -o root -g root -m 0644 "$tmp/docker-compose.ghcr.yml" /srv/yawf/docker-compose.ghcr.yml; sudo install -o root -g root -m 0600 "$tmp/.env" /srv/yawf/.env )`,
  },
  { text: 'sudo chmod 600 /srv/yawf/.env && sudoedit /srv/yawf/.env' },
  { text: 'cd /srv/yawf && sudo docker compose -f docker-compose.ghcr.yml up -d --no-deps debridstreamer' },
  { text: '[+] Running 1/1  ✓ Container debridstreamer  Started', output: true },
  { text: '→ serving on http://localhost:43110', output: true },
];

const NATIVE_LINES = [
  { text: 'curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -' },
  { text: 'sudo apt-get install -y nodejs git' },
  { text: `git clone --branch ${SERVER_RELEASE.tag} --depth 1 https://github.com/Tgk-30/YAWF-Stream.git && cd YAWF-Stream` },
  { text: 'sudo bash deploy/ubuntu/install.sh' },
  { text: '● debridstreamer.service - YAWF Stream server', output: true },
  { text: '  Active: active (running) · listening on :43110', output: true },
];

const TABS = [
  { id: 'docker', label: 'Docker (Ubuntu)', recommended: true },
  { id: 'native', label: 'Native Node + systemd', recommended: false },
  { id: 'deb', label: '.deb package', recommended: false },
  { id: 'desktop', label: 'Desktop app', recommended: false },
] as const;

type DeployId = (typeof TABS)[number]['id'];

function isDeployId(v: string | null): v is DeployId {
  return TABS.some((t) => t.id === v);
}

function GuideLink() {
  return (
    <a
      href={GITHUB_UBUNTU_GUIDE}
      target="_blank"
      rel="noreferrer"
      className="group mt-5 inline-flex items-center gap-2 font-mono text-[0.8125rem] tracking-[0.04em] text-brand transition-colors hover:text-accent2"
    >
      Full Ubuntu guide
      <ArrowUpRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
    </a>
  );
}

/** Tab 4 - interactive Settings toggle mock: Server off → on. */
function ServerToggleMock() {
  const [on, setOn] = useState(true);
  return (
    <div className="glass-panel rounded-row p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-bg-2 transition-colors duration-300',
              on ? 'text-brand' : 'text-ink-3',
            )}
          >
            <Power className="h-4 w-4" />
          </span>
          <div>
            <p className="font-body text-[0.9rem] font-semibold leading-[1.4] text-ink-1">Server</p>
            <p className="font-mono text-[0.75rem] tracking-[0.04em] text-ink-3">Settings → Control Center</p>
          </div>
        </div>
        <Switch
          checked={on}
          onCheckedChange={setOn}
          aria-label="Toggle server"
          className="data-[state=checked]:bg-brand data-[state=unchecked]:bg-bg-2 data-[state=unchecked]:border-line-strong"
        />
      </div>
      <div className="mt-3 border-t border-line pt-3">
        <p className={cn('font-mono text-[0.75rem] tracking-[0.04em] transition-colors duration-300', on ? 'text-accent2' : 'text-ink-3')}>
          {on ? (
            'on - handing phones a hosted PWA · setup URL + QR ready'
          ) : (
            'off - flip to start serving the house'
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * Section 3 - Deploy paths. Glass pill tab group (layoutId indicator),
 * cross-fading panels, deep-linkable via ?deploy=docker|native|deb|desktop.
 */
export default function DeployTabs() {
  const reduced = useReducedMotion();
  const [params, setParams] = useSearchParams();
  const tab: DeployId = isDeployId(params.get('deploy')) ? (params.get('deploy') as DeployId) : 'docker';

  const onTabChange = (v: string) => {
    setParams({ deploy: v }, { replace: true });
  };

  return (
    <section id="deploy" className="scroll-mt-24 py-[clamp(88px,12vw,152px)]">
      <div className="mx-auto max-w-[980px] px-6 md:px-10">
        <SectionHeading eyebrow="// DEPLOY" title="Four ways in. Pick yours." align="center" />

        <Tabs value={tab} onValueChange={onTabChange} className="mt-12">
          <div className="flex justify-center overflow-x-auto pb-1">
            <TabsList className="h-auto rounded-chip border border-line bg-[var(--surface-glass)] p-1 backdrop-blur">
              {TABS.map((t) => (
                <TabsTrigger
                  key={t.id}
                  value={t.id}
                  className={cn(
                    'relative h-auto flex-none rounded-chip border-0 px-4 py-2.5 font-mono text-[0.8125rem] tracking-[0.04em]',
                    'text-ink-3 shadow-none transition-colors duration-200 hover:text-ink-2',
                    'data-[state=active]:bg-transparent data-[state=active]:text-brand data-[state=active]:shadow-none',
                  )}
                >
                  {tab === t.id && (
                    <motion.span
                      layoutId="deploy-tab-pill"
                      className="absolute inset-0 rounded-chip border border-line-strong bg-[var(--surface-glass-2)]"
                      transition={reduced ? { duration: 0.15 } : { type: 'spring', stiffness: 300, damping: 30 }}
                    />
                  )}
                  <span className="relative z-10 flex items-center gap-2 whitespace-nowrap">
                    {t.label}
                    {t.recommended && (
                      <span className="inline-flex items-center gap-1 rounded-chip border border-[rgba(var(--brand-rgb),0.4)] px-2 py-0.5 text-[0.625rem] text-brand">
                        <span className="h-1 w-1 rounded-full bg-brand shadow-glow-brand" />
                        recommended
                      </span>
                    )}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <div className="mt-8 min-h-[380px]">
            {TABS.map((t) => (
              <TabsContent key={t.id} value={t.id} className="mt-0">
                <motion.div
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: reduced ? 0.15 : 0.3, ease: EASE_EXPO }}
                >
                  {t.id === 'docker' && (
                    <div>
                      <p className="mb-5 max-w-[640px] font-body text-[1rem] leading-[1.7] text-ink-2">
                        One command stack on any Ubuntu server. Prebuilt multi-arch image -{' '}
                        <span className="font-mono text-[0.9rem] text-ink-1">amd64</span> +{' '}
                        <span className="font-mono text-[0.9rem] text-ink-1">arm64</span>.
                      </p>
                      <TerminalBlock title="docker - quickstart" lines={DOCKER_LINES} />
                      <p className="mt-4 max-w-[720px] font-body text-[0.95rem] leading-[1.7] text-ink-2">
                        Fresh install only. The first command refuses any existing <span className="font-mono text-[0.85em] text-ink-1">/srv/yawf</span>{' '}
                        entry before it writes configuration. For an existing deployment, keep its project and volume identity, then use its own
                        <span className="font-mono text-[0.85em] text-ink-1"> docker compose pull</span> and{' '}
                        <span className="font-mono text-[0.85em] text-ink-1">up -d</span> update path instead of
                        downloading replacement files.
                      </p>
                      <div className="mt-5 max-w-[720px] rounded-row border border-line bg-[var(--surface-glass)] p-5">
                        <p className="font-body text-[0.95rem] leading-[1.7] text-ink-2">
                          Optional automatic updates use the matching {SERVER_RELEASE.tag} host helper for this protected
                          Docker deployment only. In a fresh terminal, verify and extract its bundle, then run{' '}
                          <span className="font-mono text-[0.85em] text-ink-1">sudo ./install.sh</span>. Choose Yes,
                          enter the protected absolute Compose path, then choose Yes again. Enter, No, EOF, and
                          non-interactive or unattended installation without explicit enable leave updates off. It requires
                          Docker Compose, flock, and Node.js 24 or newer at <span className="font-mono text-[0.85em] text-ink-1">/usr/bin/node</span>.
                          The installer itself never invokes a release check or update transaction; enabling opts into
                          scheduled updates.
                        </p>
                        <div className="mt-4 flex flex-wrap gap-3 font-mono text-[0.75rem] tracking-[0.04em]">
                          <a href={RELEASE_LINKS.serverUpdaterBundle} className="text-brand hover:text-accent2">
                            updater bundle
                          </a>
                          <a href={RELEASE_LINKS.serverChecksums} className="text-brand hover:text-accent2">
                            SHA256SUMS
                          </a>
                          <a href={RELEASE_LINKS.serverVerification} className="text-brand hover:text-accent2">
                            verification record
                          </a>
                          <a href={RELEASE_LINKS.serverUpdateManifest} className="text-brand hover:text-accent2">
                            update manifest
                          </a>
                        </div>
                      </div>
                      <GuideLink />
                    </div>
                  )}

                  {t.id === 'native' && (
                    <div>
                      <p className="mb-5 max-w-[640px] font-body text-[1rem] leading-[1.7] text-ink-2">
                        Prefer bare metal? Node.js 24 or newer at <span className="font-mono text-[0.85em] text-ink-1">/usr/bin/node</span>{' '}
                        is required. The versioned source checkout uses its supported Ubuntu installer to build and
                        register systemd.
                      </p>
                      <TerminalBlock title="native - node + systemd" lines={NATIVE_LINES} />
                      <GuideLink />
                    </div>
                  )}

                  {t.id === 'deb' && (
                    <div>
                      <p className="mb-5 max-w-[640px] font-body text-[1rem] leading-[1.7] text-ink-2">
                        Install the self-hosted server directly on Debian or Ubuntu without Docker.
                      </p>
                      <StreamRow
                        icon={<Package className="h-5 w-5" strokeWidth={1.75} />}
                        title={`debridstreamer-server_${SERVER_RELEASE.version}_all.deb`}
                        meta={[
                          { label: 'manual .deb update', variant: 'instant' },
                          { label: SERVER_RELEASE.tag, variant: 'dim' },
                        ]}
                        size=".deb"
                        href={DOWNLOAD_LINKS.serverDeb}
                      />
                      <div className="mt-4 flex flex-wrap gap-2.5">
                        <Chip variant="outline">{`apt install ./debridstreamer-server_${SERVER_RELEASE.version}_all.deb`}</Chip>
                        <Chip variant="outline">systemd service ready</Chip>
                      </div>
                    </div>
                  )}

                  {t.id === 'desktop' && (
                    <div className="grid items-center gap-8 md:grid-cols-[1fr_auto]">
                      <div>
                        <p className="mb-5 max-w-[520px] font-body text-[1rem] leading-[1.7] text-ink-2">
                          No separate machine? The desktop app can start the server from Settings - and hands phones
                          and tablets a hosted PWA with a setup URL + QR.
                        </p>
                        <ServerToggleMock />
                      </div>
                      <DeviceFrame
                        variant="phone"
                        src={asset('settings-mobile.png')}
                        alt="YAWF Stream mobile Settings - Control Center"
                        className="mx-auto w-[180px] md:w-[210px]"
                        reflect={false}
                      />
                    </div>
                  )}
                </motion.div>
              </TabsContent>
            ))}
          </div>
        </Tabs>
      </div>
    </section>
  );
}
