import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { kotlinGradleInit, prepareAndroidKotlinGradle } from "./prepare_android_kotlin_gradle.mjs";
import { stageVerifiedKotlinCompiler, stageVerifiedKotlinCompilerPom } from "./fetch_android_kotlin_compiler.mjs";
const jar = process.env.DS_TEST_KOTLIN_JAR, pom = process.env.DS_TEST_KOTLIN_POM;
const fixture = () => realpathSync(mkdtempSync(join(tmpdir(), "gradle-pin-")));
function staged(root) { const m2 = join(root, "m2"); stageVerifiedKotlinCompiler(jar, m2); stageVerifiedKotlinCompilerPom(pom, m2); return m2; }
test("generated init limits both repository scopes to exact version with only Maven POM metadata", () => {
  const attack = "/owned/a'${throw new RuntimeException()}/m2";
  const init = kotlinGradleInit(attack);
  assert.equal(init.includes(attack), false); assert.ok(init.includes(Buffer.from(attack).toString("base64")));
  assert.match(init, /project\.repositories, project\.buildscript\.repositories/);
  assert.match(init, /exclusiveContent/); assert.match(init, /includeVersion\('org\.jetbrains\.kotlin', 'kotlin-compiler-embeddable', '2\.3\.21'\)/);
  assert.match(init, /metadataSources \{ mavenPom\(\) \}/);
  assert.doesNotMatch(init, /mavenCentral\(|pluginManagement|ignoreGradleMetadataRedirection|artifact\(\)|allowInsecureProtocol|verificationMode/);
  assert.match(init, /checkPinned\(\)\ngradle.beforeProject/); assert.match(init, /beforeProject \{ project ->\n    checkPinned\(\)/);
  assert.match(init, /newByteChannel\(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS\)/);
});
test("fresh canonical home contains exactly one fixed init file", { skip: !jar || !pom }, () => {
  const root = fixture(); try { const m2 = staged(root), home = join(root, "home");
    assert.equal(prepareAndroidKotlinGradle(m2, home), home);
    assert.deepEqual(readdirSync(home), ["init.d"]); assert.deepEqual(readdirSync(join(home, "init.d")), ["yawf-kotlin-compiler.init.gradle"]);
    assert.equal(readFileSync(join(home, "init.d/yawf-kotlin-compiler.init.gradle"), "utf8"), kotlinGradleInit(m2));
    assert.throws(() => prepareAndroidKotlinGradle(m2, home), /fresh canonical/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("home aliases, unrelated init scripts, noncanonical and overlapping paths are rejected", { skip: !jar || !pom }, () => {
  const root = fixture(); try { const m2 = staged(root); mkdirSync(join(root, "real")); symlinkSync(join(root, "real"), join(root, "alias"));
    for (const home of [join(root, "alias"), root + "/../else", m2, join(m2, "home"), root]) assert.throws(() => prepareAndroidKotlinGradle(m2, home));
    const home = join(root, "unrelated"); mkdirSync(home); mkdirSync(join(home, "init.d")); writeFileSync(join(home, "init.d/other.gradle"), "keep");
    assert.throws(() => prepareAndroidKotlinGradle(m2, home), /fresh canonical/); assert.equal(readFileSync(join(home, "init.d/other.gradle"), "utf8"), "keep");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("CLI rejects missing or extra arguments", () => {
  for (const args of [[], ["/m2", "/home", "--override"]]) {
    const result = spawnSync(process.execPath, [new URL("./prepare_android_kotlin_gradle.mjs", import.meta.url).pathname, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Exactly one canonical Maven root/);
  }
});
