#!/usr/bin/env node
import {
  accessSync,
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLAN_PATH = join(HERE, "replay-plan.json");
export const ROOT_MARKER = ".yawf-independent-media-replay-root.json";
export const CHILD_MARKER = ".yawf-independent-media-replay-child.json";
const VALID_ARCHES = new Set(["arm64", "x86_64"]);
const ADAPTERS = new Set(["autoconf", "cmake", "meson", "luajit-make", "mujs-make", "openssl", "x264", "ffmpeg"]);
const FORBIDDEN_TEXT = /(?:https?:\/\/|git:\/\/|\bgit\s+(?:clone|submodule)|\bcurl\b|\bwget\b)/i;
const SHIM_DENIAL_TEXT = /(?:xcrun_db|couldn't create cache file|operation not permitted)/i;
const TOOL_KEYS = ["cc", "cxx", "ar", "ranlib", "nm", "strip", "make", "pkgConfig", "metal", "metallib"];
const DARWIN_ARCHIVE_INDEX_MEMBERS = new Set(["__.SYMDEF", "__.SYMDEF SORTED"]);

function fail(message) {
  throw new Error(message);
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function sha256(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function posixRelative(path) {
  return path.split(sep).join("/");
}

function safeRelativePath(path, label = "path") {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096 || /[\0\r\n]/.test(path)) {
    fail(`${label} is invalid`);
  }
  if (isAbsolute(path) || path.split(/[\\/]/).some((part) => part === ".." || part === "")) {
    fail(`${label} must be a normalized relative path`);
  }
  return path;
}

function assertInside(root, path, label) {
  const rel = relative(root, path);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  fail(`${label} escapes its owned root`);
}

export function loadPlan(path = PLAN_PATH) {
  const plan = json(path);
  validatePlan(plan);
  return plan;
}

export function validatePlan(plan) {
  if (plan?.schemaVersion !== 1 || plan.target !== "11.0" || plan.maximumJobs !== 16) fail("replay plan header is invalid");
  if (!Array.isArray(plan.packages) || plan.packages.length !== 33) fail("replay plan must contain exactly 33 packages");
  const seen = new Set();
  for (const [index, entry] of plan.packages.entries()) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.id ?? "")) fail(`package ${index + 1} has an invalid id`);
    if (seen.has(entry.id)) fail(`duplicate package id: ${entry.id}`);
    if (!ADAPTERS.has(entry.adapter)) fail(`package ${entry.id} has an invalid adapter`);
    safeRelativePath(entry.sourceDir, `${entry.id} sourceDir`);
    if (entry.cmakeSourceSubdir) safeRelativePath(entry.cmakeSourceSubdir, `${entry.id} cmakeSourceSubdir`);
    if (!Array.isArray(entry.dependencies) || entry.dependencies.some((dependency) => !seen.has(dependency))) {
      fail(`package ${entry.id} has a missing or forward dependency`);
    }
    if (!Array.isArray(entry.options) || entry.options.some((value) => typeof value !== "string" || FORBIDDEN_TEXT.test(value))) {
      fail(`package ${entry.id} has invalid or online options`);
    }
    if (!Array.isArray(entry.expected) || entry.expected.length === 0) fail(`package ${entry.id} has no expected products`);
    for (const expected of entry.expected) {
      if (/[*?\[]/.test(expected)) fail(`package ${entry.id} expected products must be exact paths`);
      safeRelativePath(expected, `${entry.id} expected product`);
    }
    seen.add(entry.id);
  }
  return plan;
}

function walk(root, visitor, current = root) {
  for (const name of readdirSync(current)) {
    const path = join(current, name);
    const rel = posixRelative(relative(root, path));
    const info = lstatSync(path);
    visitor(path, rel, info);
    if (info.isDirectory()) walk(root, visitor, path);
  }
}

export function assertSafeTree(root) {
  const canonicalRoot = realpathSync(root);
  walk(root, (path, rel, info) => {
    safeRelativePath(rel, "source file");
    if (info.isSymbolicLink()) {
      const target = realpathSync(path);
      assertInside(canonicalRoot, target, "source symlink");
    } else if (!info.isDirectory() && !info.isFile()) {
      fail("source tree contains an unsupported special file");
    }
  });
}

function checksumEntries(sourceRoot) {
  const checksumPath = join(sourceRoot, "SHA256SUMS");
  if (!existsSync(checksumPath)) fail("source bundle SHA256SUMS is missing");
  const entries = new Map();
  for (const line of readFileSync(checksumPath, "utf8").split("\n")) {
    if (!line) continue;
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) fail("source bundle checksum line is malformed");
    const path = safeRelativePath(match[2], "source checksum path");
    if (path === "SHA256SUMS" || entries.has(path)) fail("source bundle checksum inventory is invalid");
    entries.set(path, match[1]);
  }
  return entries;
}

export function verifySourceBundle(sourceRoot, plan = loadPlan()) {
  const root = realpathSync(sourceRoot);
  const components = join(root, "component-sources");
  if (!statSync(components, { throwIfNoEntry: false })?.isDirectory()) fail("component-sources directory is missing");
  assertSafeTree(root);
  const checksums = checksumEntries(root);
  const observed = new Set();
  walk(root, (path, rel, info) => {
    // The source-bundle checksum writer inventories regular files. Symlinks are
    // separately constrained to targets inside the source bundle.
    if (rel === "SHA256SUMS" || info.isDirectory() || info.isSymbolicLink()) return;
    const expected = checksums.get(rel);
    if (!expected) fail("source bundle contains a file absent from its checksum inventory");
    if (sha256(path) !== expected) fail("source bundle checksum mismatch");
    observed.add(rel);
  });
  if (observed.size !== checksums.size) fail("source bundle checksum inventory contains a missing file");
  const inventoryPath = join(root, "SOURCE-INVENTORY.json");
  const inventory = json(inventoryPath);
  const expectedComponents = [...plan.packages.map((entry) => entry.sourceDir)].sort();
  const actualComponents = [...(inventory.components ?? [])].sort();
  if (JSON.stringify(expectedComponents) !== JSON.stringify(actualComponents)) fail("source component inventory does not match the replay plan");
  for (const sourceDir of expectedComponents) {
    const path = join(components, sourceDir);
    assertInside(components, path, "component source");
    if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) fail("a planned component source tree is missing or aliased");
    assertInside(realpathSync(components), realpathSync(path), "component source root");
  }
  return { root, components, files: observed.size, componentsCount: actualComponents.length };
}

export function initializeOutputRoot(outputRoot) {
  const root = resolve(outputRoot);
  if (existsSync(root)) {
    if (!lstatSync(root).isDirectory()) fail("output root is not a directory");
    if (readdirSync(root).length !== 0) fail("output root must be empty before initialization");
  } else {
    mkdirSync(root, { recursive: true });
  }
  writeJsonAtomic(join(root, ROOT_MARKER), { schemaVersion: 1, purpose: "yawf-independent-media-replay", createdBy: basename(fileURLToPath(import.meta.url)) });
  return root;
}

export function assertOwnedOutputRoot(outputRoot) {
  const root = realpathSync(outputRoot);
  const marker = json(join(root, ROOT_MARKER));
  if (marker?.schemaVersion !== 1 || marker.purpose !== "yawf-independent-media-replay") fail("output root is not marked for independent media replay");
  return root;
}

export function assertNativeArchitecture(requested, actual = process.arch) {
  if (!VALID_ARCHES.has(requested)) fail("architecture must be arm64 or x86_64");
  const normalized = actual === "x64" ? "x86_64" : actual;
  if (normalized !== requested) fail("replay is native-only and requested architecture does not match the host");
}

function replaceTokens(value, context) {
  return value.replaceAll("{swiftTarget}", `${context.arch}-apple-macosx11.0`);
}

function commonCmake(context) {
  return [
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
    `-DCMAKE_INSTALL_PREFIX=${context.prefix}`,
    "-DCMAKE_INSTALL_LIBDIR=lib",
    `-DCMAKE_OSX_ARCHITECTURES=${context.arch}`,
    "-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0",
    `-DCMAKE_OSX_SYSROOT=${context.sdk}`,
    `-DCMAKE_C_COMPILER=${context.cc}`,
    `-DCMAKE_CXX_COMPILER=${context.cxx}`,
    `-DCMAKE_AR=${context.ar}`,
    `-DCMAKE_RANLIB=${context.ranlib}`,
    `-DCMAKE_NM=${context.nm}`,
    `-DCMAKE_STRIP=${context.strip}`,
    `-DCMAKE_PREFIX_PATH=${context.prefix}`,
    `-DCMAKE_FIND_ROOT_PATH=${context.prefix};${context.sdk}`,
    "-DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY",
    "-DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY",
    "-DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=ONLY",
    "-DCMAKE_FIND_USE_PACKAGE_REGISTRY=FALSE",
    "-DCMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY=FALSE",
    "-DCMAKE_IGNORE_PREFIX_PATH=/opt/homebrew;/usr/local",
    "-DFETCHCONTENT_FULLY_DISCONNECTED=ON",
  ];
}

function makeCommands(context, cwd, targets, variables = []) {
  return targets.map((target) => ({ command: context.make, args: [`-j${context.jobs}`, ...variables, target], cwd }));
}

export function renderPackageCommands(entry, context) {
  const source = join(context.sources, entry.sourceDir);
  const build = join(context.builds, entry.id);
  const options = entry.options.map((value) => replaceTokens(value, context));
  const prefixAndHost = [`--prefix=${context.prefix}`, `--host=${context.host}`];
  let commands;
  switch (entry.adapter) {
    case "autoconf": {
      // libvorbis 1.3.7's generated Darwin configure branch replaces the
      // supplied CFLAGS with an obsolete linker flag. Override that package's
      // Make variable without changing the pinned vendor source tree.
      const makeVariables = entry.id === "libvorbis"
        ? [`CFLAGS=${context.cflags} -DDARWIN -fno-common -Wall -ffast-math -fsigned-char`]
        : [];
      commands = [
        { command: join(source, "configure"), args: [...prefixAndHost, ...options], cwd: build },
        ...makeCommands(context, build, ["all", "install"], makeVariables),
      ];
      break;
    }
    case "cmake": {
      const cmakeSource = entry.cmakeSourceSubdir ? join(source, entry.cmakeSourceSubdir) : source;
      commands = [
        { command: context.tool("cmake"), args: ["-S", cmakeSource, "-B", build, ...commonCmake(context), ...options], cwd: context.child },
        { command: context.tool("cmake"), args: ["--build", build, "--parallel", String(context.jobs)], cwd: context.child },
        { command: context.tool("cmake"), args: ["--install", build], cwd: context.child },
      ];
      break;
    }
    case "meson":
      commands = [
        {
          command: context.tool("meson"),
          args: [
            "setup", build, source, `--native-file=${context.machineFile}`,
            `--prefix=${context.prefix}`, "--wrap-mode=nofallback", ...options,
          ],
          cwd: context.child,
        },
        { command: context.tool("meson"), args: ["compile", "-C", build, "-j", String(context.jobs)], cwd: context.child },
        { command: context.tool("meson"), args: ["install", "-C", build], cwd: context.child },
      ];
      break;
    case "luajit-make":
      commands = makeCommands(context, source, ["amalg", "install"], [
        `PREFIX=${context.prefix}`, "MACOSX_DEPLOYMENT_TARGET=11.0", `CC=${context.cc}`,
        `CFLAGS=${context.cflags}`, `LDFLAGS=${context.ldflags}`,
      ]);
      break;
    case "mujs-make":
      commands = [
        ...makeCommands(context, source, options, [`prefix=${context.prefix}`, `CC=${context.cc}`, `CFLAGS=${context.cflags}`]),
        ...makeCommands(context, source, ["install", "install-shared"], [`prefix=${context.prefix}`, `CC=${context.cc}`, `CFLAGS=${context.cflags}`]),
      ];
      break;
    case "openssl":
      commands = [
        { command: join(source, "Configure"), args: [context.arch === "arm64" ? "darwin64-arm64-cc" : "darwin64-x86_64-cc", `--prefix=${context.prefix}`, ...options], cwd: build },
        ...makeCommands(context, build, ["all", "install_sw"]),
      ];
      break;
    case "x264":
      commands = [
        { command: join(source, "configure"), args: [...prefixAndHost, ...options, `--extra-cflags=${context.cflags}`, `--extra-ldflags=${context.ldflags}`], cwd: build },
        ...makeCommands(context, build, ["all", "install"]),
      ];
      break;
    case "ffmpeg":
      commands = [
        { command: join(source, "configure"), args: [`--prefix=${context.prefix}`, `--arch=${context.arch}`, "--target-os=darwin", `--cc=${context.cc}`, `--cxx=${context.cxx}`, `--ar=${context.ar}`, `--ranlib=${context.ranlib}`, `--nm=${context.nm}`, `--strip=${context.strip}`, `--pkg-config=${context.pkgConfig}`, `--metalcc=${context.metal} -fmodules-cache-path=${context.metalModuleCache}`, `--metallib=${context.metallib}`, `--extra-cflags=${context.cflags} -I${context.prefix}/include`, `--extra-ldflags=${context.ldflags} -L${context.prefix}/lib`, ...options], cwd: build },
        ...makeCommands(context, build, ["all", "install"]),
      ];
      break;
    default:
      fail(`unsupported adapter: ${entry.adapter}`);
  }
  const serialized = JSON.stringify(commands);
  if (FORBIDDEN_TEXT.test(serialized)) fail(`package ${entry.id} generated an online command`);
  return commands;
}

function validateExplicitTools(tools) {
  if (!tools || typeof tools !== "object") fail("explicit tool selection is required");
  const selected = {};
  for (const key of TOOL_KEYS) {
    const path = tools[key];
    if (typeof path !== "string" || !isAbsolute(path) || /[\0\r\n'\\;]/.test(path)) fail(`explicit ${key} tool path is invalid`);
    selected[key] = path;
  }
  return selected;
}

export function createContext({ child, arch, jobs, sdk, toolPath, tools }) {
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) fail("jobs must be an integer from 1 through 16");
  if (!isAbsolute(sdk) || /[\0\r\n'\\;]/.test(sdk)) fail("SDK path must be an absolute machine-file-safe path");
  if (!isAbsolute(child) || /[\0\r\n'\\;]/.test(child)) fail("replay child must be an absolute machine-file-safe path");
  const prefix = join(child, "install", arch);
  const sources = join(child, "sources");
  const builds = join(child, "build");
  const flags = `-arch ${arch} -mmacosx-version-min=11.0 -isysroot ${sdk} -O2`;
  const path = toolPath || "/usr/bin:/bin:/usr/sbin:/sbin";
  const tool = (name) => {
    for (const directory of path.split(":")) {
      const candidate = join(directory, name);
      try {
        if (statSync(candidate).isFile()) {
          accessSync(candidate, fsConstants.X_OK);
          return candidate;
        }
      } catch {
        // Continue to the next exact PATH entry.
      }
    }
    fail(`required tool is unavailable in the controlled PATH: ${name}`);
  };
  const selected = validateExplicitTools(tools);
  return {
    child, arch, jobs, sdk, prefix, sources, builds, toolPath: path, tool,
    host: arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin",
    ...selected, cflags: flags, ldflags: flags.replace(/ -O2$/, ""),
    machineFile: join(child, `meson-${arch}-darwin.ini`),
    xcrunCacheRoot: join(child, "xcrun-cache"),
    metalModuleCache: join(child, "metal-module-cache"),
  };
}

export function createBuildEnvironment(context, base = process.env) {
  const env = {
    PATH: context.toolPath,
    HOME: join(context.child, "home"),
    TMPDIR: join(context.child, "tmp"),
    SDKROOT: context.sdk,
    MACOSX_DEPLOYMENT_TARGET: "11.0",
    CC: context.cc,
    CXX: context.cxx,
    AR: context.ar,
    RANLIB: context.ranlib,
    NM: context.nm,
    STRIP: context.strip,
    MAKE: context.make,
    PKG_CONFIG: context.pkgConfig,
    XCRUN_CACHE_ROOT: context.xcrunCacheRoot,
    CLANG_MODULE_CACHE_PATH: context.metalModuleCache,
    CFLAGS: context.cflags,
    CXXFLAGS: context.cflags,
    LDFLAGS: context.ldflags,
    PKG_CONFIG_PATH: join(context.prefix, "lib", "pkgconfig"),
    PKG_CONFIG_LIBDIR: join(context.prefix, "lib", "pkgconfig"),
    CMAKE_PREFIX_PATH: context.prefix,
    CMAKE_FIND_USE_PACKAGE_REGISTRY: "FALSE",
    CMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY: "FALSE",
    CMAKE_IGNORE_PREFIX_PATH: "/opt/homebrew;/usr/local",
    MESON_PACKAGE_CACHE_DIR: join(context.child, "meson-package-cache-disabled"),
    http_proxy: "",
    https_proxy: "",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    NO_PROXY: "*",
    CPATH: "",
    CPLUS_INCLUDE_PATH: "",
    LIBRARY_PATH: "",
  };
  for (const key of ["TERM", "LANG", "LC_ALL", "DEVELOPER_DIR"]) if (base[key]) env[key] = base[key];
  return env;
}

export function writeMachineFile(context) {
  const text = `[binaries]\nc = '${context.cc}'\ncpp = '${context.cxx}'\nobjc = '${context.cc}'\nobjcpp = '${context.cxx}'\nar = '${context.ar}'\nstrip = '${context.strip}'\npkg-config = '${context.pkgConfig}'\n\n[built-in options]\nprefix = '${context.prefix}'\nbuildtype = 'release'\ndefault_library = 'shared'\nc_args = ['-arch', '${context.arch}', '-mmacosx-version-min=11.0', '-isysroot', '${context.sdk}', '-O2']\nc_link_args = ['-arch', '${context.arch}', '-mmacosx-version-min=11.0', '-isysroot', '${context.sdk}']\ncpp_args = ['-arch', '${context.arch}', '-mmacosx-version-min=11.0', '-isysroot', '${context.sdk}', '-O2']\ncpp_link_args = ['-arch', '${context.arch}', '-mmacosx-version-min=11.0', '-isysroot', '${context.sdk}']\nobjc_args = ['-arch', '${context.arch}', '-mmacosx-version-min=11.0', '-isysroot', '${context.sdk}']\nobjc_link_args = ['-arch', '${context.arch}', '-mmacosx-version-min=11.0', '-isysroot', '${context.sdk}']\n\n[host_machine]\nsystem = 'darwin'\ncpu_family = '${context.arch === "arm64" ? "aarch64" : "x86_64"}'\ncpu = '${context.arch === "arm64" ? "aarch64" : "x86_64"}'\nendian = 'little'\n`;
  writeFileSync(context.machineFile, text);
}

export function verifyLuaJitMakefileContract(source) {
  const top = readFileSync(join(source, "Makefile"), "utf8");
  const nested = readFileSync(join(source, "src", "Makefile"), "utf8");
  const requiredTop = [/^amalg:/m, /\$\(MAKE\) -C src amalg/, /^TARGET_SYS\?= \$\(HOST_SYS\)$/m];
  const requiredNested = [
    /^ASOPTIONS= .*\$\(CFLAGS\)$/m,
    /^LDOPTIONS= .*\$\(LDFLAGS\)$/m,
    /^TARGET_TCFLAGS= .*\$\(TARGET_FLAGS\) \$\(TARGET_CFLAGS\)$/m,
    /^TARGET_ALDFLAGS= .*\$\(TARGET_FLAGS\) \$\(TARGET_LDFLAGS\)$/m,
  ];
  if (requiredTop.some((pattern) => !pattern.test(top)) || requiredNested.some((pattern) => !pattern.test(nested))) {
    fail("LuaJIT Makefiles do not preserve the reviewed compiler and linker flag contract");
  }
}

function configuredEqual(actual, expected) {
  const boolean = (value) => /^(?:1|on|yes|true|enabled)$/i.test(String(value)) ? true
    : /^(?:0|off|no|false|disabled)$/i.test(String(value)) ? false : undefined;
  const expectedBoolean = boolean(expected);
  return expectedBoolean === undefined ? String(actual) === String(expected) : boolean(actual) === expectedBoolean;
}

function requestedDefinitions(entry, context) {
  const values = new Map();
  for (const option of entry.options.map((value) => replaceTokens(value, context))) {
    const match = /^-D([^=]+)=(.*)$/.exec(option);
    if (!match) fail(`package ${entry.id} has an unsupported configuration option receipt`);
    values.set(match[1], match[2]);
  }
  return values;
}

function requireConfigured(values, key, expected, label) {
  if (!values.has(key) || !configuredEqual(values.get(key), expected)) fail(`${label} did not retain requested option ${key}`);
}

function parseCmakeCache(path) {
  const values = new Map();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([^/#][^:]*):[^=]+=(.*)$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function parseDefines(path, prefix) {
  const values = new Map();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = new RegExp(`^#define ${prefix}([A-Z0-9_]+) (.+)$`).exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function parseMakeValues(path) {
  const text = readFileSync(path, "utf8");
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return { text, values };
}

export function verifyConfigurationReceipt(entry, context) {
  const build = join(context.builds, entry.id);
  if (entry.adapter === "cmake") {
    const values = parseCmakeCache(join(build, "CMakeCache.txt"));
    const required = new Map([
      ["CMAKE_BUILD_TYPE", "Release"], ["CMAKE_POLICY_VERSION_MINIMUM", "3.5"],
      ["CMAKE_INSTALL_PREFIX", context.prefix], ["CMAKE_INSTALL_LIBDIR", "lib"],
      ["CMAKE_OSX_ARCHITECTURES", context.arch], ["CMAKE_OSX_DEPLOYMENT_TARGET", "11.0"], ["CMAKE_OSX_SYSROOT", context.sdk],
      ...requestedDefinitions(entry, context),
    ]);
    for (const [key, expected] of required) requireConfigured(values, key, expected, `${entry.id} CMake receipt`);
    return;
  }
  if (entry.adapter === "meson") {
    const options = JSON.parse(readFileSync(join(build, "meson-info", "intro-buildoptions.json"), "utf8"));
    const values = new Map(options.map((option) => [option.name, option.value]));
    const required = new Map([["prefix", context.prefix], ["buildtype", "release"], ["default_library", "shared"], ...requestedDefinitions(entry, context)]);
    for (const [key, expected] of required) requireConfigured(values, key, expected, `${entry.id} Meson receipt`);
    for (const key of ["c_args", "c_link_args"]) {
      const flags = values.get(key);
      if (!Array.isArray(flags) || !flags.includes("-arch") || !flags.includes(context.arch) || !flags.includes("-mmacosx-version-min=11.0") || !flags.includes("-isysroot") || !flags.includes(context.sdk)) {
        fail(`${entry.id} Meson receipt did not retain architecture, SDK, and macOS minimum in ${key}`);
      }
    }
    return;
  }
  if (entry.adapter === "openssl") {
    const text = readFileSync(join(build, "configdata.pm"), "utf8");
    const config = text.split(/\n\);\nour %target = /, 1)[0];
    const quoted = (key, source = config) => {
      const match = new RegExp(`^\\s*"${key}"\\s*=>\\s*"([^"]*)"`, "m").exec(source);
      if (!match) fail(`openssl configdata.pm receipt is missing ${key}`);
      return match[1];
    };
    const options = new Set(quoted("options").split(/\s+/).filter(Boolean));
    if (quoted("prefix") !== context.prefix || !options.has(`--prefix=${context.prefix}`)) {
      fail("openssl configdata.pm receipt did not retain the owned prefix");
    }
    const expectedTarget = context.arch === "arm64" ? "darwin64-arm64-cc" : "darwin64-x86_64-cc";
    if (quoted("target") !== expectedTarget) fail("openssl configdata.pm receipt did not retain the native architecture target");
    for (const option of entry.options) if (!options.has(option)) fail(`openssl configdata.pm receipt did not retain requested option ${option}`);
    if (!options.has("enable-shared") || options.has("no-shared") || !/^\s*"shared_target"\s*=>\s*"darwin-shared"/m.test(text)) {
      fail("openssl configdata.pm receipt did not retain shared-library selection");
    }
    const perlenv = /^\s*"perlenv"\s*=>\s*\{([\s\S]*?)^\s*\},/m.exec(config)?.[1];
    if (!perlenv) fail("openssl configdata.pm receipt is missing compiler environment data");
    for (const key of ["CFLAGS", "LDFLAGS"]) {
      const value = quoted(key, perlenv);
      for (const token of [`-arch ${context.arch}`, "-mmacosx-version-min=11.0", `-isysroot ${context.sdk}`]) {
        if (!value.includes(token)) fail(`openssl configdata.pm receipt dropped ${key} target flags`);
      }
    }
    return;
  }
  if (entry.adapter === "ffmpeg") {
    const macros = parseDefines(join(build, "config.h"), "CONFIG_");
    for (const option of entry.options) {
      const match = /^--(enable|disable)-(.+)$/.exec(option);
      if (!match || match[2] === "debug") continue;
      const key = match[2].replaceAll("-", "_").toUpperCase();
      requireConfigured(macros, key, match[1] === "enable" ? "1" : "0", "ffmpeg config.h receipt");
    }
    const make = parseMakeValues(join(build, "ffbuild", "config.mak")).values;
    requireConfigured(make, "ARCH", context.arch === "arm64" ? "aarch64" : "x86", "ffmpeg config.mak receipt");
    for (const key of ["CFLAGS", "LDFLAGS"]) {
      const value = make.get(key) ?? "";
      for (const token of [`-arch ${context.arch}`, "-mmacosx-version-min=11.0", `-isysroot ${context.sdk}`]) if (!value.includes(token)) fail(`ffmpeg config.mak receipt dropped ${key} target flags`);
    }
    requireConfigured(make, "METALCC", `${context.metal} -fmodules-cache-path=${context.metalModuleCache}`, "ffmpeg config.mak receipt");
    requireConfigured(make, "METALLIB", context.metallib, "ffmpeg config.mak receipt");
    requireConfigured(make, "CONFIG_METAL", "yes", "ffmpeg config.mak receipt");
    return;
  }
  if (entry.adapter === "x264") {
    const make = parseMakeValues(join(build, "config.mak"));
    requireConfigured(make.values, "prefix", context.prefix, "x264 config.mak receipt");
    requireConfigured(make.values, "SYS_ARCH", context.arch === "arm64" ? "AARCH64" : "X86_64", "x264 config.mak receipt");
    for (const key of ["CFLAGS", "LDFLAGS"]) {
      const value = make.values.get(key) ?? "";
      for (const token of [`-arch ${context.arch}`, "-mmacosx-version-min=11.0", `-isysroot ${context.sdk}`]) if (!value.includes(token)) fail(`x264 config.mak receipt dropped ${key} target flags`);
    }
    if (!/^default: lib-shared$/m.test(make.text) || !/^install: install-lib-shared$/m.test(make.text) || /^install:.*static/m.test(make.text) || /^default:.*cli/m.test(make.text)) {
      fail("x264 config.mak receipt did not retain shared-only library selection");
    }
  }
}

function prefixFiles(prefix) {
  const files = [];
  if (!existsSync(prefix)) return files;
  walk(prefix, (_path, rel, info) => { if (!info.isDirectory()) files.push(rel); });
  return files;
}

export function verifyExpectedProducts(entry, prefix) {
  const canonicalPrefix = realpathSync(prefix);
  for (const expected of entry.expected) {
    const path = join(prefix, expected);
    assertInside(prefix, path, "expected product");
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info?.isFile() || info.isSymbolicLink()) fail(`package ${entry.id} did not produce exact regular file ${expected}`);
    assertInside(canonicalPrefix, realpathSync(path), "expected product");
  }
}

function copySafeTree(source, destination) {
  assertSafeTree(source);
  cpSync(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
  assertSafeTree(destination);
}

function run(command, environment) {
  mkdirSync(command.cwd, { recursive: true });
  const result = spawnSync(command.command, command.args, { cwd: command.cwd, env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`build command failed with status ${result.status}`);
}

export function verifySelectedTools(context) {
  for (const key of TOOL_KEYS) {
    const path = context[key];
    let info;
    try {
      info = statSync(path);
      accessSync(path, fsConstants.X_OK);
    } catch {
      fail(`selected ${key} tool is not executable`);
    }
    if (!info.isFile()) fail(`selected ${key} tool is not a regular file`);
  }
}

function probeTools(context) {
  return Object.fromEntries(TOOL_KEYS.map((key) => [key, context[key]]));
}

export function runToolchainProbe(context, execute = spawnSync) {
  const source = join(context.child, "toolchain-probe", "source");
  const build = join(context.builds, "toolchain-probe");
  const logPath = join(context.child, "TOOLCHAIN-PROBE.log");
  const receiptPath = join(context.child, "TOOLCHAIN-PROBE.json");
  const archive = join(build, "libtoolchain_probe.a");
  const cxxLinkProbe = join(build, "toolchain_link_probe");
  const makefile = join(context.child, "toolchain-probe", "Makefile");
  const makeMarker = join(context.child, "toolchain-probe", "make-probe.ok");
  const metalSource = join(source, "probe.metal");
  const metalAir = join(build, "probe.air");
  const metalLibrary = join(build, "probe.metallib");
  const environment = createBuildEnvironment(context);
  const records = [];
  const logs = [];
  let archiveMembers = null;
  let cxxLinkOutput = null;
  mkdirSync(source, { recursive: true });
  mkdirSync(build, { recursive: true });
  writeFileSync(join(source, "meson.build"), "project('toolchain-probe', ['c', 'cpp'])\nstatic_library('toolchain_probe', ['probe.c', 'probe.cpp'], install: false)\nexecutable('toolchain_link_probe', 'link_probe.cpp', install: false)\n");
  writeFileSync(join(source, "probe.c"), "int toolchain_probe(void) { return 0; }\n");
  writeFileSync(join(source, "probe.cpp"), "int toolchain_cpp_probe() { return 0; }\n");
  writeFileSync(join(source, "link_probe.cpp"), "#include <iostream>\nint main() { std::cout << \"cxx-link-probe-ok\\n\"; return std::cout.good() ? 0 : 1; }\n");
  writeFileSync(metalSource, "#include <metal_stdlib>\nusing namespace metal;\nkernel void yawf_probe(device float *out [[buffer(0)]], uint i [[thread_position_in_grid]]) { out[i] = 1.0f; }\n");
  writeFileSync(makefile, `all:\n\t@/usr/bin/printf 'make-probe-ok\\n' > '${makeMarker}'\n`);

  const invoke = (command, args, cwd) => {
    const result = execute(command, args, { cwd, env: environment, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const combined = `${stdout}${stderr}`;
    const status = Number.isInteger(result.status) ? result.status : null;
    records.push({ command, args, cwd, status });
    logs.push(`$ ${JSON.stringify([command, ...args])}\n[status ${status ?? "none"}]\n${stdout}${stderr}`);
    if (result.error) throw result.error;
    if (status !== 0) fail(`toolchain probe command failed with status ${status}`);
    if (SHIM_DENIAL_TEXT.test(combined)) fail("toolchain probe observed an Apple shim cache denial");
    return combined;
  };

  try {
    const meson = context.tool("meson");
    invoke(meson, ["setup", build, source, `--native-file=${context.machineFile}`, "--buildtype=release", "--wrap-mode=nofallback"], context.child);
    invoke(meson, ["compile", "-C", build, "-j", String(context.jobs)], context.child);
    const mesonLog = join(build, "meson-logs", "meson-log.txt");
    if (!statSync(mesonLog, { throwIfNoEntry: false })?.isFile()) fail("toolchain probe did not retain the Meson diagnostic log");
    if (SHIM_DENIAL_TEXT.test(readFileSync(mesonLog, "utf8"))) fail("toolchain probe Meson log contains an Apple shim cache denial");
    if (!lstatSync(archive, { throwIfNoEntry: false })?.isFile()) fail("toolchain probe did not produce its static archive");
    invoke(context.ranlib, [archive], context.child);
    const memberOutput = invoke(context.ar, ["-t", archive], context.child);
    archiveMembers = memberOutput
      .split("\n")
      .map((value) => value.endsWith("\r") ? value.slice(0, -1) : value)
      .filter((value) => value.length > 0);
    const expectedObjects = new Set(["probe.c.o", "probe.cpp.o"]);
    const probeObjects = archiveMembers.filter((value) => expectedObjects.has(value));
    const indexMembers = archiveMembers.filter((value) => DARWIN_ARCHIVE_INDEX_MEMBERS.has(value));
    const unexpectedMembers = archiveMembers.filter((value) => !expectedObjects.has(value) && !DARWIN_ARCHIVE_INDEX_MEMBERS.has(value));
    if (
      probeObjects.length !== expectedObjects.size ||
      ![...expectedObjects].every((value) => archiveMembers.includes(value)) ||
      indexMembers.length > 1 ||
      unexpectedMembers.length > 0 ||
      new Set(archiveMembers).size !== archiveMembers.length
    ) fail("toolchain probe archive membership is unexpected");
    if (!lstatSync(cxxLinkProbe, { throwIfNoEntry: false })?.isFile()) fail("toolchain probe did not produce its C++ link executable");
    cxxLinkOutput = invoke(cxxLinkProbe, [], context.child);
    if (cxxLinkOutput !== "cxx-link-probe-ok\n") fail("toolchain probe C++ link executable output is unexpected");
    invoke(context.make, ["-f", makefile, "all"], context.child);
    if (readFileSync(makeMarker, "utf8") !== "make-probe-ok\n") fail("toolchain probe make marker is missing or incorrect");
    invoke(context.metal, ["-c", `-fmodules-cache-path=${context.metalModuleCache}`, metalSource, "-o", metalAir], context.child);
    if (!statSync(metalAir, { throwIfNoEntry: false })?.isFile() || statSync(metalAir).size === 0) fail("toolchain probe did not produce Metal AIR");
    invoke(context.metallib, ["--split-module-without-linking", metalAir, "-o", metalLibrary], context.child);
    if (!statSync(metalLibrary, { throwIfNoEntry: false })?.isFile() || statSync(metalLibrary).size === 0) fail("toolchain probe did not produce a Metal library");
    writeFileSync(logPath, logs.join("\n"));
    const receipt = {
      schemaVersion: 1,
      result: "pass",
      tools: probeTools(context),
      xcrunCacheRoot: context.xcrunCacheRoot,
      mesonMachineFile: context.machineFile,
      archive: posixRelative(relative(context.child, archive)),
      archiveMembers,
      cxxLinkProbe: posixRelative(relative(context.child, cxxLinkProbe)),
      cxxLinkOutput,
      metalModuleCache: context.metalModuleCache,
      metalAir: posixRelative(relative(context.child, metalAir)),
      metalLibrary: posixRelative(relative(context.child, metalLibrary)),
      commands: records,
      shimDenialsObserved: false,
    };
    writeJsonAtomic(receiptPath, receipt);
    return receipt;
  } catch (error) {
    writeFileSync(logPath, logs.join("\n"));
    writeJsonAtomic(receiptPath, {
      schemaVersion: 1,
      result: "fail",
      error: error instanceof Error ? error.message : "unknown failure",
      tools: probeTools(context),
      xcrunCacheRoot: context.xcrunCacheRoot,
      mesonMachineFile: context.machineFile,
      archiveMembers,
      cxxLinkProbe: posixRelative(relative(context.child, cxxLinkProbe)),
      cxxLinkOutput,
      metalModuleCache: context.metalModuleCache,
      metalAir: posixRelative(relative(context.child, metalAir)),
      metalLibrary: posixRelative(relative(context.child, metalLibrary)),
      commands: records,
    });
    throw error;
  }
}

const MACH_O_MAGICS = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);

function isMachO(path) {
  const descriptor = openSync(path, "r");
  try {
    const magic = Buffer.alloc(4);
    return readSync(descriptor, magic, 0, 4, 0) === 4 && MACH_O_MAGICS.has(magic.toString("hex"));
  } finally {
    closeSync(descriptor);
  }
}

export function snapshotInstalledMachO(prefix) {
  const files = new Map();
  if (!existsSync(prefix)) return files;
  const canonicalPrefix = realpathSync(prefix);
  walk(prefix, (path, rel, info) => {
    if (!info.isFile() || info.isSymbolicLink()) return;
    assertInside(canonicalPrefix, realpathSync(path), "installed file");
    if (isMachO(path)) files.set(rel, sha256(path));
  });
  return files;
}

function checkedInspection(tool, args, label, inspect) {
  const result = inspect(tool, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`could not inspect ${label}`);
  return result.stdout ?? "";
}

function macOSMinimums(loadCommands) {
  const lines = loadCommands.split(/\r?\n/);
  const minimums = [];
  for (let index = 0; index < lines.length; index += 1) {
    const command = /^\s*cmd\s+(LC_BUILD_VERSION|LC_VERSION_MIN_MACOSX)\s*$/.exec(lines[index])?.[1];
    if (!command) continue;
    const field = command === "LC_BUILD_VERSION" ? "minos" : "version";
    for (index += 1; index < lines.length && !/^\s*cmd\s+/.test(lines[index]); index += 1) {
      const match = new RegExp(`^\\s*${field}\\s+(\\d+(?:\\.\\d+){1,2})\\s*$`).exec(lines[index]);
      if (match) minimums.push(match[1]);
    }
    index -= 1;
  }
  return minimums;
}

export function auditInstalledMachOChanges(entry, context, before, inspect = spawnSync) {
  const after = snapshotInstalledMachO(context.prefix);
  const removed = [...before.keys()].filter((path) => !after.has(path)).sort();
  if (removed.length > 0) fail(`package ${entry.id} removed an installed Mach-O file`);
  const changed = [...after].filter(([path, digest]) => before.get(path) !== digest).map(([path]) => path).sort();
  const changedSet = new Set(changed);
  for (const expected of entry.expected) {
    if (!changedSet.has(expected)) fail(`package ${entry.id} expected Mach-O output ${expected} was not new or changed`);
  }
  for (const relativePath of changed) {
    const path = join(context.prefix, relativePath);
    const architectures = checkedInspection("/usr/bin/lipo", ["-archs", path], `${entry.id} output architecture`, inspect).trim().split(/\s+/).filter(Boolean);
    if (architectures.length !== 1 || architectures[0] !== context.arch) fail(`package ${entry.id} produced a non-native Mach-O architecture`);
    const loads = checkedInspection("/usr/bin/otool", ["-l", path], `${entry.id} output minimum`, inspect);
    const minimums = macOSMinimums(loads);
    if (minimums.length === 0 || minimums.some((minimum) => minimum !== "11.0" && minimum !== "11.0.0")) {
      fail(`package ${entry.id} produced a Mach-O without the macOS 11.0 minimum`);
    }
    const dependencies = checkedInspection("/usr/bin/otool", ["-L", path], `${entry.id} output dependencies`, inspect);
    if (/\/(?:opt\/homebrew|usr\/local)\//.test(dependencies)) fail(`package ${entry.id} linked a host package-manager library`);
  }
  return {
    state: after,
    receipt: { package: entry.id, beforeMachO: before.size, afterMachO: after.size, changedMachO: changed, removedMachO: removed },
  };
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const options = { mode };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("arguments must be --name value pairs");
    options[key.slice(2)] = value;
  }
  return options;
}

function prepareChild(outputRoot, arch) {
  const child = join(outputRoot, `replay-${arch}-macos11`);
  assertInside(outputRoot, child, "replay child");
  if (existsSync(child)) fail("replay child already exists; it will not be deleted or reused");
  mkdirSync(child);
  writeJsonAtomic(join(child, CHILD_MARKER), { schemaVersion: 1, purpose: "yawf-independent-media-replay-child", arch, target: "11.0" });
  return child;
}

function prepareContext({ outputRoot, arch, jobs, sdk, toolPath, tools, actualArch }) {
  assertNativeArchitecture(arch, actualArch);
  const ownedRoot = assertOwnedOutputRoot(outputRoot);
  const child = prepareChild(ownedRoot, arch);
  const context = createContext({ child, arch, jobs, sdk, toolPath, tools });
  verifySelectedTools(context);
  for (const directory of [context.sources, context.builds, context.prefix, join(child, "home"), join(child, "tmp"), context.xcrunCacheRoot, context.metalModuleCache]) mkdirSync(directory, { recursive: true });
  writeMachineFile(context);
  return context;
}

export function prepareToolchainProbe({ outputRoot, arch, jobs, sdk, toolPath, tools, actualArch = process.arch }) {
  return prepareContext({ outputRoot, arch, jobs, sdk, toolPath, tools, actualArch });
}

export function prepareReplay({ sourceRoot, outputRoot, arch, jobs, sdk, toolPath, tools, plan = loadPlan(), actualArch = process.arch }) {
  const sources = verifySourceBundle(sourceRoot, plan);
  const context = prepareContext({ outputRoot, arch, jobs, sdk, toolPath, tools, actualArch });
  for (const entry of plan.packages) copySafeTree(join(sources.components, entry.sourceDir), join(context.sources, entry.sourceDir));
  const luaJit = plan.packages.find((entry) => entry.id === "luajit");
  if (!luaJit) fail("LuaJIT package is missing from the replay plan");
  verifyLuaJitMakefileContract(join(context.sources, luaJit.sourceDir));
  const commands = plan.packages.map((entry) => ({ id: entry.id, commands: renderPackageCommands(entry, context) }));
  writeJsonAtomic(join(context.child, "COMMANDS.json"), { schemaVersion: 1, arch, target: "11.0", jobs, commands });
  return { plan, context, commands };
}

export function executeReplay(prepared, probe = runToolchainProbe) {
  const environment = createBuildEnvironment(prepared.context);
  const statusPath = join(prepared.context.child, "STATUS.json");
  const auditPath = join(prepared.context.child, "INSTALL-AUDIT.json");
  let installedMachO = snapshotInstalledMachO(prepared.context.prefix);
  const audits = [];
  try {
    probe(prepared.context);
    for (const packageCommands of prepared.commands) {
      const entry = prepared.plan.packages.find((candidate) => candidate.id === packageCommands.id);
      for (const [index, command] of packageCommands.commands.entries()) {
        run(command, environment);
        if (index === 0 && ["cmake", "meson", "openssl", "ffmpeg", "x264"].includes(entry.adapter)) verifyConfigurationReceipt(entry, prepared.context);
      }
      verifyExpectedProducts(entry, prepared.context.prefix);
      const audit = auditInstalledMachOChanges(entry, prepared.context, installedMachO);
      installedMachO = audit.state;
      audits.push(audit.receipt);
      writeJsonAtomic(auditPath, { schemaVersion: 1, arch: prepared.context.arch, target: "11.0", packages: audits });
    }
    writeJsonAtomic(statusPath, { schemaVersion: 1, result: "pass", packages: 33, arch: prepared.context.arch, target: "11.0" });
  } catch (error) {
    writeJsonAtomic(statusPath, { schemaVersion: 1, result: "fail", error: error instanceof Error ? error.message : "unknown failure" });
    throw error;
  }
}

export function executeToolchainProbe(context) {
  const statusPath = join(context.child, "STATUS.json");
  try {
    const receipt = runToolchainProbe(context);
    writeJsonAtomic(statusPath, { schemaVersion: 1, result: "probe-pass", packages: 0, arch: context.arch, target: "11.0" });
    return receipt;
  } catch (error) {
    writeJsonAtomic(statusPath, { schemaVersion: 1, result: "fail", error: error instanceof Error ? error.message : "unknown failure" });
    throw error;
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.mode === "init") {
    if (!args["output-root"]) fail("init requires --output-root");
    initializeOutputRoot(args["output-root"]);
    return;
  }
  if (args.mode === "verify") {
    if (!args["source-root"]) fail("verify requires --source-root");
    const result = verifySourceBundle(args["source-root"]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (!["commands", "build", "probe"].includes(args.mode)) fail("mode must be init, verify, commands, build, or probe");
  for (const required of ["output-root", "arch", "jobs", "sdk", "tool-path", "cc", "cxx", "ar", "ranlib", "nm", "strip", "make", "pkg-config", "metal", "metallib"]) {
    if (!args[required]) fail(`${args.mode} requires --${required}`);
  }
  const tools = {
    cc: args.cc,
    cxx: args.cxx,
    ar: args.ar,
    ranlib: args.ranlib,
    nm: args.nm,
    strip: args.strip,
    make: args.make,
    pkgConfig: args["pkg-config"],
    metal: args.metal,
    metallib: args.metallib,
  };
  if (args.mode === "probe") {
    const context = prepareToolchainProbe({
      outputRoot: args["output-root"], arch: args.arch, jobs: Number(args.jobs),
      sdk: args.sdk, toolPath: args["tool-path"], tools,
    });
    executeToolchainProbe(context);
    return;
  }
  if (!args["source-root"]) fail(`${args.mode} requires --source-root`);
  const prepared = prepareReplay({
    sourceRoot: args["source-root"], outputRoot: args["output-root"], arch: args.arch,
    jobs: Number(args.jobs), sdk: args.sdk, toolPath: args["tool-path"], tools,
  });
  if (args.mode === "build") executeReplay(prepared);
  else process.stdout.write(`${join(prepared.context.child, "COMMANDS.json")}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`independent media replay: ${error instanceof Error ? error.message : "failed"}\n`); process.exitCode = 1; }
}
