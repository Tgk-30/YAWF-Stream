import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { dependencies, rpaths, stageMediaRuntime, trustedTool } from "./stage_macos_media_runtime.mjs";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yawf-media-stage-")));
  const prefix = join(root, "source");
  const output = join(root, "output");
  mkdirSync(join(prefix, "lib"), { recursive: true });
  mkdirSync(join(prefix, "bin"));
  const paths = ["lib/libmpv.2.dylib", "lib/libcodec.1.2.dylib", "lib/libmujs.dylib", "bin/ffmpeg", "bin/ffprobe"];
  for (const path of paths) writeFileSync(join(prefix, path), `original:${path}`);
  symlinkSync("libcodec.1.2.dylib", join(prefix, "lib", "libcodec.1.dylib"));
  const metadata = new Map(paths.map((path) => {
    const source = join(prefix, path);
    return [source, { minimum: "11.0", arch: "arm64", id: path.endsWith(".dylib") ? source : null,
      deps: path.includes("libmpv") ? [join(prefix, "lib/libcodec.1.dylib"), "build/release/libmujs.dylib"] : path.startsWith("bin/") ? ["@rpath/libcodec.1.dylib"] : [], rpaths: [join(prefix, "lib")] }];
  }));
  const calls = [];
  const state = (path) => {
    if (!metadata.has(path)) {
      const original = [...metadata.keys()].find((p) => p.startsWith(prefix) && basename(p) === basename(path));
      metadata.set(path, structuredClone(metadata.get(original)));
    }
    return metadata.get(path);
  };
  const run = (command, args) => {
    calls.push([command, ...args]);
    const data = state(args.at(-1));
    if (command === "lipo") return `${data.arch}\n`;
    if (command === "otool") {
      if (args[0] === "-D") return `file:\n${data.id ?? ""}\n`;
      if (args[0] === "-L") return `file:\n${[data.id, ...data.deps, "/usr/lib/libSystem.B.dylib"].filter(Boolean).map((p) => `\t${p} (compatibility version 1.0.0, current version 1.0.0)`).join("\n")}\n`;
      return `Load command 1\n cmd LC_BUILD_VERSION\n platform MACOS\n minos ${data.minimum}\n sdk 26.0\n${data.rpaths.map((p, i) => `Load command ${i + 2}\n cmd LC_RPATH\n path ${p} (offset 12)\n`).join("")}`;
    }
    if (command === "install_name_tool") {
      if (args[0] === "-id") data.id = args[1];
      if (args[0] === "-change") data.deps = data.deps.map((p) => p === args[1] ? args[2] : p);
      if (args[0] === "-delete_rpath") data.rpaths = data.rpaths.filter((p) => p !== args[1]);
      return "";
    }
    if (command === "codesign") return "";
    throw new Error(`Unexpected tool ${command}`);
  };
  return { root, prefix, output, metadata, calls, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("relocation resolves versioned aliases and MuJS without changing input bytes/minima", () => {
  const f = fixture();
  try {
    const unreferenced = join(f.prefix, "lib/libunreferenced.1.dylib");
    writeFileSync(unreferenced, "canonical unreferenced runtime library");
    f.metadata.set(unreferenced, { minimum: "11.0", arch: "arm64", id: unreferenced, deps: [], rpaths: [] });
    const buildHelper = join(f.prefix, "bin/brotli");
    writeFileSync(buildHelper, "audited build helper");
    const result = stageMediaRuntime({ ...f, arch: "arm64" });
    assert.equal(result.files.length, 6);
    assert.equal(existsSync(join(f.output, "Frameworks/libunreferenced.1.dylib")), true);
    assert.equal(existsSync(join(f.output, "ffmpeg/brotli")), false);
    assert.equal(result.files.every((file) => file.minimum === "11.0"), true);
    assert.deepEqual(result.files.find((file) => file.name === "libmpv.2.dylib").changes.map(([, to]) => to), ["@loader_path/libcodec.1.2.dylib", "@loader_path/libmujs.dylib"]);
    assert.equal(f.metadata.get(join(f.output, "ffmpeg", "ffmpeg")).deps[0], "@loader_path/../../../../Frameworks/libcodec.1.2.dylib");
    const finalExecutable = join(f.root, "Fixture.app/Contents/Resources/resources/ffmpeg/darwin-arm64/ffmpeg");
    assert.equal(resolve(dirname(finalExecutable), f.metadata.get(join(f.output, "ffmpeg", "ffmpeg")).deps[0].replace("@loader_path/", "")), join(f.root, "Fixture.app/Contents/Frameworks/libcodec.1.2.dylib"));
    assert.equal(f.metadata.get(join(f.output, "Frameworks", "libmpv.2.dylib")).id, "@rpath/libmpv.2.dylib");
    assert.equal(readFileSync(join(f.prefix, "lib/libmpv.2.dylib"), "utf8"), "original:lib/libmpv.2.dylib");
    assert.equal(f.calls.filter(([command]) => command === "codesign").length, 6);
    assert.equal(f.calls.some(([command]) => command === "vtool"), false);
    assert.equal(JSON.parse(readFileSync(join(f.output, "relocation.json"))).arch, "arm64");
    assert.equal(JSON.stringify(result).includes(f.root), false);
    assert.equal(JSON.stringify(result).includes("$PREFIX/lib/libcodec.1.dylib"), true);
  } finally { f.cleanup(); }
});

for (const [name, mutate, pattern] of [
  ["newer minimum", (f) => { f.metadata.get(join(f.prefix, "bin/ffmpeg")).minimum = "12.0"; }, /newer than/],
  ["wrong architecture", (f) => { f.metadata.get(join(f.prefix, "bin/ffprobe")).arch = "x86_64"; }, /Architecture mismatch/],
  ["missing dependency", (f) => { f.metadata.get(join(f.prefix, "lib/libmpv.2.dylib")).deps.push("@rpath/missing.dylib"); }, /Unresolved/],
  ["external absolute dependency", (f) => { f.metadata.get(join(f.prefix, "lib/libmpv.2.dylib")).deps.push("/opt/homebrew/lib/libcodec.1.dylib"); }, /escapes source/],
  ["traversal-shaped system dependency", (f) => { f.metadata.get(join(f.prefix, "lib/libmpv.2.dylib")).deps.push("/usr/lib/../../tmp/libevil.dylib"); }, /escapes source/],
  ["unknown relative dependency", (f) => { f.metadata.get(join(f.prefix, "lib/libmpv.2.dylib")).deps.push("untrusted/libcodec.1.dylib"); }, /Unsupported relative/],
  ["escaping library symlink", (f) => {
    const outside = join(f.root, "escape.dylib");
    writeFileSync(outside, "escape");
    symlinkSync(outside, join(f.prefix, "lib/escape.dylib"));
    f.metadata.set(outside, { minimum: "11.0", arch: "arm64", id: outside, deps: [], rpaths: [] });
  }, /escapes source/],
]) test(`rejects ${name} before writing or signing`, () => {
  const f = fixture();
  try {
    mutate(f);
    assert.throws(() => stageMediaRuntime({ ...f, arch: "arm64" }), pattern);
    assert.equal(existsSync(f.output), false);
    assert.equal(f.calls.some(([command]) => command === "codesign" || command === "install_name_tool"), false);
  } finally { f.cleanup(); }
});

test("refuses existing output without deleting it", () => {
  const f = fixture();
  try {
    mkdirSync(f.output); writeFileSync(join(f.output, "keep"), "retained");
    assert.throws(() => stageMediaRuntime({ ...f, arch: "arm64" }), /must not already exist/);
    assert.equal(readFileSync(join(f.output, "keep"), "utf8"), "retained");
  } finally { f.cleanup(); }
});

test("refuses output through a symlinked source ancestor", () => {
  const f = fixture();
  try {
    const link = join(f.root, "out-link"); symlinkSync(f.prefix, link);
    assert.throws(() => stageMediaRuntime({ ...f, output: join(link, "stage"), arch: "arm64" }), /separate trees/);
    assert.equal(existsSync(join(f.prefix, "stage")), false);
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test("post-relocation validation rejects introduced system traversal", () => {
  const f = fixture();
  try {
    const run = (command, args) => {
      const result = f.run(command, args);
      if (command === "install_name_tool") f.metadata.get(args.at(-1)).deps.push("/System/Library/../../tmp/libevil.dylib");
      return result;
    };
    assert.throws(() => stageMediaRuntime({ ...f, arch: "arm64", run }), /unexpected dependency/);
    assert.equal(f.calls.some(([command]) => command === "codesign"), false);
  } finally { f.cleanup(); }
});

test("tools use fixed system executables instead of PATH", () => {
  assert.equal(trustedTool("codesign"), "/usr/bin/codesign");
  assert.equal(trustedTool("otool"), "/usr/bin/otool");
  assert.throws(() => trustedTool("vtool"), /Unexpected/);
});

test("rejects a tool that changes minimum or fails to relocate dependencies", () => {
  for (const mode of ["min", "deps"]) {
    const f = fixture();
    try {
      const run = (command, args) => {
        if (command === "install_name_tool" && mode === "deps") return "";
        const result = f.run(command, args);
        if (mode === "min" && command === "install_name_tool") f.metadata.get(args.at(-1)).minimum = "10.13";
        return result;
      };
      assert.throws(() => stageMediaRuntime({ ...f, arch: "arm64", run }), mode === "min" ? /minimum changed/ : /unexpected dependency/);
      assert.equal(f.calls.some(([command]) => command === "codesign"), false);
    } finally { f.cleanup(); }
  }
});

test("parses dependency paths containing spaces and rejects malformed rpaths", () => {
  assert.deepEqual(dependencies("file:\n\t/a path/lib.dylib (compatibility version 1.0.0, current version 1.0.0)\n"), ["/a path/lib.dylib"]);
  assert.throws(() => rpaths("Load command 1\n cmd LC_RPATH\n"), /Malformed/);
});
