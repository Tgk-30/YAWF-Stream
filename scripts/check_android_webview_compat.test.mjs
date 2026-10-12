import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkAndroidWebviewBuild,
  findUnsupportedMediaFeatureRanges,
} from "./check_android_webview_compat.mjs";

function withTemporaryDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), "yawf-webview-css-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("accepts legacy min-width and max-width media queries", () => {
  const css = [
    "@media (max-width: 560px) { .compact { display: grid; } }",
    "@media (min-width: 561px) and (max-height: 500px) { .wide { display: flex; } }",
  ].join("\n");

  assert.deepEqual(findUnsupportedMediaFeatureRanges(css), []);
});

test("rejects width range comparisons in built CSS", () => {
  const findings = findUnsupportedMediaFeatureRanges(
    "@media (400px < width <= 900px) { .player { display: block; } }",
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0].prelude, /400px < width <= 900px/);
});

test("rejects nested media range comparisons", () => {
  const findings = findUnsupportedMediaFeatureRanges(
    "@media screen { @media (height > 500px) { .player { display: block; } } }",
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0].prelude, /height > 500px/);
});

test("ignores comparison characters outside media feature expressions", () => {
  const css = [
    "/* < is harmless in a comment. */",
    '.label::after { content: "1 < 2"; width: calc(100% - 2px); }',
    "@media /* > remains harmless here */ (max-width: 560px) { .compact { display: grid; } }",
  ].join("\n");

  assert.deepEqual(findUnsupportedMediaFeatureRanges(css), []);
});

test("fails closed when the built asset directory is missing", () => {
  const missing = join(tmpdir(), `yawf-missing-webview-css-${process.pid}-${Date.now()}`);

  assert.throws(
    () => checkAndroidWebviewBuild(missing),
    /built asset directory is missing/,
  );
});

test("fails closed when the built asset directory contains no CSS", () => {
  withTemporaryDirectory((directory) => {
    writeFileSync(join(directory, "index.js"), "console.log('fixture');\n");

    assert.throws(
      () => checkAndroidWebviewBuild(directory),
      /built asset directory contains no CSS files/,
    );
  });
});

test("scans built CSS recursively and reports artifact counts", () => {
  withTemporaryDirectory((directory) => {
    const assets = join(directory, "assets");
    mkdirSync(assets);
    writeFileSync(join(directory, "shell.css"), ".shell { min-height: 100vh; }\n");
    writeFileSync(
      join(assets, "player.css"),
      "@media (max-width: 560px) { .player { display: grid; } }\n",
    );

    assert.deepEqual(checkAndroidWebviewBuild(directory), {
      cssFileCount: 2,
      mediaRuleCount: 1,
    });
  });
});
