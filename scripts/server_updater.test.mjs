import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { assertProtectedRootPath, parseUpdateManifest, resolveUpdateCandidate, selectManifestReleases } from "../deploy/updater/yawf-server-update.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const manifest = {
  schemaVersion: 1, version: "2.3.9", sourceRevision: "b".repeat(40),
  image: { repository: "ghcr.io/tgk-30/yawf-stream", digest },
  debian: { name: "debridstreamer-server_2.3.9_all.deb", sha256: "c".repeat(64), size: 123 },
};

test("manifest schema is exact and pins every privileged artifact", () => {
  assert.deepEqual(parseUpdateManifest(manifest, "2.3.9"), manifest);
  for (const mutation of [
    { ...manifest, version: "2.3.10" },
    { ...manifest, image: { ...manifest.image, repository: "evil.invalid/image" } },
    { ...manifest, image: { ...manifest.image, digest: "latest" } },
    { ...manifest, command: "sh" },
    { ...manifest, debian: { ...manifest.debian, name: "other.deb" } },
  ]) assert.throws(() => parseUpdateManifest(mutation, "2.3.9"));
});

test("only published strict releases with all exact assets are updater candidates", () => {
  const make = (tag, extra = {}) => ({
    tag_name: tag, draft: false, prerelease: false, published_at: "2026-10-12T00:00:00Z",
    assets: ["server-update.json", `debridstreamer-server_${tag.replace(/^v/, "").replace(/-web$/, "")}_all.deb`, "SHA256SUMS"].map((name) => ({
      name, digest, size: 10, browser_download_url: `https://github.com/Tgk-30/YAWF-Stream/releases/download/${tag}/${name}`,
    })), ...extra,
  });
  const selected = selectManifestReleases([make("v2.3.9"), make("v2.3.10-web"), make("v9.0.0", { prerelease: true })]);
  assert.deepEqual(selected.map((item) => item.version), ["2.3.10", "2.3.9"]);
});

test("candidate resolution requires GitHub digests and exact checksum lines", async () => {
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const sums = Buffer.from(`${hash(manifestBytes)}  server-update.json\n${manifest.debian.sha256}  ${manifest.debian.name}\n`);
  const tag = "v2.3.9";
  const asset = (name, bytes) => ({ name, size: name === manifest.debian.name ? manifest.debian.size : bytes.length,
    digest: `sha256:${name === manifest.debian.name ? manifest.debian.sha256 : hash(bytes)}`,
    browser_download_url: `https://github.com/Tgk-30/YAWF-Stream/releases/download/${tag}/${name}` });
  const releases = Buffer.from(JSON.stringify([{ tag_name: tag, draft: false, prerelease: false, published_at: "2026-10-12T00:00:00Z",
    assets: [asset("server-update.json", manifestBytes), asset(manifest.debian.name, Buffer.alloc(0)), asset("SHA256SUMS", sums)] }]));
  const fetchImpl = async (url) => {
    const value = String(url);
    const bytes = value.includes("api.github.com") ? releases : value.endsWith("server-update.json") ? manifestBytes : sums;
    return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
  };
  assert.equal((await resolveUpdateCandidate("2.3.8", fetchImpl)).version, "2.3.9");
  const badFetch = async (url) => String(url).endsWith("SHA256SUMS") ? new Response("bad\n") : fetchImpl(url);
  await assert.rejects(resolveUpdateCandidate("2.3.8", badFetch), /digest|SHA256SUMS/);
});

test("volume copier preserves regular files and rejects symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "yawf-updater-copy-"));
  const source = join(root, "source"); const backup = join(root, "backup");
  mkdirSync(source); writeFileSync(join(source, "database"), "account-settings");
  let result = spawnSync(process.execPath, ["deploy/updater/volume-copy.mjs", "copy", source, backup], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(join(backup, "database"), "utf8"), "account-settings");
  symlinkSync("database", join(source, "link"));
  result = spawnSync(process.execPath, ["deploy/updater/volume-copy.mjs", "copy", source, backup], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /symlinks/);
});

test("Compose registration requires a canonical root-protected ancestor chain", () => {
  const entries = new Map([
    ["/", { type: "directory", uid: 0, mode: 0o755 }],
    ["/srv", { type: "directory", uid: 0, mode: 0o755 }],
    ["/srv/yawf", { type: "directory", uid: 0, mode: 0o700 }],
    ["/srv/yawf/compose.yml", { type: "file", uid: 0, mode: 0o600 }],
  ]);
  const fsOps = {
    realpathSync: (path) => path,
    lstatSync: (path) => {
      const value = entries.get(path); if (value == null) throw new Error(`missing ${path}`);
      return { uid: value.uid, mode: value.mode, isFile: () => value.type === "file", isDirectory: () => value.type === "directory", isSymbolicLink: () => value.type === "symlink" };
    },
  };
  assert.doesNotThrow(() => assertProtectedRootPath("/srv/yawf/compose.yml", "file", fsOps));
  entries.set("/srv", { type: "directory", uid: 1000, mode: 0o755 });
  assert.throws(() => assertProtectedRootPath("/srv/yawf/compose.yml", "file", fsOps), /root-owned/);
  entries.set("/srv", { type: "directory", uid: 0, mode: 0o777 });
  assert.throws(() => assertProtectedRootPath("/srv/yawf/compose.yml", "file", fsOps), /root-owned/);
  entries.set("/srv", { type: "symlink", uid: 0, mode: 0o755 });
  assert.throws(() => assertProtectedRootPath("/srv/yawf/compose.yml", "file", fsOps), /root-owned/);
  entries.set("/srv", { type: "directory", uid: 0, mode: 0o755 });
  fsOps.realpathSync = (path) => path === "/srv/yawf/compose.yml" ? "/private/compose.yml" : path;
  assert.throws(() => assertProtectedRootPath("/srv/yawf/compose.yml", "file", fsOps), /symlinks/);
});
