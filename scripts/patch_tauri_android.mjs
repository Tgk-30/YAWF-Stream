#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const generatedAndroidRelativePath = "web/src-tauri/gen/android";
const cleartextPlaceholder = 'manifestPlaceholders["usesCleartextTraffic"]';
const webkitDependency = 'implementation("androidx.webkit:webkit:1.14.0")';
const minimumWebViewMajorVersion = 90;
const leanbackFeatureTemplate = `    <!-- AndroidTV support -->
    <uses-feature android:name="android.software.leanback" android:required="false" />

`;
const leanbackCategoryTemplate = `                <!-- AndroidTV support -->
                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
`;

function findMainActivity(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const result = findMainActivity(path);
      if (result != null) return result;
    } else if (entry.isFile() && entry.name === "MainActivity.kt") {
      return path;
    }
  }
  return null;
}

function expectedMainActivity(packageName) {
  return `package ${packageName}

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
`;
}

function legacyPatchedMainActivity(packageName) {
  return `package ${packageName}

import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
    super.onWebViewCreate(webView)
  }
}
`;
}

function darkSystemBarPatchedMainActivity(packageName) {
  return `package ${packageName}

import android.graphics.Color
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
    super.onWebViewCreate(webView)
  }
}
`;
}

function safeAreaPatchedMainActivity(packageName) {
  return `package ${packageName}

import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.view.View
import android.view.ViewTreeObserver
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.annotation.Keep
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.max

private const val SAFE_AREA_BRIDGE_NAME = "__YAWF_NATIVE_SAFE_AREA__"
private const val SAFE_AREA_CHANGE_SCRIPT = "window.dispatchEvent(new Event('yawf-native-safe-area-change'))"
private const val EMPTY_SAFE_AREA = "{\\"top\\":0,\\"right\\":0,\\"bottom\\":0,\\"left\\":0}"

@Keep
class YawfSafeAreaBridge(
  private val snapshot: AtomicReference<String>,
) {
  @JavascriptInterface
  fun getInsets(): String = snapshot.get()
}

class MainActivity : TauriActivity() {
  private val safeAreaSnapshot = AtomicReference(EMPTY_SAFE_AREA)
  private val safeAreaBridge = YawfSafeAreaBridge(safeAreaSnapshot)
  private var safeAreaWebView: WebView? = null
  private var safeAreaLayoutListener: View.OnLayoutChangeListener? = null
  private var safeAreaGlobalLayoutListener: ViewTreeObserver.OnGlobalLayoutListener? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    detachSafeAreaBridge()
    safeAreaWebView = webView
    webView.addJavascriptInterface(safeAreaBridge, SAFE_AREA_BRIDGE_NAME)

    val layoutListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
      refreshSafeAreaInsets(webView)
    }
    val globalLayoutListener = ViewTreeObserver.OnGlobalLayoutListener {
      refreshSafeAreaInsets(webView)
    }
    safeAreaLayoutListener = layoutListener
    safeAreaGlobalLayoutListener = globalLayoutListener
    webView.addOnLayoutChangeListener(layoutListener)
    webView.viewTreeObserver.addOnGlobalLayoutListener(globalLayoutListener)
    webView.post { refreshSafeAreaInsets(webView) }

    CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
    super.onWebViewCreate(webView)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    safeAreaWebView?.post { safeAreaWebView?.let(::refreshSafeAreaInsets) }
  }

  override fun onDestroy() {
    detachSafeAreaBridge()
    super.onDestroy()
  }

  private fun refreshSafeAreaInsets(webView: WebView) {
    if (safeAreaWebView !== webView) return
    if (Looper.myLooper() != Looper.getMainLooper()) {
      webView.post { refreshSafeAreaInsets(webView) }
      return
    }
    val windowInsets = webView.rootWindowInsets ?: return
    var top = windowInsets.systemWindowInsetTop.coerceAtLeast(0)
    var right = windowInsets.systemWindowInsetRight.coerceAtLeast(0)
    var bottom = windowInsets.systemWindowInsetBottom.coerceAtLeast(0)
    var left = windowInsets.systemWindowInsetLeft.coerceAtLeast(0)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      windowInsets.displayCutout?.let { cutout ->
        top = max(top, cutout.safeInsetTop.coerceAtLeast(0))
        right = max(right, cutout.safeInsetRight.coerceAtLeast(0))
        bottom = max(bottom, cutout.safeInsetBottom.coerceAtLeast(0))
        left = max(left, cutout.safeInsetLeft.coerceAtLeast(0))
      }
    }
    val nextSnapshot =
      "{\\"top\\":$top,\\"right\\":$right,\\"bottom\\":$bottom,\\"left\\":$left}"
    if (safeAreaSnapshot.getAndSet(nextSnapshot) != nextSnapshot && safeAreaWebView === webView) {
      webView.evaluateJavascript(SAFE_AREA_CHANGE_SCRIPT, null)
    }
  }

  private fun detachSafeAreaBridge() {
    safeAreaSnapshot.set(EMPTY_SAFE_AREA)
    val webView = safeAreaWebView ?: return
    safeAreaLayoutListener?.let(webView::removeOnLayoutChangeListener)
    safeAreaGlobalLayoutListener?.let { listener ->
      if (webView.viewTreeObserver.isAlive) {
        webView.viewTreeObserver.removeOnGlobalLayoutListener(listener)
      }
    }
    webView.removeJavascriptInterface(SAFE_AREA_BRIDGE_NAME)
    safeAreaLayoutListener = null
    safeAreaGlobalLayoutListener = null
    safeAreaWebView = null
  }
}
`;
}

// Exported only so the patcher contract test can prove upgrade compatibility
// with the exact safe-area template emitted by the previous generator.
export function previousSafeAreaMainActivityForTest(packageName) {
  return safeAreaPatchedMainActivity(packageName);
}

function serverPlayerPatchedMainActivity(packageName) {
  return `package ${packageName}

import android.app.AlertDialog
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.ViewTreeObserver
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.annotation.Keep
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.security.SecureRandom
import java.util.ArrayDeque
import java.util.Locale
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.max

private const val SAFE_AREA_BRIDGE_NAME = "__YAWF_NATIVE_SAFE_AREA__"
private const val SAFE_AREA_CHANGE_SCRIPT = "window.dispatchEvent(new Event('yawf-native-safe-area-change'))"
private const val EMPTY_SAFE_AREA = "{\\"top\\":0,\\"right\\":0,\\"bottom\\":0,\\"left\\":0}"
private const val SERVER_PLAYER_BRIDGE_NAME = "__YAWF_SERVER_PLAYER__"
private const val SERVER_PLAYER_MAX_MESSAGE_BYTES = 12 * 1024
private const val SERVER_PLAYER_MAX_URL_BYTES = 8 * 1024
private const val SERVER_PLAYER_TIMEOUT_MS = 30_000L
private const val SERVER_PLAYER_RATE_WINDOW_MS = 60_000L
private const val SERVER_PLAYER_RATE_LIMIT = 4
private val SERVER_PLAYER_REQUEST_ID = Regex("^[A-Za-z0-9_-]{16,64}$")
private val SERVER_PLAYER_SESSION_ID = Regex("^[A-Za-z0-9_-]{1,120}$")
private val SERVER_PLAYER_CAPABILITY = Regex("^[A-Za-z0-9_-]{32,128}$")
private val SERVER_PLAYER_MOUNT_SEGMENT = Regex("^[A-Za-z0-9._~-]{1,64}$")

private data class ServerPlayerOrigin(
  val scheme: String,
  val host: String,
  val port: Int,
) {
  fun display(): String {
    val displayedHost = if (host.contains(':')) "[" + host + "]" else host
    val defaultPort = if (scheme == "https") 443 else 80
    return scheme + "://" + displayedHost + if (port == defaultPort) "" else ":" + port
  }
}

private data class PendingServerPlayerRequest(
  val requestId: String,
  val url: String,
  val origin: ServerPlayerOrigin,
  val webView: WebView,
  val replyProxy: JavaScriptReplyProxy,
  val timeout: Runnable,
  var challenge: String? = null,
  var dialog: AlertDialog? = null,
)

@Keep
class YawfSafeAreaBridge(
  private val snapshot: AtomicReference<String>,
) {
  @JavascriptInterface
  fun getInsets(): String = snapshot.get()
}

class MainActivity : TauriActivity() {
  private val safeAreaSnapshot = AtomicReference(EMPTY_SAFE_AREA)
  private val safeAreaBridge = YawfSafeAreaBridge(safeAreaSnapshot)
  private val serverPlayerHandler = Handler(Looper.getMainLooper())
  private val serverPlayerRandom = SecureRandom()
  private val serverPlayerAttempts = ArrayDeque<Long>()
  private var safeAreaWebView: WebView? = null
  private var safeAreaLayoutListener: View.OnLayoutChangeListener? = null
  private var safeAreaGlobalLayoutListener: ViewTreeObserver.OnGlobalLayoutListener? = null
  private var serverPlayerListenerWebView: WebView? = null
  private var serverPlayerPending: PendingServerPlayerRequest? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    detachSafeAreaBridge()
    safeAreaWebView = webView
    webView.addJavascriptInterface(safeAreaBridge, SAFE_AREA_BRIDGE_NAME)
    attachServerPlayerBridge(webView)

    val layoutListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
      refreshSafeAreaInsets(webView)
    }
    val globalLayoutListener = ViewTreeObserver.OnGlobalLayoutListener {
      refreshSafeAreaInsets(webView)
    }
    safeAreaLayoutListener = layoutListener
    safeAreaGlobalLayoutListener = globalLayoutListener
    webView.addOnLayoutChangeListener(layoutListener)
    webView.viewTreeObserver.addOnGlobalLayoutListener(globalLayoutListener)
    webView.post { refreshSafeAreaInsets(webView) }

    CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
    super.onWebViewCreate(webView)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    safeAreaWebView?.post { safeAreaWebView?.let(::refreshSafeAreaInsets) }
  }

  override fun onDestroy() {
    detachSafeAreaBridge()
    super.onDestroy()
  }

  private fun attachServerPlayerBridge(webView: WebView) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
    WebViewCompat.addWebMessageListener(
      webView,
      SERVER_PLAYER_BRIDGE_NAME,
      setOf("*"),
    ) { view, message, sourceOrigin, isMainFrame, replyProxy ->
      if (
        isMainFrame &&
        safeAreaWebView === view &&
        serverPlayerListenerWebView === view &&
        message.type == WebMessageCompat.TYPE_STRING
      ) {
        handleServerPlayerMessage(
          view,
          message.data,
          sourceOrigin,
          isMainFrame,
          replyProxy,
        )
      }
    }
    serverPlayerListenerWebView = webView
  }

  private fun handleServerPlayerMessage(
    webView: WebView,
    rawMessage: String?,
    sourceOriginUri: Uri,
    isMainFrame: Boolean,
    replyProxy: JavaScriptReplyProxy,
  ) {
    if (
      !isMainFrame ||
      safeAreaWebView !== webView ||
      serverPlayerListenerWebView !== webView ||
      rawMessage == null ||
      rawMessage.toByteArray(Charsets.UTF_8).size > SERVER_PLAYER_MAX_MESSAGE_BYTES
    ) return
    val sourceOrigin = httpOrigin(sourceOriginUri) ?: return
    if (currentTopOrigin(webView) != sourceOrigin) return

    val message = try {
      JSONObject(rawMessage)
    } catch (_: Exception) {
      return
    }
    val action = message.opt("action") as? String ?: return
    val requestId = message.opt("requestId") as? String ?: return
    if (!SERVER_PLAYER_REQUEST_ID.matches(requestId)) return
    val keys = buildSet {
      val iterator = message.keys()
      while (iterator.hasNext()) add(iterator.next())
    }

    if (action == "cancel" && keys == setOf("action", "requestId")) {
      val pending = serverPlayerPending
      if (
        pending != null &&
        pending.requestId == requestId &&
        pending.webView === webView &&
        pending.replyProxy === replyProxy
      ) {
        finishServerPlayerRequest(pending, "cancelled")
      }
      return
    }
    if (action != "open") return

    val challenge = message.opt("challenge") as? String
    if (challenge != null && keys == setOf("action", "requestId", "challenge")) {
      completeServerPlayerChallenge(
        requestId,
        challenge,
        sourceOrigin,
        webView,
        replyProxy,
      )
      return
    }
    if (keys != setOf("action", "requestId", "url")) return
    val rawUrl = message.opt("url") as? String ?: return
    val target = canonicalServerPlayerUrl(rawUrl, sourceOrigin) ?: run {
      replyServerPlayer(replyProxy, "error", requestId)
      return
    }
    if (serverPlayerPending != null) {
      replyServerPlayer(replyProxy, "error", requestId)
      return
    }
    if (!recordServerPlayerAttempt()) {
      replyServerPlayer(replyProxy, "error", requestId)
      return
    }

    lateinit var pending: PendingServerPlayerRequest
    val timeout = Runnable {
      if (serverPlayerPending === pending) {
        finishServerPlayerRequest(pending, "cancelled")
      }
    }
    pending = PendingServerPlayerRequest(
      requestId = requestId,
      url = target,
      origin = sourceOrigin,
      webView = webView,
      replyProxy = replyProxy,
      timeout = timeout,
    )
    serverPlayerPending = pending
    serverPlayerHandler.postDelayed(timeout, SERVER_PLAYER_TIMEOUT_MS)
    replyServerPlayer(replyProxy, "pending", requestId)
    showServerPlayerConfirmation(pending)
  }

  private fun showServerPlayerConfirmation(pending: PendingServerPlayerRequest) {
    if (!ownsServerPlayerRequest(pending)) {
      finishServerPlayerRequest(pending, "cancelled")
      return
    }
    val dialog = AlertDialog.Builder(this)
      .setTitle("Open external player?")
      .setMessage(
        "Allow " + pending.origin.display() +
          " to open this stream in an external video player?",
      )
      .setPositiveButton("Open player") { _, _ -> beginServerPlayerChallenge(pending) }
      .setNegativeButton("Cancel") { _, _ -> finishServerPlayerRequest(pending, "cancelled") }
      .setOnCancelListener { finishServerPlayerRequest(pending, "cancelled") }
      .create()
    pending.dialog = dialog
    dialog.show()
  }

  private fun beginServerPlayerChallenge(pending: PendingServerPlayerRequest) {
    pending.dialog = null
    if (!ownsServerPlayerRequest(pending)) {
      finishServerPlayerRequest(pending, "cancelled")
      return
    }
    val bytes = ByteArray(32)
    serverPlayerRandom.nextBytes(bytes)
    val challenge = bytes.joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    pending.challenge = challenge
    replyServerPlayer(pending.replyProxy, "confirm", pending.requestId, challenge)
  }

  private fun completeServerPlayerChallenge(
    requestId: String,
    challenge: String,
    sourceOrigin: ServerPlayerOrigin,
    webView: WebView,
    replyProxy: JavaScriptReplyProxy,
  ) {
    val pending = serverPlayerPending ?: return
    if (
      pending.requestId != requestId ||
      pending.challenge != challenge ||
      pending.origin != sourceOrigin ||
      pending.webView !== webView ||
      pending.replyProxy !== replyProxy ||
      !ownsServerPlayerRequest(pending)
    ) return

    clearServerPlayerRequest(pending)
    val viewIntent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(Uri.parse(pending.url), "video/*")
    }
    try {
      startActivity(Intent.createChooser(viewIntent, "Open external player"))
      replyServerPlayer(replyProxy, "success", requestId)
    } catch (_: Exception) {
      replyServerPlayer(replyProxy, "error", requestId)
    }
  }

  private fun ownsServerPlayerRequest(pending: PendingServerPlayerRequest): Boolean =
    serverPlayerPending === pending &&
      safeAreaWebView === pending.webView &&
      serverPlayerListenerWebView === pending.webView &&
      currentTopOrigin(pending.webView) == pending.origin

  private fun finishServerPlayerRequest(
    pending: PendingServerPlayerRequest,
    result: String,
  ) {
    if (serverPlayerPending !== pending) return
    clearServerPlayerRequest(pending)
    replyServerPlayer(pending.replyProxy, result, pending.requestId)
  }

  private fun clearServerPlayerRequest(pending: PendingServerPlayerRequest) {
    if (serverPlayerPending === pending) serverPlayerPending = null
    serverPlayerHandler.removeCallbacks(pending.timeout)
    pending.dialog?.dismiss()
    pending.dialog = null
    pending.challenge = null
  }

  private fun replyServerPlayer(
    replyProxy: JavaScriptReplyProxy,
    type: String,
    requestId: String,
    challenge: String? = null,
  ) {
    val reply = JSONObject()
      .put("type", type)
      .put("requestId", requestId)
    if (challenge != null) reply.put("challenge", challenge)
    try {
      replyProxy.postMessage(reply.toString())
    } catch (_: Exception) {
      // Navigation can invalidate the original per-document reply channel.
    }
  }

  private fun recordServerPlayerAttempt(): Boolean {
    val now = SystemClock.elapsedRealtime()
    while (
      serverPlayerAttempts.isNotEmpty() &&
      now - serverPlayerAttempts.first() >= SERVER_PLAYER_RATE_WINDOW_MS
    ) {
      serverPlayerAttempts.removeFirst()
    }
    if (serverPlayerAttempts.size >= SERVER_PLAYER_RATE_LIMIT) return false
    serverPlayerAttempts.addLast(now)
    return true
  }

  private fun canonicalServerPlayerUrl(
    raw: String,
    sourceOrigin: ServerPlayerOrigin,
  ): String? {
    if (
      raw.isEmpty() ||
      raw != raw.trim() ||
      raw.toByteArray(Charsets.UTF_8).size > SERVER_PLAYER_MAX_URL_BYTES ||
      raw.any { character -> character.code < 0x20 || character.code == 0x7f }
    ) return null
    val uri = try {
      Uri.parse(raw)
    } catch (_: Exception) {
      return null
    }
    val targetOrigin = httpOrigin(uri) ?: return null
    if (
      targetOrigin != sourceOrigin ||
      uri.userInfo != null ||
      uri.encodedQuery != null ||
      uri.encodedFragment != null
    ) return null
    val path = uri.encodedPath ?: return null
    if (
      !path.startsWith('/') ||
      path.endsWith('/') ||
      path.contains('%') ||
      path.contains('\\\\') ||
      path.contains("//")
    ) return null
    val segments = path.removePrefix("/").split('/')
    if (segments.size < 4) return null
    val routeIndex = segments.size - 4
    if (
      segments[routeIndex] != "api" ||
      segments[routeIndex + 1] != "external-stream" ||
      !SERVER_PLAYER_SESSION_ID.matches(segments[routeIndex + 2]) ||
      !SERVER_PLAYER_CAPABILITY.matches(segments[routeIndex + 3]) ||
      segments.take(routeIndex).any { segment ->
        !SERVER_PLAYER_MOUNT_SEGMENT.matches(segment) || segment == "." || segment == ".."
      }
    ) return null
    val canonical = targetOrigin.display() + path
    return if (canonical == raw) canonical else null
  }

  private fun currentTopOrigin(webView: WebView): ServerPlayerOrigin? {
    val current = webView.url ?: return null
    return try {
      httpOrigin(Uri.parse(current))
    } catch (_: Exception) {
      null
    }
  }

  private fun httpOrigin(uri: Uri): ServerPlayerOrigin? {
    val scheme = uri.scheme?.lowercase(Locale.US) ?: return null
    if (scheme != "http" && scheme != "https") return null
    if (uri.userInfo != null) return null
    val parsedHost = uri.host?.lowercase(Locale.US) ?: return null
    val host = if (parsedHost.startsWith('[') && parsedHost.endsWith(']')) {
      parsedHost.removePrefix("[").removeSuffix("]")
    } else {
      parsedHost
    }
    if (host.isEmpty() || host.contains('[') || host.contains(']')) return null
    if (host.isEmpty()) return null
    val port = when {
      uri.port >= 0 -> uri.port
      scheme == "https" -> 443
      else -> 80
    }
    if (port !in 1..65535) return null
    return ServerPlayerOrigin(scheme, host, port)
  }

  private fun refreshSafeAreaInsets(webView: WebView) {
    if (safeAreaWebView !== webView) return
    if (Looper.myLooper() != Looper.getMainLooper()) {
      webView.post { refreshSafeAreaInsets(webView) }
      return
    }
    val windowInsets = webView.rootWindowInsets ?: return
    var top = windowInsets.systemWindowInsetTop.coerceAtLeast(0)
    var right = windowInsets.systemWindowInsetRight.coerceAtLeast(0)
    var bottom = windowInsets.systemWindowInsetBottom.coerceAtLeast(0)
    var left = windowInsets.systemWindowInsetLeft.coerceAtLeast(0)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      windowInsets.displayCutout?.let { cutout ->
        top = max(top, cutout.safeInsetTop.coerceAtLeast(0))
        right = max(right, cutout.safeInsetRight.coerceAtLeast(0))
        bottom = max(bottom, cutout.safeInsetBottom.coerceAtLeast(0))
        left = max(left, cutout.safeInsetLeft.coerceAtLeast(0))
      }
    }
    val nextSnapshot =
      "{\\"top\\":$top,\\"right\\":$right,\\"bottom\\":$bottom,\\"left\\":$left}"
    if (safeAreaSnapshot.getAndSet(nextSnapshot) != nextSnapshot && safeAreaWebView === webView) {
      webView.evaluateJavascript(SAFE_AREA_CHANGE_SCRIPT, null)
    }
  }

  private fun detachSafeAreaBridge() {
    safeAreaSnapshot.set(EMPTY_SAFE_AREA)
    serverPlayerPending?.let { pending -> finishServerPlayerRequest(pending, "cancelled") }
    serverPlayerListenerWebView?.let { webView ->
      if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
        WebViewCompat.removeWebMessageListener(webView, SERVER_PLAYER_BRIDGE_NAME)
      }
    }
    serverPlayerListenerWebView = null
    serverPlayerAttempts.clear()
    val webView = safeAreaWebView ?: return
    safeAreaLayoutListener?.let(webView::removeOnLayoutChangeListener)
    safeAreaGlobalLayoutListener?.let { listener ->
      if (webView.viewTreeObserver.isAlive) {
        webView.viewTreeObserver.removeOnGlobalLayoutListener(listener)
      }
    }
    webView.removeJavascriptInterface(SAFE_AREA_BRIDGE_NAME)
    safeAreaLayoutListener = null
    safeAreaGlobalLayoutListener = null
    safeAreaWebView = null
  }
}
`;
}
function previousPatchedMainActivity(packageName) {
  return serverPlayerPatchedMainActivity(packageName)
    .replace('class MainActivity : TauriActivity() {', 'class MainActivity : TauriActivity() {\n  private lateinit var androidUpdater: YawfAndroidUpdater')
    .replace('    super.onCreate(savedInstanceState)\n  }', '    super.onCreate(savedInstanceState)\n    androidUpdater = YawfAndroidUpdater.attach(this)\n  }')
    .replace('  override fun onDestroy() {', `  override fun onResume() {
    super.onResume()
    if (::androidUpdater.isInitialized) androidUpdater.onResume()
  }

  override fun onPause() {
    if (::androidUpdater.isInitialized) androidUpdater.onPause()
    super.onPause()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (::androidUpdater.isInitialized) androidUpdater.onWindowFocusChanged(hasFocus)
  }

  @Keep
  fun checkAndroidUpdates() {
    runOnUiThread { if (::androidUpdater.isInitialized) androidUpdater.checkManually() }
  }

  override fun onDestroy() {
    if (::androidUpdater.isInitialized) androidUpdater.onDestroy()`);
}

function webViewCompatibleServerPlayerMainActivity(packageName) {
  return serverPlayerPatchedMainActivity(packageName)
    .replace(
      'import android.content.Intent\n',
      `import android.content.ComponentName
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
`,
    )
    .replace(
      'import android.os.SystemClock\n',
      'import android.os.SystemClock\nimport android.provider.Settings\n',
    )
    .replace(
      'private const val EMPTY_SAFE_AREA = "{\\"top\\":0,\\"right\\":0,\\"bottom\\":0,\\"left\\":0}"\n',
      `private const val EMPTY_SAFE_AREA = "{\\"top\\":0,\\"right\\":0,\\"bottom\\":0,\\"left\\":0}"
private const val MINIMUM_WEBVIEW_MAJOR_VERSION = ${minimumWebViewMajorVersion}
private val WEBVIEW_LEADING_MAJOR = Regex("^([0-9]+)(?:[.][0-9A-Za-z][0-9A-Za-z._-]*)?$")
private val WEBVIEW_PROVIDER_PACKAGE =
  Regex("^[A-Za-z][A-Za-z0-9_]*(?:[.][A-Za-z][A-Za-z0-9_]*)+$")
`,
    )
    .replace(
      'private data class ServerPlayerOrigin(\n',
      `private data class WebViewStartupCompatibility(
  val packageName: String?,
  val versionName: String?,
  val majorVersion: Int?,
) {
  val supported: Boolean
    get() =
      packageName != null &&
        majorVersion != null &&
        majorVersion >= MINIMUM_WEBVIEW_MAJOR_VERSION
}

private data class ServerPlayerOrigin(
`,
    )
    .replace(
      'class MainActivity : TauriActivity() {\n',
      `class MainActivity : TauriActivity() {
  private lateinit var webViewCompatibility: WebViewStartupCompatibility
  private var webViewCompatibilityDialog: AlertDialog? = null
  private var webViewSettingsUnavailable = false
`,
    )
    .replace(
      '  override fun onCreate(savedInstanceState: Bundle?) {\n    enableEdgeToEdge(',
      `  override fun onCreate(savedInstanceState: Bundle?) {
    webViewCompatibility = inspectWebViewCompatibility()
    enableEdgeToEdge(`,
    )
    .replace(
      '  override fun onWebViewCreate(webView: WebView) {\n    detachSafeAreaBridge()',
      `  override fun onWebViewCreate(webView: WebView) {
    if (!webViewCompatibility.supported) {
      webView.visibility = View.INVISIBLE
      super.onWebViewCreate(webView)
      return
    }
    detachSafeAreaBridge()`,
    )
    .replace(
      '  override fun onConfigurationChanged(newConfig: Configuration) {',
      `  override fun onResume() {
    super.onResume()
    showWebViewCompatibilityDialog()
  }

  override fun onConfigurationChanged(newConfig: Configuration) {`,
    )
    .replace(
      '  override fun onDestroy() {\n    detachSafeAreaBridge()',
      `  override fun onDestroy() {
    webViewCompatibilityDialog?.dismiss()
    webViewCompatibilityDialog = null
    detachSafeAreaBridge()`,
    )
    .replace(
      '  private fun refreshSafeAreaInsets(webView: WebView) {',
      `  private fun inspectWebViewCompatibility(): WebViewStartupCompatibility {
    val packageInfo = try {
      WebViewCompat.getCurrentWebViewPackage(this)
    } catch (_: Exception) {
      null
    }
    val packageName = packageInfo?.packageName?.takeIf(WEBVIEW_PROVIDER_PACKAGE::matches)
    val versionName = packageInfo?.versionName
    return WebViewStartupCompatibility(
      packageName = packageName,
      versionName = versionName,
      majorVersion = parseLeadingWebViewMajor(versionName),
    )
  }

  private fun parseLeadingWebViewMajor(versionName: String?): Int? {
    if (versionName == null || versionName != versionName.trim()) return null
    val match = WEBVIEW_LEADING_MAJOR.find(versionName) ?: return null
    return match.groupValues[1].toIntOrNull()
  }

  private fun selectedWebViewAppInfoIntent(): Intent? {
    if (webViewSettingsUnavailable) return null
    val packageName = webViewCompatibility.packageName ?: return null
    return try {
      val installed = packageManager.getApplicationInfo(packageName, 0)
      if (installed.packageName != packageName) return null
      val implicitIntent = Intent(
        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        Uri.fromParts("package", packageName, null),
      )
      val resolved = packageManager.resolveActivity(
        implicitIntent,
        PackageManager.MATCH_SYSTEM_ONLY,
      ) ?: return null
      val activityInfo = resolved.activityInfo ?: return null
      if (!activityInfo.exported) return null
      if (activityInfo.applicationInfo.flags and ApplicationInfo.FLAG_SYSTEM == 0) return null
      implicitIntent.setComponent(ComponentName(activityInfo.packageName, activityInfo.name))
    } catch (_: Exception) {
      null
    }
  }

  private fun webViewCompatibilityMessage(settingsAvailable: Boolean): String {
    val packageName = webViewCompatibility.packageName
    val versionName = webViewCompatibility.versionName
      ?.takeIf { value ->
        value.length in 1..80 && value.all { character -> character.code in 0x20..0x7e }
      }
      ?: "unknown"
    val provider = if (packageName == null) {
      "Android did not report a valid active WebView provider."
    } else {
      "Selected provider: " + packageName + ", version " + versionName + "."
    }
    val nextStep = if (settingsAvailable) {
      "Open that exact provider's App info and update or enable it."
    } else {
      "App info for the exact selected provider is unavailable. Open Android Settings and update or enable Android System WebView."
    }
    return "YAWF needs Android System WebView version " +
      MINIMUM_WEBVIEW_MAJOR_VERSION + " or newer. " + provider + " " + nextStep +
      " Then close and reopen YAWF."
  }

  private fun showWebViewCompatibilityDialog() {
    if (webViewCompatibility.supported || isFinishing || isDestroyed) return
    if (webViewCompatibilityDialog?.isShowing == true) return
    val settingsIntent = selectedWebViewAppInfoIntent()
    val builder = AlertDialog.Builder(this)
      .setTitle("Update Android System WebView")
      .setMessage(webViewCompatibilityMessage(settingsIntent != null))
      .setCancelable(false)
      .setNegativeButton("Close YAWF") { _, _ -> finishAndRemoveTask() }
    if (settingsIntent != null) {
      builder.setPositiveButton("Open provider App info") { _, _ ->
        try {
          startActivity(settingsIntent)
        } catch (_: Exception) {
          webViewSettingsUnavailable = true
          window.decorView.post { showWebViewCompatibilityDialog() }
        }
      }
    }
    val dialog = builder.create()
    dialog.setCanceledOnTouchOutside(false)
    dialog.setOnDismissListener {
      if (webViewCompatibilityDialog === dialog) webViewCompatibilityDialog = null
    }
    webViewCompatibilityDialog = dialog
    dialog.show()
  }

  private fun refreshSafeAreaInsets(webView: WebView) {`,
    );
}

function preFullscreenMainActivity(packageName) {
  return webViewCompatibleServerPlayerMainActivity(packageName)
    .replace(
      'class MainActivity : TauriActivity() {',
      'class MainActivity : TauriActivity() {\n  private lateinit var androidUpdater: YawfAndroidUpdater',
    )
    .replace(
      '    super.onCreate(savedInstanceState)\n  }',
      `    super.onCreate(savedInstanceState)
    if (webViewCompatibility.supported) {
      androidUpdater = YawfAndroidUpdater.attach(this)
    }
  }`,
    )
    .replace(
      `  override fun onResume() {
    super.onResume()
    showWebViewCompatibilityDialog()
  }`,
      `  override fun onResume() {
    super.onResume()
    showWebViewCompatibilityDialog()
    if (::androidUpdater.isInitialized) androidUpdater.onResume()
  }`,
    )
    .replace('  override fun onDestroy() {', `  override fun onPause() {
    if (::androidUpdater.isInitialized) androidUpdater.onPause()
    super.onPause()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (::androidUpdater.isInitialized) androidUpdater.onWindowFocusChanged(hasFocus)
  }

  @Keep
  fun checkAndroidUpdates() {
    runOnUiThread { if (::androidUpdater.isInitialized) androidUpdater.checkManually() }
  }

  override fun onDestroy() {
    if (::androidUpdater.isInitialized) androidUpdater.onDestroy()`);
}

// Keep the already-audited Activity generator byte-identical. Fullscreen adds
// lifecycle hooks only; it never replaces Wry's WebChromeClient or JS bridges.
function preImeMainActivity(packageName) {
  return preFullscreenMainActivity(packageName)
    .replace('class MainActivity : TauriActivity() {',
      'class MainActivity : TauriActivity() {\n  private var fullscreenController: YawfFullscreenController? = null')
    .replace('  override fun onWebViewCreate(webView: WebView) {', `  override fun onWebViewCreate(webView: WebView) {
    fullscreenController?.destroy()
    fullscreenController = null`)
    .replace('    CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)',
      '    fullscreenController = YawfFullscreenController(this, webView)\n    CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)')
    .replace('    super.onConfigurationChanged(newConfig)',
      '    super.onConfigurationChanged(newConfig)\n    fullscreenController?.onConfigurationChanged()')
    .replace('  override fun onDestroy() {', `  override fun onDestroy() {
    fullscreenController?.destroy()
    fullscreenController = null`)
    .replace('  private fun inspectWebViewCompatibility()', `  fun showWebFullscreen(view: View, callback: android.webkit.WebChromeClient.CustomViewCallback) {
    val controller = fullscreenController
    if (controller != null) controller.show(view, callback) else callback.onCustomViewHidden()
  }

  fun hideWebFullscreen() {
    fullscreenController?.hide()
  }

  private fun inspectWebViewCompatibility()`);
}

function preGestureMainActivity(packageName) {
  const previous = preImeMainActivity(packageName);
  const legacyInsets = `    val windowInsets = webView.rootWindowInsets ?: return
    var top = windowInsets.systemWindowInsetTop.coerceAtLeast(0)
    var right = windowInsets.systemWindowInsetRight.coerceAtLeast(0)
    var bottom = windowInsets.systemWindowInsetBottom.coerceAtLeast(0)
    var left = windowInsets.systemWindowInsetLeft.coerceAtLeast(0)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      windowInsets.displayCutout?.let { cutout ->
        top = max(top, cutout.safeInsetTop.coerceAtLeast(0))
        right = max(right, cutout.safeInsetRight.coerceAtLeast(0))
        bottom = max(bottom, cutout.safeInsetBottom.coerceAtLeast(0))
        left = max(left, cutout.safeInsetLeft.coerceAtLeast(0))
      }
    }`;
  if (!previous.includes(legacyInsets)) throw new Error("Unsupported persistent inset template.");
  return previous
    .replace('import androidx.annotation.Keep\n', 'import androidx.annotation.Keep\nimport androidx.core.view.ViewCompat\nimport androidx.core.view.WindowInsetsCompat\n')
    .replace('class MainActivity : TauriActivity() {', 'class MainActivity : TauriActivity() {\n  private var imeController: YawfImeController? = null')
    .replace('  override fun onWebViewCreate(webView: WebView) {', `  override fun onWebViewCreate(webView: WebView) {
    imeController?.destroy()
    imeController = null`)
    .replace('    fullscreenController = YawfFullscreenController(this, webView)', `    fullscreenController = YawfFullscreenController(this, webView)
    // Wry installs no WebView inset listener. Parent attachment follows this hook.
    imeController = YawfImeController(webView).also { it.attach(exclusiveWebViewListener = true) }`)
    .replace('    fullscreenController?.onConfigurationChanged()', '    fullscreenController?.onConfigurationChanged()\n    imeController?.onConfigurationChanged()')
    .replace('  override fun onDestroy() {', `  override fun onDestroy() {
    imeController?.destroy()
    imeController = null`)
    .replace(legacyInsets, `    val windowInsets = ViewCompat.getRootWindowInsets(webView) ?: return
    // The read-only safe-area bridge contains persistent bars/cutouts, never IME.
    val persistent = windowInsets.getInsets(
      WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
    )
    val top = persistent.top.coerceAtLeast(0)
    val right = persistent.right.coerceAtLeast(0)
    val bottom = persistent.bottom.coerceAtLeast(0)
    val left = persistent.left.coerceAtLeast(0)`);
}

function preColdRecoveryMainActivity(packageName) {
  let activity = preGestureMainActivity(packageName);
  const replacements = [
    [`@Keep
class YawfSafeAreaBridge(
  private val snapshot: AtomicReference<String>,
) {
  @JavascriptInterface
  fun getInsets(): String = snapshot.get()
}`, `data class YawfInsetSnapshot(
  val safeArea: String,
  val systemGestures: String,
)

@Keep
class YawfSafeAreaBridge(
  private val snapshot: AtomicReference<YawfInsetSnapshot>,
) {
  @JavascriptInterface
  fun getInsets(): String = snapshot.get().safeArea

  @JavascriptInterface
  fun getSystemGestureInsets(): String = snapshot.get().systemGestures
}`],
    ['private val safeAreaSnapshot = AtomicReference(EMPTY_SAFE_AREA)',
      'private val safeAreaSnapshot = AtomicReference(YawfInsetSnapshot(EMPTY_SAFE_AREA, EMPTY_SAFE_AREA))'],
    [`    val nextSnapshot =
      "{\\\"top\\\":$top,\\\"right\\\":$right,\\\"bottom\\\":$bottom,\\\"left\\\":$left}"`,
    `    // Read current root insets only. Do not reserve legacy button bars as gestures.
    val gestureSnapshot = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val gestures = windowInsets.getInsets(WindowInsetsCompat.Type.systemGestures())
      val gestureTop = gestures.top.coerceAtLeast(0)
      val gestureRight = gestures.right.coerceAtLeast(0)
      val gestureBottom = gestures.bottom.coerceAtLeast(0)
      val gestureLeft = gestures.left.coerceAtLeast(0)
      "{\\\"top\\\":$gestureTop,\\\"right\\\":$gestureRight,\\\"bottom\\\":$gestureBottom,\\\"left\\\":$gestureLeft}"
    } else EMPTY_SAFE_AREA
    val nextSnapshot = YawfInsetSnapshot(
      "{\\\"top\\\":$top,\\\"right\\\":$right,\\\"bottom\\\":$bottom,\\\"left\\\":$left}",
      gestureSnapshot,
    )`],
    ['safeAreaSnapshot.set(EMPTY_SAFE_AREA)',
      'safeAreaSnapshot.set(YawfInsetSnapshot(EMPTY_SAFE_AREA, EMPTY_SAFE_AREA))'],
  ];
  for (const [before, after] of replacements) {
    if (activity.split(before).length !== 2) {
      throw new Error("Unsupported system gesture inset template.");
    }
    activity = activity.replace(before, after);
  }
  return activity;
}

// Register below Wry/Tauri's later navigation and custom-fullscreen callbacks.
// This fallback has no JS entry point and can load only the fixed bundled UI.
function patchedMainActivity(packageName) {
  let activity = preColdRecoveryMainActivity(packageName);
  const state = `
  private var remoteRecoveryDialog: AlertDialog? = null
  private val remoteRecoveryBack = object : OnBackPressedCallback(true) {
    override fun handleOnBackPressed() {
      if (remoteRecoveryDialog?.isShowing == true) return
      val view = safeAreaWebView
      if (view == null || !view.isAttachedToWindow || view.visibility != View.VISIBLE) {
        passRemoteRecoveryBack()
        return
      }
      val imeVisible = ViewCompat.getRootWindowInsets(view)?.isVisible(WindowInsetsCompat.Type.ime()) == true
      if (imeVisible) {
        WindowInsetsControllerCompat(window, view).hide(WindowInsetsCompat.Type.ime())
        return
      }
      // Player/overlay routes already have app-history entries. Never replace
      // their Back handling with the remote-root escape.
      if (view.canGoBack()) {
        view.goBack()
        return
      }
      val page = view.url
      if (page == null || !remoteRecoveryCanAct(view, page) || !hasWindowFocus()) {
        passRemoteRecoveryBack()
        return
      }
      showRemoteRecoveryDialog(view, page)
    }
  }
`;
  const methods = `  private fun passRemoteRecoveryBack() {
    remoteRecoveryBack.isEnabled = false
    try {
      onBackPressedDispatcher.onBackPressed()
    } finally {
      remoteRecoveryBack.isEnabled = true
    }
  }

  private fun remoteRecoveryCanAct(view: WebView, page: String): Boolean {
    if (isFinishing || isDestroyed || safeAreaWebView !== view ||
      !view.isAttachedToWindow || view.visibility != View.VISIBLE ||
      view.url != page || view.canGoBack()) return false
    val origin = currentTopOrigin(view) ?: return false
    return origin != ServerPlayerOrigin("http", "tauri.localhost", 80)
  }

  private fun dismissRemoteRecoveryDialog() {
    val previous = remoteRecoveryDialog
    remoteRecoveryDialog = null
    previous?.dismiss()
  }

  private fun showRemoteRecoveryDialog(view: WebView, page: String) {
    if (remoteRecoveryDialog != null || !remoteRecoveryCanAct(view, page)) return
    val dialog = AlertDialog.Builder(this)
      .setTitle("Server navigation")
      .setMessage("You are at the start of this server. Retry it, or return to the app's Local Mode without removing your saved server or profiles.")
      .setPositiveButton("Retry server") { current, _ ->
        if (remoteRecoveryDialog === current && remoteRecoveryCanAct(view, page)) view.reload()
      }
      .setNeutralButton("Use Local Mode") { current, _ ->
        if (remoteRecoveryDialog === current && remoteRecoveryCanAct(view, page)) {
          view.loadUrl("http://tauri.localhost/#yawf-local-mode")
        }
      }
      .setNegativeButton("Cancel", null)
      .create()
    remoteRecoveryDialog = dialog
    dialog.setOnDismissListener { if (remoteRecoveryDialog === dialog) remoteRecoveryDialog = null }
    dialog.show()
  }

`;
  const replacements = [
    ['import androidx.activity.SystemBarStyle\n', 'import androidx.activity.SystemBarStyle\nimport androidx.activity.OnBackPressedCallback\n'],
    ['import androidx.core.view.WindowInsetsCompat\n', 'import androidx.core.view.WindowInsetsCompat\nimport androidx.core.view.WindowInsetsControllerCompat\n'],
    ['class MainActivity : TauriActivity() {\n', 'class MainActivity : TauriActivity() {\n' + state],
    ['    super.onCreate(savedInstanceState)\n', '    onBackPressedDispatcher.addCallback(this, remoteRecoveryBack)\n    super.onCreate(savedInstanceState)\n'],
    ['  override fun onWebViewCreate(webView: WebView) {\n', '  override fun onWebViewCreate(webView: WebView) {\n    dismissRemoteRecoveryDialog()\n'],
    ['  override fun onPause() {\n', '  override fun onPause() {\n    dismissRemoteRecoveryDialog()\n'],
    ['  override fun onDestroy() {\n', '  override fun onDestroy() {\n    remoteRecoveryBack.remove()\n    dismissRemoteRecoveryDialog()\n'],
    ['  private fun inspectWebViewCompatibility()', methods + '  private fun inspectWebViewCompatibility()'],
  ];
  for (const [before, after] of replacements) {
    if (activity.split(before).length !== 2) throw new Error("Unsupported Android remote-root recovery template.");
    activity = activity.replace(before, after);
  }
  return activity;
}

export function previousColdRecoveryMainActivityForTest(packageName) {
  return preColdRecoveryMainActivity(packageName);
}

const originalFullscreenShow = `  override fun onShowCustomView(view: View, callback: CustomViewCallback) {
    callback.onCustomViewHidden()
    super.onShowCustomView(view, callback)
  }`;
const patchedFullscreenShow = `  override fun onShowCustomView(view: View, callback: CustomViewCallback) {
    val host = activity as? MainActivity
    if (host != null) host.showWebFullscreen(view, callback) else callback.onCustomViewHidden()
  }`;
const originalFullscreenHide = `  override fun onHideCustomView() {
    super.onHideCustomView()
  }`;
const patchedFullscreenHide = `  override fun onHideCustomView() {
    (activity as? MainActivity)?.hideWebFullscreen()
  }`;

export function patchGeneratedFullscreenSource(source) {
  const patchedShow = source.includes(patchedFullscreenShow);
  const patchedHide = source.includes(patchedFullscreenHide);
  if (patchedShow !== patchedHide) throw new Error("Unsupported generated Wry fullscreen partial patch.");
  let output = source;
  for (const [name, original, patched] of [
    ['onShowCustomView', originalFullscreenShow, patchedFullscreenShow],
    ['onHideCustomView', originalFullscreenHide, patchedFullscreenHide],
  ]) {
    // Fail closed on overloads, partial patches and upstream body drift.
    const declarations = output.match(new RegExp('override fun ' + name + '\\(', 'g')) ?? [];
    if (declarations.length !== 1 ||
        (!output.includes(original) && !output.includes(patched))) {
      throw new Error('Unsupported generated Wry fullscreen method: ' + name);
    }
    output = output.replace(original, patched);
  }
  return output;
}

function fullscreenGradleHook(packageName) {
  return `
// YAWF_FULLSCREEN_BEGIN
// Always validate after every scheduled Rust producer, even if Kotlin is up to
// date. A compile doFirst alone is skipped after regeneration of its old inputs.
val yawfFullscreenPatch = tasks.register<org.gradle.api.tasks.Exec>("yawfPatchWebFullscreen") {
    mustRunAfter(tasks.matching { it.name.startsWith("rustBuild") })
    commandLine("node", file("../../../../../scripts/patch_tauri_android.mjs").absolutePath,
        "--fullscreen-only", file("src/main/java/${packageName.replaceAll('.', '/')}/generated/RustWebChromeClient.kt").absolutePath)
}
tasks.configureEach {
    if (name.matches(Regex("compile(Universal|Arm64|Arm|X86|X86_64)(Debug|Release)Kotlin"))) {
        val rustVariant = name.removePrefix("compile").removeSuffix("Kotlin")
        dependsOn("rustBuild" + rustVariant, yawfFullscreenPatch)
    }
}
// YAWF_FULLSCREEN_END
`;
}

export function parseLeadingWebViewMajorForTest(versionName) {
  if (typeof versionName !== "string" || versionName !== versionName.trim()) return null;
  const match = /^([0-9]+)(?:[.][0-9A-Za-z][0-9A-Za-z._-]*)?$/.exec(versionName);
  if (match == null) return null;
  const majorVersion = Number(match[1]);
  return Number.isSafeInteger(majorVersion) && majorVersion <= 2_147_483_647
    ? majorVersion
    : null;
}

export function webViewStartupSupportedForTest(packageName, versionName) {
  return (
    typeof packageName === "string" &&
    /^[A-Za-z][A-Za-z0-9_]*(?:[.][A-Za-z][A-Za-z0-9_]*)+$/.test(packageName) &&
    (parseLeadingWebViewMajorForTest(versionName) ?? -1) >= minimumWebViewMajorVersion
  );
}

export function patchedMainActivityForWebViewCompatibilityTest(packageName) {
  return patchedMainActivity(packageName);
}

export function previousPatchedMainActivityForWebViewCompatibilityTest(packageName) {
  return previousPatchedMainActivity(packageName);
}

export function previousGestureMainActivityForTest(packageName) {
  return preGestureMainActivity(packageName);
}

const updatePaths = '<?xml version="1.0" encoding="utf-8"?>\n<paths xmlns:android="http://schemas.android.com/apk/res/android">\n    <files-path name="updates" path="updates/" />\n</paths>\n';
const updaterProvider = `        <provider
            android:name=".YawfUpdateFileProvider"
            android:authorities="\${applicationId}.updates"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/yawf_update_paths" />
        </provider>
`;
const installPermission = '    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />\n';

function retainMainActivityForAssetChanges(manifest) {
  const mainActivities = [...manifest.matchAll(/<activity\s[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => /\bandroid:name\s*=\s*["']\.MainActivity["']/.test(tag));
  const unsupported = "Unsupported Android MainActivity configuration template. Refusing to patch generated sources.";
  if (mainActivities.length !== 1) throw new Error(unsupported);
  const tag = mainActivities[0];
  const config = /\bandroid:configChanges="([^"]*)"/.exec(tag);
  const original = "orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode";
  const retained = `${original}|assetsPaths`;
  if (
    [...tag.matchAll(/\bandroid:name\s*=/g)].length !== 1 ||
    [...tag.matchAll(/\bandroid:configChanges\s*=/g)].length !== 1 ||
    config == null ||
    (config[1] !== original && config[1] !== retained)
  ) {
    throw new Error(unsupported);
  }
  // Navigation-mode runtime overlays change assetsPaths. Keep the live WebView;
  // existing onConfigurationChanged delegates resources and refreshes insets.
  return manifest.replace(tag, tag.replace(config[0], `android:configChanges="${retained}"`));
}

function replacementState(source, original, replacement, description) {
  if (source.includes(replacement)) return { changed: false, output: source };
  if (!source.includes(original)) {
    throw new Error(
      `${description} does not match the supported Tauri Android template. Refusing to patch generated sources.`,
    );
  }
  return { changed: true, output: source.replace(original, replacement) };
}

export function patchTauriAndroidProject({ root = repositoryRoot } = {}) {
  const androidRoot = join(root, generatedAndroidRelativePath);
  const appRoot = join(androidRoot, "app");
  const gradlePath = join(appRoot, "build.gradle.kts");
  const manifestPath = join(appRoot, "src/main/AndroidManifest.xml");
  const sourceRoot = join(appRoot, "src/main/java");
  for (const path of [gradlePath, manifestPath, sourceRoot]) {
    if (!existsSync(path)) {
      throw new Error(
        `Generated Android project is incomplete at ${relative(root, androidRoot) || generatedAndroidRelativePath}. Run tauri android init before patching.`,
      );
    }
  }

  const gradle = readFileSync(gradlePath, "utf8");
  const manifest = readFileSync(manifestPath, "utf8");
  if (!manifest.includes('android:usesCleartextTraffic="${usesCleartextTraffic}"')) {
    throw new Error(
      "AndroidManifest.xml does not match the supported Tauri Android template. Refusing to patch generated sources.",
    );
  }

  const defaultConfigFalse = `defaultConfig {
        ${cleartextPlaceholder} = "false"
        applicationId = `;
  const defaultConfigTrue = `defaultConfig {
        ${cleartextPlaceholder} = "true"
        applicationId = `;
  const gradleState = replacementState(
    gradle,
    defaultConfigFalse,
    defaultConfigTrue,
    "app/build.gradle.kts",
  );
  // Keep the audited Android 16 behavior; newer CLI templates default to API 37.
  let patchedGradle = gradleState.output;
  for (const property of ["compileSdk", "targetSdk"]) {
    const pattern = new RegExp(`(^[ \t]*${property} = )(36|37)([ \t]*$)`, "m");
    if (!pattern.test(patchedGradle)) throw new Error(`Unsupported generated Android ${property}. Refusing to patch.`);
    patchedGradle = patchedGradle.replace(pattern, (_match, prefix, _version, suffix) => prefix + "36" + suffix);
  }
  if (
    !patchedGradle.includes(defaultConfigTrue) ||
    !patchedGradle.includes(`getByName("debug") {
            ${cleartextPlaceholder} = "true"`) ||
    patchedGradle.includes(`${cleartextPlaceholder} = "false"`)
  ) {
    throw new Error(
      "Generated Android cleartext settings do not leave release playback enabled. Refusing to patch generated sources.",
    );
  }
  const dependenciesWithoutWebkit = `dependencies {
    implementation("androidx.appcompat:appcompat:1.7.1")`;
  const dependenciesWithWebkit = `dependencies {
    ${webkitDependency}
    implementation("androidx.appcompat:appcompat:1.7.1")`;
  const webkitState = replacementState(
    patchedGradle,
    dependenciesWithoutWebkit,
    dependenciesWithWebkit,
    "app/build.gradle.kts AndroidX WebKit dependency",
  );
  const patchedGradleWithWebkit = webkitState.output;
  if (
    !patchedGradleWithWebkit.includes(dependenciesWithWebkit) ||
    /androidx\.webkit:webkit:(?!1\.14\.0)/.test(patchedGradleWithWebkit)
  ) {
    throw new Error(
      "Generated Android WebKit dependency does not match the supported version. Refusing to patch generated sources.",
    );
  }

  const mainActivityPath = findMainActivity(sourceRoot);
  if (mainActivityPath == null) {
    throw new Error(
      "Generated Android MainActivity.kt is missing. Refusing to patch generated sources.",
    );
  }
  const activity = readFileSync(mainActivityPath, "utf8");
  const packageName = /^package\s+([A-Za-z_][A-Za-z0-9_.]*)$/m.exec(activity)?.[1];
  if (packageName == null) {
    throw new Error(
      "Generated Android MainActivity.kt has no supported package declaration. Refusing to patch generated sources.",
    );
  }
  const originalActivity = expectedMainActivity(packageName);
  const legacyActivity = legacyPatchedMainActivity(packageName);
  const darkSystemBarActivity = darkSystemBarPatchedMainActivity(packageName);
  const safeAreaActivity = safeAreaPatchedMainActivity(packageName);
  const replacementActivity = patchedMainActivity(packageName);
  const activityChanged =
    activity === originalActivity ||
    activity === legacyActivity ||
    activity === darkSystemBarActivity ||
    activity === safeAreaActivity ||
    activity === serverPlayerPatchedMainActivity(packageName) ||
    activity === previousPatchedMainActivity(packageName) ||
    activity === preFullscreenMainActivity(packageName) ||
    activity === preImeMainActivity(packageName) ||
    activity === preGestureMainActivity(packageName) ||
    activity === preColdRecoveryMainActivity(packageName);
  if (!activityChanged && activity !== replacementActivity) {
    throw new Error(
      "Generated Android MainActivity.kt does not match the supported Tauri Android template. Refusing to patch generated sources.",
    );
  }

  const hasLeanbackFeature = manifest.includes(leanbackFeatureTemplate);
  const hasLeanbackCategory = manifest.includes(leanbackCategoryTemplate);
  const hasAnyLeanback =
    manifest.includes("android.software.leanback") ||
    manifest.includes("android.intent.category.LEANBACK_LAUNCHER");
  if (hasLeanbackFeature !== hasLeanbackCategory || (!hasLeanbackFeature && hasAnyLeanback)) {
    throw new Error(
      "AndroidManifest.xml does not match the supported Tauri Android phone template. Refusing to patch generated sources.",
    );
  }
  const leanbackChanged = hasLeanbackFeature && hasLeanbackCategory;
  let patchedManifest = leanbackChanged
    ? manifest
        .replace(leanbackFeatureTemplate, "")
        .replace(leanbackCategoryTemplate, "")
    : manifest;

  patchedManifest = retainMainActivityForAssetChanges(patchedManifest);

  const resizeLine = 'android:windowSoftInputMode="adjustResize"';
  if (/android:windowSoftInputMode\s*=/.test(patchedManifest) && !patchedManifest.includes(resizeLine)) {
    throw new Error("Unsupported Android keyboard resize template. Refusing to overwrite.");
  }
  if (!patchedManifest.includes(resizeLine)) {
    const anchor = 'android:name=".MainActivity"';
    if (patchedManifest.split(anchor).length !== 2) throw new Error("Android keyboard activity anchor missing or duplicated.");
    patchedManifest = patchedManifest.replace(anchor, anchor + ' ' + resizeLine);
  }

  if (patchedManifest.includes('android.permission.REQUEST_INSTALL_PACKAGES') && !patchedManifest.includes(installPermission)) {
    throw new Error("Unsupported Android updater permission template.");
  }
  if (patchedManifest.includes('YawfUpdateFileProvider') && !patchedManifest.includes(updaterProvider)) {
    throw new Error("Unsupported Android updater provider template.");
  }
  if (!patchedManifest.includes(installPermission)) {
    patchedManifest = patchedManifest.replace('    <uses-permission android:name="android.permission.INTERNET" />\n', '    <uses-permission android:name="android.permission.INTERNET" />\n' + installPermission);
  }
  if (!patchedManifest.includes(updaterProvider)) patchedManifest = patchedManifest.replace('    </application>', updaterProvider + '    </application>');
  if (!patchedManifest.includes(installPermission) || !patchedManifest.includes(updaterProvider)) throw new Error("Android updater manifest anchors missing.");
  const manifestChanged = patchedManifest !== manifest;
  const updaterPath = join(dirname(mainActivityPath), "YawfAndroidUpdater.kt");
  const updaterSource = readFileSync(new URL("./android/YawfAndroidUpdater.kt", import.meta.url), "utf8").replace(/^package com\.tgk30\.debridstreamer$/m, `package ${packageName}`);
  const pathsPath = join(appRoot, "src/main/res/xml/yawf_update_paths.xml");
  for (const [path, expected] of [[updaterPath, updaterSource], [pathsPath, updatePaths]]) {
    if (existsSync(path) && readFileSync(path, "utf8") !== expected) throw new Error("Generated Android updater source or resource has unrecognized changes. Refusing to overwrite.");
  }
  const updaterChanged = !existsSync(updaterPath) || !existsSync(pathsPath);

  const fullscreenPath = join(dirname(mainActivityPath), "YawfFullscreenController.kt");
  const fullscreenSource = readFileSync(new URL("./android/YawfFullscreenController.kt", import.meta.url), "utf8")
    .replace(/^package com\.tgk30\.debridstreamer$/m, `package ${packageName}`);
  if (existsSync(fullscreenPath) && readFileSync(fullscreenPath, "utf8") !== fullscreenSource) {
    throw new Error("Generated Android fullscreen controller has unrecognized changes. Refusing to overwrite.");
  }
  const fullscreenChanged = !existsSync(fullscreenPath);
  const imePath = join(dirname(mainActivityPath), "YawfImeController.kt");
  const imeSource = readFileSync(new URL("./android/YawfImeController.kt", import.meta.url), "utf8")
    .replace(/^package com\.tgk30\.debridstreamer$/m, `package ${packageName}`);
  if (existsSync(imePath) && readFileSync(imePath, "utf8") !== imeSource) {
    throw new Error("Generated Android keyboard controller has unrecognized changes. Refusing to overwrite.");
  }
  const imeChanged = !existsSync(imePath);
  const hook = fullscreenGradleHook(packageName);
  const hasFullscreenHook = patchedGradleWithWebkit.includes(hook);
  if (!hasFullscreenHook && /YAWF_FULLSCREEN|--fullscreen-only/.test(patchedGradleWithWebkit)) {
    throw new Error("Generated Android fullscreen Gradle hook has unrecognized changes.");
  }
  const finalGradle = hasFullscreenHook ? patchedGradleWithWebkit : patchedGradleWithWebkit + hook;

  // Validate every generated template before the first write. A drifted
  // MainActivity or manifest must not leave a half-patched Gradle file behind.
  const gradleChanged = gradle !== finalGradle;
  if (gradleChanged) writeFileSync(gradlePath, finalGradle);
  if (fullscreenChanged) writeFileSync(fullscreenPath, fullscreenSource);
  if (imeChanged) writeFileSync(imePath, imeSource);
  if (activityChanged) writeFileSync(mainActivityPath, replacementActivity);
  if (manifestChanged) writeFileSync(manifestPath, patchedManifest);
  if (updaterChanged) {
    mkdirSync(dirname(pathsPath), { recursive: true });
    writeFileSync(updaterPath, updaterSource);
    writeFileSync(pathsPath, updatePaths);
  }

  return {
    androidRoot,
    changed: gradleChanged || activityChanged || manifestChanged || updaterChanged || fullscreenChanged || imeChanged,
    gradleChanged,
    activityChanged,
    manifestChanged,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--fullscreen-only") {
    if (process.argv.length !== 4) throw new Error("Expected exactly one generated RustWebChromeClient.kt path.");
    const path = process.argv[3];
    const source = readFileSync(path, "utf8");
    const patched = patchGeneratedFullscreenSource(source);
    if (source !== patched) writeFileSync(path, patched);
    console.log("Validated generated Wry fullscreen custom-view methods.");
    process.exit(0);
  }
  const result = patchTauriAndroidProject();
  console.log(
    result.changed
      ? "Patched generated Android phone manifest, cleartext, cookies, safe-area bridge, and Server Mode player bridge."
      : "Generated Android phone manifest, cleartext, cookies, safe-area bridge, and Server Mode player bridge are already patched.",
  );
}
