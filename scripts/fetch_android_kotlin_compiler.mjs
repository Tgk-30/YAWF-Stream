#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants, lstatSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, copyFileSync, linkSync, rmSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, parse, join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const KOTLIN_ASSET_API = "https://api.github.com/repos/JetBrains/kotlin/releases/assets/598615460";
export const KOTLIN_JAR_BYTES = 59720376;
export const KOTLIN_JAR_SHA256 = "d3e70fb011675e77ef00f1a68918d3cd91eed26058977d1e3ea2a37a293233af";
export const KOTLIN_JAR_SHA1 = "c4b47f8e33cdbeedd8c1415ab9f9ade870388162";
const PARTS = ["org", "jetbrains", "kotlin", "kotlin-compiler-embeddable", "2.3.21"];
const NAME = "kotlin-compiler-embeddable-2.3.21.jar";
const exists = path => { try { return lstatSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
const fail = () => { throw new Error("An isolated canonical Maven root with no symlinks or unexpected entries is required."); };

function validateRoot(root) {
  if (typeof root !== "string" || /[\x00-\x1f\x7f]/.test(root) || !isAbsolute(root) || normalize(root) !== root || root === parse(root).root) fail();
  let current = parse(root).root;
  for (const part of root.slice(current.length).split(/[\\/]/)) {
    current = join(current, part);
    const stat = exists(current);
    if (stat != null && (stat.isSymbolicLink() || !stat.isDirectory())) fail();
  }
}
function validateTree(root, depth = 0, allowedStage = null) {
  const stat = exists(root);
  if (stat == null) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail();
  const expected = depth < PARTS.length ? PARTS[depth] : NAME;
  for (const entry of readdirSync(root)) {
    if (allowedStage != null && depth === PARTS.length && entry === allowedStage) continue;
    if (entry !== expected) fail();
    const path = join(root, entry), child = lstatSync(path);
    if (child.isSymbolicLink()) fail();
    if (depth < PARTS.length) validateTree(path, depth + 1, allowedStage);
    else if (!child.isFile()) fail();
  }
}
export function kotlinCompilerArtifactPath(root) { return join(root, ...PARTS, NAME); }
export function verifyKotlinCompilerJar(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== KOTLIN_JAR_BYTES) throw new Error("Kotlin compiler artifact size or file type does not match the fixed release.");
  const bytes = readFileSync(path);
  if (createHash("sha256").update(bytes).digest("hex") !== KOTLIN_JAR_SHA256 ||
      createHash("sha1").update(bytes).digest("hex") !== KOTLIN_JAR_SHA1) throw new Error("Kotlin compiler artifact hashes do not match the fixed release.");
  return path;
}
function prepare(root) {
  validateRoot(root); validateTree(root);
  let current = parse(root).root;
  for (const part of root.slice(current.length).split(/[\\/]/).concat(PARTS)) {
    current = join(current, part);
    if (exists(current) == null) mkdirSync(current);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail();
  }
  validateRoot(root); validateTree(root);
  if (realpathSync(root) !== root) fail();
  const artifact = kotlinCompilerArtifactPath(root);
  if (exists(artifact) != null) verifyKotlinCompilerJar(artifact);
  return artifact;
}
function publish(staged, root, stage) {
  verifyKotlinCompilerJar(staged);
  validateRoot(root); validateTree(root, 0, basename(stage));
  const artifact = kotlinCompilerArtifactPath(root);
  try { linkSync(staged, artifact); }
  catch (error) { if (error.code !== "EEXIST") throw error; verifyKotlinCompilerJar(artifact); }
  verifyKotlinCompilerJar(artifact);
  return root;
}
export function stageVerifiedKotlinCompiler(source, root) {
  verifyKotlinCompilerJar(source);
  const artifact = prepare(root);
  if (exists(artifact) != null) return root;
  const stage = mkdtempSync(join(dirname(artifact), ".kotlin-stage-"));
  try {
    const staged = join(stage, NAME); copyFileSync(source, staged, constants.COPYFILE_EXCL);
    return publish(staged, root, stage);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
export function kotlinDownloadInvocation(output) {
  return ["--disable", "--fail", "--silent", "--show-error", "--location", "--max-redirs", "3",
    "--config", "-", "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "15",
    "--max-time", "60", "--retry", "2", "--retry-all-errors", "--retry-max-time", "180",
    "--max-filesize", String(KOTLIN_JAR_BYTES), "--header", "Accept: application/octet-stream",
    "--write-out", "%{http_code}", KOTLIN_ASSET_API, "--output", output];
}
export function kotlinTransferStatus(result) {
  const exit = Number.isInteger(result.status) && result.status >= 0 && result.status <= 255 ? result.status : "unavailable";
  const http = typeof result.stdout === "string" && /^\d{3}$/.test(result.stdout) ? result.stdout : "unavailable";
  return `curl=${exit}, HTTP=${http}`;
}
export function fetchAndroidKotlinCompiler(root) {
  const artifact = prepare(root);
  if (exists(artifact) != null) return root;
  const stage = mkdtempSync(join(dirname(artifact), ".kotlin-stage-"));
  try {
    const staged = join(stage, NAME), env = { ...process.env };
    delete env.GH_TOKEN; delete env.GITHUB_TOKEN; delete env.YAWF_GRADLE_API_TOKEN;
    const result = spawnSync("/usr/bin/curl", kotlinDownloadInvocation(staged), {
      input: "", env, encoding: "utf8", timeout: 190_000, maxBuffer: 64 * 1024,
    });
    if (result.status !== 0 || result.stdout !== "200") throw new Error(`Official Kotlin transfer failed (${kotlinTransferStatus(result)}).`);
    return publish(staged, root, stage);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Exactly one absolute isolated Maven root is required; no URL, checksum or credential override is accepted.");
  process.stdout.write(fetchAndroidKotlinCompiler(process.argv[2]) + "\n");
}
