import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, lstatSync, readdirSync, copyFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  KOTLIN_ASSET_API, KOTLIN_JAR_BYTES, KOTLIN_JAR_SHA256, KOTLIN_JAR_SHA1, kotlinDownloadInvocation,
  kotlinTransferStatus, kotlinCompilerArtifactPath, verifyKotlinCompilerJar, stageVerifiedKotlinCompiler, fetchAndroidKotlinCompiler,
  KOTLIN_POM_URL, KOTLIN_POM_BYTES, KOTLIN_POM_SHA256, kotlinPomDownloadInvocation, kotlinCompilerPomPath, verifyKotlinCompilerPom, stageVerifiedKotlinCompilerPom,
} from "./fetch_android_kotlin_compiler.mjs";
const cached = process.env.DS_TEST_KOTLIN_JAR;
const cachedPom = process.env.DS_TEST_KOTLIN_POM;
const fixture = () => realpathSync(mkdtempSync(join(tmpdir(), "kotlin-pin-")));
test("anonymous curl is fixed-origin, TLS-only, curlrc-free and finitely bounded", () => {
  const args = kotlinDownloadInvocation("/owned/artifact.jar");
  assert.equal(args[0], "--disable"); assert.equal(args[args.indexOf("--config") + 1], "-");
  assert.equal(args[args.indexOf("--proto") + 1], "=https"); assert.equal(args[args.indexOf("--proto-redir") + 1], "=https");
  assert.equal(args.filter(s => s.startsWith("https://")).length, 1); assert.ok(args.includes(KOTLIN_ASSET_API));
  assert.equal(args[args.indexOf("--max-filesize") + 1], String(KOTLIN_JAR_BYTES));
  assert.equal(args[args.indexOf("--max-time") + 1], "60"); assert.equal(args[args.indexOf("--retry") + 1], "2");
  for (const flag of ["--location-trusted", "--netrc", "--insecure", "--user", "Authorization"]) assert.equal(args.some(x => x.includes(flag)), false);
  assert.equal(KOTLIN_JAR_SHA256, "d3e70fb011675e77ef00f1a68918d3cd91eed26058977d1e3ea2a37a293233af");
  assert.equal(KOTLIN_JAR_SHA1, "c4b47f8e33cdbeedd8c1415ab9f9ade870388162");
});
test("transport failure summaries cannot expose response text", () => {
  assert.equal(kotlinTransferStatus({ status: 22, stdout: "504", stderr: "private fixture response" }), "curl=22, HTTP=504");
  assert.equal(kotlinTransferStatus({ status: null, stdout: "200\nprivate" }), "curl=unavailable, HTTP=unavailable");
});
test("CLI refuses missing and extra override arguments before transport", () => {
  for (const args of [[], ["/owned", "--url", "https://invalid.example/"]]) {
    const r = spawnSync(process.execPath, [new URL("./fetch_android_kotlin_compiler.mjs", import.meta.url).pathname, ...args], { encoding: "utf8" });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /Exactly one absolute isolated Maven root/);
  }
});
for (const [label, make] of [["relative", () => "relative"], ["noncanonical", root => root + "/../other"], ["filesystem root", () => "/"]]) {
  test(`rejects ${label} Maven root before curl`, () => { const root = fixture(); try { assert.throws(() => fetchAndroidKotlinCompiler(make(root)), /isolated canonical/); } finally { rmSync(root, { recursive: true, force: true }); } });
}
test("rejects root and intermediate symlinks without following them", () => {
  const root = fixture(); try {
    mkdirSync(join(root, "real")); symlinkSync(join(root, "real"), join(root, "alias"));
    assert.throws(() => fetchAndroidKotlinCompiler(join(root, "alias")), /isolated canonical/);
    const maven = join(root, "m2"); mkdirSync(maven); symlinkSync(join(root, "real"), join(maven, "org"));
    assert.throws(() => fetchAndroidKotlinCompiler(maven), /isolated canonical/); assert.deepEqual(readdirSync(join(root, "real")), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("unexpected root entries are preserved and rejected before transport", () => {
  const root = fixture(); try { writeFileSync(join(root, "keep"), "unchanged"); assert.throws(() => fetchAndroidKotlinCompiler(root), /isolated canonical/); assert.equal(readFileSync(join(root, "keep"), "utf8"), "unchanged"); } finally { rmSync(root, { recursive: true, force: true }); }
});
test("existing wrong JAR is rejected without deletion or overwrite", () => {
  const root = fixture(); try { const jar = kotlinCompilerArtifactPath(root); mkdirSync(join(jar, ".."), { recursive: true }); writeFileSync(jar, "wrong"); const inode = lstatSync(jar).ino; assert.throws(() => fetchAndroidKotlinCompiler(root), /size or file type/); assert.equal(lstatSync(jar).ino, inode); assert.equal(readFileSync(jar, "utf8"), "wrong"); } finally { rmSync(root, { recursive: true, force: true }); }
});
test("rejects a JAR leaf symlink without altering its target", () => {
  const root = fixture(); try { const jar = kotlinCompilerArtifactPath(join(root, "m2")); mkdirSync(join(jar, ".."), { recursive: true }); writeFileSync(join(root, "original"), "keep"); symlinkSync(join(root, "original"), jar); assert.throws(() => fetchAndroidKotlinCompiler(join(root, "m2")), /isolated canonical/); assert.equal(readFileSync(join(root, "original"), "utf8"), "keep"); } finally { rmSync(root, { recursive: true, force: true }); }
});
test("right-size wrong bytes fail the hard hash fence", () => {
  const root = fixture(); try { const p = join(root, "wrong.jar"); writeFileSync(p, ""); truncateSync(p, KOTLIN_JAR_BYTES); assert.throws(() => verifyKotlinCompilerJar(p), /hashes/); } finally { rmSync(root, { recursive: true, force: true }); }
});
test("verified cached release stages exact JAR and POM and is inode-idempotent", { skip: !cached || !cachedPom }, () => {
  const root = fixture(); try {
    assert.equal(stageVerifiedKotlinCompiler(cached, root), root); const jar = kotlinCompilerArtifactPath(root); verifyKotlinCompilerJar(jar); const inode = lstatSync(jar).ino;
    stageVerifiedKotlinCompilerPom(cachedPom, root); verifyKotlinCompilerPom(kotlinCompilerPomPath(root));
    assert.equal(fetchAndroidKotlinCompiler(root), root); assert.equal(stageVerifiedKotlinCompiler(cached, root), root); assert.equal(lstatSync(jar).ino, inode);
    assert.deepEqual(readdirSync(join(jar, "..")), ["kotlin-compiler-embeddable-2.3.21.jar", "kotlin-compiler-embeddable-2.3.21.pom"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("corrupted cached source never publishes a destination", { skip: !cached }, () => {
  const root = fixture(); try { const source = join(root, "source.jar"); copyFileSync(cached, source); const bytes = readFileSync(source); bytes[0] ^= 1; writeFileSync(source, bytes); const maven = join(root, "m2"); assert.throws(() => stageVerifiedKotlinCompiler(source, maven), /hashes/); assert.equal(readdirSync(root).includes("m2"), false); } finally { rmSync(root, { recursive: true, force: true }); }
});

test("POM transfer has a fixed official URL, exact bounds and immutable hash", () => {
  const args = kotlinPomDownloadInvocation("/owned/compiler.pom");
  assert.equal(KOTLIN_POM_URL, "https://repo.maven.apache.org/maven2/org/jetbrains/kotlin/kotlin-compiler-embeddable/2.3.21/kotlin-compiler-embeddable-2.3.21.pom");
  assert.equal(args.filter(x => x.startsWith("https://")).length, 1);
  assert.ok(args.includes(KOTLIN_POM_URL)); assert.equal(args[args.indexOf("--max-filesize") + 1], String(KOTLIN_POM_BYTES));
  assert.equal(KOTLIN_POM_SHA256, "9523c8feadcb17f42d04ffa97fe2a9c08e5db18f090f6db903dca5c36c7ae5c4");
});
test("POM corruption and symlinks fail closed without overwriting the target", { skip: !cachedPom }, () => {
  const root = fixture(); try {
    const source = join(root, "wrong.pom"); const data = readFileSync(cachedPom); data[0] ^= 1; writeFileSync(source, data);
    assert.throws(() => stageVerifiedKotlinCompilerPom(source, join(root, "m2")), /hash/);
    const link = join(root, "link.pom"); symlinkSync(cachedPom, link);
    assert.throws(() => stageVerifiedKotlinCompilerPom(link, join(root, "m2")), /size or file type/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
