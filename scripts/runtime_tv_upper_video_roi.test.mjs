import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = dirname(fileURLToPath(import.meta.url));
const javaDirectory = join(
  scripts,
  "android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation",
);
const helperPath = join(javaDirectory, "RuntimeTvUpperVideoRoi.java");
const driverPath = join(javaDirectory, "RuntimeTvFlowTest.java");
const javac = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin/javac") : "javac";
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin/java") : "java";
const read = path => readFileSync(path, "utf8");

const helperProbeSource = String.raw`
package com.yawf.runtimeinstrumentation;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.Arrays;
import java.util.List;

public final class RuntimeTvUpperVideoRoiProbe {
    private static final String PRODUCT_PACKAGE = "com.yawf.stream.tv";
    private static final String CONTENT_RESOURCE = PRODUCT_PACKAGE + ":id/exo_content_frame";
    private static final String CENTER_RESOURCE = PRODUCT_PACKAGE + ":id/exo_center_controls";

    private static RuntimeTvUpperVideoRoi.Bounds bounds(
            int left, int top, int right, int bottom) {
        return new RuntimeTvUpperVideoRoi.Bounds(left, top, right, bottom);
    }

    private static RuntimeTvUpperVideoRoi.Node node(
            String packageName,
            String resourceName,
            String className,
            boolean visible,
            RuntimeTvUpperVideoRoi.Bounds bounds) {
        return new RuntimeTvUpperVideoRoi.Node(
                packageName, resourceName, className, visible, bounds);
    }

    private static RuntimeTvUpperVideoRoi.Node root() {
        return node(PRODUCT_PACKAGE, null, "android.widget.FrameLayout", true,
                bounds(0, 0, 1920, 1080));
    }

    private static RuntimeTvUpperVideoRoi.Node content() {
        return node(PRODUCT_PACKAGE, CONTENT_RESOURCE, "android.widget.FrameLayout", true,
                bounds(240, 0, 1680, 1080));
    }

    private static RuntimeTvUpperVideoRoi.Node surface() {
        return node(PRODUCT_PACKAGE, null, "android.view.SurfaceView", true,
                bounds(240, 0, 1680, 1080));
    }

    private static RuntimeTvUpperVideoRoi.Node center() {
        return node(PRODUCT_PACKAGE, CENTER_RESOURCE, "android.widget.LinearLayout", true,
                bounds(602, 440, 1318, 640));
    }

    private static RuntimeTvUpperVideoRoi.Candidate candidate(
            boolean nativeAdmitted,
            RuntimeTvUpperVideoRoi.Node root,
            List<RuntimeTvUpperVideoRoi.Node> content,
            List<RuntimeTvUpperVideoRoi.Node> surfaces,
            List<RuntimeTvUpperVideoRoi.Node> centers) {
        return new RuntimeTvUpperVideoRoi.Candidate(
                nativeAdmitted, root, content, surfaces, centers);
    }

    private static RuntimeTvUpperVideoRoi.Candidate valid() {
        return candidate(true, root(), List.of(content()), List.of(surface()), List.of(center()));
    }

    private static void check(boolean value, String label) {
        if (!value) throw new AssertionError(label);
    }

    private static void expectAssertion(Runnable action, String label) {
        try {
            action.run();
        } catch (AssertionError expected) {
            return;
        }
        throw new AssertionError("Expected AssertionError: " + label);
    }

    private static void exactAdmissionAndImmutableBounds() {
        RuntimeTvUpperVideoRoi.Admission admission = RuntimeTvUpperVideoRoi.admit(
                PRODUCT_PACKAGE, List.of(valid()));
        RuntimeTvUpperVideoRoi.Bounds roi = RuntimeTvUpperVideoRoi.validateScreenshot(
                admission, 1920, 1080);
        check(roi.left == 480 && roi.top == 270
                        && roi.right == 1440 && roi.bottom == 405,
                "exact upper-video ROI changed");
        check(roi.width() == 960 && roi.height() == 135,
                "exact upper-video ROI dimensions changed");
        check(admission.contentFrameBounds.equals(bounds(240, 0, 1680, 1080)),
                "content bounds were not retained");
        check(admission.videoSurfaceBounds.equals(bounds(240, 0, 1680, 1080)),
                "surface bounds were not retained");
        check(admission.centerControlsBounds.equals(bounds(602, 440, 1318, 640)),
                "center-control bounds were not retained");
        for (Class<?> type : List.of(
                RuntimeTvUpperVideoRoi.Bounds.class,
                RuntimeTvUpperVideoRoi.Admission.class)) {
            for (Field field : type.getDeclaredFields()) {
                check(Modifier.isFinal(field.getModifiers()),
                        type.getSimpleName() + "." + field.getName() + " was mutable");
            }
        }
    }

    private static void rejectsWrongPackageAndRootMultiplicity() {
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit("com.example.wrong", List.of(valid())),
                "wrong foreground package");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of()),
                "missing PlayerView");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(
                PRODUCT_PACKAGE, List.of(valid(), valid())), "ambiguous PlayerView");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                false, root(), List.of(content()), List.of(surface()), List.of(center())))),
                "unadmitted PlayerView");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true,
                node("com.example.wrong", null, "android.widget.FrameLayout", true,
                        bounds(0, 0, 1920, 1080)),
                List.of(content()), List.of(surface()), List.of(center())))),
                "wrong root package");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true,
                node(PRODUCT_PACKAGE, null, "android.view.View", true,
                        bounds(0, 0, 1920, 1080)),
                List.of(content()), List.of(surface()), List.of(center())))),
                "root geometry substituted without exact root identity");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true,
                node(PRODUCT_PACKAGE, null, "android.widget.FrameLayout", false,
                        bounds(0, 0, 1920, 1080)),
                List.of(content()), List.of(surface()), List.of(center())))),
                "hidden PlayerView root");
    }

    private static void rejectsMissingAmbiguousAndNonsemanticNodes() {
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(), List.of(surface()), List.of(center())))),
                "missing content frame");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(content(), content()), List.of(surface()), List.of(center())))),
                "ambiguous content frame");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(content()), List.of(), List.of(center())))),
                "missing SurfaceView");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(content()), List.of(surface(), surface()), List.of(center())))),
                "ambiguous SurfaceView");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(content()), List.of(surface()), List.of()))),
                "missing center controls");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(content()), List.of(surface()), List.of(center(), center())))),
                "ambiguous center controls");

        RuntimeTvUpperVideoRoi.Node title = node(
                PRODUCT_PACKAGE,
                PRODUCT_PACKAGE + ":id/exo_title",
                "android.widget.TextView",
                true,
                bounds(480, 0, 1440, 100));
        RuntimeTvUpperVideoRoi.Node focusedPlay = node(
                PRODUCT_PACKAGE,
                PRODUCT_PACKAGE + ":id/exo_play_pause",
                "android.widget.ImageButton",
                true,
                bounds(908, 488, 1012, 592));
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(title), List.of(surface()), List.of(center())))),
                "title substituted for content frame");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(root()), List.of(surface()), List.of(center())))),
                "root substituted for content frame");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(content()), List.of(focusedPlay), List.of(center())))),
                "focused node substituted for video surface");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(content()), List.of(surface()), List.of(focusedPlay)))),
                "focused node substituted for center controls");
    }

    private static void rejectsEmptyOutsideAndOverlayIntersection() {
        RuntimeTvUpperVideoRoi.Node emptyContent = node(
                PRODUCT_PACKAGE, CONTENT_RESOURCE, "android.widget.FrameLayout", true,
                bounds(0, 0, 0, 0));
        RuntimeTvUpperVideoRoi.Node emptyCenter = node(
                PRODUCT_PACKAGE, CENTER_RESOURCE, "android.widget.LinearLayout", true,
                bounds(0, 0, 0, 0));
        RuntimeTvUpperVideoRoi.Node offscreenSurface = node(
                PRODUCT_PACKAGE, null, "android.view.SurfaceView", true,
                bounds(-1, 0, 1680, 1080));
        RuntimeTvUpperVideoRoi.Node offscreenRoot = node(
                PRODUCT_PACKAGE, null, "android.widget.FrameLayout", true,
                bounds(-1, 0, 1920, 1080));
        RuntimeTvUpperVideoRoi.Node contentExcludingRoi = node(
                PRODUCT_PACKAGE, CONTENT_RESOURCE, "android.widget.FrameLayout", true,
                bounds(481, 0, 1680, 1080));
        RuntimeTvUpperVideoRoi.Node surfaceExcludingRoi = node(
                PRODUCT_PACKAGE, null, "android.view.SurfaceView", true,
                bounds(240, 0, 1439, 1080));
        RuntimeTvUpperVideoRoi.Node intersectingControls = node(
                PRODUCT_PACKAGE, CENTER_RESOURCE, "android.widget.LinearLayout", true,
                bounds(602, 300, 1318, 500));
        RuntimeTvUpperVideoRoi.Node hiddenControls = node(
                PRODUCT_PACKAGE, CENTER_RESOURCE, "android.widget.LinearLayout", false,
                bounds(602, 440, 1318, 640));
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(emptyContent), List.of(surface()), List.of(center())))),
                "empty content bounds");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(content()), List.of(surface()), List.of(emptyCenter)))),
                "empty center-control bounds");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(content()), List.of(offscreenSurface), List.of(center())))),
                "offscreen surface bounds");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, offscreenRoot, List.of(content()), List.of(surface()), List.of(center())))),
                "offscreen PlayerView root bounds");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(contentExcludingRoi), List.of(surface()), List.of(center())))),
                "ROI outside content frame");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(content()), List.of(surfaceExcludingRoi), List.of(center())))),
                "ROI outside video surface");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(content()), List.of(surface()), List.of(intersectingControls)))),
                "ROI intersecting center controls");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(content()), List.of(surface()), List.of(hiddenControls)))),
                "hidden center controls");
    }

    private static void rejectsWrongSemanticPackagesAndScreenshotDimensions() {
        RuntimeTvUpperVideoRoi.Node wrongContent = node(
                "com.example.wrong", CONTENT_RESOURCE, "android.widget.FrameLayout", true,
                bounds(240, 0, 1680, 1080));
        RuntimeTvUpperVideoRoi.Node wrongSurface = node(
                "com.example.wrong", null, "android.view.SurfaceView", true,
                bounds(240, 0, 1680, 1080));
        RuntimeTvUpperVideoRoi.Node wrongCenter = node(
                "com.example.wrong", CENTER_RESOURCE, "android.widget.LinearLayout", true,
                bounds(602, 440, 1318, 640));
        RuntimeTvUpperVideoRoi.Node wrongContentClass = node(
                PRODUCT_PACKAGE, CONTENT_RESOURCE, "android.view.View", true,
                bounds(240, 0, 1680, 1080));
        RuntimeTvUpperVideoRoi.Node wrongSurfaceClass = node(
                PRODUCT_PACKAGE, null, "android.widget.FrameLayout", true,
                bounds(240, 0, 1680, 1080));
        RuntimeTvUpperVideoRoi.Node wrongCenterClass = node(
                PRODUCT_PACKAGE, CENTER_RESOURCE, "android.widget.FrameLayout", true,
                bounds(602, 440, 1318, 640));
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(wrongContent), List.of(surface()), List.of(center())))),
                "wrong content package");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(content()), List.of(wrongSurface), List.of(center())))),
                "wrong surface package");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(content()), List.of(surface()), List.of(wrongCenter)))),
                "wrong center-control package");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(wrongContentClass), List.of(surface()), List.of(center())))),
                "wrong content class");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(content()), List.of(wrongSurfaceClass), List.of(center())))),
                "wrong surface class");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.admit(PRODUCT_PACKAGE, List.of(candidate(
                true, root(), List.of(content()), List.of(surface()), List.of(wrongCenterClass)))),
                "wrong center-control class");
        RuntimeTvUpperVideoRoi.Admission admission = RuntimeTvUpperVideoRoi.admit(
                PRODUCT_PACKAGE, List.of(valid()));
        expectAssertion(() -> RuntimeTvUpperVideoRoi.validateScreenshot(admission, 1919, 1080),
                "wrong screenshot width");
        expectAssertion(() -> RuntimeTvUpperVideoRoi.validateScreenshot(admission, 1920, 1079),
                "wrong screenshot height");
    }

    public static void main(String[] arguments) {
        exactAdmissionAndImmutableBounds();
        rejectsWrongPackageAndRootMultiplicity();
        rejectsMissingAmbiguousAndNonsemanticNodes();
        rejectsEmptyOutsideAndOverlayIntersection();
        rejectsWrongSemanticPackagesAndScreenshotDimensions();
    }
}
`;

function runHelperProbe(helperSource = read(helperPath)) {
  const directory = mkdtempSync(join(tmpdir(), "yawf-tv-upper-video-roi-"));
  const packageDirectory = join(directory, "com/yawf/runtimeinstrumentation");
  mkdirSync(packageDirectory, { recursive: true });
  const helperSourcePath = join(packageDirectory, "RuntimeTvUpperVideoRoi.java");
  const probeSourcePath = join(packageDirectory, "RuntimeTvUpperVideoRoiProbe.java");
  writeFileSync(helperSourcePath, helperSource);
  writeFileSync(probeSourcePath, helperProbeSource);
  const compile = spawnSync(javac, ["-d", directory, helperSourcePath, probeSourcePath], {
    encoding: "utf8",
  });
  if (compile.status !== 0) return { compile, run: null };
  return {
    compile,
    run: spawnSync(java, ["-cp", directory,
      "com.yawf.runtimeinstrumentation.RuntimeTvUpperVideoRoiProbe"], { encoding: "utf8" }),
  };
}

function replaceUnique(source, search, replacement, label) {
  assert.equal(source.split(search).length, 2, `${label} mutation anchor must be unique`);
  return source.replace(search, replacement);
}

function replaceAllExact(source, search, replacement, count, label) {
  assert.equal(source.split(search).length - 1, count,
    `${label} mutation anchor count changed`);
  return source.replaceAll(search, replacement);
}

function assertHelperMutantKilled(label, source) {
  const result = runHelperProbe(source);
  assert.equal(result.compile.status, 0,
    `${label} mutant did not compile:\n${result.compile.stdout}${result.compile.stderr}`);
  assert.ok(result.run, `${label} mutant did not run`);
  assert.notEqual(result.run.status, 0,
    `${label} mutant survived:\n${result.run.stdout}${result.run.stderr}`);
  assert.match(result.run.stderr, /AssertionError/, `${label} did not fail an assertion`);
  const failure = result.run.stderr.split("\n")
    .find(line => line.includes("AssertionError")) ?? result.run.stderr.trim().split("\n")[0];
  console.log(`killed helper negative control: ${label}: ${failure.trim()}`);
}

function methodSlice(source, anchor) {
  const start = source.indexOf(anchor);
  assert.ok(start >= 0, `missing method anchor: ${anchor}`);
  const opening = source.indexOf("{", start);
  assert.ok(opening >= 0, `missing method opening brace: ${anchor}`);
  let depth = 0;
  for (let index = opening; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new AssertionError(`unterminated method: ${anchor}`);
}

function assertDriverIntegration(source) {
  const flow = methodSlice(source, "private void runFlow()");
  const adapter = methodSlice(source,
    "private RuntimeTvUpperVideoRoi.Admission readUpperVideoRoiAdmission()");
  const sampler = methodSlice(source,
    "private String upperVideoFrameHash(\n            RuntimeTvUpperVideoRoi.Admission admission,\n            String evidenceLabel");
  const selector = methodSlice(source, "private BySelector nativeCenterControlsSelector()");

  assert.equal((flow.match(/observeFreshNative\(this::readUpperVideoRoiAdmission\)/g) ?? []).length, 2,
    "playing and paused pairs must each use one fresh immutable ROI admission");
  assert.match(flow, /upperVideoFrameHash\(playingFrameRoi\);[\s\S]*SystemClock\.sleep\(2_500\);[\s\S]*upperVideoFrameHash\(playingFrameRoi\);/);
  assert.match(flow, /upperVideoFrameHash\(\s*pausedFrameRoi, "pause-hash-before", pausedStart\);[\s\S]*SystemClock\.sleep\(3_000\);[\s\S]*upperVideoFrameHash\(\s*pausedFrameRoi, "pause-hash-after", pausedEnd\);/);
  assert.doesNotMatch(flow, /centerFrameHash/);

  assert.match(selector, /By\.res\(PRODUCT_PACKAGE, "exo_center_controls"\)/);
  assert.match(selector, /\.pkg\(PRODUCT_PACKAGE\)/);
  assert.match(selector, /\.clazz\("android\.widget\.LinearLayout"\)/);

  assert.match(adapter, /String foregroundPackage = device\.getCurrentPackageName\(\);/);
  assert.match(adapter, /device\.findObjects\(nativePlayerSurfaceRootSelector\(\)\)/);
  assert.match(adapter, /readNativePlayerSurfaceCandidate\(root\)/);
  assert.match(adapter, /RuntimeTvNativeSurface\.admits\(nativeSurface\)/);
  assert.match(adapter, /root\.findObjects\(nativeContentFrameSelector\(\)\)/);
  assert.match(adapter, /contentFrame\.findObjects\(\s*nativeVideoSurfaceSelector\(\)\)/);
  assert.match(adapter, /controller\.findObjects\(\s*nativeCenterControlsSelector\(\)\)/);
  assert.match(adapter, /contentFrameSnapshots\.add\(snapshotUpperVideoRoiNode\(contentFrame\)\)/);
  assert.match(adapter, /videoSurfaceSnapshots\.add\(snapshotUpperVideoRoiNode\(videoSurface\)\)/);
  assert.match(adapter, /centerControlSnapshots\.add\(snapshotUpperVideoRoiNode\(centerControl\)\)/);
  assert.match(adapter, /snapshotUpperVideoRoiNode\(root\)/);
  assert.match(adapter, /return RuntimeTvUpperVideoRoi\.admit\(foregroundPackage, candidateSnapshots\);/);
  assert.doesNotMatch(adapter, /readCurrentNativeFocus|By\.focused|BoundsSnapshot/);

  assert.match(sampler, /instrumentation\.getUiAutomation\(\)\.takeScreenshot\(\)/);
  assert.match(sampler, /RuntimeTvUpperVideoRoi\.validateScreenshot\(/);
  assert.match(sampler, /image\.getPixels\(pixels, 0, width, left, top, width, height\)/);
  assert.match(sampler, /upperVideoArgbSha256/);
  assert.match(sampler, /contentFrameBounds/);
  assert.match(sampler, /videoSurfaceBounds/);
  assert.match(sampler, /centerControlsBounds/);
  assert.match(sampler, /evidenceLabel \+ "\.png"/);
  assert.match(sampler, /writeText\(evidenceLabel \+ "\.json"/);
  assert.doesNotMatch(sampler,
    /\bdevice\b|observeFreshNative|findObjects?|getVisibleBounds|By\.|SystemClock\.sleep|pressDPad|sendNativeDpadKey/);
  assert.doesNotMatch(sampler, /getWidth\(\) \/ 4|getHeight\(\) \/ 4|getHeight\(\) \/ 2/);
}

function assertDriverMutantKilled(label, source) {
  assert.throws(() => assertDriverIntegration(source), undefined,
    `${label} driver mutant survived`);
  try {
    assertDriverIntegration(source);
  } catch (error) {
    console.log(`killed driver negative control: ${label}: ${error.message.split("\n")[0]}`);
  }
}

test("actual upper-video ROI helper admits only exact immutable geometry", () => {
  const result = runHelperProbe();
  assert.equal(result.compile.status, 0, result.compile.stdout + result.compile.stderr);
  assert.ok(result.run, "helper probe did not run");
  assert.equal(result.run.status, 0, result.run.stdout + result.run.stderr);
});

test("executable helper probe kills safety and geometry regressions", () => {
  const source = read(helperPath);
  const mutants = [
    ["foreground package omission", replaceUnique(source,
      "require(PRODUCT_PACKAGE.equals(foregroundPackage),",
      "require(true,", "foreground package omission")],
    ["duplicate PlayerView allowance", replaceAllExact(source,
      "admittedCount == 1", "admittedCount >= 1", 2,
      "duplicate PlayerView allowance")],
    ["semantic node uniqueness omission", replaceUnique(source,
      "nodes != null && nodes.size() == 1",
      "nodes != null && nodes.size() >= 1", "semantic node uniqueness omission")],
    ["content containment omission", replaceUnique(source,
      "require(contentFrame.bounds.contains(UPPER_VIDEO_ROI),",
      "require(true,", "content containment omission")],
    ["surface containment omission", replaceUnique(source,
      "require(videoSurface.bounds.contains(UPPER_VIDEO_ROI),",
      "require(true,", "surface containment omission")],
    ["overlay disjointness omission", replaceUnique(source,
      "require(!centerControls.bounds.intersects(UPPER_VIDEO_ROI),",
      "require(true,", "overlay disjointness omission")],
    ["exact screenshot dimensions omission", replaceUnique(source,
      "require(width == SCREEN_WIDTH && height == SCREEN_HEIGHT,",
      "require(true,", "exact screenshot dimensions omission")],
    ["wrong fixed ROI", replaceUnique(source,
      "new Bounds(480, 270, 1440, 405)",
      "new Bounds(480, 270, 1440, 945)", "wrong fixed ROI")],
    ["node package omission", replaceUnique(source,
      "require(PRODUCT_PACKAGE.equals(node.packageName)\n                        && equal(resourceName, node.resourceName)",
      "require(equal(resourceName, node.resourceName)", "node package omission")],
    ["root package omission", replaceUnique(source,
      "require(PRODUCT_PACKAGE.equals(candidate.playerRoot.packageName)\n                        && PLAYER_ROOT_CLASS.equals(candidate.playerRoot.className)",
      "require(PLAYER_ROOT_CLASS.equals(candidate.playerRoot.className)",
      "root package omission")],
    ["node resource omission", replaceUnique(source,
      "&& equal(resourceName, node.resourceName)\n                        && className.equals(node.className)",
      "&& className.equals(node.className)", "node resource omission")],
    ["node class omission", replaceUnique(source,
      "&& className.equals(node.className)\n                        && node.visible",
      "&& node.visible", "node class omission")],
    ["node visibility omission", replaceUnique(source,
      `&& node.visible,
                label + " identity was not exact");`,
      `,
                label + " identity was not exact");`,
      "node visibility omission")],
    ["root visibility omission", replaceUnique(source,
      `&& candidate.playerRoot.visible,
                "Admitted PlayerView root identity was not exact");`,
      `,
                "Admitted PlayerView root identity was not exact");`,
      "root visibility omission")],
    ["empty-bounds omission", replaceUnique(source,
      "require(node.bounds != null && !node.bounds.isEmpty(),",
      "require(node.bounds != null,", "empty-bounds omission")],
    ["onscreen-bounds omission", replaceUnique(source,
      "require(SCREEN_BOUNDS.contains(node.bounds),",
      "require(true,", "onscreen-bounds omission")],
  ];
  for (const [label, mutant] of mutants) assertHelperMutantKilled(label, mutant);
});

test("driver uses fresh semantic admission and a UI-read-free strict sampler", () => {
  assertDriverIntegration(read(driverPath));
});

test("driver integration guard kills bypass and geometry substitution regressions", () => {
  const source = read(driverPath);
  const mutants = [
    ["fresh observation bypass", replaceAllExact(source,
      "observeFreshNative(this::readUpperVideoRoiAdmission)",
      "readUpperVideoRoiAdmission()", 2, "fresh observation bypass")],
    ["actual ROI helper bypass", replaceUnique(source,
      "return RuntimeTvUpperVideoRoi.admit(foregroundPackage, candidateSnapshots);",
      "return null;", "actual ROI helper bypass")],
    ["foreground snapshot bypass", replaceUnique(source,
      "String foregroundPackage = device.getCurrentPackageName();\n        List<RuntimeTvUpperVideoRoi.Candidate> candidateSnapshots",
      "String foregroundPackage = PRODUCT_PACKAGE;\n        List<RuntimeTvUpperVideoRoi.Candidate> candidateSnapshots",
      "foreground snapshot bypass")],
    ["root bounds substituted for content frame", replaceUnique(source,
      "contentFrameSnapshots.add(snapshotUpperVideoRoiNode(contentFrame));",
      "contentFrameSnapshots.add(snapshotUpperVideoRoiNode(root));",
      "root bounds substituted for content frame")],
    ["root bounds substituted for video surface", replaceUnique(source,
      "videoSurfaceSnapshots.add(snapshotUpperVideoRoiNode(videoSurface));",
      "videoSurfaceSnapshots.add(snapshotUpperVideoRoiNode(root));",
      "root bounds substituted for video surface")],
    ["focused bounds substituted for center controls", replaceUnique(source,
      "centerControlSnapshots.add(snapshotUpperVideoRoiNode(centerControl));",
      "centerControlSnapshots.add(snapshotUpperVideoRoiNode(root.findObject(By.focused(true))));",
      "focused bounds substituted for center controls")],
    ["playing pair admission omitted", replaceUnique(source,
      "RuntimeTvUpperVideoRoi.Admission playingFrameRoi =\n                observeFreshNative(this::readUpperVideoRoiAdmission);",
      "RuntimeTvUpperVideoRoi.Admission playingFrameRoi = null;",
      "playing pair admission omitted")],
    ["pause pair admission omitted", replaceUnique(source,
      "RuntimeTvUpperVideoRoi.Admission pausedFrameRoi =\n                observeFreshNative(this::readUpperVideoRoiAdmission);",
      "RuntimeTvUpperVideoRoi.Admission pausedFrameRoi = null;",
      "pause pair admission omitted")],
    ["sampler performs live UI read", replaceUnique(source,
      "long screenshotStartedAt = SystemClock.uptimeMillis();",
      "device.getCurrentPackageName();\n        long screenshotStartedAt = SystemClock.uptimeMillis();",
      "sampler performs live UI read")],
    ["legacy center crop restored", replaceUnique(source,
      "int left = roi.left;",
      "int left = image.getWidth() / 4;", "legacy center crop restored")],
  ];
  for (const [label, mutant] of mutants) assertDriverMutantKilled(label, mutant);
});
