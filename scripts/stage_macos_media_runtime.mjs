#!/usr/bin/env node
// Relocate only verified source-built media inputs. Signing is performed after
// relocation; deployment minima are compared, never rewritten.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compareMacosVersions, parseOtoolMinimum } from "./check_macos_bundle_minimum.mjs";

const systemDependency = (path) => normalize(path) === path && (path.startsWith("/usr/lib/") || path.startsWith("/System/Library/"));
const within = (root, path) => path === root || path.startsWith(`${root}${sep}`);

export function trustedTool(command) {
  if (!["lipo", "otool", "install_name_tool", "codesign"].includes(command)) throw new Error("Unexpected media staging tool");
  return `/usr/bin/${command}`;
}

function canonicalDestination(input) {
  let existing = resolve(input);
  const suffix = [];
  while (!existsSync(existing)) {
    suffix.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...suffix);
}

export function tool(command, args) {
  const result = spawnSync(trustedTool(command), args, { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error?.message || result.status}`);
  return result.stdout;
}

export function dependencies(output) {
  return output.split(/\r?\n/).slice(1).map((line) => line.trim().replace(/\s+\(compatibility version.*$/, "")).filter(Boolean);
}

export function rpaths(output) {
  return output.split(/(?=^\s*Load command \d+\s*$)/m)
    .filter((block) => /^\s*cmd\s+LC_RPATH\s*$/m.test(block))
    .map((block) => /^\s*path (.*?) \(offset \d+\)\s*$/m.exec(block)?.[1])
    .map((path) => { if (!path) throw new Error("Malformed LC_RPATH"); return path; });
}

export function stageMediaRuntime({ prefix: prefixInput, output: outputInput, arch, run = tool, sign = true }) {
  if (!["arm64", "x86_64"].includes(arch)) throw new Error("Expected native arm64 or x86_64 architecture");
  const prefix = realpathSync(resolve(prefixInput));
  const output = canonicalDestination(outputInput);
  if (within(prefix, output) || within(output, prefix)) throw new Error("Output and source prefix must be separate trees");
  if (existsSync(output)) throw new Error("Output must not already exist; no existing files will be removed");
  const lib = join(prefix, "lib");
  const aliases = new Map();
  const inputs = new Map();
  for (const name of readdirSync(lib).filter((name) => name.endsWith(".dylib"))) {
    const path = realpathSync(join(lib, name));
    if (!within(lib, path) || !lstatSync(path).isFile()) throw new Error(`Library escapes source prefix: ${name}`);
    const canonical = basename(path);
    aliases.set(name, canonical);
    inputs.set(canonical, path);
  }
  const mpv = aliases.get("libmpv.2.dylib");
  if (!mpv) throw new Error("Source prefix is missing libmpv.2.dylib");
  const plan = [...inputs].map(([name, source]) => ({ name, source, library: true }));
  for (const name of ["ffmpeg", "ffprobe"]) plan.push({ name, source: join(prefix, "bin", name), library: false });

  // Complete admission before copying or signing any file.
  for (const item of plan) {
    if (!existsSync(item.source)) throw new Error(`Missing media executable: ${item.name}`);
    item.source = realpathSync(item.source);
    if (!within(prefix, item.source) || !lstatSync(item.source).isFile()) throw new Error(`Media input escapes source prefix: ${item.name}`);
    if (run("lipo", ["-archs", item.source]).trim() !== arch) throw new Error(`Architecture mismatch: ${item.name}`);
    item.loadCommands = run("otool", ["-l", item.source]);
    item.minimum = parseOtoolMinimum(item.loadCommands, item.name).minimum;
    if (compareMacosVersions(item.minimum, "11.0") > 0) throw new Error(`Source requires newer than macOS11: ${item.name}`);
    item.rpaths = rpaths(item.loadCommands);
    item.changes = [];
    const id = item.library ? run("otool", ["-D", item.source]).split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean) : [];
    for (const dependency of dependencies(run("otool", ["-L", item.source]))) {
      if (id.includes(dependency) || systemDependency(dependency)) continue;
      if (dependency.startsWith("/") && !within(prefix, dependency)) throw new Error(`Non-system dependency escapes source prefix: ${item.name}`);
      if (!dependency.startsWith("/") && !dependency.startsWith("@rpath/") && !dependency.startsWith("@loader_path/") && dependency !== "build/release/libmujs.dylib") {
        throw new Error(`Unsupported relative dependency: ${item.name}`);
      }
      const target = aliases.get(basename(dependency));
      if (!target) throw new Error(`Unresolved media dependency: ${item.name} -> ${basename(dependency)}`);
      item.changes.push([dependency, `${item.library ? "@loader_path" : "@loader_path/../../../../Frameworks"}/${target}`]);
    }
  }
  mkdirSync(join(output, "Frameworks"), { recursive: true });
  mkdirSync(join(output, "ffmpeg"));
  for (const item of plan) {
    const destination = join(output, item.library ? "Frameworks" : "ffmpeg", item.name);
    copyFileSync(item.source, destination);
    if (item.library) run("install_name_tool", ["-id", `@rpath/${item.name}`, destination]);
    for (const [from, to] of item.changes) run("install_name_tool", ["-change", from, to, destination]);
    for (const path of item.rpaths) run("install_name_tool", ["-delete_rpath", path, destination]);
    const after = parseOtoolMinimum(run("otool", ["-l", destination]), item.name).minimum;
    if (compareMacosVersions(after, item.minimum) !== 0) throw new Error(`Deployment minimum changed: ${item.name}`);
    const expectedId = `@rpath/${item.name}`;
    const expected = new Set(item.changes.map(([, to]) => to));
    for (const dependency of dependencies(run("otool", ["-L", destination]))) {
      if (systemDependency(dependency) || (item.library && dependency === expectedId) || expected.has(dependency)) continue;
      throw new Error(`Relocation left an unexpected dependency: ${item.name}`);
    }
    if (rpaths(run("otool", ["-l", destination])).length) throw new Error(`Relocation left LC_RPATH: ${item.name}`);
    // Local ad-hoc signatures are replaced by Developer ID in the release job.
    if (sign) run("codesign", ["--force", "--sign", "-", destination]);
  }
  symlinkSync(mpv, join(output, "Frameworks", "libmpv.dylib"));
  const manifest = { schemaVersion: 1, arch, declaredMinimum: "11.0", files: plan.map(({ name, library, minimum, changes }) => ({ name, library, minimum, changes: changes.map(([from, to]) => [from.startsWith("/") ? `$PREFIX/${relative(prefix, from)}` : from, to]) })), note: "Metadata and relocation only; final packaged runtime and signatures require separate verification" };
  writeFileSync(join(output, "relocation.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [prefix, output, arch] = process.argv.slice(2);
    if (!prefix || !output || !arch || process.argv.length !== 5) throw new Error("Usage: node scripts/stage_macos_media_runtime.mjs <install-prefix> <new-output> <arm64|x86_64>");
    const result = stageMediaRuntime({ prefix, output, arch });
    console.log(`Staged ${result.files.length} source-built media files for ${result.arch}; original minima preserved`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
