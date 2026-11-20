#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants, lstatSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, copyFileSync, linkSync, rmSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, parse, join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const KOTLIN_JAR_URL = "https://repo.maven.apache.org/maven2/org/jetbrains/kotlin/kotlin-compiler-embeddable/2.3.21/kotlin-compiler-embeddable-2.3.21.jar";
export const KOTLIN_JAR_RELEASE_URL = "https://github.com/JetBrains/kotlin/releases/download/v2.3.21/kotlin-compiler-embeddable-2.3.21.jar";
export const KOTLIN_JAR_BYTES = 59720376;
export const KOTLIN_JAR_SHA256 = "d3e70fb011675e77ef00f1a68918d3cd91eed26058977d1e3ea2a37a293233af";
export const KOTLIN_JAR_SHA1 = "c4b47f8e33cdbeedd8c1415ab9f9ade870388162";
export const KOTLIN_POM_BYTES = 2451;
export const KOTLIN_POM_SHA256 = "9523c8feadcb17f42d04ffa97fe2a9c08e5db18f090f6db903dca5c36c7ae5c4";
const POM_NAME = "kotlin-compiler-embeddable-2.3.21.pom";
export const KOTLIN_POM_SOURCE_PATH = fileURLToPath(new URL(`./android/pinned-kotlin/${POM_NAME}`, import.meta.url));
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
    if (entry !== expected && !(depth === PARTS.length && entry === POM_NAME)) fail();
    const path = join(root, entry), child = lstatSync(path);
    if (child.isSymbolicLink()) fail();
    if (depth < PARTS.length) validateTree(path, depth + 1, allowedStage);
    else if (!child.isFile()) fail();
  }
}
export function kotlinCompilerArtifactPath(root) { return join(root, ...PARTS, NAME); }
export function kotlinCompilerPomPath(root) { return join(root, ...PARTS, POM_NAME); }
export function verifyKotlinCompilerPom(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== KOTLIN_POM_BYTES) throw new Error("Kotlin compiler POM size or file type does not match the fixed release.");
  if (createHash("sha256").update(readFileSync(path)).digest("hex") !== KOTLIN_POM_SHA256) throw new Error("Kotlin compiler POM hash does not match the fixed release.");
  return path;
}
export function verifyKotlinCompilerRepository(root) {
  validateRoot(root); validateTree(root);
  if (realpathSync(root) !== root) fail();
  verifyKotlinCompilerJar(kotlinCompilerArtifactPath(root)); verifyKotlinCompilerPom(kotlinCompilerPomPath(root));
  return root;
}
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
  if (exists(kotlinCompilerPomPath(root)) != null) verifyKotlinCompilerPom(kotlinCompilerPomPath(root));
  return artifact;
}
function publish(staged, root, stage, name = NAME, verify = verifyKotlinCompilerJar) {
  verify(staged);
  validateRoot(root); validateTree(root, 0, basename(stage));
  const artifact = join(root, ...PARTS, name);
  try { linkSync(staged, artifact); }
  catch (error) { if (error.code !== "EEXIST") throw error; verify(artifact); }
  verify(artifact);
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
export function stageVerifiedKotlinCompilerPom(source, root) {
  verifyKotlinCompilerPom(source); prepare(root);
  if (exists(kotlinCompilerPomPath(root)) != null) return root;
  const stage = mkdtempSync(join(dirname(kotlinCompilerPomPath(root)), ".kotlin-stage-"));
  try {
    const staged = join(stage, POM_NAME); copyFileSync(source, staged, constants.COPYFILE_EXCL);
    return publish(staged, root, stage, POM_NAME, verifyKotlinCompilerPom);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
export function kotlinDownloadInvocation(output) {
  return downloadInvocation(output, KOTLIN_JAR_URL, KOTLIN_JAR_BYTES);
}
export function kotlinReleaseDownloadInvocation(output) {
  return downloadInvocation(output, KOTLIN_JAR_RELEASE_URL, KOTLIN_JAR_BYTES);
}
function downloadInvocation(output, source, bytes) {
  return ["--disable", "--fail", "--silent", "--show-error", "--location", "--max-redirs", "3",
    "--config", "-", "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "15",
    "--max-time", "60", "--retry", "2", "--retry-all-errors", "--retry-max-time", "180",
    "--max-filesize", String(bytes), "--header", "Accept: application/octet-stream",
    "--write-out", "%{http_code}", source, "--output", output];
}
export function kotlinTransferStatus(result) {
  const exit = Number.isInteger(result.status) && result.status >= 0 && result.status <= 255 ? result.status : "unavailable";
  const http = typeof result.stdout === "string" && /^\d{3}$/.test(result.stdout) ? result.stdout : "unavailable";
  return `curl=${exit}, HTTP=${http}`;
}
export function retryWithKotlinAlternateSource({ status, stdout }) {
  // The fixed artifact can exist at the other official source even if one
  // CDN reports missing. A successful response with bad bytes is never retried.
  return (status === 22 && /^(?:404|408|429|500|502|503|504)$/.test(stdout)) ||
    ([6, 7, 18, 28, 52, 56].includes(status) && /^(?:000|200)$/.test(stdout));
}
function fetchArtifact(root, name, verify, invocation, fallback) {
  prepare(root);
  const artifact = join(root, ...PARTS, name);
  if (exists(artifact) != null) return root;
  const stage = mkdtempSync(join(dirname(artifact), ".kotlin-stage-"));
  try {
    const staged = join(stage, name), env = { ...process.env };
    delete env.GH_TOKEN; delete env.GITHUB_TOKEN; delete env.YAWF_GRADLE_API_TOKEN;
    const transfer = (command) => spawnSync("/usr/bin/curl", command(staged), {
      input: "", env, encoding: "utf8", timeout: 190_000, maxBuffer: 64 * 1024,
    });
    let result = transfer(invocation);
    const primary = kotlinTransferStatus(result);
    if (fallback && retryWithKotlinAlternateSource(result)) {
      rmSync(staged, { force: true });
      result = transfer(fallback);
      if (result.status !== 0 || result.stdout !== "200")
        throw new Error(`Official Kotlin transfer failed for ${name} (primary: ${primary}; alternate: ${kotlinTransferStatus(result)}).`);
    }
    if (result.status !== 0 || result.stdout !== "200") throw new Error(`Official Kotlin transfer failed for ${name} (${primary}).`);
    return publish(staged, root, stage, name, verify);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
export function fetchAndroidKotlinCompiler(root) {
  // The tiny official POM is byte-pinned in the checkout, so a repository
  // outage cannot block an already verified compiler JAR.
  verifyKotlinCompilerPom(KOTLIN_POM_SOURCE_PATH);
  fetchArtifact(root, NAME, verifyKotlinCompilerJar, kotlinDownloadInvocation, kotlinReleaseDownloadInvocation);
  stageVerifiedKotlinCompilerPom(KOTLIN_POM_SOURCE_PATH, root);
  return verifyKotlinCompilerRepository(root);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Exactly one absolute isolated Maven root is required; no URL, checksum or credential override is accepted.");
  process.stdout.write(fetchAndroidKotlinCompiler(process.argv[2]) + "\n");
}
