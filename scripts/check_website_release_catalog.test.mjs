import assert from "node:assert/strict";
import test from "node:test";
import { readWebsiteReleaseCatalog, validateWebsiteReleaseCatalog } from "./check_website_release_catalog.mjs";

const source = readWebsiteReleaseCatalog();

test("website release catalog accepts the published platform channels", () => {
  assert.deepEqual(validateWebsiteReleaseCatalog(source), []);
});

test("website release catalog rejects server90 while leaving independent channels unchanged", () => {
  const previous = source.replace(
    "export const SERVER_RELEASE: PublishedRelease = { version: '2.3.98', tag: 'v2.3.98' };",
    "export const SERVER_RELEASE: PublishedRelease = { version: '2.3.90', tag: 'v2.3.90' };",
  );
  assert.notEqual(previous, source, "fixture must contain the server98 mutation target");
  assert.deepEqual(validateWebsiteReleaseCatalog(previous), ["SERVER_RELEASE must retain its published version and tag"]);
});

for (const { name, from, to } of [
  {
    name: "desktop version",
    from: "export const DESKTOP_RELEASE: PublishedRelease = { version: '2.3.96', tag: 'v2.3.96-web' };",
    to: "export const DESKTOP_RELEASE: PublishedRelease = { version: '2.3.25', tag: 'v2.3.28-web' };",
  },
  {
    name: "Windows availability",
    from: "export const WINDOWS_RELEASE_AVAILABLE = false;",
    to: "export const WINDOWS_RELEASE_AVAILABLE = true;",
  },
  {
    name: "Android phone tag",
    from: "export const ANDROID_PHONE_RELEASE: PublishedRelease = { version: '2.3.99', tag: 'android-v2.3.99' };",
    to: "export const ANDROID_PHONE_RELEASE: PublishedRelease = { version: '2.3.20', tag: 'v2.3.13' };",
  },
  {
    name: "stale Android phone channel",
    from: "export const ANDROID_PHONE_RELEASE: PublishedRelease = { version: '2.3.99', tag: 'android-v2.3.99' };",
    to: "export const ANDROID_PHONE_RELEASE: PublishedRelease = { version: '2.3.88', tag: 'android-v2.3.88' };",
  },
  {
    name: "older published Android phone channel",
    from: "export const ANDROID_PHONE_RELEASE: PublishedRelease = { version: '2.3.99', tag: 'android-v2.3.99' };",
    to: "export const ANDROID_PHONE_RELEASE: PublishedRelease = { version: '2.3.96', tag: 'android-v2.3.96' };",
  },
  {
    name: "previous published Android phone channel",
    from: "export const ANDROID_PHONE_RELEASE: PublishedRelease = { version: '2.3.99', tag: 'android-v2.3.99' };",
    to: "export const ANDROID_PHONE_RELEASE: PublishedRelease = { version: '2.3.98', tag: 'android-v2.3.98' };",
  },
  {
    name: "unpublished future Android phone channel",
    from: "export const ANDROID_PHONE_RELEASE: PublishedRelease = { version: '2.3.99', tag: 'android-v2.3.99' };",
    to: "export const ANDROID_PHONE_RELEASE: PublishedRelease = { version: '2.3.100', tag: 'android-v2.3.100' };",
  },
  {
    name: "Android TV filename",
    from: "YAWF.Stream_Android.TV_${ANDROID_TV_RELEASE.version}.apk",
    to: "YAWF.Stream_Android_${ANDROID_TV_RELEASE.version}.apk",
  },
  {
    name: "Android TV checksum channel",
    from: "androidTvChecksums: releaseAsset(ANDROID_TV_RELEASE, 'SHA256SUMS')",
    to: "androidTvChecksums: releaseAsset(DESKTOP_RELEASE, 'SHA256SUMS')",
  },
  {
    name: "published server version",
    from: "export const SERVER_RELEASE: PublishedRelease = { version: '2.3.98', tag: 'v2.3.98' };",
    to: "export const SERVER_RELEASE: PublishedRelease = { version: '2.3.51', tag: 'v2.3.51' };",
  },
  {
    name: "server release tag independently of version",
    from: "tag: 'v2.3.98'",
    to: "tag: 'v2.3.51'",
  },
  {
    name: "stale server channel",
    from: "export const SERVER_RELEASE: PublishedRelease = { version: '2.3.98', tag: 'v2.3.98' };",
    to: "export const SERVER_RELEASE: PublishedRelease = { version: '2.3.95', tag: 'v2.3.95' };",
  },
  {
    name: "older published server channel",
    from: "export const SERVER_RELEASE: PublishedRelease = { version: '2.3.98', tag: 'v2.3.98' };",
    to: "export const SERVER_RELEASE: PublishedRelease = { version: '2.3.96', tag: 'v2.3.96' };",
  },
  {
    name: "previous published server channel",
    from: "export const SERVER_RELEASE: PublishedRelease = { version: '2.3.98', tag: 'v2.3.98' };",
    to: "export const SERVER_RELEASE: PublishedRelease = { version: '2.3.97', tag: 'v2.3.97' };",
  },
  {
    name: "unpublished future server channel",
    from: "export const SERVER_RELEASE: PublishedRelease = { version: '2.3.98', tag: 'v2.3.98' };",
    to: "export const SERVER_RELEASE: PublishedRelease = { version: '2.3.99', tag: 'v2.3.99' };",
  },
  {
    name: "server Debian filename",
    from: "debridstreamer-server_${SERVER_RELEASE.version}_all.deb",
    to: "debridstreamer-server_${SERVER_RELEASE.version}_amd64.deb",
  },
  {
    name: "server update manifest filename",
    from: "serverUpdateManifest: releaseAsset(SERVER_RELEASE, 'server-update.json')",
    to: "serverUpdateManifest: releaseAsset(SERVER_RELEASE, 'latest.json')",
  },
  {
    name: "server verification filename",
    from: "Server_${SERVER_RELEASE.version}_verification.json",
    to: "Server_${SERVER_RELEASE.version}_checksum.json",
  },
  {
    name: "server updater bundle filename",
    from: "yawf-server-updater_${SERVER_RELEASE.version}.tar.gz",
    to: "yawf-server-updater_${SERVER_RELEASE.version}.zip",
  },
  {
    name: "Docker source release tag",
    from: "GITHUB_DOCKER = `${GITHUB_REPO}/tree/${SERVER_RELEASE.tag}/deploy/compose`",
    to: "GITHUB_DOCKER = `${GITHUB_REPO}/tree/main/deploy/compose`",
  },
  {
    name: "Ubuntu guide release tag",
    from: "GITHUB_UBUNTU_GUIDE = `${GITHUB_REPO}/blob/${SERVER_RELEASE.tag}/deploy/ubuntu/README.md`",
    to: "GITHUB_UBUNTU_GUIDE = `${GITHUB_REPO}/blob/main/deploy/ubuntu/README.md`",
  },
  {
    name: "Docker Compose source filename",
    from: "${SERVER_RELEASE.tag}/deploy/compose/docker-compose.ghcr.yml",
    to: "${SERVER_RELEASE.tag}/deploy/compose/docker-compose.yml",
  },
  {
    name: "environment example source filename",
    from: "${SERVER_RELEASE.tag}/deploy/compose/.env.example",
    to: "${SERVER_RELEASE.tag}/deploy/compose/.env",
  },
  {
    name: "server checksum channel",
    from: "serverChecksums: releaseAsset(SERVER_RELEASE, 'SHA256SUMS')",
    to: "serverChecksums: releaseAsset(DESKTOP_RELEASE, 'SHA256SUMS')",
  },
  {
    name: "canonical repository owner",
    from: "export const GITHUB_REPO = 'https://github.com/Tgk-30/YAWF-Stream';",
    to: "export const GITHUB_REPO = 'https://github.com/Tgk30/YAWF-Stream';",
  },
  {
    name: "tag-qualified release asset boundary",
    from: "return `${GITHUB_RELEASES}/download/${release.tag}/${filename}`;",
    to: "return `${GITHUB_RELEASES}/latest/download/${filename}`;",
  },
]) {
  test(`website release catalog rejects a mutated ${name}`, () => {
    assert.ok(source.includes(from), `fixture must contain ${name} mutation target`);
    const mutated = source.replace(from, to);
    assert.notEqual(mutated, source, `${name} mutation must change the fixture`);
    assert.ok(validateWebsiteReleaseCatalog(mutated).length > 0);
  });
}
