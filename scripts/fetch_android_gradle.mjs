#!/usr/bin/env node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GRADLE_ALL_BYTES, verifiedGradleArchiveUrl } from "./prepare_android_gradle.mjs";

// Public asset in Gradle's own repository, not a project mirror.
export const GRADLE_ALL_ASSET_API = "https://api.github.com/repos/gradle/gradle-distributions/releases/assets/458711396";

/** Keep an optional Actions token out of argv and default curl configuration. */
export function gradleDownloadInvocation(archive, token) {
  // Installation credentials can be stateless JWTs, not just short opaque strings.
  // RFC6750 bearer syntax excludes curl config delimiters and control characters.
  if (token != null && token !== "" && (typeof token !== "string" || token.length < 20 || token.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token))) {
    throw new Error("Invalid Gradle API credential format.");
  }
  const args = [
    "--disable", "--fail", "--silent", "--show-error", "--location",
    "--max-redirs", "3", "--config", "-",
    "--proto", "=https", "--proto-redir", "=https",
    "--connect-timeout", "15", "--max-time", "300",
    "--retry", "2", "--retry-all-errors", "--retry-max-time", "330",
    "--max-filesize", String(GRADLE_ALL_BYTES),
    "--header", "Accept: application/octet-stream",
    "--write-out", "%{http_code}",
    GRADLE_ALL_ASSET_API, "--output", archive,
  ];
  // curl drops Authorization on cross-origin redirects. Never use its
  // credential-forwarding redirect option, including via a curlrc or argv.
  const input = token == null || token === "" ? "" : `header = "Authorization: Bearer ${token}"\n`;
  return { args, input };
}

export function gradleTransferStatus(result) {
  const exit = Number.isInteger(result.status) && result.status >= 0 && result.status <= 255 ? result.status : "unavailable";
  const http = typeof result.stdout === "string" && /^\d{3}$/.test(result.stdout) ? result.stdout : "unavailable";
  return `curl=${exit}, HTTP=${http}`;
}

export function fetchAndroidGradleArchive(root = process.env.RUNNER_TEMP ?? tmpdir(), token = process.env.YAWF_GRADLE_API_TOKEN) {
  // Validate the credential before creating staging files or starting curl.
  gradleDownloadInvocation("", token);
  const directory = mkdtempSync(join(root, "yawf-gradle-"));
  const archive = join(directory, "gradle-9.6.1-all.zip");
  const { args, input } = gradleDownloadInvocation(archive, token);
  const env = { ...process.env };
  delete env.YAWF_GRADLE_API_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const result = spawnSync("/usr/bin/curl", args, {
    input, env, encoding: "utf8", timeout: 360_000, maxBuffer: 64 * 1024,
  });
  if (result.status !== 0) throw new Error(`Official Gradle archive transfer failed (${gradleTransferStatus(result)}); no wrapper bootstrap permitted.`);
  verifiedGradleArchiveUrl(archive);
  return archive;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("No Gradle URL or checksum override is accepted.");
  process.stdout.write(fetchAndroidGradleArchive() + "\n");
}
