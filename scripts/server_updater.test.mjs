import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

function candidateFixture(version = releaseVersion) {
  const fixtureManifest = { ...manifest, version, debian: { ...manifest.debian, name: `debridstreamer-server_${version}_all.deb` } };
  const manifestBytes = Buffer.from(JSON.stringify(fixtureManifest));
  const sums = Buffer.from(`${sha256(manifestBytes)}  server-update.json\n${fixtureManifest.debian.sha256}  ${fixtureManifest.debian.name}\n`);
  const tag = `v${version}`;
  const asset = (name, bytes) => ({ name, size: name === fixtureManifest.debian.name ? fixtureManifest.debian.size : bytes.length,
    digest: `sha256:${name === fixtureManifest.debian.name ? fixtureManifest.debian.sha256 : sha256(bytes)}`,
    browser_download_url: `https://github.com/Tgk-30/YAWF-Stream/releases/download/${tag}/${name}` });
  const release = { tag_name: tag, draft: false, prerelease: false, published_at: "2026-10-12T00:00:00Z",
    assets: [asset("server-update.json", manifestBytes), asset(fixtureManifest.debian.name, Buffer.alloc(0)), asset("SHA256SUMS", sums)] };
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

test("installer and wrapper use an isolated validated Node runtime without replacing the system executable", () => {
  const installer = readFileSync(new URL("../deploy/updater/install.sh", import.meta.url), "utf8");
  const wrapper = readFileSync(new URL("../deploy/updater/yawf-server-update", import.meta.url), "utf8");
  assert.match(installer, /private_node="?\$runtime_directory\/node"?/);
  assert.match(installer, /assert_secure_node_file "\$node_runtime" true/);
  assert.match(installer, /probe_node_24 "\$runtime_source"/);
  assert.match(installer, /source_hash_before/);
  assert.match(installer, /source_hash_after/);
  assert.match(installer, /destination_hash/);
  assert.match(installer, /mv -fT/);
  assert.match(installer, /Private Node runtime reused/);
  assert.match(installer, /install_private=false/);
  assert.match(installer, /elif \[\[ "\$install_private" == true \]\]/);
  assert.match(installer, /System Node runtime validated: \/usr\/bin\/node/);
  assert.doesNotMatch(installer, /(?:install|mv|ln)[^\n]*\/usr\/bin\/node/);
  assert.match(wrapper, /if \[ -e "\$private_node" \] \|\| \[ -L "\$private_node" \]/);
  assert.match(wrapper, /validate_private_node "\$private_node"/);
  assert.match(wrapper, /node=\/usr\/bin\/node/);
  assert.match(wrapper, /exec "\$node" \/usr\/lib\/yawf-server-updater\/yawf-server-update\.mjs/);
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

// Eleven full catalog pages exist, but only the fixed first ten may be read.
function boundedWindowFixture(first = candidateFixture(), later = null, failure = null) {
  const outside = candidateFixture("99.0.0");
  const filler = index => ({ tag_name: `not-a-release-${index}` });
  const catalog = Array.from({ length: 11 }, (_, page) => Array.from({ length: 20 }, (_, index) => filler(page * 20 + index)));
  catalog[0][0] = first.release;
  if (later != null) catalog[9][19] = later.release;
  catalog[10][0] = outside.release;
  const pages = [], assets = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.github.com") {
      const page = Number(parsed.searchParams.get("page")); pages.push(page);
      assert.ok(page <= 10, "never expand the fixed release window");
      if (page === 2 && failure === "malformed-page") return new Response("{");
      if (page === 2 && failure === "http-page") return new Response("failure", { status: 503 });
      if (page === 2 && failure === "timeout-page") throw new DOMException("fixture deadline", "TimeoutError");
      if (page === 2 && failure === "oversized-page") return new Response("x".repeat(RELEASE_PAGE_MAX_BYTES + 1));
      const value = catalog[page - 1];
      if (failure === "aggregate-pages") for (const entry of value) entry.padding = "x".repeat(45_000);
      return new Response(JSON.stringify(value));
    }
    assets.push(parsed.href);
    const selected = later != null && parsed.pathname.includes(`/v${later.release.tag_name.slice(1)}/`) ? later : first;
    if (failure === "manifest-digest" && parsed.pathname.endsWith("server-update.json")) return new Response("{}");
    return selected.assetResponse(url);
  };
  return { fetchImpl, pages, assets };
}

test("a full bounded window admits a validated first-page newer candidate from a catalog over 200 releases", async () => {
  const fixture = boundedWindowFixture();
  assert.equal((await resolveUpdateCandidate(previousVersion, fixture.fetchImpl)).version, releaseVersion);
  assert.deepEqual(fixture.pages, [1,2,3,4,5,6,7,8,9,10]);
  assert.equal(fixture.assets.length, 2);
});

test("a full bounded window scans every page before choosing a higher last-page candidate", async () => {
  const higher = candidateFixture("9.8.7");
  const fixture = boundedWindowFixture(candidateFixture(), higher);
  assert.equal((await resolveUpdateCandidate(previousVersion, fixture.fetchImpl)).version, "9.8.7");
  assert.deepEqual(fixture.pages, [1,2,3,4,5,6,7,8,9,10]);
  assert.ok(fixture.assets.every(url => url.includes("/v9.8.7/")), "validate only the highest eligible release, never a lower fallback");
});

for (const failure of ["manifest-digest", "malformed-page", "http-page", "timeout-page", "oversized-page", "aggregate-pages"]) {
  test(`an earlier newer candidate cannot bypass a later ${failure} failure`, async () => {
    const fixture = boundedWindowFixture(candidateFixture(), null, failure);
    await assert.rejects(resolveUpdateCandidate(previousVersion, fixture.fetchImpl), /digest|JSON|property|request failed|deadline|size limit/);
  });
}

test("an invalid highest manifest refuses instead of installing a valid lower release", async () => {
  const lower = candidateFixture("2.3.104");
  const higher = candidateFixture("2.3.105");
  const bad = Buffer.from(JSON.stringify({ ...JSON.parse(higher.manifestBytes.toString("utf8")), command: "sh" }));
  higher.release.assets.find(asset => asset.name === "server-update.json").digest = `sha256:${sha256(bad)}`;
  const sums = Buffer.from(`${sha256(bad)}  server-update.json\n${manifest.debian.sha256}  debridstreamer-server_2.3.105_all.deb\n`);
  higher.release.assets.find(asset => asset.name === "SHA256SUMS").digest = `sha256:${sha256(sums)}`;
  higher.assetResponse = url => String(url).endsWith("server-update.json") ? new Response(bad) : new Response(sums);
  const fixture = boundedWindowFixture(lower, higher);
  await assert.rejects(resolveUpdateCandidate("2.3.103", fixture.fetchImpl), /manifest|schema|keys|Invalid/);
  assert.equal(fixture.assets.length, 1);
  assert.ok(fixture.assets[0].includes("/v2.3.105/"));
});

for (const current of [releaseVersion, "99.0.0"]) {
  test(`an incomplete window with only equal or older releases fails for installed ${current}`, async () => {
    const fixture = boundedWindowFixture();
    await assert.rejects(resolveUpdateCandidate(current, fixture.fetchImpl), /page limit|bounded/);
    assert.equal(fixture.pages.length, 10);
    assert.equal(fixture.assets.length, 0);
  });
}

test("complete short history with no newer eligible release may report up to date", async () => {
  const fixture = candidateFixture();
  assert.equal(await resolveUpdateCandidate(releaseVersion, async () => new Response(JSON.stringify([fixture.release]))), null);
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


function activeStreamGuardScript() {
  const source = readFileSync(new URL("../deploy/updater/yawf-server-update.mjs", import.meta.url), "utf8");
  const match = /async function activeStreams\(id\) \{[\s\S]*?const script = ("(?:[^"\\]|\\.)*");/.exec(source);
  assert.ok(match, "The actual installed activity query must be testable");
  return JSON.parse(match[1]);
}

function streamGuardFixture(t, rows) {
  const directory = mkdtempSync(join(tmpdir(), "yawf-updater-grants-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "fixture.sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE stream_sessions(id TEXT, created_at TEXT, expires_at TEXT, revoked_at TEXT, completed_at TEXT)");
    const insert = db.prepare("INSERT INTO stream_sessions VALUES(?,?,?,?,?)");
    for (const [index, row] of rows.entries()) insert.run(String(index), row.created, row.expires, row.revoked, row.completed);
  } finally { db.close(); }
  return file;
}

function validStreamGrant(overrides = {}) {
  const created = Date.now() - 120_000;
  return { created: new Date(created).toISOString(), expires: new Date(created + 6 * 60 * 60 * 1000).toISOString(),
    revoked: null, completed: new Date(created + 51).toISOString(), ...overrides };
}

function actualActiveGrantCount(file) {
  const script = activeStreamGuardScript();
  const databaseLiteral = "'/data/debridstreamer.sqlite'";
  assert.equal(script.split(databaseLiteral).length, 2, "Only the fixture input path may be replaced");
  const actual = script.replace(databaseLiteral, JSON.stringify(file));
  const result = spawnSync(process.execPath, ["-e", actual], { encoding: "utf8", env: {}, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\d+$/);
  return Number(result.stdout);
}

test("active stream guard counts a future HTTP-completed HLS grant", (t) => {
  const file = streamGuardFixture(t, [validStreamGrant()]);
  assert.equal(actualActiveGrantCount(file), 1);
});
test("active stream guard retains a future unfinished HTTP transfer", (t) => {
  const file = streamGuardFixture(t, [validStreamGrant({ completed: null })]);
  assert.equal(actualActiveGrantCount(file), 1);
});
test("active stream guard excludes revoked grants", (t) => {
  const file = streamGuardFixture(t, [validStreamGrant({ revoked: new Date().toISOString() })]);
  assert.equal(actualActiveGrantCount(file), 0);
});
test("active stream guard excludes expired grants", (t) => {
  const file = streamGuardFixture(t, [validStreamGrant({ expires: new Date(Date.now() - 60_000).toISOString() })]);
  assert.equal(actualActiveGrantCount(file), 0);
});
test("active stream guard counts completed and unfinished valid grants together", (t) => {
  const file = streamGuardFixture(t, [validStreamGrant(), validStreamGrant({ completed: null }),
    validStreamGrant({ revoked: new Date().toISOString() }), validStreamGrant({ expires: new Date(Date.now() - 60_000).toISOString() })]);
  assert.equal(actualActiveGrantCount(file), 2);
});
test("active stream guard recheck detects a completed transfer created during pull", (t) => {
  const file = streamGuardFixture(t, []);
  assert.equal(actualActiveGrantCount(file), 0);
  const db = new DatabaseSync(file), row = validStreamGrant();
  try { db.prepare("INSERT INTO stream_sessions VALUES(?,?,?,?,?)").run("during-pull", row.created, row.expires, row.revoked, row.completed); }
  finally { db.close(); }
  assert.equal(actualActiveGrantCount(file), 1);
});
test("active stream guard reads without changing transfer completion or expiry", (t) => {
  const row = validStreamGrant(), file = streamGuardFixture(t, [row]);
  assert.equal(actualActiveGrantCount(file), 1);
  const db = new DatabaseSync(file, { readOnly: true });
  try { assert.deepEqual({ ...db.prepare("SELECT expires_at, completed_at FROM stream_sessions").get() }, { expires_at: row.expires, completed_at: row.completed }); }
  finally { db.close(); }
});

test("active stream guard keeps HTTP completion immutable independently of the count", (t) => {
  const row = validStreamGrant(), file = streamGuardFixture(t, [row]);
  actualActiveGrantCount(file);
  const db = new DatabaseSync(file, { readOnly: true });
  try { assert.deepEqual({ ...db.prepare("SELECT expires_at, completed_at FROM stream_sessions").get() }, { expires_at: row.expires, completed_at: row.completed }); }
  finally { db.close(); }
});
