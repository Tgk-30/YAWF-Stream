/** Shared site constants for GitHub URLs and published platform release channels. */
export const GITHUB_REPO = 'https://github.com/Tgk-30/YAWF-Stream';
export const GITHUB_RELEASES = `${GITHUB_REPO}/releases`;
export const GITHUB_ISSUES = `${GITHUB_REPO}/issues`;
export const GITHUB_BUG_REPORT = `${GITHUB_ISSUES}/new?template=bug_report.yml`;

type PublishedRelease = Readonly<{
  version: string;
  tag: string;
}>;

export const DESKTOP_RELEASE: PublishedRelease = { version: '2.3.38', tag: 'v2.3.38-web' };
export const ANDROID_TV_RELEASE: PublishedRelease = { version: '2.3.38', tag: 'v2.3.38-web' };
export const ANDROID_PHONE_RELEASE: PublishedRelease = { version: '2.3.42', tag: 'android-v2.3.42' };
export const SERVER_RELEASE: PublishedRelease = { version: '2.3.57', tag: 'v2.3.57' };

function releaseAsset(release: PublishedRelease, filename: string) {
  return `${GITHUB_RELEASES}/download/${release.tag}/${filename}`;
}

export const GITHUB_DESKTOP_RELEASE = `${GITHUB_RELEASES}/tag/${DESKTOP_RELEASE.tag}`;
export const GITHUB_ANDROID_PHONE_RELEASE = `${GITHUB_RELEASES}/tag/${ANDROID_PHONE_RELEASE.tag}`;
export const GITHUB_SERVER_RELEASE = `${GITHUB_RELEASES}/tag/${SERVER_RELEASE.tag}`;
export const GITHUB_DOCKER = `${GITHUB_REPO}/tree/${SERVER_RELEASE.tag}/deploy/compose`;
export const GITHUB_UBUNTU_GUIDE = `${GITHUB_REPO}/blob/${SERVER_RELEASE.tag}/deploy/ubuntu/README.md`;

export const SERVER_SOURCE_FILES = {
  dockerCompose: `https://raw.githubusercontent.com/Tgk-30/YAWF-Stream/${SERVER_RELEASE.tag}/deploy/compose/docker-compose.ghcr.yml`,
  envExample: `https://raw.githubusercontent.com/Tgk-30/YAWF-Stream/${SERVER_RELEASE.tag}/deploy/compose/.env.example`,
} as const;

export const RELEASE_LINKS = {
  desktopChecksums: releaseAsset(DESKTOP_RELEASE, 'SHA256SUMS'),
  androidTvChecksums: releaseAsset(ANDROID_TV_RELEASE, 'SHA256SUMS'),
  androidPhoneChecksums: releaseAsset(ANDROID_PHONE_RELEASE, 'SHA256SUMS'),
  serverChecksums: releaseAsset(SERVER_RELEASE, 'SHA256SUMS'),
  serverUpdateManifest: releaseAsset(SERVER_RELEASE, 'server-update.json'),
  serverVerification: releaseAsset(SERVER_RELEASE, `Server_${SERVER_RELEASE.version}_verification.json`),
  serverUpdaterBundle: releaseAsset(SERVER_RELEASE, `yawf-server-updater_${SERVER_RELEASE.version}.tar.gz`),
} as const;

/** Desktop release tag retained for existing desktop-only presentation labels. */
export const VERSION = DESKTOP_RELEASE.tag;
export const WINDOWS_RELEASE_AVAILABLE = false;

export const DOWNLOAD_LINKS = {
  macosArm: releaseAsset(DESKTOP_RELEASE, `YAWF.Stream_${DESKTOP_RELEASE.version}_aarch64.dmg`),
  macosIntel: releaseAsset(DESKTOP_RELEASE, `YAWF.Stream_${DESKTOP_RELEASE.version}_x64.dmg`),
  linuxAppImage: releaseAsset(DESKTOP_RELEASE, `YAWF.Stream_${DESKTOP_RELEASE.version}_amd64.AppImage`),
  androidTV: releaseAsset(ANDROID_TV_RELEASE, `YAWF.Stream_Android.TV_${ANDROID_TV_RELEASE.version}.apk`),
  androidPhone: releaseAsset(ANDROID_PHONE_RELEASE, `YAWF.Stream_Android_${ANDROID_PHONE_RELEASE.version}.apk`),
  serverDeb: releaseAsset(SERVER_RELEASE, `debridstreamer-server_${SERVER_RELEASE.version}_all.deb`),
  macos: releaseAsset(DESKTOP_RELEASE, `YAWF.Stream_${DESKTOP_RELEASE.version}_aarch64.dmg`),
  linux: releaseAsset(DESKTOP_RELEASE, `YAWF.Stream_${DESKTOP_RELEASE.version}_amd64.AppImage`),
} as const;
