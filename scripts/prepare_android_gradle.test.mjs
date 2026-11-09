import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, truncateSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GRADLE_ALL_SHA256, GRADLE_ALL_URL, GRADLE_BIN_SHA256,
  GRADLE_ALL_BYTES, prepareAndroidGradle, prepareGradleWrapperProperties, verifiedGradleArchiveUrl,
} from "./prepare_android_gradle.mjs";
import { GRADLE_ALL_ASSET_API } from "./fetch_android_gradle.mjs";

const template = "# Generated wrapper\ndistributionBase=GRADLE_USER_HOME\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-9.6.1-bin.zip\ndistributionPath=wrapper/dists\nzipStorePath=wrapper/dists\nzipStoreBase=GRADLE_USER_HOME\n";

test("official distribution URL and checksum pins match the verified Gradle release", () => {
  assert.equal(GRADLE_ALL_URL, "https://downloads.gradle.org/distributions/gradle-9.6.1-all.zip");
  assert.equal(GRADLE_ALL_SHA256, "61ba77b3ff7167e60962763eb4bae79db7120c189b9544358d0ade3c1e712a83");
  assert.equal(GRADLE_BIN_SHA256, "9c0f7faeeb306cb14e4279a3e084ca6b596894089a0638e68a07c945a32c9e14");
  assert.equal(GRADLE_ALL_BYTES, 239601473);
  assert.equal(GRADLE_ALL_ASSET_API, "https://api.github.com/repos/gradle/gradle-distributions/releases/assets/458711396");
});

test("pins the same official Gradle version and verified ALL archive before wrapper bootstrap", () => {
  const output = prepareGradleWrapperProperties(template);
  assert.ok(output.includes(`distributionUrl=${GRADLE_ALL_URL.replace("https:", "https\\:")}\n`));
  assert.ok(output.includes(`distributionSha256Sum=${GRADLE_ALL_SHA256}\n`));
  assert.match(output, /^networkTimeout=60000$/m);
  assert.match(output, /^retries=2$/m);
  assert.match(output, /^retryBackOffMs=1000$/m);
  assert.equal(prepareGradleWrapperProperties(output), output);
  assert.ok(output.startsWith("# Generated wrapper\ndistributionBase=GRADLE_USER_HOME\n"));
});

test("preserves CRLF, unrelated properties and a longer bounded network timeout", () => {
  const input = (template + "customProperty=keep\nnetworkTimeout=90000\nretryBackOffMs=2000\n").replaceAll("\n", "\r\n");
  const output = prepareGradleWrapperProperties(input);
  assert.equal(output.replaceAll("\r\n", "").includes("\n"), false);
  assert.ok(output.includes("customProperty=keep\r\nnetworkTimeout=90000\r\nretryBackOffMs=2000\r\n"));
});

test("accepts only the matching pre-existing official archive checksum", () => {
  assert.doesNotThrow(() => prepareGradleWrapperProperties(template + `distributionSha256Sum=${GRADLE_BIN_SHA256}\n`));
  const output = prepareGradleWrapperProperties(template);
  assert.throws(() => prepareGradleWrapperProperties(output.replace(GRADLE_ALL_SHA256, GRADLE_BIN_SHA256)), /checksum/);
});

for (const [name, input] of [
  ["different version", template.replace("9.6.1", "9.6.0")],
  ["untrusted mirror", template.replace("services.gradle.org", "example.invalid")],
  ["cleartext", template.replace("https\\:", "http\\:")],
  ["URL query", template.replace("bin.zip", "bin.zip?override=1")],
  ["wrong checksum", template + `distributionSha256Sum=${"0".repeat(64)}\n`],
  ["duplicate URL", template + "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.6.1-bin.zip\n"],
  ["duplicate timeout", template + "networkTimeout=10000\nnetworkTimeout=60000\n"],
  ["alternate protected syntax", template + " retries:2\n"],
  ["escaped duplicate URL key", template + "distribution\\u0055rl=https\\://example.invalid/tool.zip\n"],
  ["escaped duplicate checksum key", template + "distributionSha256\\Sum=none\n"],
  ["Unicode-escaped duplicate checksum key", template + "distributionSha256\\u0053um=none\n"],
  ["split protected key continuation", template + "distribution\\\nUrl=https\\://example.invalid/tool.zip\n"],
  ["continued final unrelated value", template + "customProperty=keep\\\n"],
  ["continued value before checksum", template + `customProperty=keep\\\ndistributionSha256Sum=${GRADLE_BIN_SHA256}\n`],
  ["unbounded retries", template + "retries=99\n"],
  ["negative retries", template + "retries=-1\n"],
  ["unbounded timeout", template + "networkTimeout=999999\n"],
  ["non-integer backoff", template + "retryBackOffMs=NaN\n"],
  ["different cache layout", template.replace("zipStoreBase=GRADLE_USER_HOME", "zipStoreBase=PROJECT")],
  ["missing cache layout", template.replace("distributionPath=wrapper/dists\n", "")],
  ["NUL", template + "# invalid comment \0\n"],
]) {
  test(`rejects ${name} without writing a partial wrapper`, () => {
    const root = mkdtempSync(join(tmpdir(), "yawf-gradle-prep-"));
    try {
      const directory = join(root, "web/src-tauri/gen/android/gradle/wrapper");
      mkdirSync(directory, { recursive: true });
      const path = join(directory, "gradle-wrapper.properties");
      writeFileSync(path, input);
      assert.throws(() => prepareAndroidGradle(root));
      assert.equal(readFileSync(path, "utf8"), input);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("prepares a generated project once and refuses a missing project", () => {
  const root = mkdtempSync(join(tmpdir(), "yawf-gradle-prep-"));
  try {
    assert.throws(() => prepareAndroidGradle(root));
    const directory = join(root, "web/src-tauri/gen/android/gradle/wrapper");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "gradle-wrapper.properties"), template);
    assert.equal(prepareAndroidGradle(root).changed, true);
    assert.equal(prepareAndroidGradle(root).changed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects invalid source encoding without changing unrelated bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "yawf-gradle-prep-"));
  try {
    const directory = join(root, "web/src-tauri/gen/android/gradle/wrapper");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "gradle-wrapper.properties");
    const bytes = Buffer.concat([Buffer.from(template + "# invalid comment "), Buffer.from([0xff]), Buffer.from("\n")]);
    writeFileSync(path, bytes);
    assert.throws(() => prepareAndroidGradle(root), /UTF-8/);
    assert.deepEqual(readFileSync(path), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local bootstrap rejects missing, wrong-sized, directory and symlink archives", () => {
  const root = mkdtempSync(join(tmpdir(), "yawf-gradle-archive-"));
  try {
    const archive = join(root, "archive.zip");
    assert.throws(() => verifiedGradleArchiveUrl(archive));
    assert.throws(() => verifiedGradleArchiveUrl(root));
    writeFileSync(archive, "not the pinned archive");
    assert.throws(() => verifiedGradleArchiveUrl(archive));
    const link = join(root, "link.zip");
    symlinkSync(archive, link);
    assert.throws(() => verifiedGradleArchiveUrl(link));
    assert.throws(() => prepareGradleWrapperProperties(template, archive));
    assert.equal(readFileSync(archive, "utf8"), "not the pinned archive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("official API fetch is bounded and cannot use ambient curl credentials or skip verification", () => {
  const source = readFileSync(new URL("./fetch_android_gradle.mjs", import.meta.url), "utf8");
  assert.match(source, /"--disable", "--fail"/);
  assert.match(source, /"--proto", "=https", "--proto-redir", "=https"/);
  assert.match(source, /"--max-filesize", String\(GRADLE_ALL_BYTES\)/);
  assert.match(source, /"--header", "Accept: application\/octet-stream"/);
  assert.doesNotMatch(source, /process\.env\.(?:GITHUB_TOKEN|GH_TOKEN)|--insecure|--netrc|--user|"--location-trusted"/);
  assert.match(source, /"--max-redirs", "3", "--config", "-"/);
  assert.match(source, /delete env\.YAWF_GRADLE_API_TOKEN/);
  assert.match(source, /delete env\.GH_TOKEN/);
  assert.match(source, /delete env\.GITHUB_TOKEN/);
  assert.ok(source.indexOf("verifiedGradleArchiveUrl(archive);") > source.indexOf("if (result.status !== 0) throw"));
  assert.ok(source.indexOf("return archive;") > source.indexOf("verifiedGradleArchiveUrl(archive);"));
  assert.match(source, /timeout: 360_000/);
});

test("a full-sized untrusted archive cannot enter the local wrapper bootstrap", () => {
  const root = mkdtempSync(join(tmpdir(), "yawf-gradle-archive-hash-"));
  try {
    const archive = join(root, "archive.zip");
    writeFileSync(archive, "");
    truncateSync(archive, GRADLE_ALL_BYTES);
    assert.throws(() => verifiedGradleArchiveUrl(archive), /pinned official bytes/);
    assert.equal(statSync(archive).size, GRADLE_ALL_BYTES);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all three Android entrypoints prepare the wrapper before its first invocation", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const phone = readFileSync(new URL("../.github/workflows/android-release.yml", import.meta.url), "utf8");
  const desktop = readFileSync(new URL("../.github/workflows/web-release.yml", import.meta.url), "utf8");
  const android = ci.slice(ci.indexOf("\n  tauri-android:"), ci.indexOf("\n  android-tv:"));
  assert.ok(android.indexOf("node scripts/prepare_android_gradle.mjs") > android.indexOf("node scripts/patch_tauri_android.mjs"));
  assert.ok(android.indexOf("node scripts/prepare_android_gradle.mjs") > android.indexOf("node scripts/fetch_android_gradle.mjs"));
  assert.ok(android.indexOf("node scripts/prepare_android_gradle.mjs") < android.indexOf("run: ./gradlew"));
  const build = phone.slice(phone.indexOf("      - name: Build the Android project"), phone.indexOf("      - name: Sign and verify the phone APK"));
  const order = /node \.\.\/scripts\/patch_tauri_android\.mjs\s+YAWF_GRADLE_ARCHIVE="\$\(YAWF_GRADLE_API_TOKEN="\$yawf_gradle_api_token" node \.\.\/scripts\/fetch_android_gradle\.mjs\)"\s+unset yawf_gradle_api_token\s+export YAWF_GRADLE_ARCHIVE\s+node \.\.\/scripts\/prepare_android_gradle\.mjs\s+kotlin_maven_root="\$\(node \.\.\/scripts\/fetch_android_kotlin_compiler\.mjs "\$RUNNER_TEMP\/yawf-kotlin-m2"\)"\s+export GRADLE_OPTS="\$\{GRADLE_OPTS:-\} -Dmaven\.repo\.local=\$kotlin_maven_root"\s+npm run tauri -- android build --apk/;
  assert.match(build, order);
  const coordinated = desktop.slice(desktop.indexOf("      - name: Build the Android project"), desktop.indexOf("      - name: Sign and verify the phone APK"));
  assert.match(coordinated, order);
  const patchStart = android.indexOf("      - name: Patch generated Android playback support");
  assert.ok(patchStart >= 0);
  const patch = android.slice(patchStart, android.indexOf("\n      # The real gate", patchStart));
  for (const section of [build, coordinated, patch]) {
    assert.match(section, /YAWF_GRADLE_API_TOKEN: \$\{\{ github\.token \}\}/);
    const unset = section.indexOf("unset YAWF_GRADLE_API_TOKEN");
    const firstConsumer = Math.min(...["npm run build", "node scripts/patch_tauri_android.mjs"].map(value => section.indexOf(value)).filter(index => index >= 0));
    assert.ok(unset >= 0 && unset < firstConsumer);
  }
  assert.match(patch, /kotlin_maven_root="\$\(node scripts\/fetch_android_kotlin_compiler\.mjs "\$RUNNER_TEMP\/yawf-kotlin-m2"\)"/);
  assert.match(patch, /GRADLE_OPTS=%s -Dmaven\.repo\.local=%s/);
  assert.match(patch, />> "\$GITHUB_ENV"/);
  assert.ok(patch.indexOf("fetch_android_kotlin_compiler.mjs") > patch.indexOf("unset yawf_gradle_api_token"));
  assert.match(ci, /node --test[^\n]*scripts\/fetch_android_kotlin_compiler\.test\.mjs/);
  assert.match(ci, /node --test scripts\/prepare_android_gradle\.test\.mjs/);
});
