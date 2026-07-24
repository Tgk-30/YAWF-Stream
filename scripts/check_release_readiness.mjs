#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function check(name, pass, detail) {
  checks.push({ name, pass, detail });
}

function workflowHasFullHistoryCheckout(workflow) {
  return /uses:\s*actions\/checkout@v4[\s\S]{0,240}fetch-depth:\s*0/.test(workflow);
}

const tauri = JSON.parse(read("web/src-tauri/tauri.conf.json"));
const updater = tauri.plugins?.updater;
check(
  "Tauri updater artifacts enabled",
  tauri.bundle?.createUpdaterArtifacts === true,
  "web/src-tauri/tauri.conf.json must set bundle.createUpdaterArtifacts to true",
);
check(
  "Tauri updater endpoint",
  Array.isArray(updater?.endpoints) &&
    updater.endpoints.some((url) => /releases\/latest\/download\/latest\.json$/.test(url)),
  "web/src-tauri/tauri.conf.json must point at latest.json",
);
check(
  "Tauri updater public key",
  typeof updater?.pubkey === "string" && updater.pubkey.trim().length > 40,
  "web/src-tauri/tauri.conf.json must include the updater public key",
);
check(
  "Tauri bundles recursive server resources",
  Array.isArray(tauri.bundle?.resources) &&
    tauri.bundle.resources.includes("resources/server/**/*"),
  "web/src-tauri/tauri.conf.json must recursively include resources/server so web-dist and Node runtime are bundled",
);

const releaseWorkflow = read(".github/workflows/web-release.yml");
const cleanInstallWorkflow = read(".github/workflows/clean-install.yml");
const dockerWorkflow = read(".github/workflows/docker-image.yml");
const ciWorkflow = read(".github/workflows/ci.yml");
const cloudflareSiteWorkflow = read(".github/workflows/cloudflare-site.yml");
const desktopBuildWorkflow = read(".github/workflows/desktop-build.yml");
const dockerIgnore = read(".dockerignore");
const dockerfile = read("Dockerfile");
const publicRepoPreflight = read("scripts/public_repo_preflight.mjs");
const cloudflareDeployHelper = read("scripts/deploy_website_cloudflare.mjs");
const swiftTestVerifier = read("scripts/check_swift_tests.mjs");
const nodeRuntimeDownloader = read("scripts/download_tauri_node_runtime.mjs");
const serverResourcePrep = read("scripts/prepare_tauri_server_resources.mjs");
const desktopServerSmoke = read("scripts/smoke_tauri_server_bundle.mjs");
const localPackage = read("scripts/package_tauri_local.mjs");
const localArtifactVerifier = read("scripts/check_local_package_artifact.mjs");
const securityDecisionCheck = read("scripts/check_security_decisions.mjs");
const windowsSigningConfig = read("scripts/generate_windows_signing_config.mjs");
const linuxGtkMigration = read("docs/TAURI_LINUX_GTK_MIGRATION.md");
const bundleBudgetCheck = read("scripts/check_bundle_budgets.mjs");
const webPackage = JSON.parse(read("web/package.json"));
const webPackageLock = JSON.parse(read("web/package-lock.json"));
const serverPackage = JSON.parse(read("server/package.json"));
const serverPackageLock = JSON.parse(read("server/package-lock.json"));
const websitePackage = JSON.parse(read("website-app/package.json"));
const websitePackageLock = JSON.parse(read("website-app/package-lock.json"));
const serverVersion = read("server/src/version.ts").match(
  /SERVER_VERSION\s*=\s*"([^"]+)"/,
)?.[1];
const cargoTomlVersion = read("web/src-tauri/Cargo.toml").match(
  /^version\s*=\s*"([^"]+)"/m,
)?.[1];
const cargoLockVersion = read("web/src-tauri/Cargo.lock").match(
  /\[\[package\]\]\s*\nname = "debridstreamer"\s*\nversion = "([^"]+)"/,
)?.[1];
const websiteVersion = read("website-app/src/lib/site.ts").match(
  /APP_VERSION\s*=\s*'([^']+)'/,
)?.[1];
const androidTVVersion = read("android-tv/app/build.gradle").match(
  /versionName\s+"([^"]+)"/,
)?.[1];
const releaseVersions = [
  tauri.version,
  webPackage.version,
  webPackageLock.version,
  serverPackage.version,
  serverPackageLock.version,
  serverVersion,
  websitePackage.version,
  websitePackageLock.version,
  websiteVersion,
  cargoTomlVersion,
  cargoLockVersion,
  androidTVVersion,
];
check(
  "Release version surfaces match",
  releaseVersions.every((version) => version === tauri.version),
  `web, server, website, Tauri, Cargo, and Android TV versions must all match ${tauri.version}`,
);
check(
  "Release workflow emits updater JSON",
  /includeUpdaterJson:\s*true/.test(releaseWorkflow),
  ".github/workflows/web-release.yml should publish latest.json",
);
check(
  "Release workflow signs updater artifacts",
  /TAURI_SIGNING_PRIVATE_KEY/.test(releaseWorkflow),
  "TAURI_SIGNING_PRIVATE_KEY must be wired into the release workflow",
);
check(
  "Release workflow publishes checksums and provenance",
  /finalize-release-assets:/.test(releaseWorkflow) &&
    /SHA256SUMS/.test(releaseWorkflow) &&
    /actions\/attest@v4/.test(releaseWorkflow) &&
    /attestations:\s*write/.test(releaseWorkflow) &&
    /id-token:\s*write/.test(releaseWorkflow),
  ".github/workflows/web-release.yml must checksum and attest the completed release asset set",
);
check(
  "Release workflow builds a signed Android TV package",
  /android-tv:/.test(releaseWorkflow) &&
    /Validate Android signing secrets/.test(releaseWorkflow) &&
    /:app:testDebugUnitTest :app:lintRelease :app:assembleRelease/.test(
      releaseWorkflow,
    ) &&
    /YAWF\.Stream_Android\.TV_\$\{version\}\.apk/.test(releaseWorkflow) &&
    /apksigner verify/.test(releaseWorkflow) &&
    /SIGNING_CERT_SHA256/.test(releaseWorkflow) &&
    /needs:\s*\[release, android-tv\]/.test(releaseWorkflow),
  ".github/workflows/web-release.yml must test, lint, sign, verify, and upload Android TV before checksums are finalized",
);
check(
  "Android TV signing certificate is publicly pinned",
  existsSync(join(root, "android-tv/SIGNING_CERT_SHA256")) &&
    /^[0-9a-f]{64}\n?$/.test(read("android-tv/SIGNING_CERT_SHA256")) &&
    /SIGNING_CERT_SHA256/.test(releaseWorkflow) &&
    /SIGNING_CERT_SHA256/.test(cleanInstallWorkflow) &&
    /apksigner verify --print-certs/.test(releaseWorkflow) &&
    /apksigner verify --print-certs/.test(cleanInstallWorkflow),
  "release and clean-install workflows must reject an Android APK signed by a different certificate",
);
check(
  "Release workflow builds macOS, Linux, and Windows",
  // A pinned stable macOS (macos-15/14/13) is REQUIRED - `macos-latest` moved to
  // the macOS 26 beta, whose SDK/codesign makes bundles "damaged" on older macOS.
  /platform:\s*macos-\d+/.test(releaseWorkflow) &&
    /platform:\s*ubuntu-\d+\.\d+/.test(releaseWorkflow) &&
    /platform:\s*windows-latest/.test(releaseWorkflow) &&
    /runs-on:\s*\$\{\{\s*matrix\.platform\s*\}\}/.test(releaseWorkflow),
  ".github/workflows/web-release.yml must run the desktop release job on macOS, Linux, and Windows",
);
check(
  "Pull requests build Windows and Linux desktop packages",
  /pull_request:/.test(desktopBuildWorkflow) &&
    /branches:\s*\n\s*- main/.test(desktopBuildWorkflow) &&
    /platform:\s*windows-latest/.test(desktopBuildWorkflow) &&
    /platform:\s*ubuntu-\d+\.\d+/.test(desktopBuildWorkflow) &&
    /bundles:\s*msi,nsis/.test(desktopBuildWorkflow) &&
    /Verify Windows bundles and clean-install MSI/.test(desktopBuildWorkflow) &&
    /Verify Linux packages on clean profiles/.test(desktopBuildWorkflow) &&
    /actions\/upload-artifact@v4/.test(desktopBuildWorkflow),
  ".github/workflows/desktop-build.yml must build, clean-launch, and retain unsigned Windows and Linux packages for relevant pull requests",
);
check(
  "Release workflow builds per-arch macOS targets",
  // macOS ships PER-ARCH now (native runners, each bundling its own libmpv) - 
  // no universal/lipo build. Verify both arch targets flow through matrix.args.
  /--target aarch64-apple-darwin/.test(releaseWorkflow) &&
    /--target x86_64-apple-darwin/.test(releaseWorkflow) &&
    /args:\s*\$\{\{\s*matrix\.args\s*\}\}/.test(releaseWorkflow),
  ".github/workflows/web-release.yml must build per-arch macOS (aarch64 + x86_64) targets via matrix.args",
);
check(
  "Release workflow packages desktop server",
  /prepare_tauri_server_resources\.mjs/.test(releaseWorkflow) &&
    /download_tauri_node_runtime\.mjs/.test(releaseWorkflow),
  ".github/workflows/web-release.yml should package the server bundle and Node runtime",
);
check(
  "Release workflow runs public preflight",
  /public_repo_preflight\.mjs/.test(releaseWorkflow),
  ".github/workflows/web-release.yml must run the public repo preflight before publishing assets",
);
check(
  "Release workflow public preflight uses full Git history",
  workflowHasFullHistoryCheckout(releaseWorkflow),
  ".github/workflows/web-release.yml must checkout with fetch-depth: 0 before running public repo preflight",
);
check(
  "Release workflow validates website",
  /check_website_download_logic\.mjs/.test(releaseWorkflow) &&
    /check_website_static\.mjs/.test(releaseWorkflow) &&
    /check_website_path_mount\.mjs/.test(releaseWorkflow),
  ".github/workflows/web-release.yml must validate website download logic, static page QA, and mounted-path QA before publishing assets",
);
check(
  "Release workflow runs app responsive contract",
  /check_app_responsive_contract\.mjs/.test(releaseWorkflow),
  ".github/workflows/web-release.yml must run the app responsive contract before publishing desktop release assets",
);
check(
  "Release workflow runs web and server tests",
  /working-directory:\s*web[\s\S]*?run:\s*npm test/.test(releaseWorkflow) &&
    /working-directory:\s*server[\s\S]*?run:\s*npm test/.test(releaseWorkflow),
  ".github/workflows/web-release.yml must run the web and server unit suites before publishing release assets",
);
check(
  "Release workflow runs security decisions",
  /check_security_decisions\.mjs/.test(releaseWorkflow),
  ".github/workflows/web-release.yml must enforce the recorded security decisions before packaging",
);
check(
  "Release workflow gates drafts on clean installs",
  /clean-install:\s*[\s\S]{0,120}needs:\s*finalize-release-assets/.test(
    releaseWorkflow,
  ) &&
    /uses:\s*\.\/\.github\/workflows\/clean-install\.yml/.test(releaseWorkflow) &&
    /tag:\s*\$\{\{\s*github\.ref_name\s*\}\}/.test(releaseWorkflow),
  ".github/workflows/web-release.yml must run the reusable clean-install workflow against tag assets",
);
check(
  "Release workflow grants draft asset access to clean installs",
  /clean-install:\s*[\s\S]{0,260}permissions:\s*[\s\S]{0,80}contents:\s*write/.test(
    releaseWorkflow,
  ),
  ".github/workflows/web-release.yml must grant contents: write to the reusable clean-install job so it can download draft assets",
);
check(
  "Clean-install workflow covers release packages",
  existsSync(join(root, ".github/workflows/clean-install.yml")) &&
    /macos-15/.test(cleanInstallWorkflow) &&
    /macos-15-intel/.test(cleanInstallWorkflow) &&
    /x64_en-US\.msi/.test(cleanInstallWorkflow) &&
    /x64-setup\.exe/.test(cleanInstallWorkflow) &&
    /amd64\.AppImage/.test(cleanInstallWorkflow) &&
    /amd64\.deb/.test(cleanInstallWorkflow),
  ".github/workflows/clean-install.yml must install both macOS architectures, Windows MSI and NSIS, Linux AppImage, and Linux deb assets",
);
check(
  "Clean-install workflow verifies Android TV identity",
  /android-tv:/.test(cleanInstallWorkflow) &&
    /YAWF\.Stream_Android\.TV_\$\{version\}\.apk/.test(cleanInstallWorkflow) &&
    /apksigner verify/.test(cleanInstallWorkflow) &&
    /SIGNING_CERT_SHA256/.test(cleanInstallWorkflow) &&
    /com\.yawf\.stream\.tv/.test(cleanInstallWorkflow) &&
    /android\.software\.leanback/.test(cleanInstallWorkflow) &&
    /android\.hardware\.touchscreen/.test(cleanInstallWorkflow),
  ".github/workflows/clean-install.yml must verify the APK signature, package identity, version, Leanback launcher, and optional touchscreen",
);
check(
  "Clean-install workflow verifies trust and first launch",
  /codesign --verify --deep --strict/.test(cleanInstallWorkflow) &&
    /spctl --assess/.test(cleanInstallWorkflow) &&
    /Get-AuthenticodeSignature/.test(cleanInstallWorkflow) &&
    /smoke_tauri_server_bundle\.mjs/.test(cleanInstallWorkflow) &&
    /clean profile/i.test(cleanInstallWorkflow),
  ".github/workflows/clean-install.yml must verify package trust, bundled server boot, and a clean-profile desktop launch",
);
check(
  "Clean-install workflow requires valid Windows signatures",
  /Windows \$env:INSTALLER_KIND installer Authenticode signature is not valid/.test(
    cleanInstallWorkflow,
  ) &&
    /Installed app Authenticode signature is not valid/.test(cleanInstallWorkflow) &&
    /kind: msi/.test(cleanInstallWorkflow) &&
    /kind: nsis/.test(cleanInstallWorkflow) &&
    !/Unsigned Windows installer is an accepted/.test(cleanInstallWorkflow),
  ".github/workflows/clean-install.yml must fail when either Windows installer format or the installed app lacks a valid Authenticode signature",
);
check(
  "Swift test verifier handles local VLCKit runtime",
  existsSync(join(root, "scripts/check_swift_tests.mjs")) &&
    /--build-tests/.test(swiftTestVerifier) &&
    /--skip-build/.test(swiftTestVerifier) &&
    /PackageFrameworks/.test(swiftTestVerifier) &&
    /known SwiftPM\/VLCKit teardown crash/.test(swiftTestVerifier),
  "scripts/check_swift_tests.mjs must build tests in a scratch path, expose VLCKit on the test rpath, and tolerate only the known teardown crash",
);
check(
  "Release workflow validates updater signing secret",
  /Validate updater signing secret/.test(releaseWorkflow) &&
    /TAURI_SIGNING_PRIVATE_KEY/.test(releaseWorkflow),
  ".github/workflows/web-release.yml must fail early when the updater signing private key is missing",
);
check(
  "Release workflow validates macOS signing secrets",
  /Validate macOS signing secrets/.test(releaseWorkflow) &&
    [
      "APPLE_CERTIFICATE",
      "APPLE_CERTIFICATE_PASSWORD",
      "APPLE_SIGNING_IDENTITY",
      "APPLE_ID",
      "APPLE_PASSWORD",
      "APPLE_TEAM_ID",
    ].every((secret) => releaseWorkflow.includes(secret)),
  ".github/workflows/web-release.yml must fail early when Developer ID/notarization secrets are missing",
);
check(
  "Release workflow configures Windows Authenticode signing",
  /Validate Windows signing secrets/.test(releaseWorkflow) &&
    [
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
      "AZURE_TENANT_ID",
      "AZURE_ARTIFACT_SIGNING_ENDPOINT",
      "AZURE_ARTIFACT_SIGNING_ACCOUNT",
      "AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE",
    ].every((secret) => releaseWorkflow.includes(secret)) &&
    /cargo install artifact-signing-cli --version 0\.11\.0 --locked/.test(
      releaseWorkflow,
    ) &&
    /generate_windows_signing_config\.mjs/.test(releaseWorkflow) &&
    /signCommand/.test(windowsSigningConfig) &&
    /"-a"/.test(windowsSigningConfig) &&
    /"-c"/.test(windowsSigningConfig) &&
    /AZURE_CLI_PATH=/.test(releaseWorkflow) &&
    /SIGNTOOL_PATH=/.test(releaseWorkflow) &&
    /WINDOWS_SIGN_CONFIG_ARG/.test(releaseWorkflow),
  ".github/workflows/web-release.yml must fail early without Azure Artifact Signing secrets and pass a pinned custom sign command to Tauri",
);
check(
  "Windows release channel is explicitly held by default",
  /YAWF_RELEASE_WINDOWS/.test(releaseWorkflow) &&
    /if:\s*matrix\.os == 'windows' && vars\.YAWF_RELEASE_WINDOWS == 'true'/.test(
      releaseWorkflow,
    ) &&
    /if:\s*matrix\.os != 'windows' \|\| vars\.YAWF_RELEASE_WINDOWS == 'true'[\s\S]{0,180}uses:\s*tauri-apps\/tauri-action@v0/.test(
      releaseWorkflow,
    ) &&
    /include_windows:\s*\$\{\{\s*vars\.YAWF_RELEASE_WINDOWS == 'true'\s*\}\}/.test(
      releaseWorkflow,
    ) &&
    /include_windows:[\s\S]{0,160}default:\s*false[\s\S]{0,80}type:\s*boolean/.test(
      cleanInstallWorkflow,
    ) &&
    /windows:[\s\S]{0,120}if:\s*inputs\.include_windows/.test(cleanInstallWorkflow),
  "Windows artifacts must remain disabled unless YAWF_RELEASE_WINDOWS is explicitly true, while enabled releases retain signing and clean-install gates",
);
check(
  "Clean-install workflow verifies the self-hosted server deb",
  /server-deb:/.test(cleanInstallWorkflow) &&
    /ubuntu-22\.04/.test(cleanInstallWorkflow) &&
    /ubuntu-24\.04/.test(cleanInstallWorkflow) &&
    /debridstreamer-server_\$\{version\}_all\.deb/.test(cleanInstallWorkflow) &&
    /\/api\/health/.test(cleanInstallWorkflow) &&
    /\/opt\/debridstreamer\/web-dist\/index\.html/.test(cleanInstallWorkflow),
  ".github/workflows/clean-install.yml must install the versioned server deb on supported Ubuntu runners and verify health plus the hosted web app",
);
check(
  "Clean-install workflow verifies updater channel isolation",
  /manifest:/.test(cleanInstallWorkflow) &&
    /darwin-aarch64-app/.test(cleanInstallWorkflow) &&
    /linux-x86_64-appimage/.test(cleanInstallWorkflow) &&
    /latest\.json is missing an updater signature/.test(cleanInstallWorkflow) &&
    /Held Windows channel leaked into latest\.json/.test(cleanInstallWorkflow) &&
    /Held Windows channel leaked an asset into the draft release/.test(cleanInstallWorkflow),
  ".github/workflows/clean-install.yml must require signed macOS and Linux updater entries and reject Windows manifest entries or assets while that channel is held",
);
check(
  "Windows signing config generator fails closed without writing client credentials",
  /codesigning\\\.azure\\\.net/.test(windowsSigningConfig) &&
    /%1/.test(windowsSigningConfig) &&
    !/AZURE_CLIENT_SECRET/.test(windowsSigningConfig),
  "scripts/generate_windows_signing_config.mjs must validate the Azure endpoint, retain Tauri's file placeholder, and keep client credentials environment-only",
);
check(
  "Release workflow bundles macOS Node runtimes",
  // Per-arch: each mac job downloads only its own runtime via matrix.node_runtime,
  // and both arches are present across the matrix.
  /node_runtime:\s*darwin-arm64/.test(releaseWorkflow) &&
    /node_runtime:\s*darwin-x64/.test(releaseWorkflow) &&
    /download_tauri_node_runtime\.mjs \$\{\{ matrix\.node_runtime \}\}/.test(releaseWorkflow),
  ".github/workflows/web-release.yml must bundle darwin-arm64 and darwin-x64 Node runtimes across the per-arch mac matrix",
);
check(
  "Release workflow bundles Linux Node runtime",
  /download_tauri_node_runtime\.mjs\s+linux-x64/.test(releaseWorkflow),
  ".github/workflows/web-release.yml must bundle a linux-x64 Node runtime for the Linux desktop app",
);
check(
  "Release workflow bundles Windows Node runtime",
  /download_tauri_node_runtime\.mjs\s+win-x64/.test(releaseWorkflow),
  ".github/workflows/web-release.yml must bundle a win-x64 Node runtime for the Windows desktop app",
);
check(
  "Release workflow bundles ffmpeg binaries",
  // The optimize/remux engine shells out to bundled ffmpeg/ffprobe, so every
  // desktop target must fetch them exactly like the Node runtime above: macOS
  // per-arch via matrix.node_runtime, Linux and Windows literally.
  /download_ffmpeg\.mjs \$\{\{ matrix\.node_runtime \}\}/.test(releaseWorkflow) &&
    /download_ffmpeg\.mjs\s+linux-x64/.test(releaseWorkflow) &&
    /download_ffmpeg\.mjs\s+win-x64/.test(releaseWorkflow),
  ".github/workflows/web-release.yml must fetch ffmpeg/ffprobe for macOS (per-arch), Linux, and Windows before packaging",
);
check(
  "Tauri bundles ffmpeg resources",
  // Fetching the binaries is not enough - tauri.conf.json must ship them so
  // they are present in the packaged app next to the Node runtime.
  Array.isArray(tauri.bundle?.resources) &&
    tauri.bundle.resources.includes("resources/ffmpeg/**/*"),
  "web/src-tauri/tauri.conf.json must recursively include resources/ffmpeg so bundled ffmpeg/ffprobe binaries ship with the app",
);
check(
  "Local package script bundles current-platform Node",
  /download_tauri_node_runtime\.mjs/.test(localPackage) &&
    /nodeRuntimePlatform/.test(localPackage),
  "scripts/package_tauri_local.mjs must bundle the current-platform Node runtime before Tauri packaging",
);
check(
  "Local macOS package is self-contained for playback",
  /download_ffmpeg\.mjs/.test(localPackage) &&
    /"bundle-mpv-deps\.sh"/.test(localPackage) &&
    /MPV_LIB_DIR/.test(localPackage) &&
    /otool/.test(localPackage) &&
    /\/opt\/homebrew/.test(localPackage) &&
    /\/usr\/local/.test(localPackage),
  "scripts/package_tauri_local.mjs must bundle ffmpeg and libmpv, link through the bundled tree, and reject build-machine paths",
);
check(
  "Local package script creates macOS app zip",
  /--bundles/.test(localPackage) &&
    /app\.zip/.test(localPackage) &&
    /ditto/.test(localPackage),
  "scripts/package_tauri_local.mjs must build a local macOS .app bundle and zip it without relying on DMG post-processing",
);
check(
  "Local package artifact verifier exists",
  existsSync(join(root, "scripts/check_local_package_artifact.mjs")) &&
    /--require-current/.test(localArtifactVerifier) &&
    /sha256/.test(localArtifactVerifier),
  "scripts/check_local_package_artifact.mjs must verify local package artifact freshness, size, and checksum",
);
check(
  "Node runtime downloader is origin-restricted",
  /nodeDistOrigin\s*=\s*"https:\/\/nodejs\.org"/.test(nodeRuntimeDownloader) &&
    /assertNodeDistUrl/.test(nodeRuntimeDownloader) &&
    /Too many redirects/.test(nodeRuntimeDownloader),
  "scripts/download_tauri_node_runtime.mjs must only download runtimes from nodejs.org and bound redirects",
);
check(
  "Node runtime downloader rejects incomplete archives",
  /minArchiveBytes/.test(nodeRuntimeDownloader) &&
    /statSync\(archive\)\.size\s*>=\s*minArchiveBytes/.test(nodeRuntimeDownloader),
  "scripts/download_tauri_node_runtime.mjs must reject empty or truncated cached Node archives",
);
check(
  "Node runtime downloader verifies archive checksums",
  /SHASUMS256\.txt/.test(nodeRuntimeDownloader) &&
    /createHash\("sha256"\)/.test(nodeRuntimeDownloader) &&
    /SHA-256 mismatch/.test(nodeRuntimeDownloader),
  "scripts/download_tauri_node_runtime.mjs must verify downloaded Node archives against Node release SHASUMS",
);
check(
  "Server resource prep is cwd-independent",
  /fileURLToPath\(import\.meta\.url\)/.test(serverResourcePrep) &&
    !/const root = process\.cwd\(\)/.test(serverResourcePrep),
  "scripts/prepare_tauri_server_resources.mjs must resolve the repo root from its own path, not the caller cwd",
);

check(
  "Website exists",
  existsSync(join(root, "website/index.html")) &&
    existsSync(join(root, "website/app.js")) &&
    existsSync(join(root, "website/styles.css")),
  "website/ must contain the static download site",
);
check(
  "Cinematic YAWF Stream website exists",
  existsSync(join(root, "website-app/package.json")) &&
    existsSync(join(root, "website-app/src/pages/home/Hero.tsx")) &&
    existsSync(join(root, "website-app/public/hero-streams-loop.mp4")),
  "website-app must contain the cinematic YAWF Stream Sites build and its hero media",
);
check(
  "Release workflow validates the cinematic website",
  /working-directory:\s*website-app/.test(releaseWorkflow) &&
    /check_website_app\.mjs/.test(releaseWorkflow),
  ".github/workflows/web-release.yml must build and validate website-app before packaging",
);
check(
  "Website product preview media exists",
  existsSync(join(root, "scripts/generate_website_media.mjs")) &&
    existsSync(join(root, "website/media/discover-desktop.png")) &&
    existsSync(join(root, "website/media/discover-tablet.png")) &&
    existsSync(join(root, "website/media/settings-mobile.png")),
  "website media must include product preview images for the first-viewport documentation site",
);
check(
  "Website download logic check exists",
  existsSync(join(root, "scripts/check_website_download_logic.mjs")),
  "scripts/check_website_download_logic.mjs must verify platform detection and release asset matching",
);
check(
  "Website static check exists",
  existsSync(join(root, "scripts/check_website_static.mjs")),
  "scripts/check_website_static.mjs must verify anchors, local assets, stale copy, and responsive site safeguards",
);
check(
  "Website mounted-path check exists",
  existsSync(join(root, "scripts/check_website_path_mount.mjs")),
  "scripts/check_website_path_mount.mjs must verify website/ assets and Worker routing work under tgk30.com/debridstreamer/",
);
check(
  "Cloudflare path deploy helper exists",
  existsSync(join(root, "scripts/deploy_website_cloudflare.mjs")) &&
    /workers\/routes/.test(cloudflareDeployHelper) &&
    /wrangler@latest/.test(cloudflareDeployHelper),
  "scripts/deploy_website_cloudflare.mjs must deploy website/ to Cloudflare Pages and route tgk30.com/debridstreamer* through a Worker",
);
check(
  "Cloudflare path deploy helper validates mounted-path safety",
  /check_website_download_logic\.mjs/.test(cloudflareDeployHelper) &&
    /check_website_static\.mjs/.test(cloudflareDeployHelper) &&
    /check_website_path_mount\.mjs/.test(cloudflareDeployHelper) &&
    /public_repo_preflight\.mjs/.test(cloudflareDeployHelper),
  "scripts/deploy_website_cloudflare.mjs must run download, static, mounted-path, and public-repo checks before mutating Cloudflare",
);
// GitHub Pages (site.yml) was removed 2026-07 - Pages was never enabled and
// Cloudflare (cloudflare-site.yml, checked below) is the deploy that counts.
check(
  "Legacy GitHub Pages workflow stays deleted",
  !existsSync(join(root, ".github/workflows/site.yml")),
  ".github/workflows/site.yml is dead legacy - the Cloudflare workflow owns the site deploy",
);
check(
  "Cloudflare site workflow exists",
  existsSync(join(root, ".github/workflows/cloudflare-site.yml")),
  ".github/workflows/cloudflare-site.yml must deploy tgk30.com/debridstreamer through Cloudflare",
);
check(
  "Cloudflare site workflow validates website",
  /public_repo_preflight\.mjs/.test(cloudflareSiteWorkflow) &&
    /check_website_download_logic\.mjs/.test(cloudflareSiteWorkflow) &&
    /check_website_static\.mjs/.test(cloudflareSiteWorkflow) &&
    /check_website_path_mount\.mjs/.test(cloudflareSiteWorkflow),
  ".github/workflows/cloudflare-site.yml must run public repo preflight, website download logic, static site QA, and mounted-path QA before deploy",
);
check(
  "Cloudflare site workflow public preflight uses full Git history",
  workflowHasFullHistoryCheckout(cloudflareSiteWorkflow),
  ".github/workflows/cloudflare-site.yml must checkout with fetch-depth: 0 before running public repo preflight",
);
check(
  "Cloudflare site workflow deploys mounted path",
  /Validate Cloudflare token secret/.test(cloudflareSiteWorkflow) &&
    /CLOUDFLARE_API_TOKEN/.test(cloudflareSiteWorkflow) &&
    /deploy_website_cloudflare\.mjs/.test(cloudflareSiteWorkflow) &&
    /tgk30\.com\/debridstreamer/.test(cloudflareSiteWorkflow),
  ".github/workflows/cloudflare-site.yml must validate the Cloudflare token secret and run the Cloudflare deploy helper for tgk30.com/debridstreamer",
);
check(
  "Cloudflare site workflow supports release publication holds",
  /if:\s*vars\.YAWF_HOLD_WEBSITE_DEPLOY != 'true'/.test(cloudflareSiteWorkflow),
  ".github/workflows/cloudflare-site.yml must allow a version-bump merge to hold deployment until its release assets are public",
);
check(
  "Cloudflare site workflow watches site dependencies",
  [
    "website/**",
    "web/public/icons/**",
    "scripts/check_website_download_logic.mjs",
    "scripts/check_website_static.mjs",
    "scripts/check_website_path_mount.mjs",
    "scripts/deploy_website_cloudflare.mjs",
    "scripts/public_repo_preflight.mjs",
  ].every((path) => cloudflareSiteWorkflow.includes(path)),
  ".github/workflows/cloudflare-site.yml paths must include website assets and all Cloudflare site validation/deploy scripts",
);
check(
  "PWA manifest exists",
  existsSync(join(root, "web/public/manifest.webmanifest")) &&
    existsSync(join(root, "web/public/sw.js")),
  "web/public must contain manifest.webmanifest and sw.js",
);
check(
  "Server Docker packaging exists",
  existsSync(join(root, "Dockerfile")) &&
    existsSync(join(root, "deploy/compose/docker-compose.yml")),
  "Dockerfile and deploy/compose/docker-compose.yml are required for Server Mode",
);
check(
  "Docker web build includes production bundle gate",
  /COPY scripts\/check_bundle_budgets\.mjs \/repo\/scripts\/check_bundle_budgets\.mjs/.test(
    dockerfile,
  ) && /RUN npm run build/.test(dockerfile),
  "Dockerfile must copy the production bundle-budget verifier before the web build invokes it",
);
check(
  "Docker user guide exists",
  existsSync(join(root, "docs/DOCKER.md")),
  "docs/DOCKER.md should explain Docker/GHCR setup and persistent data",
);
check(
  "Multi-arch Docker workflow exists",
  /docker\/build-push-action@v6/.test(dockerWorkflow) &&
    /platforms:\s*linux\/amd64,linux\/arm64/.test(dockerWorkflow) &&
    /ghcr\.io/.test(dockerWorkflow),
  ".github/workflows/docker-image.yml must publish linux/amd64 and linux/arm64 images to GHCR",
);
check(
  "Desktop release tags publish stable server image versions",
  /version="\$\{REF_NAME#v\}"/.test(dockerWorkflow) &&
    /version="\$\{version%-web\}"/.test(dockerWorkflow) &&
    /major_minor=\$\{version%\.\*\}/.test(dockerWorkflow) &&
    /steps\.release-version\.outputs\.version/.test(dockerWorkflow) &&
    /steps\.release-version\.outputs\.major_minor/.test(dockerWorkflow),
  ".github/workflows/docker-image.yml must turn vX.Y.Z-web into X.Y.Z and X.Y server image tags",
);
check(
  "Pull requests build Docker images without publishing",
  /pull_request:\s*[\s\S]{0,80}branches:\s*\n\s*- main/.test(dockerWorkflow) &&
    /if: github\.event_name != 'pull_request'/.test(dockerWorkflow) &&
    /push: \$\{\{ github\.event_name != 'pull_request' \}\}/.test(dockerWorkflow),
  ".github/workflows/docker-image.yml must build changed images on pull requests and publish only outside pull requests",
);
check(
  "Docker workflow runs public preflight",
  /public_repo_preflight\.mjs/.test(dockerWorkflow) &&
    /check_release_readiness\.mjs/.test(dockerWorkflow),
  ".github/workflows/docker-image.yml must run public repo preflight and release readiness before publishing images",
);
check(
  "Docker workflow public preflight uses full Git history",
  workflowHasFullHistoryCheckout(dockerWorkflow),
  ".github/workflows/docker-image.yml must checkout with fetch-depth: 0 before running public repo preflight",
);
check(
  "Docker workflow watches publish gates",
  [
    "Dockerfile",
    ".dockerignore",
    "scripts/check_release_readiness.mjs",
    "scripts/public_repo_preflight.mjs",
    "server/**",
    "web/**",
  ].every((path) => dockerWorkflow.includes(path)),
  ".github/workflows/docker-image.yml paths must include Docker inputs plus readiness/security scripts",
);
check(
  "Docker context excludes local assistant and secret files",
  [
    ".claude",
    ".codex",
    ".cursor",
    ".windsurf",
    ".continue",
    ".gemini",
    ".opencode",
    ".aider*",
    "CLAUDE.md",
    "CODEX.md",
    "GEMINI.md",
    "AGENTS.md",
    "AGENT.md",
    ".env",
  ].every((pattern) => dockerIgnore.includes(pattern)),
  ".dockerignore must exclude local assistant files, transcripts, and env files from Docker build contexts",
);
check(
  "Public repo security preflight exists",
  existsSync(join(root, "scripts/public_repo_preflight.mjs")) &&
    existsSync(join(root, "scripts/public_repo_preflight.test.mjs")),
  "The public repo preflight and its regression tests must exist",
);
check(
  "App responsive contract exists",
  existsSync(join(root, "scripts/check_app_responsive_contract.mjs")),
  "scripts/check_app_responsive_contract.mjs must exist to guard mobile nav, settings selector, and setup wizard responsive contracts",
);
check(
  "Public repo preflight scans Git history",
  /rev-list/.test(publicRepoPreflight) &&
    /--objects/.test(publicRepoPreflight) &&
    /cat-file/.test(publicRepoPreflight) &&
    /commit message/.test(publicRepoPreflight),
  "scripts/public_repo_preflight.mjs must scan reachable history blobs and commit messages before public pushes",
);
check(
  "Public repo preflight can scan all refs",
  /--all-refs/.test(publicRepoPreflight) &&
    /historyScopeArgs/.test(publicRepoPreflight),
  "scripts/public_repo_preflight.mjs must support --all-refs before pushing multiple branches or tags to a public remote",
);
check(
  "Public repo preflight catches generic provider keys",
  /sk-\[A-Za-z0-9_-\]\{20,\}/.test(publicRepoPreflight) &&
    /zai\|z\\\.ai/.test(publicRepoPreflight),
  "scripts/public_repo_preflight.mjs must catch generic sk-prefixed provider keys, including Z.AI/GLM-style keys",
);
check(
  "CI runs public and website gates",
  /node --test scripts\/public_repo_preflight\.test\.mjs/.test(ciWorkflow) &&
    /public_repo_preflight\.mjs/.test(ciWorkflow) &&
    /check_release_readiness\.mjs/.test(ciWorkflow) &&
    /check_website_download_logic\.mjs/.test(ciWorkflow) &&
    /check_website_static\.mjs/.test(ciWorkflow) &&
    /check_website_path_mount\.mjs/.test(ciWorkflow),
  ".github/workflows/ci.yml must test and run the public repo gate plus release readiness and website checks",
);
check(
  "CI tests the Android TV package",
  /android-tv:/.test(ciWorkflow) &&
    /platforms;android-36/.test(ciWorkflow) &&
    /:app:testDebugUnitTest :app:lintDebug :app:assembleDebug/.test(ciWorkflow),
  ".github/workflows/ci.yml must test, lint, and assemble the Android TV app",
);
check(
  "CI runs security decisions",
  /check_security_decisions\.mjs/.test(ciWorkflow),
  ".github/workflows/ci.yml must enforce scripts/check_security_decisions.mjs",
);
check(
  "Security decision gate exists",
  existsSync(join(root, "docs/SECURITY_DECISIONS.md")) &&
    existsSync(join(root, "scripts/check_security_decisions.mjs")) &&
    /SEC-010/.test(read("docs/SECURITY_DECISIONS.md")) &&
    /opener:default/.test(securityDecisionCheck) &&
    /BEGIN IMMEDIATE/.test(securityDecisionCheck),
  "The decision log and executable gate must cover desktop permissions and transactional migrations",
);
check(
  "CI public preflight uses full Git history",
  workflowHasFullHistoryCheckout(ciWorkflow),
  ".github/workflows/ci.yml must checkout with fetch-depth: 0 before running public repo preflight",
);
check(
  "CI runs app responsive contract",
  /check_app_responsive_contract\.mjs/.test(ciWorkflow),
  ".github/workflows/ci.yml must run scripts/check_app_responsive_contract.mjs so mobile nav, settings selectors, and setup wizard defaults cannot regress",
);
check(
  "Production builds enforce bundle budgets",
  existsSync(join(root, "scripts/check_bundle_budgets.test.mjs")) &&
    existsSync(join(root, "docs/PERFORMANCE_BUDGETS.md")) &&
    /check_bundle_budgets\.mjs web/.test(webPackage.scripts?.["check:bundle"] ?? "") &&
    /check_bundle_budgets\.mjs website-app/.test(
      websitePackage.scripts?.["check:bundle"] ?? "",
    ) &&
    /npm run check:bundle/.test(webPackage.scripts?.build ?? "") &&
    /npm run check:bundle/.test(websitePackage.scripts?.build ?? "") &&
    /initialGzip/.test(bundleBudgetCheck) &&
    /largestJsGzip/.test(bundleBudgetCheck),
  "web and website production builds must enforce tested and documented initial-load and route-chunk raw/gzip budgets",
);
check(
  "CI tests the bundle budget verifier",
  /node --test scripts\/check_bundle_budgets\.test\.mjs/.test(ciWorkflow),
  ".github/workflows/ci.yml must test the bundle budget verifier before production builds rely on it",
);
check(
  "CI runs Swift test verifier",
  /check_swift_tests\.mjs/.test(ciWorkflow),
  ".github/workflows/ci.yml must run scripts/check_swift_tests.mjs for native Swift tests",
);
check(
  "CI enforces Rust format, lint, tests, and dependency audit",
  /cargo fmt --check/.test(ciWorkflow) &&
    /cargo clippy --locked --all-targets -- -D warnings/.test(ciWorkflow) &&
    /cargo test --locked/.test(ciWorkflow) &&
    /cargo audit/.test(ciWorkflow),
  ".github/workflows/ci.yml must keep the Tauri Rust crate formatted, warning-free, tested, and vulnerability-audited",
);
check(
  "Tauri Linux GTK and glib migration risk is recorded",
  /tauri 2\.11\.2/.test(linuxGtkMigration) &&
    /gtk 0\.18\.2/.test(linuxGtkMigration) &&
    /glib 0\.18\.5/.test(linuxGtkMigration) &&
    /RUSTSEC-2024-0415/.test(linuxGtkMigration) &&
    /RUSTSEC-2024-0429/.test(linuxGtkMigration) &&
    /Wayland and X11/.test(linuxGtkMigration),
  "docs/TAURI_LINUX_GTK_MIGRATION.md must preserve the verified dependency versions, audit warnings, and cross-session migration acceptance criteria",
);
check(
  "Desktop server resource scripts exist",
  existsSync(join(root, "scripts/prepare_tauri_server_resources.mjs")) &&
    existsSync(join(root, "scripts/download_tauri_node_runtime.mjs")) &&
    existsSync(join(root, "scripts/smoke_tauri_server_bundle.mjs")),
  "scripts must prepare desktop server resources, Node runtimes, and smoke the packaged server bundle",
);
check(
  "Release workflow smokes desktop server bundle",
  /smoke_tauri_server_bundle\.mjs/.test(releaseWorkflow),
  ".github/workflows/web-release.yml must boot the prepared desktop server bundle before publishing release assets",
);
check(
  "CI smokes desktop server bundle",
  /smoke_tauri_server_bundle\.mjs/.test(ciWorkflow) &&
    /download_tauri_node_runtime\.mjs linux-x64/.test(ciWorkflow),
  ".github/workflows/ci.yml must boot the prepared desktop server bundle with a bundled Node runtime",
);
check(
  "Local package script smokes packaged app",
  /smoke_tauri_server_bundle\.mjs/.test(read("scripts/package_tauri_local.mjs")),
  "scripts/package_tauri_local.mjs must smoke the packaged app after local Tauri packaging",
);
check(
  "Desktop server smoke follows the branded app name",
  /tauriConfig\.productName/.test(desktopServerSmoke) &&
    !/macos",\s*"DebridStreamer\.app"/.test(desktopServerSmoke),
  "scripts/smoke_tauri_server_bundle.mjs must resolve the macOS app from tauri.conf.json productName",
);
check(
  "OSS support docs exist",
  existsSync(join(root, "CONTRIBUTING.md")) &&
    existsSync(join(root, "SECURITY.md")) &&
    existsSync(join(root, ".github/ISSUE_TEMPLATE/bug_report.yml")) &&
    existsSync(join(root, ".github/ISSUE_TEMPLATE/install_support.yml")),
  "CONTRIBUTING.md, SECURITY.md, and issue templates are required for public release readiness",
);

const failed = checks.filter((item) => !item.pass);
for (const item of checks) {
  const mark = item.pass ? "ok" : "fail";
  console.log(`${mark.padEnd(4)} ${item.name}`);
  if (!item.pass) console.log(`     ${item.detail}`);
}

if (failed.length > 0) {
  console.error(`\n${failed.length} release readiness check(s) failed.`);
  process.exit(1);
}

console.log("\nRelease readiness checks passed.");
