package com.tgk30.debridstreamer

import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.system.Os
import android.view.View
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener

/** Dedicated non-exported provider for the single Download/updates/ manifest path. */
class YawfUpdateFileProvider : FileProvider()

/**
 * Activity-owned Android phone updater.
 *
 * This class intentionally has no WebView or JavaScript entrypoint. The caller owns its
 * lifecycle and must forward Activity.onResume(), Activity.onPause(),
 * Activity.onWindowFocusChanged(), and Activity.onDestroy().
 * Download and install actions are only reachable from native dialogs.
 */
class YawfAndroidUpdater private constructor(
  private val activity: Activity,
  private val worker: ExecutorService,
) {
  private val main = Handler(Looper.getMainLooper())
  private val preferences: SharedPreferences =
    activity.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
  private val downloadManager =
    activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

  private var destroyed = false
  private var foreground = false
  private var windowHasFocus = false
  private var resumeNumber = 0L
  private var foregroundGeneration = 0L
  private var readinessAttempts = 0
  private var startupCheckConsidered = false
  private var dialog: AlertDialog? = null
  private var dialogState: DialogState? = null
  private var operationFuture: Future<*>? = null
  private var operationSerial = 0L
  private var operation: Operation? = null
  private var manualCheckPending = false

  private val resumeReadiness = object : Runnable {
    override fun run() {
      if (destroyed || !foreground) return
      if (activityReady()) {
        handleForegroundReadiness()
        return
      }
      readinessAttempts += 1
      if (shouldRetryReadiness(readinessAttempts, foreground, destroyed)) {
        main.postDelayed(this, RESUME_DIALOG_DELAY_MS)
      }
    }
  }

  private val pollDownload = object : Runnable {
    override fun run() {
      if (destroyed || !foreground) return
      if (reconcileDownload(showRunningDialog = false)) {
        main.postDelayed(this, DOWNLOAD_POLL_INTERVAL_MS)
      }
    }
  }

  /** Call once from the Activity after construction, then retain the returned owner. */
  companion object {
    @JvmStatic
    fun attach(activity: Activity): YawfAndroidUpdater =
      YawfAndroidUpdater(activity, Executors.newSingleThreadExecutor())

    private const val PREFERENCES_NAME = "yawf_android_updater_v1"
    private const val KEY_AUTOMATIC_CHECKS = "automatic_checks"
    private const val KEY_NETWORK_CONSENT = "network_consent"
    private const val KEY_LAST_AUTOMATIC_CHECK = "last_automatic_check"
    private const val KEY_AUTOMATIC_RETRY_AFTER = "automatic_retry_after"
    private const val KEY_FOREGROUND_GENERATION = "foreground_generation"
    private const val KEY_OFFER_NOT_BEFORE_GENERATION = "offer_not_before_generation"
    private const val KEY_PENDING_OFFER = "pending_offer"
    private const val KEY_PENDING_CHECK_RESULT = "pending_check_result"
    private const val KEY_AVAILABLE_CANDIDATE = "available_candidate"
    private const val KEY_DOWNLOAD_ID = "download_id"
    private const val KEY_DOWNLOAD_CANDIDATE = "download_candidate"
    private const val KEY_AWAITING_INSTALL_PERMISSION = "awaiting_install_permission"
    private const val KEY_UPDATE_PHASE = "update_phase"
    private const val KEY_PHASE_NOT_BEFORE_GENERATION = "phase_not_before_generation"
    private const val KEY_RESOLVED_URL_HASH = "resolved_url_hash"

    private const val REPOSITORY_OWNER = "Tgk-30"
    private const val REPOSITORY_NAME = "YAWF-Stream"
    private const val RELEASES_PER_PAGE = 20
    private const val MAX_RELEASE_PAGES = 10
    private const val MAX_RELEASE_PAGE_BYTES = 1024 * 1024
    private const val MAX_RELEASE_TOTAL_BYTES = 8 * 1024 * 1024
    private const val MAX_MANIFEST_BYTES = 16 * 1024
    private const val MAX_APK_BYTES = 160L * 1024L * 1024L
    private const val CHECK_DEADLINE_MS = 45_000L
    private const val CONNECTION_TIMEOUT_MS = 10_000
    private const val MAX_REDIRECTS = 5
    private const val AUTOMATIC_CHECK_INTERVAL_MS = 7L * 24L * 60L * 60L * 1000L
    private const val AUTOMATIC_FAILURE_BACKOFF_MS = 6L * 60L * 60L * 1000L
    private const val DOWNLOAD_POLL_INTERVAL_MS = 2_000L
    private const val NO_DOWNLOAD_ID = -1L
    private const val CONSENT_UNKNOWN = 0
    private const val CONSENT_GRANTED = 1
    private const val CONSENT_DECLINED = 2
    private const val CHECK_RESULT_NONE = 0
    private const val CHECK_RESULT_UP_TO_DATE = 1
    private const val CHECK_RESULT_FAILED = 2
    private const val PHASE_NONE = 0
    private const val PHASE_PREPARING = 1
    private const val PHASE_DOWNLOADING = 2
    private const val PHASE_STAGED = 3

    private const val MANIFEST_NAME = "android-update.json"
    private const val APK_MIME_TYPE = "application/vnd.android.package-archive"
    private const val USER_AGENT = "YAWF-Stream-Android-Updater/1"

    private val TAG_PATTERN = Regex("^android-v(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})$")
    private val SHA256_PATTERN = Regex("^[0-9a-f]{64}$")
    private val SOURCE_REVISION_PATTERN = Regex("^[0-9a-f]{40}$")
    private val APK_FILE_PATTERN =
      Regex("^YAWF\\.Stream_Android_(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.apk$")
    private val REDIRECT_HOSTS =
      setOf("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com")
    private val FINAL_DOWNLOAD_HOSTS =
      setOf("release-assets.githubusercontent.com", "objects.githubusercontent.com")
    private const val RESUME_DIALOG_DELAY_MS = 250L
    private const val MAX_READINESS_ATTEMPTS = 20
    private const val MAX_ASSETS_PER_RELEASE = 200
    private const val MAX_PERSISTED_CANDIDATE_CHARS = 4096
    private val INTEGER_PATTERN = Regex("^(0|[1-9][0-9]*)$")
  }

  /** Forward Activity.onResume(). All dialog work remains on the main thread. */
  fun onResume() {
    runOnMain {
      if (destroyed) return@runOnMain
      foreground = true
      windowHasFocus = activity.hasWindowFocus()
      resumeNumber += 1
      foregroundGeneration = preferences.getLong(KEY_FOREGROUND_GENERATION, 0L) + 1L
      preferences.edit().putLong(KEY_FOREGROUND_GENERATION, foregroundGeneration).commit()
      cleanupAfterUpgrade()
      scheduleReadiness(resetAttempts = true)

      if (!startupCheckConsidered) {
        startupCheckConsidered = true
        if (
          persistedDownloadId() == NO_DOWNLOAD_ID &&
          persistedUpdatePhase() == PHASE_NONE &&
          !preferences.getBoolean(KEY_AWAITING_INSTALL_PERMISSION, false) &&
          automaticChecksEnabled() &&
          automaticCheckIsDue()
        ) {
          startCheck(manual = false)
        }
      }
    }
  }

  /** Forward Activity.onPause() so delayed network results cannot open a background window. */
  fun onPause() {
    runOnMain {
      foreground = false
      windowHasFocus = false
      main.removeCallbacks(resumeReadiness)
      main.removeCallbacks(pollDownload)
    }
  }

  /** Forward Activity.onWindowFocusChanged() so delayed native state is not lost. */
  fun onWindowFocusChanged(hasFocus: Boolean) {
    runOnMain {
      if (destroyed) return@runOnMain
      windowHasFocus = hasFocus
      if (hasFocus && foreground) scheduleReadiness(resetAttempts = true)
    }
  }

  /**
   * Starts a user-requested check. Wire this only to a native Activity action. It is not a
   * WebView bridge and accepts no URL or release input.
   */
  fun checkManually() {
    runOnMain {
      if (destroyed) return@runOnMain
      if (!activityReady()) {
        manualCheckPending = true
        return@runOnMain
      }
      requestManualCheckAfterConsent()
    }
  }

  private fun scheduleReadiness(resetAttempts: Boolean) {
    if (resetAttempts) readinessAttempts = 0
    main.removeCallbacks(resumeReadiness)
    main.post(resumeReadiness)
  }

  private fun shouldRetryReadiness(attempts: Int, isForeground: Boolean, isDestroyed: Boolean): Boolean =
    attempts in 0 until MAX_READINESS_ATTEMPTS && isForeground && !isDestroyed

  private fun handleForegroundReadiness() {
    if (!activityReady() || dialog != null) return
    if (operation != null) return
    if (preferences.getBoolean(KEY_AWAITING_INSTALL_PERMISSION, false)) {
      resumePermissionFlow()
      return
    }
    val phase = persistedUpdatePhase()
    if (phase != PHASE_NONE || persistedDownloadId() != NO_DOWNLOAD_ID) {
      resumePersistedUpdate(phase)
      return
    }
    if (networkConsentState() == CONSENT_UNKNOWN) {
      showInitialConsentDialog()
      return
    }
    if (manualCheckPending) {
      manualCheckPending = false
      requestManualCheckAfterConsent()
    } else if (!showPersistedCheckResultIfReady()) {
      showPersistedOfferIfReady()
    }
  }

  private fun resumePersistedUpdate(phase: Int) {
    if (foregroundGeneration < preferences.getLong(KEY_PHASE_NOT_BEFORE_GENERATION, 0L)) return
    val candidate = loadCandidate(KEY_DOWNLOAD_CANDIDATE) ?: run {
      clearPersistedDownload(removeManagerEntry = true, removeFile = true)
      return
    }
    if (!candidateStillNewer(candidate)) {
      clearPersistedDownload(removeManagerEntry = true, removeFile = true)
      return
    }
    when (phase) {
      PHASE_STAGED -> {
        removePersistedDownloadManagerEntry()
        safeDeleteDownload(candidate)
        if (stagedFile(candidate)?.isFile == true) {
          showInstallDialog(candidate)
        } else {
          showRetryOrDefer("The verified update file is unavailable.", candidate)
        }
      }
      PHASE_DOWNLOADING -> {
        if (persistedDownloadId() == NO_DOWNLOAD_ID) {
          showRetryOrDefer("The saved Android download could not be recovered.", candidate)
        } else if (reconcileDownload(showRunningDialog = true)) {
          main.removeCallbacks(pollDownload)
          main.postDelayed(pollDownload, DOWNLOAD_POLL_INTERVAL_MS)
        }
      }
      PHASE_PREPARING -> recoverInterruptedPrepare(candidate)
      else -> {
        if (persistedDownloadId() != NO_DOWNLOAD_ID && reconcileDownload(showRunningDialog = true)) {
          main.removeCallbacks(pollDownload)
          main.postDelayed(pollDownload, DOWNLOAD_POLL_INTERVAL_MS)
        }
      }
    }
  }

  private fun recoverInterruptedPrepare(candidate: Candidate) {
    val resolvedHash = preferences.getString(KEY_RESOLVED_URL_HASH, null)
      ?.takeIf(SHA256_PATTERN::matches)
    val recoveredId = if (resolvedHash == null) null else findOrphanDownload(candidate, resolvedHash)
    if (recoveredId != null) {
      if (persistDownload(recoveredId, candidate)) {
        if (reconcileDownload(showRunningDialog = true)) {
          main.removeCallbacks(pollDownload)
          main.postDelayed(pollDownload, DOWNLOAD_POLL_INTERVAL_MS)
        }
        return
      }
      try {
        downloadManager.remove(recoveredId)
      } catch (_: Exception) {
        // Never adopt a job whose identity could not be persisted.
      }
    }
    showRetryOrDefer("Update preparation was interrupted. Retry when you are ready.", candidate)
  }

  private fun requestManualCheckAfterConsent() {
    if (!hasNetworkConsent()) {
      showManualConsentDialog()
      return
    }
    val phase = persistedUpdatePhase()
    if (phase != PHASE_NONE || persistedDownloadId() != NO_DOWNLOAD_ID) {
      preferences.edit().putLong(KEY_PHASE_NOT_BEFORE_GENERATION, foregroundGeneration).apply()
      resumePersistedUpdate(phase)
      return
    }
    if (operation == Operation.CHECK_AUTOMATIC) cancelOperation()
    if (operation != null) {
      showBusyState()
      return
    }
    startCheck(manual = true)
  }

  /** Forward Activity.onDestroy(). DownloadManager work is deliberately left resumable. */
  fun onDestroy() {
    runOnMain {
      if (destroyed) return@runOnMain
      destroyed = true
      foreground = false
      main.removeCallbacksAndMessages(null)
      operationSerial += 1
      operationFuture?.cancel(true)
      operationFuture = null
      operation = null
      dismissDialog()
      worker.shutdownNow()
    }
  }

  private fun startCheck(manual: Boolean) {
    if (destroyed || operation != null || !hasNetworkConsent()) return
    preferences.edit().remove(KEY_PENDING_CHECK_RESULT).apply()
    if (manual) {
      showProgressDialog(
        state = DialogState.CHECKING,
        title = "Checking for updates",
        message = "Checking the official YAWF Stream Android release channel.",
        cancelLabel = "Cancel",
      ) { cancelOperationAndDismiss() }
    }

    val startedResume = resumeNumber
    val op = if (manual) Operation.CHECK_MANUAL else Operation.CHECK_AUTOMATIC
    submit(op, { discoverCandidate() }) { result ->
      if (manual) dismissDialog()
      if (result == null) {
        clearAvailableOffer()
        recordCheckSuccess()
        if (manual) {
          if (activityReady()) {
            showInformationalDialog(
              title = "YAWF Stream is up to date",
              message = "No newer signed Android phone release is available.",
            )
          } else {
            preferences.edit()
              .putInt(KEY_PENDING_CHECK_RESULT, CHECK_RESULT_UP_TO_DATE)
              .apply()
          }
        }
        return@submit
      }

      val offerPersisted = persistAvailableOffer(result, deferUntilNextForeground = !manual)
      if (offerPersisted) recordCheckSuccess()
      if (manual && resumeNumber == startedResume && activityReady()) {
        showAvailableDialog(result)
      }
      // Automatic results are always deferred until a later foreground resume. This prevents
      // a slow startup check from placing a dialog over playback that began after launch.
    }
  }

  private fun showInitialConsentDialog() {
    if (!activityReady() || networkConsentState() != CONSENT_UNKNOWN) return
    showUpdaterDialog(
      state = DialogState.CONSENT,
      title = "Enable Android update checks?",
      message =
        "YAWF Stream can check its fixed GitHub release channel once a week. No request is sent until you enable this.",
      positive = "Enable",
      negative = "Not now",
      onPositive = {
        preferences.edit()
          .putInt(KEY_NETWORK_CONSENT, CONSENT_GRANTED)
          .putBoolean(KEY_AUTOMATIC_CHECKS, true)
          .apply()
        startCheck(manual = true)
      },
      onNegative = {
        preferences.edit()
          .putInt(KEY_NETWORK_CONSENT, CONSENT_DECLINED)
          .putBoolean(KEY_AUTOMATIC_CHECKS, false)
          .apply()
        dismissDialog()
      },
      includeAutomaticCheckbox = false,
    )
  }

  private fun showManualConsentDialog() {
    if (!activityReady()) return
    dismissDialog()
    var enableAutomatic = false
    val builder =
      AlertDialog.Builder(activity)
        .setTitle("Check for Android updates?")
        .setView(
          automaticChecksView(
            message =
              "This checks only the fixed YAWF Stream GitHub release channel. No request is sent until you choose Check now.",
            checked = false,
          ) { enabled -> enableAutomatic = enabled },
        )
        .setPositiveButton("Check now") { _, _ ->
          val editor = preferences.edit()
            .putInt(KEY_NETWORK_CONSENT, CONSENT_GRANTED)
            .putBoolean(KEY_AUTOMATIC_CHECKS, enableAutomatic)
          editor.apply()
          startCheck(manual = true)
        }
        .setNegativeButton("Cancel") { _, _ ->
          preferences.edit()
            .putInt(KEY_NETWORK_CONSENT, CONSENT_DECLINED)
            .putBoolean(KEY_AUTOMATIC_CHECKS, false)
            .apply()
          dismissDialog()
        }
        .setCancelable(false)
    try {
      val created = builder.create()
      dialog = created
      dialogState = DialogState.CONSENT
      created.setOnDismissListener {
        if (dialog === created) {
          dialog = null
          dialogState = null
        }
      }
      created.show()
    } catch (_: Exception) {
      dialog = null
      dialogState = null
    }
  }

  private fun discoverCandidate(): Candidate? {
    val installed = installedIdentity()
    val deadline = SystemClock.elapsedRealtime() + CHECK_DEADLINE_MS
    val releases = mutableListOf<ReleaseAssets>()
    var releaseBytesRead = 0
    var reachedReleaseHistoryEnd = false

    for (page in 1..MAX_RELEASE_PAGES) {
      ensureWorkerActive(deadline)
      val url =
        "https://api.github.com/repos/$REPOSITORY_OWNER/$REPOSITORY_NAME/releases" +
          "?per_page=$RELEASES_PER_PAGE&page=$page"
      val bytes = readBounded(url, MAX_RELEASE_PAGE_BYTES, deadline, RedirectMode.NONE)
      releaseBytesRead = checkedReleaseHistoryBytes(releaseBytesRead, bytes.size)
      val pageArray = parseJsonArray(bytes)
      if (pageArray.length() > RELEASES_PER_PAGE) throw UpdaterFailure("Release page is oversized")
      for (index in 0 until pageArray.length()) {
        releaseAssets(pageArray.optJSONObject(index) ?: continue)?.let(releases::add)
      }
      if (releaseHistoryEnded(pageArray.length())) {
        reachedReleaseHistoryEnd = true
        break
      }
    }
    if (!reachedReleaseHistoryEnd) throw UpdaterFailure("Release history exceeds the bounded search")

    val newest = releases.maxByOrNull { it.semanticVersion } ?: return null
    val manifestBytes =
      readBounded(newest.manifestUrl, MAX_MANIFEST_BYTES, deadline, RedirectMode.ASSET)
    val candidate = parseManifest(manifestBytes, newest)
    if (!isVersionCodeUpgrade(candidate.versionCode, installed.versionCode)) return null
    return candidate
  }

  private fun releaseAssets(release: JSONObject): ReleaseAssets? {
    val draft = release.opt("draft") as? Boolean ?: return null
    val prerelease = release.opt("prerelease") as? Boolean ?: return null
    if (draft || prerelease) return null
    val tag = release.opt("tag_name") as? String ?: return null
    val tagMatch = TAG_PATTERN.matchEntire(tag) ?: return null
    val version = tag.removePrefix("android-v")
    val semantic =
      SemanticVersion(
        tagMatch.groupValues[1].toInt(),
        tagMatch.groupValues[2].toInt(),
        tagMatch.groupValues[3].toInt(),
      )
    val expectedApkName = "YAWF.Stream_Android_$version.apk"
    val assets = release.optJSONArray("assets") ?: return null
    if (assets.length() > MAX_ASSETS_PER_RELEASE) throw UpdaterFailure("Release has too many assets")

    var manifestUrl: String? = null
    var apkUrl: String? = null
    var apkDigest: String? = null
    var apkSize: Long? = null
    for (index in 0 until assets.length()) {
      val asset = assets.optJSONObject(index) ?: continue
      val name = asset.opt("name") as? String ?: continue
      if (name != MANIFEST_NAME && name != expectedApkName) continue
      val url = asset.opt("browser_download_url") as? String
        ?: throw UpdaterFailure("Release asset URL is invalid")
      requireOfficialAssetUrl(url, tag, name)
      if (name == MANIFEST_NAME) {
        if (manifestUrl != null) throw UpdaterFailure("Release has duplicate update manifests")
        manifestUrl = url
      } else {
        if (apkUrl != null) throw UpdaterFailure("Release has duplicate Android APK assets")
        apkUrl = url
        apkDigest = parseReleaseDigest(asset)
        apkSize = strictLong(asset, "size")
        if (apkSize !in 1L..MAX_APK_BYTES) throw UpdaterFailure("Release APK size is invalid")
      }
    }

    val strictManifestUrl = manifestUrl ?: return null
    val strictApkUrl = apkUrl ?: return null
    return ReleaseAssets(
      tag = tag,
      version = version,
      semanticVersion = semantic,
      manifestUrl = strictManifestUrl,
      apkUrl = strictApkUrl,
      apkDigest = apkDigest,
      apkSize = apkSize ?: throw UpdaterFailure("Release APK size is missing"),
    )
  }

  private fun parseReleaseDigest(asset: JSONObject): String? {
    if (!asset.has("digest") || asset.isNull("digest")) return null
    val raw = asset.opt("digest") as? String
      ?: throw UpdaterFailure("APK release digest is invalid")
    if (!raw.startsWith("sha256:")) throw UpdaterFailure("APK release digest is unsupported")
    val digest = raw.removePrefix("sha256:")
    if (!SHA256_PATTERN.matches(digest)) throw UpdaterFailure("APK release digest is invalid")
    return digest
  }

  private fun parseManifest(bytes: ByteArray, release: ReleaseAssets): Candidate {
    val root = parseJsonObject(bytes)
    requireKeys(
      root,
      required = setOf("schemaVersion", "version", "versionCode", "packageName", "apk"),
      optional = setOf("sourceRevision"),
    )
    if (strictLong(root, "schemaVersion") != 1L) throw UpdaterFailure("Unsupported update schema")
    val version = strictString(root, "version")
    if (version != release.version) throw UpdaterFailure("Manifest version does not match its tag")
    val versionCode = strictLong(root, "versionCode")
    if (versionCode !in 1L..Int.MAX_VALUE.toLong()) {
      throw UpdaterFailure("Manifest version code is invalid")
    }
    if (versionCode != expectedVersionCode(release.semanticVersion)) {
      throw UpdaterFailure("Manifest version code does not match its version")
    }
    val packageName = strictString(root, "packageName")
    if (packageName != activity.packageName) throw UpdaterFailure("Manifest package is invalid")
    if (root.has("sourceRevision")) {
      val revision = strictString(root, "sourceRevision")
      if (!SOURCE_REVISION_PATTERN.matches(revision)) {
        throw UpdaterFailure("Manifest source revision is invalid")
      }
    }

    val apk = root.optJSONObject("apk") ?: throw UpdaterFailure("Manifest APK is invalid")
    requireKeys(apk, required = setOf("name", "sha256", "size"), optional = emptySet())
    val name = strictString(apk, "name")
    val expectedName = "YAWF.Stream_Android_$version.apk"
    if (name != expectedName) throw UpdaterFailure("Manifest APK name is invalid")
    val sha256 = strictString(apk, "sha256")
    if (!SHA256_PATTERN.matches(sha256)) throw UpdaterFailure("Manifest APK hash is invalid")
    val size = strictLong(apk, "size")
    if (size !in 1L..MAX_APK_BYTES) throw UpdaterFailure("Manifest APK size is invalid")
    if (size != release.apkSize) throw UpdaterFailure("Release and manifest APK sizes disagree")
    if (release.apkDigest != null && release.apkDigest != sha256) {
      throw UpdaterFailure("Release and manifest APK digests disagree")
    }

    return Candidate(
      tag = release.tag,
      version = version,
      versionCode = versionCode,
      packageName = packageName,
      apkName = name,
      sha256 = sha256,
      size = size,
      browserDownloadUrl = release.apkUrl,
      releaseDigest = release.apkDigest,
    )
  }

  private fun showAvailableDialog(candidate: Candidate) {
    if (!candidateStillNewer(candidate)) {
      clearAvailableOffer()
      return
    }
    showUpdaterDialog(
      state = DialogState.AVAILABLE,
      title = "YAWF Stream ${candidate.version} is available",
      message =
        "Download the signed Android update now? Android will ask again before installing it.",
      positive = "Update",
      negative = "Later",
      onPositive = {
        clearAvailableOffer()
        beginPrepareDownload(candidate)
      },
      onNegative = { clearAvailableOffer() },
      includeAutomaticCheckbox = true,
    )
  }

  private fun beginPrepareDownload(candidate: Candidate) {
    if (!candidateStillNewer(candidate)) {
      clearPersistedDownload(removeManagerEntry = true, removeFile = true)
      return
    }
    if (!hasNetworkConsent()) {
      showRetryConsentDialog(candidate)
      return
    }
    clearPersistedDownload(removeManagerEntry = true, removeFile = true)
    if (!persistUpdatePhase(PHASE_PREPARING, candidate, resolvedUrlHash = null)) {
      showRetryOrDefer("The update state could not be saved.", candidate)
      return
    }
    prepareDownload(candidate)
  }

  private fun prepareDownload(candidate: Candidate) {
    showProgressDialog(
      state = DialogState.PREPARING,
      title = "Preparing update",
      message = "Validating the official download location.",
      cancelLabel = "Cancel",
    ) {
      cancelOperation()
      clearPersistedDownload(removeManagerEntry = true, removeFile = true)
      dismissDialog()
    }
    submit(
      operation = Operation.PREPARE_DOWNLOAD,
      work = {
        val deadline = SystemClock.elapsedRealtime() + CHECK_DEADLINE_MS
        resolveAssetDownload(
          candidate.browserDownloadUrl,
          candidate.tag,
          candidate.apkName,
          candidate.size,
          deadline,
        )
      },
      failure = {
        showRetryOrDefer("The official download location could not be validated.", candidate)
      },
    ) { resolvedUrl ->
      if (!persistUpdatePhase(PHASE_PREPARING, candidate, sha256Text(resolvedUrl))) {
        showRetryOrDefer("The update state could not be saved.", candidate)
      } else {
        enqueueDownload(candidate, resolvedUrl)
      }
    }
  }

  private fun enqueueDownload(candidate: Candidate, resolvedUrl: String) {
    dismissDialog()
    val target = downloadFile(candidate) ?: run {
      showRetryOrDefer("Update storage is unavailable.", candidate)
      return
    }
    target.parentFile?.mkdirs()
    if (target.exists() && !target.delete()) {
      showRetryOrDefer("The previous update file could not be removed.", candidate)
      return
    }

    try {
      val request =
        DownloadManager.Request(Uri.parse(resolvedUrl))
          .setTitle(downloadTitle(candidate))
          .setDescription("Android update")
          .setMimeType(APK_MIME_TYPE)
          .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
          .setAllowedOverMetered(true)
          .setAllowedOverRoaming(false)
          .setDestinationInExternalFilesDir(
            activity,
            Environment.DIRECTORY_DOWNLOADS,
            "updates/${candidate.apkName}",
          )
      val id = downloadManager.enqueue(request)
      if (!persistDownload(id, candidate)) {
        try {
          downloadManager.remove(id)
        } catch (_: Exception) {
          // Best effort cleanup after private persistence failed.
        }
        safeDeleteDownload(candidate)
        showRetryOrDefer("Android could not persist the update download.", candidate)
        return
      }
      showDownloadingDialog(candidate, downloaded = 0L, total = candidate.size)
      main.removeCallbacks(pollDownload)
      main.postDelayed(pollDownload, DOWNLOAD_POLL_INTERVAL_MS)
    } catch (_: Exception) {
      clearPersistedDownload(removeManagerEntry = true, removeFile = true)
      showRetryOrDefer("Android could not start the update download.", candidate)
    }
  }

  private fun reconcileDownload(showRunningDialog: Boolean): Boolean {
    val id = persistedDownloadId()
    if (id == NO_DOWNLOAD_ID) return false
    val candidate = loadCandidate(KEY_DOWNLOAD_CANDIDATE) ?: run {
      clearPersistedDownload(removeManagerEntry = true, removeFile = true)
      return false
    }
    if (!candidateStillNewer(candidate)) {
      clearPersistedDownload(removeManagerEntry = true, removeFile = true)
      return false
    }

    val row = queryDownload(id) ?: run {
      clearPersistedDownload(removeManagerEntry = false, removeFile = true)
      showRetryOrDefer("Android no longer has the update download.", candidate)
      return false
    }
    return when (row.status) {
      DownloadManager.STATUS_SUCCESSFUL -> {
        if (row.total >= 0L && row.total != candidate.size) {
          clearPersistedDownload(removeManagerEntry = true, removeFile = true)
          showRetryOrDefer("The downloaded update size is invalid.", candidate)
          return false
        }
        val target = downloadFile(candidate)
        if (target == null || !downloadLocationMatches(row.localUri, target)) {
          clearPersistedDownload(removeManagerEntry = true, removeFile = true)
          showRetryOrDefer("Android returned an unexpected update file.", candidate)
          return false
        }
        if (operation != Operation.VERIFY) stageDownloaded(candidate)
        false
      }
      DownloadManager.STATUS_PENDING,
      DownloadManager.STATUS_RUNNING,
      DownloadManager.STATUS_PAUSED,
      -> {
        check(downloadNeedsPolling(row.status))
        if (row.total > 0L && row.total != candidate.size) {
          clearPersistedDownload(removeManagerEntry = true, removeFile = true)
          showRetryOrDefer("The update download size changed.", candidate)
          return false
        }
        if (showRunningDialog && activityReady()) {
          showDownloadingDialog(candidate, row.downloaded, row.total)
        } else if (dialogState == DialogState.DOWNLOADING) {
          dialog?.setMessage(downloadProgressMessage(row.downloaded, row.total))
        }
        true
      }
      DownloadManager.STATUS_FAILED -> {
        clearPersistedDownload(removeManagerEntry = true, removeFile = true)
        showRetryOrDefer("The update download failed.", candidate)
        false
      }
      else -> {
        clearPersistedDownload(removeManagerEntry = true, removeFile = true)
        showRetryOrDefer("Android returned an unknown download state.", candidate)
        false
      }
    }
  }

  private fun stageDownloaded(candidate: Candidate) {
    val target = downloadFile(candidate) ?: run {
      showRetryOrDefer("Update storage is unavailable.", candidate)
      return
    }
    showProgressDialog(
      state = DialogState.VERIFYING,
      title = "Verifying update",
      message = "Checking the package, version, signature, size, and SHA-256 digest.",
      cancelLabel = "Cancel update",
    ) {
      cancelOperation()
      clearPersistedDownload(removeManagerEntry = true, removeFile = true)
      dismissDialog()
    }
    submit(
      operation = Operation.VERIFY,
      work = { stageAndVerifyPackage(candidate, target) },
      failure = {
        clearPersistedDownload(removeManagerEntry = true, removeFile = true)
        showRetryOrDefer("The downloaded update did not pass verification.", candidate)
      },
    ) {
      dismissDialog()
      if (!persistStaged(candidate)) {
        clearPersistedDownload(removeManagerEntry = true, removeFile = true)
        showRetryOrDefer("The verified update state could not be saved.", candidate)
      } else {
        removePersistedDownloadManagerEntry()
        safeDeleteDownload(candidate)
        showInstallDialog(candidate)
      }
    }
  }

  private fun stageAndVerifyPackage(candidate: Candidate, source: File) {
    ensureWorkerActive()
    val canonicalSource = downloadFile(candidate)?.canonicalFile
      ?: throw UpdaterFailure("Update file is unavailable")
    if (source.canonicalFile != canonicalSource || !source.isFile) {
      throw UpdaterFailure("Update file identity is invalid")
    }
    val directory = stagedUpdatesDirectory()
      ?: throw UpdaterFailure("Private update storage is unavailable")
    if (!directory.exists() && !directory.mkdirs()) {
      throw UpdaterFailure("Private update storage is unavailable")
    }
    val temporary = stagedTemporaryFile(candidate)
      ?: throw UpdaterFailure("Private update storage is unavailable")
    val staged = stagedFile(candidate)
      ?: throw UpdaterFailure("Private update storage is unavailable")
    temporary.delete()
    try {
      copyAndHashToInternal(candidate, source, temporary)
      verifyPackageIdentity(candidate, temporary)
      ensureWorkerActive()
      Os.rename(temporary.absolutePath, staged.absolutePath)
    } finally {
      if (temporary.exists()) temporary.delete()
    }
  }

  private fun copyAndHashToInternal(candidate: Candidate, source: File, destination: File) {
    val digest = MessageDigest.getInstance("SHA-256")
    var total = 0L
    source.inputStream().buffered().use { input ->
      FileOutputStream(destination, false).use { fileOutput ->
        val output = fileOutput.buffered()
        val buffer = ByteArray(64 * 1024)
        while (true) {
          ensureWorkerActive()
          val count = input.read(buffer)
          if (count < 0) break
          total += count
          if (total > candidate.size || total > MAX_APK_BYTES) {
            throw UpdaterFailure("Update file size is invalid")
          }
          digest.update(buffer, 0, count)
          output.write(buffer, 0, count)
        }
        output.flush()
        fileOutput.fd.sync()
      }
    }
    if (total != candidate.size) throw UpdaterFailure("Update file size is invalid")
    val actual = digest.digest()
    if (!MessageDigest.isEqual(actual, candidate.sha256.hexToBytes())) {
      throw UpdaterFailure("Update file digest is invalid")
    }
  }

  private fun verifyStagedForInstall(candidate: Candidate) {
    val staged = stagedFile(candidate) ?: run {
      showRetryOrDefer("The verified update is unavailable.", candidate, installRetry = true)
      return
    }
    showProgressDialog(
      state = DialogState.VERIFYING,
      title = "Verifying update",
      message = "Rechecking the private package before Android receives access.",
      cancelLabel = "Cancel update",
    ) {
      cancelOperation()
      clearPersistedDownload(removeManagerEntry = true, removeFile = true)
      dismissDialog()
    }
    submit(
      operation = Operation.VERIFY,
      work = { verifyStagedPackage(candidate, staged) },
      failure = {
        clearPersistedDownload(removeManagerEntry = true, removeFile = true)
        showRetryOrDefer("The verified update changed or became unavailable.", candidate)
      },
    ) {
      dismissDialog()
      if (activityReady()) launchInstaller(candidate)
    }
  }

  private fun verifyStagedPackage(candidate: Candidate, target: File) {
    ensureWorkerActive()
    val expected = stagedFile(candidate)?.canonicalFile
      ?: throw UpdaterFailure("Private update file is unavailable")
    if (target.canonicalFile != expected || !target.isFile) {
      throw UpdaterFailure("Private update file identity is invalid")
    }
    verifyStagedContent(candidate, target)
    verifyPackageIdentity(candidate, target)
  }

  private fun verifyStagedContent(candidate: Candidate, target: File) {
    if (target.length() != candidate.size || target.length() !in 1L..MAX_APK_BYTES) {
      throw UpdaterFailure("Update file size is invalid")
    }
    val hash = sha256(target)
    if (!MessageDigest.isEqual(hash.hexToBytes(), candidate.sha256.hexToBytes())) {
      throw UpdaterFailure("Update file digest is invalid")
    }
  }

  private fun verifyPackageIdentity(candidate: Candidate, target: File) {
    val archive = packageArchiveIdentity(target)
    val installed = installedIdentity()
    if (archive.packageName != activity.packageName || archive.packageName != candidate.packageName) {
      throw UpdaterFailure("Update package name is invalid")
    }
    if (archive.versionCode != candidate.versionCode || archive.versionName != candidate.version) {
      throw UpdaterFailure("Update package version is invalid")
    }
    if (!isVersionCodeUpgrade(archive.versionCode, installed.versionCode)) {
      throw UpdaterFailure("Update package is not newer")
    }
    if (archive.signers.isEmpty() || archive.signers != installed.signers) {
      throw UpdaterFailure("Update package signer is invalid")
    }
  }

  private fun showInstallDialog(candidate: Candidate) {
    showUpdaterDialog(
      state = DialogState.READY_TO_INSTALL,
      title = "Update ready to install",
      message =
        "YAWF Stream ${candidate.version} passed all checks. Android will show the system installer.",
      positive = "Install",
      negative = "Later",
      onPositive = { onInstallSelected(candidate) },
      onNegative = {
        deferPhaseUntilNextForeground()
        dismissDialog()
      },
      includeAutomaticCheckbox = false,
    )
  }

  private fun onInstallSelected(candidate: Candidate) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      !activity.packageManager.canRequestPackageInstalls()
    ) {
      preferences.edit().putBoolean(KEY_AWAITING_INSTALL_PERMISSION, true).apply()
      try {
        activity.startActivity(
          Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${activity.packageName}"),
          ),
        )
        showPermissionDialog(candidate, settingsAlreadyOpened = true)
      } catch (_: Exception) {
        showPermissionDialog(candidate, settingsAlreadyOpened = false)
      }
      return
    }
    preferences.edit().putBoolean(KEY_AWAITING_INSTALL_PERMISSION, false).apply()
    verifyStagedForInstall(candidate)
  }

  private fun resumePermissionFlow() {
    val candidate = loadCandidate(KEY_DOWNLOAD_CANDIDATE) ?: run {
      preferences.edit().remove(KEY_AWAITING_INSTALL_PERMISSION).apply()
      clearPersistedDownload(removeManagerEntry = true, removeFile = true)
      return
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
      activity.packageManager.canRequestPackageInstalls()
    ) {
      preferences.edit().putBoolean(KEY_AWAITING_INSTALL_PERMISSION, false).apply()
      verifyStagedForInstall(candidate)
    } else {
      showPermissionDialog(candidate, settingsAlreadyOpened = true)
    }
  }

  private fun showPermissionDialog(candidate: Candidate, settingsAlreadyOpened: Boolean) {
    val message =
      if (settingsAlreadyOpened) {
        "Allow installs from YAWF Stream in Android Settings, then return here. You can retry or install later."
      } else {
        "Android could not open the install permission screen. You can retry or install later."
      }
    showUpdaterDialog(
      state = DialogState.AWAITING_PERMISSION,
      title = "Install permission needed",
      message = message,
      positive = "Open settings",
      negative = "Later",
      onPositive = {
        try {
          activity.startActivity(
            Intent(
              Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
              Uri.parse("package:${activity.packageName}"),
            ),
          )
        } catch (_: Exception) {
          showPermissionDialog(candidate, settingsAlreadyOpened = false)
        }
      },
      onNegative = {
        preferences.edit().putBoolean(KEY_AWAITING_INSTALL_PERMISSION, false).apply()
        deferPhaseUntilNextForeground()
        dismissDialog()
      },
      includeAutomaticCheckbox = false,
    )
  }

  private fun launchInstaller(candidate: Candidate) {
    val target = stagedFile(candidate) ?: run {
      showRetryOrDefer("Update storage is unavailable.", candidate)
      return
    }
    try {
      val contentUri =
        FileProvider.getUriForFile(activity, "${activity.packageName}.updates", target)
      val intent =
        Intent(Intent.ACTION_VIEW)
          .setDataAndType(contentUri, APK_MIME_TYPE)
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      intent.clipData = ClipData.newRawUri("YAWF Stream update", contentUri)
      activity.startActivity(intent)
      dismissDialog()
    } catch (_: Exception) {
      showRetryOrDefer(
        "Android could not open the package installer.",
        candidate,
        installRetry = true,
      )
    }
  }

  private fun showDownloadingDialog(candidate: Candidate, downloaded: Long, total: Long) {
    showUpdaterDialog(
      state = DialogState.DOWNLOADING,
      title = "Downloading update",
      message = downloadProgressMessage(downloaded, total),
      positive = "Continue in background",
      negative = "Cancel download",
      onPositive = {
        deferPhaseUntilNextForeground()
        dismissDialog()
      },
      onNegative = {
        clearPersistedDownload(removeManagerEntry = true, removeFile = true)
        dismissDialog()
      },
      includeAutomaticCheckbox = false,
    )
  }

  private fun showRetryDialog(
    message: String,
    candidate: Candidate,
    installRetry: Boolean = false,
  ) {
    showUpdaterDialog(
      state = DialogState.RETRY,
      title = "Update needs attention",
      message = message,
      positive = "Retry",
      negative = "Cancel update",
      onPositive = {
        if (installRetry) verifyStagedForInstall(candidate) else beginPrepareDownload(candidate)
      },
      onNegative = {
        preferences.edit().putBoolean(KEY_AWAITING_INSTALL_PERMISSION, false).apply()
        clearPersistedDownload(removeManagerEntry = true, removeFile = true)
        dismissDialog()
      },
      includeAutomaticCheckbox = false,
    )
  }

  private fun showRetryOrDefer(
    message: String,
    candidate: Candidate,
    installRetry: Boolean = false,
  ) {
    dismissDialog()
    val phase = if (installRetry) PHASE_STAGED else PHASE_PREPARING
    persistUpdatePhase(phase, candidate, resolvedUrlHash = null)
    if (activityReady()) {
      showRetryDialog(message, candidate, installRetry)
    }
  }

  private fun showRetryConsentDialog(candidate: Candidate) {
    if (!activityReady()) {
      persistUpdatePhase(PHASE_PREPARING, candidate, resolvedUrlHash = null)
      return
    }
    showUpdaterDialog(
      state = DialogState.CONSENT,
      title = "Allow this update retry?",
      message =
        "Retrying contacts only the fixed YAWF Stream GitHub release channel. No request is sent until you continue.",
      positive = "Continue",
      negative = "Cancel update",
      onPositive = {
        preferences.edit().putInt(KEY_NETWORK_CONSENT, CONSENT_GRANTED).apply()
        beginPrepareDownload(candidate)
      },
      onNegative = {
        clearPersistedDownload(removeManagerEntry = true, removeFile = true)
        dismissDialog()
      },
      includeAutomaticCheckbox = false,
    )
  }

  private fun showInformationalDialog(title: String, message: String) {
    showUpdaterDialog(
      state = DialogState.INFORMATION,
      title = title,
      message = message,
      positive = "OK",
      negative = null,
      onPositive = { dismissDialog() },
      onNegative = null,
      includeAutomaticCheckbox = true,
    )
  }

  private fun showBusyState() {
    when (operation) {
      Operation.CHECK_MANUAL,
      Operation.CHECK_AUTOMATIC,
      -> showInformationalDialog("Update check in progress", "An update check is already running.")
      Operation.PREPARE_DOWNLOAD -> showInformationalDialog("Preparing update", "The download is being prepared.")
      Operation.VERIFY -> showInformationalDialog("Verifying update", "The downloaded update is being verified.")
      null -> Unit
    }
  }

  private fun showProgressDialog(
    state: DialogState,
    title: String,
    message: String,
    cancelLabel: String,
    onCancel: () -> Unit,
  ) {
    showUpdaterDialog(
      state = state,
      title = title,
      message = message,
      positive = null,
      negative = cancelLabel,
      onPositive = null,
      onNegative = onCancel,
      includeAutomaticCheckbox = false,
    )
  }

  private fun showUpdaterDialog(
    state: DialogState,
    title: String,
    message: String,
    positive: String?,
    negative: String?,
    onPositive: (() -> Unit)?,
    onNegative: (() -> Unit)?,
    includeAutomaticCheckbox: Boolean,
  ) {
    if (!activityReady()) return
    dismissDialog()
    val builder =
      AlertDialog.Builder(activity)
        .setTitle(title)
        .setCancelable(false)
    if (includeAutomaticCheckbox) {
      builder.setView(
        automaticChecksView(message, automaticChecksEnabled()) { enabled ->
          val editor = preferences.edit()
            .putInt(KEY_NETWORK_CONSENT, CONSENT_GRANTED)
            .putBoolean(KEY_AUTOMATIC_CHECKS, enabled)
          editor.apply()
        },
      )
    } else {
      builder.setMessage(message)
    }
    if (positive != null && onPositive != null) builder.setPositiveButton(positive) { _, _ -> onPositive() }
    if (negative != null && onNegative != null) builder.setNegativeButton(negative) { _, _ -> onNegative() }

    try {
      val created = builder.create()
      dialog = created
      dialogState = state
      created.setOnDismissListener {
        if (dialog === created) {
          dialog = null
          dialogState = null
        }
      }
      created.show()
    } catch (_: Exception) {
      dialog = null
      dialogState = null
    }
  }

  private fun automaticChecksView(
    message: String,
    checked: Boolean,
    onCheckedChanged: (Boolean) -> Unit,
  ): View {
    val density = activity.resources.displayMetrics.density
    fun dp(value: Int): Int = (value * density + 0.5f).toInt()
    return LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(24), dp(8), dp(24), 0)
      addView(
        TextView(activity).apply {
          text = message
          setTextAppearance(android.R.style.TextAppearance_Material_Body1)
        },
      )
      addView(
        CheckBox(activity).apply {
          text = "Check automatically each week"
          isChecked = checked
          setOnCheckedChangeListener { _, enabled -> onCheckedChanged(enabled) }
        },
      )
    }
  }

  private fun showPersistedOfferIfReady() {
    if (!preferences.getBoolean(KEY_PENDING_OFFER, false) || !activityReady()) return
    val notBefore = preferences.getLong(KEY_OFFER_NOT_BEFORE_GENERATION, 0L)
    if (foregroundGeneration < notBefore) return
    val candidate = loadCandidate(KEY_AVAILABLE_CANDIDATE) ?: run {
      clearAvailableOffer()
      return
    }
    if (operation != null || persistedDownloadId() != NO_DOWNLOAD_ID) return
    showAvailableDialog(candidate)
  }

  private fun showPersistedCheckResultIfReady(): Boolean {
    if (!activityReady()) return false
    return when (preferences.getInt(KEY_PENDING_CHECK_RESULT, CHECK_RESULT_NONE)) {
      CHECK_RESULT_UP_TO_DATE -> {
        preferences.edit().remove(KEY_PENDING_CHECK_RESULT).apply()
        showInformationalDialog(
          title = "YAWF Stream is up to date",
          message = "No newer signed Android phone release is available.",
        )
        true
      }
      CHECK_RESULT_FAILED -> {
        preferences.edit().remove(KEY_PENDING_CHECK_RESULT).apply()
        showInformationalDialog(
          title = "Update check unavailable",
          message = "The official Android update channel could not be checked. Try again later.",
        )
        true
      }
      else -> false
    }
  }

  private fun cleanupAfterUpgrade() {
    val installed = try {
      installedIdentity()
    } catch (_: Exception) {
      return
    }
    val downloadCandidate = loadCandidate(KEY_DOWNLOAD_CANDIDATE)
    if (downloadCandidate != null && installed.versionCode >= downloadCandidate.versionCode) {
      clearPersistedDownload(removeManagerEntry = true, removeFile = true)
    }
    val available = loadCandidate(KEY_AVAILABLE_CANDIDATE)
    if (available != null && installed.versionCode >= available.versionCode) clearAvailableOffer()
  }

  private fun automaticCheckIsDue(): Boolean {
    val last = preferences.getLong(KEY_LAST_AUTOMATIC_CHECK, 0L)
    val retryAfter = preferences.getLong(KEY_AUTOMATIC_RETRY_AFTER, 0L)
    val now = System.currentTimeMillis()
    return automaticCheckIsDueAt(last, retryAfter, now)
  }

  private fun automaticCheckIsDueAt(lastSuccess: Long, retryAfter: Long, now: Long): Boolean {
    if (now < 0L) return false
    if (retryAfter > now && retryAfter - now <= AUTOMATIC_FAILURE_BACKOFF_MS) return false
    if (lastSuccess <= 0L || now < lastSuccess) return true
    return now - lastSuccess >= AUTOMATIC_CHECK_INTERVAL_MS
  }

  private fun recordCheckSuccess() {
    preferences.edit()
      .putLong(KEY_LAST_AUTOMATIC_CHECK, System.currentTimeMillis())
      .remove(KEY_AUTOMATIC_RETRY_AFTER)
      .commit()
  }

  private fun recordAutomaticCheckFailure() {
    val now = System.currentTimeMillis().coerceAtLeast(0L)
    val retryAfter = (now + AUTOMATIC_FAILURE_BACKOFF_MS).coerceAtLeast(now)
    preferences.edit().putLong(KEY_AUTOMATIC_RETRY_AFTER, retryAfter).apply()
  }

  private fun automaticChecksEnabled(): Boolean =
    hasNetworkConsent() && preferences.getBoolean(KEY_AUTOMATIC_CHECKS, true)

  private fun hasNetworkConsent(): Boolean = networkConsentState() == CONSENT_GRANTED

  private fun networkConsentState(): Int =
    preferences.getInt(KEY_NETWORK_CONSENT, CONSENT_UNKNOWN)

  private fun persistAvailableOffer(
    candidate: Candidate,
    deferUntilNextForeground: Boolean = false,
  ): Boolean {
    val notBefore = foregroundGeneration + if (deferUntilNextForeground) 1L else 0L
    return preferences.edit()
      .putString(KEY_AVAILABLE_CANDIDATE, candidate.toJson().toString())
      .putBoolean(KEY_PENDING_OFFER, true)
      .putLong(KEY_OFFER_NOT_BEFORE_GENERATION, notBefore)
      .commit()
  }

  private fun clearAvailableOffer() {
    preferences.edit()
      .remove(KEY_AVAILABLE_CANDIDATE)
      .remove(KEY_PENDING_OFFER)
      .remove(KEY_OFFER_NOT_BEFORE_GENERATION)
      .commit()
  }

  private fun persistUpdatePhase(
    phase: Int,
    candidate: Candidate,
    resolvedUrlHash: String?,
  ): Boolean {
    if (phase !in setOf(PHASE_PREPARING, PHASE_DOWNLOADING, PHASE_STAGED)) return false
    val editor = preferences.edit()
      .putInt(KEY_UPDATE_PHASE, phase)
      .putString(KEY_DOWNLOAD_CANDIDATE, candidate.toJson().toString())
      .putLong(KEY_PHASE_NOT_BEFORE_GENERATION, foregroundGeneration)
    if (resolvedUrlHash == null) editor.remove(KEY_RESOLVED_URL_HASH)
    else editor.putString(KEY_RESOLVED_URL_HASH, resolvedUrlHash)
    if (phase != PHASE_DOWNLOADING) editor.remove(KEY_DOWNLOAD_ID)
    return editor.commit()
  }

  private fun persistDownload(id: Long, candidate: Candidate): Boolean =
    preferences.edit()
      .putLong(KEY_DOWNLOAD_ID, id)
      .putInt(KEY_UPDATE_PHASE, PHASE_DOWNLOADING)
      .putString(KEY_DOWNLOAD_CANDIDATE, candidate.toJson().toString())
      .putLong(KEY_PHASE_NOT_BEFORE_GENERATION, foregroundGeneration)
      .remove(KEY_RESOLVED_URL_HASH)
      .putBoolean(KEY_AWAITING_INSTALL_PERMISSION, false)
      .commit()

  private fun persistStaged(candidate: Candidate): Boolean =
    preferences.edit()
      .putInt(KEY_UPDATE_PHASE, PHASE_STAGED)
      .putString(KEY_DOWNLOAD_CANDIDATE, candidate.toJson().toString())
      .putLong(KEY_PHASE_NOT_BEFORE_GENERATION, foregroundGeneration)
      .remove(KEY_RESOLVED_URL_HASH)
      .putBoolean(KEY_AWAITING_INSTALL_PERMISSION, false)
      .commit()

  private fun persistedUpdatePhase(): Int =
    preferences.getInt(KEY_UPDATE_PHASE, PHASE_NONE)
      .takeIf { it in PHASE_NONE..PHASE_STAGED } ?: PHASE_NONE

  private fun deferPhaseUntilNextForeground() {
    preferences.edit()
      .putLong(KEY_PHASE_NOT_BEFORE_GENERATION, foregroundGeneration + 1L)
      .commit()
  }

  private fun persistedDownloadId(): Long =
    preferences.getLong(KEY_DOWNLOAD_ID, NO_DOWNLOAD_ID).takeIf { it > 0L } ?: NO_DOWNLOAD_ID

  private fun clearPersistedDownload(removeManagerEntry: Boolean, removeFile: Boolean) {
    main.removeCallbacks(pollDownload)
    val id = persistedDownloadId()
    val candidate = loadCandidate(KEY_DOWNLOAD_CANDIDATE)
    if (removeManagerEntry && id != NO_DOWNLOAD_ID) {
      try {
        downloadManager.remove(id)
      } catch (_: Exception) {
        // Best effort. Clearing the private identity prevents reuse of an untrusted row.
      }
    }
    if (removeFile) {
      if (candidate != null) {
        safeDeleteDownload(candidate)
        safeDeleteStaged(candidate)
      } else {
        safeDeleteOrphanUpdateFiles()
        safeDeleteOrphanStagedFiles()
      }
    }
    preferences.edit()
      .remove(KEY_DOWNLOAD_ID)
      .remove(KEY_DOWNLOAD_CANDIDATE)
      .remove(KEY_AWAITING_INSTALL_PERMISSION)
      .remove(KEY_UPDATE_PHASE)
      .remove(KEY_PHASE_NOT_BEFORE_GENERATION)
      .remove(KEY_RESOLVED_URL_HASH)
      .apply()
  }

  private fun removePersistedDownloadManagerEntry() {
    val id = persistedDownloadId()
    if (id != NO_DOWNLOAD_ID) {
      try {
        downloadManager.remove(id)
      } catch (_: Exception) {
        // Best effort after a verified private copy exists.
      }
    }
    preferences.edit().remove(KEY_DOWNLOAD_ID).apply()
  }

  private fun safeDeleteDownload(candidate: Candidate) {
    try {
      val directory = downloadUpdatesDirectory()?.canonicalFile ?: return
      val file = File(directory, candidate.apkName)
      if (file.parentFile?.canonicalFile == directory && APK_FILE_PATTERN.matches(file.name)) file.delete()
    } catch (_: IOException) {
      // Best effort cleanup only.
    } catch (_: SecurityException) {
      // Best effort cleanup only.
    }
  }

  private fun safeDeleteOrphanUpdateFiles() {
    try {
      val directory = downloadUpdatesDirectory()?.canonicalFile ?: return
      directory.listFiles()?.forEach { file ->
        if (file.parentFile?.canonicalFile == directory && APK_FILE_PATTERN.matches(file.name)) {
          file.delete()
        }
      }
    } catch (_: IOException) {
      // Best effort cleanup only.
    } catch (_: SecurityException) {
      // Best effort cleanup only.
    }
  }

  private fun safeDeleteStaged(candidate: Candidate) {
    try {
      val directory = stagedUpdatesDirectory()?.canonicalFile ?: return
      for (file in listOfNotNull(stagedFile(candidate), stagedTemporaryFile(candidate))) {
        if (file.parentFile?.canonicalFile == directory) file.delete()
      }
    } catch (_: IOException) {
      // Best effort cleanup only.
    } catch (_: SecurityException) {
      // Best effort cleanup only.
    }
  }

  private fun safeDeleteOrphanStagedFiles() {
    try {
      val directory = stagedUpdatesDirectory()?.canonicalFile ?: return
      directory.listFiles()?.forEach { file ->
        val baseName =
          if (file.name.endsWith(".part.apk")) file.name.removeSuffix(".part.apk") + ".apk"
          else file.name
        if (file.parentFile?.canonicalFile == directory && APK_FILE_PATTERN.matches(baseName)) {
          file.delete()
        }
      }
    } catch (_: IOException) {
      // Best effort cleanup only.
    } catch (_: SecurityException) {
      // Best effort cleanup only.
    }
  }

  private fun downloadUpdatesDirectory(): File? =
    activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)?.let { File(it, "updates") }

  private fun downloadFile(candidate: Candidate): File? {
    if (candidate.apkName != "YAWF.Stream_Android_${candidate.version}.apk") return null
    val directory = downloadUpdatesDirectory() ?: return null
    return childFile(directory, candidate.apkName)
  }

  private fun stagedUpdatesDirectory(): File? = File(activity.filesDir, "updates")

  private fun stagedFile(candidate: Candidate): File? {
    if (candidate.apkName != "YAWF.Stream_Android_${candidate.version}.apk") return null
    val directory = stagedUpdatesDirectory() ?: return null
    return childFile(directory, candidate.apkName)
  }

  private fun stagedTemporaryFile(candidate: Candidate): File? {
    val directory = stagedUpdatesDirectory() ?: return null
    val temporaryName = candidate.apkName.removeSuffix(".apk") + ".part.apk"
    return childFile(directory, temporaryName)
  }

  private fun childFile(directory: File, name: String): File? {
    return try {
      val canonicalDirectory = directory.canonicalFile
      val file = File(canonicalDirectory, name).canonicalFile
      if (file.parentFile == canonicalDirectory) file else null
    } catch (_: IOException) {
      null
    } catch (_: SecurityException) {
      null
    }
  }

  private fun queryDownload(id: Long): DownloadRow? {
    return try {
      downloadManager.query(DownloadManager.Query().setFilterById(id))?.use { cursor ->
        if (!cursor.moveToFirst()) return@use null
        DownloadRow(
          id = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_ID)),
          status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)),
          downloaded =
            cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)),
          total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)),
          localUri =
            cursor.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI).takeIf { it >= 0 }
              ?.let { cursor.getString(it) },
          sourceUri =
            cursor.getColumnIndex(DownloadManager.COLUMN_URI).takeIf { it >= 0 }
              ?.let { cursor.getString(it) },
          title =
            cursor.getColumnIndex(DownloadManager.COLUMN_TITLE).takeIf { it >= 0 }
              ?.let { cursor.getString(it) },
        )
      }
    } catch (_: Exception) {
      null
    }
  }

  private fun findOrphanDownload(candidate: Candidate, resolvedUrlHash: String): Long? {
    val matches = mutableListOf<Long>()
    try {
      downloadManager.query(DownloadManager.Query())?.use { cursor ->
        var inspected = 0
        while (cursor.moveToNext() && inspected < 512) {
          inspected += 1
          val row =
            DownloadRow(
              id = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_ID)),
              status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)),
              downloaded =
                cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)),
              total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)),
              localUri =
                cursor.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI).takeIf { it >= 0 }
                  ?.let { cursor.getString(it) },
              sourceUri =
                cursor.getColumnIndex(DownloadManager.COLUMN_URI).takeIf { it >= 0 }
                  ?.let { cursor.getString(it) },
              title =
                cursor.getColumnIndex(DownloadManager.COLUMN_TITLE).takeIf { it >= 0 }
                  ?.let { cursor.getString(it) },
            )
          if (orphanRowMatches(candidate, resolvedUrlHash, row)) matches += row.id
        }
      }
    } catch (_: Exception) {
      return null
    }
    if (matches.size == 1) return matches.single()
    if (matches.size > 1) {
      try {
        downloadManager.remove(*matches.toLongArray())
      } catch (_: Exception) {
        // Ambiguous jobs are never adopted.
      }
    }
    return null
  }

  private fun orphanRowMatches(
    candidate: Candidate,
    resolvedUrlHash: String,
    row: DownloadRow,
  ): Boolean {
    if (row.id <= 0L || row.title != downloadTitle(candidate)) return false
    if (row.sourceUri == null || sha256Text(row.sourceUri) != resolvedUrlHash) return false
    val expected = downloadFile(candidate) ?: return false
    return row.localUri == null || downloadLocationMatches(row.localUri, expected)
  }

  private fun downloadTitle(candidate: Candidate): String = "YAWF Stream ${candidate.version}"

  private fun downloadLocationMatches(localUri: String?, expected: File): Boolean {
    if (localUri == null) return expected.isFile
    return try {
      val parsed = URI(localUri)
      parsed.scheme == "file" && File(parsed).canonicalFile == expected.canonicalFile
    } catch (_: Exception) {
      false
    }
  }

  private fun downloadProgressMessage(downloaded: Long, total: Long): String {
    val safeDownloaded = downloaded.coerceAtLeast(0L)
    val safeTotal = total.takeIf { it > 0L }
    return if (safeTotal != null) {
      val percent = ((safeDownloaded.coerceAtMost(safeTotal) * 100L) / safeTotal).toInt()
      "Android is downloading the signed APK. $percent% complete."
    } else {
      "Android is downloading the signed APK."
    }
  }

  private fun packageArchiveIdentity(file: File): InstalledIdentity {
    val flags =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        PackageManager.GET_SIGNING_CERTIFICATES
      } else {
        @Suppress("DEPRECATION")
        PackageManager.GET_SIGNATURES
      }
    @Suppress("DEPRECATION")
    val info = activity.packageManager.getPackageArchiveInfo(file.absolutePath, flags)
      ?: throw UpdaterFailure("Android could not parse the update package")
    return identityFromPackageInfo(info)
  }

  private fun installedIdentity(): InstalledIdentity {
    val flags =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        PackageManager.GET_SIGNING_CERTIFICATES
      } else {
        @Suppress("DEPRECATION")
        PackageManager.GET_SIGNATURES
      }
    @Suppress("DEPRECATION")
    val info = activity.packageManager.getPackageInfo(activity.packageName, flags)
    return identityFromPackageInfo(info)
  }

  private fun identityFromPackageInfo(info: PackageInfo): InstalledIdentity {
    val signers =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        info.signingInfo?.apkContentsSigners?.map { signatureDigest(it.toByteArray()) }?.toSet()
          ?: emptySet()
      } else {
        @Suppress("DEPRECATION")
        info.signatures?.map { signatureDigest(it.toByteArray()) }?.toSet() ?: emptySet()
      }
    @Suppress("DEPRECATION")
    val versionCode =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
    return InstalledIdentity(
      packageName = info.packageName,
      versionName = info.versionName ?: "",
      versionCode = versionCode,
      signers = signers,
    )
  }

  private fun signatureDigest(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

  private fun sha256Text(value: String): String =
    MessageDigest.getInstance("SHA-256").digest(value.toByteArray(StandardCharsets.UTF_8)).toHex()

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().buffered().use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        ensureWorkerActive()
        val count = input.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
      }
    }
    return digest.digest().toHex()
  }

  private fun resolveAssetDownload(
    browserUrl: String,
    tag: String,
    name: String,
    expectedSize: Long,
    deadline: Long,
  ): String {
    requireOfficialAssetUrl(browserUrl, tag, name)
    var current = browserUrl
    for (redirect in 0..MAX_REDIRECTS) {
      ensureWorkerActive(deadline)
      if (redirect > 0) requireAllowedRedirect(current)
      val connection = openConnection(current, deadline)
      try {
        connection.setRequestProperty("Range", "bytes=0-0")
        val status = connection.responseCode
        if (status in 300..399) {
          if (redirect == MAX_REDIRECTS) throw UpdaterFailure("Too many download redirects")
          current = resolvedRedirect(current, connection.getHeaderField("Location"))
          continue
        }
        if (status != HttpURLConnection.HTTP_OK && status != HttpURLConnection.HTTP_PARTIAL) {
          throw UpdaterFailure("APK download endpoint is unavailable")
        }
        requireAllowedRedirect(current)
        requireFinalDownloadHost(current)
        validateResolvedAssetSize(connection, status, expectedSize)
        return current
      } finally {
        connection.disconnect()
      }
    }
    throw UpdaterFailure("APK download endpoint is unavailable")
  }

  private fun validateResolvedAssetSize(
    connection: HttpURLConnection,
    status: Int,
    expectedSize: Long,
  ) {
    if (expectedSize !in 1L..MAX_APK_BYTES) throw UpdaterFailure("APK size is invalid")
    val resolvedSize =
      if (status == HttpURLConnection.HTTP_PARTIAL) {
        val contentRange = connection.getHeaderField("Content-Range") ?: ""
        val match = Regex("^bytes 0-0/([1-9][0-9]*)$").matchEntire(contentRange)
          ?: throw UpdaterFailure("APK range response is invalid")
        match.groupValues[1].toLongOrNull()
      } else {
        connection.contentLengthLong.takeIf { it >= 0L }
      }
    if (resolvedSize != expectedSize || resolvedSize !in 1L..MAX_APK_BYTES) {
      throw UpdaterFailure("APK endpoint size does not match the manifest")
    }
  }

  private fun readBounded(
    initialUrl: String,
    limit: Int,
    deadline: Long,
    redirectMode: RedirectMode,
  ): ByteArray {
    var current = initialUrl
    for (redirect in 0..MAX_REDIRECTS) {
      ensureWorkerActive(deadline)
      if (redirect > 0) {
        if (redirectMode != RedirectMode.ASSET) throw UpdaterFailure("Unexpected API redirect")
        requireAllowedRedirect(current)
      }
      val connection = openConnection(current, deadline)
      try {
        val status = connection.responseCode
        if (status in 300..399) {
          if (redirectMode != RedirectMode.ASSET || redirect == MAX_REDIRECTS) {
            throw UpdaterFailure("Unexpected network redirect")
          }
          current = resolvedRedirect(current, connection.getHeaderField("Location"))
          continue
        }
        if (status != HttpURLConnection.HTTP_OK) throw UpdaterFailure("Update channel is unavailable")
        val declared = connection.contentLengthLong
        if (declared > limit) throw UpdaterFailure("Update response is oversized")
        val output = ByteArrayOutputStream(minOf(limit, 32 * 1024))
        connection.inputStream.use { input ->
          val buffer = ByteArray(8192)
          var total = 0
          while (true) {
            ensureWorkerActive(deadline)
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            if (total > limit) throw UpdaterFailure("Update response is oversized")
            output.write(buffer, 0, count)
          }
        }
        return output.toByteArray()
      } finally {
        connection.disconnect()
      }
    }
    throw UpdaterFailure("Update channel is unavailable")
  }

  private fun openConnection(url: String, deadline: Long): HttpURLConnection {
    val remaining = (deadline - SystemClock.elapsedRealtime()).coerceAtMost(CONNECTION_TIMEOUT_MS.toLong())
    if (remaining <= 0L) throw UpdaterFailure("Update check timed out")
    val connection = URI(url).toURL().openConnection() as? HttpURLConnection
      ?: throw UpdaterFailure("Update channel is invalid")
    connection.instanceFollowRedirects = false
    connection.connectTimeout = remaining.toInt().coerceAtLeast(1)
    connection.readTimeout = remaining.toInt().coerceAtLeast(1)
    connection.useCaches = false
    connection.setRequestProperty("Accept", "application/vnd.github+json, application/json")
    connection.setRequestProperty("Accept-Encoding", "identity")
    connection.setRequestProperty("User-Agent", USER_AGENT)
    return connection
  }

  private fun resolvedRedirect(current: String, location: String?): String {
    if (location.isNullOrBlank()) throw UpdaterFailure("Redirect is missing a location")
    val target = try {
      URI(current).resolve(location)
    } catch (_: Exception) {
      throw UpdaterFailure("Redirect location is invalid")
    }
    val value = target.toASCIIString()
    requireAllowedRedirect(value)
    return value
  }

  private fun requireOfficialAssetUrl(url: String, tag: String, name: String) {
    val expected =
      "https://github.com/$REPOSITORY_OWNER/$REPOSITORY_NAME/releases/download/$tag/$name"
    val parsed = try {
      URI(url)
    } catch (_: Exception) {
      throw UpdaterFailure("Release asset URL is invalid")
    }
    if (
      url != expected ||
      parsed.scheme != "https" ||
      parsed.rawUserInfo != null ||
      parsed.host?.lowercase(Locale.US) != "github.com" ||
      parsed.port != -1 ||
      parsed.rawQuery != null ||
      parsed.rawFragment != null
    ) {
      throw UpdaterFailure("Release asset URL is outside the official channel")
    }
  }

  private fun requireAllowedRedirect(url: String) {
    val parsed = try {
      URI(url)
    } catch (_: Exception) {
      throw UpdaterFailure("Redirect URL is invalid")
    }
    val host = parsed.host?.lowercase(Locale.US)
    if (
      parsed.scheme != "https" ||
      parsed.rawUserInfo != null ||
      parsed.port !in setOf(-1, 443) ||
      parsed.rawFragment != null ||
      host !in REDIRECT_HOSTS
    ) {
      throw UpdaterFailure("Redirect leaves the approved download hosts")
    }
  }

  private fun requireFinalDownloadHost(url: String) {
    val host = try {
      URI(url).host?.lowercase(Locale.US)
    } catch (_: Exception) {
      null
    }
    if (host !in FINAL_DOWNLOAD_HOSTS) {
      throw UpdaterFailure("APK download did not resolve to an approved asset host")
    }
  }

  private fun candidateStillNewer(candidate: Candidate): Boolean {
    return try {
      candidate.packageName == activity.packageName &&
        isVersionCodeUpgrade(candidate.versionCode, installedIdentity().versionCode) &&
        validateCandidate(candidate)
    } catch (_: Exception) {
      false
    }
  }

  private fun isVersionCodeUpgrade(candidateVersionCode: Long, installedVersionCode: Long): Boolean =
    candidateVersionCode in 1L..Int.MAX_VALUE.toLong() && candidateVersionCode > installedVersionCode

  private fun checkedReleaseHistoryBytes(current: Int, next: Int): Int {
    if (current < 0 || next !in 0..MAX_RELEASE_PAGE_BYTES || current > MAX_RELEASE_TOTAL_BYTES - next) {
      throw UpdaterFailure("Release history is oversized")
    }
    return current + next
  }

  private fun releaseHistoryEnded(itemCount: Int): Boolean {
    if (itemCount !in 0..RELEASES_PER_PAGE) throw UpdaterFailure("Release page is oversized")
    return itemCount < RELEASES_PER_PAGE
  }

  private fun expectedVersionCode(version: SemanticVersion): Long {
    if (version.minor !in 0..999 || version.patch !in 0..999) {
      throw UpdaterFailure("Android version components are out of range")
    }
    val code = version.major.toLong() * 1_000_000L + version.minor.toLong() * 1_000L + version.patch
    if (code !in 1L..Int.MAX_VALUE.toLong()) throw UpdaterFailure("Android version code is out of range")
    return code
  }

  private fun downloadNeedsPolling(status: Int): Boolean =
    status == DownloadManager.STATUS_PENDING ||
      status == DownloadManager.STATUS_RUNNING ||
      status == DownloadManager.STATUS_PAUSED

  private fun validateCandidate(candidate: Candidate): Boolean {
    val match = TAG_PATTERN.matchEntire(candidate.tag) ?: return false
    if (candidate.tag.removePrefix("android-v") != candidate.version) return false
    val semantic =
      SemanticVersion(
        match.groupValues[1].toInt(),
        match.groupValues[2].toInt(),
        match.groupValues[3].toInt(),
      )
    if (candidate.versionCode != expectedVersionCode(semantic)) return false
    if (candidate.apkName != "YAWF.Stream_Android_${candidate.version}.apk") return false
    if (!SHA256_PATTERN.matches(candidate.sha256)) return false
    if (candidate.size !in 1L..MAX_APK_BYTES) return false
    if (candidate.releaseDigest != null && candidate.releaseDigest != candidate.sha256) return false
    requireOfficialAssetUrl(candidate.browserDownloadUrl, candidate.tag, candidate.apkName)
    return true
  }

  private fun loadCandidate(key: String): Candidate? {
    val raw = preferences.getString(key, null) ?: return null
    if (raw.length > MAX_PERSISTED_CANDIDATE_CHARS) return null
    return try {
      val root = parseJsonObject(raw.toByteArray(StandardCharsets.UTF_8))
      requireKeys(
        root,
        required =
          setOf(
            "tag",
            "version",
            "versionCode",
            "packageName",
            "apkName",
            "sha256",
            "size",
            "browserDownloadUrl",
          ),
        optional = setOf("releaseDigest"),
      )
      val candidate =
        Candidate(
          tag = strictString(root, "tag"),
          version = strictString(root, "version"),
          versionCode = strictLong(root, "versionCode"),
          packageName = strictString(root, "packageName"),
          apkName = strictString(root, "apkName"),
          sha256 = strictString(root, "sha256"),
          size = strictLong(root, "size"),
          browserDownloadUrl = strictString(root, "browserDownloadUrl"),
          releaseDigest =
            if (root.has("releaseDigest")) strictString(root, "releaseDigest") else null,
        )
      if (candidate.packageName == activity.packageName && validateCandidate(candidate)) candidate else null
    } catch (_: Exception) {
      null
    }
  }

  private fun parseJsonObject(bytes: ByteArray): JSONObject =
    parseJson(bytes) as? JSONObject ?: throw UpdaterFailure("Update JSON object is invalid")

  private fun parseJsonArray(bytes: ByteArray): JSONArray =
    parseJson(bytes) as? JSONArray ?: throw UpdaterFailure("Update JSON array is invalid")

  private fun parseJson(bytes: ByteArray): Any {
    val text = decodeUtf8(bytes)
    return try {
      rejectDuplicateJsonKeys(text)
      val tokener = JSONTokener(text)
      val value = tokener.nextValue()
      if (tokener.nextClean().code != 0) throw UpdaterFailure("Update JSON has trailing data")
      value
    } catch (failure: UpdaterFailure) {
      throw failure
    } catch (_: JSONException) {
      throw UpdaterFailure("Update JSON is invalid")
    }
  }

  private fun decodeUtf8(bytes: ByteArray): String {
    return try {
      StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString()
    } catch (_: Exception) {
      throw UpdaterFailure("Update JSON is not valid UTF-8")
    }
  }

  private fun rejectDuplicateJsonKeys(text: String) {
    JsonDuplicateKeyScanner(text).scan()
  }

  private fun requireKeys(root: JSONObject, required: Set<String>, optional: Set<String>) {
    val keys = mutableSetOf<String>()
    val iterator = root.keys()
    while (iterator.hasNext()) keys.add(iterator.next())
    if (!keys.containsAll(required) || (keys - required - optional).isNotEmpty()) {
      throw UpdaterFailure("Update JSON fields are invalid")
    }
  }

  private fun strictString(root: JSONObject, key: String): String {
    val value = root.opt(key)
    if (value !is String || value.isEmpty()) throw UpdaterFailure("Update JSON string is invalid")
    return value
  }

  private fun strictLong(root: JSONObject, key: String): Long {
    val value = root.opt(key)
    if (
      value !is Byte && value !is Short && value !is Int && value !is Long ||
      !INTEGER_PATTERN.matches(value.toString())
    ) {
      throw UpdaterFailure("Update JSON integer is invalid")
    }
    return try {
      value.toString().toLong()
    } catch (_: NumberFormatException) {
      throw UpdaterFailure("Update JSON integer is out of range")
    }
  }

  private fun <T> submit(
    operation: Operation,
    work: () -> T,
    failure: (() -> Unit)? = null,
    success: (T) -> Unit,
  ) {
    cancelOperation()
    this.operation = operation
    val serial = ++operationSerial
    operationFuture =
      worker.submit {
        try {
          val result = work()
          main.post {
            if (destroyed || serial != operationSerial) return@post
            operationFuture = null
            this.operation = null
            success(result)
          }
        } catch (_: InterruptedException) {
          Thread.currentThread().interrupt()
        } catch (_: Exception) {
          main.post {
            if (destroyed || serial != operationSerial) return@post
            operationFuture = null
            this.operation = null
            if (
              (operation == Operation.CHECK_AUTOMATIC || operation == Operation.CHECK_MANUAL) &&
              automaticChecksEnabled()
            ) {
              recordAutomaticCheckFailure()
            }
            if (failure != null) {
              failure()
            } else if (operation == Operation.CHECK_AUTOMATIC) {
              // Automatic checks stay silent on failure.
            } else {
              dismissDialog()
              if (activityReady()) {
                showInformationalDialog(
                  title = "Update check unavailable",
                  message = "The official Android update channel could not be checked. Try again later.",
                )
              } else {
                preferences.edit().putInt(KEY_PENDING_CHECK_RESULT, CHECK_RESULT_FAILED).apply()
              }
            }
          }
        }
      }
  }

  private fun cancelOperation() {
    operationSerial += 1
    operationFuture?.cancel(true)
    operationFuture = null
    operation = null
  }

  private fun cancelOperationAndDismiss() {
    cancelOperation()
    dismissDialog()
  }

  private fun dismissDialog() {
    val current = dialog
    dialog = null
    dialogState = null
    try {
      current?.dismiss()
    } catch (_: Exception) {
      // The Activity window may already be gone.
    }
  }

  private fun activityReady(): Boolean =
    !destroyed &&
      !activity.isFinishing &&
      !(Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && activity.isDestroyed) &&
      activity.window?.decorView?.isAttachedToWindow == true &&
      foreground &&
      windowHasFocus &&
      activity.hasWindowFocus()

  private fun runOnMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
  }

  private fun ensureWorkerActive(deadline: Long? = null) {
    if (Thread.currentThread().isInterrupted) throw InterruptedException()
    if (deadline != null && SystemClock.elapsedRealtime() >= deadline) {
      throw UpdaterFailure("Update check timed out")
    }
  }

  private data class ReleaseAssets(
    val tag: String,
    val version: String,
    val semanticVersion: SemanticVersion,
    val manifestUrl: String,
    val apkUrl: String,
    val apkDigest: String?,
    val apkSize: Long,
  )

  private data class Candidate(
    val tag: String,
    val version: String,
    val versionCode: Long,
    val packageName: String,
    val apkName: String,
    val sha256: String,
    val size: Long,
    val browserDownloadUrl: String,
    val releaseDigest: String?,
  ) {
    fun toJson(): JSONObject =
      JSONObject()
        .put("tag", tag)
        .put("version", version)
        .put("versionCode", versionCode)
        .put("packageName", packageName)
        .put("apkName", apkName)
        .put("sha256", sha256)
        .put("size", size)
        .put("browserDownloadUrl", browserDownloadUrl)
        .also { if (releaseDigest != null) it.put("releaseDigest", releaseDigest) }
  }

  private data class InstalledIdentity(
    val packageName: String,
    val versionName: String,
    val versionCode: Long,
    val signers: Set<String>,
  )

  private data class DownloadRow(
    val id: Long,
    val status: Int,
    val downloaded: Long,
    val total: Long,
    val localUri: String?,
    val sourceUri: String?,
    val title: String?,
  )

  private data class SemanticVersion(
    val major: Int,
    val minor: Int,
    val patch: Int,
  ) : Comparable<SemanticVersion> {
    override fun compareTo(other: SemanticVersion): Int =
      compareValuesBy(this, other, SemanticVersion::major, SemanticVersion::minor, SemanticVersion::patch)
  }

  private enum class RedirectMode { NONE, ASSET }
  private enum class Operation { CHECK_AUTOMATIC, CHECK_MANUAL, PREPARE_DOWNLOAD, VERIFY }
  private enum class DialogState {
    CONSENT,
    CHECKING,
    AVAILABLE,
    PREPARING,
    DOWNLOADING,
    VERIFYING,
    READY_TO_INSTALL,
    AWAITING_PERMISSION,
    RETRY,
    INFORMATION,
  }

  /**
   * Android's JSONObject keeps only one value for a duplicate member. Scan the original text
   * first so security fields cannot be redefined, including through an escaped member name.
   */
  private class JsonDuplicateKeyScanner(private val text: String) {
    private var index = 0

    fun scan() {
      skipWhitespace()
      scanValue(depth = 0)
      skipWhitespace()
      if (index != text.length) fail()
    }

    private fun scanValue(depth: Int) {
      if (depth > 64 || index >= text.length) fail()
      when (text[index]) {
        '{' -> scanObject(depth + 1)
        '[' -> scanArray(depth + 1)
        '"' -> scanString()
        't' -> scanLiteral("true")
        'f' -> scanLiteral("false")
        'n' -> scanLiteral("null")
        '-', in '0'..'9' -> scanNumber()
        else -> fail()
      }
    }

    private fun scanObject(depth: Int) {
      index += 1
      skipWhitespace()
      if (take('}')) return
      val keys = mutableSetOf<String>()
      while (true) {
        if (index >= text.length || text[index] != '"') fail()
        val key = scanString()
        if (!keys.add(key)) throw UpdaterFailure("Update JSON contains duplicate fields")
        skipWhitespace()
        if (!take(':')) fail()
        skipWhitespace()
        scanValue(depth)
        skipWhitespace()
        if (take('}')) return
        if (!take(',')) fail()
        skipWhitespace()
      }
    }

    private fun scanArray(depth: Int) {
      index += 1
      skipWhitespace()
      if (take(']')) return
      while (true) {
        scanValue(depth)
        skipWhitespace()
        if (take(']')) return
        if (!take(',')) fail()
        skipWhitespace()
      }
    }

    private fun scanString(): String {
      if (!take('"')) fail()
      val result = StringBuilder()
      while (index < text.length) {
        val character = text[index++]
        when {
          character == '"' -> return result.toString()
          character == '\\' -> {
            if (index >= text.length) fail()
            when (val escaped = text[index++]) {
              '"', '\\', '/' -> result.append(escaped)
              'b' -> result.append('\b')
              'f' -> result.append('\u000c')
              'n' -> result.append('\n')
              'r' -> result.append('\r')
              't' -> result.append('\t')
              'u' -> {
                if (index + 4 > text.length) fail()
                val code = text.substring(index, index + 4).toIntOrNull(16) ?: fail()
                result.append(code.toChar())
                index += 4
              }
              else -> fail()
            }
          }
          character.code < 0x20 -> fail()
          else -> result.append(character)
        }
      }
      fail()
    }

    private fun scanLiteral(literal: String) {
      if (!text.regionMatches(index, literal, 0, literal.length)) fail()
      index += literal.length
    }

    private fun scanNumber() {
      take('-')
      if (take('0')) {
        if (index < text.length && text[index] in '0'..'9') fail()
      } else {
        if (index >= text.length || text[index] !in '1'..'9') fail()
        while (index < text.length && text[index] in '0'..'9') index += 1
      }
      if (take('.')) {
        if (index >= text.length || text[index] !in '0'..'9') fail()
        while (index < text.length && text[index] in '0'..'9') index += 1
      }
      if (index < text.length && (text[index] == 'e' || text[index] == 'E')) {
        index += 1
        if (index < text.length && (text[index] == '+' || text[index] == '-')) index += 1
        if (index >= text.length || text[index] !in '0'..'9') fail()
        while (index < text.length && text[index] in '0'..'9') index += 1
      }
    }

    private fun skipWhitespace() {
      while (index < text.length) {
        val character = text[index]
        if (character != ' ' && character != '\t' && character != '\n' && character != '\r') return
        index += 1
      }
    }

    private fun take(expected: Char): Boolean {
      if (index >= text.length || text[index] != expected) return false
      index += 1
      return true
    }

    private fun fail(): Nothing = throw UpdaterFailure("Update JSON is invalid")
  }

  private class UpdaterFailure(message: String) : Exception(message)

  private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(Locale.US, it.toInt() and 0xff) }

  private fun String.hexToBytes(): ByteArray =
    ByteArray(length / 2) { index -> substring(index * 2, index * 2 + 2).toInt(16).toByte() }

}
