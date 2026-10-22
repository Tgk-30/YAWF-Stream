#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATHS = [
  "success-fixture/build/generated/successBaselineAssets/success-target.apk",
  "app/build/generated/tamperBaselineAssets/success-target.apk",
];
const OUTPUTS = OUTPUT_PATHS.map((path) => join(ROOT, path));
const MAX_BYTES = 160 * 1024 * 1024;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requireApk(path, expectedSha256, expectedSize) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Success target must be one regular non-symlink APK");
  }
  const canonical = realpathSync(path);
  const size = statSync(canonical).size;
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MAX_BYTES) {
    throw new Error("Success target size pin is invalid");
  }
  if (size !== expectedSize) throw new Error("Success target size does not match its pin");
  if (!/^[0-9a-f]{64}$/.test(expectedSha256) || sha256(canonical) !== expectedSha256) {
    throw new Error("Success target digest does not match its pin");
  }
  const descriptor = openSync(canonical, "r");
  try {
    const prefix = Buffer.alloc(4);
    if (readSync(descriptor, prefix, 0, prefix.length, 0) !== prefix.length
        || prefix[0] !== 0x50 || prefix[1] !== 0x4b) {
      throw new Error("Success target is not an APK-shaped ZIP archive");
    }
  } finally {
    closeSync(descriptor);
  }
  return { canonical, size };
}

export function stageSuccessTarget({ target, expectedSha256, expectedSize, receipt }) {
  const admitted = requireApk(resolve(target), expectedSha256, expectedSize);
  for (const output of OUTPUTS) {
    try {
      const existing = lstatSync(output);
      if (!existing.isFile() || existing.isSymbolicLink() || sha256(output) !== expectedSha256) {
        throw new Error("Refusing to replace an unrecognized baseline target asset");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const output of OUTPUTS) {
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(admitted.canonical, output);
    if (sha256(output) !== expectedSha256 || statSync(output).size !== expectedSize) {
      throw new Error("Staged baseline target asset changed during copy");
    }
  }
  const result = {
    classification: "fixture-success-target-asset",
    targetSha256: expectedSha256,
    targetSize: expectedSize,
    outputs: OUTPUT_PATHS,
    publicDiscoveryProof: false,
    productionOtaProof: false,
  };
  if (receipt) {
    mkdirSync(dirname(resolve(receipt)), { recursive: true });
    writeFileSync(resolve(receipt), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  return result;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] == null) {
      throw new Error("Invalid arguments");
    }
    values[argv[index].slice(2)] = argv[index + 1];
  }
  if (!values.target || !values.sha256 || !values.size || !values.receipt) {
    throw new Error(
      "Usage: stage_success_target.mjs --target APK --sha256 SHA256 --size BYTES --receipt PATH",
    );
  }
  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  stageSuccessTarget({
    target: args.target,
    expectedSha256: args.sha256,
    expectedSize: Number(args.size),
    receipt: args.receipt,
  });
  process.stdout.write("Staged the pinned success target for the baseline fixture.\n");
}
