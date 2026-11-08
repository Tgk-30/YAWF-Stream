import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
}

android {
    namespace = "com.yawf.consentfocusfixture"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.yawf.consentfocusfixture"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "0.0.1-test-only"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField(
            "String",
            "UPDATER_SOURCE_SHA256",
            "\"689275dd62813f589013519d783316e7bb27260cf98a49b6c879ff7abefa027f\"",
        )
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
        kotlin.directories.add("build/generated/updater")
    }

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
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:core:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}
