import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
}

val targetSha256 = providers.gradleProperty("successTargetSha256")
    .orElse("PIN_REQUIRED_SUCCESS_TARGET_SHA256")
val targetSize = providers.gradleProperty("successTargetSize")
    .orElse("-1")

android {
    namespace = "com.yawf.permissionreturnfixture"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.yawf.permissionreturnfixture"
        minSdk = 24
        targetSdk = 36
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "UPDATER_SOURCE_SHA256", "\"bf42027e5f1aa0715d51ef68b87f4c6c209173465613896357071eebc599b565\"")
        buildConfigField("boolean", "OMIT_PERMISSION_RETURN_ON_RESUME", "false")
        buildConfigField("String", "SUCCESS_TARGET_SHA256", "\"${targetSha256.get()}\"")
        buildConfigField("long", "SUCCESS_TARGET_SIZE", "${targetSize.get()}L")
    }

    flavorDimensions += "fixtureVersion"
    productFlavors {
        create("baseline") {
            dimension = "fixtureVersion"
            versionCode = 90_000_001
            versionName = "90.0.1"
            buildConfigField("boolean", "SUCCESS_BASELINE", "true")
        }
        create("target") {
            dimension = "fixtureVersion"
            versionCode = 90_000_002
            versionName = "90.0.2"
            buildConfigField("boolean", "SUCCESS_BASELINE", "false")
        }
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        buildConfig = true
    }

    sourceSets.getByName("main") {
        java.directories.add("../app/src/main/java")
        kotlin.directories.add("../app/src/main/java")
    }
    sourceSets.getByName("baseline").assets.directories.add(
        "build/generated/successBaselineAssets",
    )

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

dependencies {
    implementation("androidx.core:core:1.17.0")
}
