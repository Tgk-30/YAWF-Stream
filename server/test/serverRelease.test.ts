import { describe, expect, it } from "vitest";
import { selectServerRelease, serverReleaseStatus } from "../src/serverRelease.js";

const digest = `sha256:${"a".repeat(64)}`;
function release(tag: string, names: string[], extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag, html_url: `https://github.com/Tgk-30/YAWF-Stream/releases/tag/${tag}`,
    draft: false, prerelease: false, published_at: "2026-10-12T00:00:00Z",
    assets: names.map((name) => ({ name, digest, size: 10, browser_download_url: `https://github.com/Tgk-30/YAWF-Stream/releases/download/${tag}/${name}` })),
    ...extra,
  };
}

describe("server release selection", () => {
  it("chooses the greatest actual server release instead of the desktop latest release", () => {
    const selected = selectServerRelease([
      release("v2.3.6-web", ["YAWF-Stream.dmg", "SHA256SUMS"]),
      release("v2.3.8", ["debridstreamer-server_2.3.8_all.deb", "SHA256SUMS"]),
      release("android-v9.0.0", ["app.apk", "SHA256SUMS"]),
      release("v2.3.10-web", ["debridstreamer-server_2.3.10_all.deb", "SHA256SUMS", "server-update.json"]),
    ]);
    expect(selected).toMatchObject({ version: "2.3.10", tag: "v2.3.10-web" });
    expect(serverReleaseStatus("2.3.9", selected).available).toBe(true);
  });

  it("rejects drafts, prereleases, malformed digests, and missing exact assets", () => {
    expect(selectServerRelease([
      release("v3.0.0", ["debridstreamer-server_3.0.0_all.deb", "SHA256SUMS"], { draft: true }),
      release("v2.9.0", ["debridstreamer-server_latest_all.deb", "SHA256SUMS"]),
      { ...release("v2.8.0", ["debridstreamer-server_2.8.0_all.deb", "SHA256SUMS"]), assets: [{ name: "SHA256SUMS", digest: "sha256:no", size: 1, browser_download_url: "https://example.com" }] },
    ])).toBeNull();
  });
});
