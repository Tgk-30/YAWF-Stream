import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../web/public/sw.js", import.meta.url), "utf8");

function loadWorker({ cachedPaths = [], fetchFailurePaths = [] } = {}) {
  const handlers = new Map();
  const operations = [];
  const response = (sourceName) => ({
    source: sourceName,
    status: 200,
    type: "basic",
    clone() { return this; },
  });
  const cached = new Set(cachedPaths);
  const failures = new Set(fetchFailurePaths);
  const context = {
    URL,
    Promise,
    caches: {
      async keys() {
        operations.push(["cache-keys"]);
        return ["debridstreamer-shell-v2", "debridstreamer-shell-v3", "unrelated-old-cache"];
      },
      async delete(key) {
        operations.push(["cache-delete", key]);
        return true;
      },
      async match(request) {
        const path = typeof request === "string" ? request : new URL(request.url).pathname;
        operations.push(["cache-match", path]);
        return cached.has(path) ? response("cache") : undefined;
      },
      async open(name) {
        operations.push(["cache-open", name]);
        return {
          async addAll(paths) {
            operations.push(["cache-add-all", ...paths]);
          },
          async put(request) {
            operations.push(["cache-put", new URL(request.url).pathname]);
          },
        };
      },
    },
    async fetch(request, options) {
      const path = new URL(request.url).pathname;
      operations.push(["fetch", path, options?.cache ?? null]);
      if (failures.has(path)) throw new Error("offline");
      return response("network");
    },
    self: {
      location: { origin: "https://app.example" },
      clients: { claim() {} },
      skipWaiting() {},
      addEventListener(name, handler) {
        handlers.set(name, handler);
      },
    },
  };
  vm.runInNewContext(source, context, { filename: "sw.js" });
  return { handlers, operations };
}

async function dispatchFetch(worker, path) {
  let handled;
  worker.handlers.get("fetch")({
    request: {
      method: "GET",
      mode: "no-cors",
      url: `https://app.example${path}`,
    },
    respondWith(promise) {
      handled = promise;
    },
  });
  assert.ok(handled, `expected ${path} to be handled`);
  return handled;
}

test("uses cache-first only for hashed build assets", async () => {
  const worker = loadWorker({ cachedPaths: ["/assets/index-AbCdEf12.js"] });
  const result = await dispatchFetch(worker, "/assets/index-AbCdEf12.js");
  assert.equal(result.source, "cache");
  assert.deepEqual(worker.operations, [["cache-match", "/assets/index-AbCdEf12.js"]]);

  const uncached = loadWorker();
  const fetched = await dispatchFetch(uncached, "/assets/index-AbCdEf12.js");
  assert.equal(fetched.source, "network");
  assert.deepEqual(uncached.operations.slice(0, 2), [
    ["cache-match", "/assets/index-AbCdEf12.js"],
    ["fetch", "/assets/index-AbCdEf12.js", null],
  ]);
});

test("uses network-first for stable icons and falls back to their cached bytes", async () => {
  const online = loadWorker({ cachedPaths: ["/icons/icon-192.png"] });
  const fresh = await dispatchFetch(online, "/icons/icon-192.png");
  assert.equal(fresh.source, "network");
  assert.deepEqual(online.operations[0], ["fetch", "/icons/icon-192.png", "no-cache"]);

  const offline = loadWorker({
    cachedPaths: ["/icons/icon-192.png"],
    fetchFailurePaths: ["/icons/icon-192.png"],
  });
  const fallback = await dispatchFetch(offline, "/icons/icon-192.png");
  assert.equal(fallback.source, "cache");
  assert.deepEqual(offline.operations.slice(0, 2), [
    ["fetch", "/icons/icon-192.png", "no-cache"],
    ["cache-match", "/icons/icon-192.png"],
  ]);
});

test("activating v3 deletes the stale v2 shell cache", async () => {
  const worker = loadWorker();
  let activation;
  worker.handlers.get("activate")({
    waitUntil(promise) {
      activation = promise;
    },
  });
  await activation;
  assert.deepEqual(
    worker.operations.filter(([operation]) => operation === "cache-delete"),
    [
      ["cache-delete", "debridstreamer-shell-v2"],
      ["cache-delete", "unrelated-old-cache"],
    ],
  );
});
