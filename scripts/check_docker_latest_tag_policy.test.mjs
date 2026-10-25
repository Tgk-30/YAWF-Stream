import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { validateDockerLatestTagPolicy } from "./check_docker_latest_tag_policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = join(root, ".github/workflows/docker-image.yml");
const checkerPath = join(root, "scripts/check_docker_latest_tag_policy.mjs");
const workflow = readFileSync(workflowPath, "utf8");

function replaceOnce(source, needle, replacement) {
  assert.ok(source.includes(needle), `fixture must contain ${JSON.stringify(needle)}`);
  const mutated = source.replace(needle, replacement);
  assert.notEqual(mutated, source, "fixture mutation must change the source");
  return mutated;
}

function expectPolicyFailure(mutated) {
  assert.notEqual(mutated, workflow, "fixture mutation must change the source");
  assert.notDeepEqual(validateDockerLatestTagPolicy(mutated), []);
}

test("real workflow satisfies policy", () => {
  assert.deepEqual(validateDockerLatestTagPolicy(workflow), []);
});

test("rejects missing, conflicting, repeated, and duplicate flavor policy", () => {
  const flavorBlock = "          flavor: |\n            latest=false\n";
  for (const mutated of [
    replaceOnce(workflow, flavorBlock, ""),
    replaceOnce(workflow, "latest=false", "latest=true"),
    replaceOnce(workflow, "latest=false", "latest=auto"),
    replaceOnce(workflow, "latest=false", "latest=false\n            latest=true"),
    replaceOnce(workflow, "latest=false", "latest=false\n            latest=false"),
  ]) {
    expectPolicyFailure(mutated);
  }
});

test("rejects a second flavor key after the valid literal flavor block", () => {
  const flavorBlock = "          flavor: |\n            latest=false\n";
  for (const duplicate of [
    "          flavor: latest=true\n",
    "          flavor: |\n            latest=true\n",
  ]) {
    expectPolicyFailure(
      replaceOnce(workflow, flavorBlock, `${flavorBlock}${duplicate}`),
    );
  }
});

test("binds the named metadata step to metadata-action and id meta", () => {
  expectPolicyFailure(replaceOnce(workflow, "id: meta", "id: other"));
  expectPolicyFailure(
    replaceOnce(
      workflow,
      "uses: docker/metadata-action@v5",
      "uses: actions/checkout@v4",
    ),
  );
  const movedAction = replaceOnce(
    replaceOnce(
      workflow,
      "uses: actions/checkout@v4",
      "uses: docker/metadata-action@v5",
    ),
    "uses: docker/metadata-action@v5\n        with:\n          images:",
    "uses: actions/checkout@v4\n        with:\n          images:",
  );
  expectPolicyFailure(movedAction);
  expectPolicyFailure(
    replaceOnce(workflow, "- name: Docker metadata", "- name: Other step"),
  );
  const duplicate = `${workflow}\n      - name: Docker metadata\n        id: meta\n        uses: docker/metadata-action@v5\n`;
  expectPolicyFailure(duplicate);
});

test("rejects a raw latest rule and every removed required version or ref rule", () => {
  const firstRule = "            type=ref,event=branch\n";
  expectPolicyFailure(
    replaceOnce(
      workflow,
      firstRule,
      "            type=raw,value=latest,enable={{is_default_branch}}\n" +
        firstRule,
    ),
  );

  const requiredRules = [
    "type=ref,event=branch",
    "type=ref,event=tag",
    "type=semver,pattern={{version}}",
    "type=semver,pattern={{major}}.{{minor}}",
    "type=raw,value=${{ steps.release-version.outputs.version }},enable=${{ steps.release-version.outputs.enabled }}",
    "type=raw,value=${{ steps.release-version.outputs.major_minor }},enable=${{ steps.release-version.outputs.enabled }}",
  ];
  for (const rule of requiredRules) {
    expectPolicyFailure(replaceOnce(workflow, `            ${rule}\n`, ""));
  }
});

test("binds the named publish step to build-push-action and metadata tags only", () => {
  expectPolicyFailure(
    replaceOnce(
      workflow,
      "uses: docker/build-push-action@v6",
      "uses: docker/build-push-action@v5",
    ),
  );
  expectPolicyFailure(
    replaceOnce(
      workflow,
      "tags: ${{ steps.meta.outputs.tags }}",
      "tags: ghcr.io/example:latest",
    ),
  );
  expectPolicyFailure(
    replaceOnce(
      workflow,
      "tags: ${{ steps.meta.outputs.tags }}",
      "tags: ${{ steps.meta.outputs.tags }}\n          tags: ghcr.io/example:fixed",
    ),
  );
  expectPolicyFailure(
    replaceOnce(
      workflow,
      "- name: Build and publish multi-arch image",
      "- name: Other publish step",
    ),
  );
});

test("CLI runs from a copied script path containing spaces", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "docker-policy-owned-"));
  try {
    const copiedRoot = join(sandbox, "copied repo with spaces");
    const copiedScripts = join(copiedRoot, "scripts");
    const copiedWorkflows = join(copiedRoot, ".github/workflows");
    mkdirSync(copiedScripts, { recursive: true });
    mkdirSync(copiedWorkflows, { recursive: true });

    const copiedChecker = join(
      copiedScripts,
      "check docker latest tag policy.mjs",
    );
    const defaultWorkflow = join(copiedWorkflows, "docker-image.yml");
    const explicitValid = join(copiedRoot, "valid workflow.yml");
    const explicitInvalid = join(copiedRoot, "invalid workflow.yml");
    writeFileSync(copiedChecker, readFileSync(checkerPath));
    writeFileSync(defaultWorkflow, workflow);
    writeFileSync(explicitValid, workflow);
    writeFileSync(
      explicitInvalid,
      replaceOnce(workflow, "latest=false", "latest=true"),
    );

    const explicitSuccess = spawnSync(
      process.execPath,
      [copiedChecker, explicitValid],
      { cwd: tmpdir(), encoding: "utf8" },
    );
    assert.equal(explicitSuccess.status, 0, explicitSuccess.stderr);
    assert.match(explicitSuccess.stdout, /policy passed/);

    const explicitFailure = spawnSync(
      process.execPath,
      [copiedChecker, explicitInvalid],
      { cwd: tmpdir(), encoding: "utf8" },
    );
    assert.equal(explicitFailure.status, 1);
    assert.match(explicitFailure.stderr, /fail:/);

    const scriptRelativeDefault = spawnSync(process.execPath, [copiedChecker], {
      cwd: tmpdir(),
      encoding: "utf8",
    });
    assert.equal(scriptRelativeDefault.status, 0, scriptRelativeDefault.stderr);
    assert.match(scriptRelativeDefault.stdout, /policy passed/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
  assert.equal(existsSync(sandbox), false, "test must remove only its own temp root");
});
