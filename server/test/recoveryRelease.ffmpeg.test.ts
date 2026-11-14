import { describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createReadStream, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";
import { realTranscoder, type Transcoder } from "../src/transcode.js";

// Root-only opt-in. The only encoder argv seam is input -re, which keeps the
// real original producer alive long enough to measure confirmed handoff.
// This tests real route/process ownership, not browser invocation or pause cure.
describe.skipIf(process.env.DS_RECOVERY_RELEASE_FFMPEG !== "1")("actual FFmpeg recovery release117", () => {
  it("confirms old actual exit before a max1 successor can encode", async () => {
    const admittedWorkRoot = process.env.DS_RECOVERY_RELEASE_WORK_ROOT;
    expect(typeof admittedWorkRoot).toBe("string");
    expect(isAbsolute(admittedWorkRoot!)).toBe(true);
    const workRoot = realpathSync(admittedWorkRoot!);
    expect(workRoot).toBe(admittedWorkRoot);
    const canonicalTmp = realpathSync(tmpdir());
    const delta = relative(workRoot, canonicalTmp);
    expect(delta === "" || (!isAbsolute(delta) && delta !== ".." && !delta.startsWith(".." + sep))).toBe(true);
    const directory = mkdtempSync(join(canonicalTmp, "yawf-recovery-release117-"));
    let app: FastifyInstance | undefined, media: Server | undefined;
    let live = 0, maximum = 0;
    const records: Array<{ child: ChildProcess; original: string[]; paced: string[]; started: number; exitAt: number | null; exitCode: number | null; signal: string | null; closeAt: number | null; stderrBytes: number; closed: Promise<void>; deadline: ReturnType<typeof setTimeout> }> = [];
    const receipt: Record<string, unknown> = { scope: "ACTUAL_LOOPBACK_PRODUCTION_ENCODING_RELEASE_ONLY_NOT_BROWSER_PROVIDER_OR_PAUSE_CURE", ok: false, originalArgsUnchangedExceptInputRe: true };
    const cookies = new Map<string, string>();
    function tool(name: string) {
      const path = realpathSync(execFileSync("which", [name], { encoding: "utf8", timeout: 2000 }).trim());
      return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), version: execFileSync(path, ["-version"], { encoding: "utf8", timeout: 2000, maxBuffer: 200_000 }).split("\n")[0] };
    }
    async function request(method: "GET" | "POST", url: string, payload?: unknown, range?: string): Promise<LightMyRequestResponse> {
      const response = await app!.inject({ method, url, payload, headers: {
        cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        ...(method === "POST" && cookies.has("ds_csrf") ? { "x-csrf-token": cookies.get("ds_csrf")! } : {}),
        ...(range ? { range } : {}),
      } });
      const set = response.headers["set-cookie"];
      for (const row of Array.isArray(set) ? set : set ? [set] : []) {
        const [pair] = row.split(";"); const index = pair!.indexOf("="); if (index > 0) cookies.set(pair!.slice(0, index), pair!.slice(index + 1));
      }
      return response;
    }
    try {
      // The explicit canonical work-root admission above forbids tmp fallback.
      const ffmpeg = tool("ffmpeg"), ffprobe = tool("ffprobe"); receipt.tools = { ffmpeg, ffprobe };
      receipt.sourceFilesSha256 = Object.fromEntries(["app.ts", "transcodeSession.ts", "transcode.ts"].map(name => [name, createHash("sha256").update(readFileSync(new URL("../src/" + name, import.meta.url))).digest("hex")]));
      const source = join(directory, "synthetic.mp4");
      execFileSync(ffmpeg.path, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "20", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-movflags", "+faststart", source], { timeout: 10_000, maxBuffer: 200_000, stdio: ["ignore", "ignore", "pipe"] });
      receipt.inputSha256 = createHash("sha256").update(readFileSync(source)).digest("hex");
      let mediaReads = 0;
      media = createServer((req, res) => {
        if (req.url !== "/synthetic.mp4" || !["GET", "HEAD"].includes(req.method ?? "")) { res.writeHead(404); res.end(); return; }
        const size = statSync(source).size; let start = 0, end = size - 1;
        if (req.headers.range != null) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!match || (!match[1] && !match[2])) { res.writeHead(416, { "content-range": `bytes */${size}` }); res.end(); return; }
          if (!match[1]) start = Math.max(0, size - Number(match[2]));
          else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) { res.writeHead(416, { "content-range": `bytes */${size}` }); res.end(); return; }
        }
        mediaReads += 1;
        res.writeHead(req.headers.range ? 206 : 200, { "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": end - start + 1, "cache-control": "no-store", ...(req.headers.range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) });
        if (req.method === "HEAD") res.end();
        else { const stream = createReadStream(source, { start, end }); res.once("close", () => stream.destroy()); stream.on("error", () => res.destroy()); stream.pipe(res); }
      });
      await new Promise<void>(resolve => media!.listen(0, "127.0.0.1", resolve));
      const address = media.address(); if (address == null || typeof address === "string") throw new Error("Owned loopback address missing.");
      const upstream = `http://127.0.0.1:${address.port}/synthetic.mp4`;
      const transcoder: Transcoder = { ...realTranscoder, spawnHls(original) {
        expect(original[original.indexOf("-i") + 1]).toBe(upstream); expect(original).not.toContain("-re");
        expect(original[original.indexOf("-c:v:0") + 1]).toBe("libx264"); expect(original).not.toContain("copy");
        const paced = [...original]; const index = paced.indexOf("-i"); expect(index).toBeGreaterThan(0); paced.splice(index, 0, "-re");
        expect(paced.filter((_, position) => position !== index)).toEqual(original);
        const child = spawn(ffmpeg.path, paced, { stdio: ["ignore", "ignore", "pipe"] });
        live += 1; maximum = Math.max(maximum, live);
        let finish!: () => void; const closed = new Promise<void>(resolve => { finish = resolve; });
        const record = { child, original: [...original], paced, started: performance.now(), exitAt: null as number | null, exitCode: null as number | null, signal: null as string | null, closeAt: null as number | null, stderrBytes: 0, closed, deadline: setTimeout(() => { if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL"); }, 25_000) };
        child.stderr?.on("data", (chunk: Buffer) => { record.stderrBytes += chunk.length; });
        child.once("exit", (code, signal) => { record.exitAt = performance.now(); record.exitCode = code; record.signal = signal; live -= 1; });
        child.once("close", () => { record.closeAt = performance.now(); clearTimeout(record.deadline); finish(); });
        child.once("error", () => { /* close is the cleanup boundary after spawn failure */ });
        records.push(record); return child;
      } };
      app = await buildApp({ config: { databasePath: join(directory, "app.sqlite"), dataDir: directory, secretKey: randomBytes(32), cookieSecure: false, logger: false, allowRawStreamUrls: true, enableTranscode: true, transcodeVideoEncoder: "libx264", maxTranscodes: 1, transcodeStartTimeoutMs: 12_000 }, transcoder });
      expect((await request("POST", "/api/auth/setup-owner", { username: "synthetic-owner117", password: "synthetic-password117", displayName: "Synthetic" })).statusCode).toBe(200);
      async function session() { const response = await request("POST", "/api/streams/sessions/raw", { upstreamUrl: upstream, contentType: "video/mp4" }); expect(response.statusCode).toBe(200); return response.json<{ session: { id: string; playbackUrl: string } }>().session; }
      async function start(id: string) {
        const root = `/api/stream/${id}/`; const master = await request("GET", root + "index.m3u8?quality=480p"); expect(master.statusCode).toBe(200);
        const child = master.body.match(/^480p\.m3u8\?generation=(transcode-[A-Za-z0-9_-]+)/m); expect(child).not.toBeNull();
        const playlist = await request("GET", root + child![0]); expect(playlist.statusCode).toBe(200);
        const segment = playlist.body.split("\n").find(line => /^480p_seg_\d+\.ts\?generation=/.test(line)); expect(segment).toBeDefined();
        const asset = await request("GET", root + segment!); expect(asset.statusCode).toBe(200); expect(asset.rawPayload.byteLength).toBeGreaterThan(188);
        return child![1]!;
      }
      const first = await session(); const generationA = await start(first.id);
      expect(records).toHaveLength(1); expect(live).toBe(1); expect(records[0]!.exitAt).toBeNull();
      const second = await session(); expect(records).toHaveLength(1); expect(live).toBe(1);
      const releasedA = await request("POST", `/api/stream/${first.id}/transcode/release`, { generation: generationA });
      expect(releasedA.statusCode).toBe(200); expect(releasedA.json()).toEqual({ ok: true });
      expect(records[0]!.exitAt).not.toBeNull(); expect(live).toBe(0);
      // Close can follow exit because stdio drains separately. Capacity proof
      // is real exit at response; wait for close separately before proceeding.
      await Promise.race([records[0]!.closed, new Promise((_, reject) => setTimeout(() => reject(new Error("Owned FFmpeg close timeout.")), 1_000))]);
      const generationB = await start(second.id); expect(records).toHaveLength(2); expect(live).toBe(1); expect(maximum).toBe(1);
      expect((await request("GET", first.playbackUrl, undefined, "bytes=0-63")).statusCode).toBe(206);
      expect((await request("POST", `/api/stream/${second.id}/transcode/release`, { generation: generationB })).statusCode).toBe(200);
      expect(records[1]!.exitAt).not.toBeNull(); expect(live).toBe(0); expect(maximum).toBe(1);
      receipt.ok = true; receipt.maximumActualLiveEncoders = maximum; receipt.freshSessionBeforeReleaseDidNotSpawn = true; receipt.rawGrantStillValid = true; receipt.mediaReads = mediaReads;
    } finally {
      let cleanupFailure: unknown;
      try { await app?.close(); } catch (error) { cleanupFailure = error; }
      for (const record of records) if (record.child.exitCode == null && record.child.signalCode == null) record.child.kill("SIGKILL");
      await Promise.all(records.map(record => Promise.race([record.closed, new Promise<void>(resolve => setTimeout(resolve, 1500))])));
      if (media) { media.closeAllConnections(); await new Promise<void>(resolve => media!.close(() => resolve())); }
      receipt.encoders = records.map(record => ({ originalArgvSha256: createHash("sha256").update(JSON.stringify(record.original)).digest("hex"), pacedArgvSha256: createHash("sha256").update(JSON.stringify(record.paced)).digest("hex"), started: record.started, exitAt: record.exitAt, exitCode: record.exitCode, signal: record.signal, closeAt: record.closeAt, stderrBytes: record.stderrBytes }));
      receipt.childrenClosed = records.every(record => record.closeAt != null); receipt.finalActualLiveEncoders = live;
      try {
        if (process.env.DS_RECOVERY_RELEASE_RECEIPT) writeFileSync(process.env.DS_RECOVERY_RELEASE_RECEIPT, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      } finally { rmSync(directory, { recursive: true, force: true }); }
      if (cleanupFailure != null) throw cleanupFailure;
    }
  }, 60_000);
});
