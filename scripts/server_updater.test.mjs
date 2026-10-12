import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { assertProtectedRootPath, parseUpdateManifest, resolveUpdateCandidate, selectManifestReleases, writePublicStatusForTest } from "../deploy/updater/yawf-server-update.mjs";
import { copyTree } from "../deploy/updater/volume-copy.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const releaseVersion = JSON.parse(readFileSync(new URL("../server/package.json", import.meta.url), "utf8")).version;
const [releaseMajor, releaseMinor, releasePatch] = releaseVersion.split(".").map(Number);
const previousVersion = `${releaseMajor}.${releaseMinor}.${releasePatch - 1}`;
const manifest = {
  schemaVersion: 1, version: releaseVersion, sourceRevision: "b".repeat(40),
  image: { repository: "ghcr.io/tgk-30/yawf-stream", digest },
  debian: { name: `debridstreamer-server_${releaseVersion}_all.deb`, sha256: "c".repeat(64), size: 123 },
};

test("manifest schema is exact and pins every privileged artifact", () => {
  assert.deepEqual(parseUpdateManifest(manifest, releaseVersion), manifest);
  for (const mutation of [
    { ...manifest, version: previousVersion },
    { ...manifest, image: { ...manifest.image, repository: "evil.invalid/image" } },
    { ...manifest, image: { ...manifest.image, digest: "latest" } },
    { ...manifest, command: "sh" },
    { ...manifest, debian: { ...manifest.debian, name: "other.deb" } },
  ]) assert.throws(() => parseUpdateManifest(mutation, releaseVersion));
});

test("only published strict releases with all exact assets are updater candidates", () => {
  const make = (tag, extra = {}) => ({
    tag_name: tag, draft: false, prerelease: false, published_at: "2026-10-12T00:00:00Z",
    assets: ["server-update.json", `debridstreamer-server_${tag.replace(/^v/, "").replace(/-web$/, "")}_all.deb`, "SHA256SUMS"].map((name) => ({
      name, digest, size: 10, browser_download_url: `https://github.com/Tgk-30/YAWF-Stream/releases/download/${tag}/${name}`,
    })), ...extra,
  });
  const selected = selectManifestReleases([make(`v${previousVersion}`), make(`v${releaseVersion}-web`), make("v9.0.0", { prerelease: true })]);
  assert.deepEqual(selected.map((item) => item.version), [releaseVersion, previousVersion]);
});

test("candidate resolution requires GitHub digests and exact checksum lines", async () => {
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const sums = Buffer.from(`${hash(manifestBytes)}  server-update.json\n${manifest.debian.sha256}  ${manifest.debian.name}\n`);
  const tag = `v${releaseVersion}`;
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
  assert.equal((await resolveUpdateCandidate(previousVersion, fetchImpl)).version, releaseVersion);
  const badFetch = async (url) => String(url).endsWith("SHA256SUMS") ? new Response("bad\n") : fetchImpl(url);
  await assert.rejects(resolveUpdateCandidate("2.3.8", badFetch), /digest|SHA256SUMS/);
});

test("volume copier streams protected files with exact numeric metadata and rejects unsafe trees", () => {
  const root = mkdtempSync(join(tmpdir(), "yawf-updater-copy-"));
  const source = join(root, "source"); const backup = join(root, "backup");
  const multiChunk = Buffer.alloc((64 * 1024 * 3) + 17, 0x5a);
  mkdirSync(source); writeFileSync(join(source, "protected"), multiChunk); chmodSync(join(source, "protected"), 0o400);
  writeFileSync(join(source, "private"), "account-settings"); chmodSync(join(source, "private"), 0o600);
  mkdirSync(backup); writeFileSync(join(backup, "stale"), "remove-me");
  copyTree(source, backup);
  assert.deepEqual(readFileSync(join(backup, "protected")), multiChunk);
  assert.equal(readFileSync(join(backup, "private"), "utf8"), "account-settings");
  for (const [name, mode] of [["protected", 0o400], ["private", 0o600]]) {
    const before = lstatSync(join(source, name)); const after = lstatSync(join(backup, name));
    assert.deepEqual({ uid: after.uid, gid: after.gid, mode: after.mode & 0o7777 }, { uid: before.uid, gid: before.gid, mode });
  }
  assert.throws(() => lstatSync(join(backup, "stale")));
  symlinkSync("private", join(source, "link"));
  assert.throws(() => copyTree(source, backup), /symlinks/);
  assert.equal(readFileSync(join(backup, "private"), "utf8"), "account-settings", "invalid source cleared the last valid snapshot");
  unlinkSync(join(source, "link"));

  const sourceLink = join(root, "source-link"); symlinkSync(source, sourceLink);
  assert.throws(() => copyTree(sourceLink, join(root, "source-link-backup")), /Snapshot root/);
  const destinationLink = join(root, "backup-link"); symlinkSync(backup, destinationLink);
  assert.throws(() => copyTree(source, destinationLink), /destination root/);

  const result = spawnSync(process.execPath, ["deploy/updater/volume-copy.mjs", "copy", source, backup], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Invalid volume copy invocation/);
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

test("public status stays readable under UMask 0077 while private state stays restrictive", () => {
  const stateRoot = "/var/lib/yawf-server-updater";
  const publicDir = `${stateRoot}/public`;
  const statusPath = `${publicDir}/status.json`;
  const entries = new Map([
    ["/", { type: "directory", uid: 0, mode: 0o755 }],
    ["/var", { type: "directory", uid: 0, mode: 0o755 }],
    ["/var/lib", { type: "directory", uid: 0, mode: 0o755 }],
    [stateRoot, { type: "directory", uid: 0, mode: 0o700 }],
  ]);
  const handles = new Map(); const events = []; let nextFd = 20;
  const stat = (entry) => ({ uid: entry.uid, mode: entry.mode,
    isFile: () => entry.type === "file", isDirectory: () => entry.type === "directory", isSymbolicLink: () => entry.type === "symlink" });
  const fsOps = {
    existsSync: (path) => entries.has(path),
    realpathSync: (path) => path,
    lstatSync: (path) => { const entry = entries.get(path); if (entry == null) throw new Error(`missing ${path}`); return stat(entry); },
    mkdirSync: (path, options) => {
      if (!entries.has(path)) { entries.set(path, { type: "directory", uid: 0, mode: options.mode & ~0o077 }); events.push(`mkdir:${path}`); }
    },
    openSync: (path, flags, mode) => {
      if (!entries.has(path)) entries.set(path, { type: "file", uid: 0, mode: mode & ~0o077, text: "" });
      const fd = nextFd++; handles.set(fd, path); events.push(`open:${path}`); return fd;
    },
    fstatSync: (fd) => stat(entries.get(handles.get(fd))),
    fchmodSync: (fd, mode) => { const path = handles.get(fd); entries.get(path).mode = mode; events.push(`chmod:${path}:${mode.toString(8)}`); },
    writeFileSync: (fd, text) => { entries.get(handles.get(fd)).text = text; },
    closeSync: (fd) => handles.delete(fd),
    renameSync: (source, destination) => { const entry = entries.get(source); entries.delete(source); entries.set(destination, entry); events.push(`rename:${destination}`); },
    unlinkSync: (path) => entries.delete(path),
  };
  writePublicStatusForTest(fsOps);
  assert.equal(entries.get(publicDir).mode, 0o755, "public status directory inherited UMask 0077");
  assert.equal(entries.get(statusPath).mode, 0o644, "public status file inherited UMask 0077");
  assert.ok(events.indexOf(`chmod:${statusPath}.tmp-${process.pid}:644`) < events.indexOf(`rename:${statusPath}`),
    "status descriptor was not chmodded before its atomic rename");
  assert.equal(JSON.parse(entries.get(statusPath).text).state, "disabled");

  const service = readFileSync(new URL("../deploy/updater/yawf-server-update.service", import.meta.url), "utf8");
  const installer = readFileSync(new URL("../deploy/updater/install.sh", import.meta.url), "utf8");
  const helper = readFileSync(new URL("../deploy/updater/yawf-server-update.mjs", import.meta.url), "utf8");
  assert.match(service, /^UMask=0077$/m);
  assert.match(installer, /install -m 0644 "\$root\/yawf-server-update\.service" \/etc\/systemd\/system\/yawf-server-update\.service/);
  assert.match(helper, /const mode = path === PATHS\.status \? 0o644 : 0o600/);
  assert.match(helper, /mkdirSync\(backup, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(helper, /mkdirSync\(PATHS\.root, \{ recursive: true, mode: 0o700 \}\)/);
});
