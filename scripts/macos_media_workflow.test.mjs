import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const producer = readFileSync(new URL("../.github/workflows/macos-media-runtime.yml", import.meta.url), "utf8");
const consumer = readFileSync(new URL("../.github/workflows/web-release.yml", import.meta.url), "utf8");
const readiness = readFileSync(new URL("./check_release_readiness.mjs", import.meta.url), "utf8");

export function assertMacMediaBuildTools(source) {
  assert.match(source, /brew install [^\n]*\blibtool\b/);
  assert.match(source, /libtool_prefix="\$\(brew --prefix libtool\)"/);
  assert.match(source, /test -x "\$libtool_prefix\/bin\/glibtoolize"/);
  assert.match(source, /test -f "\$libtool_prefix\/share\/aclocal\/libtool\.m4"/);
}

test("clean native runners install explicit build tools without media libraries", () => assertMacMediaBuildTools(producer));

test("one freshly admitted content-addressed source archive feeds both native jobs", () => {
  assert.match(producer, /jobs:[\s\S]*\n  source:/);
  assert.match(producer, /name: macos-media-corresponding-source/g);
  assert.match(producer, /needs: source/);
  assert.match(producer, /EXPECTED_SOURCE_SHA256: \$\{\{ needs\.source\.outputs\.archive_sha256 \}\}/);
  assert.match(producer, /EXPECTED_SOURCE_FILE: \$\{\{ needs\.source\.outputs\.archive_file \}\}/);
  assertDurableSourceTransport(producer);
  assert.match(producer, /actions: read/);
  assert.doesNotMatch(producer, /buildMacosMediaRuntime|build_macos_media_runtime\.mjs/);
});

export function assertDurableSourceTransport(source) {
  const metadata = source.indexOf('gh api "repos/Tgk-30/YAWF-Stream/releases/$SOURCE_RELEASE_ID"');
  const validate = source.indexOf('--verify-source-transport-metadata "$transport/source-transport-metadata.json"');
  const asset = source.indexOf('gh api "repos/Tgk-30/YAWF-Stream/releases/assets/$SOURCE_ASSET_ID"');
  const prepare = source.indexOf('--prepare-source');
  assert.ok(metadata >= 0 && asset > metadata && validate > asset && prepare > validate,
    "retrieved release metadata must be verified before source preparation");
  assert.match(source, /SOURCE_RELEASE_ID: "417897650"/);
  assert.match(source, /SOURCE_ASSET_ID: "657879542"/);
  assert.match(source, /--source-transport-metadata "\$RUNNER_TEMP\/source-transport\/source-transport-metadata\.json"/);
  assert.doesNotMatch(source.slice(0, source.indexOf("  build:")), /SOURCE_RUN_ID|run-id:/);
  assertPrivateTransportIsolation(source);
}

export function assertPrivateTransportIsolation(source) {
  const transport = source.slice(source.indexOf("  transport:"), source.indexOf("  source:"));
  const preparation = source.slice(source.indexOf("  source:"), source.indexOf("  build:"));
  assert.match(transport, /if: github\.event_name != 'pull_request'/);
  assert.match(transport, /permissions:\n\s+contents: write/);
  assert.doesNotMatch(transport, /actions\/checkout|python|node |scripts\//);
  assert.match(preparation, /needs: transport/);
  assert.match(preparation, /persist-credentials: false/);
  assert.doesNotMatch(preparation, /GH_TOKEN|contents: write|gh api/);
}

test("durable source transport rejects bypassed validation and expiring seed retrieval", () => {
  assertDurableSourceTransport(producer);
  assert.throws(() => assertDurableSourceTransport(producer.replace(
    '--verify-source-transport-metadata "$transport/source-transport-metadata.json"',
    '--unverified-metadata "$transport/source-transport-metadata.json"',
  )));
  assert.throws(() => assertDurableSourceTransport(producer.replace(
    '      SOURCE_ASSET_ID: "657879542"',
    '      SOURCE_RUN_ID: "39304293958"',
  )));
});

test("private draft access never grants a write token to pull requests or project code", () => {
  assertPrivateTransportIsolation(producer);
  for (const [before, after] of [
    ["if: github.event_name != 'pull_request'", "if: always()"],
    ["name: Retrieve only the fixed draft asset and metadata", "uses: actions/checkout@v4"],
    ["persist-credentials: false", "persist-credentials: true"],
    ["name: Validate the exact pinned durable source transport", "name: Run\n        env:\n          GH_TOKEN: token"],
  ]) assert.throws(() => assertPrivateTransportIsolation(producer.replace(before, after)));
});

test("both native architectures use the independent confined shipping producer", () => {
  assert.match(producer, /runner: macos-15\n\s+arch: arm64/);
  assert.match(producer, /runner: macos-15-intel\n\s+arch: x86_64/);
  assert.match(producer, /produce_macos_media_runtime\.py \\\n\s+--build/);
  assert.match(producer, /--source-dir "\$RUNNER_TEMP\/corresponding-source"/);
  assert.match(producer, /--workspace "\$RUNNER_TEMP\/media-shipping-\$MEDIA_ARCH"/);
  assert.doesNotMatch(producer, /MEDIA_PREFIX|--install-prefix/);
});

test("shared confinement and tool-selection helper changes run their focused gate", () => {
  assert.match(producer, /scripts\/ci\/run_macos_media_replay_experiment\.py/);
  assert.match(producer, /\/usr\/bin\/python3 -I -B scripts\/ci\/run_macos_media_replay_experiment\.test\.py -v/);
});

test("release readiness validates the independent producer and bundled replay notice control", () => {
  assert.match(readiness, /produce_macos_media_runtime\\\.py\[\\s\\S\]\*--prepare-source/);
  assert.match(readiness, /produce_macos_media_runtime\\\.py\[\\s\\S\]\*--build/);
  assert.match(readiness, /replay_macos_media_sources\\\.mjs/);
  assert.match(readiness, /prepare_macos_replay_notices\\\.mjs/);
  assert.equal(readiness.includes("/replay-support\\/scripts\\/prepare_macos_replay_notices"), true);
});

export function assertMacMediaTransport(source, target) {
  assert.match(source, /tar -czf "macos-media-runtime-\$MEDIA_ARCH\.tar\.gz" -C "\$MEDIA_STAGE" \./);
  assert.match(source, /shasum -a 256 "macos-media-runtime-\$MEDIA_ARCH\.tar\.gz" > "macos-media-runtime-\$MEDIA_ARCH\.tar\.gz\.sha256"/);
  const hash = target.indexOf('shasum -a 256 -c "macos-media-runtime-$MEDIA_ARCH.tar.gz.sha256"');
  const extract = target.indexOf('tar -xzf "macos-media-runtime-$MEDIA_ARCH.tar.gz"');
  const smoke = target.indexOf("name: Retest natural media runtime after artifact transport");
  const sign = target.indexOf("name: Import Developer ID certificate");
  assert.ok(hash >= 0 && extract > hash && smoke > extract && sign > smoke, "transport must verify, extract, smoke, then sign");
  assert.match(target, /test -x "\$RUNNER_TEMP\/media-candidate\/ffmpeg\/ffmpeg"/);
  assert.match(target, /test -L "\$RUNNER_TEMP\/media-candidate\/Frameworks\/libmpv\.dylib"/);
}

test("existing release transport and post-transport smoke stay compatible", () => assertMacMediaTransport(producer, consumer));

test("native builds retain a finite budget and bounded evidence", () => {
  const timeout = /^    timeout-minutes: (\d+)$/gm;
  const values = [...producer.matchAll(timeout)].map((match) => Number(match[1]));
  assert.deepEqual(values, [10, 30, 120]);
  assert.match(producer, /Retain bounded runtime failure or success evidence/);
  assert.doesNotMatch(producer, /owned-output\/replay-\$\{\{ matrix\.arch \}\}-macos11\/install/);
});
