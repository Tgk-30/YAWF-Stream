import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("./deploy_website_cloudflare.mjs", import.meta.url), "utf8");
const begin = source.indexOf("function workerSource() {");
const end = source.indexOf("\nasync function uploadWorker(", begin);
assert.ok(begin >= 0 && end > begin);
// Evaluate only the actual generator and generated handler. Never execute deployment,
// environment/configuration discovery, credentials, subprocesses or Cloudflare APIs.
const generator = source.slice(begin, end);
const project = "fixture-site", pages = `https://${project}.pages.dev`;

function handler(prefix, upstream) {
  const generated = vm.runInNewContext(`(${generator})()`, { config: { project, prefix } }, { timeout: 1000 });
  let listener; const requests = [];
  vm.runInNewContext(generated, {
    URL, Request, Response, Headers,
    addEventListener: (type, callback) => { assert.equal(type, "fetch"); assert.equal(listener, undefined); listener = callback; },
    fetch: async request => { requests.push(request); return upstream(request); },
  }, { timeout: 1000 });
  return {
    requests,
    async request(url, method = "GET") {
      let response;
      listener({ request: new Request(url, { method, redirect: "manual", headers: { "x-client": "preserved" } }), respondWith: value => { response = value; } });
      assert.ok(response); return await response;
    },
  };
}

const mounts = [{ prefix: "/streamer", publicOrigin: "https://yawf.com" }, { prefix: "/debridstreamer", publicOrigin: "https://tgk30.com" }];
const positives = prefix => [
  ["root", "/", `${prefix}/`],
  ["relative", "./?canonical=1#top", `${prefix}/docs/?canonical=1#top`],
  ["parent relative", "../download?os=linux#install", `${prefix}/download?os=linux#install`],
  ["root relative query hash", "/download?os=mac#install", `${prefix}/download?os=mac#install`],
  ["absolute Pages", `${pages}/download?os=android#install`, `${prefix}/download?os=android#install`],
  ["protocol relative Pages", "//fixture-site.pages.dev/download", `${prefix}/download`],
  ["already mounted", `${prefix}/download?canonical=1#top`, `${prefix}/download?canonical=1#top`],
  ["absolute already mounted", `${pages}${prefix}/download`, `${prefix}/download`],
  ["prefix boundary", `${prefix}-other/path`, `${prefix}${prefix}-other/path`],
  ["query only", "?updated=1#top", `${prefix}/docs/index.html?updated=1#top`],
  ["hash only", "#top", `${prefix}/docs/index.html?original=1#top`],
  ["same origin double slash path", `${pages}//external.invalid/path`, `${prefix}//external.invalid/path`],
];

for (const { prefix, publicOrigin } of mounts) {
  for (const [label, location, expected] of positives(prefix)) {
    test(`${prefix} rebases ${label} without losing upstream response`, async () => {
      const body = "upstream canonical body";
      const worker = handler(prefix, () => new Response(body, { status: 308, statusText: "Canonical", headers: { location, "cache-control": "private, max-age=17", "x-upstream": "unchanged", "content-type": "text/plain", "content-length": String(Buffer.byteLength(body)) } }));
      const response = await worker.request(`${publicOrigin}${prefix}/docs/index.html?original=1`);
      assert.equal(worker.requests.length, 1); assert.equal(worker.requests[0].url, `${pages}/docs/index.html?original=1`);
      assert.equal(worker.requests[0].redirect, "manual"); assert.equal(worker.requests[0].headers.get("x-client"), "preserved");
      assert.equal(response.status, 308); assert.equal(response.statusText, "Canonical");
      assert.equal(response.headers.get("location"), expected);
      assert.equal(new URL(response.headers.get("location"), publicOrigin).origin, publicOrigin, "rewritten location cannot become an external authority");
      assert.equal(response.headers.get("cache-control"), "private, max-age=17"); assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(body)));
      assert.equal(response.headers.get("x-upstream"), "unchanged"); assert.equal(response.headers.get("content-type"), "text/plain");
      assert.equal(await response.text(), body);
    });
  }

  test(`${prefix} preserves noncanonical or external redirect locations`, async () => {
    const userInfo = new URL(`${pages}/private`); userInfo.username = "fixture"; userInfo.password = "unused";
    for (const location of ["https://external.invalid/login?next=/", "//external.invalid/login", "https://fixture-site.pages.dev.external.invalid/", "http://fixture-site.pages.dev/", `${publicOrigin}/intentional-parent`, userInfo.href, "mailto:fixture@example.invalid", "http://["]) {
      const worker = handler(prefix, () => new Response("external body", { status: 302, headers: { location, "x-upstream": "unchanged" } }));
      const response = await worker.request(`${publicOrigin}${prefix}/index.html`);
      assert.equal(response.status, 302); assert.equal(response.headers.get("location"), location); assert.equal(response.headers.get("x-upstream"), "unchanged"); assert.equal(await response.text(), "external body");
    }
  });

  test(`${prefix} preserves all redirect status codes and HEAD bodies`, async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const worker = handler(prefix, () => new Response(null, { status, headers: { location: "/", "content-length": "0" } }));
      const response = await worker.request(`${publicOrigin}${prefix}/index.html`, "HEAD");
      assert.equal(worker.requests[0].method, "HEAD"); assert.equal(response.status, status);
      assert.equal(response.headers.get("location"), `${prefix}/`); assert.equal(response.headers.get("content-length"), "0"); assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
  });

  test(`${prefix} leaves nonredirect Location and ordinary assets unchanged`, async () => {
    for (const status of [200, 201]) {
      const worker = handler(prefix, () => new Response("asset bytes", { status, headers: { location: "/", "x-upstream": "unchanged" } }));
      const response = await worker.request(`${publicOrigin}${prefix}/assets/app.js`);
      assert.equal(response.status, status); assert.equal(response.headers.get("location"), "/"); assert.equal(await response.text(), "asset bytes");
      assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable"); assert.equal(response.headers.get("x-upstream"), "unchanged");
    }
  });

  test(`${prefix} retains missing-Location responses and mount admission`, async () => {
    const worker = handler(prefix, () => new Response("no canonical location", { status: 308 }));
    const response = await worker.request(`${publicOrigin}${prefix}/index.html`);
    assert.equal(response.status, 308); assert.equal(response.headers.get("location"), null); assert.equal(await response.text(), "no canonical location");
    const outside = await worker.request(`${publicOrigin}/outside`); assert.equal(outside.status, 404); assert.equal(worker.requests.length, 1);
    const slash = await worker.request(`${publicOrigin}${prefix}?ref=1`); assert.equal(slash.status, 308); assert.equal(slash.headers.get("location"), `${publicOrigin}${prefix}/?ref=1`); assert.equal(worker.requests.length, 1);
  });
}
