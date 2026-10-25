package com.yawf.consentfocusfixture

import android.app.Activity
import android.app.AlertDialog
import android.content.DialogInterface
import android.os.Bundle
import android.os.Looper
import android.view.Gravity
import android.view.WindowManager
import android.widget.TextView
import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.ExecutorService
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit

/** Test-only owner for real Activity and AlertDialog lifecycle ordering. */
class ConsentFocusActivity : Activity() {
  private lateinit var updater: YawfAndroidUpdater
  private lateinit var recordingWorker: RecordingExecutorService
  private var failDialogPresentation = false
  private var failedDialogWindowManagerRequests = 0
  private var frameworkBadTokenProbeObserved = false
  private var readinessFocusGate: AlertDialog? = null
  private var readinessFocusGateDismissed = false
  private var readinessFocusLossObserved = false
  private var readinessFocusGainObserved = false

  override fun getSystemService(name: String): Any? {
    if (name == WINDOW_SERVICE && failDialogPresentation) {
      failedDialogWindowManagerRequests += 1
      // This is still the framework WindowManagerImpl required by Dialog/Window. Unlike the
      // Activity manager, the application manager has no Activity window token, so show()
      // reaches WindowManager and fails with the real BadTokenException verified below.
      return applicationContext.getSystemService(name)
    }
    return super.getSystemService(name)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    resetObservations()
    setContentView(
      TextView(this).apply {
        gravity = Gravity.CENTER
        text = "YAWF consent focus lifecycle fixture"
      },
    )
    recordingWorker = RecordingExecutorService(this)
    updater = constructUpdater(recordingWorker)
  }

  override fun onResume() {
    super.onResume()
    if (::updater.isInitialized) updater.onResume()
  }

  override fun onPause() {
    if (::updater.isInitialized) updater.onPause()
    super.onPause()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (::updater.isInitialized) {
      if (!hasFocus && dialogStateName() == "CONSENT") consentOwnedFocusObserved = true
      if (hasFocus && consentOwnedFocusObserved) focusRestoredAfterConsent = true
      if (!hasFocus && readinessFocusGate?.isShowing == true) readinessFocusLossObserved = true
      if (hasFocus && readinessFocusGateDismissed) readinessFocusGainObserved = true
      updater.onWindowFocusChanged(hasFocus)
    }
  }

  override fun onDestroy() {
    readinessFocusGate?.dismiss()
    readinessFocusGate = null
    if (::updater.isInitialized) updater.onDestroy()
    super.onDestroy()
  }

  fun consentVisibleForTest(): Boolean =
    dialogStateName() == "CONSENT" && currentDialog()?.isShowing == true

  fun checkingVisibleForTest(): Boolean =
    dialogStateName() == "CHECKING" &&
      currentDialog()?.isShowing == true &&
      currentDialog()?.getButton(DialogInterface.BUTTON_NEGATIVE)?.text?.toString() == "Cancel"

  fun clickConsentPositiveAndReadImmediateSubmissionCount(): Int {
    check(consentVisibleForTest())
    currentDialog()!!.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
    return submissionCount
  }

  fun clickCheckingCancelForTest() {
    check(checkingVisibleForTest())
    currentDialog()!!.getButton(DialogInterface.BUTTON_NEGATIVE).performClick()
  }

  fun requestManualCheckForTest() {
    updater.checkManually()
  }

  fun repeatFocusForTest() {
    updater.onWindowFocusChanged(true)
    updater.onWindowFocusChanged(true)
  }

  fun failDialogPresentationForTest() {
    failedDialogWindowManagerRequests = 0
    frameworkBadTokenProbeObserved = false
    failDialogPresentation = true
    var probe: AlertDialog? = null
    var probeCreated = false
    try {
      probe = AlertDialog.Builder(this)
        .setMessage("Test-only unbound-window presentation probe")
        .create()
      probeCreated = true
      probe.show()
    } catch (_: WindowManager.BadTokenException) {
      check(probeCreated) { "BadToken occurred before AlertDialog creation completed" }
      frameworkBadTokenProbeObserved = true
    } finally {
      if (probe?.isShowing == true) probe.dismiss()
    }
    check(frameworkBadTokenProbeObserved) {
      "Unbound framework WindowManager did not reject AlertDialog.show() with BadTokenException"
    }
    // Count only the updater attempt. The probe above exists to prove that this exact
    // WindowManager substitution is a real show-time framework failure rather than a cast or
    // construction failure.
    failedDialogWindowManagerRequests = 0
  }

  fun restoreDialogPresentationForTest() {
    failDialogPresentation = false
  }

  fun frameworkBadTokenProbeObservedForTest(): Boolean = frameworkBadTokenProbeObserved

  fun failedDialogWindowManagerRequestsForTest(): Int = failedDialogWindowManagerRequests

  fun failedUpdaterDialogWasClearedForTest(): Boolean =
    currentDialog() == null && dialogStateName() == null

  fun showReadinessFocusGateForTest() {
    check(!failDialogPresentation)
    check(readinessFocusGate == null)
    readinessFocusGateDismissed = false
    readinessFocusLossObserved = false
    readinessFocusGainObserved = false
    readinessFocusGate = AlertDialog.Builder(this)
      .setMessage("Test-only real focus edge")
      .setCancelable(false)
      .create()
      .also { gate ->
        gate.show()
        check(gate.isShowing) { "Focus gate failed to present" }
      }
  }

  fun dismissReadinessFocusGateForTest() {
    val gate = checkNotNull(readinessFocusGate)
    check(readinessFocusLossObserved) { "Activity never lost focus to the focus gate" }
    check(gate.isShowing)
    readinessFocusGateDismissed = true
    gate.dismiss()
  }

  fun readinessFocusLossObservedForTest(): Boolean = readinessFocusLossObserved

  fun readinessFocusGainObservedForTest(): Boolean = readinessFocusGainObserved

  fun lastSubmissionCancelledForTest(): Boolean = recordingWorker.lastFuture()?.isCancelled == true

  private fun constructUpdater(worker: ExecutorService): YawfAndroidUpdater {
    val constructor = YawfAndroidUpdater::class.java.getDeclaredConstructor(
      Activity::class.java,
      ExecutorService::class.java,
    )
    constructor.isAccessible = true
    return constructor.newInstance(this, worker)
  }

  private fun currentDialog(): AlertDialog? {
    val field = YawfAndroidUpdater::class.java.getDeclaredField("dialog")
    field.isAccessible = true
    return field.get(updater) as? AlertDialog
  }

  private fun dialogStateName(): String? {
    val field = YawfAndroidUpdater::class.java.getDeclaredField("dialogState")
    field.isAccessible = true
    return field.get(updater)?.toString()
  }

  private class RecordingExecutorService(
    private val owner: ConsentFocusActivity,
  ) : AbstractExecutorService() {
    @Volatile private var shutdown = false
    @Volatile private var recordedFuture: Future<*>? = null

    override fun execute(command: Runnable) {
      check(!shutdown)
      submissionCount += 1
      submissionOnMainThread = Looper.myLooper() == Looper.getMainLooper()
      checkingVisibleAtSubmission = owner.checkingVisibleForTest()
      focusRestoredBeforeSubmission = focusRestoredAfterConsent
      recordedFuture = command as? Future<*>
    }

    override fun shutdown() {
      shutdown = true
    }

    override fun shutdownNow(): MutableList<Runnable> {
      shutdown = true
      return mutableListOf()
    }

    override fun isShutdown(): Boolean = shutdown

    override fun isTerminated(): Boolean = shutdown

    override fun awaitTermination(timeout: Long, unit: TimeUnit): Boolean = shutdown

    fun lastFuture(): Future<*>? = recordedFuture
  }

  companion object {
    @Volatile var submissionCount = 0
    @Volatile var submissionOnMainThread = false
    @Volatile var checkingVisibleAtSubmission = false
    @Volatile var focusRestoredBeforeSubmission = false
    @Volatile var consentOwnedFocusObserved = false
    @Volatile var focusRestoredAfterConsent = false

    fun resetObservations() {
      submissionCount = 0
      submissionOnMainThread = false
      checkingVisibleAtSubmission = false
      focusRestoredBeforeSubmission = false
      consentOwnedFocusObserved = false
      focusRestoredAfterConsent = false
    }
  }
}
