import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { checkHlsWorkerAsset } from "./check_hls_worker_asset.mjs";
import { prepareTauriServerResources } from "./prepare_tauri_server_resources.mjs";

const workerName = "hls.worker-AbCdEf12.js";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hls-worker-asset-"));
  function put(name, value) {
    const file = join(root, name); mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  }
  const worker = 'console.log("hls.js version 1.6.16");';
  put("web/node_modules/hls.js/package.json", { version: "1.6.16" });
  put("web/package-lock.json", { packages: { "node_modules/hls.js": { version: "1.6.16" } } });
  put("web/node_modules/hls.js/dist/hls.worker.js", worker);
  put(`web/dist/assets/${workerName}`, worker);
  put("web/dist/assets/VideoPlayer-AbCdEf12.js", `const worker="/assets/${workerName}"; new Hls({workerPath:worker});`);
  put("web/dist/index.html", '<script type="module" src="/assets/index-AbCdEf12.js"></script>');
  put("web/src/components/VideoPlayer.tsx", 'import worker from "hls.js/dist/hls.worker.js?url";');
  put("server/src/app.ts", 'const MIME_TYPES = {".js": "text/javascript; charset=utf-8"};');
  put("server/dist/index.cjs", "/* YAWF_WINDOWS_STORAGE_BINDING:null */\n// Unexecuted non-Windows staging-only fixture.\n");
  put("web/src-tauri/tauri.conf.json", { build: { frontendDist: "../dist" } });
  return { root, put, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test("requires byte-identical locked worker and exact mounted lazy asset reference", () => {
  const f = fixture();
  try {
    assert.equal(checkHlsWorkerAsset({ root: f.root }).hlsVersion, "1.6.16");
    f.put("web/dist/assets/VideoPlayer-AbCdEf12.js", `const worker=\`/yawf/assets/${workerName}\`; new Hls({workerPath:worker});`);
    assert.equal(checkHlsWorkerAsset({ root: f.root, base: "/yawf/" }).workerUrl, `/yawf/assets/${workerName}`);
  } finally { f.clean(); }
});

for (const [name, mutate, expected] of [
  ["missing emission", f => rmSync(join(f.root, `web/dist/assets/${workerName}`)), /one emitted/],
  ["different worker bytes", f => f.put(`web/dist/assets/${workerName}`, "wrong"), /worker bytes/],
  ["different package version", f => {
    f.put("web/node_modules/hls.js/package.json", { version: "1.6.15" });
    const differentWorker = 'console.log("hls.js version 1.6.15");';
    f.put("web/node_modules/hls.js/dist/hls.worker.js", differentWorker);
    f.put(`web/dist/assets/${workerName}`, differentWorker);
  }, /lockfile/],
  ["CDN URL", f => f.put("web/dist/assets/VideoPlayer-AbCdEf12.js", `new Hls({workerPath:"https://cdn.example/${workerName}"})`), /same-origin/],
  ["missing workerPath", f => f.put("web/dist/assets/VideoPlayer-AbCdEf12.js", `const worker="/assets/${workerName}"; new Hls({});`), /same-origin/],
  ["eager request", f => f.put("web/dist/index.html", `<link rel="preload" href="/assets/${workerName}">`), /initial/],
  ["wrong MIME policy", f => f.put("server/src/app.ts", 'const MIME_TYPES={".js":"text/plain"}'), /JavaScript/],
  ["missing native frontend", f => f.put("web/src-tauri/tauri.conf.json", { build: { frontendDist: "../other" } }), /frontend/],
]) test(`rejects ${name}`, () => {
  const f = fixture();
  try { mutate(f); assert.throws(() => checkHlsWorkerAsset({ root: f.root }), expected); }
  finally { f.clean(); }
});

test("actual resource stager includes the worker unchanged in generated server web-dist", () => {
  const f = fixture();
  try {
    prepareTauriServerResources({ root: f.root, platform: "darwin" });
    assert.deepEqual(readFileSync(join(f.root, "web/src-tauri/resources/server/web-dist/assets", workerName)), readFileSync(join(f.root, "web/dist/assets", workerName)));
  } finally { f.clean(); }
});

test("actual service worker caches the hashed worker asset without API/media routing", async () => {
  const handlers = new Map(), operations = [];
  const response = { status: 200, type: "basic", clone() { return this; } };
  vm.runInNewContext(readFileSync(new URL("../web/public/sw.js", import.meta.url), "utf8"), {
    URL, Promise,
    self: { location: { origin: "https://app.example" }, addEventListener: (kind, handler) => handlers.set(kind, handler) },
    caches: { match: async () => { operations.push("match"); }, open: async () => ({ put: async () => { operations.push("put"); } }) },
    fetch: async (_request, options) => { assert.equal(options, undefined); operations.push("fetch"); return response; },
  });
  let result;
  handlers.get("fetch")({ request: { method: "GET", mode: "same-origin", url: `https://app.example/assets/${workerName}` }, respondWith: promise => { result = promise; } });
  assert.equal(await result, response);
  await Promise.resolve();
  assert.deepEqual(operations, ["match", "fetch", "put"]);
});
