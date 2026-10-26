import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflow = readFileSync(
  join(root, ".github/workflows/android-runtime-check.yml"),
  "utf8",
);
const api30RuntimeStart = workflow.indexOf("  api30-runtime:");
const api30GuideStart = workflow.indexOf("  api30-stock-webview-guide:");
assert.ok(api30RuntimeStart >= 0 && api30GuideStart > api30RuntimeStart);
const api30Runtime = workflow.slice(api30RuntimeStart, api30GuideStart);
const api30Guide = workflow.slice(api30GuideStart);

const candidatePins = {
  CANDIDATE_RUN_ID: "39857024891",
  CANDIDATE_RUN_WORKFLOW_ID: "299659497",
  CANDIDATE_RUN_HEAD_BRANCH: "codex/qa-platform-release-2326",
  CANDIDATE_SOURCE_SHA: "e7e2b7796684bf437bb10fdc9fc51263a8ba016a",
  CANDIDATE_APK_SHA256: "23587726b3ad4f2a82f4a89bd568f6c9680c1ea2a7680d41eb4b0a5475e614b3",
  CANDIDATE_APK_SIZE: "88558465",
  CANDIDATE_ACTIONS_ARTIFACT: "android-phone-verification-candidate",
  CANDIDATE_DRAFT_RELEASE_ID: "421230453",
  CANDIDATE_DRAFT_RELEASE_TAG: "v2.3.31-web",
  CANDIDATE_DRAFT_TAG_OBJECT_SHA: "7672ea318acecd01d449cf9f71ade3509bfc3d3d",
  CANDIDATE_DRAFT_TAG_COMMIT_SHA: "25fb08df12a24c535113b745328f72cb63a3b51e",
  CANDIDATE_DRAFT_ASSET_ID: "667390405",
  CANDIDATE_DRAFT_ASSET_NAME: "YAWF.Stream_Android_2.3.31.apk",
};

function resolverPython(job) {
  const match = job.match(
    /- name: Resolve exact private historical candidate delivery[\s\S]*?python3 - <<'PY'\n([\s\S]*?)\n          PY/,
  );
  assert.ok(match, "candidate delivery resolver is missing");
  return match[1].replace(/^          /gm, "");
}

function validateCandidateDelivery(job) {
  for (const [key, value] of Object.entries(candidatePins)) {
    assert.ok(job.includes(`${key}: ${/^[0-9]+$/.test(value) ? `"${value}"` : value}`), `missing ${key}`);
  }
  const resolver = job.indexOf("- name: Resolve exact private historical candidate delivery");
  const actions = job.indexOf("- name: Download exact signed candidate Actions artifact");
  const draft = job.indexOf("- name: Recover exact signed candidate from authenticated draft asset");
  const setup = job.indexOf("- name: Set up JDK 17");
  assert.ok(resolver >= 0 && resolver < actions && actions < draft && draft < setup);
  assert.match(job, /if: steps\.candidate_source\.outputs\.kind == 'actions'[\s\S]*uses: actions\/download-artifact@v4/);
  assert.match(job, /if: steps\.candidate_source\.outputs\.kind == 'draft'[\s\S]*repos\/\$GITHUB_REPOSITORY\/releases\/assets\/\$CANDIDATE_DRAFT_ASSET_ID/);
  assert.match(job, /test "\$\(stat -c %s "\$CANDIDATE_APK"\)" = "\$CANDIDATE_APK_SIZE"/);
  assert.equal((job.match(/stat -c %s "\$CANDIDATE_APK"/g) ?? []).length, 2);
  assert.match(job, /printf '%s  %s\\n' "\$CANDIDATE_APK_SHA256" "\$CANDIDATE_APK" \| sha256sum --check -/);
  assert.doesNotMatch(job, /continue-on-error/);

  const python = resolverPython(job);
  for (const literal of [
    'run.get("head_sha") == source_sha',
    'run.get("workflow_id") == int(os.environ["CANDIDATE_RUN_WORKFLOW_ID"])',
    'assert total == 0, "Candidate Actions artifact is missing from a nonempty inventory"',
    'release.get("draft") is True and release.get("immutable") is False',
    'asset = get(f"releases/assets/{asset_id}")',
    'tag_ref = get(f"git/ref/tags/{urllib.parse.quote(tag_name, safe=\'\')}")',
    'comparison = get(f"compare/{source_sha}...{tag_commit}")',
    '"classification=private-historical-signed-fixture"',
    '"releasedOta=false"',
    '"publicDownload=false"',
    '"otaPublicationEvidence=false"',
  ]) {
    assert.ok(python.includes(literal), `resolver missing ${literal}`);
  }
  assert.doesNotMatch(python, /except\s|browser_download_url|print\(token/);
}

function producerRun() {
  return {
    id: 39857024891,
    workflow_id: 299659497,
    name: "web-release",
    path: ".github/workflows/web-release.yml",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    head_sha: candidatePins.CANDIDATE_SOURCE_SHA,
    head_branch: candidatePins.CANDIDATE_RUN_HEAD_BRANCH,
    repository: { full_name: "Tgk-30/YAWF-Stream" },
    head_repository: { full_name: "Tgk-30/YAWF-Stream" },
  };
}

function draftResponses(artifacts = { total_count: 0, artifacts: [] }) {
  const asset = {
    id: 667390405,
    name: candidatePins.CANDIDATE_DRAFT_ASSET_NAME,
    size: 88558465,
    digest: `sha256:${candidatePins.CANDIDATE_APK_SHA256}`,
    state: "uploaded",
    content_type: "application/vnd.android.package-archive",
    uploader: { login: "github-actions[bot]" },
  };
  return {
    "actions/runs/39857024891": producerRun(),
    "actions/runs/39857024891/artifacts?per_page=100": artifacts,
    "releases/421230453": {
      id: 421230453,
      tag_name: "v2.3.31-web",
      name: "v2.3.31-web",
      draft: true,
      immutable: false,
      prerelease: false,
      published_at: null,
      target_commitish: "main",
      assets: [asset],
    },
    "releases/assets/667390405": asset,
    "git/ref/tags/v2.3.31-web": {
      ref: "refs/tags/v2.3.31-web",
      object: { type: "tag", sha: candidatePins.CANDIDATE_DRAFT_TAG_OBJECT_SHA },
    },
    [`git/tags/${candidatePins.CANDIDATE_DRAFT_TAG_OBJECT_SHA}`]: {
      tag: "v2.3.31-web",
      object: { type: "commit", sha: candidatePins.CANDIDATE_DRAFT_TAG_COMMIT_SHA },
    },
    [`compare/${candidatePins.CANDIDATE_SOURCE_SHA}...${candidatePins.CANDIDATE_DRAFT_TAG_COMMIT_SHA}`]: {
      status: "ahead",
      ahead_by: 1,
      behind_by: 0,
      total_commits: 1,
      base_commit: { sha: candidatePins.CANDIDATE_SOURCE_SHA },
      merge_base_commit: { sha: candidatePins.CANDIDATE_SOURCE_SHA },
      commits: [{ sha: candidatePins.CANDIDATE_DRAFT_TAG_COMMIT_SHA }],
      files: [
        { filename: "website-app/package-lock.json" },
        { filename: "website-app/package.json" },
      ],
    },
  };
}

function runResolver(responses) {
  const directory = mkdtempSync(join(tmpdir(), "yawf-private-candidate-resolver-"));
  const evidence = join(directory, "evidence");
  const output = join(directory, "output.txt");
  mkdirSync(evidence);
  const wrapper = `
import json, os, urllib.request
responses = json.loads(os.environ.pop("FAKE_GITHUB_RESPONSES"))
calls = []
class Response:
    status = 200
    def __init__(self, value): self.body = json.dumps(value).encode()
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, size=-1): return self.body if size < 0 else self.body[:size]
def fake_urlopen(request, timeout):
    prefix = os.environ["GITHUB_API_URL"].rstrip("/") + "/repos/" + os.environ["GITHUB_REPOSITORY"] + "/"
    assert request.full_url.startswith(prefix)
    key = request.full_url[len(prefix):]
    calls.append(key)
    if key not in responses: raise RuntimeError("unexpected metadata request")
    return Response(responses[key])
urllib.request.urlopen = fake_urlopen
exec(${JSON.stringify(resolverPython(api30Runtime))})
print(json.dumps(calls))
`;
  try {
    const result = spawnSync("python3", ["-c", wrapper], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...candidatePins,
        FAKE_GITHUB_RESPONSES: JSON.stringify(responses),
        GITHUB_API_URL: "https://api.github.test",
        GITHUB_REPOSITORY: "Tgk-30/YAWF-Stream",
        GH_TOKEN: "test-token-not-a-credential",
        GITHUB_OUTPUT: output,
        EVIDENCE: evidence,
      },
    });
    return {
      ...result,
      output: result.status === 0 ? readFileSync(output, "utf8") : "",
      evidence: result.status === 0 ? readFileSync(join(evidence, "candidate-delivery.txt"), "utf8") : "",
      calls: result.status === 0 ? JSON.parse(result.stdout) : [],
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const otaPolicyMutationCommand =
  'python3 scripts/android-runtime-instrumentation/ota_policy_mutation_check.py \\\n' +
  '            | tee "$EVIDENCE/ota-policy-mutations.json"';

function validateOtaPolicyMutationGate(source) {
  const failures = [];
  const generalPolicy = source.indexOf(
    "python3 scripts/android-runtime-instrumentation/policy_mutation_check.py",
  );
  const otaPolicy = source.indexOf(otaPolicyMutationCommand);
  const gradle = source.indexOf("          gradle \\");
  if (generalPolicy < 0) failures.push("general policy mutation gate is missing");
  if (otaPolicy < 0) failures.push("exact OTA policy mutation gate is missing");
  if ((source.match(/ota_policy_mutation_check\.py/g) ?? []).length !== 1) {
    failures.push("OTA policy mutation gate must occur exactly once");
  }
  if (!(generalPolicy < otaPolicy && otaPolicy < gradle)) {
    failures.push("OTA policy mutation gate must follow general policy mutants and precede Gradle");
  }
  return failures;
}

test("pins the exact verification artifact while retaining the published channel", () => {
  assert.match(api30Runtime, /CANDIDATE_RUN_ID: "39857024891"/);
  assert.match(api30Runtime, /CANDIDATE_SOURCE_SHA: e7e2b7796684bf437bb10fdc9fc51263a8ba016a/);
  assert.match(api30Runtime, /CANDIDATE_APK_SHA256: 23587726b3ad4f2a82f4a89bd568f6c9680c1ea2a7680d41eb4b0a5475e614b3/);
  assert.match(api30Runtime, /CANDIDATE_ACTIONS_ARTIFACT: android-phone-verification-candidate/);
  assert.match(api30Runtime, /CANDIDATE_VERSION: 2\.3\.31/);
  assert.match(api30Runtime, /CANDIDATE_VERSION_CODE: "2003031"/);
  assert.match(api30Runtime, /PUBLISHED_ANDROID_VERSION: 2\.3\.27/);
});

test("keeps identical exact-metadata delivery resolvers in both legacy runtime jobs", () => {
  validateCandidateDelivery(api30Runtime);
  validateCandidateDelivery(api30Guide);
  assert.equal(resolverPython(api30Runtime), resolverPython(api30Guide));
  assert.equal(
    (workflow.match(/- name: Resolve exact private historical candidate delivery/g) ?? []).length,
    2,
  );
});

test("uses the Actions artifact when present and the exact authenticated draft only for an empty inventory", () => {
  const actions = runResolver({
    "actions/runs/39857024891": producerRun(),
    "actions/runs/39857024891/artifacts?per_page=100": {
      total_count: 1,
      artifacts: [{ name: "android-phone-verification-candidate", expired: false }],
    },
  });
  assert.equal(actions.status, 0, actions.stderr);
  assert.equal(actions.output, "kind=actions\n");
  assert.match(actions.evidence, /delivery=actions-artifact/);
  assert.match(actions.evidence, /draftMetadataVerified=false/);
  assert.deepEqual(actions.calls, [
    "actions/runs/39857024891",
    "actions/runs/39857024891/artifacts?per_page=100",
  ]);

  const draft = runResolver(draftResponses());
  assert.equal(draft.status, 0, draft.stderr);
  assert.equal(draft.output, "kind=draft\n");
  assert.match(draft.evidence, /classification=private-historical-signed-fixture/);
  assert.match(draft.evidence, /delivery=authenticated-draft-asset-fallback/);
  assert.match(draft.evidence, /draftMetadataVerified=true/);
  assert.match(draft.evidence, /releasedOta=false/);
  assert.match(draft.evidence, /publicDownload=false/);
  assert.match(draft.evidence, /otaPublicationEvidence=false/);
  assert.deepEqual(draft.calls, [
    "actions/runs/39857024891",
    "actions/runs/39857024891/artifacts?per_page=100",
    "releases/421230453",
    "releases/assets/667390405",
    "git/ref/tags/v2.3.31-web",
    `git/tags/${candidatePins.CANDIDATE_DRAFT_TAG_OBJECT_SHA}`,
    `compare/${candidatePins.CANDIDATE_SOURCE_SHA}...${candidatePins.CANDIDATE_DRAFT_TAG_COMMIT_SHA}`,
  ]);
});

test("fails closed on nonempty unexpected inventories and any fallback metadata mismatch", () => {
  const unexpectedInventory = runResolver(
    draftResponses({ total_count: 1, artifacts: [{ name: "different-artifact", expired: false }] }),
  );
  assert.notEqual(unexpectedInventory.status, 0);
  assert.match(unexpectedInventory.stderr, /Candidate Actions artifact is missing from a nonempty inventory/);

  const mismatchedAsset = draftResponses();
  mismatchedAsset["releases/assets/667390405"] = {
    ...mismatchedAsset["releases/assets/667390405"],
    size: 1,
  };
  const mismatch = runResolver(mismatchedAsset);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /Fallback asset size changed/);

  const unavailable = draftResponses();
  delete unavailable["releases/421230453"];
  const networkFailure = runResolver(unavailable);
  assert.notEqual(networkFailure.status, 0);
  assert.match(networkFailure.stderr, /unexpected metadata request/);
});

for (const [name, mutate] of [
  ["release id", (value) => value.replaceAll('CANDIDATE_DRAFT_RELEASE_ID: "421230453"', 'CANDIDATE_DRAFT_RELEASE_ID: "1"')],
  ["asset id", (value) => value.replaceAll('CANDIDATE_DRAFT_ASSET_ID: "667390405"', 'CANDIDATE_DRAFT_ASSET_ID: "1"')],
  ["tag object", (value) => value.replaceAll(candidatePins.CANDIDATE_DRAFT_TAG_OBJECT_SHA, "0".repeat(40))],
  ["empty-inventory gate", (value) => value.replaceAll('assert total == 0, "Candidate Actions artifact is missing from a nonempty inventory"', "assert total >= 0")],
  ["private classification", (value) => value.replaceAll("classification=private-historical-signed-fixture", "classification=public-release")],
  ["download hash", (value) => value.replaceAll("sha256sum --check -", 'sha256sum "$CANDIDATE_APK"')],
]) {
  test(`rejects mutated candidate fallback ${name}`, () => {
    const changed = mutate(workflow);
    assert.notEqual(changed, workflow);
    const runtimeStart = changed.indexOf("  api30-runtime:");
    const guideStart = changed.indexOf("  api30-stock-webview-guide:");
    assert.throws(() => validateCandidateDelivery(changed.slice(runtimeStart, guideStart)));
  });
}

test("verifies the pinned APK and production invariants before generating local metadata", () => {
  const pinnedHashCheck = workflow.indexOf(
    `printf '%s  %s\\n' "$CANDIDATE_APK_SHA256" "$CANDIDATE_APK" | sha256sum -c -`,
  );
  const manifestBuild = workflow.indexOf(
    "node candidate-source/scripts/build_android_update_manifest.mjs",
  );
  const productionVerification = workflow.indexOf(
    "python3 candidate-source/scripts/verify_android_apk.py",
  );
  assert.ok(pinnedHashCheck >= 0);
  assert.ok(productionVerification > pinnedHashCheck);
  assert.ok(manifestBuild > productionVerification);
});

test("generates explicitly local verification metadata from the pinned candidate source", () => {
  assert.match(
    workflow,
    /name: Verify exact APK and signer with local verification metadata/,
  );
  assert.match(
    workflow,
    /local_metadata_dir="\$\(pwd\)\/\$EVIDENCE\/local-generated-verification-metadata"/,
  );
  assert.match(
    workflow,
    /node candidate-source\/scripts\/build_android_update_manifest\.mjs[\s\S]*--apk "\$CANDIDATE_APK"[\s\S]*--version "\$CANDIDATE_VERSION"[\s\S]*--source "\$CANDIDATE_SOURCE_SHA"[\s\S]*--output "\$local_metadata_dir\/android-update\.json"/,
  );
  assert.match(workflow, /classification=locally-generated-runtime-verification-metadata/);
  assert.match(workflow, /releaseAsset=false/);
  assert.match(workflow, /otaPublicationEvidence=false/);
  assert.doesNotMatch(workflow, /candidate\/android-update\.json/);
});

test("checks local metadata while retaining package version source and signer gates", () => {
  assert.match(
    workflow,
    /sha256sum -c "\$local_metadata_dir\/SHA256SUMS"/,
  );
  assert.match(
    workflow,
    /Path\(os\.environ\["LOCAL_METADATA_DIR"\]\) \/ "android-update\.json"/,
  );
  assert.match(workflow, /manifest\["sourceRevision"\] == os\.environ\["CANDIDATE_SOURCE_SHA"\]/);
  assert.match(workflow, /manifest\["apk"\]\["sha256"\] == os\.environ\["CANDIDATE_APK_SHA256"\]/);
  assert.match(workflow, /apkanalyzer manifest application-id "\$CANDIDATE_APK"/);
  assert.match(workflow, /apkanalyzer manifest version-name "\$CANDIDATE_APK"/);
  assert.match(workflow, /apkanalyzer manifest version-code "\$CANDIDATE_APK"/);
  assert.match(workflow, /candidate-source\/scripts\/verify_android_apk\.py/);
  assert.match(workflow, /--certificate-pin candidate-source\/web\/src-tauri\/SIGNING_CERT_SHA256/);
});

test("runs OTA policy baselines and mutants before Gradle", () => {
  assert.deepEqual(validateOtaPolicyMutationGate(workflow), []);

  const omission = workflow.replace(otaPolicyMutationCommand, "");
  assert.notDeepEqual(validateOtaPolicyMutationGate(omission), []);

  const wrongScript = workflow.replace(
    "ota_policy_mutation_check.py",
    "ota_policy_assertions_only.py",
  );
  assert.notDeepEqual(validateOtaPolicyMutationGate(wrongScript), []);

  const reordered = workflow
    .replace(otaPolicyMutationCommand + "\n", "")
    .replace("          gradle \\", "          gradle \\\n" + otaPolicyMutationCommand);
  assert.notDeepEqual(validateOtaPolicyMutationGate(reordered), []);
});
