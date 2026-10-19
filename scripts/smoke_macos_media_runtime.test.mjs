import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanMediaEnvironment, pcmFrequency, requireSeekFrames, requireX264, smokeMediaRuntime, validateMediaProbe } from "./smoke_macos_media_runtime.mjs";

test("natural runtime environment excludes loader and fixture trust overrides", () => {
  assert.deepEqual(cleanMediaEnvironment({ PATH: "/usr/bin", DYLD_LIBRARY_PATH: "/external", DYLD_INSERT_LIBRARIES: "/external", SSL_CERT_FILE: "/fixture", SSL_CERT_DIR: "/fixture", LD_LIBRARY_PATH: "/external", PYTHONOPTIMIZE: "1", PYTHONPATH: "/external", FFREPORT: "file=/external/report.log" }), { PATH: "/usr/bin" });
});
test("software H264 encoding is required", () => {
  assert.doesNotThrow(() => requireX264(" V....D libx264 H264 encoder"));
  assert.throws(() => requireX264(" V....D h264_videotoolbox"), /libx264/);
});
test("fixture requires H264, two AAC languages and non-first default", () => {
  const probe = { streams: [{ codec_type: "video", codec_name: "h264" }, { codec_type: "audio", codec_name: "aac", tags: { language: "eng" }, disposition: { default: 0 } }, { codec_type: "audio", codec_name: "aac", tags: { language: "fra" }, disposition: { default: 1 } }] };
  assert.doesNotThrow(() => validateMediaProbe(probe));
  const changed = structuredClone(probe); changed.streams[2].disposition.default = 0;
  assert.throws(() => validateMediaProbe(changed), /metadata/);
  assert.throws(() => validateMediaProbe({ streams: probe.streams.slice(0, 2) }), /fixture streams/);
});
test("decoded audio frequencies distinguish the selected track", () => {
  for (const hz of [440, 880]) {
    const pcm = Buffer.alloc(32000);
    for (let i = 0; i < 16000; i += 1) pcm.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * hz * i / 8000)), i * 2);
    assert.ok(Math.abs(pcmFrequency(pcm) - hz) < 2);
  }
  assert.throws(() => pcmFrequency(Buffer.alloc(4)), /too short/);
});
test("seek must produce complete distinct frame hashes", () => {
  const first = `MD5=${"a".repeat(32)}`, second = `MD5=${"b".repeat(32)}`;
  assert.doesNotThrow(() => requireSeekFrames(first, second));
  assert.throws(() => requireSeekFrames(first, first), /distinct frame/);
  assert.throws(() => requireSeekFrames("", second), /distinct frame/);
});

function runtimeFixture(failure) {
  const root = mkdtempSync(join(tmpdir(), "yawf-media-orchestration-"));
  const stage = join(root, "stage"), evidence = join(root, "evidence");
  mkdirSync(join(stage, "Frameworks"), { recursive: true }); mkdirSync(join(stage, "ffmpeg"));
  for (const name of ["ffmpeg", "ffprobe"]) writeFileSync(join(stage, "ffmpeg", name), "injected executable fixture");
  writeFileSync(join(stage, "relocation.json"), JSON.stringify({ arch: "arm64" }));
  const probe = { streams: [{ codec_type: "video", codec_name: "h264" }, { codec_type: "audio", codec_name: "aac", tags: { language: "eng" }, disposition: { default: 0 } }, { codec_type: "audio", codec_name: "aac", tags: { language: "fra" }, disposition: { default: 1 } }] };
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if ((failure === "encode" || failure === "timeout") && args.includes("testsrc2=size=160x90:rate=5:duration=4")) return failure === "timeout" ? { status: null, error: new Error("injected timeout") } : { status: 1, stderr: "injected encoding failure" };
    if (failure === "mpv" && command === "/usr/bin/python3") return { status: 1, stderr: "injected initialize failure" };
    let stdout = "ffmpeg fixture version\n";
    if (args.includes("-encoders")) stdout = "libx264 encoder";
    if (args.includes("-show_streams")) stdout = JSON.stringify(probe);
    if (args.includes("s16le")) {
      stdout = Buffer.alloc(32000);
      for (let i = 0; i < 16000; i += 1) stdout.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * 880 * i / 8000)), i * 2);
    }
    if (args.includes("md5")) stdout = `MD5=${(args[args.indexOf("-ss") + 1] === "0" ? "a" : "b").repeat(32)}\n`;
    return { status: 0, stdout, stderr: "" };
  };
  return { root, stage, evidence, calls, spawn, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("orchestrates natural loading and input seeking with owned caches and isolated Python", () => {
  const f = runtimeFixture(); try {
    assert.equal(smokeMediaRuntime(f.stage, f.evidence, { spawn: f.spawn, platformName: "darwin" }).result, "pass");
    for (const { options } of f.calls) {
      assert.equal(options.killSignal, "SIGKILL"); assert.ok(options.timeout <= 30000);
      assert.ok(options.env.HOME.startsWith(f.evidence)); assert.ok(options.env.TMPDIR.startsWith(f.evidence));
      assert.equal(Object.keys(options.env).some((key) => key.startsWith("PYTHON") || key.startsWith("DYLD_") || key === "FFREPORT"), false);
    }
    const seeks = f.calls.filter(({ args }) => args.includes("md5"));
    assert.equal(seeks.length, 2); assert.ok(seeks.every(({ args }) => args.indexOf("-ss") < args.indexOf("-i")));
    const python = f.calls.find(({ command }) => command === "/usr/bin/python3");
    assert.equal(python.args[0], "-I"); assert.equal(/\bassert\b/.test(python.args[2]), false);
    assert.equal(JSON.parse(readFileSync(join(f.evidence, "RESULTS.json"))).result, "pass");
  } finally { f.cleanup(); }
});

for (const failure of ["encode", "timeout", "mpv"]) test(`retains failed ${failure} receipt and never marks the run passed`, () => {
  const f = runtimeFixture(failure); try {
    assert.throws(() => smokeMediaRuntime(f.stage, f.evidence, { spawn: f.spawn, platformName: "darwin" }), /failed/);
    const receipt = JSON.parse(readFileSync(join(f.evidence, "RESULTS.json")));
    assert.equal(receipt.result, "fail"); assert.equal(receipt.gates.headlessMpv, undefined);
  } finally { f.cleanup(); }
});

test("malformed stage admission still leaves a truthful failure receipt", () => {
  const f = runtimeFixture(); try {
    writeFileSync(join(f.stage, "relocation.json"), "malformed");
    assert.throws(() => smokeMediaRuntime(f.stage, f.evidence, { spawn: f.spawn, platformName: "darwin" }));
    assert.equal(f.calls.length, 0); assert.equal(JSON.parse(readFileSync(join(f.evidence, "RESULTS.json"))).result, "fail");
  } finally { f.cleanup(); }
});
