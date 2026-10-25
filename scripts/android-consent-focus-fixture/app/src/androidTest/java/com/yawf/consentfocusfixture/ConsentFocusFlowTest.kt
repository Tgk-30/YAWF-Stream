package com.yawf.consentfocusfixture

import android.content.Context
import android.os.SystemClock
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ConsentFocusFlowTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val targetContext = instrumentation.targetContext

  @Test
  fun enableDismissesConsentBeforeFocusReadinessAndVisibleCheckingGatesOneWorker() {
    clearUpdaterPreferences()
    ActivityScenario.launch(ConsentFocusActivity::class.java).use { scenario ->
      waitForActivity(scenario, "initial consent") { it.consentVisibleForTest() }
      scenario.onActivity { activity ->
        assertTrue("Consent dialog never owned focus", ConsentFocusActivity.consentOwnedFocusObserved)
        assertFalse("Activity retained main-window focus behind consent", activity.hasWindowFocus())
        assertEquals(
          "Worker started inside the framework positive callback before consent dismissal",
          0,
          activity.clickConsentPositiveAndReadImmediateSubmissionCount(),
        )
      }

      waitForActivity(scenario, "one worker after CHECKING presentation") {
        ConsentFocusActivity.submissionCount == 1 && it.checkingVisibleForTest()
      }
      assertTrue("Submission did not run on the Android main thread", ConsentFocusActivity.submissionOnMainThread)
      assertTrue("CHECKING with Cancel was not visible at submission", ConsentFocusActivity.checkingVisibleAtSubmission)
      assertTrue("Main-window focus did not return after consent", ConsentFocusActivity.focusRestoredBeforeSubmission)

      scenario.onActivity { it.repeatFocusForTest() }
      instrumentation.waitForIdleSync()
      assertEquals("Duplicate focus submitted another worker", 1, ConsentFocusActivity.submissionCount)

      scenario.onActivity {
        it.requestManualCheckForTest()
        it.clickCheckingCancelForTest()
      }
      waitForActivity(scenario, "Cancel invalidation") { it.lastSubmissionCancelledForTest() }
      SystemClock.sleep(300L)
      scenario.onActivity { it.repeatFocusForTest() }
      instrumentation.waitForIdleSync()
      assertEquals("Cancel restarted a manual request queued behind CHECKING", 1, ConsentFocusActivity.submissionCount)
    }
  }

  @Test
  fun backgroundManualIntentPerformsNoIoUntilARealResumedFocusCanShowChecking() {
    seedGrantedManualOnlyConsent()
    ActivityScenario.launch(ConsentFocusActivity::class.java).use { scenario ->
      instrumentation.waitForIdleSync()
      assertEquals(0, ConsentFocusActivity.submissionCount)

      scenario.moveToState(Lifecycle.State.STARTED)
      scenario.onActivity { it.requestManualCheckForTest() }
      SystemClock.sleep(300L)
      instrumentation.waitForIdleSync()
      assertEquals("Background manual intent submitted worker I/O", 0, ConsentFocusActivity.submissionCount)

      scenario.moveToState(Lifecycle.State.RESUMED)
      waitForActivity(scenario, "resumed CHECKING presentation") {
        ConsentFocusActivity.submissionCount == 1 && it.checkingVisibleForTest()
      }
      assertTrue(ConsentFocusActivity.submissionOnMainThread)
      assertTrue(ConsentFocusActivity.checkingVisibleAtSubmission)
      scenario.onActivity { it.clickCheckingCancelForTest() }
      waitForActivity(scenario, "background test Cancel invalidation") { it.lastSubmissionCancelledForTest() }
    }
  }

  @Test
  fun failedCheckingPresentationWaitsForANewRealReadinessEdgeWithoutWorkerOrSpin() {
    seedGrantedManualOnlyConsent()
    ActivityScenario.launch(ConsentFocusActivity::class.java).use { scenario ->
      waitForActivity(scenario, "focused activity") { it.hasWindowFocus() }
      scenario.onActivity {
        it.failDialogPresentationForTest()
        assertTrue(
          "Fixture did not prove a real AlertDialog.show BadToken failure",
          it.frameworkBadTokenProbeObservedForTest(),
        )
        it.requestManualCheckForTest()
      }
      SystemClock.sleep(500L)
      instrumentation.waitForIdleSync()
      scenario.onActivity { activity ->
        assertEquals("Failed presentation submitted worker I/O", 0, ConsentFocusActivity.submissionCount)
        assertEquals(
          "Failed presentation retried without a new readiness edge",
          1,
          activity.failedDialogWindowManagerRequestsForTest(),
        )
        assertTrue("Updater retained failed dialog state", activity.failedUpdaterDialogWasClearedForTest())
        activity.restoreDialogPresentationForTest()
        activity.showReadinessFocusGateForTest()
      }
      waitForActivity(scenario, "real framework focus loss") {
        it.readinessFocusLossObservedForTest()
      }
      scenario.onActivity { it.dismissReadinessFocusGateForTest() }
      waitForActivity(scenario, "real framework focus gain") {
        it.readinessFocusGainObservedForTest()
      }
      waitForActivity(scenario, "CHECKING after a new readiness edge") {
        ConsentFocusActivity.submissionCount == 1 && it.checkingVisibleForTest()
      }
      assertEquals("Real readiness edge submitted more than one worker", 1, ConsentFocusActivity.submissionCount)
      scenario.onActivity { it.clickCheckingCancelForTest() }
      waitForActivity(scenario, "failed-presentation test Cancel invalidation") {
        it.lastSubmissionCancelledForTest()
      }
    }
  }

  private fun clearUpdaterPreferences() {
    assertTrue(
      targetContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
        .edit().clear().commit(),
    )
  }

  private fun seedGrantedManualOnlyConsent() {
    assertTrue(
      targetContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
        .edit().clear()
        .putInt(KEY_NETWORK_CONSENT, CONSENT_GRANTED)
        .putBoolean(KEY_AUTOMATIC_CHECKS, false)
        .commit(),
    )
  }

  private fun waitForActivity(
    scenario: ActivityScenario<ConsentFocusActivity>,
    label: String,
    condition: (ConsentFocusActivity) -> Boolean,
  ) {
    val deadline = SystemClock.uptimeMillis() + 10_000L
    while (SystemClock.uptimeMillis() < deadline) {
      var matched = false
      scenario.onActivity { matched = condition(it) }
      if (matched) return
      SystemClock.sleep(25L)
    }
    throw AssertionError("Timed out waiting for $label")
  }

  companion object {
    private const val PREFERENCES_NAME = "yawf_android_updater_v1"
    private const val KEY_AUTOMATIC_CHECKS = "automatic_checks"
    private const val KEY_NETWORK_CONSENT = "network_consent"
    private const val CONSENT_GRANTED = 1
  }
}
