# Kotlin compiler metadata

This directory includes the unmodified
[JetBrains Kotlin 2.3.21 compiler POM from Maven Central](https://repo.maven.apache.org/maven2/org/jetbrains/kotlin/kotlin-compiler-embeddable/2.3.21/kotlin-compiler-embeddable-2.3.21.pom)
and its Apache 2.0 license. The Android build helper verifies the POM's
published release pin, including its 2,451-byte length and SHA-256, before
creating the isolated Gradle repository.

No compiler binary is vendored. The JAR still uses the fixed upstream
download sources and must pass both existing release hash checks.
