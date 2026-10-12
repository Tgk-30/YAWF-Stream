#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateWebsiteReleaseCatalog } from "./check_website_release_catalog.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, "website-app");
const dist = join(source, "dist");
const failures = [];

function read(path) {
  return readFileSync(join(source, path), "utf8");
}

function check(condition, message) {
  if (!condition) failures.push(message);
}

const app = read("src/App.tsx");
const hero = read("src/pages/home/Hero.tsx");
const features = read("src/pages/features/shared.tsx");
const footer = read("src/components/Footer.tsx");
const themeConfig = read("src/theme.config.ts");
const styles = read("src/index.css");
const site = read("src/lib/site.ts");
const streamPicker = read("src/pages/download/StreamPicker.tsx");
const deployTabs = read("src/pages/self-host/DeployTabs.tsx");
const pwaSteps = read("src/pages/download/PwaSteps.tsx");
const androidTVInstall = read("src/pages/download/AndroidTVInstall.tsx");
const deviceInstallFlows = read("src/pages/devices/InstallFlows.tsx");
const deviceHero = read("src/pages/devices/Hero.tsx");
const deviceConstellation = read("src/pages/devices/Constellation.tsx");
const selfHostTeaser = read("src/pages/home/SelfHostTeaser.tsx");
const selfHostHub = read("src/pages/self-host/HubSection.tsx");
const help = read("src/pages/Help.tsx");
const verify = read("src/pages/download/Verify.tsx");
const trust = read("src/pages/download/TrustPanel.tsx");
const packageJson = JSON.parse(read("package.json"));
const tauri = JSON.parse(readFileSync(join(root, "web/src-tauri/tauri.conf.json"), "utf8"));
const pwaManifest = JSON.parse(
  readFileSync(join(root, "web/public/manifest.webmanifest"), "utf8"),
);

check(
  app.includes("basename={import.meta.env.BASE_URL"),
  "BrowserRouter must derive its basename from the build base so every mount routes correctly",
);
check(app.includes('path="help"'), "website must publish the Help and FAQ route");
check(
  help.includes("Report a bug") &&
    help.includes("Frequently asked questions") &&
    help.includes("server operator"),
  "Help route must include bug reporting, FAQ, and operator-visibility guidance",
);
check(hero.includes("Your Accounts. Watch Freely."), "home hero must use the YAWF Stream headline");
check(hero.includes("A private streaming hub for the services you already use."), "home hero must use the private-hub positioning");
check(!features.includes("id: 'assistant'"), "features must not expose the Assistant chapter by default");
check(footer.includes("YAWF Group. All rights reserved."), "footer must include the YAWF Group copyright");
check(footer.includes("theme.brandMeaning"), "footer must include the YAWF Group brand meaning");
check(
  footer.includes("This product uses the TMDB API but is not endorsed or certified by TMDB.") &&
    footer.includes("asset('tmdb.svg')"),
  "website footer must include the required TMDB notice and approved logo",
);
check(
  themeConfig.includes("brandMeaning: 'Yours. Always. Wherever. Forever.'"),
  "theme config must define the YAWF Group brand meaning",
);
check(styles.includes(".char-space") && styles.includes("white-space: pre"), "animated headlines must preserve word spacing");
check(packageJson.version === tauri.version, "website package version must match the Tauri release version");
for (const failure of validateWebsiteReleaseCatalog(site)) {
  check(false, `website release catalog: ${failure}`);
}

check(site.includes("WINDOWS_RELEASE_AVAILABLE = false"), "website must record that the Windows channel is held");
check(!site.includes("_x64_en-US.msi"), "website must not publish a broken Windows installer link");
check(!hero.includes("DOWNLOAD_LINKS.windows"), "home hero must not link to an unavailable Windows asset");
check(streamPicker.includes("Windows release is held"), "download picker must explain the held Windows channel");
check(
  streamPicker.includes("Android TV & Google TV") &&
    streamPicker.includes("DOWNLOAD_LINKS.androidTV") &&
    androidTVInstall.includes("native Media3 player"),
  "download page must expose the signed Android TV package and native-player install guidance",
);
check(
  streamPicker.includes("Server - Debian or Ubuntu") &&
    streamPicker.includes("The Debian server package has no"),
  "download picker must expose the Debian server package and explain manual updates",
);
check(
  streamPicker.includes("getHighEntropyValues") &&
    streamPicker.includes("architecture"),
  "download picker must detect the platform and architecture when the browser exposes them",
);
check(
  site.includes("SHA256SUMS") &&
    verify.includes("VERIFY BEFORE INSTALLING") &&
    verify.includes("sha256sum"),
  "download page must publish user-facing checksum verification",
);
check(
  trust.includes("checksums and provenance") &&
    trust.includes("GitHub attestations"),
  "download trust panel must disclose checksums and build provenance",
);
check(
  !deviceHero.includes("Desktop apps for macOS, Windows, and Linux"),
  "devices page must not claim that a Windows desktop release is available",
);
check(
  deviceHero.includes("Windows is held until its signing gate passes"),
  "devices page must explain the held Windows channel",
);
check(
  deviceHero.includes("Android TV") &&
    deviceHero.includes("Google TV") &&
    deviceHero.includes("phone remote") &&
    deviceConstellation.includes("remote for the TV"),
  "devices page must explain Android TV, Google TV, and the phone remote",
);
check(
  pwaSteps.includes("http://your-server:43110") && !pwaSteps.includes(":9696"),
  "PWA instructions must use the server port 43110",
);
check(
  pwaSteps.includes("running YAWF Stream server is required") &&
    deviceInstallFlows.includes("no standalone iOS package is published") &&
    help.includes("No standalone iOS package is published"),
  "iOS and iPad PWA copy must require a running server and avoid a standalone package claim",
);
check(
  deviceInstallFlows.includes("192.168.1.20:43110") &&
    !deviceInstallFlows.includes(":9696"),
  "device install example must use the server port 43110",
);
check(
  pwaManifest.name === "YAWF Stream" && pwaManifest.short_name === "YAWF Stream",
  "PWA manifest must install as YAWF Stream",
);
check(
  !selfHostTeaser.includes("never leave your network") &&
    !selfHostHub.includes("never leave your network"),
  "website must not claim that provider credentials never leave the network",
);
check(
  !features.includes("positioning") && !features.includes("position, and background"),
  "website must not advertise subtitle positioning until the player implements it",
);

check(!/checking caches|sources found|sort: instant/i.test(streamPicker), "download picker must not simulate cache or source status");
check(streamPicker.includes("Choose your platform"), "download picker must explain the platform choice directly");
const freshDockerSources = [deployTabs, selfHostTeaser];
const usesSafeFreshDockerInstall = freshDockerSources.every(
  (copy) =>
    copy.includes('tmp="$(mktemp -d)"') &&
    copy.includes(`trap 'rm -rf "$tmp"' 0`) &&
    copy.includes('curl -fsSL ${SERVER_SOURCE_FILES.dockerCompose} -o "$tmp/docker-compose.ghcr.yml"') &&
    copy.includes('curl -fsSL ${SERVER_SOURCE_FILES.envExample} -o "$tmp/.env"') &&
    copy.includes("sudo mkdir -m 0755 /srv/yawf") &&
    !copy.includes("sudo mkdir -p") &&
    copy.includes('sudo install -o root -g root -m 0644 "$tmp/docker-compose.ghcr.yml" /srv/yawf/docker-compose.ghcr.yml') &&
    copy.includes('sudo install -o root -g root -m 0600 "$tmp/.env" /srv/yawf/.env') &&
    !copy.includes("sudo curl -fsSL") &&
    !copy.includes("sudo install -d") &&
    !copy.includes("sudo sh -c"),
);
check(
  deployTabs.includes("debridstreamer-server_${SERVER_RELEASE.version}_all.deb") &&
    deployTabs.includes("RELEASE_LINKS.serverUpdaterBundle") &&
    deployTabs.includes("protected absolute Compose path") &&
    deployTabs.includes("Docker Compose, flock, and Node.js 24") &&
    deployTabs.includes("never invokes a release check or update transaction") &&
    usesSafeFreshDockerInstall &&
    deployTabs.includes("sudo bash deploy/ubuntu/install.sh") &&
    deployTabs.includes("listening on :43110") &&
    !deployTabs.includes(":7878") &&
    !deployTabs.includes("3.8 MB") &&
    !selfHostTeaser.includes(":7878"),
  "self-host page must preserve existing deployments, use port 43110, and distinguish native, Debian, and optional Docker updater paths",
);

for (const asset of [
  "hero-streams-loop.mp4",
  "hero-streams-poster.jpg",
  "discover-desktop.png",
  "discover-tablet.png",
  "settings-mobile.png",
  "brand/logo-mark.svg",
  "tmdb.svg",
]) {
  const file = join(source, "public", asset);
  check(existsSync(file), `website asset missing: ${asset}`);
  if (existsSync(file)) check(statSync(file).size > 0, `website asset is empty: ${asset}`);
}

const ambientVideos = [
  "hero-streams-loop.mp4",
  "cinema-grain-loop.mp4",
  "nebula-drift-loop.mp4",
  "streamrings-loop.mp4",
];
let ambientVideoBytes = 0;
for (const asset of ambientVideos) {
  const file = join(source, "public", asset);
  check(existsSync(file), `ambient website video missing: ${asset}`);
  if (!existsSync(file)) continue;
  const size = statSync(file).size;
  ambientVideoBytes += size;
  check(size <= 1_600_000, `ambient website video exceeds 1.6 MB: ${asset}`);
}
check(
  ambientVideoBytes <= 3_000_000,
  `ambient website videos exceed the 3 MB transfer budget (${ambientVideoBytes} bytes)`,
);

check(
  existsSync(join(root, "docs", "recovery.md")),
  "public recovery runbook must exist",
);

const sourceFiles = [];
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (/\.(?:ts|tsx|css|html|md|js|json)$/.test(entry.name) && entry.name !== "package-lock.json") sourceFiles.push(path);
  }
}
collect(join(source, "src"));
for (const name of ["index.html", "README.md", "info.md", "package.json", "vite.config.ts"]) {
  const path = join(source, name);
  if (existsSync(path)) sourceFiles.push(path);
}

for (const file of sourceFiles) {
  const text = readFileSync(file, "utf8");
  check(!text.includes("\u2014"), `${file.slice(source.length + 1)} contains an em dash`);
}

check(existsSync(join(dist, "index.html")), "website-app/dist is missing; run npm run build in website-app");
if (existsSync(join(dist, "index.html"))) {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const siteMount = `/${(process.env.SITE_BASE ?? "debridstreamer").replace(/^\/+|\/+$/g, "")}/`;
  check(html.includes(`${siteMount}assets/`), `built assets must stay under ${siteMount}`);
  check(html.includes("YAWF Stream"), "built metadata must use YAWF Stream");

  const distFiles = [];
  collect(dist);
  for (const file of sourceFiles.filter((path) => path.startsWith(dist))) distFiles.push(file);
  check(
    distFiles.every((file) => !readFileSync(file, "utf8").includes("code-path")),
    "production website must not expose source inspection attributes",
  );
}

if (failures.length > 0) {
  console.error("YAWF Stream website check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("YAWF Stream website check passed.");
