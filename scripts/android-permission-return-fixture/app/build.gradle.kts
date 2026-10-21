import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
}

val fixtureTestBuildType = providers.gradleProperty("fixtureTestBuildType")
    .orElse("debug")

android {
    namespace = "com.yawf.permissionreturnfixture"
    compileSdk = 36
    testBuildType = fixtureTestBuildType.get()

    defaultConfig {
        applicationId = "com.yawf.permissionreturnfixture"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "0.0.1-fixture"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField(
            "String",
            "UPDATER_SOURCE_SHA256",
            "\"bf42027e5f1aa0715d51ef68b87f4c6c209173465613896357071eebc599b565\"",
        )
        buildConfigField("boolean", "OMIT_PERMISSION_RETURN_ON_RESUME", "false")
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
        }
        create("negativeControl") {
            initWith(getByName("debug"))
            matchingFallbacks += listOf("debug")
            buildConfigField("boolean", "OMIT_PERMISSION_RETURN_ON_RESUME", "true")
        }
    }

    buildFeatures {
        buildConfig = true
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
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}
