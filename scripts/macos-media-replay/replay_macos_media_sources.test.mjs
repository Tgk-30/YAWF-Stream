import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  auditInstalledMachOChanges,
  assertNativeArchitecture,
  assertOwnedOutputRoot,
  assertSafeTree,
  createBuildEnvironment,
  createContext,
  executeReplay,
  initializeOutputRoot,
  loadPlan,
  prepareReplay,
  renderPackageCommands,
  snapshotInstalledMachO,
  validatePlan,
  verifyConfigurationReceipt,
  verifyExpectedProducts,
  verifyLuaJitMakefileContract,
  verifySourceBundle,
  writeMachineFile,
} from "./replay_macos_media_sources.mjs";

const PLAN = loadPlan();
const REQUIRED_RUNTIME_OUTPUTS = JSON.parse(readFileSync(new URL("./required-runtime-outputs.json", import.meta.url), "utf8"));
const ORDER = [
  "freetype", "fribidi", "libunibreak", "luajit", "mujs", "uchardet", "little-cms2", "libudfread",
  "lz4", "zstd", "zimg", "openssl", "libbs2b", "soxr", "x264", "jpeg-turbo", "libwebp",
  "svt-av1", "libjxl", "dav1d", "speex", "libogg", "libvorbis", "libaribcaption", "harfbuzz",
  "fontconfig", "libarchive", "rubberband", "libbluray", "libplacebo", "libass", "ffmpeg", "mpv",
];

function temporary() {
  return mkdtempSync(join(tmpdir(), "independent-media-replay-"));
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixtureBundle({ tamper = false, escapeSymlink = false, relativeSymlink = false, componentAlias = false } = {}) {
  const root = temporary();
  const components = join(root, "component-sources");
  mkdirSync(components);
  for (const [index, entry] of PLAN.packages.entries()) {
    const directory = componentAlias && index === 0 ? join(components, `.backing-${entry.sourceDir}`) : join(components, entry.sourceDir);
    mkdirSync(directory);
    writeFileSync(join(directory, "source.txt"), entry.id);
    if (componentAlias && index === 0) symlinkSync(`.backing-${entry.sourceDir}`, join(components, entry.sourceDir));
    if (relativeSymlink && index === 0) symlinkSync("source.txt", join(directory, "source-link.txt"));
    if (entry.id === "luajit") {
      mkdirSync(join(directory, "src"));
      writeFileSync(join(directory, "Makefile"), "TARGET_SYS?= $(HOST_SYS)\namalg:\n\t$(MAKE) -C src amalg\n");
      writeFileSync(join(directory, "src", "Makefile"), "ASOPTIONS= $(CCOPT) $(CFLAGS)\nLDOPTIONS= $(CCDEBUG) $(LDFLAGS)\nTARGET_TCFLAGS= $(CCOPTIONS) $(TARGET_FLAGS) $(TARGET_CFLAGS)\nTARGET_ALDFLAGS= $(LDOPTIONS) $(TARGET_FLAGS) $(TARGET_LDFLAGS)\n");
    }
  }
  if (escapeSymlink) symlinkSync("/tmp", join(components, PLAN.packages[0].sourceDir, "escape"));
  writeFileSync(join(root, "SOURCE-INVENTORY.json"), `${JSON.stringify({ components: PLAN.packages.map((entry) => entry.sourceDir), archives: [], notices: [], gitSources: [] })}\n`);
  const files = [];
  const visit = (directory, relative = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (rel === "SHA256SUMS" || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, rel);
      else files.push([rel, digest(path)]);
    }
  };
  visit(root);
  writeFileSync(join(root, "SHA256SUMS"), `${files.map(([path, hash]) => `${hash}  ${path}`).join("\n")}\n`);
  if (tamper) writeFileSync(join(components, PLAN.packages[0].sourceDir, "source.txt"), "tampered");
  return root;
}

function fixedContext(arch = "arm64") {
  const context = createContext({ child: "/owned/replay", arch, jobs: 4, sdk: "/SDK/MacOSX.sdk", toolPath: "/tools" });
  context.tool = (name) => `/tools/${name}`;
  return context;
}

function normalizedCommands(entry, arch = "arm64") {
  return renderPackageCommands(entry, fixedContext(arch)).map(({ command, args, cwd }) => ({ command, args, cwd }));
}

test("declares the exact 33-package order and an acyclic backward-only dependency graph", () => {
  assert.equal(PLAN.packages.length, 33);
  assert.deepEqual(PLAN.packages.map((entry) => entry.id), ORDER);
  const seen = new Set();
  for (const entry of PLAN.packages) {
    assert.ok(entry.dependencies.every((dependency) => seen.has(dependency)), entry.id);
    seen.add(entry.id);
  }
});

test("requires the exact canonical staged dylib and CLI closure without globs", () => {
  const actual = PLAN.packages.flatMap((entry) => entry.expected);
  assert.equal(actual.length, 57);
  assert.equal(new Set(actual).size, actual.length);
  assert.deepEqual(actual, REQUIRED_RUNTIME_OUTPUTS.outputs);
  assert.equal(actual.filter((path) => path.startsWith("lib/") && path.endsWith(".dylib")).length, 55);
  assert.deepEqual(actual.filter((path) => path.startsWith("bin/")), ["bin/ffmpeg", "bin/ffprobe"]);
  assert.ok(actual.every((path) => !/[*?\[]/.test(path)));
});

test("matches the reviewed command snapshot for every package", () => {
  const actual = Object.fromEntries(PLAN.packages.map((entry) => [entry.id, normalizedCommands(entry)]));
  const expected = JSON.parse(readFileSync(new URL("./command-snapshots.json", import.meta.url), "utf8"));
  assert.deepEqual(actual, expected);
});

test("confines the effective install prefix for every package and adapter", () => {
  const context = fixedContext();
  const prefixForms = [
    `--prefix=${context.prefix}`,
    `-DCMAKE_INSTALL_PREFIX=${context.prefix}`,
    `PREFIX=${context.prefix}`,
    `prefix=${context.prefix}`,
  ];
  for (const entry of PLAN.packages) {
    const commands = renderPackageCommands(entry, context);
    assert.ok(commands[0].args.some((argument) => prefixForms.includes(argument)), `${entry.id} configure/setup prefix`);
    for (const command of commands) {
      for (const argument of command.args.filter((value) => /^(?:--prefix|-DCMAKE_INSTALL_PREFIX|PREFIX|prefix)=/.test(value))) {
        assert.ok(prefixForms.includes(argument), `${entry.id} has an unexpected install prefix`);
      }
    }
    assert.ok(commands.every((command) => command.args.every((argument) => !/^(?:--prefix|-DCMAKE_INSTALL_PREFIX|PREFIX|prefix)=\/(?:opt\/homebrew|usr\/local)(?:\/|$)/.test(argument))), `${entry.id} host install prefix`);
  }
});

test("gives every Meson setup exactly one explicit release, shared, and owned-prefix value", () => {
  const context = fixedContext();
  for (const entry of PLAN.packages.filter((candidate) => candidate.adapter === "meson")) {
    const setup = renderPackageCommands(entry, context)[0];
    assert.equal(setup.args.filter((argument) => argument === `--prefix=${context.prefix}` || argument === `-Dprefix=${context.prefix}`).length, 1, `${entry.id} prefix`);
    assert.equal(setup.args.filter((argument) => argument === "--buildtype=release" || argument === "-Dbuildtype=release").length, 1, `${entry.id} buildtype`);
    assert.equal(setup.args.filter((argument) => argument === "--default-library=shared" || argument === "-Ddefault_library=shared").length, 1, `${entry.id} default library`);
    assert.equal(setup.args.filter((argument) => argument === "--wrap-mode=nofallback").length, 1, `${entry.id} fallback mode`);
    assert.ok(setup.args.includes(`--native-file=${context.machineFile}`), entry.id);
  }
  const root = temporary();
  context.machineFile = join(root, "machine.ini");
  writeMachineFile(context);
  const machine = readFileSync(context.machineFile, "utf8");
  assert.match(machine, /prefix = '\/owned\/replay\/install\/arm64'/);
  assert.match(machine, /buildtype = 'release'/);
  assert.match(machine, /default_library = 'shared'/);
});

test("roots every CMake package lookup in the owned prefix and selected SDK", () => {
  const context = fixedContext();
  for (const entry of PLAN.packages.filter((candidate) => candidate.adapter === "cmake")) {
    const setup = renderPackageCommands(entry, context)[0];
    assert.ok(setup.args.includes(`-DCMAKE_PREFIX_PATH=${context.prefix}`), entry.id);
    assert.ok(setup.args.includes(`-DCMAKE_FIND_ROOT_PATH=${context.prefix};${context.sdk}`), entry.id);
    for (const kind of ["INCLUDE", "LIBRARY", "PACKAGE"]) assert.ok(setup.args.includes(`-DCMAKE_FIND_ROOT_PATH_MODE_${kind}=ONLY`), `${entry.id} ${kind}`);
    assert.ok(setup.args.includes("-DCMAKE_FIND_USE_PACKAGE_REGISTRY=FALSE"), entry.id);
    assert.ok(setup.args.includes("-DCMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY=FALSE"), entry.id);
    assert.ok(setup.args.includes("-DCMAKE_IGNORE_PREFIX_PATH=/opt/homebrew;/usr/local"), entry.id);
  }
  const environment = createBuildEnvironment(context, {});
  assert.equal(environment.CMAKE_IGNORE_PREFIX_PATH, "/opt/homebrew;/usr/local");
});

test("finds owned CMake libraries while excluding a simulated host package prefix", () => {
  const child = temporary();
  const sdk = join(child, "sdk");
  const project = join(child, "probe-source");
  const build = join(child, "probe-build");
  const simulatedHost = join(child, "host-homebrew");
  mkdirSync(sdk);
  mkdirSync(project);
  mkdirSync(join(simulatedHost, "lib"), { recursive: true });
  const context = createContext({ child, arch: "arm64", jobs: 1, sdk, toolPath: process.env.PATH });
  mkdirSync(join(context.prefix, "lib"), { recursive: true });
  const ownedLibrary = join(context.prefix, "lib", "libreplay_owned_probe.dylib");
  writeFileSync(ownedLibrary, "owned");
  writeFileSync(join(simulatedHost, "lib", "libreplay_host_probe.dylib"), "host");
  writeFileSync(join(project, "CMakeLists.txt"), `
cmake_minimum_required(VERSION 3.20)
project(replay_prefix_probe NONE)
set(CMAKE_SYSTEM_PREFIX_PATH "\${SIMULATED_HOST_PREFIX}")
find_library(OWNED_PROBE NAMES replay_owned_probe REQUIRED)
find_library(HOST_PROBE NAMES replay_host_probe)
if(NOT OWNED_PROBE STREQUAL "\${EXPECTED_OWNED}")
  message(FATAL_ERROR "owned prefix was not selected")
endif()
if(HOST_PROBE)
  message(FATAL_ERROR "host package prefix leaked into discovery")
endif()
message(STATUS "replay-prefix-probe=pass")
`);
  const cmakeEntry = PLAN.packages.find((entry) => entry.adapter === "cmake");
  const setup = renderPackageCommands(cmakeEntry, context)[0];
  const args = [...setup.args];
  args[1] = project;
  args[3] = build;
  args.push(`-DSIMULATED_HOST_PREFIX=${simulatedHost}`, `-DEXPECTED_OWNED=${ownedLibrary}`);
  const result = spawnSync(setup.command, args, {
    cwd: child,
    env: createBuildEnvironment(context, process.env),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /replay-prefix-probe=pass/);
});

test("passes LuaJIT flags through variables its reviewed Makefiles consume", () => {
  const source = temporary();
  mkdirSync(join(source, "src"));
  writeFileSync(join(source, "Makefile"), "TARGET_SYS?= $(HOST_SYS)\namalg:\n\t$(MAKE) -C src amalg\n");
  writeFileSync(join(source, "src", "Makefile"), "ASOPTIONS= $(CCOPT) $(CFLAGS)\nLDOPTIONS= $(CCDEBUG) $(LDFLAGS)\nTARGET_TCFLAGS= $(CCOPTIONS) $(TARGET_FLAGS) $(TARGET_CFLAGS)\nTARGET_ALDFLAGS= $(LDOPTIONS) $(TARGET_FLAGS) $(TARGET_LDFLAGS)\n");
  assert.doesNotThrow(() => verifyLuaJitMakefileContract(source));
  writeFileSync(join(source, "src", "Makefile"), "ASOPTIONS= no-cflags\nLDOPTIONS= no-ldflags\nTARGET_TCFLAGS= no-target\nTARGET_ALDFLAGS= no-target\n");
  assert.throws(() => verifyLuaJitMakefileContract(source), /flag contract/);
  const context = fixedContext();
  const luaJit = PLAN.packages.find((entry) => entry.id === "luajit");
  for (const command of renderPackageCommands(luaJit, context)) {
    assert.ok(command.args.includes(`CFLAGS=${context.cflags}`));
    assert.ok(command.args.includes(`LDFLAGS=${context.ldflags}`));
    assert.ok(command.args.includes(`PREFIX=${context.prefix}`));
  }
});

test("rejects dropped CMake and Meson options and target flags from post-config receipts", () => {
  const context = createContext({ child: temporary(), arch: "arm64", jobs: 1, sdk: "/SDK/MacOSX.sdk", toolPath: "/tools" });
  const cmake = PLAN.packages.find((entry) => entry.id === "libwebp");
  const cmakeBuild = join(context.builds, cmake.id);
  mkdirSync(cmakeBuild, { recursive: true });
  const cmakeValues = [
    "CMAKE_BUILD_TYPE:STRING=Release", `CMAKE_INSTALL_PREFIX:PATH=${context.prefix}`, "CMAKE_INSTALL_LIBDIR:PATH=lib",
    `CMAKE_OSX_ARCHITECTURES:STRING=${context.arch}`, "CMAKE_OSX_DEPLOYMENT_TARGET:STRING=11.0", `CMAKE_OSX_SYSROOT:PATH=${context.sdk}`,
    ...cmake.options.map((option) => `${option.slice(2).replace("=", ":STRING=")}`),
  ];
  writeFileSync(join(cmakeBuild, "CMakeCache.txt"), `${cmakeValues.join("\n")}\n`);
  assert.doesNotThrow(() => verifyConfigurationReceipt(cmake, context));
  writeFileSync(join(cmakeBuild, "CMakeCache.txt"), `${cmakeValues.filter((line) => !line.startsWith("WEBP_BUILD_LIBWEBPMUX:")).join("\n")}\n`);
  assert.throws(() => verifyConfigurationReceipt(cmake, context), /WEBP_BUILD_LIBWEBPMUX/);

  const meson = PLAN.packages.find((entry) => entry.id === "mpv");
  const mesonInfo = join(context.builds, meson.id, "meson-info");
  mkdirSync(mesonInfo, { recursive: true });
  const mesonOptions = meson.options.map((option) => {
    const [name, ...rest] = option.slice(2).replace("{swiftTarget}", "arm64-apple-macosx11.0").split("=");
    const raw = rest.join("=");
    return { name, value: raw === "true" ? true : raw === "false" ? false : raw };
  });
  mesonOptions.push({ name: "prefix", value: context.prefix });
  for (const name of ["c_args", "c_link_args"]) mesonOptions.push({ name, value: ["-arch", "arm64", "-mmacosx-version-min=11.0", "-isysroot", context.sdk] });
  writeFileSync(join(mesonInfo, "intro-buildoptions.json"), JSON.stringify(mesonOptions));
  assert.doesNotThrow(() => verifyConfigurationReceipt(meson, context));
  mesonOptions.find((option) => option.name === "libmpv").value = false;
  writeFileSync(join(mesonInfo, "intro-buildoptions.json"), JSON.stringify(mesonOptions));
  assert.throws(() => verifyConfigurationReceipt(meson, context), /libmpv/);
});

test("rejects dropped FFmpeg features and x264 shared-only or target configuration receipts", () => {
  const context = createContext({ child: temporary(), arch: "arm64", jobs: 1, sdk: "/SDK/MacOSX.sdk", toolPath: "/tools" });
  const ffmpeg = PLAN.packages.find((entry) => entry.id === "ffmpeg");
  const ffmpegBuild = join(context.builds, ffmpeg.id);
  mkdirSync(join(ffmpegBuild, "ffbuild"), { recursive: true });
  const macros = ffmpeg.options.flatMap((option) => {
    const match = /^--(enable|disable)-(.+)$/.exec(option);
    if (!match || match[2] === "debug") return [];
    return [`#define CONFIG_${match[2].replaceAll("-", "_").toUpperCase()} ${match[1] === "enable" ? 1 : 0}`];
  });
  writeFileSync(join(ffmpegBuild, "config.h"), `${macros.join("\n")}\n`);
  const targetFlags = `-arch arm64 -mmacosx-version-min=11.0 -isysroot ${context.sdk}`;
  writeFileSync(join(ffmpegBuild, "ffbuild", "config.mak"), `ARCH=aarch64\nCFLAGS=${targetFlags}\nLDFLAGS=${targetFlags}\n`);
  assert.doesNotThrow(() => verifyConfigurationReceipt(ffmpeg, context));
  writeFileSync(join(ffmpegBuild, "config.h"), `${macros.filter((line) => !line.startsWith("#define CONFIG_LIBX264 ")).join("\n")}\n`);
  assert.throws(() => verifyConfigurationReceipt(ffmpeg, context), /LIBX264/);

  const x264 = PLAN.packages.find((entry) => entry.id === "x264");
  const x264Build = join(context.builds, x264.id);
  mkdirSync(x264Build, { recursive: true });
  const good = `prefix=${context.prefix}\nSYS_ARCH=AARCH64\nCFLAGS=${targetFlags}\nLDFLAGS=${targetFlags}\ndefault: lib-shared\ninstall: install-lib-shared\n`;
  writeFileSync(join(x264Build, "config.mak"), good);
  assert.doesNotThrow(() => verifyConfigurationReceipt(x264, context));
  writeFileSync(join(x264Build, "config.mak"), good.replace("default: lib-shared", "default: lib-static"));
  assert.throws(() => verifyConfigurationReceipt(x264, context), /shared-only/);
});

test("validates OpenSSL configdata prefix, shared mode, architecture, SDK, and macOS 11 flags", () => {
  const context = createContext({ child: temporary(), arch: "arm64", jobs: 1, sdk: "/SDK/MacOSX.sdk", toolPath: "/tools" });
  const openssl = PLAN.packages.find((entry) => entry.id === "openssl");
  const build = join(context.builds, openssl.id);
  mkdirSync(build, { recursive: true });
  const flags = `-arch ${context.arch} -mmacosx-version-min=11.0 -isysroot ${context.sdk}`;
  const configdata = `our %config = (
    "options" => "--prefix=${context.prefix} ${openssl.options.join(" ")}",
    "perlenv" => {
      "CFLAGS" => "${flags} -O2",
      "LDFLAGS" => "${flags}",
    },
    "prefix" => "${context.prefix}",
    "target" => "darwin64-arm64-cc"
);
our %target = (
    "shared_target" => "darwin-shared"
);
`;
  const receipt = join(build, "configdata.pm");
  writeFileSync(receipt, configdata);
  assert.doesNotThrow(() => verifyConfigurationReceipt(openssl, context));
  writeFileSync(receipt, configdata.replace("enable-shared", "no-shared"));
  assert.throws(() => verifyConfigurationReceipt(openssl, context), /enable-shared|shared-library/);
  writeFileSync(receipt, configdata.replaceAll(context.sdk, "/wrong/SDK"));
  assert.throws(() => verifyConfigurationReceipt(openssl, context), /target flags/);
});

test("propagates native architecture, macOS 11, SDK, prefix, and isolated discovery paths", () => {
  for (const arch of ["arm64", "x86_64"]) {
    const context = fixedContext(arch);
    const environment = createBuildEnvironment(context, {});
    assert.equal(environment.MACOSX_DEPLOYMENT_TARGET, "11.0");
    assert.match(environment.CFLAGS, new RegExp(`-arch ${arch} -mmacosx-version-min=11\\.0 -isysroot /SDK/MacOSX\\.sdk`));
    assert.equal(environment.PKG_CONFIG_PATH, "/owned/replay/install/" + arch + "/lib/pkgconfig");
    assert.equal(environment.PKG_CONFIG_LIBDIR, environment.PKG_CONFIG_PATH);
    assert.equal(environment.CMAKE_PREFIX_PATH, "/owned/replay/install/" + arch);
    assert.equal(environment.CPATH, "");
    assert.equal(environment.LIBRARY_PATH, "");
    assert.equal(environment.NO_PROXY, "*");
    const root = temporary();
    context.machineFile = join(root, "machine.ini");
    writeMachineFile(context);
    const machine = readFileSync(context.machineFile, "utf8");
    assert.match(machine, new RegExp(`cpu = '${arch === "arm64" ? "aarch64" : "x86_64"}'`));
    assert.match(machine, /-mmacosx-version-min=11\.0/);
    assert.match(machine, /-isysroot/);
  }
});

test("allows only native arm64 and x86_64 replays", () => {
  assert.doesNotThrow(() => assertNativeArchitecture("arm64", "arm64"));
  assert.doesNotThrow(() => assertNativeArchitecture("x86_64", "x64"));
  assert.throws(() => assertNativeArchitecture("x86_64", "arm64"), /native-only/);
  assert.throws(() => assertNativeArchitecture("universal", "arm64"), /architecture/);
});

test("rejects SDK and replay paths that can inject machine-file or CMake syntax", () => {
  for (const sdk of ["/SDK/it's", "/SDK/back\\slash", "/SDK/list;entry", "/SDK/line\nbreak"]) {
    assert.throws(() => createContext({ child: "/owned/replay", arch: "arm64", jobs: 1, sdk, toolPath: "/tools" }), /machine-file-safe/);
  }
  assert.throws(() => createContext({ child: "/owned/replay;other", arch: "arm64", jobs: 1, sdk: "/SDK", toolPath: "/tools" }), /machine-file-safe/);
});

test("rejects online commands and forward dependencies in a mutated plan", () => {
  const online = structuredClone(PLAN);
  online.packages[0].options.push("https://example.invalid/source");
  assert.throws(() => validatePlan(online), /online options/);
  const forward = structuredClone(PLAN);
  forward.packages[0].dependencies.push("mpv");
  assert.throws(() => validatePlan(forward), /forward dependency/);
  for (const entry of PLAN.packages) assert.doesNotMatch(JSON.stringify(normalizedCommands(entry)), /https?:|git clone|curl|wget/i);
});

test("verifies the complete source checksum and component inventory", () => {
  const root = fixtureBundle();
  const canonical = realpathSync(root);
  assert.deepEqual(verifySourceBundle(root, PLAN), {
    root: canonical,
    components: join(canonical, "component-sources"),
    files: 36,
    componentsCount: 33,
  });
});

test("rejects source tampering and symlink escapes without exposing file content", () => {
  assert.throws(() => verifySourceBundle(fixtureBundle({ tamper: true }), PLAN), /checksum mismatch/);
  const escaped = fixtureBundle({ escapeSymlink: true });
  assert.throws(() => assertSafeTree(escaped), /escapes its owned root/);
});

test("rejects component-root aliases and preserves contained relative links verbatim when copying", () => {
  assert.throws(() => verifySourceBundle(fixtureBundle({ componentAlias: true }), PLAN), /missing or aliased/);
  const source = fixtureBundle({ relativeSymlink: true });
  const output = temporary();
  initializeOutputRoot(output);
  const prepared = prepareReplay({ sourceRoot: source, outputRoot: output, arch: "arm64", jobs: 1, sdk: "/SDK/MacOSX.sdk", plan: PLAN, actualArch: "arm64" });
  const first = PLAN.packages[0];
  const copiedLink = join(prepared.context.sources, first.sourceDir, "source-link.txt");
  assert.equal(readlinkSync(copiedLink), "source.txt");
  assert.equal(realpathSync(copiedLink), join(prepared.context.sources, first.sourceDir, "source.txt"));
});

test("refuses unmarked, nonempty, and reused output roots", () => {
  const unmarked = temporary();
  assert.throws(() => assertOwnedOutputRoot(unmarked), /ENOENT|not marked/);
  writeFileSync(join(unmarked, "user-file"), "keep");
  assert.throws(() => initializeOutputRoot(unmarked), /must be empty/);
  const owned = temporary();
  initializeOutputRoot(owned);
  assert.equal(assertOwnedOutputRoot(owned), realpathSync(owned));
  const source = fixtureBundle();
  prepareReplay({ sourceRoot: source, outputRoot: owned, arch: "arm64", jobs: 1, sdk: "/SDK/MacOSX.sdk", plan: PLAN, actualArch: "arm64" });
  assert.throws(
    () => prepareReplay({ sourceRoot: source, outputRoot: owned, arch: "arm64", jobs: 1, sdk: "/SDK/MacOSX.sdk", plan: PLAN, actualArch: "arm64" }),
    /replay child already exists; it will not be deleted or reused/,
  );
});

test("bounds parallelism", () => {
  assert.throws(() => createContext({ child: "/owned/replay", arch: "arm64", jobs: 0, sdk: "/SDK", toolPath: "/tools" }), /jobs/);
  assert.throws(() => createContext({ child: "/owned/replay", arch: "arm64", jobs: 17, sdk: "/SDK", toolPath: "/tools" }), /jobs/);
  assert.equal(createContext({ child: "/owned/replay", arch: "arm64", jobs: 16, sdk: "/SDK", toolPath: "/tools" }).jobs, 16);
});

test("propagates a command failure and retains a failed status receipt", () => {
  const child = temporary();
  const context = createContext({ child, arch: "arm64", jobs: 1, sdk: "/SDK", toolPath: "/usr/bin:/bin" });
  const prepared = {
    context,
    plan: { packages: [{ id: "failing", expected: ["lib/never.dylib"] }] },
    commands: [{ id: "failing", commands: [{ command: "/usr/bin/false", args: [], cwd: child }] }],
  };
  assert.throws(() => executeReplay(prepared), /status 1/);
  assert.deepEqual(JSON.parse(readFileSync(join(child, "STATUS.json"), "utf8")), {
    schemaVersion: 1,
    result: "fail",
    error: "build command failed with status 1",
  });
});

test("requires every expected installed product", () => {
  const prefix = temporary();
  mkdirSync(join(prefix, "lib"));
  writeFileSync(join(prefix, "lib", "libexample.1.dylib"), "fixture");
  assert.doesNotThrow(() => verifyExpectedProducts({ id: "example", expected: ["lib/libexample.1.dylib"] }, prefix));
  assert.throws(() => verifyExpectedProducts({ id: "example", expected: ["bin/example"] }, prefix), /did not produce/);
  symlinkSync("libexample.1.dylib", join(prefix, "lib", "libexample.dylib"));
  assert.throws(() => verifyExpectedProducts({ id: "example", expected: ["lib/libexample.dylib"] }, prefix), /exact regular file/);
});

test("diffs the prefix and inspects every new or changed Mach-O, including unlisted files", () => {
  const child = temporary();
  const context = createContext({ child, arch: "arm64", jobs: 1, sdk: "/SDK", toolPath: "/tools" });
  mkdirSync(join(context.prefix, "lib", "plugins"), { recursive: true });
  const expected = join(context.prefix, "lib", "libexample.dylib");
  const unlisted = join(context.prefix, "lib", "plugins", "helper.bundle");
  const macho = (marker) => Buffer.concat([Buffer.from("feedfacf", "hex"), Buffer.from(marker)]);
  writeFileSync(expected, macho("before"));
  const before = snapshotInstalledMachO(context.prefix);
  writeFileSync(expected, macho("after"));
  writeFileSync(unlisted, macho("new-unlisted"));
  const inspected = [];
  const inspect = (tool, args) => {
    inspected.push([tool, ...args]);
    if (tool === "/usr/bin/lipo") return { status: 0, stdout: "arm64\n" };
    if (args[0] === "-l") return { status: 0, stdout: "      cmd LC_BUILD_VERSION\n    minos 11.0\n      cmd LC_SOURCE_VERSION\n  version 0.0\n" };
    return { status: 0, stdout: `${args[1]}:\n\t@rpath/libexample.dylib\n` };
  };
  const audit = auditInstalledMachOChanges({ id: "example", expected: ["lib/libexample.dylib"] }, context, before, inspect);
  assert.deepEqual(audit.receipt.changedMachO, ["lib/libexample.dylib", "lib/plugins/helper.bundle"]);
  assert.equal(inspected.length, 6);
  assert.deepEqual(new Set(inspected.map((call) => call.at(-1))), new Set([expected, unlisted]));
  assert.throws(
    () => auditInstalledMachOChanges({ id: "example", expected: ["lib/libexample.dylib"] }, context, audit.state, inspect),
    /was not new or changed/,
  );

  writeFileSync(unlisted, macho("changed-again"));
  const hostInspect = (tool, args) => {
    if (tool === "/usr/bin/lipo") return { status: 0, stdout: "arm64\n" };
    if (args[0] === "-l") return { status: 0, stdout: "      cmd LC_VERSION_MIN_MACOSX\n  version 11.0\n" };
    return { status: 0, stdout: `${args[1]}:\n\t/opt/homebrew/lib/libbad.dylib\n` };
  };
  assert.throws(
    () => auditInstalledMachOChanges({ id: "unexpected", expected: [] }, context, audit.state, hostInspect),
    /host package-manager/,
  );
});
