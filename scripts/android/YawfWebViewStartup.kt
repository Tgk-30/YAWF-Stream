package com.tgk30.debridstreamer

import android.webkit.WebView
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.ViewTreeObserver
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.Keep
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewOutcomeReceiver
import androidx.webkit.WebViewStartUpConfig
import androidx.webkit.WebViewStartUpResult
import androidx.webkit.WebViewStartupException
import java.lang.ref.WeakReference
import java.util.concurrent.Executors

/** Private native startup only. No JS interface, intent inspection or persistent state. */
@Keep
internal object YawfWebViewStartup {
  private const val READY = 1
  private const val AUTHORIZED = 2
  private const val CANCELLED = 4
  private const val REFUSED = 5
  private val main = Handler(Looper.getMainLooper())
  private val background = Executors.newSingleThreadExecutor()
  private var gate = YawfWebViewStartupGate()
  private var owner = WeakReference<MainActivity>(null)
  private var ownerKey = Any()
  private var resumed = false
  private var firstFrame = false
  private var retryRequested = false
  private var ticketSequence = 0L
  private var ticket = 0L
  @Volatile private var queuedTicket = 0L
  @Volatile private var cleanupTicket = 0L
  @Volatile private var bridgeBound = false
  @Volatile private var attachedTicket = 0L
  // HOOK_ACCEPTED is not completion: Wry still has fallible work and storage.
  private var acceptedWebView: WebView? = null
  private var acceptedTicket = 0L
  private var acceptedGate: YawfWebViewStartupGate? = null
  private var acceptedOwnerKey: Any? = null

  @Keep @JvmStatic private external fun nativeSignal(kind: Int, ticket: Long)

  // Metadata binding before normal synchronous Tauri super. No WebView API here.
  fun bind(activity: MainActivity) {
    checkMain()
    if (owner.get() === activity) return
    owner.get()?.let { if (attachedTicket == 0L) interruptQueued(it) }
    gate.deactivate(ownerKey)
    owner = WeakReference(activity)
    ownerKey = Any()
    resumed = false
    firstFrame = false
    retryRequested = false
    ticket = nextTicket()
  }

  fun showLoadingIfNeeded(activity: MainActivity) {
    checkMain()
    if (!owns(activity) || attachedTicket != 0L) return
    render(activity)
  }

  fun onResume(activity: MainActivity) {
    checkMain()
    if (!owns(activity)) return
    resumed = true
    if (attachedTicket != 0L) return
    gate.activate(ownerKey, now())
    render(activity)
    maybeStart(activity)
    offerReady()
  }

  fun onPause(activity: MainActivity) {
    checkMain()
    if (!owns(activity)) return
    if (attachedTicket == 0L) interruptQueued(activity)
    resumed = false
    gate.deactivate(ownerKey)
  }

  fun onDestroy(activity: MainActivity) {
    checkMain()
    if (!owns(activity)) return
    if (attachedTicket == 0L) interruptQueued(activity)
    gate.deactivate(ownerKey)
    owner.clear()
    resumed = false
    if (attachedTicket == 0L && !activity.isChangingConfigurations) {
      // A later normal user entry gets a fresh native session, never a stale callback.
      gate = YawfWebViewStartupGate()
      ticket = nextTicket()
    }
  }

  fun isResumed(activity: MainActivity): Boolean = owns(activity) && resumed
  fun isAttachedTo(activity: MainActivity): Boolean = owns(activity) && attachedTicket != 0L

  fun onWebViewCreate(activity: MainActivity, webView: WebView): Boolean {
    checkMain()
    if (!owns(activity) || activity.isFinishing || activity.isDestroyed) return false
    // A healthy, already-warmed process keeps normal configuration recreation.
    if (attachedTicket != 0L) return true
    if (!resumed || queuedTicket != ticket || cleanupTicket != 0L ||
      acceptedWebView != null || gate.tick(now()) != YawfWebViewStartupGate.Phase.READY) {
      interruptQueued(activity)
      main.post { if (owns(activity)) render(activity) }
      return false
    }
    // Retain the actual object synchronously. A later, FIFO JNI callback sees
    // ACTIVITY_PROXY.webview only after Wry's clients/content/plugins/globalref.
    acceptedWebView = webView
    acceptedTicket = ticket
    acceptedGate = gate
    acceptedOwnerKey = ownerKey
    return true
  }

  @Keep @JvmStatic fun constructionStored(request: Long, webView: WebView?): Boolean {
    checkMain()
    val activity = owner.get() ?: return false
    if (webView == null || acceptedWebView !== webView || request != acceptedTicket ||
      request != ticket || acceptedGate !== gate || acceptedOwnerKey !== ownerKey ||
      !usable(activity) || queuedTicket != request || cleanupTicket != 0L || attachedTicket != 0L ||
      !gate.claimHandoff(ownerKey, gate.generation, now())) return false
    attachedTicket = request
    queuedTicket = 0L
    clearAccepted(request)
    return true
  }

  private fun clearAccepted(request: Long) {
    if (acceptedTicket != request) return
    acceptedWebView = null
    acceptedTicket = 0L
    acceptedGate = null
    acceptedOwnerKey = null
  }

  @Keep @JvmStatic fun onBridgeReady() {
    main.post {
      bridgeBound = true
      offerReady()
    }
  }

  @Keep @JvmStatic fun authorizeConstruction(request: Long) {
    // Rust never waits on this Handler from the UI or Tao event-loop thread.
    main.post {
      val activity = owner.get()
      if (activity == null || !usable(activity) || request != ticket || cleanupTicket != 0L ||
        queuedTicket != 0L || gate.tick(now()) != YawfWebViewStartupGate.Phase.READY) {
        signal(REFUSED, request)
      } else {
        queuedTicket = request
        signal(AUTHORIZED, request)
      }
    }
  }

  @Keep @JvmStatic fun constructionFailed(request: Long) {
    main.post {
      if (request != ticket || attachedTicket != 0L) return@post
      gate.failPending(ownerKey, gate.generation, now())
      owner.get()?.let { render(it) }
    }
  }

  @Keep @JvmStatic fun constructionCleared(request: Long) {
    main.post {
      clearAccepted(request)
      if (cleanupTicket == request) cleanupTicket = 0L
      if (queuedTicket == request) queuedTicket = 0L
      owner.get()?.let { render(it); maybeStart(it) }
      offerReady()
    }
  }

  @Keep @JvmStatic fun isConstructionAuthorized(request: Long): Boolean =
    request > 0L && queuedTicket == request && cleanupTicket == 0L && attachedTicket == 0L && now() < gate.deadlineMillis

  @Keep @JvmStatic fun isAttached(request: Long): Boolean = attachedTicket == request && request > 0L

  private fun interruptQueued(activity: MainActivity) {
    if (!owns(activity) || queuedTicket == 0L || attachedTicket != 0L) return
    val cancelled = queuedTicket
    cleanupTicket = cancelled
    queuedTicket = 0L
    gate.failPending(ownerKey, gate.generation, now())
    signal(CANCELLED, cancelled)
  }

  private fun offerReady() {
    val activity = owner.get() ?: return
    if (bridgeBound && usable(activity) && cleanupTicket == 0L && queuedTicket == 0L &&
      gate.tick(now()) == YawfWebViewStartupGate.Phase.READY) signal(READY, ticket)
  }

  private fun maybeStart(activity: MainActivity) {
    if (!usable(activity) || !firstFrame || cleanupTicket != 0L || attachedTicket != 0L) return
    val attempt = gate.begin(ownerKey, now(), retryRequested) ?: return
    val wasRetry = retryRequested
    retryRequested = false
    ticket = nextTicket()
    if (wasRetry) render(activity)
    val currentGate = gate
    main.postAtTime({
      if (gate !== currentGate || gate.generation != attempt || attachedTicket != 0L) return@postAtTime
      if (gate.tick(now()) == YawfWebViewStartupGate.Phase.TIMED_OUT) {
        owner.get()?.let { interruptQueued(it); render(it) }
      }
    }, SystemClock.uptimeMillis() + (gate.deadlineMillis - now()).coerceAtLeast(0L))
    // Only the stable startup/config APIs are touched before the actual callback.
    try {
      WebViewCompat.startUpWebView(
        activity.applicationContext,
        WebViewStartUpConfig.Builder(background).setShouldRunUiThreadStartUpTasks(true).build(),
        object : WebViewOutcomeReceiver<WebViewStartUpResult, WebViewStartupException> {
          override fun onResult(result: WebViewStartUpResult) { complete(currentGate, attempt, true) }
          override fun onError(error: WebViewStartupException) { complete(currentGate, attempt, false) }
        },
      )
    } catch (_: RuntimeException) {
      complete(currentGate, attempt, false)
    } catch (_: LinkageError) {
      complete(currentGate, attempt, false)
    }
  }

  private fun complete(expected: YawfWebViewStartupGate, attempt: Long, success: Boolean) {
    checkMain()
    if (gate !== expected || !gate.complete(attempt, success, now())) return
    owner.get()?.let { render(it) }
    if (success) offerReady()
  }

  private fun render(activity: MainActivity) {
    if (!owns(activity) || activity.isDestroyed || activity.isFinishing || attachedTicket != 0L) return
    val phase = gate.tick(now())
    val failed = phase == YawfWebViewStartupGate.Phase.FAILED ||
      phase == YawfWebViewStartupGate.Phase.TIMED_OUT || cleanupTicket != 0L
    val layout = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(32, 48, 32, 32)
      setBackgroundColor(Color.rgb(12, 14, 20))
    }
    layout.addView(TextView(activity).apply {
      text = if (failed) "YAWF Stream could not finish starting" else "Starting YAWF Stream"
      textSize = 22f
      setTextColor(Color.WHITE)
      accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    })
    layout.addView(TextView(activity).apply {
      text = if (failed) "The Android web engine did not become ready. You can retry or go back." else "Preparing the Android web engine. You can go back while this finishes."
      textSize = 16f
      setTextColor(Color.WHITE)
    })
    if (failed) layout.addView(Button(activity).apply {
      text = "Retry startup"
      isEnabled = cleanupTicket == 0L && queuedTicket == 0L && resumed
      setOnClickListener {
        if (usable(activity) && cleanupTicket == 0L && queuedTicket == 0L &&
          (gate.phase == YawfWebViewStartupGate.Phase.FAILED || gate.phase == YawfWebViewStartupGate.Phase.TIMED_OUT)) {
          retryRequested = true
          firstFrame = false
          render(activity)
        }
      }
    })
    layout.addView(Button(activity).apply {
      text = "Go back"
      setOnClickListener { if (owns(activity)) { interruptQueued(activity); gate.cancel(ownerKey); activity.finish() } }
    })
    activity.setContentView(layout)
    // Post from the first actual native draw, never inflate a WebView as a splash.
    val listener = object : ViewTreeObserver.OnDrawListener {
      var posted = false
      override fun onDraw() {
        if (posted) return
        posted = true
        layout.post {
          if (layout.viewTreeObserver.isAlive) layout.viewTreeObserver.removeOnDrawListener(this)
          if (owns(activity)) { firstFrame = true; maybeStart(activity) }
        }
      }
    }
    layout.viewTreeObserver.addOnDrawListener(listener)
  }

  private fun signal(kind: Int, value: Long) {
    if (!bridgeBound) return
    try { nativeSignal(kind, value) } catch (_: UnsatisfiedLinkError) { bridgeBound = false }
  }
  private fun usable(activity: MainActivity): Boolean = owns(activity) && resumed &&
    !activity.isFinishing && !activity.isDestroyed && gate.owns(ownerKey)
  private fun owns(activity: MainActivity): Boolean = owner.get() === activity
  private fun nextTicket(): Long { check(ticketSequence < Long.MAX_VALUE); ticketSequence += 1L; return ticketSequence }
  private fun now(): Long = SystemClock.elapsedRealtime()
  private fun checkMain() { check(Looper.myLooper() == Looper.getMainLooper()) }
}
