import assert from "node:assert/strict";
import test from "node:test";
import { readWebsiteReleaseCatalog, validateWebsiteReleaseCatalog } from "./check_website_release_catalog.mjs";

const source = readWebsiteReleaseCatalog();

test("website release catalog accepts the published platform channels", () => {
  assert.deepEqual(validateWebsiteReleaseCatalog(source), []);
});

for (const { name, from, to } of [
  {
    name: "desktop version",
    from: "export const DESKTOP_RELEASE: PublishedRelease = { version: '2.3.28', tag: 'v2.3.28-web' };",
    to: "export const DESKTOP_RELEASE: PublishedRelease = { version: '2.3.25', tag: 'v2.3.28-web' };",
  },
  {
    name: "Android phone tag",
    from: "export const ANDROID_PHONE_RELEASE: PublishedRelease = { version: '2.3.27', tag: 'android-v2.3.27' };",
    to: "export const ANDROID_PHONE_RELEASE: PublishedRelease = { version: '2.3.20', tag: 'v2.3.13' };",
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
    from: "export const SERVER_RELEASE: PublishedRelease = { version: '2.3.36', tag: 'v2.3.36' };",
    to: "export const SERVER_RELEASE: PublishedRelease = { version: '2.3.22', tag: 'v2.3.36' };",
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
    assert.ok(validateWebsiteReleaseCatalog(source.replace(from, to)).length > 0);
  });
}
