#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch as operatingSystemArch } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DRIVER_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "..");
const SUPPORT_DIR = join(SCRIPT_DIR, "macos-media-runtime");
const MANIFEST_PATH = join(SUPPORT_DIR, "manifest.json");
const PATCH_PATH = join(SUPPORT_DIR, "target-macos11.patch");
const X264_BUILD_PATH = join(SUPPORT_DIR, "build-x264.sh");
const SOURCE_NOTICES_PATH = join(SUPPORT_DIR, "SOURCE-NOTICES.md");
const DOCUMENTATION_PATH = join(REPOSITORY_ROOT, "docs", "MACOS_MEDIA_RUNTIME.md");
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const REQUIRED_TOOLS = [
  "aclocal",
  "clang",
  "cmake",
  "curl",
  "git",
  "make",
  "meson",
  "nasm",
  "ninja",
  "patch",
  "perl",
  "pkg-config",
  "shasum",
  "tar",
  "xcrun",
];

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadMediaRuntimeManifest(path = MANIFEST_PATH) {
  const manifest = readJson(path);
  validateManifest(manifest);
  return manifest;
}

function requireHttps(url, label) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${label} must use credential-free HTTPS`);
  }
}

function requireHex(value, length, label) {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    throw new Error(`${label} must be a ${length}-character lowercase hexadecimal pin`);
  }
}

export function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1) throw new Error("unsupported media runtime manifest");
  if (manifest.target !== "11.0") throw new Error("the media runtime target must remain macOS 11.0");
  if (!Number.isInteger(manifest.defaultJobs) || manifest.defaultJobs !== 8) {
    throw new Error("the default media runtime job count must remain 8");
  }
  if (!Number.isInteger(manifest.maximumJobs) || manifest.maximumJobs < 8) {
    throw new Error("the maximum media runtime job count is invalid");
  }
  for (const [label, source] of [
    ["upstream recipe", manifest.upstreamRecipe],
    ["x264", manifest.x264],
  ]) {
    requireHttps(source.url, label);
    requireHex(source.commit, 40, `${label} commit`);
    requireHex(source.sha256, 64, `${label} SHA-256`);
    if (!Number.isInteger(source.bytes) || source.bytes < 1 || source.bytes > MAX_ARCHIVE_BYTES) {
      throw new Error(`${label} archive size is outside the allowed range`);
    }
  }
  if (!Array.isArray(manifest.gitSources) || manifest.gitSources.length !== 2) {
    throw new Error("the two prototype Git sources must be pinned");
  }
  for (const source of manifest.gitSources) {
    requireHttps(source.url, `${source.name} repository`);
    requireHex(source.commit, 40, `${source.name} commit`);
    if (typeof source.tag !== "string" || source.tag.length === 0) {
      throw new Error(`${source.name} acquisition tag is missing`);
    }
    const submodules = Object.entries(source.submodules ?? {});
    if (submodules.length === 0) throw new Error(`${source.name} submodule pins are missing`);
    for (const [path, commit] of submodules) {
      if (path.startsWith("/") || path.split("/").includes("..")) {
        throw new Error(`${source.name} has an unsafe submodule path`);
      }
      requireHex(commit, 40, `${source.name} submodule ${path}`);
    }
  }
  return manifest;
}

function normalizeArchitecture(value) {
  if (value === "x64") return "x86_64";
  if (value === "aarch64") return "arm64";
  return value;
}

export function assertNativeArchitecture({
  platform = process.platform,
  hostArch = operatingSystemArch(),
  requestedArch = normalizeArchitecture(hostArch),
} = {}) {
  const host = normalizeArchitecture(hostArch);
  const requested = normalizeArchitecture(requestedArch);
  if (platform !== "darwin") throw new Error("the media runtime can only be built on macOS");
  if (!new Set(["arm64", "x86_64"]).has(host)) {
    throw new Error(`unsupported native macOS architecture: ${host}`);
  }
  if (!new Set(["arm64", "x86_64"]).has(requested)) {
    throw new Error(`unsupported requested architecture: ${requested}`);
  }
  if (requested !== host) {
    throw new Error(`cross-compilation is not allowed: host ${host}, requested ${requested}`);
  }
  return requested;
}

function validateJobs(value, maximum) {
  const jobs = Number(value);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > maximum) {
    throw new Error(`jobs must be an integer between 1 and ${maximum}`);
  }
  return jobs;
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : undefined,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.inherit ? "" : `\n${result.stderr || result.stdout || ""}`;
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}${detail}`);
  }
  return options.inherit ? "" : result.stdout.trim();
}

function sanitizedEnvironment(extra = {}) {
  const environment = { ...process.env, ...extra };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("DYLD_")) delete environment[key];
  }
  return environment;
}

function verifyArchive(path, source) {
  const size = statSync(path).size;
  if (size !== source.bytes) {
    throw new Error(`${source.name} archive size mismatch: expected ${source.bytes}, got ${size}`);
  }
  const digest = sha256File(path);
  if (digest !== source.sha256) {
    throw new Error(`${source.name} SHA-256 mismatch: expected ${source.sha256}, got ${digest}`);
  }
  return { bytes: size, sha256: digest };
}

function defaultDownload(url, destination) {
  runChecked("curl", [
    "--proto",
    "=https",
    "--tlsv1.2",
    "-fL",
    "--retry",
    "3",
    "--retry-delay",
    "5",
    "--max-filesize",
    String(MAX_ARCHIVE_BYTES),
    "-o",
    destination,
    url,
  ]);
}

export function acquireVerifiedArchive(source, destination, { download = defaultDownload } = {}) {
  requireHttps(source.url, source.name);
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) {
    return { path: destination, reused: true, ...verifyArchive(destination, source) };
  }
  const temporary = `${destination}.partial-${process.pid}-${Date.now()}`;
  try {
    download(source.url, temporary, source);
    const verified = verifyArchive(temporary, source);
    renameSync(temporary, destination);
    return { path: destination, reused: false, ...verified };
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function createBuildPlan(manifest, { arch, jobs }) {
  validateManifest(manifest);
  return {
    target: manifest.target,
    architecture: arch,
    jobs,
    packagesBeforeFfmpeg: ["x264"],
    ffmpegPrograms: { ffmpeg: true, ffprobe: true, ffplay: false },
    ffmpegFlags: ["--enable-gpl", "--enable-version3", "--enable-libx264"],
    verification: {
      buildStage: "generated-config-and-installed-files",
      executableEncoderSmoke: "deferred-until-relocated-staging",
    },
    requiredProducts: ["bin/ffmpeg", "bin/ffprobe", "lib/libmpv*.dylib", "lib/libx264*.dylib"],
    forbiddenOperations: ["brew install", "codesign", "vtool", "cross-compile", "DYLD_*"],
    outputContract: [
      `install/${arch}/bin/ffmpeg`,
      `install/${arch}/bin/ffprobe`,
      `install/${arch}/lib/libmpv*.dylib`,
      `install/${arch}/lib/libx264*.dylib`,
      "provenance.json",
      "yawf-macos-media-runtime-source-<identity>.tar.gz",
      "SHA256SUMS",
    ],
    sources: {
      upstreamRecipe: manifest.upstreamRecipe,
      x264: manifest.x264,
      git: manifest.gitSources,
    },
  };
}

export function assertAllowedCommand(command, args = [], options = {}) {
  const executable = basename(command);
  if (new Set(["brew", "codesign", "vtool"]).has(executable)) {
    throw new Error(`forbidden media runtime command: ${executable}`);
  }
  const rendered = [command, ...args].join(" ");
  if (/--enable-cross-compile|\bDYLD_[A-Z_]*=/.test(rendered)) {
    throw new Error(`forbidden media runtime build option: ${rendered}`);
  }
  for (const key of Object.keys(options.env ?? {})) {
    if (key.startsWith("DYLD_")) throw new Error(`forbidden media runtime environment: ${key}`);
  }
}

function recipeIdentity(manifest, arch, jobs) {
  const ownedFiles = [DRIVER_PATH, PATCH_PATH, X264_BUILD_PATH, SOURCE_NOTICES_PATH, DOCUMENTATION_PATH]
    .map((path) => [relative(REPOSITORY_ROOT, path), sha256File(path)]);
  return sha256Buffer(Buffer.from(JSON.stringify({ manifest, arch, jobs, ownedFiles }))).slice(0, 20);
}

function assertOwnedPath(root, candidate) {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (relativePath === "" || relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    throw new Error(`refusing to modify a path outside the owned build root: ${candidate}`);
  }
}

function makeOwnedRoot(workspace, identity, arch, jobs, manifest) {
  const base = resolve(workspace);
  mkdirSync(base, { recursive: true });
  const root = join(base, `yawf-macos-media-runtime-${arch}-${identity}`);
  const marker = join(root, ".yawf-media-runtime-workspace.json");
  const expected = { schemaVersion: 1, identity, arch, jobs, target: manifest.target };
  if (existsSync(root)) {
    if (!existsSync(marker)) throw new Error(`existing build root is not owned by this recipe: ${root}`);
    if (JSON.stringify(readJson(marker)) !== JSON.stringify(expected)) {
      throw new Error(`existing build root identity does not match: ${root}`);
    }
  } else {
    mkdirSync(root, { recursive: true });
    writeFileSync(marker, `${JSON.stringify(expected, null, 2)}\n`, { flag: "wx" });
  }
  return root;
}

function extractRecipe(archive, root, runCommand) {
  const recipe = join(root, "recipe");
  const marker = join(recipe, ".yawf-prepared-recipe.json");
  if (existsSync(marker)) return recipe;
  if (existsSync(recipe)) {
    assertOwnedPath(root, recipe);
    rmSync(recipe, { recursive: true, force: true });
  }
  const extraction = join(root, "recipe-extraction");
  if (existsSync(extraction)) {
    assertOwnedPath(root, extraction);
    rmSync(extraction, { recursive: true, force: true });
  }
  mkdirSync(extraction, { recursive: true });
  runCommand("tar", ["-xzf", archive, "-C", extraction]);
  const entries = readdirSync(extraction).filter((entry) => !entry.startsWith("."));
  if (entries.length !== 1 || !statSync(join(extraction, entries[0])).isDirectory()) {
    throw new Error("upstream recipe archive must contain one top-level directory");
  }
  renameSync(join(extraction, entries[0]), recipe);
  assertOwnedPath(root, extraction);
  rmSync(extraction, { recursive: true, force: true });
  return recipe;
}

function prepareRecipe(recipe, identity, runCommand) {
  const marker = join(recipe, ".yawf-prepared-recipe.json");
  if (existsSync(marker)) {
    const prepared = readJson(marker);
    if (prepared.identity !== identity) throw new Error("prepared recipe identity mismatch");
    return;
  }
  runCommand("patch", ["-p1", "--forward", "-i", PATCH_PATH], { cwd: recipe });
  const destination = join(recipe, "buildscripts", "build-x264.sh");
  copyFileSync(X264_BUILD_PATH, destination);
  chmodSync(destination, 0o755);
  const common = readFileSync(join(recipe, "buildscripts", "common.sh"), "utf8");
  const ffmpeg = readFileSync(join(recipe, "buildscripts", "build-ffmpeg.sh"), "utf8");
  const build = readFileSync(join(recipe, "build.sh"), "utf8");
  for (const required of [
    'MACOSX_DEPLOYMENT_TARGET="11.0"',
    "--proto '=https'",
    "SOURCE_ARCHIVE_MAX_BYTES",
  ]) {
    if (!common.includes(required)) throw new Error(`prepared recipe is missing ${required}`);
  }
  for (const flag of ["--enable-gpl", "--enable-version3", "--enable-libx264", "--enable-ffmpeg", "--enable-ffprobe", "--disable-ffplay"]) {
    if (!ffmpeg.includes(flag)) throw new Error(`prepared FFmpeg recipe is missing ${flag}`);
  }
  if (!build.includes("build-x264.sh") || build.indexOf("build-x264.sh") > build.indexOf("build-ffmpeg.sh")) {
    throw new Error("x264 must be built before FFmpeg");
  }
  const ownedRecipeText = [common, ffmpeg, build, readFileSync(destination, "utf8")].join("\n");
  if (/\b(vtool|codesign)\b/.test(ownedRecipeText)) {
    throw new Error("the media runtime recipe must not rewrite or sign Mach-O files");
  }
  writeFileSync(marker, `${JSON.stringify({ schemaVersion: 1, identity }, null, 2)}\n`, { flag: "wx" });
}

function parseSubmoduleStatus(output) {
  const result = new Map();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^[-+ U]?([0-9a-f]{40})\s+([^\s]+)(?:\s|$)/);
    if (!match) throw new Error(`unsupported git submodule status line: ${line}`);
    result.set(match[2], match[1]);
  }
  return result;
}

export function verifyPinnedGitSource(source, directory, runCapture = runChecked) {
  const head = runCapture("git", ["-C", directory, "rev-parse", "HEAD"]);
  if (head !== source.commit) {
    throw new Error(`${source.name} resolved to ${head}, expected ${source.commit}`);
  }
  const actual = parseSubmoduleStatus(
    runCapture("git", ["-C", directory, "submodule", "status", "--recursive"]),
  );
  const expected = new Map(Object.entries(source.submodules));
  if (actual.size !== expected.size) {
    throw new Error(`${source.name} submodule inventory count mismatch`);
  }
  for (const [path, commit] of expected) {
    if (actual.get(path) !== commit) {
      throw new Error(`${source.name} submodule ${path} is not pinned to ${commit}`);
    }
  }
}

function acquirePinnedGitSource(source, sourcesDirectory, runCommand, runCapture) {
  const destination = join(sourcesDirectory, source.directory);
  if (!existsSync(destination)) {
    runCommand("git", [
      "-c",
      "protocol.file.allow=never",
      "clone",
      "--recurse-submodules",
      "--depth",
      "1",
      "--branch",
      source.tag,
      "--",
      source.url,
      destination,
    ]);
  }
  verifyPinnedGitSource(source, destination, runCapture);
  return destination;
}

function walkFiles(root, { exclude = () => false } = {}) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join("/");
      if (exclude(relativePath, entry)) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push({ path, relativePath });
    }
  }
  if (existsSync(root)) visit(root);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

const ARCHIVE_PATTERN = /\.(?:tar\.(?:gz|xz|bz2)|tgz|zip)$/i;
const NOTICE_PATTERN = /(?:^|\/)(?:license|copying|notice|copyright|authors)(?:[._-].*)?$/i;

export function collectSourceInventory(sourcesDirectory, manifest) {
  const files = walkFiles(sourcesDirectory, {
    exclude: (path) => path.split("/").includes(".git"),
  });
  return {
    components: readdirSync(sourcesDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort(),
    archives: files.filter(({ relativePath }) => ARCHIVE_PATTERN.test(relativePath)).map(({ path, relativePath }) => ({
      path: relativePath,
      bytes: statSync(path).size,
      sha256: sha256File(path),
    })),
    notices: files.filter(({ relativePath }) => NOTICE_PATTERN.test(relativePath)).map(({ path, relativePath }) => ({
      path: relativePath,
      sha256: sha256File(path),
    })),
    gitSources: manifest.gitSources.map(({ name, directory, commit, submodules, url }) => ({
      name,
      directory,
      commit,
      submodules,
      url,
    })),
  };
}

function findMatchingFiles(root, pattern) {
  return walkFiles(root).filter(({ relativePath }) => pattern.test(relativePath));
}

export function verifyInstallTree(installDirectory) {
  for (const program of ["bin/ffmpeg", "bin/ffprobe"]) {
    if (!existsSync(join(installDirectory, program))) throw new Error(`missing installed ${program}`);
  }
  if (existsSync(join(installDirectory, "bin", "ffplay"))) throw new Error("ffplay must not be installed");
  const mpv = findMatchingFiles(installDirectory, /(?:^|\/)libmpv[^/]*\.dylib$/);
  const x264 = findMatchingFiles(installDirectory, /(?:^|\/)libx264[^/]*\.dylib$/);
  if (mpv.length === 0) throw new Error("installed libmpv dylib is missing");
  if (x264.length === 0) throw new Error("installed shared libx264 dylib is missing");
  return {
    ffmpeg: join(installDirectory, "bin", "ffmpeg"),
    ffprobe: join(installDirectory, "bin", "ffprobe"),
    mpv: mpv.map(({ relativePath }) => relativePath),
    x264: x264.map(({ relativePath }) => relativePath),
  };
}

export function verifyBuildInstallPrefix(buildInstallPrefix, installInventory) {
  if (!existsSync(buildInstallPrefix) || !lstatSync(buildInstallPrefix).isDirectory()) {
    throw new Error(`original build install prefix is missing: ${buildInstallPrefix}`);
  }
  if (!Array.isArray(installInventory) || installInventory.length === 0) {
    throw new Error("recorded install inventory is missing");
  }
  const actualFiles = new Map(
    walkFiles(buildInstallPrefix).map(({ path, relativePath }) => [relativePath, path]),
  );
  const recordedPaths = new Set();
  for (const recorded of installInventory) {
    if (
      typeof recorded?.path !== "string" ||
      recorded.path.length === 0 ||
      recorded.path.startsWith("/") ||
      recorded.path.split("/").includes("..") ||
      !Number.isInteger(recorded.bytes) ||
      typeof recorded.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(recorded.sha256) ||
      recordedPaths.has(recorded.path)
    ) {
      throw new Error("recorded install inventory contains an invalid entry");
    }
    recordedPaths.add(recorded.path);
    const actualPath = actualFiles.get(recorded.path);
    if (!actualPath) {
      throw new Error(`original build install prefix is missing recorded file: ${recorded.path}`);
    }
    const actualBytes = statSync(actualPath).size;
    const actualSha256 = sha256File(actualPath);
    if (actualBytes !== recorded.bytes || actualSha256 !== recorded.sha256) {
      throw new Error(`original build install prefix file was changed: ${recorded.path}`);
    }
  }
  if (actualFiles.size !== recordedPaths.size) {
    throw new Error(
      `original build install prefix file count mismatch: expected ${recordedPaths.size}, got ${actualFiles.size}`,
    );
  }
  return buildInstallPrefix;
}

export function verifyFfmpegBuildConfiguration(recipeDirectory, arch) {
  const configPath = join(recipeDirectory, "build", "ffmpeg", arch, "config.h");
  if (!existsSync(configPath)) throw new Error("FFmpeg build configuration is missing");
  const config = readFileSync(configPath, "utf8");
  const required = {
    CONFIG_LIBX264: 1,
    CONFIG_FFMPEG: 1,
    CONFIG_FFPROBE: 1,
    CONFIG_FFPLAY: 0,
  };
  for (const [name, value] of Object.entries(required)) {
    if (!new RegExp(`^#define ${name} ${value}$`, "m").test(config)) {
      throw new Error(`FFmpeg build configuration must set ${name} to ${value}`);
    }
  }
  return {
    path: `build/ffmpeg/${arch}/config.h`,
    sha256: sha256File(configPath),
    libx264: true,
    programs: { ffmpeg: true, ffprobe: true, ffplay: false },
    executableEncoderSmokeDeferredUntilRelocation: true,
  };
}

const GENERATED_COMPONENT_BINARY_DIRECTORY = /(?:^|\/)Bin\/Release(?:\/|$)/;
const COMPILED_BINARY_FILENAME = /(?:\.dylib|\.so(?:\.\d+)*|\.a|\.o|\.obj|\.dll|\.exe|\.pdb)$/i;
const SVT_RELEASE_EXECUTABLE = /^SvtAv1[^/]*App$/;

function excludeComponentSourcePath(relativePath) {
  const normalized = relativePath.split(sep).join("/");
  const parts = normalized.split("/");
  if (
    parts.some(
      (part) =>
        part === ".git" ||
        part.startsWith(".tmp_extract_") ||
        part.endsWith(".partial"),
    )
  ) {
    return true;
  }
  if (!GENERATED_COMPONENT_BINARY_DIRECTORY.test(normalized)) return false;
  const name = basename(normalized);
  return COMPILED_BINARY_FILENAME.test(name) || SVT_RELEASE_EXECUTABLE.test(name);
}

export function copyComponentSources(source, destination) {
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter: (path) => !excludeComponentSourcePath(relative(source, path)),
  });
}

function writeChecksumFile(root, destination) {
  const destinationRelative = relative(root, destination).split(sep).join("/");
  const lines = walkFiles(root)
    .filter(({ relativePath }) => relativePath !== destinationRelative)
    .map(({ path, relativePath }) => `${sha256File(path)}  ${relativePath}`);
  writeFileSync(destination, `${lines.join("\n")}\n`);
  return lines.length;
}

export function createSourceBundleManifest(manifest, sourceInventory) {
  const ownedFiles = [
    DRIVER_PATH,
    MANIFEST_PATH,
    PATCH_PATH,
    X264_BUILD_PATH,
    SOURCE_NOTICES_PATH,
    DOCUMENTATION_PATH,
  ].map((path) => ({
    path: relative(REPOSITORY_ROOT, path).split(sep).join("/"),
    bytes: statSync(path).size,
    sha256: sha256File(path),
  }));
  return {
    schemaVersion: 1,
    licensingCleared: false,
    upstreamRecipe: {
      name: manifest.upstreamRecipe.name,
      url: manifest.upstreamRecipe.url,
      commit: manifest.upstreamRecipe.commit,
      archive: manifest.upstreamRecipe.archive,
      bytes: manifest.upstreamRecipe.bytes,
      sha256: manifest.upstreamRecipe.sha256,
      bundled: false,
      redistributionRights: "unresolved",
    },
    ownedFiles,
    componentSources: sourceInventory,
    excluded: [
      "upstream recipe archive and tree because redistribution rights are unresolved",
      "known generated compiled binaries from in-tree build output directories",
      ".git metadata and temporary files",
    ],
  };
}

function archiveEvidence(source, acquired) {
  return {
    name: source.name,
    url: source.url,
    commit: source.commit,
    archive: source.archive,
    bytes: acquired.bytes,
    sha256: acquired.sha256,
    reused: acquired.reused,
  };
}

export function resolveBuildOutputContract(root, provenance, { reused = false } = {}) {
  const arch = provenance?.architecture;
  if (!new Set(["arm64", "x86_64"]).has(arch)) {
    throw new Error("provenance architecture is invalid");
  }
  const expectedArtifactPrefix = `install/${arch}`;
  if (provenance.installPrefix !== expectedArtifactPrefix) {
    throw new Error("provenance artifact install prefix is invalid");
  }
  if (
    typeof provenance.sourceBundle?.file !== "string" ||
    basename(provenance.sourceBundle.file) !== provenance.sourceBundle.file
  ) {
    throw new Error("provenance source bundle path is invalid");
  }
  const artifacts = join(root, "artifacts");
  const buildInstallPrefix = join(root, "recipe", "install", arch);
  verifyBuildInstallPrefix(buildInstallPrefix, provenance.installInventory);
  return {
    artifacts,
    installPrefix: join(artifacts, "install", arch),
    buildInstallPrefix,
    provenance: join(artifacts, "provenance.json"),
    sourceBundle: join(artifacts, provenance.sourceBundle.file),
    reused,
  };
}

function createArtifacts({
  root,
  recipe,
  manifest,
  arch,
  jobs,
  identity,
  plan,
  runCommand,
  acquired,
  ffmpegConfiguration,
}) {
  const artifacts = join(root, "artifacts");
  const staging = join(root, "artifacts-staging");
  for (const path of [artifacts, staging]) {
    if (existsSync(path)) {
      assertOwnedPath(root, path);
      rmSync(path, { recursive: true, force: true });
    }
  }
  mkdirSync(staging, { recursive: true });
  const installSource = join(recipe, "install", arch);
  const install = join(staging, "install", arch);
  cpSync(installSource, install, { recursive: true, dereference: false });

  const sourceBundleRoot = join(root, "corresponding-source-staging");
  if (existsSync(sourceBundleRoot)) {
    assertOwnedPath(root, sourceBundleRoot);
    rmSync(sourceBundleRoot, { recursive: true, force: true });
  }
  const bundle = join(sourceBundleRoot, "yawf-macos-media-runtime-source");
  mkdirSync(bundle, { recursive: true });
  copyComponentSources(join(recipe, "sources"), join(bundle, "component-sources"));
  for (const path of [
    DRIVER_PATH,
    MANIFEST_PATH,
    PATCH_PATH,
    X264_BUILD_PATH,
    SOURCE_NOTICES_PATH,
    DOCUMENTATION_PATH,
  ]) {
    const destination = join(bundle, relative(REPOSITORY_ROOT, path));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(path, destination);
  }
  const sourceInventory = collectSourceInventory(join(recipe, "sources"), manifest);
  writeFileSync(join(bundle, "SOURCE-INVENTORY.json"), `${JSON.stringify(sourceInventory, null, 2)}\n`);
  const sourceBundleManifest = createSourceBundleManifest(manifest, sourceInventory);
  writeFileSync(
    join(bundle, "SOURCE-BUNDLE-MANIFEST.json"),
    `${JSON.stringify(sourceBundleManifest, null, 2)}\n`,
  );
  writeChecksumFile(bundle, join(bundle, "SHA256SUMS"));

  const sourceArchive = join(staging, `yawf-macos-media-runtime-source-${identity}.tar.gz`);
  runCommand("tar", ["-czf", sourceArchive, "-C", sourceBundleRoot, basename(bundle)]);
  assertOwnedPath(root, sourceBundleRoot);
  rmSync(sourceBundleRoot, { recursive: true, force: true });

  const installInventory = walkFiles(install).map(({ path, relativePath }) => ({
    path: relativePath,
    bytes: statSync(path).size,
    sha256: sha256File(path),
  }));
  const provenance = {
    schemaVersion: 1,
    identity,
    architecture: arch,
    target: manifest.target,
    jobs,
    installPrefix: `install/${arch}`,
    installPrefixPurpose: "unrelocated-artifact-evidence-only",
    buildInstallPrefixRelativeToBuildRoot: `recipe/install/${arch}`,
    buildInstallPrefixPurpose: "private-in-place-relocation-input",
    plan,
    upstreamRecipe: {
      ...manifest.upstreamRecipe,
      redistributionRights: "unresolved",
      bundledInCorrespondingSource: false,
    },
    acquired: {
      upstreamRecipe: archiveEvidence(manifest.upstreamRecipe, acquired.upstreamRecipe),
      x264: archiveEvidence(manifest.x264, acquired.x264),
    },
    gitSources: manifest.gitSources,
    ffmpegConfiguration,
    sourceInventory,
    installInventory,
    sourceBundle: {
      file: basename(sourceArchive),
      bytes: statSync(sourceArchive).size,
      sha256: sha256File(sourceArchive),
      manifest: "SOURCE-BUNDLE-MANIFEST.json",
    },
    licensingCleared: false,
    dyldEnvironmentUsed: false,
    signingPerformed: false,
    machoMinimumRewritten: false,
  };
  writeFileSync(join(staging, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  writeChecksumFile(staging, join(staging, "SHA256SUMS"));
  renameSync(staging, artifacts);
  return resolveBuildOutputContract(root, provenance);
}

function verifyCompletedArtifacts(root) {
  const artifacts = join(root, "artifacts");
  const checksumPath = join(artifacts, "SHA256SUMS");
  if (!existsSync(checksumPath)) return null;
  for (const line of readFileSync(checksumPath, "utf8").trim().split("\n")) {
    if (!line) continue;
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (!match) throw new Error("invalid artifact checksum file");
    const path = join(artifacts, ...match[2].split("/"));
    if (!existsSync(path) || sha256File(path) !== match[1]) {
      throw new Error(`completed artifact checksum mismatch: ${match[2]}`);
    }
  }
  const provenance = readJson(join(artifacts, "provenance.json"));
  return resolveBuildOutputContract(root, provenance, { reused: true });
}

function checkRequiredTools(runCapture) {
  for (const tool of REQUIRED_TOOLS) runCapture("/usr/bin/which", [tool]);
}

export async function buildMacosMediaRuntime({
  workspace,
  requestedArch,
  jobs: requestedJobs,
  platform = process.platform,
  hostArch = operatingSystemArch(),
  manifest = loadMediaRuntimeManifest(),
  download = defaultDownload,
  runCommand = runChecked,
  runCapture = runChecked,
  checkTools = true,
} = {}) {
  if (!workspace) throw new Error("--workspace is required");
  validateManifest(manifest);
  const arch = assertNativeArchitecture({ platform, hostArch, requestedArch });
  const jobs = validateJobs(requestedJobs ?? manifest.defaultJobs, manifest.maximumJobs);
  const plan = createBuildPlan(manifest, { arch, jobs });
  const guardedRun = (command, args, options) => {
    assertAllowedCommand(command, args, options);
    return runCommand(command, args, options);
  };
  const guardedCapture = (command, args, options) => {
    assertAllowedCommand(command, args, options);
    return runCapture(command, args, options);
  };
  if (checkTools) checkRequiredTools(guardedCapture);
  const identity = recipeIdentity(manifest, arch, jobs);
  const root = makeOwnedRoot(workspace, identity, arch, jobs, manifest);
  const completed = verifyCompletedArtifacts(root);
  if (completed) return { ...completed, root, identity, plan };

  const downloads = join(root, "downloads");
  const recipeArchive = acquireVerifiedArchive(
    manifest.upstreamRecipe,
    join(downloads, manifest.upstreamRecipe.archive),
    { download },
  );
  const recipe = extractRecipe(recipeArchive.path, root, guardedRun);
  prepareRecipe(recipe, identity, guardedRun);

  const x264Archive = acquireVerifiedArchive(
    manifest.x264,
    join(recipe, "sources", manifest.x264.archive),
    { download },
  );
  for (const source of manifest.gitSources) {
    acquirePinnedGitSource(source, join(recipe, "sources"), guardedRun, guardedCapture);
  }

  const environment = sanitizedEnvironment({
    ARCHS: arch,
    YAWF_MEDIA_JOBS: String(jobs),
  });
  guardedRun("/bin/bash", [join(recipe, "build.sh"), arch], {
    cwd: recipe,
    env: environment,
    inherit: true,
  });
  const install = join(recipe, "install", arch);
  verifyInstallTree(install);
  const ffmpegConfiguration = verifyFfmpegBuildConfiguration(recipe, arch);

  const result = createArtifacts({
    root,
    recipe,
    manifest,
    arch,
    jobs,
    identity,
    plan,
    runCommand: guardedRun,
    acquired: {
      upstreamRecipe: recipeArchive,
      x264: x264Archive,
    },
    ffmpegConfiguration,
  });
  return { ...result, root, identity, plan, reused: false };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (argument === "--workspace") options.workspace = argv[++index];
    else if (argument === "--arch") options.requestedArch = argv[++index];
    else if (argument === "--jobs") options.jobs = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function usage() {
  return "Usage: node scripts/build_macos_media_runtime.mjs --workspace <owned-directory> [--arch arm64|x86_64] [--jobs 1-16]";
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await buildMacosMediaRuntime(options);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
