package com.tgk30.debridstreamer

import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebChromeClient.CustomViewCallback
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/** Owns only Chromium's standard fullscreen custom view, never the media session. */
@Suppress("DEPRECATION")
class YawfFullscreenController(
  private val activity: ComponentActivity,
  private val webView: WebView,
) {
  private class Session(
    val view: View,
    val callback: CustomViewCallback,
    val container: FrameLayout,
    val decor: ViewGroup,
    val webViewVisibility: Int,
    val systemUiVisibility: Int,
    val fullscreenFlag: Int,
    val barsBehavior: Int,
    val statusVisible: Boolean,
    val navigationVisible: Boolean,
    val captionVisible: Boolean,
  )

  private var session: Session? = null
  private var destroyed = false
  private val back = object : OnBackPressedCallback(false) {
    override fun handleOnBackPressed() { hide() }
  }

  init {
    // Wry installs its navigation callback before onWebViewCreate. This callback
    // has priority only while a custom view is actually attached.
    activity.onBackPressedDispatcher.addCallback(activity, back)
  }

  fun show(view: View, callback: CustomViewCallback) {
    val current = session
    if (current != null) {
      // Do not cancel the active request if Chromium repeats the same callback.
      if (current.callback !== callback) callback.onCustomViewHidden()
      return
    }
    val decor = activity.window.decorView as? ViewGroup
    val insets = decor?.let(ViewCompat::getRootWindowInsets)
    if (destroyed || activity.isFinishing || activity.isDestroyed ||
      decor == null || insets == null || view.parent != null) {
      callback.onCustomViewHidden()
      return
    }
    val bars = WindowCompat.getInsetsController(activity.window, decor)
    val container = FrameLayout(activity).apply { setBackgroundColor(Color.BLACK) }
    val next = Session(
      view, callback, container, decor, webView.visibility, decor.systemUiVisibility,
      activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_FULLSCREEN,
      bars.systemBarsBehavior,
      insets.isVisible(WindowInsetsCompat.Type.statusBars()),
      insets.isVisible(WindowInsetsCompat.Type.navigationBars()),
      insets.isVisible(WindowInsetsCompat.Type.captionBar()),
    )
    session = next
    try {
      container.addView(view, FrameLayout.LayoutParams(-1, -1))
      decor.addView(container, ViewGroup.LayoutParams(-1, -1))
      webView.visibility = View.INVISIBLE
      back.isEnabled = true
      applyImmersive()
      container.requestFocus()
    } catch (_: RuntimeException) {
      hide()
    }
  }

  fun hide() {
    val previous = session ?: return
    // Consume before invoking Chromium, which may synchronously call hide again.
    session = null
    back.isEnabled = false
    try {
      previous.container.removeView(previous.view)
      previous.decor.removeView(previous.container)
      webView.visibility = previous.webViewVisibility
      val bars = WindowCompat.getInsetsController(activity.window, previous.decor)
      bars.systemBarsBehavior = previous.barsBehavior
      restoreBar(bars, WindowInsetsCompat.Type.statusBars(), previous.statusVisible)
      restoreBar(bars, WindowInsetsCompat.Type.navigationBars(), previous.navigationVisible)
      restoreBar(bars, WindowInsetsCompat.Type.captionBar(), previous.captionVisible)
      // AndroidX's pre-30 path also changes legacy flags. Restore those exactly.
      activity.window.setFlags(previous.fullscreenFlag, WindowManager.LayoutParams.FLAG_FULLSCREEN)
      previous.decor.systemUiVisibility = previous.systemUiVisibility
      // requestedOrientation is deliberately never changed, including on rotation.
    } finally {
      previous.callback.onCustomViewHidden()
    }
  }

  fun onConfigurationChanged() {
    // MATCH_PARENT follows the new bounds without replacing/reloading the video.
    if (session != null) applyImmersive()
  }

  fun destroy() {
    destroyed = true
    try { hide() } finally { back.remove() }
  }

  private fun applyImmersive() {
    val bars = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
    bars.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    bars.hide(WindowInsetsCompat.Type.systemBars())
  }

  private fun restoreBar(bars: WindowInsetsControllerCompat, type: Int, visible: Boolean) {
    if (visible) bars.show(type) else bars.hide(type)
  }
}
