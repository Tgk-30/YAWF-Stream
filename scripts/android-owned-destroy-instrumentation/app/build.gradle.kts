import java.io.File
import java.security.MessageDigest
import java.util.zip.ZipFile
import org.gradle.api.attributes.Category
import org.gradle.api.attributes.Usage

plugins {
    id("com.android.application")
}

val apiClassesJar = providers.gradleProperty("tauriAndroidApiClassesJar")
    .orElse(providers.environmentVariable("TAURI_ANDROID_API_CLASSES_JAR"))
    .orNull?.let(::file)
    ?: throw GradleException("TAURI_ANDROID_API_CLASSES_JAR_REQUIRED")
val apiClassesJarSha256 = providers.gradleProperty("tauriAndroidApiClassesJarSha256")
    .orElse(providers.environmentVariable("TAURI_ANDROID_API_CLASSES_JAR_SHA256"))
    .orNull
    ?: throw GradleException("TAURI_ANDROID_API_CLASSES_JAR_SHA256_REQUIRED")
val apiSourceReceipt = providers.gradleProperty("tauriAndroidApiSourceReceipt")
    .orElse(providers.environmentVariable("TAURI_ANDROID_API_SOURCE_RECEIPT"))
    .orNull?.let(::file)
    ?: throw GradleException("TAURI_ANDROID_API_SOURCE_RECEIPT_REQUIRED")

val verifyTauriApiInput = tasks.register("verifyTauriAndroidApiInput") {
    inputs.file(apiClassesJar)
    inputs.file(apiSourceReceipt)
    doLast {
        require(apiClassesJar.isFile && !apiClassesJar.isDirectory) { "TAURI_ANDROID_API_CLASSES_JAR_NOT_FILE" }
        require(apiSourceReceipt.isFile) { "TAURI_ANDROID_API_SOURCE_RECEIPT_NOT_FILE" }
        require(apiClassesJarSha256.matches(Regex("[a-f0-9]{64}"))) { "TAURI_ANDROID_API_SHA256_INVALID" }
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(apiClassesJar.readBytes()).joinToString("") { "%02x".format(it) }
        require(digest == apiClassesJarSha256) { "TAURI_ANDROID_API_CLASSES_JAR_HASH_MISMATCH" }

        val receipt = groovy.json.JsonSlurper().parse(apiSourceReceipt) as? Map<*, *>
            ?: throw GradleException("TAURI_ANDROID_API_SOURCE_RECEIPT_INVALID")
        require(receipt["schemaVersion"] == 1) { "TAURI_ANDROID_API_SOURCE_RECEIPT_SCHEMA" }
        require(receipt["crateName"] == "tauri" && receipt["crateVersion"] == "2.12.4") {
            "TAURI_ANDROID_API_SOURCE_VERSION_MISMATCH"
        }
        require(receipt["crateChecksum"] == "f316751027fc2644221d1a448564d519efb07067fda584879d9cda966391d212") {
            "TAURI_ANDROID_API_CRATE_CHECKSUM_MISMATCH"
        }
        require(receipt["classesJarSha256"] == digest) { "TAURI_ANDROID_API_RECEIPT_JAR_HASH_MISMATCH" }
        val files = receipt["sourceFiles"] as? Map<*, *>
            ?: throw GradleException("TAURI_ANDROID_API_SOURCE_FILES_MISSING")
        val expected = mapOf(
            "Cargo.toml" to "0226bd683231ce3d1599d504ac85bbec1250ae2ff16078ed00f17ecb3fe62683",
            "mobile/android/build.gradle.kts" to "7cd902e29c3d5e495600f98669fb67a2b7983d58e69e627fc7d8778be58802d4",
            "mobile/android/src/main/java/app/tauri/plugin/Plugin.kt" to "c5dc0d1b59ac2024399afd0893f1182ae583b4d4f2cc88a5ba7864d365f77f7c",
            "mobile/android/src/main/java/app/tauri/plugin/PluginManager.kt" to "053958be1e83d8633d26348ded26bbd6d4ab21121e662985194fa3342eef1e95",
            "mobile/android/src/main/java/app/tauri/plugin/PluginHandle.kt" to "628b69f19d03b861765a2f7f3140e5b6a79bd991966019bb250bf7ae79bfd301",
        )
        require(files == expected) { "TAURI_ANDROID_API_SOURCE_HASHES_MISMATCH" }
        require(receipt["buildEnvironment"] is String && (receipt["buildEnvironment"] as String).isNotBlank()) {
            "TAURI_ANDROID_API_BUILD_PROVENANCE_MISSING"
        }
    }
}

// Resolve public signatures separately from every app/test runtime classpath.
val publicApiSignatures = configurations.create("ownedPublicApiSignatures") {
    isCanBeResolved = true
    isCanBeConsumed = false
    isTransitive = true
    attributes {
        attribute(Category.CATEGORY_ATTRIBUTE, objects.named(Category.LIBRARY))
        attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage.JAVA_RUNTIME))
    }
    resolutionStrategy {
        failOnDynamicVersions()
        failOnChangingVersions()
    }
}
val signatureDirectory = layout.buildDirectory.dir("owned-public-api-signatures")
val signatureReceipt = signatureDirectory.map { it.file("public-api-signatures.json") }
val signatureArtifacts = providers.provider {
    publicApiSignatures.resolvedConfiguration.resolvedArtifacts.sortedBy {
        "${it.moduleVersion.id}:${it.name}:${it.classifier.orEmpty()}"
    }
}

fun signatureSha256(input: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    input.inputStream().use { stream ->
        val buffer = ByteArray(65_536)
        while (true) {
            val count = stream.read(buffer)
            if (count < 0) break
            digest.update(buffer, 0, count)
        }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

fun signatureEntries(input: File): List<String> = when (input.extension.lowercase()) {
    "jar" -> listOf("")
    "aar" -> ZipFile(input).use { archive ->
        val entries = archive.entries().asSequence().filter { entry ->
            !entry.isDirectory && (entry.name == "classes.jar" || Regex("libs/[A-Za-z0-9_.-]+\\.jar").matches(entry.name))
        }.map { it.name }.toList()
        require(entries.size == entries.distinct().size) { "PUBLIC_SIGNATURE_DUPLICATE_JAR_ENTRY" }
        entries.sorted()
    }
    else -> throw GradleException("PUBLIC_SIGNATURE_ARTIFACT_NOT_JAR_OR_AAR")
}

fun signatureJar(input: File, entry: String): File = signatureDirectory.get().asFile.resolve(
    "${signatureSha256(input)}-${if (entry.isEmpty()) "artifact.jar" else entry.replace('/', '_')}"
)

val signatureJarFiles = signatureArtifacts.map { artifacts ->
    artifacts.flatMap { artifact -> signatureEntries(artifact.file).map { signatureJar(artifact.file, it) } }
}
val extractPublicApiSignatureJars = tasks.register("extractPublicApiSignatureJars") {
    dependsOn(verifyTauriApiInput)
    inputs.files(publicApiSignatures)
    outputs.files(signatureJarFiles)
    outputs.file(signatureReceipt)
    doLast {
        val directory = signatureDirectory.get().asFile
        require(directory.isDirectory || directory.mkdirs()) { "PUBLIC_SIGNATURE_OUTPUT_DIRECTORY" }
        val artifacts = signatureArtifacts.get().map { artifact ->
            val input = artifact.file
            val jars = signatureEntries(input).map { entry ->
                val output = signatureJar(input, entry)
                if (entry.isEmpty()) {
                    input.copyTo(output, overwrite = true)
                } else {
                    ZipFile(input).use { archive ->
                        val jar = archive.getEntry(entry)
                        require(jar.size in 1..(64L * 1024 * 1024)) { "PUBLIC_SIGNATURE_JAR_SIZE" }
                        archive.getInputStream(jar).use { stream ->
                            output.outputStream().use { stream.copyTo(it) }
                        }
                    }
                }
                mapOf("entry" to entry, "file" to output.name, "sha256" to signatureSha256(output))
            }
            mapOf("component" to artifact.moduleVersion.id.toString(), "artifact" to input.name,
                "artifactSha256" to signatureSha256(input), "jars" to jars)
        }
        require(signatureJarFiles.get().isNotEmpty()) { "PUBLIC_SIGNATURE_JARS_MISSING" }
        signatureReceipt.get().asFile.writeText(groovy.json.JsonOutput.prettyPrint(groovy.json.JsonOutput.toJson(
            mapOf("schemaVersion" to 1, "scope" to "PUBLIC_COMPILE_ONLY_SIGNATURES_NO_RUNTIME_COPIES",
                "rootDependency" to "androidx.appcompat:appcompat:1.6.0", "artifacts" to artifacts)
        )) + "\n")
    }
}
val publicApiSignatureClasspath = files(signatureJarFiles).builtBy(extractPublicApiSignatureJars)

android {
    // Java-only platform/JUnit harness must not add a Kotlin runtime.
    enableKotlin = false
    namespace = "com.yawf.ownedstartupinstrumentation"
    compileSdk = 36

    defaultConfig {
        // Compile-only empty target model. Never build/install its main APK.
        // AGP derives the binary instrumentation target from this ID, not
        // from the source test-manifest override.
        applicationId = "com.tgk30.debridstreamer"
        testApplicationId = "com.yawf.ownedstartupinstrumentation.test"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0-test-only"
        testInstrumentationRunner = "com.yawf.ownedstartup.OwnedDestroyInstrumentationRunner"
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // This is a checksum-bound JAR of the exact public Tauri Android API, not a
    // packaged AAR. Runtime classes must come from the installed production APK.
    compileOnly(files(apiClassesJar))
    androidTestCompileOnly(files(apiClassesJar))
    // Tauri's public signatures require these types at compile time only.
    add(publicApiSignatures.name, "androidx.appcompat:appcompat:1.6.0")
    androidTestCompileOnly(publicApiSignatureClasspath)
    androidTestImplementation("junit:junit:4.13.2") { isTransitive = false }
    androidTestImplementation("org.hamcrest:hamcrest-core:1.3") { isTransitive = false }
}

tasks.named("preBuild").configure {
    dependsOn(verifyTauriApiInput)
}
