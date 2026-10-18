#!/usr/bin/env node

import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MACH_O_MAGICS = new Set([
  0xfeedface,
  0xfeedfacf,
  0xcefaedfe,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
  0xcafebabf,
  0xbfbafeca,
]);
const REQUIRED_RUNTIME_NAMES = new Set(["node", "ffmpeg", "ffprobe"]);
const MAX_REPORTED_MISMATCHES = 100;

function fail(message) {
  throw new Error(message);
}

export function parseMacosVersion(value, label = "macOS version") {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} is missing`);
  }
  const text = value.trim();
  if (!/^\d+(?:\.\d+){0,2}$/.test(text)) {
    fail(`${label} is not a supported numeric version: ${text}`);
  }
  const components = text.split(".").map((part) => Number(part));
  if (components.some((part) => !Number.isSafeInteger(part))) {
    fail(`${label} is outside the supported numeric range: ${text}`);
  }
  return { text, components };
}

export function parseDeclaredMinimum(value) {
  return parseMacosVersion(value, "Info.plist LSMinimumSystemVersion");
}

export function compareMacosVersions(left, right) {
  const a = typeof left === "string" ? parseMacosVersion(left) : left;
  const b = typeof right === "string" ? parseMacosVersion(right) : right;
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.components[index] ?? 0) - (b.components[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export function parseOtoolMinimum(output, label = "Mach-O slice") {
  if (typeof output !== "string" || output.trim() === "") {
    fail(`${label}: otool load-command output is missing`);
  }

  const commands = output.split(/(?=^\s*Load command \d+\s*$)/m);
  const found = [];
  for (const block of commands) {
    const command = /^\s*cmd\s+(LC_BUILD_VERSION|LC_VERSION_MIN_MACOSX)\s*$/m.exec(block)?.[1];
    if (command == null) continue;

    if (command === "LC_BUILD_VERSION") {
      const platform = /^\s*platform\s+(\S+)\s*$/m.exec(block)?.[1];
      if (platform == null || !/^(?:macos|1)$/i.test(platform)) {
        fail(`${label}: LC_BUILD_VERSION has a missing or unsupported platform`);
      }
      const minimum = /^\s*minos\s+(\S+)\s*$/m.exec(block)?.[1];
      if (minimum == null) fail(`${label}: LC_BUILD_VERSION is missing minos`);
      found.push({ command, minimum: parseMacosVersion(minimum, `${label} minos`).text });
    } else {
      const minimum = /^\s*version\s+(\S+)\s*$/m.exec(block)?.[1];
      if (minimum == null) fail(`${label}: LC_VERSION_MIN_MACOSX is missing version`);
      found.push({ command, minimum: parseMacosVersion(minimum, `${label} version`).text });
    }
  }

  if (found.length === 0) {
    fail(`${label}: no supported macOS minimum load command was found`);
  }
  if (found.some(({ minimum }) => compareMacosVersions(minimum, found[0].minimum) !== 0)) {
    fail(`${label}: conflicting macOS minimum load commands were found`);
  }
  return found[0];
}

export function assessMinimumConsistency(declaredValue, files) {
  const declared = typeof declaredValue === "string"
    ? parseDeclaredMinimum(declaredValue)
    : declaredValue;
  if (!Array.isArray(files) || files.length === 0) {
    fail("bundle contains no Mach-O files to inspect");
  }

  const mismatches = [];
  let sliceCount = 0;
  for (const file of files) {
    if (!Array.isArray(file.slices) || file.slices.length === 0) {
      fail(`${file.path ?? "Mach-O file"}: architecture metadata is missing`);
    }
    for (const slice of file.slices) {
      sliceCount += 1;
      if (typeof slice.arch !== "string" || slice.arch.trim() === "") {
        fail(`${file.path ?? "Mach-O file"}: architecture name is missing`);
      }
      const minimum = parseMacosVersion(
        slice.minimum,
        `${file.path ?? "Mach-O file"} [${slice.arch}] minimum`,
      );
      if (compareMacosVersions(minimum, declared) > 0) {
        mismatches.push({
          path: file.path,
          arch: slice.arch,
          minimum: minimum.text,
          declared: declared.text,
        });
      }
    }
  }
  return {
    declaredMinimum: declared.text,
    fileCount: files.length,
    sliceCount,
    mismatches,
  };
}

function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error != null || result.status !== 0) {
    fail(`${basename(command)} failed while reading bundle metadata`);
  }
  return result.stdout;
}

function commandOutput(runCommand, command, args) {
  const result = runCommand(command, args);
  if (typeof result === "string") return result;
  if (result != null && typeof result.stdout === "string") return result.stdout;
  fail(`${basename(command)} returned unsupported output`);
}

function plistValue(infoPlist, key, runCommand) {
  try {
    const value = commandOutput(
      runCommand,
      "/usr/bin/plutil",
      ["-extract", key, "raw", "-o", "-", infoPlist],
    ).trim();
    if (value === "") fail("empty value");
    return value;
  } catch {
    fail(`Info.plist ${key} is missing or unreadable`);
  }
}

function walkRegularFiles(root) {
  const files = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

function hasMachOMagic(path) {
  const bytes = Buffer.alloc(4);
  const fd = openSync(path, "r");
  try {
    if (readSync(fd, bytes, 0, 4, 0) !== 4) return false;
  } finally {
    closeSync(fd);
  }
  return MACH_O_MAGICS.has(bytes.readUInt32BE(0));
}

function relativeBundlePath(appPath, path) {
  return relative(appPath, path).split(sep).join("/");
}

function architecturesFor(path, runCommand) {
  const output = commandOutput(runCommand, "/usr/bin/lipo", ["-archs", path]).trim();
  const architectures = output.split(/\s+/).filter(Boolean);
  if (
    architectures.length === 0 ||
    architectures.some((arch) => !/^[A-Za-z0-9_]+$/.test(arch)) ||
    new Set(architectures).size !== architectures.length
  ) {
    fail(`${path}: lipo returned missing or unsupported architecture metadata`);
  }
  return architectures;
}

export function auditMacosBundleMinimum(appPathValue, options = {}) {
  const runCommand = options.runCommand ?? defaultRunCommand;
  if (typeof appPathValue !== "string" || appPathValue.trim() === "") {
    fail("Provide an explicit .app path.");
  }
  const appPath = resolve(appPathValue);
  if (!appPath.endsWith(".app") || !lstatSync(appPath).isDirectory()) {
    fail(`${appPath}: expected an application bundle directory`);
  }
  const contentsPath = join(appPath, "Contents");
  const infoPlist = join(contentsPath, "Info.plist");
  if (!lstatSync(infoPlist).isFile()) fail(`${infoPlist}: missing Info.plist`);

  const declared = parseDeclaredMinimum(
    plistValue(infoPlist, "LSMinimumSystemVersion", runCommand),
  );
  const executableName = plistValue(infoPlist, "CFBundleExecutable", runCommand);
  if (basename(executableName) !== executableName || executableName === "." || executableName === "..") {
    fail("Info.plist CFBundleExecutable is unsupported");
  }
  const mainExecutable = join(contentsPath, "MacOS", executableName);

  const regularFiles = walkRegularFiles(contentsPath);
  const machoPaths = [];
  for (const path of regularFiles) {
    const isMachO = hasMachOMagic(path);
    const expectedMachO = path === mainExecutable ||
      extname(path).toLowerCase() === ".dylib" ||
      REQUIRED_RUNTIME_NAMES.has(basename(path).toLowerCase());
    if (expectedMachO && !isMachO) {
      fail(`${relativeBundlePath(appPath, path)}: expected Mach-O metadata is missing or unsupported`);
    }
    if (isMachO) machoPaths.push(path);
  }
  if (!machoPaths.includes(mainExecutable)) {
    fail(`${relativeBundlePath(appPath, mainExecutable)}: main executable is missing or not Mach-O`);
  }

  const files = machoPaths.map((path) => {
    const bundlePath = relativeBundlePath(appPath, path);
    const slices = architecturesFor(path, runCommand).map((arch) => {
      const parsed = parseOtoolMinimum(
        commandOutput(runCommand, "/usr/bin/otool", ["-arch", arch, "-l", path]),
        `${bundlePath} [${arch}]`,
      );
      return { arch, minimum: parsed.minimum, command: parsed.command };
    });
    return { path: bundlePath, slices };
  });

  return {
    appPath,
    files,
    ...assessMinimumConsistency(declared, files),
  };
}

function printResult(result) {
  console.log(
    `checked ${result.fileCount} Mach-O file(s), ${result.sliceCount} architecture slice(s); Info.plist minimum ${result.declaredMinimum}`,
  );
  if (result.mismatches.length === 0) {
    console.log("ok   every inspected Mach-O slice declares a minimum no newer than the application minimum; runtime compatibility is not proven");
    return true;
  }
  console.error(
    `fail ${result.mismatches.length} Mach-O slice(s) require a newer macOS version than Info.plist declares:`,
  );
  for (const mismatch of result.mismatches.slice(0, MAX_REPORTED_MISMATCHES)) {
    console.error(
      `  ${mismatch.path} [${mismatch.arch}] requires ${mismatch.minimum}; declared ${mismatch.declared}`,
    );
  }
  if (result.mismatches.length > MAX_REPORTED_MISMATCHES) {
    console.error(`  ... ${result.mismatches.length - MAX_REPORTED_MISMATCHES} additional mismatch(es) omitted`);
  }
  console.error(
    "Action: rebuild or replace incompatible dependencies, or raise the declared floor only after compatibility validation. Do not rewrite Mach-O headers.",
  );
  return false;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1) fail("Usage: node scripts/check_macos_bundle_minimum.mjs <app-path>");
    if (!printResult(auditMacosBundleMinimum(args[0]))) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? `fail ${error.message}` : "fail macOS bundle minimum check failed");
    process.exitCode = 1;
  }
}
