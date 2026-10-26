#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriConfig = JSON.parse(
  readFileSync(join(root, "web", "src-tauri", "tauri.conf.json"), "utf8"),
);
const productName = tauriConfig.productName ?? "DebridStreamer";
const target = resolve(process.argv[2] ?? defaultTarget());

function defaultTarget() {
  if (process.platform === "darwin") {
    return join(
      root,
      "web",
      "src-tauri",
      "target",
      "release",
      "bundle",
      "macos",
      `${productName}.app`,
    );
  }
  return join(root, "web", "src-tauri", "resources", "server");
}

function currentRuntime() {
  const os = process.platform;
  const arch = process.arch;
  if (os === "darwin" && arch === "arm64") return { platform: "darwin-arm64", executable: join("bin", "node") };
  if (os === "darwin" && arch === "x64") return { platform: "darwin-x64", executable: join("bin", "node") };
  if (os === "linux" && arch === "arm64") return { platform: "linux-arm64", executable: join("bin", "node") };
  if (os === "linux" && arch === "x64") return { platform: "linux-x64", executable: join("bin", "node") };
  if (os === "win32" && arch === "arm64") return { platform: "win-arm64", executable: "node.exe" };
  if (os === "win32" && arch === "x64") return { platform: "win-x64", executable: "node.exe" };
  throw new Error(`Unsupported runtime platform: ${os}-${arch}`);
}

function serverDirCandidates(path) {
  return [
    join(path, "Contents", "Resources", "resources", "server"),
    join(path, "Contents", "Resources", "server"),
    join(path, "resources", "server"),
    join(path, "server"),
    path,
  ];
}

function findServerDir(path) {
  for (const candidate of serverDirCandidates(path)) {
    if (existsSync(join(candidate, "index.cjs")) && existsSync(join(candidate, "web-dist", "index.html"))) {
      return candidate;
    }
  }
  throw new Error(`Could not find packaged server resources under ${path}`);
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Missing ${label}: ${path}`);
  }
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (port == null) reject(new Error("Could not allocate a localhost port"));
        else resolvePort(port);
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? "no response"}`);
}

async function requireOk(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? "no response"}`);
}

function materializeNode(source, tempRoot) {
  const exeName = process.platform === "win32" ? "node.exe" : "node";
  const dest = join(tempRoot, exeName);
  copyFileSync(source, dest);
  if (process.platform !== "win32") chmodSync(dest, 0o755);
  return dest;
}

function outputTail(buffer) {
  return buffer.join("").slice(-4000).trim();
}

async function main() {
  const serverDir = findServerDir(target);
  const serverEntry = join(serverDir, "index.cjs");
  const webDist = join(serverDir, "web-dist");
  const webIndex = join(webDist, "index.html");
  const manifest = join(serverDir, "manifest.json");
  const runtime = currentRuntime();
  const bundledNode = join(serverDir, "node", runtime.platform, runtime.executable);

  requireFile(serverEntry, "server entry");
  requireFile(webIndex, "web index");
  requireFile(manifest, "server resource manifest");
  requireFile(bundledNode, `${runtime.platform} Node runtime`);

  const tempRoot = mkdtempSync(join(tmpdir(), "debridstreamer-tauri-smoke-"));
  const dataDir = join(tempRoot, "data");
  mkdirSync(dataDir, { recursive: true });
  const nodeBin = materializeNode(bundledNode, tempRoot);

  const versionCheck = spawnSync(nodeBin, ["--version"], { encoding: "utf8" });
  if (versionCheck.status !== 0) {
    throw new Error(`Packaged Node runtime failed --version: ${versionCheck.stderr || versionCheck.stdout}`);
  }

  const port = await freePort();
  const stdout = [];
  const stderr = [];
  const child = spawn(nodeBin, [serverEntry], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      DS_SERVER_DATA_DIR: dataDir,
      DS_SERVER_DB_PATH: join(dataDir, "debridstreamer.sqlite"),
      DS_SERVER_CORS_ORIGIN: "http://tauri.localhost,tauri://localhost,http://127.0.0.1",
      DS_SERVER_COOKIE_SECURE: "false",
      DS_SERVER_COOKIE_SAMESITE: "lax",
      DS_WEB_DIST: webDist,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  let exitStatus = null;
  const childExit = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => {
      exitStatus = { code, signal };
      resolveExit(exitStatus);
    });
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForJson(`${baseUrl}/api/health`, 8000);
    if (health?.ok !== true) {
      throw new Error(`Unexpected health payload: ${JSON.stringify(health)}`);
    }

    const rootResponse = await requireOk(baseUrl, 3000);
    const html = await rootResponse.text();
    if (!html.includes("<!doctype html") && !html.includes("<html")) {
      throw new Error("Packaged web-dist root did not return HTML");
    }

    console.log(`ok   Packaged server resources: ${serverDir}`);
    console.log(`ok   Packaged Node runtime: ${runtime.platform} ${versionCheck.stdout.trim()}`);
    console.log(`ok   Server booted and served health + HTML on localhost:${port}`);
  } catch (error) {
    console.error(`fail Packaged server smoke failed for ${target}`);
    const out = outputTail(stdout);
    const err = outputTail(stderr);
    if (out) console.error(`stdout tail:\n${out}`);
    if (err) console.error(`stderr tail:\n${err}`);
    throw error;
  } finally {
    if (exitStatus == null) child.kill();
    await childExit;
    rmSync(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
