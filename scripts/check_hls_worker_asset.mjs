#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function requireCheck(condition, message) {
  if (!condition) throw new Error(message);
}

// Static production-artifact checks, not evidence of a running browser Worker.
export function checkHlsWorkerAsset({ root = repoRoot, dist = join(root, "web/dist"), base = "/" } = {}) {
  requireCheck(/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base), "expected an explicit same-origin absolute mount");
  const pkg = JSON.parse(readFileSync(join(root, "web/node_modules/hls.js/package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "web/package-lock.json"), "utf8"));
  requireCheck(pkg.version === lock.packages["node_modules/hls.js"].version, "installed HLS version differs from lockfile");
  const dependencyWorker = readFileSync(join(root, "web/node_modules/hls.js/dist/hls.worker.js"));
  requireCheck(dependencyWorker.includes(Buffer.from(`hls.js version ${pkg.version}`)), "worker version does not match its HLS package");
  const workers = readdirSync(join(dist, "assets")).filter(name => /^hls\.worker-[A-Za-z0-9_-]{8,}\.js$/.test(name));
  requireCheck(workers.length === 1, "exactly one emitted hashed HLS worker is required");
  const name = workers[0];
  const workerPath = join(dist, "assets", name);
  const info = lstatSync(workerPath);
  requireCheck(info.isFile() && !info.isSymbolicLink(), "emitted HLS worker must be a regular file");
  const emitted = readFileSync(workerPath);
  requireCheck(hash(emitted) === hash(dependencyWorker), "emitted worker bytes differ from the locked package");
  const players = readdirSync(join(dist, "assets")).filter(name => /^VideoPlayer-[A-Za-z0-9_-]{8,}\.js$/.test(name));
  requireCheck(players.length === 1, "exactly one built VideoPlayer chunk is required");
  const player = readFileSync(join(dist, "assets", players[0]), "utf8");
  const expectedUrl = `${base}assets/${name}`;
  const references = [...player.matchAll(/["'`]([^"'`]*hls\.worker-[A-Za-z0-9_-]+\.js)["'`]/g)].map(match => match[1]);
  requireCheck(references.length === 1 && references[0] === expectedUrl && /workerPath:/.test(player), "VideoPlayer must pass the exact same-origin mounted worker URL");
  requireCheck(!readFileSync(join(dist, "index.html"), "utf8").includes(name), "worker must not be an initial script/preload request");
  const source = readFileSync(join(root, "web/src/components/VideoPlayer.tsx"), "utf8");
  requireCheck(/import\s+(\w+)\s+from\s+["']hls\.js\/dist\/hls\.worker\.js\?url["']/.test(source), "worker must use Vite's package-local URL asset import");
  const server = readFileSync(join(root, "server/src/app.ts"), "utf8");
  requireCheck(/["']\.js["']:\s*["']text\/javascript; charset=utf-8["']/.test(server), "server static policy must serve the worker as JavaScript");
  const config = JSON.parse(readFileSync(join(root, "web/src-tauri/tauri.conf.json"), "utf8"));
  requireCheck(config.build.frontendDist === "../dist", "native frontend must include the complete Vite dist");
  return { hlsVersion: pkg.version, worker: `assets/${name}`, workerUrl: expectedUrl, bytes: emitted.length, sha256: hash(emitted), playerChunk: `assets/${players[0]}`, scope: "STATIC_BUILD_AND_SERVING_POLICY_NOT_WORKER_RUNTIME_OR_SIGNED_PACKAGE" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(checkHlsWorkerAsset({ dist: resolve(process.argv[2] ?? join(repoRoot, "web/dist")), base: process.argv[3] ?? "/" }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
