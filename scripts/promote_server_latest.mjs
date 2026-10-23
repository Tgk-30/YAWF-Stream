#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

import { parseUpdateManifest } from "../deploy/updater/yawf-server-update.mjs";
import {
  PUBLISHED_IMAGE,
  resolvePublishedImageManifests,
} from "./resolve_published_image_manifests.mjs";

export const CANONICAL_REPOSITORY = "Tgk-30/YAWF-Stream";
export const CANONICAL_OWNER = "Tgk-30";
export const CONTAINER_WORKFLOW = ".github/workflows/docker-image.yml";
export const DEBIAN_WORKFLOW = ".github/workflows/deb-release.yml";

const API_ROOT = `https://api.github.com/repos/${CANONICAL_REPOSITORY}`;
const WEB_ROOT = `https://github.com/${CANONICAL_REPOSITORY}`;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REVISION = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TRUSTED_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const TARGET_PLATFORMS = new Set(["linux/amd64", "linux/arm64"]);
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_VERIFICATION_BYTES = 256 * 1024;
const MAX_PACKAGE_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

export class ServerLatestPromotionError extends Error {}

function reject(message) {
  throw new ServerLatestPromotionError(message);
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) {
    reject(`${label} has an invalid shape`);
  }
}

function exact(actual, expected, label) {
  if (actual !== expected) reject(`${label} mismatch`);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) reject(`${label} is invalid`);
  return value;
}

function lowerRevision(value, label) {
  if (typeof value !== "string" || !REVISION.test(value)) reject(`${label} is invalid`);
  return value;
}

function lowerDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) reject(`${label} is invalid`);
  return value;
}

function lowerSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) reject(`${label} is invalid`);
  return value;
}

function releaseVersion(value, label = "release version") {
  if (typeof value !== "string" || !VERSION.test(value)) reject(`${label} is invalid`);
  const parts = value.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) reject(`${label} is invalid`);
  return value;
}

function compareVersions(left, right) {
  const a = releaseVersion(left, "left version").split(".").map(Number);
  const b = releaseVersion(right, "right version").split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJsonBytes(bytes, label, maximum = MAX_JSON_BYTES) {
  if (!Buffer.isBuffer(bytes) || bytes.length <= 0 || bytes.length > maximum) {
    reject(`${label} bytes are invalid`);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    reject(`${label} JSON is malformed`);
  }
}

function parsePublishedAt(value) {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    reject("release publication timestamp is invalid");
  }
  return value;
}

function validateOptionalGuard(value, validator, label) {
  if (value == null || value === "") return null;
  return validator(value, label);
}

function exactAsset(release, tag, name, maximumSize) {
  if (!Array.isArray(release.assets) || release.assets.length > 100) reject("release assets are invalid");
  const matches = release.assets.filter((asset) => asset?.name === name);
  if (matches.length !== 1) reject(`${name} must appear exactly once`);
  const asset = matches[0];
  if (!isRecord(asset)) reject(`${name} metadata is invalid`);
  const id = positiveInteger(asset.id, `${name} asset id`);
  exact(asset.state, "uploaded", `${name} upload state`);
  const size = positiveInteger(asset.size, `${name} asset size`);
  if (size > maximumSize) reject(`${name} exceeds its size limit`);
  const digest = lowerDigest(asset.digest, `${name} asset digest`);
  exact(asset.url, `${API_ROOT}/releases/assets/${id}`, `${name} API URL`);
  exact(
    asset.browser_download_url,
    `${WEB_ROOT}/releases/download/${tag}/${name}`,
    `${name} public URL`,
  );
  return { id, name, size, digest, browserDownloadUrl: asset.browser_download_url };
}

function validateRelease(release, requestedVersion) {
  if (!isRecord(release)) reject("release metadata is invalid");
  const tag = release.tag_name;
  if (tag !== `v${requestedVersion}` && tag !== `v${requestedVersion}-web`) {
    reject("release tag mismatch");
  }
  const id = positiveInteger(release.id, "release id");
  exact(release.draft, false, "release draft state");
  exact(release.prerelease, false, "release prerelease state");
  parsePublishedAt(release.published_at);
  exact(release.url, `${API_ROOT}/releases/${id}`, "release API URL");
  exact(release.assets_url, `${API_ROOT}/releases/${id}/assets`, "release assets URL");
  exact(release.html_url, `${WEB_ROOT}/releases/tag/${tag}`, "release public URL");
  exact(release.author?.login, CANONICAL_OWNER, "release author");
  return { id, tag, url: release.html_url, publishedAt: release.published_at };
}

function validatePackageBytes(bytes, expectedVersion, label = "source package") {
  releaseVersion(expectedVersion, `${label} expected version`);
  const value = parseJsonBytes(bytes, label, MAX_PACKAGE_BYTES);
  if (!isRecord(value)) reject(`${label} is invalid`);
  exact(value.name, "debridstreamer-server", `${label} name`);
  exact(value.private, true, `${label} private flag`);
  exact(value.version, expectedVersion, `${label} version`);
  return value.version;
}

function validateVerificationRecord(record, { version, tag, sourceRevision, imageDigest }) {
  exactKeys(record, [
    "schemaVersion",
    "version",
    "sourceRevision",
    "releaseTag",
    "serverBundleSha256",
    "image",
    "checks",
    "workflowRuns",
    "boundaries",
    "knownLimitations",
  ], "server verification record");
  exact(record.schemaVersion, 1, "verification schema");
  exact(record.version, version, "verification version");
  exact(record.sourceRevision, sourceRevision, "verification source revision");
  exact(record.releaseTag, tag, "verification release tag");
  lowerSha256(record.serverBundleSha256, "verification server bundle digest");
  exactKeys(record.image, ["repository", "digest", "amd64", "arm64"], "verification image");
  exact(record.image.repository, PUBLISHED_IMAGE, "verification image repository");
  exact(record.image.digest, imageDigest, "verification image digest");
  const childReference = (architecture) => {
    const value = record.image[architecture];
    const match = new RegExp(`^${PUBLISHED_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@(sha256:[a-f0-9]{64})$`).exec(value ?? "");
    if (match == null) reject(`verification ${architecture} image reference is invalid`);
    return { reference: value, digest: match[1] };
  };
  const amd64 = childReference("amd64");
  const arm64 = childReference("arm64");
  if (amd64.digest === arm64.digest) reject("verification child image digests must be distinct");

  if (!isRecord(record.checks) || Object.keys(record.checks).length > 64) {
    reject("verification checks are invalid");
  }
  for (const [key, expected] of Object.entries({
    webAndServerTypechecks: true,
    webAndServerProductionBuilds: true,
    webProductionAuditVulnerabilities: 0,
    serverProductionAuditVulnerabilities: 0,
    publishedAmd64AndArm64ImageSmokes: true,
    ubuntu22And24InstalledPackageChecks: true,
    controlledComposeUpdaterTransactions: true,
  })) exact(record.checks[key], expected, `verification check ${key}`);
  positiveInteger(record.checks.webTestsPassed, "verification web test count");
  positiveInteger(record.checks.serverTestsPassed, "verification server test count");

  exactKeys(record.workflowRuns, ["container", "debian"], "verification workflow runs");
  const containerRun = positiveInteger(record.workflowRuns.container, "container workflow run");
  const debianRun = positiveInteger(record.workflowRuns.debian, "Debian workflow run");
  if (containerRun === debianRun) reject("verification workflow runs must be distinct");

  if (!isRecord(record.boundaries) || Object.keys(record.boundaries).length > 32 ||
      Object.values(record.boundaries).some((value) => typeof value !== "boolean")) {
    reject("verification boundaries are invalid");
  }
  if (!Array.isArray(record.knownLimitations) || record.knownLimitations.length > 32 ||
      record.knownLimitations.some((value) => typeof value !== "string" || value.length === 0 || value.length > 2_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))) {
    reject("verification limitations are invalid");
  }
  return { amd64, arm64, containerRun, debianRun };
}

function validateWorkflowRun(run, { id, kind, sourceRevision, tag }) {
  if (!isRecord(run)) reject(`${kind} workflow run metadata is invalid`);
  exact(run.id, id, `${kind} workflow run id`);
  exact(run.repository?.full_name, CANONICAL_REPOSITORY, `${kind} workflow repository`);
  exact(run.repository?.private, false, `${kind} workflow repository visibility`);
  exact(run.head_repository?.full_name, CANONICAL_REPOSITORY, `${kind} workflow head repository`);
  exact(run.head_repository?.private, false, `${kind} workflow head repository visibility`);
  exact(run.actor?.login, CANONICAL_OWNER, `${kind} workflow actor`);
  exact(run.status, "completed", `${kind} workflow status`);
  exact(run.conclusion, "success", `${kind} workflow conclusion`);
  exact(run.head_sha, sourceRevision, `${kind} workflow source revision`);
  positiveInteger(run.run_attempt, `${kind} workflow attempt`);
  exact(run.html_url, `${WEB_ROOT}/actions/runs/${id}`, `${kind} workflow public URL`);
  if (kind === "container") {
    exact(run.name, "docker-image", "container workflow name");
    exact(run.path, CONTAINER_WORKFLOW, "container workflow path");
    exact(run.event, "push", "container workflow event");
    exact(run.head_branch, tag, "container workflow tag");
  } else {
    exact(run.name, "deb-release", "Debian workflow name");
    exact(run.path, DEBIAN_WORKFLOW, "Debian workflow path");
    if (run.event !== "push" && run.event !== "workflow_dispatch") {
      reject("Debian workflow event is invalid");
    }
    if (run.event === "push") exact(run.head_branch, tag, "Debian workflow tag");
  }
  return {
    id,
    attempt: run.run_attempt,
    event: run.event,
    url: run.html_url,
  };
}

/**
 * Qualify caller-supplied public GitHub evidence. Network collection is separate so
 * every trust decision can be executed in unit tests without package credentials.
 */
export function qualifyReleaseEvidence(input) {
  if (!isRecord(input)) reject("release qualification input is invalid");
  const requestedVersion = releaseVersion(input.requestedVersion);
  const expectedSourceRevision = validateOptionalGuard(
    input.expectedSourceRevision,
    lowerRevision,
    "expected source revision",
  );
  const expectedImageDigest = validateOptionalGuard(
    input.expectedImageDigest,
    lowerDigest,
    "expected image digest",
  );
  const release = validateRelease(input.release, requestedVersion);
  const manifestAsset = exactAsset(input.release, release.tag, "server-update.json", MAX_MANIFEST_BYTES);
  const verificationName = `Server_${requestedVersion}_verification.json`;
  const verificationAsset = exactAsset(input.release, release.tag, verificationName, MAX_VERIFICATION_BYTES);
  const debianName = `debridstreamer-server_${requestedVersion}_all.deb`;
  const debianAsset = exactAsset(input.release, release.tag, debianName, 1_000_000_000);

  const manifestBytes = input.manifestBytes;
  const verificationBytes = input.verificationBytes;
  if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length !== manifestAsset.size ||
      `sha256:${sha256(manifestBytes)}` !== manifestAsset.digest) {
    reject("server-update.json bytes do not match GitHub asset metadata");
  }
  if (!Buffer.isBuffer(verificationBytes) || verificationBytes.length !== verificationAsset.size ||
      `sha256:${sha256(verificationBytes)}` !== verificationAsset.digest) {
    reject("server verification bytes do not match GitHub asset metadata");
  }

  let manifest;
  try {
    manifest = parseUpdateManifest(parseJsonBytes(manifestBytes, "server-update.json", MAX_MANIFEST_BYTES), requestedVersion);
  } catch {
    reject("server-update.json failed the updater manifest contract");
  }
  exact(manifest.debian.name, debianAsset.name, "Debian artifact name");
  exact(`sha256:${manifest.debian.sha256}`, debianAsset.digest, "Debian artifact digest");
  exact(manifest.debian.size, debianAsset.size, "Debian artifact size");
  exact(input.resolvedTagCommit, manifest.sourceRevision, "release tag source revision");
  validatePackageBytes(input.packageBytes, requestedVersion);
  if (expectedSourceRevision != null) exact(manifest.sourceRevision, expectedSourceRevision, "operator source revision guard");
  if (expectedImageDigest != null) exact(manifest.image.digest, expectedImageDigest, "operator image digest guard");

  const verification = parseJsonBytes(verificationBytes, "server verification", MAX_VERIFICATION_BYTES);
  const verified = validateVerificationRecord(verification, {
    version: requestedVersion,
    tag: release.tag,
    sourceRevision: manifest.sourceRevision,
    imageDigest: manifest.image.digest,
  });
  const containerRun = validateWorkflowRun(input.runs?.container, {
    id: verified.containerRun,
    kind: "container",
    sourceRevision: manifest.sourceRevision,
    tag: release.tag,
  });
  const debianRun = validateWorkflowRun(input.runs?.debian, {
    id: verified.debianRun,
    kind: "debian",
    sourceRevision: manifest.sourceRevision,
    tag: release.tag,
  });

  return Object.freeze({
    schemaVersion: 1,
    repository: CANONICAL_REPOSITORY,
    imageRepository: PUBLISHED_IMAGE,
    version: requestedVersion,
    releaseTag: release.tag,
    releaseId: release.id,
    releaseUrl: release.url,
    publishedAt: release.publishedAt,
    sourceRevision: manifest.sourceRevision,
    imageDigest: manifest.image.digest,
    children: {
      amd64: verified.amd64.reference,
      arm64: verified.arm64.reference,
    },
    assets: {
      manifest: { id: manifestAsset.id, name: manifestAsset.name, size: manifestAsset.size, sha256: manifestAsset.digest.slice(7) },
      verification: { id: verificationAsset.id, name: verificationAsset.name, size: verificationAsset.size, sha256: verificationAsset.digest.slice(7) },
      debian: { id: debianAsset.id, name: debianAsset.name, size: debianAsset.size, sha256: debianAsset.digest.slice(7) },
    },
    workflowRuns: { container: containerRun, debian: debianRun },
  });
}

function validatePreparedEvidence(value) {
  exactKeys(value, [
    "schemaVersion", "repository", "imageRepository", "version", "releaseTag", "releaseId",
    "releaseUrl", "publishedAt", "sourceRevision", "imageDigest", "children", "assets", "workflowRuns",
  ], "prepared release evidence");
  exact(value.schemaVersion, 1, "prepared evidence schema");
  exact(value.repository, CANONICAL_REPOSITORY, "prepared evidence repository");
  exact(value.imageRepository, PUBLISHED_IMAGE, "prepared evidence image repository");
  releaseVersion(value.version);
  if (value.releaseTag !== `v${value.version}` && value.releaseTag !== `v${value.version}-web`) reject("prepared release tag is invalid");
  positiveInteger(value.releaseId, "prepared release id");
  exact(value.releaseUrl, `${WEB_ROOT}/releases/tag/${value.releaseTag}`, "prepared release URL");
  parsePublishedAt(value.publishedAt);
  lowerRevision(value.sourceRevision, "prepared source revision");
  lowerDigest(value.imageDigest, "prepared image digest");
  exactKeys(value.children, ["amd64", "arm64"], "prepared image children");
  for (const architecture of ["amd64", "arm64"]) {
    const expected = `${PUBLISHED_IMAGE}@`;
    if (typeof value.children[architecture] !== "string" || !value.children[architecture].startsWith(expected) ||
        !DIGEST.test(value.children[architecture].slice(expected.length))) reject(`prepared ${architecture} child is invalid`);
  }
  if (value.children.amd64 === value.children.arm64) reject("prepared image children must be distinct");
  exactKeys(value.assets, ["manifest", "verification", "debian"], "prepared assets");
  for (const [key, asset] of Object.entries(value.assets)) {
    exactKeys(asset, ["id", "name", "size", "sha256"], `prepared ${key} asset`);
    positiveInteger(asset.id, `prepared ${key} asset id`);
    positiveInteger(asset.size, `prepared ${key} asset size`);
    lowerSha256(asset.sha256, `prepared ${key} asset digest`);
  }
  exactKeys(value.workflowRuns, ["container", "debian"], "prepared workflow runs");
  for (const [kind, run] of Object.entries(value.workflowRuns)) {
    exactKeys(run, ["id", "attempt", "event", "url"], `prepared ${kind} workflow run`);
    positiveInteger(run.id, `prepared ${kind} workflow run id`);
    positiveInteger(run.attempt, `prepared ${kind} workflow attempt`);
    exact(run.url, `${WEB_ROOT}/actions/runs/${run.id}`, `prepared ${kind} workflow URL`);
  }
  return value;
}

function isAttestation(entry) {
  return entry?.platform?.os === "unknown" && entry?.platform?.architecture === "unknown" &&
    entry?.annotations?.["vnd.docker.reference.type"] === "attestation-manifest";
}

export function parseIndexSummary(input, { expectedDigest = null, expectedChildren = null, label = "image index" } = {}) {
  const value = Buffer.isBuffer(input) ? parseJsonBytes(input, label) : input;
  if (!isRecord(value)) reject(`${label} is invalid`);
  const digest = lowerDigest(value.digest, `${label} digest`);
  if (expectedDigest != null) exact(digest, expectedDigest, `${label} digest`);
  positiveInteger(value.size, `${label} size`);
  let resolved;
  try {
    resolved = resolvePublishedImageManifests(value, { image: PUBLISHED_IMAGE, indexDigest: digest });
  } catch {
    reject(`${label} failed the published image manifest contract`);
  }
  for (const entry of value.manifests) {
    const platform = `${entry?.platform?.os}/${entry?.platform?.architecture}`;
    if (!TARGET_PLATFORMS.has(platform) && !isAttestation(entry)) {
      reject(`${label} contains an unqualified platform`);
    }
  }
  const byPlatform = Object.fromEntries(resolved.platforms.map((entry) => [entry.platform.slice(6), entry.reference]));
  if (expectedChildren != null) {
    exact(byPlatform.amd64, expectedChildren.amd64, `${label} amd64 child`);
    exact(byPlatform.arm64, expectedChildren.arm64, `${label} arm64 child`);
  }
  return { digest, size: value.size, children: byPlatform };
}

function imageConfigValue(config, upper, lower, label) {
  if (Object.hasOwn(config, upper) && Object.hasOwn(config, lower)) reject(`${label} is ambiguous`);
  return Object.hasOwn(config, upper) ? config[upper] : config[lower];
}

export function parseImageConfiguration(input, architecture, label = "image configuration") {
  const value = Buffer.isBuffer(input) ? parseJsonBytes(input, label) : input;
  if (!isRecord(value) || !isRecord(value.config)) reject(`${label} is invalid`);
  exact(value.os, "linux", `${label} OS`);
  exact(value.architecture, architecture, `${label} architecture`);
  const user = imageConfigValue(value.config, "User", "user", `${label} user`);
  exact(user, "node", `${label} user`);
  const labels = imageConfigValue(value.config, "Labels", "labels", `${label} labels`);
  if (!isRecord(labels) || Object.keys(labels).length > 128) reject(`${label} labels are invalid`);
  const revision = lowerRevision(labels["org.opencontainers.image.revision"], `${label} source revision`);
  const versionLabel = labels["org.opencontainers.image.version"];
  if (typeof versionLabel !== "string" || versionLabel.length === 0 || versionLabel.length > 128) {
    reject(`${label} version label is invalid`);
  }
  return { revision, versionLabel };
}

function matchingConfigurationIdentity(amd64Input, arm64Input, label) {
  const amd64 = parseImageConfiguration(amd64Input, "amd64", `${label} amd64 configuration`);
  const arm64 = parseImageConfiguration(arm64Input, "arm64", `${label} arm64 configuration`);
  exact(arm64.revision, amd64.revision, `${label} child source revisions`);
  exact(arm64.versionLabel, amd64.versionLabel, `${label} child version labels`);
  return amd64;
}

export function currentImageSourceRevision(amd64Input, arm64Input) {
  return matchingConfigurationIdentity(amd64Input, arm64Input, "current latest").revision;
}

/** Admit the immutable candidate and the exact current latest image before any write. */
export function admitPromotion(input) {
  if (!isRecord(input)) reject("promotion admission input is invalid");
  const evidence = validatePreparedEvidence(input.evidence);
  const candidateIndex = parseIndexSummary(input.candidateIndex, {
    expectedDigest: evidence.imageDigest,
    expectedChildren: evidence.children,
    label: "candidate image index",
  });
  const currentIndex = parseIndexSummary(input.currentIndex, { label: "current latest image index" });
  const candidateIdentity = matchingConfigurationIdentity(
    input.candidateAmd64,
    input.candidateArm64,
    "candidate",
  );
  exact(candidateIdentity.revision, evidence.sourceRevision, "candidate image source revision");
  exact(candidateIdentity.versionLabel, evidence.releaseTag.slice(1), "candidate image version label");
  const currentIdentity = matchingConfigurationIdentity(input.currentAmd64, input.currentArm64, "current latest");
  const currentVersion = validatePackageBytes(input.currentPackageBytes, input.currentPackageVersion, "current latest source package");
  const currentPackageRevision = lowerRevision(input.currentPackageRevision, "current latest source package revision");
  exact(currentIdentity.revision, currentPackageRevision, "current latest image source revision");
  const allowedCurrentLabels = new Set([currentVersion, `${currentVersion}-web`, "main"]);
  if (!allowedCurrentLabels.has(currentIdentity.versionLabel)) reject("current latest image version label is unqualified");

  const comparison = compareVersions(evidence.version, currentVersion);
  if (comparison < 0) reject("candidate version is older than the current latest image");
  if (comparison === 0 && candidateIndex.digest !== currentIndex.digest) {
    reject("same-version latest image has a different immutable digest");
  }
  const alreadyCurrent = candidateIndex.digest === currentIndex.digest;
  return Object.freeze({
    schemaVersion: 1,
    mode: "server-latest-promotion",
    repository: evidence.repository,
    imageRepository: evidence.imageRepository,
    version: evidence.version,
    releaseTag: evidence.releaseTag,
    releaseId: evidence.releaseId,
    sourceRevision: evidence.sourceRevision,
    candidateDigest: candidateIndex.digest,
    candidateChildren: candidateIndex.children,
    before: {
      digest: currentIndex.digest,
      children: currentIndex.children,
      version: currentVersion,
      sourceRevision: currentIdentity.revision,
      ociVersionLabel: currentIdentity.versionLabel,
    },
    alreadyCurrent,
    assets: evidence.assets,
    workflowRuns: evidence.workflowRuns,
  });
}

function validateAdmission(value) {
  exactKeys(value, [
    "schemaVersion", "mode", "repository", "imageRepository", "version", "releaseTag", "releaseId",
    "sourceRevision", "candidateDigest", "candidateChildren", "before", "alreadyCurrent", "assets", "workflowRuns",
  ], "promotion admission");
  exact(value.schemaVersion, 1, "promotion admission schema");
  exact(value.mode, "server-latest-promotion", "promotion admission mode");
  exact(value.repository, CANONICAL_REPOSITORY, "promotion admission repository");
  exact(value.imageRepository, PUBLISHED_IMAGE, "promotion admission image repository");
  releaseVersion(value.version);
  if (value.releaseTag !== `v${value.version}` && value.releaseTag !== `v${value.version}-web`) {
    reject("promotion admission release tag is invalid");
  }
  positiveInteger(value.releaseId, "promotion admission release id");
  lowerRevision(value.sourceRevision, "promotion admission source revision");
  lowerDigest(value.candidateDigest, "promotion admission candidate digest");
  exactKeys(value.candidateChildren, ["amd64", "arm64"], "promotion admission candidate children");
  for (const architecture of ["amd64", "arm64"]) {
    const prefix = `${PUBLISHED_IMAGE}@`;
    const reference = value.candidateChildren[architecture];
    if (typeof reference !== "string" || !reference.startsWith(prefix) || !DIGEST.test(reference.slice(prefix.length))) {
      reject(`promotion admission ${architecture} candidate child is invalid`);
    }
  }
  if (typeof value.alreadyCurrent !== "boolean") reject("promotion admission current state is invalid");
  exactKeys(value.before, ["digest", "children", "version", "sourceRevision", "ociVersionLabel"], "promotion admission prior image");
  lowerDigest(value.before?.digest, "promotion admission prior digest");
  releaseVersion(value.before?.version, "promotion admission prior version");
  lowerRevision(value.before?.sourceRevision, "promotion admission prior source revision");
  exactKeys(value.before.children, ["amd64", "arm64"], "promotion admission prior children");
  for (const architecture of ["amd64", "arm64"]) {
    const prefix = `${PUBLISHED_IMAGE}@`;
    const reference = value.before.children[architecture];
    if (typeof reference !== "string" || !reference.startsWith(prefix) || !DIGEST.test(reference.slice(prefix.length))) {
      reject(`promotion admission prior ${architecture} child is invalid`);
    }
  }
  if (![value.before.version, `${value.before.version}-web`, "main"].includes(value.before.ociVersionLabel)) {
    reject("promotion admission prior OCI version label is invalid");
  }
  const comparison = compareVersions(value.version, value.before.version);
  if (comparison < 0 || (comparison === 0 && value.candidateDigest !== value.before.digest)) {
    reject("promotion admission would replace latest with an older or conflicting image");
  }
  exact(value.alreadyCurrent, value.candidateDigest === value.before.digest, "promotion admission current state");
  exactKeys(value.assets, ["manifest", "verification", "debian"], "promotion admission assets");
  for (const [key, asset] of Object.entries(value.assets)) {
    exactKeys(asset, ["id", "name", "size", "sha256"], `promotion admission ${key} asset`);
    positiveInteger(asset.id, `promotion admission ${key} asset id`);
    positiveInteger(asset.size, `promotion admission ${key} asset size`);
    lowerSha256(asset.sha256, `promotion admission ${key} asset digest`);
  }
  exact(value.assets.manifest.name, "server-update.json", "promotion admission manifest name");
  exact(value.assets.verification.name, `Server_${value.version}_verification.json`, "promotion admission verification name");
  exact(value.assets.debian.name, `debridstreamer-server_${value.version}_all.deb`, "promotion admission Debian name");
  exactKeys(value.workflowRuns, ["container", "debian"], "promotion admission workflow runs");
  for (const [kind, run] of Object.entries(value.workflowRuns)) {
    exactKeys(run, ["id", "attempt", "event", "url"], `promotion admission ${kind} workflow run`);
    positiveInteger(run.id, `promotion admission ${kind} workflow run id`);
    positiveInteger(run.attempt, `promotion admission ${kind} workflow run attempt`);
    exact(run.url, `${WEB_ROOT}/actions/runs/${run.id}`, `promotion admission ${kind} workflow URL`);
  }
  return value;
}

export function confirmCurrentImage(admissionInput, currentIndexInput) {
  const admission = validateAdmission(admissionInput);
  const current = parseIndexSummary(currentIndexInput, {
    expectedDigest: admission.before.digest,
    expectedChildren: admission.before.children,
    label: "pre-promotion latest image index",
  });
  return current.digest;
}

export function createPromotionReceipt(admissionInput, afterIndexInput, context) {
  const admission = validateAdmission(admissionInput);
  const after = parseIndexSummary(afterIndexInput, {
    expectedDigest: admission.candidateDigest,
    expectedChildren: admission.candidateChildren,
    label: "post-promotion latest image index",
  });
  const performed = context?.promotionPerformed;
  if (typeof performed !== "boolean" || performed !== !admission.alreadyCurrent) {
    reject("promotion execution state does not match admission");
  }
  const workflowRunId = positiveInteger(context?.workflowRunId, "promotion workflow run id");
  const workflowRunAttempt = positiveInteger(context?.workflowRunAttempt, "promotion workflow run attempt");
  if (typeof context?.completedAt !== "string" || !Number.isFinite(Date.parse(context.completedAt))) {
    reject("promotion completion timestamp is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    mode: "server-latest-promotion",
    repository: admission.repository,
    image: admission.imageRepository,
    version: admission.version,
    releaseTag: admission.releaseTag,
    releaseId: admission.releaseId,
    sourceRevision: admission.sourceRevision,
    workflowRunId,
    workflowRunAttempt,
    completedAt: context.completedAt,
    promotionPerformed: performed,
    before: admission.before,
    after: {
      digest: after.digest,
      children: after.children,
      version: admission.version,
      sourceRevision: admission.sourceRevision,
    },
    candidateDigestUnchanged: after.digest === admission.candidateDigest,
    qualifiedAssets: admission.assets,
    qualifyingWorkflowRuns: admission.workflowRuns,
  });
}

async function readResponseBytes(response, maximum, label) {
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader != null && !/^(0|[1-9]\d*)$/.test(declaredHeader)) reject(`${label} content length is invalid`);
  const declared = declaredHeader == null ? null : Number(declaredHeader);
  if (declared != null && (!Number.isSafeInteger(declared) || declared > maximum)) reject(`${label} exceeded its size limit`);
  if (response.body == null) reject(`${label} response was empty`);
  const chunks = [];
  let total = 0;
  let complete = false;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) reject(`${label} exceeded its size limit`);
      chunks.push(Buffer.from(value));
    }
    complete = true;
  } finally {
    if (!complete) {
      try { await reader.cancel(); } catch {}
    }
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function cancelResponse(response) {
  try { await response.body?.cancel(); } catch {}
}

async function trustedFetch(url, {
  fetchImpl = fetch,
  token = "",
  maximum = MAX_JSON_BYTES,
  label = "GitHub response",
  accept = "application/vnd.github+json",
  allowNotFound = false,
} = {}) {
  let current = new URL(url);
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (current.protocol !== "https:" || !TRUSTED_HOSTS.has(current.hostname)) reject("GitHub request left trusted hosts");
    const headers = { accept, "user-agent": "YAWF-Server-Latest-Promoter" };
    if (current.hostname === "api.github.com" && token !== "") headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(current, { redirect: "manual", headers, signal });
    if (allowNotFound && response.status === 404) {
      await cancelResponse(response);
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await cancelResponse(response);
      if (location == null) reject("GitHub redirect is invalid");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      await cancelResponse(response);
      reject(`GitHub request failed (${response.status})`);
    }
    const bytes = await readResponseBytes(response, maximum, label);
    signal.throwIfAborted();
    return bytes;
  }
  reject("GitHub returned too many redirects");
}

async function apiJson(path, options = {}) {
  const bytes = await trustedFetch(`${API_ROOT}${path}`, options);
  return bytes == null ? null : parseJsonBytes(bytes, options.label ?? "GitHub API response", options.maximum);
}

function decodeGitHubContent(response, expectedRevision, label) {
  if (!isRecord(response) || response.type !== "file" || response.name !== "package.json" ||
      response.path !== "server/package.json" || response.encoding !== "base64" ||
      !Number.isSafeInteger(response.size) || response.size <= 0 || response.size > MAX_PACKAGE_BYTES) {
    reject(`${label} metadata is invalid`);
  }
  exact(response.url, `${API_ROOT}/contents/server/package.json?ref=${expectedRevision}`, `${label} API URL`);
  const compact = typeof response.content === "string" ? response.content.replace(/\s/g, "") : "";
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    reject(`${label} base64 is invalid`);
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.length !== response.size || bytes.toString("base64") !== compact) reject(`${label} bytes are invalid`);
  return bytes;
}

async function sourcePackageBytes(revision, { fetchImpl, token, label = "source package" }) {
  lowerRevision(revision, `${label} revision`);
  const response = await apiJson(`/contents/server/package.json?ref=${revision}`, {
    fetchImpl,
    token,
    maximum: MAX_JSON_BYTES,
    label: `${label} metadata`,
  });
  return decodeGitHubContent(response, revision, label);
}

async function resolveTagCommit(tag, { fetchImpl, token }) {
  let response = await apiJson(`/git/ref/tags/${tag}`, { fetchImpl, token, label: "release tag reference" });
  exact(response?.ref, `refs/tags/${tag}`, "release tag reference");
  let object = response?.object;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!isRecord(object)) reject("release tag object is invalid");
    const sha = lowerRevision(object.sha, "release tag object digest");
    if (object.type === "commit") {
      exact(object.url, `${API_ROOT}/git/commits/${sha}`, "release commit URL");
      return sha;
    }
    if (object.type !== "tag") reject("release tag does not resolve to a commit");
    exact(object.url, `${API_ROOT}/git/tags/${sha}`, "annotated tag URL");
    response = await apiJson(`/git/tags/${sha}`, { fetchImpl, token, label: "annotated release tag" });
    if (depth === 0) exact(response?.tag, tag, "annotated release tag name");
    object = response?.object;
  }
  reject("release tag indirection is too deep");
}

async function releaseForVersion(version, { fetchImpl, token }) {
  const direct = await apiJson(`/releases/tags/v${version}`, {
    fetchImpl,
    token,
    label: "server release",
    allowNotFound: true,
  });
  if (direct != null) return direct;
  const coordinated = await apiJson(`/releases/tags/v${version}-web`, {
    fetchImpl,
    token,
    label: "coordinated server release",
    allowNotFound: true,
  });
  if (coordinated == null) reject("public server release was not found");
  return coordinated;
}

export async function collectReleaseEvidence({
  requestedVersion,
  expectedSourceRevision = "",
  expectedImageDigest = "",
  fetchImpl = fetch,
  token = "",
}) {
  const version = releaseVersion(requestedVersion);
  validateOptionalGuard(expectedSourceRevision, lowerRevision, "expected source revision");
  validateOptionalGuard(expectedImageDigest, lowerDigest, "expected image digest");
  const release = await releaseForVersion(version, { fetchImpl, token });
  const releaseShape = validateRelease(release, version);
  const manifestAsset = exactAsset(release, releaseShape.tag, "server-update.json", MAX_MANIFEST_BYTES);
  const verificationAsset = exactAsset(release, releaseShape.tag, `Server_${version}_verification.json`, MAX_VERIFICATION_BYTES);
  const [manifestBytes, verificationBytes] = await Promise.all([
    trustedFetch(manifestAsset.browserDownloadUrl, {
      fetchImpl,
      token,
      maximum: MAX_MANIFEST_BYTES,
      label: "server-update.json",
      accept: "application/octet-stream",
    }),
    trustedFetch(verificationAsset.browserDownloadUrl, {
      fetchImpl,
      token,
      maximum: MAX_VERIFICATION_BYTES,
      label: "server verification",
      accept: "application/octet-stream",
    }),
  ]);
  const verification = parseJsonBytes(verificationBytes, "server verification", MAX_VERIFICATION_BYTES);
  const containerRunId = positiveInteger(verification?.workflowRuns?.container, "container workflow run");
  const debianRunId = positiveInteger(verification?.workflowRuns?.debian, "Debian workflow run");
  const resolvedTagCommit = await resolveTagCommit(releaseShape.tag, { fetchImpl, token });
  const [packageBytes, containerRun, debianRun] = await Promise.all([
    sourcePackageBytes(resolvedTagCommit, { fetchImpl, token }),
    apiJson(`/actions/runs/${containerRunId}`, { fetchImpl, token, label: "container workflow run" }),
    apiJson(`/actions/runs/${debianRunId}`, { fetchImpl, token, label: "Debian workflow run" }),
  ]);
  return qualifyReleaseEvidence({
    requestedVersion: version,
    expectedSourceRevision,
    expectedImageDigest,
    release,
    manifestBytes,
    verificationBytes,
    resolvedTagCommit,
    packageBytes,
    runs: { container: containerRun, debian: debianRun },
  });
}

function readBoundedFile(path, maximum, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    reject(`${label} could not be read`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximum) {
    reject(`${label} file is invalid`);
  }
  return readFileSync(path);
}

function readJsonFile(path, maximum, label) {
  return parseJsonBytes(readBoundedFile(path, maximum, label), label, maximum);
}

function writePrivateJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function writeOutputs(path, values) {
  if (path == null) return;
  for (const [key, value] of Object.entries(values)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key) || typeof value !== "string" || /[\r\n]/.test(value)) {
      reject("GitHub output is invalid");
    }
    appendFileSync(path, `${key}=${value}\n`, "utf8");
  }
}

function parseArguments(argv) {
  const mode = argv[0];
  if (!new Set(["prepare", "index-digest", "admit", "confirm-current", "finalize"]).has(mode)) {
    reject("promotion command is invalid");
  }
  const values = new Map();
  const rest = argv.slice(1);
  if (rest.length % 2 !== 0) reject("promotion arguments must be --name value pairs");
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key.startsWith("--") || values.has(key)) reject("promotion arguments are invalid or duplicated");
    values.set(key, value);
  }
  const specifications = {
    prepare: {
      allowed: ["--version", "--expected-source-revision", "--expected-image-digest", "--output", "--github-output"],
      required: ["--version", "--output", "--github-output"],
    },
    "index-digest": { allowed: ["--input", "--github-output"], required: ["--input", "--github-output"] },
    admit: {
      allowed: ["--evidence", "--candidate-index", "--candidate-amd64", "--candidate-arm64", "--current-index", "--current-amd64", "--current-arm64", "--output", "--github-output"],
      required: ["--evidence", "--candidate-index", "--candidate-amd64", "--candidate-arm64", "--current-index", "--current-amd64", "--current-arm64", "--output", "--github-output"],
    },
    "confirm-current": { allowed: ["--admission", "--current-index"], required: ["--admission", "--current-index"] },
    finalize: {
      allowed: ["--admission", "--after-index", "--promotion-performed", "--workflow-run-id", "--workflow-run-attempt", "--receipt"],
      required: ["--admission", "--after-index", "--promotion-performed", "--workflow-run-id", "--workflow-run-attempt", "--receipt"],
    },
  };
  const specification = specifications[mode];
  for (const key of values.keys()) if (!specification.allowed.includes(key)) reject(`unexpected argument ${key}`);
  for (const key of specification.required) if (!values.has(key)) reject(`missing argument ${key}`);
  return { mode, values };
}

async function main(argv) {
  const { mode, values } = parseArguments(argv);
  if (mode === "prepare") {
    const token = process.env.GITHUB_TOKEN;
    if (typeof token !== "string" || token.length === 0) reject("GITHUB_TOKEN is required at runtime");
    const evidence = await collectReleaseEvidence({
      requestedVersion: values.get("--version"),
      expectedSourceRevision: values.get("--expected-source-revision") ?? "",
      expectedImageDigest: values.get("--expected-image-digest") ?? "",
      token,
    });
    writePrivateJson(values.get("--output"), evidence);
    writeOutputs(values.get("--github-output"), {
      candidate_digest: evidence.imageDigest,
      candidate_reference: `${PUBLISHED_IMAGE}@${evidence.imageDigest}`,
      source_revision: evidence.sourceRevision,
      version: evidence.version,
    });
    process.stdout.write(`Qualified public server release ${evidence.version} at ${evidence.imageDigest}.\n`);
    return;
  }
  if (mode === "index-digest") {
    const index = parseIndexSummary(readBoundedFile(values.get("--input"), MAX_JSON_BYTES, "image index"));
    writeOutputs(values.get("--github-output"), { index_digest: index.digest });
    process.stdout.write(`${index.digest}\n`);
    return;
  }
  if (mode === "admit") {
    const evidence = readJsonFile(values.get("--evidence"), MAX_JSON_BYTES, "prepared release evidence");
    const candidateAmd64 = readBoundedFile(values.get("--candidate-amd64"), MAX_JSON_BYTES, "candidate amd64 configuration");
    const candidateArm64 = readBoundedFile(values.get("--candidate-arm64"), MAX_JSON_BYTES, "candidate arm64 configuration");
    const currentAmd64 = readBoundedFile(values.get("--current-amd64"), MAX_JSON_BYTES, "current amd64 configuration");
    const currentArm64 = readBoundedFile(values.get("--current-arm64"), MAX_JSON_BYTES, "current arm64 configuration");
    const currentRevision = currentImageSourceRevision(currentAmd64, currentArm64);
    const token = process.env.GITHUB_TOKEN;
    if (typeof token !== "string" || token.length === 0) reject("GITHUB_TOKEN is required at runtime");
    const currentPackageBytes = await sourcePackageBytes(currentRevision, { token, label: "current latest source package" });
    const currentPackage = parseJsonBytes(currentPackageBytes, "current latest source package", MAX_PACKAGE_BYTES);
    if (!isRecord(currentPackage)) reject("current latest source package is invalid");
    const currentPackageVersion = releaseVersion(currentPackage.version, "current latest source package version");
    const admission = admitPromotion({
      evidence,
      candidateIndex: readBoundedFile(values.get("--candidate-index"), MAX_JSON_BYTES, "candidate image index"),
      candidateAmd64,
      candidateArm64,
      currentIndex: readBoundedFile(values.get("--current-index"), MAX_JSON_BYTES, "current latest image index"),
      currentAmd64,
      currentArm64,
      currentPackageBytes,
      currentPackageVersion,
      currentPackageRevision: currentRevision,
    });
    writePrivateJson(values.get("--output"), admission);
    writeOutputs(values.get("--github-output"), {
      already_current: String(admission.alreadyCurrent),
      before_digest: admission.before.digest,
      candidate_digest: admission.candidateDigest,
    });
    process.stdout.write(`Admitted server ${admission.version} promotion over ${admission.before.version}.\n`);
    return;
  }
  if (mode === "confirm-current") {
    const admission = readJsonFile(values.get("--admission"), MAX_JSON_BYTES, "promotion admission");
    const digest = confirmCurrentImage(
      admission,
      readBoundedFile(values.get("--current-index"), MAX_JSON_BYTES, "pre-promotion latest image index"),
    );
    process.stdout.write(`Current latest remains ${digest}.\n`);
    return;
  }
  const admission = readJsonFile(values.get("--admission"), MAX_JSON_BYTES, "promotion admission");
  const performedValue = values.get("--promotion-performed");
  if (performedValue !== "true" && performedValue !== "false") reject("promotion performed flag is invalid");
  const receipt = createPromotionReceipt(
    admission,
    readBoundedFile(values.get("--after-index"), MAX_JSON_BYTES, "post-promotion latest image index"),
    {
      promotionPerformed: performedValue === "true",
      workflowRunId: Number(values.get("--workflow-run-id")),
      workflowRunAttempt: Number(values.get("--workflow-run-attempt")),
      completedAt: new Date().toISOString(),
    },
  );
  writePrivateJson(values.get("--receipt"), receipt);
  process.stdout.write(`Verified latest at unchanged index ${receipt.after.digest}.\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Server latest promotion failed."}\n`);
    process.exitCode = 1;
  });
}
