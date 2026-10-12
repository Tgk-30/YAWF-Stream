import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PUBLISHED_IMAGE,
  githubOutputs,
  resolvePublishedImageManifests,
} from "./resolve_published_image_manifests.mjs";

const workflow = readFileSync(new URL("../.github/workflows/docker-image.yml", import.meta.url), "utf8");
const INDEX_DIGEST = `sha256:${"1".repeat(64)}`;
const AMD64_DIGEST = `sha256:${"a".repeat(64)}`;
const ARM64_DIGEST = `sha256:${"b".repeat(64)}`;
const ATTESTATION_DIGEST = `sha256:${"c".repeat(64)}`;
const PUBLISHED_238_INDEX_DIGEST = "sha256:53db8ee061db988ff7aa8cdf69a71da92ee74b908aed2bcb367d78818218ba21";
const PUBLISHED_238_AMD64_DIGEST = "sha256:9dc7374c72937f10498ccb2ae72b34a7a89f6ff40943c37301a99dcdbc9daaf8";
const PUBLISHED_238_ARM64_DIGEST = "sha256:876ccb1c9e78c0a6659e370d0908abcaa92b5787479be4dca88eb8e691c55f2d";

function child(os, architecture, digest, extra = {}) {
  return {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest,
    size: 1234,
    platform: { os, architecture },
    ...extra,
  };
}

function index(manifests = [
  child("linux", "amd64", AMD64_DIGEST),
  child("unknown", "unknown", ATTESTATION_DIGEST, {
    annotations: { "vnd.docker.reference.type": "attestation-manifest" },
  }),
  child("linux", "arm64", ARM64_DIGEST),
]) {
  return JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests,
  });
}

function resolve(raw = index(), options = {}) {
  return resolvePublishedImageManifests(raw, {
    image: PUBLISHED_IMAGE,
    indexDigest: INDEX_DIGEST,
    ...options,
  });
}

function workflowJob(name) {
  const jobs = [...workflow.matchAll(/^  ([A-Za-z0-9_-]+):\n/gm)];
  const position = jobs.findIndex((match) => match[1] === name);
  assert.notEqual(position, -1, `missing workflow job ${name}`);
  const start = jobs[position].index;
  const end = jobs[position + 1]?.index ?? workflow.length;
  return workflow.slice(start, end);
}

test("selects one immutable amd64 and arm64 child while ignoring attestation manifests", () => {
  const result = resolve();
  assert.deepEqual(result, {
    image: PUBLISHED_IMAGE,
    indexDigest: INDEX_DIGEST,
    indexReference: `${PUBLISHED_IMAGE}@${INDEX_DIGEST}`,
    platforms: [
      {
        platform: "linux/amd64",
        digest: AMD64_DIGEST,
        reference: `${PUBLISHED_IMAGE}@${AMD64_DIGEST}`,
      },
      {
        platform: "linux/arm64",
        digest: ARM64_DIGEST,
        reference: `${PUBLISHED_IMAGE}@${ARM64_DIGEST}`,
      },
    ],
  });
  assert.equal(
    githubOutputs(result),
    `index_reference=${PUBLISHED_IMAGE}@${INDEX_DIGEST}\n`
      + `amd64_reference=${PUBLISHED_IMAGE}@${AMD64_DIGEST}\n`
      + `arm64_reference=${PUBLISHED_IMAGE}@${ARM64_DIGEST}\n`,
  );
});

test("resolves the published 2.3.8 index to its observed immutable children", () => {
  assert.equal(PUBLISHED_IMAGE, "ghcr.io/tgk-30/yawf-stream");
  const raw = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      child("linux", "amd64", PUBLISHED_238_AMD64_DIGEST),
      child("linux", "arm64", PUBLISHED_238_ARM64_DIGEST),
      child("unknown", "unknown", "sha256:d67d701ab66c7d67107fd65a3c9804a6f29739e185dd3609558da1500d4fb4fa", {
        annotations: {
          "vnd.docker.reference.digest": PUBLISHED_238_AMD64_DIGEST,
          "vnd.docker.reference.type": "attestation-manifest",
        },
      }),
      child("unknown", "unknown", "sha256:1af869b6f32d4d5d4bc6dd330f612b9bfcb10eba615fda713110e5f01d978888", {
        annotations: {
          "vnd.docker.reference.digest": PUBLISHED_238_ARM64_DIGEST,
          "vnd.docker.reference.type": "attestation-manifest",
        },
      }),
    ],
  });
  const result = resolve(raw, { indexDigest: PUBLISHED_238_INDEX_DIGEST });
  assert.deepEqual(result.platforms, [
    {
      platform: "linux/amd64",
      digest: PUBLISHED_238_AMD64_DIGEST,
      reference: `${PUBLISHED_IMAGE}@${PUBLISHED_238_AMD64_DIGEST}`,
    },
    {
      platform: "linux/arm64",
      digest: PUBLISHED_238_ARM64_DIGEST,
      reference: `${PUBLISHED_IMAGE}@${PUBLISHED_238_ARM64_DIGEST}`,
    },
  ]);
  assert.equal(result.indexReference, `${PUBLISHED_IMAGE}@${PUBLISHED_238_INDEX_DIGEST}`);
});

test("accepts a Docker manifest list with Docker image children", () => {
  const raw = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.docker.distribution.manifest.list.v2+json",
    manifests: [
      child("linux", "amd64", AMD64_DIGEST, {
        mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      }),
      child("linux", "arm64", ARM64_DIGEST, {
        mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      }),
    ],
  });
  let result;
  assert.doesNotThrow(() => {
    result = resolve(raw);
  });
  assert.equal(result.platforms.length, 2);
});

test("rejects missing and duplicate target children", () => {
  assert.throws(
    () => resolve(index([child("linux", "amd64", AMD64_DIGEST)])),
    /missing linux\/arm64/,
  );
  assert.throws(
    () => resolve(index([
      child("linux", "amd64", AMD64_DIGEST),
      child("linux", "amd64", `sha256:${"d".repeat(64)}`),
      child("linux", "arm64", ARM64_DIGEST),
    ])),
    /duplicate linux\/amd64/,
  );
});

test("rejects malformed digests, platforms, and unknown non-attestation entries", () => {
  assert.throws(
    () => resolve(index([
      child("linux", "amd64", "sha256:BAD"),
      child("linux", "arm64", ARM64_DIGEST),
    ])),
    /lowercase sha256 digest/,
  );
  assert.throws(
    () => resolve(index([
      child("linux", "AMD64", AMD64_DIGEST),
      child("linux", "arm64", ARM64_DIGEST),
    ])),
    /architecture is malformed/,
  );
  assert.throws(
    () => resolve(index([
      child("unknown", "unknown", ATTESTATION_DIGEST),
      child("linux", "amd64", AMD64_DIGEST),
      child("linux", "arm64", ARM64_DIGEST),
    ])),
    /unsupported unknown platform/,
  );
});

test("rejects malformed indexes, mutable image names, and shared child digests", () => {
  assert.throws(() => resolve("not-json"), /index JSON is malformed/);
  assert.throws(
    () => resolve(index(), { image: `${PUBLISHED_IMAGE}:latest` }),
    /image must be exactly/,
  );
  assert.throws(
    () => resolve(index([
      child("linux", "amd64", AMD64_DIGEST),
      child("linux", "arm64", AMD64_DIGEST),
    ])),
    /must have distinct digests/,
  );
});

test("regular publication resolves and smokes each immutable child reference", () => {
  const regular = workflowJob("docker");
  assert.match(regular, /id: published-children/);
  assert.match(regular, /docker buildx imagetools inspect --raw "\$index_reference"/);
  assert.match(regular, /--index-digest "\$IMAGE_DIGEST"/);
  assert.match(regular, /AMD64_REFERENCE: \$\{\{ steps\.published-children\.outputs\.amd64_reference \}\}/);
  assert.match(regular, /ARM64_REFERENCE: \$\{\{ steps\.published-children\.outputs\.arm64_reference \}\}/);
  assert.match(regular, /amd64\) child_reference="\$AMD64_REFERENCE"/);
  assert.match(regular, /arm64\) child_reference="\$ARM64_REFERENCE"/);
  assert.match(regular, /image="\$child_reference"/);
  assert.match(regular, /docker pull --platform "linux\/\$architecture" "\$image"/);
});

test("manual published verification is read-only and runs both pinned children hardened", () => {
  const manual = workflowJob("verify-published");
  assert.match(manual, /^    permissions:\n      contents: read\n      packages: read$/m);
  assert.match(manual, /github\.event_name == 'workflow_dispatch'/);
  assert.match(manual, /inputs\.published_image_digest != ''/);
  assert.match(manual, /IMAGE_NAME: ghcr\.io\/tgk-30\/yawf-stream/);
  assert.match(manual, /SOURCE_PACKAGE_VERSION: \$\{\{ inputs\.source_package_version \}\}/);
  assert.match(manual, /EXPECTED_SOURCE_REVISION: \$\{\{ inputs\.expected_source_revision \}\}/);
  assert.match(manual, /test "\$SOURCE_PACKAGE_VERSION" = "2\.3\.8"/);
  assert.match(manual, /test "\$EXPECTED_SOURCE_REVISION" = "4387873fd7df8ef894c7424a30abb31f8ec06526"/);
  assert.match(manual, /id: manual-children/);
  assert.match(manual, /for architecture in amd64 arm64; do/);
  assert.match(manual, /amd64\) child_reference="\$AMD64_REFERENCE"/);
  assert.match(manual, /arm64\) child_reference="\$ARM64_REFERENCE"/);
  assert.equal((manual.match(/--network none/g) ?? []).length, 1);
  assert.equal((manual.match(/--read-only/g) ?? []).length, 1);
  assert.equal((manual.match(/--cap-drop ALL/g) ?? []).length, 1);
  assert.equal((manual.match(/--security-opt no-new-privileges/g) ?? []).length, 1);
  assert.match(manual, /yawf-published-smoke-linux-\$architecture\.jsonl/);
  assert.match(manual, /actions\/upload-artifact@v4/);
});

test("manual verification checks image identity without build or publication paths", () => {
  const manual = workflowJob("verify-published");
  assert.doesNotMatch(
    manual,
    /packages: write|docker\/login-action|docker\/build-push-action|docker buildx build|\bpush:|secrets\./,
  );
  assert.match(manual, /docker image inspect --format '\{\{\.Config\.User\}\}' "\$child_reference"/);
  assert.match(manual, /org\.opencontainers\.image\.version/);
  assert.match(manual, /org\.opencontainers\.image\.revision/);
});

test("manual digest mode alone skips the regular build and publish job", () => {
  const regular = workflowJob("docker");
  assert.match(
    regular,
    /^    if: github\.event_name != 'workflow_dispatch' \|\| inputs\.published_image_digest == ''$/m,
  );
  assert.match(workflow, /published_image_digest:\n\s+description:/);
  assert.match(workflow, /expected_source_revision:\n\s+description:/);
  assert.match(workflow, /source_package_version:\n\s+description:/);
});

test("resolver changes trigger Docker pull request and push verification", () => {
  const resolverPath = '      - "scripts/resolve_published_image_manifests.mjs"';
  const resolverTestPath = '      - "scripts/resolve_published_image_manifests.test.mjs"';
  assert.equal(workflow.split(resolverPath).length - 1, 2);
  assert.equal(workflow.split(resolverTestPath).length - 1, 2);
});
