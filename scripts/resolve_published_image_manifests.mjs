#!/usr/bin/env node

import { appendFileSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PUBLISHED_IMAGE = "ghcr.io/tgk-30/yawf-stream";

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const PLATFORM_IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_MANIFESTS = 128;
const TARGETS = ["linux/amd64", "linux/arm64"];
const INDEX_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const IMAGE_MANIFEST_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);

function fail(reason) {
  throw new Error(`Published image manifest resolution failed: ${reason}`);
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function requireDigest(value, description) {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    fail(`${description} must be a lowercase sha256 digest`);
  }
  return value;
}

function requirePlatformIdentifier(value, description) {
  if (typeof value !== "string" || !PLATFORM_IDENTIFIER.test(value)) {
    fail(`${description} is malformed`);
  }
  return value;
}

function isAttestationManifest(entry, os, architecture) {
  if (os !== "unknown" || architecture !== "unknown") return false;
  const annotations = entry.annotations;
  return isRecord(annotations)
    && annotations["vnd.docker.reference.type"] === "attestation-manifest";
}

export function resolvePublishedImageManifests(rawIndex, options = {}) {
  const image = options.image ?? PUBLISHED_IMAGE;
  if (image !== PUBLISHED_IMAGE) {
    fail(`image must be exactly ${PUBLISHED_IMAGE}`);
  }
  const indexDigest = requireDigest(options.indexDigest, "index digest");

  let parsed;
  try {
    parsed = typeof rawIndex === "string" ? JSON.parse(rawIndex) : rawIndex;
  } catch {
    fail("index JSON is malformed");
  }
  if (!isRecord(parsed)) fail("index must be a JSON object");
  if (parsed.schemaVersion !== 2 || !INDEX_MEDIA_TYPES.has(parsed.mediaType)) {
    fail("document is not a supported OCI image index");
  }
  if (!Array.isArray(parsed.manifests) || parsed.manifests.length === 0) {
    fail("index has no child manifests");
  }
  if (parsed.manifests.length > MAX_MANIFESTS) {
    fail(`index exceeds the ${MAX_MANIFESTS} child manifest limit`);
  }

  const selected = new Map();
  for (const [index, entry] of parsed.manifests.entries()) {
    if (!isRecord(entry)) fail(`child manifest ${index} is not an object`);
    const digest = requireDigest(entry.digest, `child manifest ${index} digest`);
    if (!isRecord(entry.platform)) {
      fail(`child manifest ${index} platform is missing`);
    }
    const os = requirePlatformIdentifier(entry.platform.os, `child manifest ${index} OS`);
    const architecture = requirePlatformIdentifier(
      entry.platform.architecture,
      `child manifest ${index} architecture`,
    );
    if (entry.platform.variant != null) {
      requirePlatformIdentifier(entry.platform.variant, `child manifest ${index} variant`);
    }

    if (os === "unknown" || architecture === "unknown") {
      if (isAttestationManifest(entry, os, architecture)) continue;
      fail(`child manifest ${index} has an unsupported unknown platform`);
    }

    const platform = `${os}/${architecture}`;
    if (!TARGETS.includes(platform)) continue;
    if (!IMAGE_MANIFEST_MEDIA_TYPES.has(entry.mediaType)) {
      fail(`${platform} child is not a supported image manifest`);
    }
    if (selected.has(platform)) fail(`index has duplicate ${platform} children`);
    selected.set(platform, {
      platform,
      digest,
      reference: `${image}@${digest}`,
    });
  }

  for (const platform of TARGETS) {
    if (!selected.has(platform)) fail(`index is missing ${platform}`);
  }
  if (selected.get("linux/amd64").digest === selected.get("linux/arm64").digest) {
    fail("amd64 and arm64 children must have distinct digests");
  }

  return {
    image,
    indexDigest,
    indexReference: `${image}@${indexDigest}`,
    platforms: TARGETS.map((platform) => selected.get(platform)),
  };
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null || value.startsWith("--")) {
      fail("arguments must be --name value pairs");
    }
    if (values.has(key)) fail(`duplicate argument ${key}`);
    values.set(key, value);
  }
  const allowed = new Set(["--image", "--index-digest", "--input", "--github-output"]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) fail(`unknown argument ${key}`);
  }
  for (const key of ["--image", "--index-digest", "--input"]) {
    if (!values.has(key)) fail(`missing ${key}`);
  }
  return values;
}

function readBoundedIndex(path) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    fail("could not read index JSON");
  }
  if (size <= 0 || size > MAX_INDEX_BYTES) {
    fail(`index JSON must be between 1 and ${MAX_INDEX_BYTES} bytes`);
  }
  try {
    return readFileSync(path, "utf8");
  } catch {
    fail("could not read index JSON");
  }
}

export function githubOutputs(result) {
  const byPlatform = new Map(result.platforms.map((entry) => [entry.platform, entry]));
  return [
    `index_reference=${result.indexReference}`,
    `amd64_reference=${byPlatform.get("linux/amd64").reference}`,
    `arm64_reference=${byPlatform.get("linux/arm64").reference}`,
  ].join("\n") + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const result = resolvePublishedImageManifests(readBoundedIndex(args.get("--input")), {
      image: args.get("--image"),
      indexDigest: args.get("--index-digest"),
    });
    const outputPath = args.get("--github-output");
    if (outputPath != null) appendFileSync(outputPath, githubOutputs(result), "utf8");
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Published image manifest resolution failed.");
    process.exitCode = 1;
  }
}
