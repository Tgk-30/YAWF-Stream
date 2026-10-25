package com.yawf.permissionreturnfixture

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.widget.TextView
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import org.json.JSONObject

class SuccessFixtureActivity : Activity() {
  private lateinit var androidUpdater: YawfAndroidUpdater
  private lateinit var status: TextView
  private val main = Handler(Looper.getMainLooper())
  private val observeCleanup = object : Runnable {
    override fun run() {
      if (isFinishing || isDestroyed || BuildConfig.SUCCESS_BASELINE) return
      val preferences = getSharedPreferences(FixturePolicy.PREFERENCES_NAME, MODE_PRIVATE)
      val staged = File(File(filesDir, "updates"), TARGET_APK_NAME)
      val canary = File(filesDir, CANARY_NAME)
      val complete =
        canary.isFile && canary.readText(Charsets.UTF_8) == CANARY_VALUE &&
          !staged.exists() &&
          !preferences.contains(FixturePolicy.KEY_DOWNLOAD_CANDIDATE) &&
          preferences.getInt(FixturePolicy.KEY_UPDATE_PHASE, FixturePolicy.PHASE_NONE) ==
            FixturePolicy.PHASE_NONE &&
          !preferences.getBoolean(FixturePolicy.KEY_AWAITING_INSTALL_PERMISSION, false)
      status.text = if (complete) SUCCESS_RECEIPT else "Waiting for updater cleanup"
      if (!complete) main.postDelayed(this, 100L)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    status = TextView(this).apply {
      gravity = Gravity.CENTER
      text = if (BuildConfig.SUCCESS_BASELINE) "Preparing fixture update" else "Checking preserved state"
    }
    setContentView(status)
    if (BuildConfig.SUCCESS_BASELINE) seedBaselineUpdate()
    androidUpdater = YawfAndroidUpdater.attach(this)
  }

  override fun onResume() {
    super.onResume()
    if (::androidUpdater.isInitialized) androidUpdater.onResume()
    if (!BuildConfig.SUCCESS_BASELINE) {
      main.removeCallbacks(observeCleanup)
      main.post(observeCleanup)
    }
  }

  override fun onPause() {
    main.removeCallbacks(observeCleanup)
    if (::androidUpdater.isInitialized) androidUpdater.onPause()
    super.onPause()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (::androidUpdater.isInitialized) androidUpdater.onWindowFocusChanged(hasFocus)
  }

  override fun onDestroy() {
    main.removeCallbacks(observeCleanup)
    if (::androidUpdater.isInitialized) androidUpdater.onDestroy()
    super.onDestroy()
  }

  private fun seedBaselineUpdate() {
    require(packageName == FixturePolicy.FIXTURE_PACKAGE)
    require(BuildConfig.VERSION_NAME == BASELINE_VERSION)
    require(BuildConfig.VERSION_CODE.toLong() == BASELINE_VERSION_CODE)
    require(BuildConfig.SUCCESS_TARGET_SHA256.matches(Regex("^[0-9a-f]{64}$")))
    require(BuildConfig.SUCCESS_TARGET_SIZE in 1L..MAX_TARGET_BYTES)

    val preferences = getSharedPreferences(FixturePolicy.PREFERENCES_NAME, MODE_PRIVATE)
    if (preferences.getBoolean(KEY_SUCCESS_SEEDED, false)) return

    val updates = File(filesDir, "updates")
    check(updates.isDirectory || updates.mkdirs())
    val staged = File(updates, TARGET_APK_NAME)
    val temporary = File(updates, "$TARGET_APK_NAME.part")
    temporary.delete()
    val digest = MessageDigest.getInstance("SHA-256")
    var total = 0L
    assets.open(TARGET_ASSET_NAME).use { input ->
      FileOutputStream(temporary).use { output ->
        val buffer = ByteArray(8192)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          total += count
          check(total <= MAX_TARGET_BYTES)
          digest.update(buffer, 0, count)
          output.write(buffer, 0, count)
        }
        output.fd.sync()
      }
    }
    check(total == BuildConfig.SUCCESS_TARGET_SIZE)
    check(digest.digest().toHex() == BuildConfig.SUCCESS_TARGET_SHA256)
    check(!staged.exists() || staged.delete())
    check(temporary.renameTo(staged))
    check(staged.isFile && staged.length() == total)

    val canary = File(filesDir, CANARY_NAME)
    canary.writeText(CANARY_VALUE, Charsets.UTF_8)
    val candidate = JSONObject()
      .put("tag", TARGET_TAG)
      .put("version", TARGET_VERSION)
      .put("versionCode", TARGET_VERSION_CODE)
      .put("packageName", FixturePolicy.FIXTURE_PACKAGE)
      .put("apkName", TARGET_APK_NAME)
      .put("sha256", BuildConfig.SUCCESS_TARGET_SHA256)
      .put("size", BuildConfig.SUCCESS_TARGET_SIZE)
      .put("browserDownloadUrl", TARGET_BROWSER_URL)

    check(
      preferences.edit()
        .clear()
        .putInt(FixturePolicy.KEY_NETWORK_CONSENT, FixturePolicy.CONSENT_DECLINED)
        .putBoolean(FixturePolicy.KEY_AUTOMATIC_CHECKS, false)
        .putString(FixturePolicy.KEY_DOWNLOAD_CANDIDATE, candidate.toString())
        .putInt(FixturePolicy.KEY_UPDATE_PHASE, FixturePolicy.PHASE_STAGED)
        .putLong(FixturePolicy.KEY_PHASE_NOT_BEFORE_GENERATION, 0L)
        .putBoolean(FixturePolicy.KEY_AWAITING_INSTALL_PERMISSION, false)
        .putBoolean(KEY_SUCCESS_SEEDED, true)
        .commit(),
    )
  }

  private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it.toInt() and 0xff) }

  companion object {
    const val BASELINE_VERSION = "90.0.1"
    const val BASELINE_VERSION_CODE = 90_000_001L
    const val TARGET_VERSION = "90.0.2"
    const val TARGET_VERSION_CODE = 90_000_002L
    const val TARGET_APK_NAME = "YAWF.Stream_Android_90.0.2.apk"
    const val TARGET_ASSET_NAME = "success-target.apk"
    const val TARGET_TAG = "android-v90.0.2"
    const val CANARY_NAME = "success-fixture-canary.txt"
    const val CANARY_VALUE = "permission-return-success-fixture-v1\n"
    const val KEY_SUCCESS_SEEDED = "success_fixture_seeded"
    const val SUCCESS_RECEIPT =
      "Fixture update verified\nCanary preserved\nStaged update cleared\nPermission return marker cleared\nUpdater state cleared"
    const val MAX_TARGET_BYTES = 160L * 1024L * 1024L
    const val TARGET_BROWSER_URL =
      "https://github.com/Tgk-30/YAWF-Stream/releases/download/android-v90.0.2/YAWF.Stream_Android_90.0.2.apk"
  }
}
