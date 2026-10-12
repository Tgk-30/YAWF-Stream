import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertHealth,
  assertNonRootRuntime,
  assertPackageVersion,
  assertPersistedSetting,
  assertRestartedSession,
  assertStableResourceResponse,
  assertSupportedRuntime,
  assertUnauthenticatedProfileDenied,
  assertMissingResourceResponse,
  discoverCompiledAssets,
  listCompiledAssets,
  parseArgs,
  sanitizeDiagnostic,
  selectCompiledAssets,
} from "./smoke_server_artifact.mjs";

const dockerWorkflow = await readFile(new URL("../.github/workflows/docker-image.yml", import.meta.url), "utf8");
const debWorkflow = await readFile(new URL("../.github/workflows/deb-release.yml", import.meta.url), "utf8");

function workflowStep(source, name) {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const next = source.indexOf("\n      - name: ", start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

test("parses explicit container or extracted Debian artifact paths", () => {
  const options = parseArgs([
    "--expected-version", "2.3.7",
    "--server-entry", "./extracted/opt/debridstreamer/server/dist/index.cjs",
    "--web-dist", "./extracted/opt/debridstreamer/web-dist",
    "--receipt", "./receipt.json",
    "--startup-timeout-ms", "12000",
    "--request-timeout-ms", "3000",
  ]);
  assert.equal(options.expectedVersion, "2.3.7");
  assert.match(options.serverEntry, /extracted[/\\]opt[/\\]debridstreamer[/\\]server[/\\]dist[/\\]index\.cjs$/);
  assert.match(options.webDist, /extracted[/\\]opt[/\\]debridstreamer[/\\]web-dist$/);
  assert.match(options.receipt, /receipt\.json$/);
  assert.equal(options.startupTimeoutMs, 12000);
  assert.equal(options.requestTimeoutMs, 3000);
});

test("rejects malformed versions, unknown flags, duplicate flags, and unbounded timeouts", () => {
  const base = ["--expected-version", "2.3.7", "--server-entry", "/tmp/index.cjs", "--web-dist", "/tmp/web"];
  assert.throws(() => parseArgs(base.with(1, "v2.3.7")), /exact numeric patch version/);
  assert.throws(() => parseArgs([...base, "--unknown", "value"]), /Unknown option/);
  assert.throws(() => parseArgs([...base, "--web-dist", "/tmp/other"]), /Duplicate option/);
  assert.throws(() => parseArgs([...base, "--request-timeout-ms", "999999"]), /between 500 and 30000/);
});

test("requires Node 24 or newer and a non-root runtime", () => {
  assert.equal(assertSupportedRuntime("24.0.0"), "24.0.0");
  assert.equal(assertSupportedRuntime("26.1.0"), "26.1.0");
  assert.throws(() => assertSupportedRuntime("23.11.9"), /Node 24 or newer/);
  assert.throws(() => assertSupportedRuntime("not-a-version"), /Node 24 or newer/);
  assert.doesNotThrow(() => assertNonRootRuntime(() => 1000));
  assert.throws(() => assertNonRootRuntime(() => 0), /non-root user/);
});

test("requires exact first-run and restarted health state", () => {
  assert.doesNotThrow(() => assertHealth({ ok: true, setupRequired: true, setupTokenRequired: true }, true));
  assert.doesNotThrow(() => assertHealth({ ok: true, setupRequired: false, setupTokenRequired: false }, false));
  assert.throws(
    () => assertHealth({ ok: true, setupRequired: false, setupTokenRequired: false }, true),
    /expected setup state/,
  );
});

test("rejects a wrong packaged version or an active external update check", () => {
  const valid = {
    ok: true,
    update: { currentVersion: "2.3.7", latestVersion: null, available: false },
  };
  assert.doesNotThrow(() => assertPackageVersion(valid, "2.3.7"));
  assert.throws(
    () => assertPackageVersion({ ...valid, update: { ...valid.update, currentVersion: "2.3.6" } }, "2.3.7"),
    /version or disabled update-check state/,
  );
  assert.throws(
    () => assertPackageVersion({ ...valid, update: { ...valid.update, latestVersion: "2.3.8", available: true } }, "2.3.7"),
    /version or disabled update-check state/,
  );
});

test("requires served HTML to reference hashed JavaScript and CSS assets", () => {
  assert.deepEqual(
    discoverCompiledAssets(`<!doctype html><script type="module" src="/assets/index-AbCdEf12.js"></script><link rel="stylesheet" href="/assets/index-ZyXwVu98.css">`),
    ["/assets/index-AbCdEf12.js", "/assets/index-ZyXwVu98.css"],
  );
  assert.throws(
    () => discoverCompiledAssets(`<script type="module" src="/assets/index-AbCdEf12.js"></script>`),
    /hashed JavaScript and CSS/,
  );
  assert.throws(
    () => discoverCompiledAssets(`<script src="/assets/index.js"></script><link href="/assets/index-ZyXwVu98.css">`),
    /unhashed compiled/,
  );
});

test("selects every packaged lazy JavaScript and CSS asset for artifact verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "yawf-smoke-assets-"));
  try {
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "index-AbCdEf12.js"), "entry");
    await writeFile(join(root, "assets", "index-ZyXwVu98.css"), "style");
    await writeFile(join(root, "assets", "VideoPlayer-QwErTy12.js"), "lazy");
    const packaged = await listCompiledAssets(root);
    assert.deepEqual(packaged, [
      "/assets/VideoPlayer-QwErTy12.js",
      "/assets/index-AbCdEf12.js",
      "/assets/index-ZyXwVu98.css",
    ]);
    assert.deepEqual(
      selectCompiledAssets(
        ["/assets/index-AbCdEf12.js", "/assets/index-ZyXwVu98.css"],
        packaged,
      ),
      packaged,
    );

    await writeFile(join(root, "assets", "unhashed.js"), "bad");
    await assert.rejects(() => listCompiledAssets(root), /did not have a content hash/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires exact unauthenticated profile denial", () => {
  assert.doesNotThrow(() => assertUnauthenticatedProfileDenied(401));
  for (const status of [200, 302, 403, 404, 500]) {
    assert.throws(() => assertUnauthenticatedProfileDenied(status), /was not denied/);
  }
});

test("requires stable resource revalidation and genuine missing-resource 404s", () => {
  const headers = (values) => new Headers(values);
  assert.doesNotThrow(() => assertStableResourceResponse(200, headers({
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  })));
  assert.throws(
    () => assertStableResourceResponse(200, headers({
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    })),
    /require HTTP revalidation/,
  );

  assert.doesNotThrow(() => assertMissingResourceResponse(404, headers({
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
  })));
  assert.throws(
    () => assertMissingResourceResponse(200, headers({
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    })),
    /non-HTML, no-store 404/,
  );
});

test("requires the exact profile setting after restart", () => {
  assert.doesNotThrow(() => assertPersistedSetting({ settings: { marker: "expected" } }, "marker", "expected"));
  assert.throws(
    () => assertPersistedSetting({ settings: { marker: "stale" } }, "marker", "expected"),
    /not persisted across the packaged server restart/,
  );
  assert.throws(
    () => assertPersistedSetting({ settings: {} }, "marker", "expected"),
    /not persisted across the packaged server restart/,
  );
});

test("requires the existing owner profile and CSRF state after restart", () => {
  const valid = {
    session: { role: "owner", profileId: "profile-1" },
    csrfToken: "csrf-1",
  };
  assert.doesNotThrow(() => assertRestartedSession(valid, "profile-1", "csrf-1"));
  assert.throws(
    () => assertRestartedSession({ ...valid, session: { ...valid.session, profileId: "profile-2" } }, "profile-1", "csrf-1"),
    /did not survive/,
  );
  assert.throws(
    () => assertRestartedSession({ ...valid, csrfToken: "csrf-2" }, "profile-1", "csrf-1"),
    /did not survive/,
  );
});

test("redacts fixture credentials and session material from diagnostics", () => {
  const secret = "fixture-secret-value";
  const message = sanitizeDiagnostic(
    `failed ${secret} ds_session=session-value; ds_csrf=csrf-value; {"password":"password-value","setupToken":"token-value","csrfToken":"csrf-json"}`,
    [secret],
  );
  assert.doesNotMatch(message, /fixture-secret|session-value|csrf-value|password-value|token-value|csrf-json/);
  assert.match(message, /\[REDACTED\]/);
});

test("runs both architecture image smokes before any registry login", () => {
  const buildx = dockerWorkflow.indexOf("- name: Set up Docker Buildx");
  const login = dockerWorkflow.indexOf("- name: Log in to GHCR");
  assert.ok(buildx >= 0 && login > buildx);
  const prelogin = dockerWorkflow.slice(buildx, login);
  for (const architecture of ["amd64", "arm64"]) {
    assert.match(prelogin, new RegExp(`--platform linux/${architecture}`));
    assert.match(prelogin, new RegExp(`yawf-server-smoke:${architecture}`));
  }
  assert.equal((prelogin.match(/--network none/g) ?? []).length, 2);
  assert.equal((prelogin.match(/--read-only/g) ?? []).length, 2);
  assert.equal((prelogin.match(/smoke_server_artifact\.mjs/g) ?? []).length, 6);
});

test("keeps dispatch verification-only and re-smokes the published digest on both architectures", () => {
  const login = workflowStep(dockerWorkflow, "Log in to GHCR");
  const publish = workflowStep(dockerWorkflow, "Build and publish multi-arch image");
  const verify = workflowStep(dockerWorkflow, "Verify published images by immutable digest");
  const retain = workflowStep(dockerWorkflow, "Retain server image verification receipts");

  assert.match(login, /^        if: github\.event_name == 'push'$/m);
  assert.match(publish, /^          push: \$\{\{ github\.event_name == 'push' \}\}$/m);
  assert.match(verify, /^        if: github\.event_name == 'push'$/m);
  for (const step of [login, publish, verify]) {
    assert.doesNotMatch(step, /github\.event_name != 'pull_request'|workflow_dispatch/);
  }

  assert.match(publish, /^        id: publish$/m);
  assert.match(verify, /^          IMAGE_DIGEST: \$\{\{ steps\.publish\.outputs\.digest \}\}$/m);
  assert.match(verify, /\[\[ "\$IMAGE_DIGEST" =~ \^sha256:\[a-f0-9\]\{64\}\$ \]\]/);
  assert.match(verify, /image="\$IMAGE_NAME@\$IMAGE_DIGEST"/);
  assert.match(verify, /for architecture in amd64 arm64; do/);
  assert.match(verify, /docker pull --platform "linux\/\$architecture" "\$image"/);
  assert.match(verify, /--platform "linux\/\$architecture"/);
  assert.match(verify, /yawf-published-smoke-linux-\$architecture\.jsonl/);

  assert.match(retain, /^        if: always\(\)$/m);
  assert.match(retain, /actions\/upload-artifact@v4/);
  assert.match(retain, /yawf-server-smoke-linux-\*\.json/);
  assert.match(retain, /yawf-published-smoke-linux-\*\.jsonl/);
  assert.match(retain, /if-no-files-found: ignore/);
});

test("Debian candidate uses package version, full gates, extracted smoke, receipt, and checksums", () => {
  assert.match(debWorkflow, /package_version="\$\(node -p "require\('\.\/server\/package\.json'\)\.version"\)"/);
  assert.match(debWorkflow, /release tag must be vX\.Y\.Z or vX\.Y\.Z-web/);
  assert.equal((debWorkflow.match(/npm test/g) ?? []).length, 2);
  assert.equal((debWorkflow.match(/npm audit --omit=dev/g) ?? []).length, 2);
  assert.match(debWorkflow, /dpkg-deb --extract "\$candidate" "\$extracted"/);
  assert.match(debWorkflow, /--server-entry "\$extracted\/opt\/debridstreamer\/server\/dist\/index\.cjs"/);
  assert.match(debWorkflow, /--receipt "\$receipt"/);
  assert.match(debWorkflow, /> SHA256SUMS/);
});

test("Debian install checks exercise the same candidate on Ubuntu 22 and 24", () => {
  assert.match(debWorkflow, /install-check:\n[\s\S]*?needs: deb/);
  assert.match(debWorkflow, /runner:\n\s+- ubuntu-22\.04\n\s+- ubuntu-24\.04/);
  assert.match(debWorkflow, /https:\/\/deb\.nodesource\.com\/setup_24\.x/);
  assert.match(debWorkflow, /\/usr\/bin\/node --version \| grep -Eq '\^v24\\\.'/);
  assert.match(debWorkflow, /echo \/usr\/bin >> "\$GITHUB_PATH"/);
  assert.match(debWorkflow, /actions\/download-artifact@v4/);
  assert.match(debWorkflow, /sha256sum --check SHA256SUMS/);
  assert.match(debWorkflow, /sudo apt-get install -y "\$candidate"/);
  assert.match(debWorkflow, /chmod 0755 "\$smoke_dir"/);
  assert.match(debWorkflow, /sudo -u debridstreamer node "\$smoke_dir\/smoke_server_artifact\.mjs"/);
  assert.match(debWorkflow, /sudo systemctl start debridstreamer/);
  assert.match(debWorkflow, /sudo systemctl restart debridstreamer/);
  assert.match(debWorkflow, /Environment=HOST=127\.0\.0\.1/);
  assert.match(debWorkflow, /Environment=DS_SERVER_UPDATE_CHECK=false/);
  assert.match(debWorkflow, /chmod 0600 \/etc\/systemd\/system\/debridstreamer\.service\.d\/10-ci-smoke\.conf/);
  assert.match(debWorkflow, /systemctl show debridstreamer --property=MainPID/);
});
