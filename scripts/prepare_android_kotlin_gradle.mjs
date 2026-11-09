#!/usr/bin/env node
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, parse, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyKotlinCompilerRepository, KOTLIN_JAR_BYTES, KOTLIN_JAR_SHA256, KOTLIN_POM_BYTES, KOTLIN_POM_SHA256 } from "./fetch_android_kotlin_compiler.mjs";
const INIT = "yawf-kotlin-compiler.init.gradle";
const fail = () => { throw new Error("A fresh canonical Gradle home without symlinks or unrelated entries is required."); };
export function kotlinGradleInit(root) {
  const encoded = Buffer.from(root, "utf8").toString("base64");
  return `// Fixed official Kotlin compiler only. No remote repository or policy changes.
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardOpenOption
import java.nio.ByteBuffer
import java.security.MessageDigest

def pinnedRoot = new String(Base64.decoder.decode('${encoded}'), 'UTF-8')
def checkPinned = {
    def root = java.nio.file.Paths.get(pinnedRoot)
    def current = root.root
    root.each { part ->
        current = current.resolve(part)
        if (!Files.isDirectory(current, LinkOption.NOFOLLOW_LINKS)) throw new GradleException('Invalid pinned Kotlin repository directory')
    }
    [
        ['kotlin-compiler-embeddable-2.3.21.jar', ${KOTLIN_JAR_BYTES}L, '${KOTLIN_JAR_SHA256}'],
        ['kotlin-compiler-embeddable-2.3.21.pom', ${KOTLIN_POM_BYTES}L, '${KOTLIN_POM_SHA256}']
    ].each { pin ->
        def file = root.resolve('org/jetbrains/kotlin/kotlin-compiler-embeddable/2.3.21/' + pin[0])
        def parent = root
        root.relativize(file.parent).each { part ->
            parent = parent.resolve(part)
            if (!Files.isDirectory(parent, LinkOption.NOFOLLOW_LINKS)) throw new GradleException('Invalid pinned Kotlin repository directory')
        }
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) != pin[1]) throw new GradleException('Invalid pinned Kotlin artifact size or type')
        def digest = MessageDigest.getInstance('SHA-256')
        Files.newByteChannel(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS).withCloseable { channel ->
            def buffer = ByteBuffer.allocate(8192)
            long count = 0
            while (channel.read(buffer) != -1) {
                buffer.flip(); count += buffer.remaining()
                if (count > pin[1]) throw new GradleException('Invalid pinned Kotlin artifact size')
                digest.update(buffer); buffer.clear()
            }
            if (count != pin[1]) throw new GradleException('Invalid pinned Kotlin artifact size')
        }
        if (digest.digest().encodeHex().toString() != pin[2]) throw new GradleException('Invalid pinned Kotlin artifact hash')
    }
}
checkPinned()
gradle.beforeProject { project ->
    checkPinned()
    [project.repositories, project.buildscript.repositories].each { repositories ->
        repositories.exclusiveContent {
            forRepository {
                repositories.maven {
                    name = 'yawfPinnedKotlinCompiler'
                    url = project.uri(pinnedRoot)
                    metadataSources { mavenPom() }
                }
            }
            filter { includeVersion('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '2.3.21') }
        }
    }
}
`;
}
export function prepareAndroidKotlinGradle(root, home) {
  verifyKotlinCompilerRepository(root);
  if (typeof home !== "string" || /[\x00-\x1f\x7f]/.test(home) || !isAbsolute(home) || normalize(home) !== home || home === parse(home).root || home === root || home.startsWith(root + "/") || root.startsWith(home + "/")) fail();
  let current = parse(home).root;
  for (const part of home.slice(current.length).split(/[\\/]/)) {
    current = join(current, part);
    let stat; try { stat = lstatSync(current); } catch (e) { if (e.code !== "ENOENT") throw e; mkdirSync(current); stat = lstatSync(current); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail();
  }
  if (realpathSync(home) !== home) fail();
  if (readdirSync(home).length !== 0) fail();
  const init = join(home, "init.d"); mkdirSync(init);
  writeFileSync(join(init, INIT), kotlinGradleInit(root), { flag: "wx", mode: 0o600 });
  return home;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error("Exactly one canonical Maven root and one fresh canonical Gradle home are required.");
  process.stdout.write(prepareAndroidKotlinGradle(process.argv[2], process.argv[3]) + "\n");
}
