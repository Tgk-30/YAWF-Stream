package com.tgk30.debridstreamer

import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.lang.ref.WeakReference
import java.util.WeakHashMap

/**
 * Fits only the WebView's incremental bottom IME overlap. Call on the UI thread.
 * The host must exclusively own this WebView's inset-listener slot and bottom
 * margin for this controller's lifetime. No shared parent listener is replaced.
 */
class YawfImeController(
  private val webView: WebView,
  private val onUnsupported: (AttachResult) -> Unit = {},
) {
  enum class AttachResult {
    NOT_ATTACHED, WAITING_FOR_ATTACHMENT, ATTACHED,
    LISTENER_OWNERSHIP_REQUIRED, LISTENER_CONFLICT,
    UNSUPPORTED_PARENT, UNSUPPORTED_LAYOUT, OWNERSHIP_CHANGED, DESTROYED,
  }

  var status = AttachResult.NOT_ATTACHED
    private set

  private var started = false
  private var destroyed = false
  private var capturedParent: ViewGroup? = null
  private var capturedLayout: ViewGroup.MarginLayoutParams? = null
  private var baselineBottom = 0
  private var appliedBottom = 0

  private val attachment = object : View.OnAttachStateChangeListener {
    override fun onViewAttachedToWindow(view: View) {
      if (bindAttachedLayout()) ViewCompat.requestApplyInsets(webView)
    }

    override fun onViewDetachedFromWindow(view: View) {
      restoreOwnedMargin()
      if (status == AttachResult.ATTACHED) status = AttachResult.WAITING_FOR_ATTACHMENT
    }
  }

  fun attach(exclusiveWebViewListener: Boolean): AttachResult {
    if (destroyed) return AttachResult.DESTROYED
    if (started) return status
    if (!exclusiveWebViewListener) {
      status = AttachResult.LISTENER_OWNERSHIP_REQUIRED
      return status
    }
    val owner = owners[webView]?.get()
    if (owner != null && owner !== this) {
      status = AttachResult.LISTENER_CONFLICT
      return status
    }
    owners[webView] = WeakReference(this)
    started = true
    status = AttachResult.WAITING_FOR_ATTACHMENT
    webView.addOnAttachStateChangeListener(attachment)
    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
      if (destroyed || status != AttachResult.ATTACHED || !webView.isAttachedToWindow) {
        return@setOnApplyWindowInsetsListener applyDefaultInsets(insets)
      }
      if (!ownsCurrentLayout()) {
        reject(AttachResult.OWNERSHIP_CHANGED)
        return@setOnApplyWindowInsetsListener applyDefaultInsets(insets)
      }
      val layout = capturedLayout ?: return@setOnApplyWindowInsetsListener applyDefaultInsets(insets)
      val imeType = WindowInsetsCompat.Type.ime()
      val persistentBottom = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      ).bottom
      val imeBottom = if (insets.isVisible(imeType)) insets.getInsets(imeType).bottom else 0
      val overlap = maxOf(0, imeBottom - persistentBottom)
      val nextBottom = baselineBottom + overlap
      if (layout.bottomMargin != nextBottom) {
        layout.bottomMargin = nextBottom
        appliedBottom = nextBottom
        webView.requestLayout()
      }
      // Apply the WebView's default policy even on owned deliveries, clearing
      // any earlier native IME resize while preserving hide notifications and
      // persistent insets. Only the overlap fitted above is zeroed.
      applyDefaultInsets(WindowInsetsCompat.Builder(insets).setInsets(imeType, Insets.NONE).build())
    }
    // Wry calls onWebViewCreate before setContentView, so parent can be null.
    if (webView.isAttachedToWindow && bindAttachedLayout()) {
      ViewCompat.requestApplyInsets(webView)
    }
    return status
  }

  fun onConfigurationChanged() {
    if (started && !destroyed && status == AttachResult.ATTACHED) {
      if (!ownsCurrentLayout()) reject(AttachResult.OWNERSHIP_CHANGED)
      else ViewCompat.requestApplyInsets(webView)
    }
  }

  fun destroy() {
    if (destroyed) return
    destroyed = true
    restoreOwnedMargin()
    webView.removeOnAttachStateChangeListener(attachment)
    if (owners[webView]?.get() === this) {
      ViewCompat.setOnApplyWindowInsetsListener(webView, null)
      owners.remove(webView)
      ViewCompat.requestApplyInsets(webView)
    }
    started = false
    status = AttachResult.DESTROYED
  }

  private fun bindAttachedLayout(): Boolean {
    if (!started || destroyed || status !in setOf(
        AttachResult.WAITING_FOR_ATTACHMENT, AttachResult.ATTACHED,
      )) return false
    val parent = webView.parent as? ViewGroup
      ?: return reject(AttachResult.UNSUPPORTED_PARENT)
    val layout = webView.layoutParams as? ViewGroup.MarginLayoutParams
      ?: return reject(AttachResult.UNSUPPORTED_LAYOUT)
    if (capturedParent == null) {
      capturedParent = parent
      capturedLayout = layout
      baselineBottom = layout.bottomMargin
      appliedBottom = baselineBottom
    } else if (!ownsCurrentLayout()) {
      return reject(AttachResult.OWNERSHIP_CHANGED)
    }
    status = AttachResult.ATTACHED
    return true
  }

  private fun ownsCurrentLayout(): Boolean =
    webView.parent === capturedParent && webView.layoutParams === capturedLayout &&
      capturedLayout?.bottomMargin == appliedBottom

  // A listener replaces View.onApplyWindowInsets. Returning the raw object
  // alone would suppress the WebView's default resize policy on fallback.
  private fun applyDefaultInsets(insets: WindowInsetsCompat): WindowInsetsCompat =
    ViewCompat.onApplyWindowInsets(webView, insets)

  private fun restoreOwnedMargin() {
    val layout = capturedLayout ?: return
    // A foreign replacement or bottom-margin write must not be overwritten.
    if (layout.bottomMargin != appliedBottom) return
    if (layout.bottomMargin != baselineBottom) {
      layout.bottomMargin = baselineBottom
      appliedBottom = baselineBottom
      if (webView.layoutParams === layout) webView.requestLayout()
    }
  }

  private fun reject(reason: AttachResult): Boolean {
    restoreOwnedMargin()
    status = reason
    onUnsupported(reason)
    return false
  }

  private companion object {
    val owners = WeakHashMap<WebView, WeakReference<YawfImeController>>()
  }
}
