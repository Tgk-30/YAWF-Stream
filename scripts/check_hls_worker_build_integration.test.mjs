import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../web/package.json", import.meta.url), "utf8"));
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

test("normal web build validates the emitted root-mounted HLS worker before later artifact checks", () => {
  assert.equal(pkg.scripts["check:hls-worker"], "node ../scripts/check_hls_worker_asset.mjs dist /");
  assert.equal(
    pkg.scripts.build,
    "tsc -b && vite build && npm run check:hls-worker && npm run check:android-webview && npm run check:bundle",
  );
});

test("Docker web-build provides every source input to the HLS worker gate before building", () => {
  const webBuildStart = dockerfile.indexOf("FROM node:24-bookworm-slim AS web-build");
  const serverBuildStart = dockerfile.indexOf("FROM node:24-bookworm-slim AS server-build");
  assert.notEqual(webBuildStart, -1);
  assert.ok(serverBuildStart > webBuildStart);
  const webBuild = dockerfile.slice(webBuildStart, serverBuildStart);
  const requiredInOrder = [
    "COPY web/package*.json ./",
    "RUN npm ci",
    "COPY web/ ./",
    "COPY scripts/check_hls_worker_asset.mjs /repo/scripts/check_hls_worker_asset.mjs",
    "COPY server/src/app.ts /repo/server/src/app.ts",
    "RUN npm run build",
  ];
  let previous = -1;
  for (const line of requiredInOrder) {
    const position = webBuild.indexOf(line);
    assert.ok(position > previous, `${line} must exist in the web-build stage in dependency order`);
    previous = position;
  }
  assert.doesNotMatch(webBuild, /^COPY server\/\s/m, "web-build must not copy the complete server tree");
});
