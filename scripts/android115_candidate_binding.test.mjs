import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/android115-unfaulted-qa.yml", import.meta.url), "utf8");
const sha = "6150542fb6e22ebae5ecd467947a7650404a3d18";
const apkSha = "97439137620a402d9e8e3a5976dcfc894386dad9566c26a07d1e82575f993aba";

function contract(source) {
  assert.match(source, /permissions:\n  contents: read\n  actions: read/);
  assert.doesNotMatch(source, /(?:contents|actions|id-token): write|secrets\.|pull_request_target|git push|gh release|gh variable/);
  for (const line of [
    "      CANDIDATE_VERSION: 2.3.115",
    '      CANDIDATE_VERSION_CODE: "2003115"',
    '      CANDIDATE_APK_BYTES: "89320321"',
    `      CANDIDATE_APK_SHA256: ${apkSha}`,
    `      CANDIDATE_SOURCE_SHA: ${sha}`,
    '      CANDIDATE_RUN_ID: "43854400447"',
    '      CANDIDATE_ARTIFACT_ID: "14220523201"',
    "          artifact-ids: 14220523201",
    "          run-id: 43854400447",
    "          repository: ${{ github.repository }}",
    "          github-token: ${{ github.token }}",
    "          merge-multiple: true",
    "          path: ${{ runner.temp }}/android115-candidate",
    '          apk="$RUNNER_TEMP/android115-candidate/YAWF.Stream_Android_2.3.115.apk"',
    '          test -f "$apk" && test ! -L "$apk"',
    '          test "$(wc -c < "$apk" | tr -d \' \')" = "$CANDIDATE_APK_BYTES"',
    '          printf \'%s  %s\\n\' "$CANDIDATE_APK_SHA256" "$apk" | sha256sum --check -',
    '          test "$(apkanalyzer manifest application-id "$apk")" = com.tgk30.debridstreamer',
    '          test "$(apkanalyzer manifest version-name "$apk")" = "$CANDIDATE_VERSION"',
    '          test "$(apkanalyzer manifest version-code "$apk")" = "$CANDIDATE_VERSION_CODE"',
    "          python3 candidate-source/scripts/verify_android_apk.py \\",
    "            --certificate-pin candidate-source/web/src-tauri/SIGNING_CERT_SHA256 \\",
    '          test "$("${adb_cmd[@]}" shell sha256sum "$installed" | awk \'{print $1}\')" = "$CANDIDATE_APK_SHA256"',
  ]) assert.ok(source.includes(line), `Missing exact candidate gate: ${line}`);
  assert.ok(source.indexOf("name: Admit immutable unpublished candidate producer and artifact") <
    source.indexOf("name: Download exact immutable candidate artifact"));
  assert.ok(source.indexOf("name: Download exact immutable candidate artifact") <
    source.indexOf("name: Verify exact unpublished signed phone115 APK"));
  assert.doesNotMatch(source, /releases\/download|CANDIDATE_APK_URL|publicVersion|publicApkSha256|publicSource/);
}

const bindingBody = /          python3 - <<'PY_BINDING'\n([\s\S]*?)\n          PY_BINDING\n/.exec(workflow)?.[1];
assert.ok(bindingBody, "Immutable producer binding must execute before download");
const script = bindingBody.replace(/^          /gm, "");
const runFixture = {
  id: 43854400447, head_sha: sha, head_branch: "codex/android115-integrated-current",
  event: "workflow_dispatch", path: ".github/workflows/android-release.yml",
  status: "completed", conclusion: "success",
};
const artifactFixture = {
  id: 14220523201, name: "android-phone-verification-candidate", expired: false,
  size_in_bytes: 39666120,
  workflow_run: { id: 43854400447, head_sha: sha, head_branch: "codex/android115-integrated-current" },
};

function admit(run, artifact) {
  const temporary = process.env.TMPDIR ?? process.env.RUNNER_TEMP ?? tmpdir();
  if (process.platform === "darwin") {
    assert.ok(resolve(temporary).startsWith("/Volumes/Work/"), "Use Work-owned TMPDIR on this Mac");
  }
  const root = mkdtempSync(join(temporary, "android115-candidate-binding-"));
  try {
    writeFileSync(join(root, "candidate-run.json"), JSON.stringify(run));
    writeFileSync(join(root, "candidate-artifact.json"), JSON.stringify(artifact));
    return spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "-B", "-c", script], {
      env: { PATH: process.env.PATH, RUNNER_TEMP: root, TMPDIR: temporary },
      timeout: 5000, encoding: "utf8", maxBuffer: 65536,
    });
  } finally {
    rmSync(root, { recursive: true });
  }
}

test("candidate adapter binds only the immutable signed unpublished artifact", () => contract(workflow));

for (const needle of [
  `      CANDIDATE_SOURCE_SHA: ${sha}`,
  `      CANDIDATE_APK_SHA256: ${apkSha}`,
  '      CANDIDATE_APK_BYTES: "89320321"',
  '      CANDIDATE_VERSION_CODE: "2003115"',
  "          artifact-ids: 14220523201",
  "          run-id: 43854400447",
  "          repository: ${{ github.repository }}",
  '          test -f "$apk" && test ! -L "$apk"',
  "            --certificate-pin candidate-source/web/src-tauri/SIGNING_CERT_SHA256 \\",
  '          test "$("${adb_cmd[@]}" shell sha256sum "$installed" | awk \'{print $1}\')" = "$CANDIDATE_APK_SHA256"',
]) {
  test(`candidate contract rejects removal of ${needle.trim().split(/[ :]/)[0]}`, () => {
    assert.ok(workflow.includes(needle));
    assert.throws(() => contract(workflow.replace(needle, "")));
  });
}

test("actual Python binding accepts the exact producer and artifact fixture", () => {
  const result = admit(runFixture, artifactFixture);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

const mutations = [
  ["producer run ID", r => { r.id++; }],
  ["producer source", r => { r.head_sha = "0".repeat(40); }],
  ["producer branch", r => { r.head_branch = "main"; }],
  ["producer event", r => { r.event = "push"; }],
  ["producer workflow", r => { r.path = ".github/workflows/other.yml"; }],
  ["unfinished producer", r => { r.status = "in_progress"; }],
  ["failed producer", r => { r.conclusion = "failure"; }],
  ["artifact ID", (_r, a) => { a.id++; }],
  ["artifact name", (_r, a) => { a.name = "other"; }],
  ["expired artifact", (_r, a) => { a.expired = true; }],
  ["missing expiry", (_r, a) => { delete a.expired; }],
  ["artifact byte count", (_r, a) => { a.size_in_bytes++; }],
  ["artifact producer run", (_r, a) => { a.workflow_run.id++; }],
  ["artifact source", (_r, a) => { a.workflow_run.head_sha = "0".repeat(40); }],
  ["artifact branch", (_r, a) => { a.workflow_run.head_branch = "main"; }],
  ["missing producer binding", (_r, a) => { delete a.workflow_run; }],
];
for (const [name, mutate] of mutations) {
  test(`actual Python binding rejects ${name}`, () => {
    const run = structuredClone(runFixture), artifact = structuredClone(artifactFixture);
    mutate(run, artifact);
    const result = admit(run, artifact);
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, name);
  });
}
