import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../web/package.json", import.meta.url), "utf8"));

test("normal web build validates the emitted root-mounted HLS worker before later artifact checks", () => {
  assert.equal(pkg.scripts["check:hls-worker"], "node ../scripts/check_hls_worker_asset.mjs dist /");
  assert.equal(
    pkg.scripts.build,
    "tsc -b && vite build && npm run check:hls-worker && npm run check:android-webview && npm run check:bundle",
  );
});
