#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const UPDATER_SHA256 = "129df15e095ed5ce8933d17ab9a0329da79244e14ac046df18c3fad32e01163d";
export const FIXTURE_SHA256 = "eb61c11c4b003e7c29f50ae3852d39b1dcde8ce7d88d3878528b0e989aead583";
const ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(ROOT, "../../scripts/android/YawfAndroidUpdater.kt");
const OUTPUT = resolve(
  ROOT,
  "app/build/generated/updater/com/yawf/consentfocusfixture/YawfAndroidUpdater.kt",
);
const PRODUCT_PACKAGE = "package com.tgk30.debridstreamer\n";
const FIXTURE_PACKAGE = "package com.yawf.consentfocusfixture\n";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function prepareFixtureSource(sourcePath = SOURCE, outputPath = OUTPUT) {
  assert.equal(resolve(sourcePath), SOURCE, "fixture source path is fixed to the reviewed worktree");
  assert.equal(resolve(outputPath), OUTPUT, "fixture output path is fixed");
  const source = readFileSync(SOURCE);
  assert.equal(sha256(source), UPDATER_SHA256, "updater source digest changed");
  const text = source.toString("utf8");
  assert.equal(text.split(PRODUCT_PACKAGE).length, 2, "product package declaration is not unique");
  assert.equal(text.includes(FIXTURE_PACKAGE), false, "source already contains fixture package");
  const fixture = Buffer.from(text.replace(PRODUCT_PACKAGE, FIXTURE_PACKAGE), "utf8");
  assert.equal(sha256(fixture), FIXTURE_SHA256, "package-only fixture transform changed");
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, fixture, { mode: 0o644 });
  return { sourceSha256: UPDATER_SHA256, fixtureSha256: FIXTURE_SHA256, output: OUTPUT };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const receipt = prepareFixtureSource();
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
