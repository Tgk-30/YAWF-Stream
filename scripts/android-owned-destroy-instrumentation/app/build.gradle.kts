import java.security.MessageDigest

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

android {
    namespace = "com.yawf.ownedstartupinstrumentation"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.yawf.ownedstartupinstrumentation"
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
    // Plugin's public API signatures mention AppCompatActivity. Keep this
    // ordinary AndroidX dependency in the instrumentation APK, never compileOnly.
    androidTestImplementation("androidx.appcompat:appcompat:1.6.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:core:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("junit:junit:4.13.2")
}

tasks.named("preBuild").configure {
    dependsOn(verifyTauriApiInput)
}
