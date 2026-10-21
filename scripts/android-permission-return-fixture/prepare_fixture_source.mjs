#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PINNED_UPDATER_SHA256 =
  "bf42027e5f1aa0715d51ef68b87f4c6c209173465613896357071eebc599b565";
export const PINNED_FIXTURE_SOURCE_SHA256 =
  "13204e15181c05d62f492ba074962a314ef2623415c7181528f595a8eca30c93";
export const PINNED_SOURCE_REVISION =
  "9fc94a237d99b849cfc18a01085bb487915dd978";
const ORIGINAL_PACKAGE = "package com.tgk30.debridstreamer\n";
const FIXTURE_PACKAGE = "package com.yawf.permissionreturnfixture\n";
const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const FIXTURE_OUTPUT = join(
  SCRIPT_ROOT,
  "app/src/main/java/com/yawf/permissionreturnfixture/YawfAndroidUpdater.kt",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireContainedRegularFile(checkout, candidate) {
  const root = realpathSync(checkout);
  const info = lstatSync(candidate);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Candidate updater source must be a regular non-symlink file");
  }
  const canonical = realpathSync(candidate);
  const rel = relative(root, canonical);
  if (!rel || rel.startsWith("..") || resolve(root, rel) !== canonical) {
    throw new Error("Candidate updater source escaped its exact checkout");
  }
  return canonical;
}

export function prepareFixtureSource({ checkout, sourceRevision, output = FIXTURE_OUTPUT, receipt }) {
  if (!/^[0-9a-f]{64}$/.test(PINNED_UPDATER_SHA256)
      || !/^[0-9a-f]{64}$/.test(PINNED_FIXTURE_SOURCE_SHA256)) {
    throw new Error("Final updater source pins have not been supplied");
  }
  if (sourceRevision !== PINNED_SOURCE_REVISION) {
    throw new Error("Candidate source revision does not match the reviewed permission-return fix");
  }
  const expectedSource = join(resolve(checkout), "scripts/android/YawfAndroidUpdater.kt");
  const sourcePath = requireContainedRegularFile(checkout, expectedSource);
  const source = readFileSync(sourcePath, "utf8");
  const sourceDigest = sha256(Buffer.from(source, "utf8"));
  if (sourceDigest !== PINNED_UPDATER_SHA256) {
    throw new Error("Candidate updater source does not match the reviewed permission-return fix");
  }
  if (source.split(ORIGINAL_PACKAGE).length !== 2 || source.includes(FIXTURE_PACKAGE)) {
    throw new Error("Candidate updater package declaration is not the reviewed production shape");
  }
  const fixtureSource = source.replace(ORIGINAL_PACKAGE, FIXTURE_PACKAGE);
  const fixtureDigest = sha256(Buffer.from(fixtureSource, "utf8"));
  if (fixtureDigest !== PINNED_FIXTURE_SOURCE_SHA256) {
    throw new Error("Fixture package transformation changed more than the package declaration");
  }

  const outputPath = resolve(output);
  if (outputPath !== resolve(FIXTURE_OUTPUT)) {
    throw new Error("Fixture updater output path is fixed");
  }
  try {
    const existing = readFileSync(outputPath, "utf8");
    if (existing !== fixtureSource) {
      throw new Error("Refusing to overwrite unrecognized generated updater source");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, fixtureSource, { encoding: "utf8", mode: 0o644 });

  const receiptValue = {
    classification: "fixture-source-binding",
    candidateSourceRevision: sourceRevision,
    candidateUpdaterSha256: sourceDigest,
    fixtureUpdaterSha256: fixtureDigest,
    transformation: "package-declaration-only",
    publicOtaProof: false,
    installProof: false,
  };
  if (receipt) {
    mkdirSync(dirname(resolve(receipt)), { recursive: true });
    writeFileSync(resolve(receipt), `${JSON.stringify(receiptValue, null, 2)}\n`, "utf8");
  }
  return receiptValue;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value == null) throw new Error("Invalid arguments");
    values[name.slice(2)] = value;
  }
  if (!values.checkout || !values.revision || !values.receipt) {
    throw new Error("Usage: prepare_fixture_source.mjs --checkout PATH --revision SHA --receipt PATH");
  }
  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  prepareFixtureSource({
    checkout: args.checkout,
    sourceRevision: args.revision,
    receipt: args.receipt,
  });
  process.stdout.write("Prepared the exact reviewed updater for the isolated fixture.\n");
}
