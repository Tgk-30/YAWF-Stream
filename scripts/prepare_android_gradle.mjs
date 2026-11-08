#!/usr/bin/env node
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Official Gradle 9.6.1 release checksums. ALL adds documentation and sources,
// not a different build-tool version. Never substitute an unverified mirror.
export const GRADLE_VERSION = "9.6.1";
export const GRADLE_BIN_SHA256 = "9c0f7faeeb306cb14e4279a3e084ca6b596894089a0638e68a07c945a32c9e14";
export const GRADLE_ALL_SHA256 = "61ba77b3ff7167e60962763eb4bae79db7120c189b9544358d0ade3c1e712a83";
export const GRADLE_ALL_URL = "https://downloads.gradle.org/distributions/gradle-9.6.1-all.zip";
export const GRADLE_ALL_BYTES = 239_601_473;

/** A local bootstrap is permitted only for these exact official archive bytes. */
export function verifiedGradleArchiveUrl(path) {
  if (typeof path !== "string" || path.length === 0) throw new Error("Missing verified Gradle archive.");
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== GRADLE_ALL_BYTES) {
    throw new Error("Gradle archive is not the expected regular file and size.");
  }
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  const after = lstatSync(path);
  if (digest !== GRADLE_ALL_SHA256 || before.dev !== after.dev || before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
    throw new Error("Gradle archive does not match the pinned official bytes.");
  }
  return pathToFileURL(realpathSync(path)).href;
}

const required = {
  distributionBase: "GRADLE_USER_HOME",
  distributionPath: "wrapper/dists",
  zipStoreBase: "GRADLE_USER_HOME",
  zipStorePath: "wrapper/dists",
};
const managed = new Set([
  ...Object.keys(required), "distributionUrl", "distributionSha256Sum",
  "networkTimeout", "retries", "retryBackOffMs",
]);

/** Validate all inputs before returning a complete, idempotent replacement. */
export function prepareGradleWrapperProperties(source, archiveFile) {
  if (typeof source !== "string" || source.includes("\0") || source.replaceAll("\r\n", "").includes("\r")) {
    throw new Error("Unsupported generated Gradle wrapper properties.");
  }
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const properties = new Map();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*(?:#|!|$)/.test(line)) continue;
    const match = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line);
    const trailingSlashes = match && /(\\+)$/.exec(match[2])?.[1].length;
    // Java Properties unescapes keys and joins continued lines. Do not let a
    // hidden duplicate override the pin or absorb a newly appended setting.
    if (!match || (trailingSlashes && trailingSlashes % 2 === 1)) {
      throw new Error("Unrecognized generated Gradle wrapper property syntax.");
    }
    if (managed.has(match[1])) {
      if (properties.has(match[1])) throw new Error("Duplicate generated Gradle wrapper property.");
      properties.set(match[1], { value: match[2], index });
    }
  }
  for (const [key, value] of Object.entries(required)) {
    if (properties.get(key)?.value !== value) throw new Error("Unsupported generated Gradle cache layout.");
  }
  const archiveUrl = archiveFile == null ? null : verifiedGradleArchiveUrl(archiveFile);
  const url = properties.get("distributionUrl")?.value.replace(/^(https|file)\\:/, "$1:");
  const kind = [
    `https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip`,
    `https://downloads.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip`,
  ].includes(url) ? "bin" : url === GRADLE_ALL_URL || (archiveUrl != null && url === archiveUrl) ? "all" : null;
  if (kind == null) throw new Error("Generated Gradle distribution is not the pinned official version.");
  const checksum = properties.get("distributionSha256Sum")?.value;
  if (checksum != null && checksum !== (kind === "bin" ? GRADLE_BIN_SHA256 : GRADLE_ALL_SHA256)) {
    throw new Error("Generated Gradle distribution checksum is unexpected.");
  }
  const integer = (key, fallback, maximum) => {
    const value = properties.get(key)?.value;
    if (value == null) return fallback;
    if (!/^(0|[1-9]\d*)$/.test(value) || Number(value) > maximum) {
      throw new Error("Generated Gradle network policy is not bounded.");
    }
    return Number(value);
  };
  const networkTimeout = Math.max(60_000, integer("networkTimeout", 10_000, 120_000));
  const retries = integer("retries", 0, 2);
  const retryBackOffMs = Math.max(1_000, integer("retryBackOffMs", 500, 5_000));
  const set = (key, value) => {
    const entry = properties.get(key);
    if (entry == null) lines.push(`${key}=${value}`);
    else lines[entry.index] = `${key}=${value}`;
  };
  set("distributionUrl", (archiveUrl ?? GRADLE_ALL_URL).replace(/^(https|file):/, "$1\\:"));
  set("distributionSha256Sum", GRADLE_ALL_SHA256);
  set("networkTimeout", networkTimeout);
  set("retries", Math.max(2, retries));
  set("retryBackOffMs", retryBackOffMs);
  return lines.join(newline) + newline;
}

export function prepareAndroidGradle(repositoryRoot = fileURLToPath(new URL("..", import.meta.url)), archiveFile) {
  const path = join(repositoryRoot, "web/src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties");
  const bytes = readFileSync(path);
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes)) {
    throw new Error("Generated Gradle wrapper properties are not valid UTF-8.");
  }
  const output = prepareGradleWrapperProperties(source, archiveFile);
  if (source !== output) writeFileSync(path, output);
  return { changed: source !== output, version: GRADLE_VERSION, distribution: "all", sha256: GRADLE_ALL_SHA256 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("No Gradle distribution override is accepted.");
  console.log(JSON.stringify(prepareAndroidGradle(undefined, process.env.YAWF_GRADLE_ARCHIVE)));
}
