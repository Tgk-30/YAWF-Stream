/** Shared site constants - GitHub URLs, version, platform downloads. */
export const GITHUB_REPO = 'https://github.com/Tgk-30/YAWF-Stream';
export const GITHUB_RELEASES = `${GITHUB_REPO}/releases`;
export const GITHUB_RELEASES_LATEST = `${GITHUB_RELEASES}/latest`;
export const GITHUB_ISSUES = `${GITHUB_REPO}/issues`;
export const GITHUB_BUG_REPORT = `${GITHUB_ISSUES}/new?template=bug_report.yml`;
export const GITHUB_DOCKER = `${GITHUB_REPO}/tree/main/deploy/compose`;

export const APP_VERSION = '2.0.0';
export const VERSION = `v${APP_VERSION}-web`;
export const RELEASE_ASSET_BASE = `${GITHUB_RELEASES}/download/${VERSION}`;
export const RELEASE_CHECKSUMS = `${RELEASE_ASSET_BASE}/SHA256SUMS`;
export const WINDOWS_RELEASE_AVAILABLE = false;

export const DOWNLOAD_LINKS = {
  macosArm: `${RELEASE_ASSET_BASE}/YAWF.Stream_${APP_VERSION}_aarch64.dmg`,
  macosIntel: `${RELEASE_ASSET_BASE}/YAWF.Stream_${APP_VERSION}_x64.dmg`,
  linuxAppImage: `${RELEASE_ASSET_BASE}/YAWF.Stream_${APP_VERSION}_amd64.AppImage`,
  androidTV: `${RELEASE_ASSET_BASE}/YAWF.Stream_Android.TV_${APP_VERSION}.apk`,
  serverDeb: `${RELEASE_ASSET_BASE}/debridstreamer-server_${APP_VERSION}_all.deb`,
  macos: `${RELEASE_ASSET_BASE}/YAWF.Stream_${APP_VERSION}_aarch64.dmg`,
  linux: `${RELEASE_ASSET_BASE}/YAWF.Stream_${APP_VERSION}_amd64.AppImage`,
} as const;
