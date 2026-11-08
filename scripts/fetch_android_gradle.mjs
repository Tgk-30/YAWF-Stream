#!/usr/bin/env node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GRADLE_ALL_BYTES, verifiedGradleArchiveUrl } from "./prepare_android_gradle.mjs";

// Public asset in Gradle's own repository, not a project mirror. No API token.
export const GRADLE_ALL_ASSET_API = "https://api.github.com/repos/gradle/gradle-distributions/releases/assets/458711396";

export function fetchAndroidGradleArchive(root = process.env.RUNNER_TEMP ?? tmpdir()) {
  const directory = mkdtempSync(join(root, "yawf-gradle-"));
  const archive = join(directory, "gradle-9.6.1-all.zip");
  const result = spawnSync("/usr/bin/curl", [
    "--disable", "--fail", "--silent", "--show-error", "--location",
    "--proto", "=https", "--proto-redir", "=https",
    "--connect-timeout", "15", "--max-time", "300",
    "--retry", "2", "--retry-all-errors", "--retry-max-time", "330",
    "--max-filesize", String(GRADLE_ALL_BYTES),
    "--header", "Accept: application/octet-stream",
    GRADLE_ALL_ASSET_API, "--output", archive,
  ], { encoding: "utf8", timeout: 360_000, maxBuffer: 64 * 1024 });
  if (result.status !== 0) throw new Error("Official Gradle archive transfer failed; no wrapper bootstrap permitted.");
  verifiedGradleArchiveUrl(archive);
  return archive;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("No Gradle URL or checksum override is accepted.");
  process.stdout.write(fetchAndroidGradleArchive() + "\n");
}
