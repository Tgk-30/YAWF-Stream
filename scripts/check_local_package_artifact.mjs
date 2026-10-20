#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "web");
const requireCurrent = process.argv.includes("--require-current");
const runSmokeCheck = process.argv.includes("--smoke");
const tauriConfig = JSON.parse(readFileSync(join(web, "src-tauri", "tauri.conf.json"), "utf8"));
const productName = tauriConfig.productName ?? "DebridStreamer";
const version = tauriConfig.version ?? "0.0.0";
const minArtifactBytes = 20 * 1024 * 1024;

function localArtifactArch() {
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64";
  if (process.platform === "darwin" && process.arch === "x64") return "x64";
  return process.arch;
}

function expectedArtifact() {
  if (process.platform === "darwin") {
    return join(
      web,
      "src-tauri",
      "target",
      "release",
      "bundle",
      "macos",
      `${productName}_${version}_${localArtifactArch()}.app.zip`,
    );
  }
  throw new Error(`Local package artifact verification is not implemented for ${process.platform}. CI covers Linux and Windows release artifacts.`);
}

const packageInputs = [
  "web/src",
  "web/src-tauri/src",
  "web/src-tauri/build.rs",
  "web/src-tauri/Cargo.toml",
  "web/src-tauri/Cargo.lock",
  "web/src-tauri/scripts/bundle-mpv-deps.sh",
  "web/src-tauri/tauri.conf.json",
  "web/package.json",
  "web/package-lock.json",
  "server/src",
  "server/package.json",
  "server/package-lock.json",
  "scripts/package_tauri_local.mjs",
  "scripts/build_macos_media_runtime.mjs",
  "scripts/macos-media-runtime",
  "scripts/stage_macos_media_runtime.mjs",
  "scripts/smoke_macos_media_runtime.mjs",
  "scripts/prepare_macos_media_notices.mjs",
  "scripts/desktop_node_runtime_policy.mjs",
  "scripts/prepare_tauri_server_resources.mjs",
  "scripts/download_tauri_node_runtime.mjs",
  "scripts/download_ffmpeg.mjs",
  "scripts/smoke_tauri_server_bundle.mjs",
];

function newestInputAfter(timestampMs) {
  const args = [
    "find",
    ...packageInputs,
    "-newer",
    expectedArtifact(),
    "-print",
  ];
  const output = execFileSync(args[0], args.slice(1), {
    cwd: root,
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => {
      try {
        return statSync(join(root, path)).mtimeMs > timestampMs;
      } catch {
        return false;
      }
    });
}

function sha256(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function runSmoke() {
  execFileSync(process.execPath, ["scripts/smoke_tauri_server_bundle.mjs"], {
    cwd: root,
    stdio: "inherit",
  });
}

function main() {
  const artifact = expectedArtifact();
  if (!existsSync(artifact)) {
    throw new Error(`Missing local package artifact: ${artifact}`);
  }
  const stats = statSync(artifact);
  if (!stats.isFile()) {
    throw new Error(`Local package artifact is not a file: ${artifact}`);
  }
  if (stats.size < minArtifactBytes) {
    throw new Error(`Local package artifact is unexpectedly small: ${stats.size} bytes`);
  }

  const staleInputs = newestInputAfter(stats.mtimeMs);
  if (staleInputs.length > 0) {
    const message = `Local package artifact is older than package input(s):\n- ${staleInputs.join("\n- ")}`;
    if (requireCurrent) throw new Error(message);
    console.warn(`warn ${message}`);
  }

  if (runSmokeCheck) runSmoke();

  console.log(`ok   Local package artifact: ${artifact}`);
  console.log(`ok   Size: ${Math.round(stats.size / 1024 / 1024)} MB`);
  console.log(`ok   SHA-256: ${sha256(artifact)}`);
  if (staleInputs.length === 0) {
    console.log("ok   Artifact is current against package inputs.");
  }
  if (!runSmokeCheck) {
    console.log("ok   Server smoke skipped here; run scripts/smoke_tauri_server_bundle.mjs for runtime verification.");
  }
}

main();
