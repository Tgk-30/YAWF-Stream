import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { RELEASE_DISCOVERY_MAX_BYTES, RELEASE_DISCOVERY_TIMEOUT_MS, RELEASE_PAGE_LIMIT, RELEASE_PAGE_MAX_BYTES, RELEASE_REQUEST_TIMEOUT_MS, RELEASES_PER_PAGE, assertProtectedRootPath, parseUpdateManifest,
  resolveUpdateCandidate, selectManifestReleases, writePublicStatusForTest } from "../deploy/updater/yawf-server-update.mjs";
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
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function candidateFixture() {
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const sums = Buffer.from(`${sha256(manifestBytes)}  server-update.json\n${manifest.debian.sha256}  ${manifest.debian.name}\n`);
  const tag = `v${releaseVersion}`;
  const asset = (name, bytes) => ({ name, size: name === manifest.debian.name ? manifest.debian.size : bytes.length,
    digest: `sha256:${name === manifest.debian.name ? manifest.debian.sha256 : sha256(bytes)}`,
    browser_download_url: `https://github.com/Tgk-30/YAWF-Stream/releases/download/${tag}/${name}` });
  const release = { tag_name: tag, draft: false, prerelease: false, published_at: "2026-10-12T00:00:00Z",
    assets: [asset("server-update.json", manifestBytes), asset(manifest.debian.name, Buffer.alloc(0)), asset("SHA256SUMS", sums)] };
  const assetResponse = (url) => new Response(String(url).endsWith("server-update.json") ? manifestBytes : sums,
    { status: 200, headers: { "content-length": String(String(url).endsWith("server-update.json") ? manifestBytes.length : sums.length) } });
  return { manifestBytes, release, sums, assetResponse };
}

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
  const fixture = candidateFixture();
  const releases = Buffer.from(JSON.stringify([fixture.release]));
  const fetchImpl = async (url) => {
    const value = String(url);
    if (!value.includes("api.github.com")) return fixture.assetResponse(url);
    return new Response(releases, { status: 200, headers: { "content-length": String(releases.length) } });
  };
  assert.equal((await resolveUpdateCandidate(previousVersion, fetchImpl)).version, releaseVersion);
  const badFetch = async (url) => String(url).endsWith("SHA256SUMS") ? new Response("bad\n") : fetchImpl(url);
  await assert.rejects(resolveUpdateCandidate("2.3.8", badFetch), /digest|SHA256SUMS/);
});

test("release discovery budgets remain fixed independently of pagination fixtures", () => {
  assert.deepEqual({ perPage: RELEASES_PER_PAGE, pages: RELEASE_PAGE_LIMIT, pageBytes: RELEASE_PAGE_MAX_BYTES,
    aggregateBytes: RELEASE_DISCOVERY_MAX_BYTES, requestTimeoutMs: RELEASE_REQUEST_TIMEOUT_MS,
    discoveryTimeoutMs: RELEASE_DISCOVERY_TIMEOUT_MS },
  { perPage: 20, pages: 10, pageBytes: 1_000_000, aggregateBytes: 8_000_000, requestTimeoutMs: 10_000,
    discoveryTimeoutMs: 15_000 });
});

test("release discovery scans bounded pages and selects the greatest eligible numeric version", async () => {
  const fixture = candidateFixture();
  const filler = (page, index) => ({ tag_name: `not-a-release-${page}-${index}`, draft: false, prerelease: false,
    published_at: "2026-10-12T00:00:00Z", assets: [], padding: "x".repeat(40_000) });
  const olderTag = `v${previousVersion}`;
  const older = { tag_name: olderTag, draft: false, prerelease: false, published_at: "2026-10-11T00:00:00Z",
    assets: ["server-update.json", `debridstreamer-server_${previousVersion}_all.deb`, "SHA256SUMS"].map((name) => ({
      name, digest, size: 10, browser_download_url: `https://github.com/Tgk-30/YAWF-Stream/releases/download/${olderTag}/${name}`,
    })) };
  const pages = [
    [older, ...Array.from({ length: 19 }, (_, index) => filler(1, index))],
    Array.from({ length: 20 }, (_, index) => filler(2, index)),
    Array.from({ length: 20 }, (_, index) => filler(3, index)),
    [fixture.release],
  ].map((page) => Buffer.from(JSON.stringify(page)));
  assert.ok(pages.slice(0, 3).every((page) => page.length < RELEASE_PAGE_MAX_BYTES));
  const aggregateBytes = pages.reduce((total, page) => total + page.length, 0);
  assert.ok(aggregateBytes > 2_000_000 && aggregateBytes < 8_000_000);
  const requestedPages = []; const discoverySignals = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname !== "api.github.com") return fixture.assetResponse(url);
    const page = Number(parsed.searchParams.get("page")); requestedPages.push(page); discoverySignals.push(init.signal);
    const bytes = pages[page - 1] ?? Buffer.from("[]");
    return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
  };
  const candidate = await resolveUpdateCandidate("0.0.0", fetchImpl);
  assert.equal(candidate?.version, releaseVersion);
  assert.deepEqual(requestedPages, [1, 2, 3, 4]);
  assert.ok(discoverySignals.every((signal) => signal === discoverySignals[0]), "release pages reset the whole-discovery deadline");
});

test("release discovery stops on short or empty pages and fails closed at its page limit", async () => {
  const fullPage = Buffer.from(JSON.stringify(Array.from({ length: 20 }, (_, index) => ({ tag_name: `invalid-${index}` }))));
  for (const ending of [[Buffer.from("[]")], [Buffer.from("[]"), Buffer.from("[]")]]) {
    let calls = 0;
    const fetchImpl = async () => {
      const bytes = ending.length === 1 ? ending[0] : calls === 0 ? fullPage : ending[1];
      calls += 1;
      return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
    };
    assert.equal(await resolveUpdateCandidate("0.0.0", fetchImpl), null);
    assert.equal(calls, ending.length === 1 ? 1 : 2);
  }

  const pages = [];
  const loopingFetch = async (url) => {
    pages.push(Number(new URL(url).searchParams.get("page")));
    return new Response(fullPage, { status: 200, headers: { "content-length": String(fullPage.length) } });
  };
  await assert.rejects(resolveUpdateCandidate("0.0.0", loopingFetch), /page limit/);
  assert.deepEqual(pages, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  const largeFullPage = Buffer.from(JSON.stringify(Array.from({ length: 20 }, (_, index) => ({
    tag_name: `large-invalid-${index}`, padding: "x".repeat(45_000),
  }))));
  assert.ok(largeFullPage.length < RELEASE_PAGE_MAX_BYTES);
  let largeCalls = 0;
  const largeFetch = async () => { largeCalls += 1; return new Response(largeFullPage, { status: 200 }); };
  await assert.rejects(resolveUpdateCandidate("0.0.0", largeFetch), /aggregate size limit/);
  assert.ok(largeCalls < 10);
});

test("release discovery cancels an oversized individual response", async () => {
  let cancelled = false; let sent = false;
  const response = { status: 200, ok: true, headers: { get: () => null }, body: { getReader: () => ({
    read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: new Uint8Array(1_000_001) }; },
    cancel: async () => { cancelled = true; },
    releaseLock: () => {},
  }) } };
  await assert.rejects(resolveUpdateCandidate("0.0.0", async () => response), /size limit/);
  assert.equal(cancelled, true);
});

test("release discovery ignores external pagination links", async () => {
  const fullPage = Buffer.from(JSON.stringify(Array.from({ length: 20 }, (_, index) => ({ tag_name: `invalid-link-${index}` }))));
  const requested = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url); requested.push(parsed.href);
    const bytes = requested.length === 1 ? fullPage : Buffer.from("[]");
    return new Response(bytes, { status: 200, headers: { link: '<https://evil.invalid/releases?page=2>; rel="next"' } });
  };
  assert.equal(await resolveUpdateCandidate("0.0.0", fetchImpl), null);
  assert.deepEqual(requested.map((url) => new URL(url).hostname), ["api.github.com", "api.github.com"]);
  assert.deepEqual(requested.map((url) => new URL(url).searchParams.get("page")), ["1", "2"]);
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
