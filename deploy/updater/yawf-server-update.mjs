#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants, closeSync, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

export const REPOSITORY = "ghcr.io/tgk-30/yawf-stream";
export const RELEASES_PER_PAGE = 20;
export const RELEASE_PAGE_LIMIT = 10;
export const RELEASE_PAGE_MAX_BYTES = 1_000_000;
export const RELEASE_DISCOVERY_MAX_BYTES = 8_000_000;
export const RELEASES_API = `https://api.github.com/repos/Tgk-30/YAWF-Stream/releases?per_page=${RELEASES_PER_PAGE}&page=1`;
export const RELEASE_REQUEST_TIMEOUT_MS = 10_000;
export const RELEASE_DISCOVERY_TIMEOUT_MS = 15_000;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(-web)?$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const STATE_ROOT = "/var/lib/yawf-server-updater";
const PATHS = Object.freeze({
  policy: "/etc/yawf-server-updater/config.json",
  root: STATE_ROOT,
  publicDir: `${STATE_ROOT}/public`,
  status: `${STATE_ROOT}/public/status.json`,
  override: `${STATE_ROOT}/compose.override.yaml`,
  journal: `${STATE_ROOT}/journal.json`,
  helper: "/usr/lib/yawf-server-updater/volume-copy.mjs",
});
const execFile = promisify(execFileCallback);

function exactKeys(value, expected) {
  return value != null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

export function parseUpdateManifest(input, releaseVersion) {
  if (!exactKeys(input, ["schemaVersion", "version", "sourceRevision", "image", "debian"]) ||
      input.schemaVersion !== 1 || input.version !== releaseVersion || !VERSION.test(input.version) || !SHA.test(input.sourceRevision) ||
      !exactKeys(input.image, ["repository", "digest"]) || input.image.repository !== REPOSITORY || !DIGEST.test(input.image.digest) ||
      !exactKeys(input.debian, ["name", "sha256", "size"]) ||
      input.debian.name !== `debridstreamer-server_${releaseVersion}_all.deb` || !/^[a-f0-9]{64}$/.test(input.debian.sha256) ||
      !Number.isSafeInteger(input.debian.size) || input.debian.size <= 0 || input.debian.size > 1_000_000_000) {
    throw new Error("The server update manifest is invalid.");
  }
  return input;
}

function semverCompare(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

function githubAsset(asset, name, tag) {
  const url = `https://github.com/Tgk-30/YAWF-Stream/releases/download/${tag}/${name}`;
  return asset?.name === name && asset?.browser_download_url === url && DIGEST.test(asset?.digest ?? "") &&
    Number.isSafeInteger(asset?.size) && asset.size > 0 ? asset : null;
}

export function selectManifestReleases(input) {
  if (!Array.isArray(input) || input.length > 100) throw new Error("GitHub returned invalid release metadata.");
  const selected = [];
  for (const release of input) {
    const match = typeof release?.tag_name === "string" ? TAG.exec(release.tag_name) : null;
    if (match == null || release.draft !== false || release.prerelease !== false || typeof release.published_at !== "string" || !Array.isArray(release.assets) || release.assets.length > 100) continue;
    const version = match[1];
    const one = (name) => { const matches = release.assets.filter((item) => item?.name === name); return matches.length === 1 ? githubAsset(matches[0], name, release.tag_name) : null; };
    const manifest = one("server-update.json");
    const debName = `debridstreamer-server_${version}_all.deb`;
    const debian = one(debName);
    const checksums = one("SHA256SUMS");
    if (manifest && debian && checksums) selected.push({ version, tag: release.tag_name, manifest, debian, checksums });
  }
  return selected.sort((a, b) => semverCompare(b.version, a.version) || Number(a.tag.endsWith("-web")) - Number(b.tag.endsWith("-web")));
}

function checksumFor(text, name) {
  const matches = text.split(/\r?\n/).map((line) => /^([a-f0-9]{64}) [ *](\S+)$/.exec(line)).filter((match) => match?.[2] === name);
  if (matches.length !== 1) throw new Error(`SHA256SUMS does not contain one exact ${name} entry.`);
  return matches[0][1];
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function cancelBody(response) {
  try { await response.body?.cancel(); } catch {}
}

async function boundedFetch(url, { fetchImpl = fetch, maxBytes = 2_000_000, signal = AbortSignal.timeout(RELEASE_REQUEST_TIMEOUT_MS) } = {}) {
  let current = new URL(url);
  for (let redirects = 0; redirects < 6; redirects += 1) {
    signal.throwIfAborted();
    if (current.protocol !== "https:" || !["api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(current.hostname)) {
      throw new Error("Update download left the trusted GitHub hosts.");
    }
    const response = await fetchImpl(current, { redirect: "manual", headers: { accept: "application/vnd.github+json", "user-agent": "YAWF-Server-Updater" }, signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location == null) { await cancelBody(response); throw new Error("GitHub returned an invalid redirect."); }
      await cancelBody(response);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) { await cancelBody(response); throw new Error(`GitHub request failed (${response.status}).`); }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) { await cancelBody(response); throw new Error("Update response exceeded its size limit."); }
    if (response.body == null) throw new Error("GitHub returned an empty response.");
    const chunks = []; let total = 0; let complete = false; const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new Error("Update response exceeded its size limit.");
        chunks.push(Buffer.from(value));
      }
      complete = true;
    } finally {
      if (!complete) { try { await reader.cancel(); } catch {} }
      reader.releaseLock();
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, total);
  }
  throw new Error("GitHub returned too many redirects.");
}

async function discoverManifestReleases(fetchImpl) {
  const selected = []; let aggregateBytes = 0;
  const signal = AbortSignal.timeout(RELEASE_DISCOVERY_TIMEOUT_MS);
  for (let page = 1; page <= RELEASE_PAGE_LIMIT; page += 1) {
    const url = new URL(RELEASES_API);
    url.searchParams.set("page", String(page));
    const bytes = await boundedFetch(url, { fetchImpl, maxBytes: RELEASE_PAGE_MAX_BYTES, signal });
    aggregateBytes += bytes.length;
    if (aggregateBytes > RELEASE_DISCOVERY_MAX_BYTES) throw new Error("GitHub release discovery exceeded its aggregate size limit.");
    const releases = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(releases) || releases.length > RELEASES_PER_PAGE) throw new Error("GitHub returned invalid paginated release metadata.");
    selected.push(...selectManifestReleases(releases));
    if (releases.length < RELEASES_PER_PAGE) {
      return selected.sort((a, b) => semverCompare(b.version, a.version) || Number(a.tag.endsWith("-web")) - Number(b.tag.endsWith("-web")));
    }
  }
  throw new Error("GitHub release discovery exceeded its page limit.");
}

export async function resolveUpdateCandidate(currentVersion, fetchImpl = fetch) {
  const releases = await discoverManifestReleases(fetchImpl);
  for (const release of releases) {
    if (semverCompare(release.version, currentVersion) <= 0) continue;
    const bytes = await boundedFetch(release.manifest.browser_download_url, { fetchImpl, maxBytes: 64 * 1024 });
    if (`sha256:${sha256(bytes)}` !== release.manifest.digest) throw new Error("The server update manifest digest did not match GitHub metadata.");
    const parsed = parseUpdateManifest(JSON.parse(bytes.toString("utf8")), release.version);
    if (`sha256:${parsed.debian.sha256}` !== release.debian.digest || parsed.debian.size !== release.debian.size) throw new Error("The Debian artifact does not match the update manifest.");
    const sums = await boundedFetch(release.checksums.browser_download_url, { fetchImpl, maxBytes: 1024 * 1024 });
    if (`sha256:${sha256(sums)}` !== release.checksums.digest ||
        checksumFor(sums.toString("utf8"), "server-update.json") !== sha256(bytes) ||
        checksumFor(sums.toString("utf8"), parsed.debian.name) !== parsed.debian.sha256) {
      throw new Error("SHA256SUMS does not match the release manifest.");
    }
    return { ...parsed, tag: release.tag };
  }
  return null;
}

function assertRoot() { if (process.getuid?.() !== 0) throw new Error("Run this command with sudo."); }
function assertInheritedLock() {
  if (process.env.YAWF_UPDATER_LOCK_FD !== "9") throw new Error("Invoke the updater through /usr/local/sbin/yawf-server-update.");
  const stat = fstatSync(9);
  if (!stat.isFile() || stat.uid !== 0) throw new Error("The inherited updater lock is invalid.");
}
const DEFAULT_PATH_FS = Object.freeze({ lstatSync, realpathSync });
function assertSafeNode(path, kind, fsOps = DEFAULT_PATH_FS) {
  const stat = fsOps.lstatSync(path);
  if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() : !stat.isDirectory()) || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error(`${path} must be a root-owned ${kind} and not group/other writable.`);
  }
}
export function assertProtectedRootPath(path, kind, fsOps = DEFAULT_PATH_FS) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Compose path must be canonical and absolute.");
  if (fsOps.realpathSync(path) !== path) throw new Error(`${path} must not contain symlinks.`);
  assertSafeNode(path, kind, fsOps);
  let ancestor = dirname(path);
  while (true) {
    if (fsOps.realpathSync(ancestor) !== ancestor) throw new Error(`${ancestor} must not contain symlinks.`);
    assertSafeNode(ancestor, "directory", fsOps);
    if (ancestor === "/") break;
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("Compose path did not reach the filesystem root safely.");
    ancestor = parent;
  }
}
function assertSafeComposePath(path) {
  assertProtectedRootPath(path, "file");
  const projectDir = dirname(path);
  const envPath = join(projectDir, ".env");
  assertProtectedRootPath(envPath, "file");
  if (lstatSync(envPath).size > 1024 * 1024) throw new Error("The Compose .env file is too large.");
  return { projectDir, envPath };
}

function copyPrivateFile(source, destination, exclusive) {
  const sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationFd;
  try {
    const stat = fstatSync(sourceFd);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 1024 * 1024) throw new Error("The Compose .env file is unsafe.");
    const flags = constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_CREAT | (exclusive ? constants.O_EXCL : constants.O_TRUNC);
    destinationFd = openSync(destination, flags, stat.mode & 0o777);
    writeFileSync(destinationFd, readFileSync(sourceFd));
  } finally {
    if (destinationFd != null) closeSync(destinationFd);
    closeSync(sourceFd);
  }
}

const DEFAULT_STATE_FS = Object.freeze({ closeSync, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync });
function ensurePublicStatusDirectory(fsOps = DEFAULT_STATE_FS) {
  fsOps.mkdirSync(PATHS.root, { recursive: true, mode: 0o700 });
  assertProtectedRootPath(PATHS.root, "directory", fsOps);
  if (!fsOps.existsSync(PATHS.publicDir)) fsOps.mkdirSync(PATHS.publicDir, { mode: 0o755 });
  assertProtectedRootPath(PATHS.publicDir, "directory", fsOps);
  const fd = fsOps.openSync(PATHS.publicDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const before = fsOps.fstatSync(fd);
    if (!before.isDirectory() || before.uid !== 0 || (before.mode & 0o022) !== 0) throw new Error("The public updater status directory is unsafe.");
    fsOps.fchmodSync(fd, 0o755);
    const after = fsOps.fstatSync(fd);
    if (!after.isDirectory() || after.uid !== 0 || (after.mode & 0o777) !== 0o755) throw new Error("The public updater status directory permissions could not be established.");
  } finally { fsOps.closeSync(fd); }
}
function atomicJson(path, value, fsOps = DEFAULT_STATE_FS) {
  if (![PATHS.policy, PATHS.journal, PATHS.status].includes(path)) throw new Error("Refusing to write an unknown updater state path.");
  const mode = path === PATHS.status ? 0o644 : 0o600;
  const directory = dirname(path);
  if (path === PATHS.status) ensurePublicStatusDirectory(fsOps);
  else {
    fsOps.mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertProtectedRootPath(directory, "directory", fsOps);
  }
  if (fsOps.existsSync(path)) assertProtectedRootPath(path, "file", fsOps);
  const temporary = `${path}.tmp-${process.pid}`;
  let fd = fsOps.openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  let renamed = false;
  try {
    fsOps.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsOps.fchmodSync(fd, mode);
    const written = fsOps.fstatSync(fd);
    if (!written.isFile() || written.uid !== 0 || (written.mode & 0o777) !== mode) throw new Error("Updater state file permissions could not be established.");
    fsOps.closeSync(fd); fd = null;
    fsOps.renameSync(temporary, path); renamed = true;
  } finally {
    if (fd != null) fsOps.closeSync(fd);
    if (!renamed) { try { fsOps.unlinkSync(temporary); } catch {} }
  }
}
function readJson(path, max = 64 * 1024) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error(`Unsafe state file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}
function writeStatus(policy, state, detail, extra = {}, fsOps = DEFAULT_STATE_FS) {
  atomicJson(PATHS.status, { schemaVersion: 1, supported: true, installType: "docker-compose", enabled: policy.enabled, state,
    currentVersion: policy.currentVersion ?? null, candidateVersion: null, lastCheckedAt: null, lastChangedAt: new Date().toISOString(), detail, ...extra }, fsOps);
}

// This test seam has no path input and can only exercise the fixed public status destination.
export function writePublicStatusForTest(fsOps) {
  writeStatus({ enabled: false, currentVersion: null }, "disabled", "test", {}, fsOps);
}

async function run(command, args, options = {}) {
  const result = await execFile(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 120_000, ...options,
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root" } });
  return result.stdout.trim();
}
function composeArgs(policy, command) {
  const checked = assertSafeComposePath(policy.composeFile);
  if (checked.projectDir !== policy.projectDir || checked.envPath !== policy.envPath) throw new Error("The registered Compose path changed after registration.");
  return ["compose", "--project-name", policy.projectName, "--project-directory", policy.projectDir, "--file", policy.composeFile, "--file", PATHS.override, ...command];
}
function imageRef(digest) { if (!DIGEST.test(digest)) throw new Error("Invalid image digest."); return `${REPOSITORY}@${digest}`; }
function writeOverride(digest) {
  const text = `services:\n  debridstreamer:\n    image: ${imageRef(digest)}\n`;
  mkdirSync(PATHS.root, { recursive: true, mode: 0o700 });
  const tmp = `${PATHS.override}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600, flag: "wx" }); renameSync(tmp, PATHS.override);
}
async function containerId(policy) {
  const value = await run("docker", composeArgs(policy, ["ps", "--quiet", "debridstreamer"]));
  if (!/^[a-f0-9]{12,64}$/.test(value)) throw new Error("The registered debridstreamer service is not running.");
  return value;
}
async function serviceContainerId(policy) {
  const value = await run("docker", composeArgs(policy, ["ps", "--all", "--quiet", "debridstreamer"]));
  if (!/^[a-f0-9]{12,64}$/.test(value)) throw new Error("The registered debridstreamer service does not have exactly one container.");
  return value;
}
async function inspectFormat(id, format) { return run("docker", ["inspect", "--format", format, id]); }
async function stopAndConfirm(policy) {
  const id = await serviceContainerId(policy);
  await run("docker", composeArgs(policy, ["stop", "debridstreamer"]));
  if (await inspectFormat(id, "{{.State.Running}}") !== "false") throw new Error("The registered server container did not stop safely.");
}
async function health(id) {
  const script = "fetch('http://127.0.0.1:43110/api/health').then(async r=>{if(!r.ok)throw Error(String(r.status));let t=await r.text();if(t.length>4096)throw Error('large');process.stdout.write(t)})";
  const raw = await run("docker", ["exec", id, "node", "-e", script]);
  return JSON.parse(raw);
}
async function bundleHash(id) {
  return run("docker", ["exec", id, "node", "-e", "const f=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha256').update(f.readFileSync('/app/server/dist/index.cjs')).digest('hex'))"]);
}
async function activeStreams(id) {
  const script = "const{DatabaseSync}=require('node:sqlite');let d=new DatabaseSync('/data/debridstreamer.sqlite',{readOnly:true});let r=d.prepare(`SELECT COUNT(*) count FROM stream_sessions WHERE revoked_at IS NULL AND expires_at > ? AND completed_at IS NULL`).get(new Date().toISOString());process.stdout.write(String(r.count));d.close()";
  const value = await run("docker", ["exec", id, "node", "-e", script]);
  if (!/^\d+$/.test(value)) throw new Error("Could not verify active playback.");
  return Number(value);
}
async function verifyBaselineAfterPull(policy, expectedId, expectedImageId, expectedBundleHash) {
  const id = await containerId(policy);
  if (id !== expectedId || await inspectFormat(id, "{{.Image}}") !== expectedImageId || await bundleHash(id) !== expectedBundleHash) {
    throw new Error("The registered server changed while the candidate image was downloading.");
  }
  const mounts = JSON.parse(await inspectFormat(id, "{{json .Mounts}}"));
  const data = mounts.filter((item) => item?.Type === "volume" && item?.Destination === "/data" && item?.RW === true && item?.Name === policy.volumeName);
  if (data.length !== 1) throw new Error("The registered data volume changed while the candidate image was downloading.");
  return activeStreams(id);
}
async function snapshotVolume(policy, image, backup, mode) {
  const source = mode === "copy" ? "/data" : "/backup/data";
  const destination = mode === "copy" ? "/backup/data" : "/data";
  const volume = `type=volume,source=${policy.volumeName},target=/data${mode === "copy" ? ",readonly" : ""}`;
  await run("docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--cap-add", "CHOWN", "--security-opt", "no-new-privileges:true", "--user", "0:0",
    "--mount", volume, "--mount", `type=bind,source=${backup},target=/backup`, "--mount", `type=bind,source=${PATHS.helper},target=/updater/volume-copy.mjs,readonly`,
    "--entrypoint", "node", image, "/updater/volume-copy.mjs", mode, source, destination]);
}
async function register(composeFile) {
  if (existsSync(PATHS.journal)) throw new Error("Recover the pending update journal before changing registration.");
  const { projectDir, envPath } = assertSafeComposePath(composeFile);
  mkdirSync(PATHS.root, { recursive: true, mode: 0o700 }); mkdirSync(PATHS.publicDir, { recursive: true, mode: 0o755 });
  const temporary = { composeFile, projectDir, projectName: "placeholder" };
  assertSafeComposePath(composeFile);
  const ids = await run("docker", ["compose", "--project-directory", projectDir, "--file", composeFile, "ps", "--quiet", "debridstreamer"]);
  if (!/^[a-f0-9]{12,64}$/.test(ids)) throw new Error("Exactly one running debridstreamer Compose service is required.");
  const service = await inspectFormat(ids, "{{ index .Config.Labels \"com.docker.compose.service\" }}");
  const projectName = await inspectFormat(ids, "{{ index .Config.Labels \"com.docker.compose.project\" }}");
  if (service !== "debridstreamer" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(projectName)) throw new Error("The running container is not the expected Compose service.");
  temporary.projectName = projectName;
  const configImage = await inspectFormat(ids, "{{.Config.Image}}");
  if (!configImage.startsWith(`${REPOSITORY}:`) && !configImage.startsWith(`${REPOSITORY}@`)) throw new Error("The service does not use the fixed YAWF Stream repository.");
  const imageId = await inspectFormat(ids, "{{.Image}}");
  const repoDigests = JSON.parse(await run("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", imageId]));
  const currentRef = repoDigests.find((item) => typeof item === "string" && item.startsWith(`${REPOSITORY}@sha256:`));
  if (currentRef == null) throw new Error("The running image has no immutable YAWF Stream digest.");
  const mounts = JSON.parse(await inspectFormat(ids, "{{json .Mounts}}"));
  const data = mounts.filter((item) => item?.Type === "volume" && item?.Destination === "/data" && item?.RW === true);
  if (data.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(data[0].Name)) throw new Error("The service must have one writable named volume mounted at /data.");
  const currentHealth = await health(ids);
  const currentVersion = typeof currentHealth.version === "string" && VERSION.test(currentHealth.version) ? currentHealth.version : null;
  const policy = { schemaVersion: 1, installType: "docker-compose", enabled: false, composeFile, projectDir, envPath, projectName,
    volumeName: data[0].Name, currentDigest: currentRef.slice(REPOSITORY.length + 1), currentVersion, inhibitedVersion: null, maintenanceUtcStart: 3, maintenanceMinutes: 120 };
  writeOverride(policy.currentDigest); atomicJson(PATHS.policy, policy); writeStatus(policy, "disabled", "Registered. Automatic server updates are off.");
  return policy;
}

async function rollback(policy, journal) {
  assertJournalIdentity(policy, journal);
  const oldRef = imageRef(journal.oldDigest);
  await stopAndConfirm(policy);
  writeOverride(journal.oldDigest);
  await snapshotVolume(policy, oldRef, journal.backup, "restore");
  copyPrivateFile(join(journal.backup, "environment"), policy.envPath, false);
  await run("docker", composeArgs(policy, ["up", "--detach", "--no-deps", "debridstreamer"]));
  let id; let result;
  for (let attempt = 0; attempt < 40; attempt += 1) { try { id = await containerId(policy); result = await health(id); if (result.ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  if (id == null || result?.ok !== true) throw new Error("Rollback health verification failed.");
  const hash = await bundleHash(id);
  if (result.ok !== true || hash !== journal.oldBundleHash || await inspectFormat(id, "{{.Config.Image}}") !== oldRef) throw new Error("Rollback verification failed.");
  policy.currentDigest = journal.oldDigest; policy.currentVersion = journal.oldVersion; policy.inhibitedVersion = journal.candidateVersion;
  atomicJson(PATHS.policy, policy); rmSync(PATHS.journal, { force: true });
  writeStatus(policy, "rolled_back", `Update ${journal.candidateVersion} failed and the previous server was restored.`, { candidateVersion: journal.candidateVersion });
}

function registrationIdentity(policy) {
  return { composeFile: policy.composeFile, projectName: policy.projectName, volumeName: policy.volumeName, envPath: policy.envPath };
}
function assertJournalIdentity(policy, journal) {
  if (!exactKeys(journal.registration, ["composeFile", "projectName", "volumeName", "envPath"]) ||
      JSON.stringify(journal.registration) !== JSON.stringify(registrationIdentity(policy))) {
    throw new Error("The pending update journal does not match the registered Compose service.");
  }
}
async function restartOldWithoutRestore(policy, journal) {
  assertJournalIdentity(policy, journal);
  const oldRef = imageRef(journal.oldDigest);
  writeOverride(journal.oldDigest);
  await run("docker", composeArgs(policy, ["up", "--detach", "--no-deps", "debridstreamer"]));
  let id; let result;
  for (let attempt = 0; attempt < 40; attempt += 1) { try { id = await containerId(policy); result = await health(id); if (result.ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  if (id == null || result?.ok !== true || await bundleHash(id) !== journal.oldBundleHash || await inspectFormat(id, "{{.Config.Image}}") !== oldRef) {
    throw new Error("Pre-install recovery verification failed.");
  }
  policy.inhibitedVersion = journal.candidateVersion;
  atomicJson(PATHS.policy, policy);
  rmSync(PATHS.journal, { force: true });
  rmSync(journal.backup, { recursive: true, force: true });
  writeStatus(policy, "failed", `Update ${journal.candidateVersion} failed before the data snapshot; the previous server was restarted.`, { candidateVersion: journal.candidateVersion });
}

async function recoverJournal(policy, journal) {
  assertJournalIdentity(policy, journal);
  if (journal.phase === "snapshotted" || journal.phase === "switched") return rollback(policy, journal);
  await restartOldWithoutRestore(policy, journal);
}

async function performUpdate(policy, candidate, testFaults = null) {
  if (policy.inhibitedVersion === candidate.version) { writeStatus(policy, "failed", `Version ${candidate.version} is inhibited after a failed update. Run enable to retry.`, { candidateVersion: candidate.version }); return; }
  const now = testFaults?.now instanceof Date ? testFaults.now : new Date(); const minute = now.getUTCHours() * 60 + now.getUTCMinutes(); const start = policy.maintenanceUtcStart * 60;
  if (minute < start || minute >= start + policy.maintenanceMinutes) { writeStatus(policy, "deferred", "Waiting for the 03:00-05:00 UTC maintenance window.", { candidateVersion: candidate.version, lastCheckedAt: now.toISOString() }); return; }
  const oldId = await containerId(policy);
  let active;
  try { active = await activeStreams(oldId); }
  catch { writeStatus(policy, "deferred", "Playback activity could not be verified safely; the update was deferred.", { candidateVersion: candidate.version, lastCheckedAt: now.toISOString() }); return; }
  if (active > 0) { writeStatus(policy, "deferred", "Active playback is in progress; the update was deferred.", { candidateVersion: candidate.version, lastCheckedAt: now.toISOString() }); return; }
  const oldBundleHash = await bundleHash(oldId); const oldDigest = policy.currentDigest; const oldVersion = policy.currentVersion;
  const oldImageId = await inspectFormat(oldId, "{{.Image}}");
  let registeredImageId;
  try { registeredImageId = await run("docker", ["image", "inspect", "--format", "{{.Id}}", imageRef(oldDigest)]); }
  catch { registeredImageId = null; }
  if (registeredImageId !== oldImageId) {
    writeStatus(policy, "deferred", "The running server no longer matches its registration; register it again before updating.", { candidateVersion: candidate.version, lastCheckedAt: now.toISOString() });
    return;
  }
  const candidateRef = imageRef(candidate.image.digest);
  try {
    await run("docker", ["pull", candidateRef]);
    const candidateRevision = await run("docker", ["image", "inspect", "--format", "{{ index .Config.Labels \"org.opencontainers.image.revision\" }}", candidateRef]);
    if (candidateRevision !== candidate.sourceRevision) throw new Error("The candidate image source revision does not match the release manifest.");
  } catch (error) {
    writeStatus(policy, "failed", "Candidate image download or provenance verification failed.", { candidateVersion: candidate.version, lastCheckedAt: now.toISOString() });
    throw error;
  }
  try { active = await verifyBaselineAfterPull(policy, oldId, oldImageId, oldBundleHash); }
  catch { writeStatus(policy, "deferred", "The running server changed or playback activity could not be rechecked safely; the update was deferred.", { candidateVersion: candidate.version, lastCheckedAt: now.toISOString() }); return; }
  if (active > 0) { writeStatus(policy, "deferred", "Active playback began while the candidate downloaded; the update was deferred.", { candidateVersion: candidate.version, lastCheckedAt: now.toISOString() }); return; }
  const backup = join(PATHS.root, "backups", `${Date.now()}-${candidate.version}`); mkdirSync(backup, { recursive: true, mode: 0o700 });
  const journal = { schemaVersion: 1, phase: "prepared", backup, oldDigest, oldVersion, oldBundleHash, candidateVersion: candidate.version, candidateDigest: candidate.image.digest, registration: registrationIdentity(policy) };
  atomicJson(PATHS.journal, journal); writeStatus(policy, "updating", `Installing server ${candidate.version}.`, { candidateVersion: candidate.version, lastCheckedAt: now.toISOString() });
  try {
    if (testFaults?.stop === true) throw new Error("Injected stop failure.");
    await stopAndConfirm(policy); journal.phase = "stopped"; atomicJson(PATHS.journal, journal);
    copyPrivateFile(policy.envPath, join(backup, "environment"), true);
    try {
      if (testFaults?.snapshot === true) throw new Error("Injected snapshot failure.");
      await snapshotVolume(policy, imageRef(oldDigest), backup, "copy");
    }
    catch { await restartOldWithoutRestore(policy, journal); return; }
    journal.phase = "snapshotted"; atomicJson(PATHS.journal, journal);
    if (testFaults?.interruptAfterSnapshot === true) return;
    writeOverride(candidate.image.digest); journal.phase = "switched"; atomicJson(PATHS.journal, journal);
    await run("docker", composeArgs(policy, ["up", "--detach", "--no-deps", "debridstreamer"]));
    let id; let result;
    for (let attempt = 0; attempt < 40; attempt += 1) { try { id = await containerId(policy); result = await health(id); if (result.ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
    if (id == null || result?.ok !== true || result.ready !== true || result.version !== candidate.version || await inspectFormat(id, "{{.Config.Image}}") !== candidateRef) throw new Error("Candidate health or version verification failed.");
    if (typeof testFaults?.afterHealth === "function") await testFaults.afterHealth(id);
    policy.currentDigest = candidate.image.digest; policy.currentVersion = candidate.version; policy.inhibitedVersion = null;
    atomicJson(PATHS.policy, policy); rmSync(PATHS.journal, { force: true });
    writeStatus(policy, "updated", `Server ${candidate.version} installed successfully.`, { candidateVersion: candidate.version, currentVersion: candidate.version, lastCheckedAt: now.toISOString() });
  } catch (error) {
    try {
      if (journal.phase === "snapshotted" || journal.phase === "switched") await rollback(policy, journal);
      else await restartOldWithoutRestore(policy, journal);
    } catch (recoveryError) {
      writeStatus(policy, "failed", "Update recovery needs operator attention; the journal was retained and server data was not restored without a verified stop.", { candidateVersion: candidate.version });
      throw recoveryError;
    }
  }
}

// Imported only by the isolated CI harness. The installed CLI exposes no path,
// command, repository, or clock override.
export async function runRegisteredCandidateForTest(candidate, testFaults = {}) {
  assertRoot();
  const policy = await loadPolicy();
  if (existsSync(PATHS.journal)) await recoverJournal(policy, readJson(PATHS.journal));
  await performUpdate(policy, candidate, testFaults);
}

export async function recoverRegisteredJournalForTest() {
  assertRoot();
  const policy = await loadPolicy();
  if (!existsSync(PATHS.journal)) throw new Error("No pending update journal exists.");
  await recoverJournal(policy, readJson(PATHS.journal));
}

async function loadPolicy() {
  const policy = readJson(PATHS.policy);
  if (policy.schemaVersion !== 1 || policy.installType !== "docker-compose" || typeof policy.enabled !== "boolean") throw new Error("The updater is not registered.");
  assertSafeComposePath(policy.composeFile); assertSafeNode(PATHS.policy, "file");
  return policy;
}

export async function main(argv = process.argv.slice(2)) {
  assertRoot(); const command = argv[0];
  assertInheritedLock();
  if (command === "register") {
    if (argv.length !== 2) throw new Error("Usage: yawf-server-update register /absolute/compose.yml");
    await register(argv[1]);
    return;
  }
  if (!new Set(["enable", "disable", "check", "run", "status"]).has(command) || argv.length !== 1) throw new Error("Usage: yawf-server-update register|enable|disable|check|run|status");
  {
    const policy = await loadPolicy();
    if (existsSync(PATHS.journal)) await recoverJournal(policy, readJson(PATHS.journal));
    if (command === "enable") { await run("systemctl", ["enable", "--now", "yawf-server-update.timer"]); policy.enabled = true; policy.inhibitedVersion = null; atomicJson(PATHS.policy, policy); writeStatus(policy, "idle", "Automatic server updates are enabled for 03:00-05:00 UTC."); return; }
    if (command === "disable") { policy.enabled = false; atomicJson(PATHS.policy, policy); await run("systemctl", ["disable", "--now", "yawf-server-update.timer"]).catch(() => {}); writeStatus(policy, "disabled", "Automatic server updates are off."); return; }
    if (command === "status") { process.stdout.write(`${readFileSync(PATHS.status, "utf8")}`); return; }
    if (command === "run" && !policy.enabled) { writeStatus(policy, "disabled", "Automatic server updates are off."); return; }
    writeStatus(policy, "checking", "Checking the stable server release channel.", { lastCheckedAt: new Date().toISOString() });
    let candidate;
    try { candidate = await resolveUpdateCandidate(policy.currentVersion ?? "0.0.0"); }
    catch (error) { writeStatus(policy, "failed", "The stable release check failed. Inspect host service logs.", { lastCheckedAt: new Date().toISOString() }); throw error; }
    if (candidate == null) { writeStatus(policy, policy.enabled ? "idle" : "disabled", "The server is up to date.", { lastCheckedAt: new Date().toISOString() }); return; }
    if (command === "check") { writeStatus(policy, policy.enabled ? "idle" : "disabled", `Server ${candidate.version} is available.`, { candidateVersion: candidate.version, lastCheckedAt: new Date().toISOString() }); return; }
    await performUpdate(policy, candidate);
  }
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`yawf-server-update: ${error instanceof Error ? error.message : "failed"}\n`); process.exitCode = 1; });
}
