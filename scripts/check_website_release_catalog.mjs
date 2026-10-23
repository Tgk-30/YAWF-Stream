#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function includes(source, fragment, failures, message) {
  if (!source.includes(fragment)) failures.push(message);
}

export function validateWebsiteReleaseCatalog(source) {
  const failures = [];

  includes(
    source,
    "export const GITHUB_REPO = 'https://github.com/Tgk-30/YAWF-Stream';",
    failures,
    "release catalog must use the canonical Tgk-30/YAWF-Stream repository",
  );
  includes(
    source,
    "function releaseAsset(release: PublishedRelease, filename: string) {\n  return `${GITHUB_RELEASES}/download/${release.tag}/${filename}`;\n}",
    failures,
    "release assets must remain on the tag-qualified download boundary",
  );

  for (const [name, version, tag] of [
    ["DESKTOP_RELEASE", "2.3.37", "v2.3.37-web"],
    ["ANDROID_TV_RELEASE", "2.3.37", "v2.3.37-web"],
    ["ANDROID_PHONE_RELEASE", "2.3.37", "android-v2.3.37"],
    ["SERVER_RELEASE", "2.3.37", "v2.3.37"],
  ]) {
    includes(
      source,
      `export const ${name}: PublishedRelease = { version: '${version}', tag: '${tag}' };`,
      failures,
      `${name} must retain its published version and tag`,
    );
  }

  includes(
    source,
    "export const VERSION = DESKTOP_RELEASE.tag;",
    failures,
    "VERSION must remain an explicit desktop-only compatibility label",
  );
  includes(source, "desktopChecksums: releaseAsset(DESKTOP_RELEASE, 'SHA256SUMS')", failures, "desktop checksum channel must use the desktop release");
  includes(source, "androidTvChecksums: releaseAsset(ANDROID_TV_RELEASE, 'SHA256SUMS')", failures, "Android TV checksum channel must use the Android TV release");
  includes(source, "androidPhoneChecksums: releaseAsset(ANDROID_PHONE_RELEASE, 'SHA256SUMS')", failures, "Android phone checksum channel must use the Android phone release");
  includes(source, "serverChecksums: releaseAsset(SERVER_RELEASE, 'SHA256SUMS')", failures, "server checksum channel must use the server release");
  includes(source, "serverUpdateManifest: releaseAsset(SERVER_RELEASE, 'server-update.json')", failures, "server update manifest must use the server release");
  includes(source, "serverVerification: releaseAsset(SERVER_RELEASE, `Server_${SERVER_RELEASE.version}_verification.json`)", failures, "server verification record must use the server release and filename");
  includes(source, "serverUpdaterBundle: releaseAsset(SERVER_RELEASE, `yawf-server-updater_${SERVER_RELEASE.version}.tar.gz`)", failures, "server updater bundle must use the server release and filename");

  for (const [name, fragment] of [
    ["Apple Silicon DMG", "macosArm: releaseAsset(DESKTOP_RELEASE, `YAWF.Stream_${DESKTOP_RELEASE.version}_aarch64.dmg`)"],
    ["Intel DMG", "macosIntel: releaseAsset(DESKTOP_RELEASE, `YAWF.Stream_${DESKTOP_RELEASE.version}_x64.dmg`)"],
    ["Linux AppImage", "linuxAppImage: releaseAsset(DESKTOP_RELEASE, `YAWF.Stream_${DESKTOP_RELEASE.version}_amd64.AppImage`)"],
    ["Android TV APK", "androidTV: releaseAsset(ANDROID_TV_RELEASE, `YAWF.Stream_Android.TV_${ANDROID_TV_RELEASE.version}.apk`)"],
    ["Android phone APK", "androidPhone: releaseAsset(ANDROID_PHONE_RELEASE, `YAWF.Stream_Android_${ANDROID_PHONE_RELEASE.version}.apk`)"],
    ["server Debian package", "serverDeb: releaseAsset(SERVER_RELEASE, `debridstreamer-server_${SERVER_RELEASE.version}_all.deb`)"],
  ]) {
    includes(source, fragment, failures, `${name} must retain its release channel and filename`);
  }

  includes(source, "GITHUB_DOCKER = `${GITHUB_REPO}/tree/${SERVER_RELEASE.tag}/deploy/compose`", failures, "Docker source link must use the server release tag");
  includes(source, "GITHUB_UBUNTU_GUIDE = `${GITHUB_REPO}/blob/${SERVER_RELEASE.tag}/deploy/ubuntu/README.md`", failures, "Ubuntu guide must use the server release tag");
  includes(source, "SERVER_SOURCE_FILES", failures, "server source files must be versioned");
  includes(source, "${SERVER_RELEASE.tag}/deploy/compose/docker-compose.ghcr.yml", failures, "Docker Compose source file must use the server release tag");
  includes(source, "${SERVER_RELEASE.tag}/deploy/compose/.env.example", failures, "environment example source file must use the server release tag");

  for (const forbidden of ["APP_VERSION", "RELEASE_ASSET_BASE", "RELEASE_CHECKSUMS", "GITHUB_RELEASES_LATEST"]) {
    if (source.includes(forbidden)) failures.push(`website release catalog must not use generic ${forbidden}`);
  }

  return failures;
}

export function readWebsiteReleaseCatalog() {
  return readFileSync(resolve(root, "website-app/src/lib/site.ts"), "utf8");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const failures = validateWebsiteReleaseCatalog(readWebsiteReleaseCatalog());
  if (failures.length > 0) {
    console.error("Website release catalog check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log("Website release catalog check passed.");
}
