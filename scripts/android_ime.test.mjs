import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import test, { after } from 'node:test';

const source = readFileSync(new URL('./android/YawfImeController.kt', import.meta.url), 'utf8');

test('IME fitting owns no parent listener, bridge, system bars, fullscreen, orientation or media actions', () => {
  assert.doesNotMatch(source, /WindowInsetsCompat\.CONSUMED|WindowCompat|WindowInsetsController|WindowManager|requestedOrientation|systemUiVisibility|JavascriptInterface|evaluateJavascript|loadUrl|WebChromeClient|addView|removeView|setPadding/);
  assert.match(source, /setOnApplyWindowInsetsListener\(webView\)/);
  assert.match(source, /requestLayout\(\)/);
});

// Host doubles execute the actual production Kotlin. They model only public
// View lifecycle, layout margins and inset delivery, not Android/WebView layout,
// keyboard animation, fullscreen behavior or runtime focus visibility.
const stubs = {
  'view.kt': `package android.view
interface ViewParent
open class View {
 var parent: ViewParent? = null
 var layoutParams: ViewGroup.LayoutParams? = null
 var isAttachedToWindow = false
 var paddingLeft = 3; var paddingTop = 5; var paddingRight = 7; var paddingBottom = 11
 var visibility = 0; var systemUiVisibility = 37
 var layoutRequests = 0
 val attachmentListeners = mutableListOf<OnAttachStateChangeListener>()
 interface OnAttachStateChangeListener {
  fun onViewAttachedToWindow(view: View)
  fun onViewDetachedFromWindow(view: View)
 }
 fun addOnAttachStateChangeListener(listener: OnAttachStateChangeListener) { attachmentListeners.add(listener) }
 fun removeOnAttachStateChangeListener(listener: OnAttachStateChangeListener) { attachmentListeners.remove(listener) }
 fun requestLayout() { layoutRequests++ }
 open fun onApplyWindowInsets(insets: androidx.core.view.WindowInsetsCompat) = insets
}
open class ViewGroup : View(), ViewParent {
 open class LayoutParams(var width: Int, var height: Int)
 class MarginLayoutParams(width: Int, height: Int) : LayoutParams(width, height) {
  var leftMargin = 13; var topMargin = 17; var rightMargin = 19; var bottomMargin = 23
 }
}`,
  'webview.kt': `package android.webkit
import androidx.core.view.WindowInsetsCompat
class WebView : android.view.View() {
 var defaultHandlerCalls = 0
 var nativeImeResize = 0
 var lastDefaultInput: WindowInsetsCompat? = null
 var lastDefaultOutput: WindowInsetsCompat? = null
 override fun onApplyWindowInsets(insets: WindowInsetsCompat): WindowInsetsCompat {
  defaultHandlerCalls++
  lastDefaultInput = insets
  nativeImeResize = if (insets.isVisible(8)) insets.getInsets(8).bottom else 0
  // A distinct result proves that listeners return the default handler's
  // output, rather than merely calling it and returning the raw input.
  return WindowInsetsCompat(insets.values, insets.visible, insets.isConsumed,
   insets.unrelatedMetadata + 1).also { lastDefaultOutput = it }
 }
}`,
  'graphics.kt': `package androidx.core.graphics
data class Insets(val left: Int, val top: Int, val right: Int, val bottom: Int) {
 companion object { val NONE = Insets(0, 0, 0, 0); fun of(left: Int, top: Int, right: Int, bottom: Int) = Insets(left, top, right, bottom) }
}`,
  'insets.kt': `package androidx.core.view
import android.view.View
import androidx.core.graphics.Insets
class WindowInsetsCompat(
 val values: Map<Int, Insets>, val visible: Set<Int>, val isConsumed: Boolean = false,
 val unrelatedMetadata: Int = 417,
) {
 fun getInsets(types: Int): Insets {
  val selected = values.filterKeys { it and types != 0 }.values
  return Insets(selected.maxOfOrNull { it.left } ?: 0, selected.maxOfOrNull { it.top } ?: 0,
   selected.maxOfOrNull { it.right } ?: 0, selected.maxOfOrNull { it.bottom } ?: 0)
 }
 fun isVisible(type: Int) = visible.contains(type)
 object Type {
  fun statusBars() = 1; fun navigationBars() = 2; fun captionBar() = 4
  fun systemBars() = 7; fun ime() = 8; fun displayCutout() = 16
 }
 class Builder(private val original: WindowInsetsCompat) {
  private val values = original.values.toMutableMap()
  fun setInsets(type: Int, insets: Insets): Builder { values[type] = insets; return this }
  fun build() = WindowInsetsCompat(values, original.visible, original.isConsumed, original.unrelatedMetadata)
 }
 companion object { val CONSUMED = WindowInsetsCompat(emptyMap(), emptySet(), true) }
}
object ViewCompat {
 val listeners = mutableMapOf<View, (View, WindowInsetsCompat) -> WindowInsetsCompat>()
 val requests = mutableMapOf<View, Int>()
 var listenerWrites = 0
 fun setOnApplyWindowInsetsListener(view: View, listener: ((View, WindowInsetsCompat) -> WindowInsetsCompat)?) {
  listenerWrites++
  if (listener == null) listeners.remove(view) else listeners[view] = listener
 }
 fun requestApplyInsets(view: View) { requests[view] = (requests[view] ?: 0) + 1 }
 // A registered listener replaces, rather than precedes, the default policy.
 fun onApplyWindowInsets(view: View, insets: WindowInsetsCompat) = view.onApplyWindowInsets(insets)
 fun dispatch(view: View, insets: WindowInsetsCompat) =
  listeners[view]?.invoke(view, insets) ?: onApplyWindowInsets(view, insets)
}`,
};

const behavior = `package com.tgk30.debridstreamer
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

private var assertions = 0
private fun expect(actual: Any?, expected: Any?, label: String) {
 assertions++
 check(actual == expected) { "$label: expected=$expected actual=$actual" }
}
private fun same(actual: Any?, expected: Any?, label: String) {
 assertions++
 check(actual === expected) { "$label: identity changed" }
}
private fun insets(ime: Int, navigation: Int, visible: Boolean = true, right: Int = 0, cutout: Int = 0) =
 WindowInsetsCompat(mapOf(1 to Insets.of(0, 31, 0, 0), 2 to Insets.of(0, 0, right, navigation),
  8 to Insets.of(0, 0, 0, ime), 16 to Insets.of(0, 0, 0, cutout)),
  if (visible) setOf(1, 2, 8) else setOf(1, 2))
private fun attach(view: WebView, parent: ViewGroup, layout: ViewGroup.LayoutParams) {
 view.parent = parent; view.layoutParams = layout; view.isAttachedToWindow = true
 view.attachmentListeners.toList().forEach { it.onViewAttachedToWindow(view) }
}
private fun detach(view: WebView) {
 view.isAttachedToWindow = false
 view.attachmentListeners.toList().forEach { it.onViewDetachedFromWindow(view) }
}
private class Fixture {
 val parent = ViewGroup()
 val view = WebView()
 val layout = ViewGroup.MarginLayoutParams(1080, 1920)
 val failures = mutableListOf<YawfImeController.AttachResult>()
 val controller = YawfImeController(view) { failures.add(it) }
 init {
  attach(view, parent, layout)
  expect(controller.attach(true), YawfImeController.AttachResult.ATTACHED, "attached result")
 }
 fun dispatch(input: WindowInsetsCompat) = ViewCompat.dispatch(view, input)
 fun unchanged() {
  expect(listOf(layout.width, layout.height, layout.leftMargin, layout.topMargin, layout.rightMargin),
   listOf(1080, 1920, 13, 17, 19), "other layout fields")
  expect(listOf(parent.paddingLeft, parent.paddingTop, parent.paddingRight, parent.paddingBottom),
   listOf(3, 5, 7, 11), "parent padding")
  expect(listOf(view.paddingLeft, view.paddingTop, view.paddingRight, view.paddingBottom),
   listOf(3, 5, 7, 11), "WebView padding")
  expect(view.visibility, 0, "visibility")
  expect(view.systemUiVisibility, 37, "system bar flags")
  expect(view.defaultHandlerCalls > 0, true, "owned fitting invokes default policy")
  expect(view.nativeImeResize, 0, "owned fitting has no second native resize")
 }
}
private fun forwarded(view: WebView, input: WindowInsetsCompat) {
 val calls = view.defaultHandlerCalls
 val output = ViewCompat.dispatch(view, input)
 expect(view.defaultHandlerCalls, calls + 1, "owned default handler called once")
 val received = view.lastDefaultInput!!
 expect(received.isConsumed, false, "default input not consumed")
 expect(received.getInsets(8), Insets.NONE, "default policy receives zero IME")
 expect(received.getInsets(7 or 16), input.getInsets(7 or 16), "default policy receives persistent insets")
 expect(received.isVisible(8), input.isVisible(8), "default policy receives visibility update")
 expect(received.unrelatedMetadata, input.unrelatedMetadata, "default policy receives unrelated metadata")
 same(output, view.lastDefaultOutput, "owned default result returned")
 expect(view.nativeImeResize, 0, "owned default clears previous native resize")
 expect(output.isConsumed, false, "not consumed")
 expect(output.getInsets(8), Insets.NONE, "IME zeroed")
 expect(output.getInsets(7 or 16), input.getInsets(7 or 16), "persistent insets preserved")
 expect(output.isVisible(8), input.isVisible(8), "visibility update preserved")
 expect(output.unrelatedMetadata, input.unrelatedMetadata + 1, "default output metadata sentinel")
}
private fun nativeFallback(view: WebView, input: WindowInsetsCompat, label: String,
 apply: () -> WindowInsetsCompat = { ViewCompat.dispatch(view, input) }) {
 val calls = view.defaultHandlerCalls
 val output = apply()
 expect(view.defaultHandlerCalls, calls + 1, "$label default handler called once")
 same(view.lastDefaultInput, input, "$label unmodified default input")
 same(output, view.lastDefaultOutput, "$label default result returned")
 expect(view.nativeImeResize, if (input.isVisible(8)) input.getInsets(8).bottom else 0,
  "$label default IME resize applied")
}

fun main(args: Array<String>) {
 val scenario = args.single()
 when (scenario) {
  "admission" -> {
   val waiting = WebView()
   val controller = YawfImeController(waiting)
   expect(controller.attach(false), YawfImeController.AttachResult.LISTENER_OWNERSHIP_REQUIRED, "explicit ownership required")
   expect(ViewCompat.listeners.containsKey(waiting), false, "no unowned listener write")
   expect(controller.attach(true), YawfImeController.AttachResult.WAITING_FOR_ATTACHMENT, "Wry parent not ready")
   val input = insets(348, 48)
   nativeFallback(waiting, input, "unbound inset fallback")
   val layout = ViewGroup.MarginLayoutParams(1080, 1920)
   attach(waiting, ViewGroup(), layout)
   expect(controller.status, YawfImeController.AttachResult.ATTACHED, "bind after attachment")
   val listener = ViewCompat.listeners[waiting]
   val requests = ViewCompat.requests[waiting]
   expect(controller.attach(true), YawfImeController.AttachResult.ATTACHED, "repeat attachment")
   same(ViewCompat.listeners[waiting], listener, "listener unchanged")
   expect(ViewCompat.requests[waiting], requests, "repeat attach has no inset request")
   val competing = YawfImeController(waiting)
   expect(competing.attach(true), YawfImeController.AttachResult.LISTENER_CONFLICT, "competing owner rejected")
   competing.destroy()
   same(ViewCompat.listeners[waiting], listener, "rejected destroy preserves active listener")
   controller.destroy()
   val unsupported = WebView().apply { isAttachedToWindow = true; parent = object : android.view.ViewParent {} }
   val badParent = YawfImeController(unsupported)
   expect(badParent.attach(true), YawfImeController.AttachResult.UNSUPPORTED_PARENT, "non-ViewGroup rejected")
   nativeFallback(unsupported, input, "unsupported parent keeps native handling")
   badParent.destroy()
   val plain = WebView()
   attach(plain, ViewGroup(), ViewGroup.LayoutParams(1080, 1920))
   val badLayout = YawfImeController(plain)
   expect(badLayout.attach(true), YawfImeController.AttachResult.UNSUPPORTED_LAYOUT, "non-margin layout rejected")
   nativeFallback(plain, input, "unsupported layout keeps native handling")
   badLayout.destroy()
  }
  "hidden" -> {
   val f = Fixture()
   val input = insets(348, 48, false)
   forwarded(f.view, input)
   expect(f.layout.bottomMargin, 23, "hidden IME baseline")
   expect(f.view.layoutRequests, 0, "hidden IME does not relayout")
   f.unchanged(); f.controller.destroy()
  }
  "navigation" -> {
   val f = Fixture()
   for ((ime, bars, cutout, overlap) in listOf(listOf(348, 48, 0, 300), listOf(324, 24, 0, 300),
       listOf(324, 24, 54, 270), listOf(20, 48, 0, 0))) {
    val input = insets(ime, bars, true, cutout = cutout)
    forwarded(f.view, input)
    expect(f.layout.bottomMargin, 23 + overlap, "incremental keyboard overlap")
    f.unchanged()
   }
   f.controller.destroy()
  }
  "repeat" -> {
   val f = Fixture()
   val shown = insets(348, 48)
   forwarded(f.view, shown)
   expect(f.layout.bottomMargin, 323, "shown margin")
   expect(f.view.layoutRequests, 1, "first layout request")
   forwarded(f.view, shown)
   expect(f.layout.bottomMargin, 323, "no accumulating overlap")
   expect(f.view.layoutRequests, 1, "unchanged margin does not relayout")
   val hidden = insets(0, 48, false)
   forwarded(f.view, hidden)
   expect(f.layout.bottomMargin, 23, "hide clears overlap")
   expect(f.view.layoutRequests, 2, "hide relayout")
   forwarded(f.view, hidden)
   expect(f.view.layoutRequests, 2, "repeat hide does not relayout")
   forwarded(f.view, shown)
   expect(f.layout.bottomMargin, 323, "second show")
   f.controller.destroy()
  }
  "rotation" -> {
   val f = Fixture()
   f.dispatch(insets(348, 48))
   val requests = ViewCompat.requests[f.view] ?: 0
   f.controller.onConfigurationChanged()
   expect(ViewCompat.requests[f.view], requests + 1, "rotation requests fresh insets")
   val rotated = insets(200, 0, true, right = 48)
   forwarded(f.view, rotated)
   expect(f.layout.bottomMargin, 223, "rotated overlap uses new bottom bars")
   f.unchanged(); f.controller.destroy()
  }
  "detach" -> {
   val f = Fixture()
   val shown = insets(348, 48)
   f.dispatch(shown)
   detach(f.view)
   expect(f.layout.bottomMargin, 23, "detach restores baseline")
   val changes = f.view.layoutRequests
   nativeFallback(f.view, shown, "detached native handling")
   detach(f.view)
   expect(f.view.layoutRequests, changes, "repeat detach no relayout")
   attach(f.view, f.parent, f.layout)
   expect(f.controller.status, YawfImeController.AttachResult.ATTACHED, "same-parent reattachment")
   f.dispatch(shown)
   expect(f.layout.bottomMargin, 323, "reattached baseline does not drift")
   val stale = ViewCompat.listeners[f.view]!!
   f.controller.destroy()
   expect(f.layout.bottomMargin, 23, "destroy restores baseline")
   expect(f.view.attachmentListeners.size, 0, "destroy removes lifecycle observer")
   expect(ViewCompat.listeners.containsKey(f.view), false, "destroy removes owned listener")
   val writes = ViewCompat.listenerWrites
   val requests = f.view.layoutRequests
   f.controller.destroy()
   expect(ViewCompat.listenerWrites, writes, "destroy idempotent")
   expect(f.view.layoutRequests, requests, "destroy no repeated layout")
   nativeFallback(f.view, shown, "late callback after destroy") { stale(f.view, shown) }
   expect(f.controller.attach(true), YawfImeController.AttachResult.DESTROYED, "destroy terminal")
  }
  "ownership" -> {
   val input = insets(348, 48)
   val replaced = Fixture()
   replaced.dispatch(input)
   val foreign = ViewGroup.MarginLayoutParams(900, 1200).apply { bottomMargin = 97 }
   replaced.view.layoutParams = foreign
   nativeFallback(replaced.view, input, "replacement layout keeps native insets")
   expect(replaced.controller.status, YawfImeController.AttachResult.OWNERSHIP_CHANGED, "layout replacement reported")
   expect(foreign.bottomMargin, 97, "foreign layout untouched")
   expect(replaced.layout.bottomMargin, 23, "old owned layout restored")
   expect(replaced.failures.size, 1, "replacement reported once")
   replaced.controller.destroy()
   val write = Fixture()
   write.dispatch(input); write.layout.bottomMargin = 89
   nativeFallback(write.view, input, "foreign bottom-margin write keeps native insets")
   write.controller.destroy()
   expect(write.layout.bottomMargin, 89, "foreign bottom-margin write not clobbered")
   val moved = Fixture()
   moved.dispatch(input); detach(moved.view)
   val parent = ViewGroup()
   attach(moved.view, parent, moved.layout)
   expect(moved.controller.status, YawfImeController.AttachResult.OWNERSHIP_CHANGED, "new parent rejected")
   same(moved.view.parent, parent, "no parent swapping")
   nativeFallback(moved.view, input, "new parent keeps native insets")
   moved.controller.destroy()
  }
  "fallback" -> {
   val shown = insets(348, 48)
   val hidden = insets(0, 48, false)
   val waiting = WebView()
   val pending = YawfImeController(waiting)
   pending.attach(true)
   nativeFallback(waiting, shown, "waiting fallback")
   expect(waiting.nativeImeResize, 348, "inactive phase applied native resize")
   val layout = ViewGroup.MarginLayoutParams(1080, 1920)
   attach(waiting, ViewGroup(), layout)
   forwarded(waiting, shown)
   expect(layout.bottomMargin, 323, "owned phase applies native margin")
   forwarded(waiting, hidden)
   expect(layout.bottomMargin, 23, "owned hide restores baseline")
   pending.destroy()
   val rejected = Fixture()
   forwarded(rejected.view, shown)
   rejected.view.layoutParams = ViewGroup.LayoutParams(900, 1200)
   nativeFallback(rejected.view, shown, "rejected fallback")
   nativeFallback(rejected.view, hidden, "rejected hide update")
   expect(rejected.layout.bottomMargin, 23, "rejected overlap restored")
   rejected.controller.destroy()
   val detached = Fixture()
   detached.dispatch(shown); detach(detached.view)
   nativeFallback(detached.view, shown, "detached fallback")
   nativeFallback(detached.view, hidden, "detached hide update")
   detached.controller.destroy()
  }
  else -> error("Unknown behavior case: $scenario")
 }
 println("IME behavior case passed: $scenario; assertions=$assertions")
}
`;

function filesBelow(root, match) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesBelow(path, match) : match(path) ? [path] : [];
  });
}

function compilerRuntimeCoordinates(pom) {
  return [...pom.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].flatMap(([, body]) => {
    const field = (name) => new RegExp(`<${name}>([^<]+)</${name}>`).exec(body)?.[1].trim();
    if (!['compile', 'runtime'].includes(field('scope') || 'compile')) return [];
    const coordinate = ['groupId', 'artifactId', 'version'].map(field);
    assert.ok(coordinate.every((value) => value && /^[\w.+-]+$/.test(value)), 'Unsupported Kotlin compiler POM dependency');
    return [coordinate.join('/')];
  });
}

function toolchain(t) {
  const modules = join(process.env.GRADLE_USER_HOME || join(homedir(), '.gradle'), 'caches/modules-2/files-2.1');
  const jar = (path) => {
    const [, artifact, version] = path.split('/');
    return filesBelow(join(modules, path), (file) => version ? basename(file) === `${artifact}-${version}.jar` : file.endsWith('.jar'))[0];
  };
  const pom = (version) => filesBelow(join(modules, `org.jetbrains.kotlin/kotlin-compiler-embeddable/${version}`), (file) => file.endsWith(`kotlin-compiler-embeddable-${version}.pom`))[0];
  const compiler = filesBelow(join(modules, 'org.jetbrains.kotlin/kotlin-compiler-embeddable'), (file) => /kotlin-compiler-embeddable-[^/]+\.jar$/.test(file))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    .find((file) => {
      const version = /kotlin-compiler-embeddable-([^/]+)\.jar$/.exec(file)?.[1];
      return version && pom(version) && jar(`org.jetbrains.kotlin/kotlin-stdlib/${version}`) && jar(`org.jetbrains.kotlin/kotlin-script-runtime/${version}`);
    });
  const version = compiler && /kotlin-compiler-embeddable-([^/]+)\.jar$/.exec(compiler)?.[1];
  const stdlib = version && jar(`org.jetbrains.kotlin/kotlin-stdlib/${version}`);
  const annotations = jar('org.jetbrains/annotations');
  const dependencies = version ? compilerRuntimeCoordinates(readFileSync(pom(version), 'utf8')) : [];
  assert.ok(!compiler || dependencies.length > 0, 'Kotlin compiler POM must declare runtime dependencies');
  const components = [compiler, annotations, ...dependencies.map(jar)];
  const java = join(process.env.JAVA_HOME || '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  if (components.some((file) => !file) || !existsSync(java)) {
    assert.notEqual(process.env.YAWF_REQUIRE_ANDROID_IME_BEHAVIOR, '1', 'Required Android IME behavior toolchain unavailable; warm Kotlin Gradle cache and set JAVA_HOME');
    t.skip('Kotlin compiler cache or Java unavailable');
    return null;
  }
  return { java, runtime: components.join(delimiter), stdlib, annotations, version };
}

const work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'yawf-ime-kotlin-'));
after(() => rmSync(work, { recursive: true, force: true }));
const paths = Object.entries({ ...stubs, 'behavior.kt': behavior }).map(([name, text]) => {
  const path = join(work, name); writeFileSync(path, text); return path;
});
const compiled = new Map();
function compile(t, text, name) {
  const tools = toolchain(t);
  if (!tools) return null;
  if (compiled.has(name)) return { ...tools, output: compiled.get(name) };
  const dir = join(work, name);
  mkdirSync(dir);
  const production = join(dir, 'YawfImeController.kt');
  const output = join(dir, 'behavior.jar');
  writeFileSync(production, text);
  const result = spawnSync(tools.java, ['-cp', tools.runtime, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-classpath', [tools.stdlib, tools.annotations].join(delimiter), '-d', output, production, ...paths], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  compiled.set(name, output);
  return { ...tools, output };
}
function run(tools, scenario) {
  return spawnSync(tools.java, ['-cp', [tools.output, tools.stdlib].join(delimiter), 'com.tgk30.debridstreamer.BehaviorKt', scenario], { encoding: 'utf8', timeout: 10000 });
}

for (const scenario of ['admission', 'hidden', 'navigation', 'repeat', 'rotation', 'detach', 'ownership', 'fallback']) {
  test(`actual Kotlin IME controller: ${scenario}`, (t) => {
    const tools = compile(t, source, 'production');
    if (!tools) return;
    const result = run(tools, scenario);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`IME behavior case passed: ${scenario}; assertions=\\d+`));
    t.diagnostic(`Kotlin ${tools.version}: ${result.stdout.trim()}`);
  });
}

const mutants = [
  ['eager-parent-binding', 'admission', 'if (webView.isAttachedToWindow && bindAttachedLayout())', 'if (bindAttachedLayout())', 'Wry parent not ready'],
  ['hidden-ime-counted', 'hidden', 'if (insets.isVisible(imeType)) insets.getInsets(imeType).bottom else 0', 'insets.getInsets(imeType).bottom', 'hidden IME baseline'],
  ['persistent-insets-double-counted', 'navigation', 'maxOf(0, imeBottom - persistentBottom)', 'imeBottom', 'incremental keyboard overlap'],
  ['overlap-accumulates', 'repeat', 'val nextBottom = baselineBottom + overlap', 'val nextBottom = layout.bottomMargin + overlap', 'no accumulating overlap'],
  ['consumed-blocks-notifications', 'rotation', 'WindowInsetsCompat.Builder(insets).setInsets(imeType, Insets.NONE).build()', 'WindowInsetsCompat.CONSUMED', 'not consumed'],
  ['ime-not-zeroed', 'navigation', '.setInsets(imeType, Insets.NONE)', '.setInsets(imeType, insets.getInsets(imeType))', 'default policy receives zero IME'],
  ['detach-leaks-margin', 'detach', 'override fun onViewDetachedFromWindow(view: View) {\n      restoreOwnedMargin()', 'override fun onViewDetachedFromWindow(view: View) {', 'detach restores baseline'],
  ['foreign-layout-taken-over', 'ownership', 'if (!ownsCurrentLayout()) {\n        reject(AttachResult.OWNERSHIP_CHANGED)', 'if (false) {\n        reject(AttachResult.OWNERSHIP_CHANGED)', 'replacement layout keeps native insets'],
  ['native-fallback-suppressed', 'fallback', 'ViewCompat.onApplyWindowInsets(webView, insets)', 'insets', 'waiting fallback default handler called once'],
  ['owned-default-suppressed', 'fallback', 'applyDefaultInsets(WindowInsetsCompat.Builder(insets).setInsets(imeType, Insets.NONE).build())', 'WindowInsetsCompat.Builder(insets).setInsets(imeType, Insets.NONE).build()', 'owned default handler called once'],
];

test('individual causal IME mutants are rejected by executed Kotlin assertions', async (t) => {
  for (const [name, scenario, before, replacement, expected] of mutants) {
    await t.test(name, (subtest) => {
      assert.equal(source.split(before).length - 1, 1, `Mutant ${name} must change exactly one production region`);
      const tools = compile(subtest, source.replace(before, replacement), name);
      if (!tools) return;
      const result = run(tools, scenario);
      assert.notEqual(result.status, 0, `Mutant survived: ${name}`);
      assert.match(result.stdout + result.stderr, new RegExp(expected), `Mutant ${name} must fail its intended behavior assertion`);
      subtest.diagnostic(`${name}: Kotlin case ${scenario} rejected the mutation`);
    });
  }
});
