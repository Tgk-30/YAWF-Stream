import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  assessMinimumConsistency,
  auditMacosBundleMinimum,
  compareMacosVersions,
  parseDeclaredMinimum,
  parseOtoolMinimum,
} from "./check_macos_bundle_minimum.mjs";

const buildCommand = (minimum, sdk = "26.0") => `
Load command 7
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform MACOS
    minos ${minimum}
      sdk ${sdk}
   ntools 1
`;

test("parses a valid declared macOS minimum and rejects missing or malformed values", () => {
  assert.deepEqual(parseDeclaredMinimum(" 10.13 "), {
    text: "10.13",
    components: [10, 13],
  });
  assert.throws(() => parseDeclaredMinimum(undefined), /LSMinimumSystemVersion is missing/);
  assert.throws(() => parseDeclaredMinimum("13.x"), /not a supported numeric version/);
  assert.throws(() => parseDeclaredMinimum("13.5.1.2"), /not a supported numeric version/);
});

test("compares 13.5 below 13.10 numerically rather than lexically", () => {
  assert.equal(compareMacosVersions("13.5", "13.10"), -1);
  assert.equal(compareMacosVersions("13.10", "13.5"), 1);
});

test("parses modern and legacy macOS minimum load commands", () => {
  assert.deepEqual(parseOtoolMinimum(buildCommand("13.5"), "modern"), {
    command: "LC_BUILD_VERSION",
    minimum: "13.5",
  });
  assert.deepEqual(parseOtoolMinimum(`
Load command 4
          cmd LC_VERSION_MIN_MACOSX
      cmdsize 16
      version 10.13
          sdk 15.4
`, "legacy"), {
    command: "LC_VERSION_MIN_MACOSX",
    minimum: "10.13",
  });
});

test("ignores an unrelated SDK version when reading the deployment minimum", () => {
  assert.equal(parseOtoolMinimum(buildCommand("13.5", "99.10")).minimum, "13.5");
});

test("fails closed when load-command minimum metadata is missing or unsupported", () => {
  assert.throws(
    () => parseOtoolMinimum("Load command 1\n cmd LC_SEGMENT_64\n", "missing"),
    /no supported macOS minimum load command/,
  );
  assert.throws(
    () => parseOtoolMinimum(buildCommand("13.5").replace("platform MACOS", "platform IOS"), "ios"),
    /missing or unsupported platform/,
  );
  assert.throws(
    () => parseOtoolMinimum(buildCommand("13.5").replace("minos 13.5", "sdk 13.5"), "bad"),
    /missing minos/,
  );
});

test("reports only the newer slice from a mixed-minimum multi-architecture file", () => {
  const result = assessMinimumConsistency("13.5", [{
    path: "Contents/MacOS/YAWF Stream",
    slices: [
      { arch: "x86_64", minimum: "13.5" },
      { arch: "arm64", minimum: "13.10" },
    ],
  }]);
  assert.deepEqual(result.mismatches, [{
    path: "Contents/MacOS/YAWF Stream",
    arch: "arm64",
    minimum: "13.10",
    declared: "13.5",
  }]);
});

test("reports bundled Node 13.5 as incompatible with an application floor of 10.13", () => {
  const result = assessMinimumConsistency("10.13", [{
    path: "Contents/Resources/server/runtime/node",
    slices: [{ arch: "arm64", minimum: "13.5" }],
  }]);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].minimum, "13.5");
});

test("reports one macOS 26 dependency against an application floor of 15", () => {
  const result = assessMinimumConsistency("15.0", [
    { path: "Contents/MacOS/YAWF Stream", slices: [{ arch: "arm64", minimum: "15.0" }] },
    { path: "Contents/Frameworks/libnew.dylib", slices: [{ arch: "arm64", minimum: "26.0" }] },
  ]);
  assert.deepEqual(result.mismatches.map(({ path }) => path), [
    "Contents/Frameworks/libnew.dylib",
  ]);
});

test("accepts Mach-O slices whose minimum equals the declared floor", () => {
  const result = assessMinimumConsistency("15.0", [{
    path: "Contents/MacOS/YAWF Stream",
    slices: [
      { arch: "arm64", minimum: "15.0" },
      { arch: "x86_64", minimum: "15" },
    ],
  }]);
  assert.equal(result.sliceCount, 2);
  assert.deepEqual(result.mismatches, []);
});

test("audits only through injected read-only metadata commands without mutating the bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "yawf-macos-minimum-"));
  const app = join(root, "Fixture.app");
  const contents = join(app, "Contents");
  const macos = join(contents, "MacOS");
  const runtime = join(contents, "Resources", "server", "runtime");
  const ffmpegRuntime = join(contents, "Resources", "ffmpeg");
  const frameworks = join(contents, "Frameworks");
  mkdirSync(macos, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  mkdirSync(ffmpegRuntime, { recursive: true });
  mkdirSync(frameworks, { recursive: true });
  const plist = join(contents, "Info.plist");
  const main = join(macos, "Fixture");
  const node = join(runtime, "node");
  const ffmpeg = join(ffmpegRuntime, "ffmpeg");
  const ffprobe = join(ffmpegRuntime, "ffprobe");
  const dylib = join(frameworks, "libfixture.dylib");
  writeFileSync(plist, "plist fixture bytes\n");
  writeFileSync(main, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]));
  writeFileSync(node, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 5, 6, 7, 8]));
  writeFileSync(ffmpeg, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 9, 10, 11, 12]));
  writeFileSync(ffprobe, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 13, 14, 15, 16]));
  writeFileSync(dylib, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 17, 18, 19, 20]));
  writeFileSync(join(contents, "plain.txt"), "not Mach-O\n");
  const before = new Map([
    [plist, readFileSync(plist)],
    [main, readFileSync(main)],
    [node, readFileSync(node)],
    [ffmpeg, readFileSync(ffmpeg)],
    [ffprobe, readFileSync(ffprobe)],
    [dylib, readFileSync(dylib)],
  ]);
  const calls = [];
  const runCommand = (command, args) => {
    calls.push([command, [...args]]);
    if (command === "/usr/bin/plutil") {
      return args[1] === "LSMinimumSystemVersion" ? "13.5\n" : "Fixture\n";
    }
    if (command === "/usr/bin/lipo") {
      return basename(args.at(-1)) === "node" ? "x86_64 arm64\n" : "arm64\n";
    }
    if (command === "/usr/bin/otool") return buildCommand("13.5");
    throw new Error(`unexpected command ${command}`);
  };

  try {
    const result = auditMacosBundleMinimum(app, { runCommand });
    assert.equal(result.fileCount, 5);
    assert.equal(result.sliceCount, 6);
    assert.deepEqual(result.mismatches, []);
    assert.deepEqual(new Set(calls.map(([command]) => command)), new Set([
      "/usr/bin/plutil",
      "/usr/bin/lipo",
      "/usr/bin/otool",
    ]));
    assert.equal(calls.some(([command]) => /codesign|install_name_tool|vtool/.test(command)), false);
    for (const [path, bytes] of before) assert.deepEqual(readFileSync(path), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
