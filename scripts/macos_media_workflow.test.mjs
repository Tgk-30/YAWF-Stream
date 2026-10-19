import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const producer = readFileSync(new URL("../.github/workflows/macos-media-runtime.yml", import.meta.url), "utf8");
const consumer = readFileSync(new URL("../.github/workflows/web-release.yml", import.meta.url), "utf8");

export function assertMacMediaBuildTools(source) {
  assert.match(source, /brew install [^\n]*\blibtool\b/);
  assert.match(source, /libtool_prefix="\$\(brew --prefix libtool\)"/);
  assert.match(source, /test -x "\$libtool_prefix\/bin\/glibtoolize"/);
  assert.match(source, /test -f "\$libtool_prefix\/share\/aclocal\/libtool\.m4"/);
  assert.match(source, /echo "ACLOCAL_PATH=\$libtool_prefix\/share\/aclocal\$\{ACLOCAL_PATH:\+:\$ACLOCAL_PATH\}" >> "\$GITHUB_ENV"/);
}

test("clean macOS runners install GNU libtool and expose its Autoconf macros", () => assertMacMediaBuildTools(producer));
test("rejects missing GNU libtool installation, executable, macro or search path", () => {
  for (const [before, after] of [
    ["automake libtool nasm", "automake nasm"],
    ['test -x "$libtool_prefix/bin/glibtoolize"', "true"],
    ['test -f "$libtool_prefix/share/aclocal/libtool.m4"', "true"],
    ['echo "ACLOCAL_PATH=', 'echo "UNUSED_ACLOCAL_PATH='],
  ]) assert.throws(() => assertMacMediaBuildTools(producer.replace(before, after)));
});

export function assertMacMediaTransport(source, target) {
  assert.match(source, /tar -czf "macos-media-runtime-\$MEDIA_ARCH\.tar\.gz" -C media-candidate \./);
  assert.match(source, /shasum -a 256 "macos-media-runtime-\$MEDIA_ARCH\.tar\.gz" > "macos-media-runtime-\$MEDIA_ARCH\.tar\.gz\.sha256"/);
  assert.match(source, /path: \|\n\s+\$\{\{ runner.temp \}\}\/macos-media-runtime-\$\{\{ matrix.arch \}\}\.tar\.gz\n\s+\$\{\{ runner.temp \}\}\/macos-media-runtime-\$\{\{ matrix.arch \}\}\.tar\.gz\.sha256/);
  const hash = target.indexOf('shasum -a 256 -c "macos-media-runtime-$MEDIA_ARCH.tar.gz.sha256"');
  const extract = target.indexOf('tar -xzf "macos-media-runtime-$MEDIA_ARCH.tar.gz"');
  const smoke = target.indexOf("name: Retest natural media runtime after artifact transport");
  const sign = target.indexOf("name: Import Developer ID certificate");
  assert.ok(hash >= 0 && extract > hash && smoke > extract && sign > smoke, "transport must verify, extract, smoke, then sign");
  assert.match(target, /test -x "\$RUNNER_TEMP\/media-candidate\/ffmpeg\/ffmpeg"/);
  assert.match(target, /test -x "\$RUNNER_TEMP\/media-candidate\/ffmpeg\/ffprobe"/);
  assert.match(target, /test -L "\$RUNNER_TEMP\/media-candidate\/Frameworks\/libmpv.dylib"/);
}

test("media artifact transport retains modes and aliases and is reverified before signing", () => assertMacMediaTransport(producer, consumer));
test("rejects missing archive/checksum/post-transport smoke contracts", () => {
  for (const [before, after] of [
    ['tar -czf "macos-media-runtime-$MEDIA_ARCH.tar.gz"', 'echo "no archive"'],
    ['shasum -a 256 "macos-media-runtime-$MEDIA_ARCH.tar.gz"', 'echo "no checksum"'],
  ]) assert.throws(() => assertMacMediaTransport(producer.replace(before, after), consumer));
  assert.throws(() => assertMacMediaTransport(producer, consumer.replace("name: Retest natural media runtime after artifact transport", "name: Removed smoke")));
});
