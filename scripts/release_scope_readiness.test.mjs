import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { validateWebsiteReleaseCatalog } from "./check_website_release_catalog.mjs";
import { validateDockerLatestTagPolicy } from "./check_docker_latest_tag_policy.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
// The override selects only owned static-source copies for negative controls.
const readinessSource = readFileSync(process.env.RELEASE_SCOPE_READINESS_SOURCE ?? join(ROOT, "scripts/check_release_readiness.mjs"), "utf8");
const web = readFileSync(join(ROOT, ".github/workflows/web-release.yml"), "utf8");
const clean = readFileSync(join(ROOT, ".github/workflows/clean-install.yml"), "utf8");
const LABEL = {
  tv: "Release workflow builds a signed Android TV package",
  publish: "Manual Android verification cannot enter a publication job",
  clean: "Release workflow gates drafts on clean installs",
  phone: "Clean-install workflow requires and verifies the Android phone asset",
  media: "Release workflow bundles ffmpeg binaries",
};

function checks(overrides = {}) {
  // Execute the actual static gate, not copied predicates. Only its existing
  // unrelated catalog test subprocess is stubbed; the real gate also runs below
  // during handoff verification. No workflow run block or signing command runs.
  let source = readinessSource.replace(/^#![^\n]*\n/, "").replace(/^import .*;\n/gm, "");
  const rootLine = 'const root = join(dirname(fileURLToPath(import.meta.url)), "..");';
  assert.equal(source.split(rootLine).length, 2);
  source = source.replace(rootLine, "const root = ROOT;");
  const tail = source.indexOf("\nconst failed = checks.filter");
  assert.notEqual(tail, -1);
  source = source.slice(0, tail) + "\nglobalThis.results = checks;";
  const context = {
    ROOT, join, dirname, existsSync, validateWebsiteReleaseCatalog, validateDockerLatestTagPolicy,
    process: { execPath: process.execPath },
    readFileSync(path, options) {
      const name = relative(ROOT, String(path)).replaceAll("\\", "/");
      return Object.hasOwn(overrides, name) ? overrides[name] : readFileSync(path, options);
    },
    execFileSync(_file, args) {
      assert.deepEqual(Array.from(args), ["--test", join(ROOT, "scripts/check_website_release_catalog.test.mjs")]);
      return Buffer.from("");
    },
  };
  vm.runInNewContext(source, context, { timeout: 2000 });
  assert.equal(context.results.length, (readinessSource.match(/^check\(/gm) ?? []).length);
  return Array.from(context.results);
}

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, "Mutation anchor must be unique");
  return source.replace(before, after);
}

function job(source, id, mutate) {
  const start = new RegExp(`^  ${id}:\\n`, "m").exec(source);
  assert.ok(start, "Missing job mutation anchor");
  const next = /^  [a-z][a-z0-9_-]*:\s*$/m.exec(source.slice(start.index + start[0].length));
  const end = next ? start.index + start[0].length + next.index : source.length;
  return source.slice(0, start.index) + mutate(source.slice(start.index, end)) + source.slice(end);
}

function jobIf(block, mutate) {
  const start = /^    if: (.*)\n/m.exec(block);
  assert.ok(start, "Missing job-level condition");
  let condition = start[1];
  let end = start.index + start[0].length;
  if ([">-", ">"].includes(condition)) {
    const parts = [];
    for (const line of block.slice(end).split("\n")) {
      if (!line.startsWith("      ")) break;
      parts.push(line.trim()); end += line.length + 1;
    }
    condition = parts.join(" ");
  }
  return block.slice(0, start.index) + "    if: " + mutate(condition) + "\n" + block.slice(end);
}

function rejected(label, changed, file = "web-release") {
  const result = checks({ [`.github/workflows/${file}.yml`]: changed }).find(value => value.name === LABEL[label]);
  assert.ok(result, "Missing readiness check");
  assert.equal(result.pass, false, LABEL[label]);
}

test("actual readiness accepts the scoped topology while evaluating every existing static check", () => {
  const result = checks();
  assert.ok(result.length > 100);
  for (const label of Object.values(LABEL)) assert.equal(result.find(value => value.name === label)?.pass, true, label);
  assert.deepEqual(result.filter(value => !value.pass).map(value => value.name), []);
});

test("finalizer requires every exact dependency, not a nearby needs list", () => {
  for (const missing of ["release-scope", "release", "android-tv", "android-app-publish"]) {
    const changed = job(web, "finalize-release-assets", block => {
      const names = ["release-scope", "release", "android-tv", "android-app-publish"].filter(name => name !== missing);
      return replaceOnce(block, "needs: [release-scope, release, android-tv, android-app-publish]", `needs: [${names.join(", ")}]`);
    });
    rejected("tv", changed + "\n  irrelevant:\n    needs: [release-scope, release, android-tv, android-app-publish]\n");
  }
});

test("finalizer preserves coordinated success and scoped skips with successful scope and desktop release", () => {
  for (const [before, after] of [
    ["needs.android-tv.result == 'success'", "needs.android-tv.result != 'failure'"],
    ["needs.android-tv.result == 'skipped'", "needs.android-tv.result != 'failure'"],
    ["needs.android-app-publish.result == 'success'", "true"],
    ["needs.release-scope.result == 'success'", "true"],
    ["needs.release.result == 'success'", "true"],
    ["!cancelled() && ", ""],
  ]) rejected("tv", job(web, "finalize-release-assets", block => replaceOnce(block, before, after)));
});

test("folded job-level push-tag conditions retain their full known-safe meaning", () => {
  const changed = job(web, "android-app-publish", block => block.replace(/^    if: (.+)$/m,
    (_line, condition) => "    if: >-\n      " + condition.split(" && ").join(" &&\n      ")));
  assert.equal(checks({ ".github/workflows/web-release.yml": changed }).find(value => value.name === LABEL.publish).pass, true);
});

test("publisher gates reject manual-dispatch OR lanes even after a valid push-tag prefix", () => {
  for (const id of ["release", "android-tv", "android-app-publish", "clean-install"]) {
    rejected("publish", job(web, id, block => jobIf(block, condition => condition + " || github.event_name == 'workflow_dispatch'")));
  }
  rejected("publish", job(web, "finalize-release-assets", block => jobIf(block, condition => "github.event_name == 'workflow_dispatch' || " + condition)));
});

test("step-level push-tag decoys cannot replace a required job-level publication gate", () => {
  const changed = job(web, "android-app-publish", block => {
    const condition = /^    if: (.+)$/m.exec(block)?.[1];
    assert.ok(condition);
    return block.replace(/^    if: .+\n/m, "") + "\n      - name: Gate decoy\n        if: " + condition + "\n";
  });
  rejected("publish", changed);
});

test("manual phone branch lane and exact scope prefix remain mandatory without release writes", () => {
  for (const [before, after] of [
    ["needs.release-scope.result == 'success'", "true"],
    ["needs.release-scope.outputs.desktop_only == 'false'", "needs.release-scope.outputs.desktop_only != 'true'"],
    ["github.ref_type == 'branch'", "github.ref_type == 'tag'"],
  ]) rejected("publish", job(web, "android-app", block => jobIf(block, condition => replaceOnce(condition, before, after))));
  rejected("publish", job(web, "android-app", block => block + "\n        run: gh release upload injected\n"));
});

test("clean-install caller requires exact finalizer dependency and scope-derived Android/server flags", () => {
  for (const [before, after] of [
    ["needs: [release-scope, finalize-release-assets]", "needs: [release-scope]"],
    ["include_android: ${{ needs.release-scope.outputs.include_android == 'true' }}", "include_android: ${{ needs.release-scope.outputs.include_android == 'false' }}"],
    ["include_server: ${{ needs.release-scope.outputs.include_server == 'true' }}", "include_server: false"],
    ["tag: ${{ github.ref_name }}", "tag: unrelated"],
  ]) rejected("clean", job(web, "clean-install", block => replaceOnce(block, before, after)));
});

test("clean-install readiness requires skip-rescuing status checks and explicit cancellation rejection", () => {
  for (const [before, after] of [["always() && !cancelled() && ", ""], ["!cancelled() && ", ""]]) {
    rejected("clean", job(web, "clean-install", block => jobIf(block, condition => replaceOnce(condition, before, after))));
  }
});

test("clean-install retains the draft-asset access permission despite the longer folded condition", () => {
  const changed = job(web, "clean-install", block => replaceOnce(block, "      contents: write", "      contents: read"));
  const result = checks({ ".github/workflows/web-release.yml": changed }).find(value => value.name === "Release workflow grants draft asset access to clean installs");
  assert.equal(result.pass, false);
});

for (const event of ["workflow_call", "workflow_dispatch"]) for (const input of ["include_android", "include_server"]) {
  test(`${event} ${input} must default true for existing verification paths`, () => {
    const eventStart = new RegExp(`^  ${event}:\\n`, "m").exec(clean);
    assert.ok(eventStart);
    const next = /^  [a-z][a-z0-9_-]*:\s*$/m.exec(clean.slice(eventStart.index + eventStart[0].length));
    const end = next ? eventStart.index + eventStart[0].length + next.index : clean.indexOf("\npermissions:");
    const eventBlock = clean.slice(eventStart.index, end);
    const regex = new RegExp(`(      ${input}:\\n[\\s\\S]*?default:) true`);
    assert.match(eventBlock, regex);
    const changed = clean.slice(0, eventStart.index) + eventBlock.replace(regex, "$1 false") + clean.slice(end);
    rejected("phone", changed, "clean-install");
  });
}

test("phone clean-install job must use the positive include-Android job gate", () => {
  rejected("phone", job(clean, "android-phone", block => replaceOnce(block, "    if: inputs.include_android", "    if: '!inputs.include_android'")), "clean-install");
  rejected("phone", job(clean, "android-phone", block => replaceOnce(block, "    if: inputs.include_android\n", "")), "clean-install");
});

test("inventory must require both APKs under the true Android inclusion guard", () => {
  rejected("phone", replaceOnce(clean, 'if [ "$INCLUDE_ANDROID" = "true" ]; then', 'if [ "$INCLUDE_ANDROID" != "true" ]; then'), "clean-install");
  for (const name of ["YAWF.Stream_Android.TV_${expected_version}.apk", "YAWF.Stream_Android_${expected_version}.apk"]) {
    rejected("phone", replaceOnce(clean, name, "Unrelated_${expected_version}.apk"), "clean-install");
  }
});

test("phone's pinned production verifier body cannot disappear behind a valid new gate", () => {
  rejected("phone", job(clean, "android-phone", block => replaceOnce(block, "python3 scripts/verify_android_apk.py", "echo verifier-removed")), "clean-install");
  rejected("phone", job(clean, "android-phone", block => replaceOnce(block, "--certificate-pin web/src-tauri/SIGNING_CERT_SHA256", "--certificate-pin unrelated")), "clean-install");
});

test("release requires both scope and native media producer dependencies with all ffmpeg checks intact", () => {
  const changed = job(web, "release", block => replaceOnce(block, "needs: [release-scope, macos-media-runtime]", "needs: [release-scope]"));
  rejected("media", changed + "\n  irrelevant-media:\n    needs: macos-media-runtime\n");
  rejected("media", replaceOnce(web, "download_ffmpeg.mjs linux-x64", "echo ffmpeg-removed"));
});

test("existing phone least-privilege checks are not bypassed by the new scope adaptation", () => {
  const changed = job(web, "android-app", block => replaceOnce(block, "      contents: read", "      contents: write"));
  const result = checks({ ".github/workflows/web-release.yml": changed }).find(value => value.name === "Android phone build and publisher keep least-privilege boundaries");
  assert.equal(result.pass, false);
});
