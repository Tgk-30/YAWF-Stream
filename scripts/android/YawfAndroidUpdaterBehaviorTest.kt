package com.tgk30.debridstreamer

import android.app.Activity
import android.app.DownloadManager
import android.os.Environment
import java.io.File
import java.lang.reflect.InvocationTargetException
import java.security.MessageDigest
import java.nio.file.Files
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import sun.misc.Unsafe

private const val PACKAGE_NAME = "com.tgk30.debridstreamer"
private const val TAG = "android-v2.3.15"
private const val VERSION = "2.3.15"
private const val APK_NAME = "YAWF.Stream_Android_2.3.15.apk"
private val HASH = "b".repeat(64)

private fun sha256(bytes: ByteArray): String =
  MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }

private class TestActivity : Activity() {
  companion object {
    lateinit var internalRoot: File
    lateinit var externalRoot: File
  }

  override fun getPackageName(): String = PACKAGE_NAME
  override fun getFilesDir(): File = internalRoot
  override fun getExternalFilesDir(type: String?): File = File(externalRoot, type ?: "")
}

private class RecordingFuture : Future<Any?> {
  var cancelled = false
  var interruptRequested = false

  override fun cancel(mayInterruptIfRunning: Boolean): Boolean {
    cancelled = true
    interruptRequested = mayInterruptIfRunning
    return true
  }

  override fun isCancelled(): Boolean = cancelled
  override fun isDone(): Boolean = cancelled
  override fun get(): Any? = null
  override fun get(timeout: Long, unit: TimeUnit): Any? = null
}

private object Subject {
  private val unsafe: Unsafe =
    Unsafe::class.java.getDeclaredField("theUnsafe").let {
      it.isAccessible = true
      it.get(null) as Unsafe
    }
  private val type = YawfAndroidUpdater::class.java
  val updater: Any = unsafe.allocateInstance(type)

  init {
    val activity = unsafe.allocateInstance(TestActivity::class.java)
    set("activity", activity)
  }

  fun invoke(name: String, vararg arguments: Any?): Any? {
    val method =
      type.declaredMethods.singleOrNull { it.name == name && it.parameterCount == arguments.size }
        ?: error("No unique method $name/${arguments.size}")
    method.isAccessible = true
    return try {
      method.invoke(updater, *arguments)
    } catch (failure: InvocationTargetException) {
      throw failure.targetException
    }
  }

  fun get(name: String): Any? {
    val field = type.getDeclaredField(name)
    field.isAccessible = true
    return field.get(updater)
  }

  fun set(name: String, value: Any?) {
    val field = type.getDeclaredField(name)
    field.isAccessible = true
    unsafe.putObject(updater, unsafe.objectFieldOffset(field), value)
  }

  fun setLong(name: String, value: Long) {
    val field = type.getDeclaredField(name)
    field.isAccessible = true
    unsafe.putLong(updater, unsafe.objectFieldOffset(field), value)
  }

  fun constructNested(simpleName: String, vararg arguments: Any?): Any {
    val nested = type.declaredClasses.single { it.simpleName == simpleName }
    val constructor = nested.declaredConstructors.single { it.parameterCount == arguments.size }
    constructor.isAccessible = true
    return constructor.newInstance(*arguments)
  }
}

private fun release(
  tag: String = TAG,
  draft: Boolean = false,
  prerelease: Boolean = false,
  digest: String? = "sha256:$HASH",
  apkSize: String = "42000000",
  manifestCount: Int = 1,
  apkCount: Int = 1,
  manifestUrl: String = "https://github.com/Tgk-30/YAWF-Stream/releases/download/$TAG/android-update.json",
  apkUrl: String = "https://github.com/Tgk-30/YAWF-Stream/releases/download/$TAG/$APK_NAME",
): JSONObject {
  val assets = mutableListOf<String>()
  repeat(manifestCount) {
    assets += """{"name":"android-update.json","browser_download_url":"$manifestUrl"}"""
  }
  repeat(apkCount) {
    val digestMember = if (digest == null) "" else ",\"digest\":\"$digest\""
    assets += """{"name":"$APK_NAME","browser_download_url":"$apkUrl","size":$apkSize$digestMember}"""
  }
  return JSONObject(
    """{"draft":$draft,"prerelease":$prerelease,"tag_name":"$tag","assets":[${assets.joinToString(",")}]}""",
  )
}

private fun manifest(
  version: String = VERSION,
  versionCode: String = "2003015",
  packageName: String = PACKAGE_NAME,
  name: String = APK_NAME,
  sha256: String = HASH,
  size: String = "42000000",
  extra: String = "",
): ByteArray =
  """{"schemaVersion":1,"version":"$version","versionCode":$versionCode,"packageName":"$packageName","sourceRevision":"${"a".repeat(40)}","apk":{"name":"$name","sha256":"$sha256","size":$size}$extra}"""
    .toByteArray(Charsets.UTF_8)

private fun releaseAssets(value: JSONObject): Any? = Subject.invoke("releaseAssets", value)

private fun candidate(bytes: ByteArray = manifest(), release: Any = releaseAssets(release())!!): Any =
  Subject.invoke("parseManifest", bytes, release) ?: error("Expected candidate")

private fun property(value: Any, name: String): Any? {
  val getter = value.javaClass.declaredMethods.single { it.name == "get${name.replaceFirstChar(Char::uppercase)}" }
  getter.isAccessible = true
  return getter.invoke(value)
}

private var assertions = 0

private fun expectRejected(label: String, block: () -> Unit) {
  try {
    block()
    error("$label was accepted")
  } catch (failure: Throwable) {
    if (failure is IllegalStateException && failure.message == "$label was accepted") throw failure
    check(failure.javaClass.simpleName == "UpdaterFailure") {
      "$label failed with ${failure.javaClass.name}: ${failure.message}"
    }
    assertions += 1
  }
}

private fun assertThat(condition: Boolean, label: String) {
  check(condition) { label }
  assertions += 1
}

private fun testValidReleaseAndManifest() {
  val parsedRelease = releaseAssets(release()) ?: error("valid release was ignored")
  val parsedCandidate = candidate(release = parsedRelease)
  assertThat(property(parsedRelease, "tag") == TAG, "release tag")
  assertThat(property(parsedRelease, "version") == VERSION, "release version")
  assertThat(property(parsedCandidate, "versionCode") == 2_003_015L, "manifest versionCode")
  assertThat(property(parsedCandidate, "packageName") == PACKAGE_NAME, "manifest package")
  assertThat(property(parsedCandidate, "sha256") == HASH, "manifest hash")
  assertThat(property(parsedCandidate, "size") == 42_000_000L, "manifest size")
}

private fun testReleaseFilteringAndBinding() {
  assertThat(releaseAssets(release(draft = true)) == null, "draft ignored")
  assertThat(releaseAssets(release(prerelease = true)) == null, "prerelease ignored")
  assertThat(releaseAssets(release(tag = "v2.3.15")) == null, "wrong tag channel ignored")
  expectRejected("duplicate manifest asset") { releaseAssets(release(manifestCount = 2)) }
  expectRejected("duplicate APK asset") { releaseAssets(release(apkCount = 2)) }
  expectRejected("invalid API APK size") { releaseAssets(release(apkSize = "0")) }
  expectRejected("invalid API APK digest") { releaseAssets(release(digest = "sha256:${"B".repeat(64)}")) }
  expectRejected("wrong manifest repository") {
    releaseAssets(
      release(manifestUrl = "https://github.com/attacker/YAWF-Stream/releases/download/$TAG/android-update.json"),
    )
  }
  expectRejected("wrong APK tag") {
    releaseAssets(
      release(apkUrl = "https://github.com/Tgk-30/YAWF-Stream/releases/download/android-v9.9.9/$APK_NAME"),
    )
  }
  val withoutDigest = releaseAssets(release(digest = null)) ?: error("digest-optional release ignored")
  assertThat(property(candidate(release = withoutDigest), "releaseDigest") == null, "strict manifest channel permits absent API digest")
  expectRejected("duplicate release API field") {
    Subject.invoke(
      "parseJsonArray",
      """[{"draft":false,"draft":false,"prerelease":false,"tag_name":"$TAG","assets":[]}]"""
        .toByteArray(),
    )
  }
}

private fun testStrictManifest() {
  val parsedRelease = releaseAssets(release())!!
  expectRejected("literal duplicate key scanner") {
    Subject.invoke("rejectDuplicateJsonKeys", "{\"version\":1,\"version\":1}")
  }
  expectRejected("escaped duplicate key scanner") {
    Subject.invoke("rejectDuplicateJsonKeys", "{\"version\":1,\"\\u0076ersion\":1}")
  }
  expectRejected("duplicate literal manifest key") {
    candidate(
      """{"schemaVersion":1,"version":"$VERSION","version":"$VERSION","versionCode":2003015,"packageName":"$PACKAGE_NAME","apk":{"name":"$APK_NAME","sha256":"$HASH","size":42000000}}"""
        .toByteArray(),
      parsedRelease,
    )
  }
  expectRejected("duplicate escaped manifest key") {
    candidate(
      """{"schemaVersion":1,"version":"$VERSION","\u0076ersion":"$VERSION","versionCode":2003015,"packageName":"$PACKAGE_NAME","apk":{"name":"$APK_NAME","sha256":"$HASH","size":42000000}}"""
        .toByteArray(),
      parsedRelease,
    )
  }
  expectRejected("wrong package") { candidate(manifest(packageName = "com.attacker.app"), parsedRelease) }
  expectRejected("version and tag mismatch") { candidate(manifest(version = "2.3.16"), parsedRelease) }
  expectRejected("zero version code") { candidate(manifest(versionCode = "0"), parsedRelease) }
  expectRejected("version code inconsistent with version") { candidate(manifest(versionCode = "20315"), parsedRelease) }
  expectRejected("fractional version code") { candidate(manifest(versionCode = "2003015.0"), parsedRelease) }
  expectRejected("exponent version code") { candidate(manifest(versionCode = "2003015e0"), parsedRelease) }
  expectRejected("string version code") { candidate(manifest(versionCode = "\"2003015\""), parsedRelease) }
  expectRejected("version code outside Android range") {
    candidate(manifest(versionCode = "2147483648"), parsedRelease)
  }
  expectRejected("unexpected manifest field") { candidate(manifest(extra = ",\"url\":\"https://evil.invalid\""), parsedRelease) }
  expectRejected("wrong APK name") { candidate(manifest(name = "update.apk"), parsedRelease) }
  expectRejected("uppercase APK hash") { candidate(manifest(sha256 = "B".repeat(64)), parsedRelease) }
  expectRejected("zero APK size") { candidate(manifest(size = "0"), parsedRelease) }
  expectRejected("oversized APK") { candidate(manifest(size = (160L * 1024L * 1024L + 1L).toString()), parsedRelease) }
  expectRejected("release and manifest size mismatch") { candidate(manifest(size = "41999999"), parsedRelease) }
  val mismatchedApiSize = releaseAssets(release(apkSize = "41999999"))!!
  expectRejected("API and manifest size mismatch") { candidate(manifest(), mismatchedApiSize) }
  val mismatchedDigest = releaseAssets(release(digest = "sha256:${"c".repeat(64)}"))!!
  expectRejected("release and manifest hash mismatch") { candidate(manifest(), mismatchedDigest) }
  val unsupportedVersion = "2.1000.1"
  val unsupportedName = "YAWF.Stream_Android_$unsupportedVersion.apk"
  val unsupportedRelease =
    releaseAssets(
      JSONObject(
        """{"draft":false,"prerelease":false,"tag_name":"android-v$unsupportedVersion","assets":[{"name":"android-update.json","browser_download_url":"https://github.com/Tgk-30/YAWF-Stream/releases/download/android-v$unsupportedVersion/android-update.json"},{"name":"$unsupportedName","browser_download_url":"https://github.com/Tgk-30/YAWF-Stream/releases/download/android-v$unsupportedVersion/$unsupportedName","size":42000000,"digest":"sha256:$HASH"}]}""",
      ),
    )!!
  expectRejected("version component outside code formula") {
    candidate(
      manifest(version = unsupportedVersion, versionCode = "3000001", name = unsupportedName),
      unsupportedRelease,
    )
  }
}

private fun testReplayAndDownloadState() {
  assertThat(Subject.invoke("isVersionCodeUpgrade", 2_003_015L, 2_003_014L) == true, "upgrade accepted")
  assertThat(Subject.invoke("isVersionCodeUpgrade", 2_003_015L, 2_003_015L) == false, "replay rejected")
  assertThat(Subject.invoke("isVersionCodeUpgrade", 2_003_014L, 2_003_015L) == false, "downgrade rejected")
  assertThat(Subject.invoke("isVersionCodeUpgrade", Int.MAX_VALUE.toLong() + 1L, 1L) == false, "out of range code rejected")
  assertThat(Subject.invoke("downloadNeedsPolling", DownloadManager.STATUS_PENDING) == true, "pending polls")
  assertThat(Subject.invoke("downloadNeedsPolling", DownloadManager.STATUS_RUNNING) == true, "running polls")
  assertThat(Subject.invoke("downloadNeedsPolling", DownloadManager.STATUS_PAUSED) == true, "paused polls")
  assertThat(Subject.invoke("downloadNeedsPolling", DownloadManager.STATUS_SUCCESSFUL) == false, "success stops polling")
  assertThat(Subject.invoke("downloadNeedsPolling", DownloadManager.STATUS_FAILED) == false, "failure stops polling")
}

private fun testReleaseHistoryBounds() {
  val oneMiB = 1024 * 1024
  assertThat(Subject.invoke("checkedReleaseHistoryBytes", 0, oneMiB) == oneMiB, "one bounded page")
  assertThat(
    Subject.invoke("checkedReleaseHistoryBytes", 7 * oneMiB, oneMiB) == 8 * oneMiB,
    "aggregate limit accepted",
  )
  expectRejected("aggregate release byte overflow") {
    Subject.invoke("checkedReleaseHistoryBytes", 8 * oneMiB, 1)
  }
  expectRejected("single release page overflow") {
    Subject.invoke("checkedReleaseHistoryBytes", 0, oneMiB + 1)
  }
  assertThat(Subject.invoke("releaseHistoryEnded", 19) == true, "short page ends search")
  assertThat(Subject.invoke("releaseHistoryEnded", 20) == false, "full page requires another page")
}

private fun testCadenceAndReadinessPolicy() {
  val day = 24L * 60L * 60L * 1000L
  val now = 10L * day
  assertThat(Subject.invoke("automaticCheckIsDueAt", 0L, 0L, now) == true, "never checked is due")
  assertThat(Subject.invoke("automaticCheckIsDueAt", now - day, 0L, now) == false, "recent success is not due")
  assertThat(Subject.invoke("automaticCheckIsDueAt", now - 7L * day, 0L, now) == true, "weekly success is due")
  assertThat(
    Subject.invoke("automaticCheckIsDueAt", 0L, now + 6L * 60L * 60L * 1000L, now) == false,
    "bounded failure backoff delays",
  )
  assertThat(
    Subject.invoke("automaticCheckIsDueAt", 0L, now + 6L * 60L * 60L * 1000L + 1L, now) == true,
    "corrupt long backoff cannot suppress checks",
  )
  assertThat(Subject.invoke("automaticCheckIsDueAt", now + day, 0L, now) == true, "clock rollback retries")
  assertThat(Subject.invoke("shouldRetryReadiness", 19, true, false) == true, "readiness retry bounded")
  assertThat(Subject.invoke("shouldRetryReadiness", 20, true, false) == false, "readiness retry stops")
  assertThat(Subject.invoke("shouldRetryReadiness", 1, false, false) == false, "background stops readiness")
  assertThat(Subject.invoke("shouldRetryReadiness", 1, true, true) == false, "destroyed stops readiness")
}

private fun testPrivateStagingContent() {
  val root = Files.createTempDirectory("yawf-updater-behavior").toFile()
  try {
    TestActivity.internalRoot = File(root, "internal").apply { mkdirs() }
    TestActivity.externalRoot = File(root, "external").apply { mkdirs() }
    val payload = "signed-apk-fixture-content".toByteArray()
    val digest = sha256(payload)
    val parsedRelease = releaseAssets(release(digest = "sha256:$digest", apkSize = payload.size.toString()))!!
    val parsedCandidate =
      candidate(
        manifest(sha256 = digest, size = payload.size.toString()),
        parsedRelease,
      )
    val external = Subject.invoke("downloadFile", parsedCandidate) as File
    val staged = Subject.invoke("stagedFile", parsedCandidate) as File
    val temporary = Subject.invoke("stagedTemporaryFile", parsedCandidate) as File
    external.parentFile!!.mkdirs()
    temporary.parentFile!!.mkdirs()
    external.writeBytes(payload)
    Subject.invoke("copyAndHashToInternal", parsedCandidate, external, temporary)
    Subject.invoke("verifyStagedContent", parsedCandidate, temporary)
    assertThat(external.canonicalPath.startsWith(TestActivity.externalRoot.canonicalPath), "download remains external")
    assertThat(staged.canonicalPath.startsWith(TestActivity.internalRoot.canonicalPath), "installer target is internal")
    assertThat(temporary.readBytes().contentEquals(payload), "bounded copy preserves bytes")
    external.writeText("attacker changed external file")
    Subject.invoke("verifyStagedContent", parsedCandidate, temporary)
    assertThat(temporary.readBytes().contentEquals(payload), "external mutation cannot change private copy")
    external.writeBytes(ByteArray(payload.size) { 0x33 })
    expectRejected("external copy hash mismatch") {
      Subject.invoke("copyAndHashToInternal", parsedCandidate, external, temporary)
    }
    temporary.writeBytes(ByteArray(payload.size) { 0x5a })
    expectRejected("private staged content mutation") {
      Subject.invoke("verifyStagedContent", parsedCandidate, temporary)
    }
  } finally {
    root.deleteRecursively()
  }
}

private fun testOrphanDownloadIdentity() {
  val parsedCandidate = candidate()
  val source = "https://release-assets.githubusercontent.com/private-object"
  val sourceHash = Subject.invoke("sha256Text", source) as String
  fun row(uri: String?, title: String = "YAWF Stream $VERSION"): Any =
    Subject.constructNested(
      "DownloadRow",
      77L,
      DownloadManager.STATUS_RUNNING,
      1L,
      42_000_000L,
      null,
      uri,
      title,
    )
  assertThat(
    Subject.invoke("orphanRowMatches", parsedCandidate, sourceHash, row(source)) == true,
    "matching orphan job recovers",
  )
  assertThat(
    Subject.invoke("orphanRowMatches", parsedCandidate, "c".repeat(64), row(source)) == false,
    "wrong orphan URL hash rejected",
  )
  assertThat(
    Subject.invoke("orphanRowMatches", parsedCandidate, sourceHash, row(source, "Other")) == false,
    "wrong orphan title rejected",
  )
}

private fun testRedirectPolicy() {
  Subject.invoke(
    "requireOfficialAssetUrl",
    "https://github.com/Tgk-30/YAWF-Stream/releases/download/$TAG/$APK_NAME",
    TAG,
    APK_NAME,
  )
  expectRejected("official URL query") {
    Subject.invoke(
      "requireOfficialAssetUrl",
      "https://github.com/Tgk-30/YAWF-Stream/releases/download/$TAG/$APK_NAME?x=1",
      TAG,
      APK_NAME,
    )
  }
  expectRejected("lookalike official host") {
    Subject.invoke(
      "requireOfficialAssetUrl",
      "https://github.com.evil.invalid/Tgk-30/YAWF-Stream/releases/download/$TAG/$APK_NAME",
      TAG,
      APK_NAME,
    )
  }
  Subject.invoke("requireAllowedRedirect", "https://release-assets.githubusercontent.com/path?token=opaque")
  Subject.invoke("requireAllowedRedirect", "https://objects.githubusercontent.com/path")
  expectRejected("HTTP redirect") { Subject.invoke("requireAllowedRedirect", "http://release-assets.githubusercontent.com/path") }
  expectRejected("userinfo redirect") { Subject.invoke("requireAllowedRedirect", "https://user@release-assets.githubusercontent.com/path") }
  expectRejected("redirect fragment") { Subject.invoke("requireAllowedRedirect", "https://release-assets.githubusercontent.com/path#fragment") }
  expectRejected("redirect lookalike host") { Subject.invoke("requireAllowedRedirect", "https://release-assets.githubusercontent.com.evil.invalid/path") }
  Subject.invoke("requireFinalDownloadHost", "https://release-assets.githubusercontent.com/path")
  expectRejected("GitHub is not a final APK host") { Subject.invoke("requireFinalDownloadHost", "https://github.com/path") }
}

private fun testCancellationInvalidatesResults() {
  val future = RecordingFuture()
  Subject.setLong("operationSerial", 41L)
  Subject.set("operationFuture", future)
  val operationType = Class.forName("com.tgk30.debridstreamer.YawfAndroidUpdater\$Operation")
  Subject.set("operation", operationType.enumConstants.first())
  Subject.invoke("cancelOperation")
  assertThat(future.cancelled && future.interruptRequested, "worker cancellation interrupts")
  assertThat(Subject.get("operationSerial") == 42L, "result generation invalidated")
  assertThat(Subject.get("operationFuture") == null, "future reference cleared")
  assertThat(Subject.get("operation") == null, "operation state cleared")
}

private fun testPendingInstallerLaunchPolicy() {
  fun mayLaunch(
    foreground: Boolean = true,
    ready: Boolean = true,
    activeOperation: Boolean = false,
    resumeMatches: Boolean = true,
    phase: Int = 3,
    candidateMatches: Boolean = true,
    fileMatches: Boolean = true,
    upgradeStillValid: Boolean = true,
  ): Boolean =
    Subject.invoke(
      "pendingInstallerMayLaunch",
      foreground,
      ready,
      activeOperation,
      resumeMatches,
      phase,
      candidateMatches,
      fileMatches,
      upgradeStillValid,
    ) as Boolean

  assertThat(!mayLaunch(ready = false), "delayed focus cannot launch installer")
  assertThat(mayLaunch(ready = true), "restored focus permits verified installer launch")
  assertThat(!mayLaunch(activeOperation = true), "active operation blocks installer launch")
  assertThat(!mayLaunch(foreground = false), "background callback cannot launch installer")
  assertThat(!mayLaunch(resumeMatches = false), "a prior foreground result cannot launch after resume")
  assertThat(!mayLaunch(phase = 2), "non-staged phase cannot launch installer")
  assertThat(!mayLaunch(candidateMatches = false), "persisted candidate mismatch blocks installer")
  assertThat(!mayLaunch(fileMatches = false), "private staged file mismatch blocks installer")
  assertThat(!mayLaunch(upgradeStillValid = false), "obsolete verified candidate cannot launch installer")
}

fun main() {
  testValidReleaseAndManifest()
  testReleaseFilteringAndBinding()
  testStrictManifest()
  testReplayAndDownloadState()
  testReleaseHistoryBounds()
  testCadenceAndReadinessPolicy()
  testPrivateStagingContent()
  testOrphanDownloadIdentity()
  testRedirectPolicy()
  testCancellationInvalidatesResults()
  testPendingInstallerLaunchPolicy()
  println("YawfAndroidUpdater behavior assertions passed: $assertions")
}
