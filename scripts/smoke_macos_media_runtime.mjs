#!/usr/bin/env node
// Isolated runtime gate, not an onscreen, audible, older-OS or provider claim.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function cleanMediaEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith("DYLD_") && !key.startsWith("PYTHON") && !["SSL_CERT_FILE", "SSL_CERT_DIR", "LD_LIBRARY_PATH", "FFREPORT"].includes(key)));
}

export function requireX264(encoders) {
  if (!/\blibx264\b/.test(encoders)) throw new Error("FFmpeg lacks required libx264 encoder");
}

export function validateMediaProbe(probe) {
  const video = probe.streams?.filter((stream) => stream.codec_type === "video") ?? [];
  const audio = probe.streams?.filter((stream) => stream.codec_type === "audio") ?? [];
  if (video.length !== 1 || video[0].codec_name !== "h264" || audio.length !== 2 || audio.some((stream) => stream.codec_name !== "aac")) throw new Error("Unexpected H264/two-AAC fixture streams");
  if (audio[0].tags?.language !== "eng" || audio[1].tags?.language !== "fra" || audio[0].disposition?.default !== 0 || audio[1].disposition?.default !== 1) throw new Error("Language or non-first-default fixture metadata is incorrect");
}

export function pcmFrequency(pcm, rate = 8000) {
  const samples = Math.floor(pcm.length / 2);
  if (samples < rate / 2) throw new Error("Decoded audio is too short");
  const start = Math.floor(rate / 5), end = samples - start;
  let crossings = 0;
  for (let index = start + 1; index < end; index += 1) if (pcm.readInt16LE((index - 1) * 2) <= 0 && pcm.readInt16LE(index * 2) > 0) crossings += 1;
  return crossings * rate / (end - start);
}

export function requireSeekFrames(atZero, atTwo) {
  if (!/^MD5=[a-f0-9]{32}$/m.test(atZero) || !/^MD5=[a-f0-9]{32}$/m.test(atTwo) || atZero.trim() === atTwo.trim()) throw new Error("Nonzero seek did not decode a distinct frame");
}

export function smokeMediaRuntime(stageInput, evidenceInput, { spawn = spawnSync, platformName = process.platform } = {}) {
  if (platformName !== "darwin") throw new Error("macOS runtime smoke requires a Mac");
  const stage = resolve(stageInput), evidence = resolve(evidenceInput);
  if (existsSync(evidence)) throw new Error("Evidence directory must not exist; existing data will not be removed");
  const app = join(evidence, "MediaRuntimeFixture.app");
  mkdirSync(evidence, { recursive: true });
  const receipt = { scope: "Isolated source-built media fixture on the current Mac, no onscreen/audible/older-OS/provider/OTA claim", architecture: null, dyldOverrides: false, networkUsed: false, gates: {} };
  const deadline = Date.now() + 120_000;
  const env = cleanMediaEnvironment();
  for (const [key, name] of [["HOME", "home"], ["TMPDIR", "tmp"], ["XDG_CACHE_HOME", "cache"]]) {
    env[key] = join(evidence, name); mkdirSync(env[key]);
  }
  let serial = 0;
  function run(command, args, binary = false) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Media smoke exceeded overall120s deadline");
    const result = spawn(command, args, { env, encoding: binary ? undefined : "utf8", timeout: Math.min(30_000, remaining), killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 });
    const number = String(++serial).padStart(2, "0");
    writeFileSync(join(evidence, `${number}-stderr.log`), result.stderr ?? "");
    if (!binary) writeFileSync(join(evidence, `${number}-stdout.log`), result.stdout ?? "");
    if (result.status !== 0) throw new Error(`Runtime command${number} failed: ${result.error?.message ?? result.status}`);
    return result.stdout;
  }
  try {
    const relocation = JSON.parse(readFileSync(join(stage, "relocation.json")));
    if (!["arm64", "x86_64"].includes(relocation.arch)) throw new Error("Missing staged architecture");
    receipt.architecture = relocation.arch;
    const platform = relocation.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
    const tools = join(app, "Contents/Resources/resources/ffmpeg", platform);
    cpSync(join(stage, "Frameworks"), join(app, "Contents/Frameworks"), { recursive: true, verbatimSymlinks: true });
    cpSync(join(stage, "ffmpeg"), tools, { recursive: true });
    const ffmpeg = join(tools, "ffmpeg"), ffprobe = join(tools, "ffprobe");
    receipt.gates.ffmpeg = run(ffmpeg, ["-version"]).split("\n")[0];
    receipt.gates.ffprobe = run(ffprobe, ["-version"]).split("\n")[0];
    requireX264(run(ffmpeg, ["-hide_banner", "-encoders"]));
    const sample = join(evidence, "two-audio.mp4");
    run(ffmpeg, ["-hide_banner", "-nostdin", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=5:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-f", "lavfi", "-i", "sine=frequency=880:duration=4", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=fra", "-disposition:a:0", "0", "-disposition:a:1", "default", sample]);
    validateMediaProbe(JSON.parse(run(ffprobe, ["-v", "error", "-show_streams", "-of", "json", sample])));
    const hls = join(evidence, "selected-french.m3u8");
    run(ffmpeg, ["-hide_banner", "-nostdin", "-i", sample, "-map", "0:v:0", "-map", "0:a:1", "-c:v", "libx264", "-preset", "ultrafast", "-g", "5", "-c:a", "aac", "-hls_time", "1", "-hls_list_size", "0", "-f", "hls", hls]);
    const pcm = run(ffmpeg, ["-v", "error", "-nostdin", "-i", hls, "-map", "0:a:0", "-t", "2", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"], true);
    const frequency = pcmFrequency(pcm);
    if (Math.abs(frequency - 880) > 30) throw new Error("Selected HLS audio did not decode the second tone");
    const frame = (position) => run(ffmpeg, ["-v", "error", "-nostdin", "-ss", String(position), "-i", hls, "-map", "0:v:0", "-frames:v", "1", "-f", "hash", "-hash", "md5", "pipe:1"]);
    requireSeekFrames(frame(0), frame(2));
    receipt.gates.h264TwoAudioHlsSeek = { result: "pass", selectedAudioHz: frequency, defaultAudioIndex: 1 };
    const python = `import ctypes,sys
m=ctypes.CDLL(sys.argv[1])
m.mpv_create.restype=ctypes.c_void_p
m.mpv_set_option_string.argtypes=[ctypes.c_void_p,ctypes.c_char_p,ctypes.c_char_p]
m.mpv_initialize.argtypes=[ctypes.c_void_p]
m.mpv_terminate_destroy.argtypes=[ctypes.c_void_p]
h=m.mpv_create()
if not h: raise RuntimeError('mpv_create failed')
try:
 for key,value in [(b'config',b'no'),(b'load-scripts',b'no'),(b'vo',b'null'),(b'ao',b'null')]:
  if m.mpv_set_option_string(h,key,value)!=0: raise RuntimeError('mpv option failed')
 if m.mpv_initialize(h)!=0: raise RuntimeError('mpv_initialize failed')
finally: m.mpv_terminate_destroy(h)
print('headless libmpv initialized')`;
    run("/usr/bin/python3", ["-I", "-c", python, join(app, "Contents/Frameworks/libmpv.2.dylib")]);
    receipt.gates.headlessMpv = "pass";
    receipt.result = "pass";
  } catch (error) {
    receipt.result = "fail"; receipt.error = error.message;
    throw error;
  } finally { writeFileSync(join(evidence, "RESULTS.json"), `${JSON.stringify(receipt, null, 2)}\n`); }
  return receipt;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "--worker") {
      if (process.argv.length !== 5) throw new Error("Invalid media smoke worker arguments");
      console.log(JSON.stringify(smokeMediaRuntime(...process.argv.slice(3)), null, 2));
    } else {
    if (process.argv.length !== 4) throw new Error("Usage: node scripts/smoke_macos_media_runtime.mjs <staged-runtime> <new-evidence-directory>");
    const evidence = resolve(process.argv[3]);
    if (existsSync(evidence)) throw new Error("Evidence directory must not exist");
    const child = spawnSync(process.execPath, [process.argv[1], "--worker", ...process.argv.slice(2)], { encoding: "utf8", detached: true, timeout: 125_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 });
    if (child.error?.code === "ETIMEDOUT") {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, "RESULTS.json"), JSON.stringify({ result: "fail", error: "Hard125s outer deadline exceeded", scope: "Media runtime smoke incomplete" }));
    }
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.status !== 0) throw new Error(child.error?.message ?? "Media runtime smoke failed");
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
