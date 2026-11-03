import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { patchGeneratedFullscreenSource, patchedMainActivityForWebViewCompatibilityTest } from './patch_tauri_android.mjs';

const source = readFileSync(new URL('./android/YawfFullscreenController.kt', import.meta.url), 'utf8');
const original = `package com.tgk30.debridstreamer
class RustWebChromeClient(private val activity: WryActivity, private val webViewId: String) : WebChromeClient() {
  override fun onShowCustomView(view: View, callback: CustomViewCallback) {
    callback.onCustomViewHidden()
    super.onShowCustomView(view, callback)
  }
  override fun onHideCustomView() {
    super.onHideCustomView()
  }
  override fun onPermissionRequest(request: PermissionRequest) { unchanged(request) }
  override fun onShowFileChooser(): Boolean { return untouched() }
}
`;

test('patches only fullscreen methods, is idempotent after regeneration and preserves all surrounding bytes', () => {
  const patched = patchGeneratedFullscreenSource(original);
  assert.match(patched, /host.showWebFullscreen\(view, callback\)/);
  assert.match(patched, /\(activity as\? MainActivity\)\?\.hideWebFullscreen\(\)/);
  assert.doesNotMatch(patched, /super.onShowCustomView|super.onHideCustomView/);
  const scrub = (text) => text.replace(/  override fun onShowCustomView[\s\S]*?\n  }/, '<show>').replace(/  override fun onHideCustomView[\s\S]*?\n  }/, '<hide>');
  assert.equal(scrub(patched), scrub(original));
  assert.equal(patchGeneratedFullscreenSource(patched), patched);
  assert.equal(patchGeneratedFullscreenSource(original), patched, 'Rust regeneration must be patched again');
});

test('rejects upstream fullscreen drift, overloads, missing methods and partial/unrecognized patches', () => {
  const mutants = [
    original.replace('    callback.onCustomViewHidden()', '    unexpected()'),
    patchGeneratedFullscreenSource(original).replace('    (activity as? MainActivity)?.hideWebFullscreen()', '    super.onHideCustomView()'),
    original.replace('    super.onHideCustomView()', '    unexpected()'),
    original.replace('onHideCustomView()', 'onHideSomethingElse()'),
    original + '\n override fun onShowCustomView(view: View) {}',
    original.replace('super.onShowCustomView(view, callback)', 'super.onShowCustomView(view, callback)\n    unexpected()'),
  ];
  for (const mutant of mutants) assert.throws(() => patchGeneratedFullscreenSource(mutant), /Unsupported generated Wry fullscreen/);
});

test('Activity uses narrow native hooks with no new JS interface or ChromeClient replacement', () => {
  const activity = patchedMainActivityForWebViewCompatibilityTest('com.tgk30.debridstreamer');
  assert.match(activity, /fullscreenController = YawfFullscreenController\(this, webView\)/);
  assert.match(activity, /fullscreenController\?\.onConfigurationChanged\(\)/);
  assert.equal(activity.match(/fullscreenController\?\.destroy\(\)/g).length, 2);
  assert.equal(activity.match(/@JavascriptInterface/g).length, 1);
  assert.doesNotMatch(activity + source, /setWebChromeClient|webChromeClient\s*=|requestFullscreen|requestedOrientation\s*=/);
});

test('Gradle wires exact per-variant Rust producer before compile-time patch, not init-time generated output', () => {
  const patcher = readFileSync(new URL('./patch_tauri_android.mjs', import.meta.url), 'utf8');
  const hook = patcher.slice(patcher.indexOf('function fullscreenGradleHook'), patcher.indexOf('export function parseLeading'));
  assert.match(hook, /tasks.configureEach/);
  assert.match(hook, /tasks.register<org\.gradle\.api\.tasks\.Exec>\("yawfPatchWebFullscreen"\)/);
  assert.match(hook, /mustRunAfter\(tasks.matching \{ it.name.startsWith\("rustBuild"\) \}\)/);
  assert.match(hook, /dependsOn\("rustBuild" \+ rustVariant, yawfFullscreenPatch\)/);
  assert.match(hook, /commandLine\("node",/);
  assert.doesNotMatch(hook, /project\.exec|doLast \{/);
  assert.doesNotMatch(hook, /doFirst \{/);
  assert.match(hook, /--fullscreen-only/);
  assert.match(hook, /generated\/RustWebChromeClient.kt/);
  assert.match(hook, /compile\(Universal\|Arm64\|Arm\|X86\|X86_64\)\(Debug\|Release\)Kotlin/);
});

function filesBelow(root, match) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesBelow(path, match) : match(path) ? [path] : [];
  });
}

function compilerRuntimeCoordinates(pom) {
  // Published compiler POMs contain literal direct runtime dependencies. Do not
  // impose an old compiler's dependency list on a newly generated template.
  return [...pom.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].flatMap(([, body]) => {
    const field = (name) => new RegExp(`<${name}>([^<]+)</${name}>`).exec(body)?.[1].trim();
    if (!['compile', 'runtime'].includes(field('scope') || 'compile')) return [];
    const coordinate = ['groupId', 'artifactId', 'version'].map(field);
    assert.ok(coordinate.every((value) => value && /^[\w.+-]+$/.test(value)), 'Unsupported Kotlin compiler POM dependency');
    return [coordinate.join('/')];
  });
}

test('compiler runtime follows published coordinates, including removed and newly required dependencies', () => {
  const dependency = (group, artifact, version) => `<dependency><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>${version}</version><scope>runtime</scope></dependency>`;
  const modern = dependency('org.jetbrains.kotlin', 'kotlin-daemon-embeddable', '2.2.10') + dependency('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.8.0');
  assert.deepEqual(compilerRuntimeCoordinates(modern), ['org.jetbrains.kotlin/kotlin-daemon-embeddable/2.2.10', 'org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm/1.8.0']);
  assert.deepEqual(compilerRuntimeCoordinates(dependency('org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330')), ['org.jetbrains.intellij.deps/trove4j/1.0.20200330']);
  assert.throws(() => compilerRuntimeCoordinates(dependency('org.jetbrains.kotlin', 'kotlin-stdlib', '${kotlin.version}')), /Unsupported Kotlin compiler POM dependency/);
});

// Minimal host doubles execute the actual production controller, not a JS model.
const stubs = {
  'graphics.kt': `package android.graphics
object Color { const val BLACK = -16777216 }`,
  'view.kt': `package android.view
open class View {
 var parent: ViewGroup? = null; var visibility = 0; var systemUiVisibility = 0; var hasInsets = true
 var layoutWidth = 0; var layoutHeight = 0
 fun requestFocus() = true
 companion object { const val INVISIBLE = 4 }
}
open class ViewGroup : View() {
 open class LayoutParams(val width: Int, val height: Int)
 val children = mutableListOf<View>(); var failNextAdd = false
 fun addView(view: View, params: LayoutParams) { if (failNextAdd) { failNextAdd = false; error("attach failed") }; check(view.parent == null); view.parent = this; view.layoutWidth = params.width; view.layoutHeight = params.height; children.add(view) }
 fun removeView(view: View) { children.remove(view); if (view.parent === this) view.parent = null }
}
class WindowManager { class LayoutParams { var flags = 0; companion object { const val FLAG_FULLSCREEN = 1024 } } }
class Window {
 val decorView = ViewGroup(); val attributes = WindowManager.LayoutParams(); var visibleMask = 7
 val bars = androidx.core.view.WindowInsetsControllerCompat(this)
 init { androidx.core.view.ViewCompat.windows[decorView] = this }
 fun setFlags(flags: Int, mask: Int) { attributes.flags = (attributes.flags and mask.inv()) or (flags and mask) }
}`,
  'webkit.kt': `package android.webkit
class WebView : android.view.View()
class WebChromeClient { interface CustomViewCallback { fun onCustomViewHidden() } }`,
  'frame.kt': `package android.widget
class FrameLayout(activity: androidx.activity.ComponentActivity) : android.view.ViewGroup() {
 class LayoutParams(width: Int, height: Int) : android.view.ViewGroup.LayoutParams(width, height)
 fun setBackgroundColor(color: Int) {}
}`,
  'activity.kt': `package androidx.activity
class ComponentActivity {
 val window = android.view.Window(); var isFinishing = false; var isDestroyed = false; var requestedOrientation = -1
 val onBackPressedDispatcher = Dispatcher()
}
abstract class OnBackPressedCallback(var isEnabled: Boolean) {
 var removeAction: (() -> Unit)? = null
 abstract fun handleOnBackPressed()
 fun remove() { removeAction?.invoke() }
}
class Dispatcher {
 val callbacks = mutableListOf<OnBackPressedCallback>(); var fallbackCount = 0
 fun addCallback(owner: ComponentActivity, callback: OnBackPressedCallback) { callbacks.add(callback); callback.removeAction = { callbacks.remove(callback) } }
 fun press() { val callback = callbacks.lastOrNull { it.isEnabled }; if (callback != null) callback.handleOnBackPressed() else fallbackCount++ }
}`,
  'insets.kt': `package androidx.core.view
class WindowInsetsCompat(private val mask: Int) {
 fun isVisible(type: Int) = mask and type == type
 object Type { fun statusBars() = 1; fun navigationBars() = 2; fun captionBar() = 4; fun systemBars() = 7 }
}
object ViewCompat { fun getRootWindowInsets(view: android.view.View): WindowInsetsCompat? = if (view.hasInsets) WindowInsetsCompat(windows[view]?.visibleMask ?: 7) else null; val windows = mutableMapOf<android.view.View, android.view.Window>() }
object WindowCompat { fun getInsetsController(window: android.view.Window, view: android.view.View): WindowInsetsControllerCompat { ViewCompat.windows[view] = window; return window.bars } }
class WindowInsetsControllerCompat(private val window: android.view.Window) {
 var systemBarsBehavior = 0
 fun hide(type: Int) { window.visibleMask = window.visibleMask and type.inv(); window.decorView.systemUiVisibility = 999; window.attributes.flags = window.attributes.flags or 1024 }
 fun show(type: Int) { window.visibleMask = window.visibleMask or type }
 companion object { const val BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE = 2 }
}`,
};

test('required behavior gate rejects missing toolchains while generic Node runs may skip', () => {
  const root = mkdtempSync(join(tmpdir(), 'yawf-fullscreen-no-toolchain-'));
  try {
    const args = ['--test', '--test-reporter=tap', '--test-name-pattern=^actual Kotlin controller lifecycle', fileURLToPath(import.meta.url)];
    const env = { ...process.env, JAVA_HOME: join(root, 'no-java'), GRADLE_USER_HOME: join(root, 'no-gradle') };
    delete env.NODE_TEST_CONTEXT;
    const required = spawnSync(process.execPath, args, { env: { ...env, YAWF_REQUIRE_ANDROID_FULLSCREEN_BEHAVIOR: '1' }, encoding: 'utf8', timeout: 10000 });
    assert.equal(required.status, 1, required.stdout + required.stderr);
    assert.match(required.stdout + required.stderr, /Required Android fullscreen behavior toolchain unavailable/);
    const optional = spawnSync(process.execPath, args, { env: { ...env, YAWF_REQUIRE_ANDROID_FULLSCREEN_BEHAVIOR: '0' }, encoding: 'utf8', timeout: 10000 });
    assert.equal(optional.status, 0, optional.stdout + optional.stderr);
    assert.match(optional.stdout, /# SKIP Kotlin compiler cache or Java unavailable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('actual Kotlin controller lifecycle, duplicate requests, callback-once, Back, configuration, failures and restoration', (t) => {
  const modules = join(process.env.GRADLE_USER_HOME || join(homedir(), '.gradle'), 'caches/modules-2/files-2.1');
  const jar = (path) => {
    const [, artifact, version] = path.split('/');
    return filesBelow(join(modules, path), (file) => version ? basename(file) === `${artifact}-${version}.jar` : file.endsWith('.jar'))[0];
  };
  const pom = (version) => filesBelow(join(modules, `org.jetbrains.kotlin/kotlin-compiler-embeddable/${version}`), (file) => file.endsWith(`kotlin-compiler-embeddable-${version}.pom`))[0];
  // CI warms the template's Kotlin version, which need not match this Mac's.
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
  const components = [['kotlin-compiler-embeddable with matching stdlib, script-runtime and POM', compiler], ['org.jetbrains/annotations', annotations], ...dependencies.map((coordinate) => [coordinate, jar(coordinate)])];
  const runtime = components.map(([, file]) => file);
  const java = join(process.env.JAVA_HOME || '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const missing = [...components.filter(([, file]) => !file).map(([name]) => name), ...(!existsSync(java) ? ['JAVA_HOME/bin/java'] : [])];
  if (missing.length) {
    assert.notEqual(process.env.YAWF_REQUIRE_ANDROID_FULLSCREEN_BEHAVIOR, '1',
      `Required Android fullscreen behavior toolchain unavailable: missing ${missing.join(', ')}; warm the Kotlin Gradle cache and set JAVA_HOME`);
    return t.skip('Kotlin compiler cache or Java unavailable');
  }
  t.diagnostic(`Kotlin compiler ${version}; runtime: ${dependencies.join(', ')}, org.jetbrains/annotations`);
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'yawf-fullscreen-kotlin-'));
  try {
    const paths = Object.entries(stubs).map(([name, text]) => { const path = join(root, name); writeFileSync(path, text); return path; });
    const output = join(root, 'behavior.jar');
    const production = fileURLToPath(new URL('./android/YawfFullscreenController.kt', import.meta.url));
    const behavior = fileURLToPath(new URL('./android/YawfFullscreenControllerBehaviorTest.kt', import.meta.url));
    const compile = spawnSync(java, ['-cp', runtime.join(delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-classpath', [stdlib, annotations].join(delimiter), '-d', output, production, behavior, ...paths], { encoding: 'utf8', timeout: 60000 });
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    const run = spawnSync(java, ['-cp', [output, stdlib].join(delimiter), 'com.tgk30.debridstreamer.YawfFullscreenControllerBehaviorTestKt'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /behavior assertions passed: 161/);
    t.diagnostic(run.stdout.trim());
  } finally { rmSync(root, { recursive: true, force: true }); }
});
