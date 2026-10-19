#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopNodeRuntimeVersion } from "./desktop_node_runtime_policy.mjs";
import { buildMacosMediaRuntime } from "./build_macos_media_runtime.mjs";
import { stageMediaRuntime } from "./stage_macos_media_runtime.mjs";
import { smokeMediaRuntime } from "./smoke_macos_media_runtime.mjs";
import { prepareMediaNotices } from "./prepare_macos_media_notices.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "web");
const server = join(root, "server");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function nodeRuntimePlatform() {
  const os = process.platform;
  const arch = process.arch;
  if (os === "darwin" && arch === "arm64") return "darwin-arm64";
  if (os === "darwin" && arch === "x64") return "darwin-x64";
  if (os === "linux" && arch === "x64") return "linux-x64";
  if (os === "linux" && arch === "arm64") return "linux-arm64";
  if (os === "win32" && arch === "x64") return "win-x64";
  if (os === "win32" && arch === "arm64") return "win-arm64";
  throw new Error(`Unsupported desktop runtime platform: ${os}-${arch}`);
}

const runtime = nodeRuntimePlatform();
const tauriConfig = JSON.parse(readFileSync(join(web, "src-tauri", "tauri.conf.json"), "utf8"));

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function filesBelow(path) {
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const fullPath = join(path, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

async function prepareLocalMacMpv() {
  if (process.platform !== "darwin") return null;

  const tauriDir = join(web, "src-tauri");
  const frameworksDir = join(tauriDir, "Frameworks");
  const media = await buildMacosMediaRuntime({ workspace: process.env.YAWF_MEDIA_BUILD_CACHE ?? join(root, ".build", "macos-media-runtime") });
  const stagingRoot = mkdtempSync(join(media.root, "package-stage-"));
  const staging = join(stagingRoot, "runtime");
  stageMediaRuntime({ prefix: media.buildInstallPrefix, output: staging, arch: process.arch === "arm64" ? "arm64" : "x86_64" });
  smokeMediaRuntime(staging, join(stagingRoot, "smoke"));
  const notices = join(stagingRoot, "notices");
  prepareMediaNotices(media.root, notices);
  rmSync(frameworksDir, { recursive: true, force: true });
  cpSync(join(staging, "Frameworks"), frameworksDir, { recursive: true, verbatimSymlinks: true });
  const ffmpegDestination = join(tauriDir, "resources", "ffmpeg", runtime);
  mkdirSync(dirname(ffmpegDestination), { recursive: true });
  rmSync(ffmpegDestination, { recursive: true, force: true });
  cpSync(join(staging, "ffmpeg"), ffmpegDestination, { recursive: true });
  const noticeDestination = join(tauriDir, "resources", "media-notices");
  rmSync(join(noticeDestination, "components"), { recursive: true, force: true });
  cpSync(notices, noticeDestination, { recursive: true });
  const frameworks = filesBelow(frameworksDir)
    .filter((path) => path.endsWith(".dylib"))
    .map((path) => relative(tauriDir, path).split("\\").join("/"));
  if (!frameworks.some((path) => /libmpv(?:\.\d+)*\.dylib$/.test(path))) {
    throw new Error("The local macOS player bundle did not produce libmpv.");
  }
  return { frameworksDir, frameworks };
}

function localArtifactArch() {
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64";
  if (process.platform === "darwin" && process.arch === "x64") return "x64";
  return process.arch;
}

function createLocalMacDownloadArtifact() {
  if (process.platform !== "darwin") return;

  const productName = tauriConfig.productName ?? "DebridStreamer";
  const version = tauriConfig.version ?? "0.0.0";
  const bundleDir = join(web, "src-tauri", "target", "release", "bundle", "macos");
  const appName = `${productName}.app`;
  const appPath = join(bundleDir, appName);
  const zipPath = join(bundleDir, `${productName}_${version}_${localArtifactArch()}.app.zip`);

  if (!existsSync(appPath)) {
    throw new Error(`Expected app bundle missing: ${appPath}`);
  }

  const frameworksDir = join(appPath, "Contents", "Frameworks");
  const bundledFrameworks = existsSync(frameworksDir)
    ? filesBelow(frameworksDir).filter((path) => path.endsWith(".dylib"))
    : [];
  if (!bundledFrameworks.some((path) => /libmpv(?:\.\d+)*\.dylib$/.test(path))) {
    throw new Error(`Packaged app is missing bundled libmpv: ${frameworksDir}`);
  }
  const executables = readdirSync(join(appPath, "Contents", "MacOS"), {
    withFileTypes: true,
  }).filter((entry) => entry.isFile());
  if (executables.length !== 1) {
    throw new Error(`Expected one app executable, found ${executables.length}.`);
  }
  const nativeFiles = [
    join(appPath, "Contents", "MacOS", executables[0].name),
    ...bundledFrameworks,
  ];
  const buildMachinePrefixes = ["/opt/homebrew/", "/usr/local/"];
  for (const nativeFile of nativeFiles) {
    const dependencies = commandOutput("otool", ["-L", nativeFile]);
    if (buildMachinePrefixes.some((prefix) => dependencies.includes(prefix))) {
      throw new Error(`Packaged native dependency uses a build-machine path: ${nativeFile}`);
    }
  }

  run(process.execPath, ["scripts/check_macos_bundle_minimum.mjs", appPath]);

  rmSync(zipPath, { force: true });
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appName, zipPath], { cwd: bundleDir });
  console.log(`Created local macOS download artifact: ${zipPath}`);
}

run("npm", ["run", "build"], { cwd: server });
run("npm", ["run", "build"], { cwd: web });
run(process.execPath, ["scripts/prepare_tauri_server_resources.mjs"]);
run(process.execPath, ["scripts/download_tauri_node_runtime.mjs", runtime], {
  env: { NODE_RUNTIME_VERSION: desktopNodeRuntimeVersion(runtime, process.env.NODE_RUNTIME_VERSION) },
});
if (process.platform !== "darwin") run(process.execPath, ["scripts/download_ffmpeg.mjs", runtime]);
const localMacMpv = await prepareLocalMacMpv();
const localTauriConfig = {
  bundle: {
    createUpdaterArtifacts: false,
    ...(localMacMpv == null
      ? {}
      : { macOS: { frameworks: localMacMpv.frameworks } }),
  },
};
rmSync(join(web, "src-tauri", "target", "release", "bundle"), { recursive: true, force: true });
run("npm", [
  "run",
  "tauri",
  "--",
  "build",
  "--no-sign",
  ...(process.platform === "darwin" ? ["--bundles", "app"] : []),
  "--config",
  JSON.stringify(localTauriConfig),
], {
  cwd: web,
  env: localMacMpv == null ? {} : { MPV_LIB_DIR: localMacMpv.frameworksDir, MACOSX_DEPLOYMENT_TARGET: "11.0" },
});
createLocalMacDownloadArtifact();
run(process.execPath, ["scripts/smoke_tauri_server_bundle.mjs"]);
