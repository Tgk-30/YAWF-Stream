package com.tgk30.debridstreamer

import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient.CustomViewCallback
import android.webkit.WebView
import androidx.activity.ComponentActivity

private var assertions = 0
private fun verify(condition: Boolean, message: String) {
  check(condition) { message }
  assertions++
}

private class Callback : CustomViewCallback {
  var count = 0
  var reenter: (() -> Unit)? = null
  override fun onCustomViewHidden() { count++; reenter?.invoke() }
}

fun main() {
  // Exercise every combination of preexisting status/navigation/caption visibility,
  // including a WebView that was not initially visible and legacy fullscreen flags.
  for (mask in 0..7) {
    val activity = ComponentActivity()
    val window = activity.window
    window.visibleMask = mask
    window.bars.systemBarsBehavior = 17
    window.decorView.systemUiVisibility = 123
    window.attributes.flags = 1024 or 128
    activity.requestedOrientation = 7
    val webView = WebView().apply { visibility = 8 }
    val controller = YawfFullscreenController(activity, webView)
    val view = View()
    val callback = Callback()
    controller.show(view, callback)
    verify(view.parent != null && view.parent?.parent === window.decorView, "actual custom view must be attached")
    verify(view.parent?.layoutWidth == -1 && view.parent?.layoutHeight == -1, "container must fill decor")
    verify(webView.visibility == View.INVISIBLE, "WebView must be hidden without pausing it")
    verify(window.visibleMask == 0, "all system bars must be hidden")
    verify(callback.count == 0, "do not cancel the accepted request")
    controller.show(view, callback)
    verify(callback.count == 0, "identical duplicate must not cancel active request")
    val duplicate = Callback()
    controller.show(View(), duplicate)
    verify(duplicate.count == 1 && callback.count == 0, "reject only new duplicate request")
    controller.onConfigurationChanged()
    verify(view.parent != null && callback.count == 0, "configuration must preserve current surface")
    verify(activity.requestedOrientation == 7, "orientation policy must remain untouched")
    callback.reenter = { controller.hide() }
    activity.onBackPressedDispatcher.press()
    verify(callback.count == 1 && view.parent == null, "Back exits fullscreen once")
    verify(window.decorView.children.isEmpty(), "Back must remove overlay")
    verify(activity.onBackPressedDispatcher.fallbackCount == 0, "Back must not leave app")
    verify(window.visibleMask == mask, "restore exact prior bar visibility")
    verify(window.bars.systemBarsBehavior == 17, "restore prior bar behavior")
    verify(window.decorView.systemUiVisibility == 123 && window.attributes.flags == 1152, "restore exact legacy flags")
    verify(webView.visibility == 8, "restore exact WebView visibility")
    controller.hide()
    controller.destroy()
    verify(callback.count == 1, "hide and destroy after Back must be no-op")
    activity.onBackPressedDispatcher.press()
    verify(activity.onBackPressedDispatcher.fallbackCount == 1, "normal Back must resume after exit")
  }
  run {
    val activity = ComponentActivity()
    val controller = YawfFullscreenController(activity, WebView())
    val callback = Callback()
    val view = View()
    controller.show(view, callback)
    controller.destroy()
    controller.destroy()
    verify(callback.count == 1 && view.parent == null, "destroy must detach and notify only once")
    val late = Callback()
    controller.show(View(), late)
    verify(late.count == 1 && activity.window.decorView.children.isEmpty(), "destroyed controller rejects late show")
  }
  for (failure in listOf("finishing", "destroyed", "insets", "parent", "attach")) {
    val activity = ComponentActivity()
    val webView = WebView()
    val controller = YawfFullscreenController(activity, webView)
    val view = View()
    when (failure) {
      "finishing" -> activity.isFinishing = true
      "destroyed" -> activity.isDestroyed = true
      "insets" -> activity.window.decorView.hasInsets = false
      "parent" -> ViewGroup().addView(view, ViewGroup.LayoutParams(-1, -1))
      "attach" -> activity.window.decorView.failNextAdd = true
    }
    val callback = Callback()
    controller.show(view, callback)
    verify(callback.count == 1 && activity.window.decorView.children.isEmpty(), "failed show must release: $failure")
    verify(webView.visibility == 0 && activity.window.visibleMask == 7, "failed show must preserve state: $failure")
    controller.destroy()
    verify(callback.count == 1, "failed request cannot notify again: $failure")
  }
  println("YawfFullscreenController behavior assertions passed: $assertions")
}
