#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, cpSync, readdirSync, renameSync, statSync } from "node:fs";
import { get } from "node:https";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_NODE_RUNTIME_VERSION } from "./desktop_node_runtime_policy.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = (process.env.NODE_RUNTIME_VERSION ?? DEFAULT_NODE_RUNTIME_VERSION).replace(/^v/, "");
const nodeDistOrigin = "https://nodejs.org";
const minArchiveBytes = 1_000_000;
const platforms = process.argv.slice(2);
const supportedPlatforms = new Map([
  ["darwin-arm64", join("bin", "node")],
  ["darwin-x64", join("bin", "node")],
  ["linux-arm64", join("bin", "node")],
  ["linux-x64", join("bin", "node")],
  ["win-arm64", "node.exe"],
  ["win-x64", "node.exe"],
]);

if (platforms.length === 0) {
  console.error("Usage: node scripts/download_tauri_node_runtime.mjs <platform> [platform...]");
  console.error("Examples: darwin-arm64 darwin-x64 linux-x64 win-x64");
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Unsupported NODE_RUNTIME_VERSION: ${version}`);
  console.error(`Expected a plain semver version such as ${DEFAULT_NODE_RUNTIME_VERSION}.`);
  process.exit(1);
}

for (const platform of platforms) {
  if (!supportedPlatforms.has(platform)) {
    console.error(`Unsupported Node runtime platform: ${platform}`);
    console.error(`Supported platforms: ${Array.from(supportedPlatforms.keys()).join(", ")}`);
    process.exit(1);
  }
}

const cacheDir = join(root, ".build", "node-runtime");
const destRoot = join(root, "web", "src-tauri", "resources", "server", "node");
mkdirSync(cacheDir, { recursive: true });
mkdirSync(destRoot, { recursive: true });

function assertNodeDistUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.origin !== nodeDistOrigin) {
    throw new Error(`Refusing to download Node runtime from untrusted URL: ${url}`);
  }
  return parsed;
}

function download(url, dest, redirects = 0) {
  const requestUrl = assertNodeDistUrl(url);
  if (redirects > 5) {
    throw new Error(`Too many redirects while downloading ${requestUrl}`);
  }

  const tmp = `${dest}.tmp`;
  rmSync(tmp, { force: true });
  return new Promise((resolve, reject) => {
    const file = createWriteStream(tmp);
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      file.close(() => {
        rmSync(tmp, { force: true });
        reject(error);
      });
    };
    file.on("error", fail);
    const request = get(requestUrl, (response) => {
      response.on("error", fail);
      if (
        response.statusCode != null &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        const redirected = new URL(response.headers.location, requestUrl);
        assertNodeDistUrl(redirected);
        response.resume();
        file.close(() => {
          rmSync(tmp, { force: true });
          download(redirected.toString(), dest, redirects + 1).then(resolve, reject);
        });
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        fail(new Error(`Download failed ${response.statusCode}: ${requestUrl}`));
        return;
      }
      response.pipe(file);
      file.on("finish", () =>
        file.close(() => {
          settled = true;
          renameSync(tmp, dest);
          resolve();
        }),
      );
    });
    request.setTimeout(60_000, () => {
      request.destroy(new Error(`Timed out downloading ${requestUrl}`));
    });
    request.on("error", fail);
  });
}

async function ensureDownloaded(url, dest) {
  if (!existsSync(dest)) {
    await download(url, dest);
  }
}

function archiveIsUsable(archive) {
  try {
    return statSync(archive).size >= minArchiveBytes;
  } catch {
    return false;
  }
}

function archiveName(platform) {
  const ext = platform.startsWith("win-") ? "zip" : "tar.xz";
  return `node-v${version}-${platform}.${ext}`;
}

async function shasums() {
  const file = `SHASUMS256-v${version}.txt`;
  const path = join(cacheDir, file);
  await ensureDownloaded(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`, path);
  return readFileSync(path, "utf8");
}

let shasumsText = null;

async function expectedSha256(file) {
  shasumsText ??= await shasums();
  for (const line of shasumsText.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === file && /^[a-f0-9]{64}$/i.test(hash)) return hash.toLowerCase();
  }
  throw new Error(`No SHA-256 entry found in Node SHASUMS for ${file}`);
}

function actualSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function verifyArchive(archive, file) {
  const expected = await expectedSha256(file);
  const actual = actualSha256(archive);
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${file}: expected ${expected}, got ${actual}`);
  }
}

function extract(archive, platform) {
  const extractDir = join(cacheDir, `extract-${platform}`);
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  if (platform.startsWith("win-")) {
    if (process.platform === "win32") {
      execFileSync("powershell", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath ${JSON.stringify(archive)} -DestinationPath ${JSON.stringify(extractDir)} -Force`,
      ]);
    } else {
      execFileSync("unzip", ["-q", archive, "-d", extractDir]);
    }
  } else {
    execFileSync("tar", ["-xJf", archive, "-C", extractDir]);
  }

  const expectedDirectory = `node-v${version}-${platform}`;
  const unexpected = readdirSync(extractDir).filter((entry) => entry !== expectedDirectory);
  if (unexpected.length > 0) {
    throw new Error(`Unexpected entries in Node runtime archive for ${platform}: ${unexpected.join(", ")}`);
  }

  const source = join(extractDir, expectedDirectory);
  if (!existsSync(source)) {
    throw new Error(`Extracted Node directory not found: ${source}`);
  }

  const dest = join(destRoot, platform);
  rmSync(dest, { recursive: true, force: true });
  cpSync(source, dest, { recursive: true });
  const executable = join(dest, supportedPlatforms.get(platform));
  if (!existsSync(executable)) {
    throw new Error(`Extracted Node executable not found: ${executable}`);
  }
  console.log(`Prepared Node ${version} runtime for ${platform}.`);
}

for (const platform of platforms) {
  const file = archiveName(platform);
  const archive = join(cacheDir, file);
  const url = `https://nodejs.org/dist/v${version}/${file}`;
  if (!archiveIsUsable(archive)) {
    rmSync(archive, { force: true });
    console.log(`Downloading ${basename(archive)}...`);
    await download(url, archive);
  }
  try {
    await verifyArchive(archive, file);
  } catch (error) {
    rmSync(archive, { force: true });
    console.log(`Re-downloading ${basename(archive)} after failed checksum verification...`);
    await download(url, archive);
    await verifyArchive(archive, file);
  }
  extract(archive, platform);
}
