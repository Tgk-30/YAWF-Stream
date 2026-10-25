import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  CANONICAL_REPOSITORY,
  ServerLatestPromotionError,
  admitPromotion,
  collectReleaseEvidence,
  confirmCurrentImage,
  createPromotionReceipt,
  parseImageConfiguration,
  parseIndexSummary,
  qualifyReleaseEvidence,
} from "./promote_server_latest.mjs";

const VERSION = "2.3.36";
const TAG = `v${VERSION}`;
const SOURCE = "a".repeat(40);
const TAG_OBJECT = "b".repeat(40);
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const AMD64_DIGEST = `sha256:${"d".repeat(64)}`;
const ARM64_DIGEST = `sha256:${"e".repeat(64)}`;
const DEBIAN_SHA = "f".repeat(64);
const IMAGE = "ghcr.io/tgk-30/yawf-stream";
const API = "https://api.github.com/repos/Tgk-30/YAWF-Stream";
const WEB = "https://github.com/Tgk-30/YAWF-Stream";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function manifestValue() {
  return {
    schemaVersion: 1,
    version: VERSION,
    sourceRevision: SOURCE,
    image: { repository: IMAGE, digest: IMAGE_DIGEST },
    debian: {
      name: `debridstreamer-server_${VERSION}_all.deb`,
      sha256: DEBIAN_SHA,
      size: 4_184_610,
    },
  };
}

function verificationValue() {
  return {
    schemaVersion: 1,
    version: VERSION,
    sourceRevision: SOURCE,
    releaseTag: TAG,
    serverBundleSha256: "1".repeat(64),
    image: {
      repository: IMAGE,
      digest: IMAGE_DIGEST,
      amd64: `${IMAGE}@${AMD64_DIGEST}`,
      arm64: `${IMAGE}@${ARM64_DIGEST}`,
    },
    checks: {
      webTestsPassed: 4_311,
      serverTestsPassed: 326,
      webAndServerTypechecks: true,
      webAndServerProductionBuilds: true,
      webProductionAuditVulnerabilities: 0,
      serverProductionAuditVulnerabilities: 0,
      publishedAmd64AndArm64ImageSmokes: true,
      ubuntu22And24InstalledPackageChecks: true,
      controlledComposeUpdaterTransactions: true,
      signedInLiveServerGuide: true,
    },
    workflowRuns: { container: 39_905_428_747, debian: 39_905_421_068 },
    boundaries: {
      serverOnlyEmergencyRelease: true,
      fullPlatformQACompleted: false,
    },
    knownLimitations: ["Server-only release."],
  };
}

function runValue(kind, id) {
  const container = kind === "container";
  return {
    id,
    name: container ? "docker-image" : "deb-release",
    path: container ? ".github/workflows/docker-image.yml" : ".github/workflows/deb-release.yml",
    event: container ? "push" : "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    head_branch: container ? TAG : "codex/emergency-server-release",
    head_sha: SOURCE,
    run_attempt: 1,
    actor: { login: "Tgk-30" },
    repository: { full_name: CANONICAL_REPOSITORY, private: false },
    head_repository: { full_name: CANONICAL_REPOSITORY, private: false },
    html_url: `${WEB}/actions/runs/${id}`,
  };
}

function asset(id, tag, name, bytesOrMetadata, maximumDigest = null) {
  const bytes = Buffer.isBuffer(bytesOrMetadata) ? bytesOrMetadata : null;
  const size = bytes == null ? bytesOrMetadata.size : bytes.length;
  const sha = bytes == null ? bytesOrMetadata.sha256 : digest(bytes);
  return {
    id,
    name,
    state: "uploaded",
    size,
    digest: `sha256:${maximumDigest ?? sha}`,
    url: `${API}/releases/assets/${id}`,
    browser_download_url: `${WEB}/releases/download/${tag}/${name}`,
  };
}

function qualificationFixture() {
  const manifestBytes = jsonBytes(manifestValue());
  const verificationBytes = jsonBytes(verificationValue());
  const packageBytes = jsonBytes({ name: "debridstreamer-server", private: true, version: VERSION });
  const release = {
    id: 421_488_481,
    tag_name: TAG,
    draft: false,
    prerelease: false,
    published_at: "2026-10-23T05:41:59Z",
    author: { login: "Tgk-30" },
    url: `${API}/releases/421488481`,
    assets_url: `${API}/releases/421488481/assets`,
    html_url: `${WEB}/releases/tag/${TAG}`,
    assets: [
      asset(11, TAG, "server-update.json", manifestBytes),
      asset(12, TAG, `Server_${VERSION}_verification.json`, verificationBytes),
      asset(13, TAG, `debridstreamer-server_${VERSION}_all.deb`, {
        size: manifestValue().debian.size,
        sha256: DEBIAN_SHA,
      }),
    ],
  };
  return {
    requestedVersion: VERSION,
    expectedSourceRevision: SOURCE,
    expectedImageDigest: IMAGE_DIGEST,
    release,
    manifestBytes,
    verificationBytes,
    resolvedTagCommit: SOURCE,
    packageBytes,
    runs: {
      container: runValue("container", verificationValue().workflowRuns.container),
      debian: runValue("debian", verificationValue().workflowRuns.debian),
    },
  };
}

function replaceManifest(fixture, mutate) {
  const value = JSON.parse(fixture.manifestBytes);
  mutate(value);
  fixture.manifestBytes = jsonBytes(value);
  fixture.release.assets[0] = asset(11, fixture.release.tag_name, "server-update.json", fixture.manifestBytes);
}

function replaceVerification(fixture, mutate) {
  const value = JSON.parse(fixture.verificationBytes);
  mutate(value);
  fixture.verificationBytes = jsonBytes(value);
  fixture.release.assets[1] = asset(12, fixture.release.tag_name, `Server_${VERSION}_verification.json`, fixture.verificationBytes);
}

function indexSummary(digestValue, amd64 = AMD64_DIGEST, arm64 = ARM64_DIGEST, extras = []) {
  return {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    digest: digestValue,
    size: 1_024,
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: amd64,
        size: 512,
        platform: { os: "linux", architecture: "amd64" },
      },
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: arm64,
        size: 512,
        platform: { os: "linux", architecture: "arm64" },
      },
      ...extras,
    ],
  };
}

function imageConfiguration(architecture, revision, versionLabel, overrides = {}) {
  return {
    created: "2026-10-23T00:00:00Z",
    architecture,
    os: "linux",
    config: {
      User: "node",
      Labels: {
        "org.opencontainers.image.revision": revision,
        "org.opencontainers.image.version": versionLabel,
      },
    },
    ...overrides,
  };
}

function promotionFixture({ currentVersion = "2.3.35", currentDigest = `sha256:${"2".repeat(64)}` } = {}) {
  const evidence = qualifyReleaseEvidence(qualificationFixture());
  const currentRevision = "3".repeat(40);
  const currentAmd64Digest = `sha256:${"4".repeat(64)}`;
  const currentArm64Digest = `sha256:${"5".repeat(64)}`;
  return {
    evidence,
    candidateIndex: indexSummary(IMAGE_DIGEST),
    candidateAmd64: imageConfiguration("amd64", SOURCE, VERSION),
    candidateArm64: imageConfiguration("arm64", SOURCE, VERSION),
    currentIndex: indexSummary(currentDigest, currentAmd64Digest, currentArm64Digest),
    currentAmd64: imageConfiguration("amd64", currentRevision, "main"),
    currentArm64: imageConfiguration("arm64", currentRevision, "main"),
    currentPackageBytes: jsonBytes({ name: "debridstreamer-server", private: true, version: currentVersion }),
    currentPackageVersion: currentVersion,
    currentPackageRevision: currentRevision,
  };
}

test("release qualification binds stable public assets, tag, package, image, and both successful runs", () => {
  const result = qualifyReleaseEvidence(qualificationFixture());
  assert.equal(result.version, VERSION);
  assert.equal(result.releaseTag, TAG);
  assert.equal(result.sourceRevision, SOURCE);
  assert.equal(result.imageDigest, IMAGE_DIGEST);
  assert.equal(result.children.amd64, `${IMAGE}@${AMD64_DIGEST}`);
  assert.equal(result.assets.manifest.sha256, digest(qualificationFixture().manifestBytes));
  assert.equal(result.workflowRuns.container.id, verificationValue().workflowRuns.container);
  assert.equal(result.workflowRuns.debian.id, verificationValue().workflowRuns.debian);
});

test("release qualification rejects each public-release and asset trust mutant", () => {
  const mutations = [
    ["draft", (v) => { v.release.draft = true; }],
    ["prerelease", (v) => { v.release.prerelease = true; }],
    ["wrong host", (v) => { v.release.assets[0].browser_download_url = "https://example.com/server-update.json"; }],
    ["missing manifest", (v) => { v.release.assets = v.release.assets.filter((item) => item.name !== "server-update.json"); }],
    ["duplicate manifest", (v) => { v.release.assets.push({ ...v.release.assets[0], id: 99, url: `${API}/releases/assets/99` }); }],
    ["manifest digest", (v) => { v.release.assets[0].digest = `sha256:${"0".repeat(64)}`; }],
    ["manifest size", (v) => { v.release.assets[0].size += 1; }],
    ["verification digest", (v) => { v.release.assets[1].digest = `sha256:${"0".repeat(64)}`; }],
    ["Debian digest", (v) => { v.release.assets[2].digest = `sha256:${"0".repeat(64)}`; }],
    ["author", (v) => { v.release.author.login = "fork-owner"; }],
  ];
  for (const [label, mutate] of mutations) {
    const fixture = qualificationFixture();
    mutate(fixture);
    assert.throws(() => qualifyReleaseEvidence(fixture), ServerLatestPromotionError, label);
  }
});

test("release qualification rejects each source, manifest, verification, and operator-guard mutant", () => {
  const mutations = [
    ["tag source", (v) => { v.resolvedTagCommit = "0".repeat(40); }],
    ["source package version", (v) => { v.packageBytes = jsonBytes({ name: "debridstreamer-server", private: true, version: "2.3.35" }); }],
    ["source guard", (v) => { v.expectedSourceRevision = "0".repeat(40); }],
    ["digest guard", (v) => { v.expectedImageDigest = `sha256:${"0".repeat(64)}`; }],
    ["manifest image host", (v) => replaceManifest(v, (m) => { m.image.repository = "ghcr.io/fork/yawf-stream"; })],
    ["verification source", (v) => replaceVerification(v, (r) => { r.sourceRevision = "0".repeat(40); })],
    ["verification image", (v) => replaceVerification(v, (r) => { r.image.digest = `sha256:${"0".repeat(64)}`; })],
    ["image smoke", (v) => replaceVerification(v, (r) => { r.checks.publishedAmd64AndArm64ImageSmokes = false; })],
    ["installed Debian checks", (v) => replaceVerification(v, (r) => { r.checks.ubuntu22And24InstalledPackageChecks = false; })],
    ["updater transaction", (v) => replaceVerification(v, (r) => { r.checks.controlledComposeUpdaterTransactions = false; })],
  ];
  for (const [label, mutate] of mutations) {
    const fixture = qualificationFixture();
    mutate(fixture);
    assert.throws(() => qualifyReleaseEvidence(fixture), ServerLatestPromotionError, label);
  }
});

test("release qualification rejects untrusted, failed, mismatched, or non-publishing workflow runs", () => {
  const mutations = [
    ["container repository", (v) => { v.runs.container.repository.full_name = "fork/repo"; }],
    ["container source", (v) => { v.runs.container.head_sha = "0".repeat(40); }],
    ["container path", (v) => { v.runs.container.path = ".github/workflows/other.yml"; }],
    ["container event", (v) => { v.runs.container.event = "workflow_dispatch"; }],
    ["container tag", (v) => { v.runs.container.head_branch = "main"; }],
    ["container failed", (v) => { v.runs.container.conclusion = "failure"; }],
    ["Debian repository", (v) => { v.runs.debian.head_repository.full_name = "fork/repo"; }],
    ["Debian source", (v) => { v.runs.debian.head_sha = "0".repeat(40); }],
    ["Debian path", (v) => { v.runs.debian.path = ".github/workflows/other.yml"; }],
    ["Debian event", (v) => { v.runs.debian.event = "pull_request"; }],
    ["Debian failed", (v) => { v.runs.debian.status = "in_progress"; }],
  ];
  for (const [label, mutate] of mutations) {
    const fixture = qualificationFixture();
    mutate(fixture);
    assert.throws(() => qualifyReleaseEvidence(fixture), ServerLatestPromotionError, label);
  }
});

function responseJson(value, status = 200, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  return new Response(body, {
    status,
    headers: { "content-length": String(body.length), "content-type": "application/json", ...headers },
  });
}

function responseBytes(bytes, status = 200, headers = {}) {
  return new Response(bytes, {
    status,
    headers: { "content-length": String(bytes.length), ...headers },
  });
}

function collectionMock({ redirectManifestTo = null } = {}) {
  const fixture = qualificationFixture();
  const calls = [];
  const packageMetadata = {
    type: "file",
    name: "package.json",
    path: "server/package.json",
    encoding: "base64",
    size: fixture.packageBytes.length,
    content: fixture.packageBytes.toString("base64"),
    url: `${API}/contents/server/package.json?ref=${SOURCE}`,
  };
  const routes = new Map([
    [`${API}/releases/tags/${TAG}`, () => responseJson(fixture.release)],
    [`${WEB}/releases/download/${TAG}/server-update.json`, () => redirectManifestTo == null
      ? responseBytes(fixture.manifestBytes)
      : new Response(null, { status: 302, headers: { location: redirectManifestTo } })],
    [`${WEB}/releases/download/${TAG}/Server_${VERSION}_verification.json`, () => responseBytes(fixture.verificationBytes)],
    [`${API}/git/ref/tags/${TAG}`, () => responseJson({
      ref: `refs/tags/${TAG}`,
      object: { type: "tag", sha: TAG_OBJECT, url: `${API}/git/tags/${TAG_OBJECT}` },
    })],
    [`${API}/git/tags/${TAG_OBJECT}`, () => responseJson({
      tag: TAG,
      object: { type: "commit", sha: SOURCE, url: `${API}/git/commits/${SOURCE}` },
    })],
    [`${API}/contents/server/package.json?ref=${SOURCE}`, () => responseJson(packageMetadata)],
    [`${API}/actions/runs/${verificationValue().workflowRuns.container}`, () => responseJson(fixture.runs.container)],
    [`${API}/actions/runs/${verificationValue().workflowRuns.debian}`, () => responseJson(fixture.runs.debian)],
  ]);
  if (redirectManifestTo != null) routes.set(redirectManifestTo, () => responseBytes(fixture.manifestBytes));
  return {
    calls,
    fetchImpl: async (url, options) => {
      const href = String(url);
      calls.push({ href, authorization: options.headers.authorization ?? null });
      const route = routes.get(href);
      return route == null ? responseJson({ message: "not found" }, 404) : route();
    },
  };
}

test("collector executes actual annotated-tag and public-byte path without forwarding the API token", async () => {
  const mock = collectionMock();
  const result = await collectReleaseEvidence({
    requestedVersion: VERSION,
    expectedSourceRevision: SOURCE,
    expectedImageDigest: IMAGE_DIGEST,
    fetchImpl: mock.fetchImpl,
    token: "test-token-never-returned",
  });
  assert.equal(result.sourceRevision, SOURCE);
  assert.ok(mock.calls.some((call) => call.href === `${API}/git/tags/${TAG_OBJECT}`));
  assert.ok(mock.calls.filter((call) => call.href.startsWith(API)).every((call) => call.authorization === "Bearer test-token-never-returned"));
  assert.ok(mock.calls.filter((call) => call.href.startsWith(WEB)).every((call) => call.authorization == null));
  assert.doesNotMatch(JSON.stringify(result), /test-token/);
});

test("collector rejects an asset redirect that leaves the trusted GitHub hosts", async () => {
  const mock = collectionMock({ redirectManifestTo: "https://example.com/server-update.json" });
  await assert.rejects(
    collectReleaseEvidence({ requestedVersion: VERSION, fetchImpl: mock.fetchImpl, token: "token" }),
    ServerLatestPromotionError,
  );
  assert.ok(!mock.calls.some((call) => call.href.startsWith("https://example.com/")));
});

test("index and configuration adapters admit only the qualified two-platform image", () => {
  const attestation = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: `sha256:${"6".repeat(64)}`,
    size: 256,
    platform: { os: "unknown", architecture: "unknown" },
    annotations: { "vnd.docker.reference.type": "attestation-manifest" },
  };
  const parsed = parseIndexSummary(indexSummary(IMAGE_DIGEST, AMD64_DIGEST, ARM64_DIGEST, [attestation]), {
    expectedDigest: IMAGE_DIGEST,
    expectedChildren: { amd64: `${IMAGE}@${AMD64_DIGEST}`, arm64: `${IMAGE}@${ARM64_DIGEST}` },
  });
  assert.equal(parsed.digest, IMAGE_DIGEST);
  assert.deepEqual(parseImageConfiguration(imageConfiguration("amd64", SOURCE, VERSION), "amd64"), {
    revision: SOURCE,
    versionLabel: VERSION,
  });
});

test("index and configuration adapters reject scope, child, platform, user, and label mutants", () => {
  const extraPlatform = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: `sha256:${"6".repeat(64)}`,
    size: 256,
    platform: { os: "linux", architecture: "s390x" },
  };
  assert.throws(() => parseIndexSummary(indexSummary(IMAGE_DIGEST, AMD64_DIGEST, ARM64_DIGEST, [extraPlatform])), ServerLatestPromotionError);
  assert.throws(() => parseIndexSummary(indexSummary(IMAGE_DIGEST), { expectedDigest: `sha256:${"0".repeat(64)}` }), ServerLatestPromotionError);
  assert.throws(() => parseIndexSummary(indexSummary(IMAGE_DIGEST), {
    expectedChildren: { amd64: `${IMAGE}@sha256:${"0".repeat(64)}`, arm64: `${IMAGE}@${ARM64_DIGEST}` },
  }), ServerLatestPromotionError);
  const rootConfig = imageConfiguration("amd64", SOURCE, VERSION);
  rootConfig.config.User = "root";
  assert.throws(() => parseImageConfiguration(rootConfig, "amd64"), ServerLatestPromotionError);
  const ambiguous = imageConfiguration("amd64", SOURCE, VERSION);
  ambiguous.config.labels = ambiguous.config.Labels;
  assert.throws(() => parseImageConfiguration(ambiguous, "amd64"), ServerLatestPromotionError);
});

test("promotion admission accepts a newer exact candidate and retains immutable before state", () => {
  const admitted = admitPromotion(promotionFixture());
  assert.equal(admitted.version, VERSION);
  assert.equal(admitted.candidateDigest, IMAGE_DIGEST);
  assert.equal(admitted.before.version, "2.3.35");
  assert.equal(admitted.before.digest, `sha256:${"2".repeat(64)}`);
  assert.equal(admitted.alreadyCurrent, false);
});

test("promotion admission rejects downgrade, same-version conflict, source, label, and child mismatches", () => {
  assert.throws(() => admitPromotion(promotionFixture({ currentVersion: "2.3.37" })), ServerLatestPromotionError);
  assert.throws(() => admitPromotion(promotionFixture({ currentVersion: VERSION })), ServerLatestPromotionError);

  const mutations = [
    ["candidate source", (v) => { v.candidateAmd64.config.Labels["org.opencontainers.image.revision"] = "0".repeat(40); }],
    ["candidate label", (v) => { v.candidateArm64.config.Labels["org.opencontainers.image.version"] = "main"; }],
    ["current source", (v) => { v.currentArm64.config.Labels["org.opencontainers.image.revision"] = "0".repeat(40); }],
    ["current label", (v) => {
      v.currentAmd64.config.Labels["org.opencontainers.image.version"] = "branch";
      v.currentArm64.config.Labels["org.opencontainers.image.version"] = "branch";
    }],
    ["candidate child", (v) => { v.candidateIndex.manifests[0].digest = `sha256:${"0".repeat(64)}`; }],
  ];
  for (const [label, mutate] of mutations) {
    const fixture = promotionFixture();
    mutate(fixture);
    assert.throws(() => admitPromotion(fixture), ServerLatestPromotionError, label);
  }
});

test("idempotent exact candidate is admitted without a write", () => {
  const fixture = promotionFixture({ currentVersion: VERSION, currentDigest: IMAGE_DIGEST });
  fixture.currentIndex = indexSummary(IMAGE_DIGEST);
  fixture.currentAmd64 = imageConfiguration("amd64", SOURCE, VERSION);
  fixture.currentArm64 = imageConfiguration("arm64", SOURCE, VERSION);
  fixture.currentPackageBytes = jsonBytes({ name: "debridstreamer-server", private: true, version: VERSION });
  fixture.currentPackageVersion = VERSION;
  fixture.currentPackageRevision = SOURCE;
  const admitted = admitPromotion(fixture);
  assert.equal(admitted.alreadyCurrent, true);
  const receipt = createPromotionReceipt(admitted, indexSummary(IMAGE_DIGEST), {
    promotionPerformed: false,
    workflowRunId: 42,
    workflowRunAttempt: 1,
    completedAt: "2026-10-23T12:00:00.000Z",
  });
  assert.equal(receipt.promotionPerformed, false);
  assert.equal(receipt.candidateDigestUnchanged, true);
});

test("prewrite confirmation and postwrite receipt fail closed on every digest or execution drift", () => {
  const admitted = admitPromotion(promotionFixture());
  assert.equal(confirmCurrentImage(admitted, promotionFixture().currentIndex), admitted.before.digest);
  assert.throws(
    () => confirmCurrentImage(admitted, indexSummary(`sha256:${"7".repeat(64)}`, `sha256:${"4".repeat(64)}`, `sha256:${"5".repeat(64)}`)),
    ServerLatestPromotionError,
  );
  const receipt = createPromotionReceipt(admitted, indexSummary(IMAGE_DIGEST), {
    promotionPerformed: true,
    workflowRunId: 42,
    workflowRunAttempt: 1,
    completedAt: "2026-10-23T12:00:00.000Z",
  });
  assert.equal(receipt.before.digest, admitted.before.digest);
  assert.equal(receipt.after.digest, IMAGE_DIGEST);
  assert.equal(receipt.candidateDigestUnchanged, true);
  assert.ok(!JSON.stringify(receipt).includes("token"));
  assert.throws(() => createPromotionReceipt(admitted, indexSummary(`sha256:${"7".repeat(64)}`), {
    promotionPerformed: true,
    workflowRunId: 42,
    workflowRunAttempt: 1,
    completedAt: "2026-10-23T12:00:00.000Z",
  }), ServerLatestPromotionError);
  assert.throws(() => createPromotionReceipt(admitted, indexSummary(IMAGE_DIGEST), {
    promotionPerformed: false,
    workflowRunId: 42,
    workflowRunAttempt: 1,
    completedAt: "2026-10-23T12:00:00.000Z",
  }), ServerLatestPromotionError);
});

test("CLI rejects duplicate and unexpected arguments before any network or registry action", () => {
  const script = new URL("./promote_server_latest.mjs", import.meta.url);
  for (const args of [
    ["prepare", "--version", VERSION, "--version", VERSION],
    ["prepare", "--version", VERSION, "--unexpected", "value"],
    ["unknown"],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: {} });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  }
});

test("workflow registers through validation-only pushes and grants package write only to owner dispatch", () => {
  const workflow = readFileSync(new URL("../.github/workflows/promote-server-latest.yml", import.meta.url), "utf8");
  assert.match(workflow, /\n  push:\n    paths:\n(?:      - .+\n){3}  workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:|schedule:/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /promote:\n[\s\S]*if: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.repository == 'Tgk-30\/YAWF-Stream' && github\.actor == github\.repository_owner \}\}/);
  const validateBlock = workflow.slice(workflow.indexOf("  validate:"), workflow.indexOf("  promote:"));
  assert.doesNotMatch(validateBlock, /packages: write|docker login|imagetools create/);
  const promoteBlock = workflow.slice(workflow.indexOf("  promote:"));
  assert.match(promoteBlock, /packages: write/);
  assert.match(promoteBlock, /uses: docker\/setup-buildx-action@v3/);
  assert.match(promoteBlock, /uses: docker\/login-action@v3/);
  assert.equal((workflow.match(/docker buildx imagetools create/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /docker build(?:\s|\\)|docker\/build-push-action/);
});

test("workflow qualifies, rechecks, copies by digest, and verifies the unchanged post-promotion index", () => {
  const workflow = readFileSync(new URL("../.github/workflows/promote-server-latest.yml", import.meta.url), "utf8");
  const prepare = workflow.indexOf("promote_server_latest.mjs prepare");
  const admit = workflow.indexOf("promote_server_latest.mjs admit");
  const confirm = workflow.indexOf("promote_server_latest.mjs confirm-current");
  const create = workflow.indexOf("docker buildx imagetools create");
  const finalize = workflow.indexOf("promote_server_latest.mjs finalize");
  const retain = workflow.indexOf("Retain secret-free promotion receipt");
  assert.ok(prepare >= 0 && admit > prepare && confirm > admit && create > confirm && finalize > create && retain > finalize);
  assert.match(workflow, /--tag "\$IMAGE:latest"[\s\\\n]+"\$IMAGE@\$CANDIDATE_DIGEST"/);
  assert.match(workflow, /--after-index "\$RUNNER_TEMP\/post-promotion-index\.json"/);
  assert.match(workflow, /--promotion-performed "\$PROMOTION_PERFORMED"/);
  const secretReferences = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);
  assert.deepEqual(secretReferences, ["GITHUB_TOKEN"]);
  assert.doesNotMatch(workflow, /echo[^\n]*(?:GITHUB_TOKEN|github\.token|secrets\.)/);
});
