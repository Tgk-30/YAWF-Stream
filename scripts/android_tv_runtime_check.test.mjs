import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = dirname(fileURLToPath(import.meta.url));
const root = resolve(scripts, "..");
const hostPath = join(scripts, "android_tv_runtime_check.py");
const fixturePath = join(scripts, "android_tv_runtime_fixture.py");
const mainActivityPath = join(
  root,
  "android-tv/app/src/main/java/com/yawf/stream/tv/MainActivity.java",
);
const javaPath = join(
  scripts,
  "android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeTvFlowTest.java",
);
const clockJavaPath = join(
  scripts,
  "android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeTvClock.java",
);
const nativeSurfaceJavaPath = join(
  scripts,
  "android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeTvNativeSurface.java",
);
const manifestPath = join(
  scripts,
  "android-runtime-instrumentation/app/src/main/AndroidManifest.xml",
);
const retainedPlayerXmlPath = join(
  scripts,
  "android-runtime-instrumentation/fixtures/runtime-tv-media3-hidden-controls.xml",
);
const retainedVisibleControllerXmlPath = join(
  scripts,
  "android-runtime-instrumentation/fixtures/runtime-tv-media3-visible-controller-empty-description.xml",
);
const retainedTimeBarXmlPath = join(
  scripts,
  "android-runtime-instrumentation/fixtures/runtime-tv-media3-visible-timebar.xml",
);
const workflowPath = join(root, ".github/workflows/android-tv-runtime.yml");
const python = process.env.PYTHON || "python3";
const productPackage = "com.yawf.stream.tv";
const javac = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin/javac") : "javac";
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin/java") : "java";

const read = (path) => readFileSync(path, "utf8");

function runPythonSelfTest(path) {
  return spawnSync(python, [path, "self-test"], { encoding: "utf8" });
}

function killedPythonMutant(path, search, replacement, args = ["--self-test"]) {
  const original = read(path);
  assert.equal(original.split(search).length, 2, `mutation anchor must be unique: ${search}`);
  const directory = mkdtempSync(join(tmpdir(), "yawf-tv-mutant-"));
  const mutant = join(directory, path.endsWith("fixture.py") ? "fixture.py" : "host.py");
  writeFileSync(mutant, original.replace(search, replacement));
  const result = spawnSync(python, [mutant, ...args], { encoding: "utf8" });
  assert.notEqual(result.status, 0, `semantic mutant survived:\n${result.stdout}\n${result.stderr}`);
}

const clockProbeSource = `
package com.yawf.runtimeinstrumentation;

import java.util.List;

public final class RuntimeTvClockProbe {
    private record FakeTimeBar(boolean visible, String contentDescription) { }

    private static void equal(long actual, long expected, String label) {
        if (actual != expected) throw new AssertionError(label + ": " + actual + " != " + expected);
    }

    private static void rejects(Runnable action, String label) {
        try {
            action.run();
        } catch (AssertionError expected) {
            return;
        }
        throw new AssertionError("Expected rejection: " + label);
    }

    public static void main(String[] arguments) {
        equal(RuntimeTvClock.parsePositionClock("00:02"), 2, "MM:SS short position");
        equal(RuntimeTvClock.parsePositionClock("01:02"), 62, "MM:SS position");
        equal(RuntimeTvClock.parsePositionClock("1:02:03"), 3723, "H:MM:SS position");
        equal(RuntimeTvClock.parsePositionClock("00:06"), 6, "retained time bar position");
        for (String invalid : new String[] {
                null, "", "position 00:02", "00:02 remaining", "1:2:03", "00:60", "1:60:00",
                "999999999999999999999999:00:00"
        }) {
            rejects(() -> RuntimeTvClock.parsePositionClock(invalid), "invalid clock " + invalid);
        }

        FakeTimeBar hidden = new FakeTimeBar(false, "00:01");
        FakeTimeBar visible = new FakeTimeBar(true, "00:02");
        equal(RuntimeTvClock.readUniqueVisibleTimeBar(
                List.of(hidden, visible), FakeTimeBar::visible, FakeTimeBar::contentDescription),
                2, "one visible time bar");
        rejects(() -> RuntimeTvClock.readUniqueVisibleTimeBar(
                List.<FakeTimeBar>of(), FakeTimeBar::visible, FakeTimeBar::contentDescription),
                "missing time bar");
        rejects(() -> RuntimeTvClock.readUniqueVisibleTimeBar(
                List.of(visible, new FakeTimeBar(true, "00:03")),
                FakeTimeBar::visible, FakeTimeBar::contentDescription),
                "duplicate visible time bars");
        rejects(() -> RuntimeTvClock.readUniqueVisibleTimeBar(
                List.of(new FakeTimeBar(true, "prefix 00:02")),
                FakeTimeBar::visible, FakeTimeBar::contentDescription),
                "malformed time bar description");
    }
}
`;

function runJavaClockProbe(clockSource = read(clockJavaPath)) {
  const directory = mkdtempSync(join(tmpdir(), "yawf-tv-clock-"));
  const packageDirectory = join(directory, "com/yawf/runtimeinstrumentation");
  mkdirSync(packageDirectory, { recursive: true });
  const clockSourcePath = join(packageDirectory, "RuntimeTvClock.java");
  const probeSourcePath = join(packageDirectory, "RuntimeTvClockProbe.java");
  writeFileSync(clockSourcePath, clockSource);
  writeFileSync(probeSourcePath, clockProbeSource);
  const compile = spawnSync(javac, ["-d", directory, clockSourcePath, probeSourcePath], {
    encoding: "utf8",
  });
  if (compile.status !== 0) return compile;
  return spawnSync(java, ["-cp", directory, "com.yawf.runtimeinstrumentation.RuntimeTvClockProbe"], {
    encoding: "utf8",
  });
}

function killedJavaClockMutant(search, replacement) {
  const original = read(clockJavaPath);
  assert.equal(original.split(search).length, 2, `clock mutation anchor must be unique: ${search}`);
  const result = runJavaClockProbe(original.replace(search, replacement));
  assert.notEqual(result.status, 0, `Java clock mutant survived:\n${result.stdout}\n${result.stderr}`);
}

function javaSurfaceCandidate(candidate) {
  const string = value => value === null ? "null" : JSON.stringify(value);
  return `new RuntimeTvNativeSurface.Candidate(
                ${string(candidate.rootPackage)},
                ${string(candidate.rootClass)},
                ${string(candidate.description)},
                ${candidate.rootClickable},
                ${candidate.rootEnabled},
                ${candidate.rootFocusable},
                ${candidate.rootVisible},
                ${candidate.controllerCount},
                ${candidate.controllerVisible},
                ${candidate.playPauseCount},
                ${candidate.playPauseClickable},
                ${candidate.playPauseEnabled},
                ${candidate.playPauseFocusable},
                ${candidate.playPauseVisible},
                ${candidate.contentFrameCount},
                ${candidate.contentFrameVisible},
                ${candidate.videoSurfaceCount},
                ${candidate.videoSurfaceVisible})`;
}

function runJavaNativeSurfaceProbe(cases, surfaceSource = read(nativeSurfaceJavaPath)) {
  const directory = mkdtempSync(join(tmpdir(), "yawf-tv-native-surface-"));
  const packageDirectory = join(directory, "com/yawf/runtimeinstrumentation");
  mkdirSync(packageDirectory, { recursive: true });
  const surfaceSourcePath = join(packageDirectory, "RuntimeTvNativeSurface.java");
  const probeSourcePath = join(packageDirectory, "RuntimeTvNativeSurfaceProbe.java");
  const checks = cases.map(({ label, candidates, expected }) => {
    const values = candidates.map(javaSurfaceCandidate).join(",\n                ");
    return `        check("${label}", ${expected}, new RuntimeTvNativeSurface.Candidate[] {
                ${values}
        });`;
  }).join("\n");
  const probe = `
package com.yawf.runtimeinstrumentation;

public final class RuntimeTvNativeSurfaceProbe {
    private static void check(
            String label,
            boolean expected,
            RuntimeTvNativeSurface.Candidate[] candidates) {
        int admitted = 0;
        for (RuntimeTvNativeSurface.Candidate candidate : candidates) {
            if (RuntimeTvNativeSurface.admits(candidate)) admitted++;
        }
        boolean actual = admitted == 1;
        if (actual != expected) {
            throw new AssertionError(label + ": admitted=" + admitted + ", expected=" + expected);
        }
    }

    public static void main(String[] arguments) {
${checks}
    }
}
`;
  writeFileSync(surfaceSourcePath, surfaceSource);
  writeFileSync(probeSourcePath, probe);
  const compile = spawnSync(javac, ["-d", directory, surfaceSourcePath, probeSourcePath], {
    encoding: "utf8",
  });
  if (compile.status !== 0) return compile;
  return spawnSync(java, ["-cp", directory,
    "com.yawf.runtimeinstrumentation.RuntimeTvNativeSurfaceProbe"], { encoding: "utf8" });
}

function assertSetupEmulatorPath(source) {
  const start = source.indexOf("      - name: Admit exact official Android TV API 36 image revision");
  const end = source.indexOf("      - name: Run policy tests, generate fixture, and build isolated harness", start);
  assert.ok(start >= 0 && end > start, "SDK admission step must be explicit");
  const setup = source.slice(start, end);
  assert.ok(setup.includes('test -x "$sdk_root/emulator/emulator"'));
  assert.ok(setup.includes('"$sdk_root/emulator/emulator" -version'));
  assert.doesNotMatch(setup, /^\s*emulator -version/m);
}

function assertScopedVolumeCommand(source) {
  assert.ok(source.includes('adb -s "$EMULATOR_SERIAL" shell cmd media_session volume --stream 3 --set 0'));
  assert.doesNotMatch(source, /shell\s+media\s+volume/);
}

function assertHarnessVisibilityPolicy(source) {
  const queries = source.match(/<queries>[\s\S]*?<\/queries>/g) ?? [];
  assert.equal(queries.length, 1, "harness must have one package visibility block");
  assert.match(queries[0], /<package\s+android:name="com\.yawf\.stream\.tv"\s*\/>/);
  assert.equal((queries[0].match(/<package\b/g) ?? []).length, 1);
  assert.doesNotMatch(source, /QUERY_ALL_PACKAGES|<uses-permission\b/);
}

function assertWorkflowPolicy(source) {
  assertScopedVolumeCommand(source);
  assertSetupEmulatorPath(source);
  assert.match(source, /on:\s*\n\s*workflow_dispatch:\s*\n/);
  assert.match(source, /SYSTEM_IMAGE_PACKAGE: system-images;android-36;android-tv;x86_64/);
  assert.match(source, /SYSTEM_IMAGE_REVISION: "4"/);
  assert.match(source, /Reject unresolved signed artifact pins before setup/);
  assert.match(source, /test "\$TV_RELEASE_TAG" = "v2\.3\.28-web"/);
  assert.equal((source.match(/TV_RELEASE_ID: 419588272/g) ?? []).length, 2);
  assert.equal((source.match(/TV_ASSET_ID: 662821004/g) ?? []).length, 2);
  assert.equal((source.match(/TV_SOURCE_REVISION: 2aa6a41664756526123a566c062053e15ab646cb/g) ?? []).length, 2);
  assert.match(source, /TV_SIGNING_RUN_ID: "39607327164"/);
  assert.match(source, /TV_VERSION_NAME: 2\.3\.28/);
  assert.match(source, /TV_VERSION_CODE: "20328"/);
  assert.equal((source.match(/TV_APK_SHA256: f1f6e7f3481a4b461bf2d090a25dc42af9ff1dfb44cdd4760064a12c35d76f4c/g) ?? []).length, 2);
  assert.equal((source.match(/TV_APK_SIZE: "5056795"/g) ?? []).length, 2);
  assert.match(source, /TV_SIGNER_SHA256: 6d8ec5466423e10e5c751132bb0f6a6ddf95a8d9f3378772d7809fce616eec1e/);
  assert.match(source, /name: tv-signed-static-transport/);
  assert.match(source, /--validate-static-transport/);
  assert.match(source, /signed-source\/android-tv\/SIGNING_CERT_SHA256/);
  assert.match(source, /\[\[ "\$TV_APK_SHA256" =~ \^\[0-9a-f\]\{64\}\$ \]\]/);
  assert.match(source, /test -z "\$\(adb devices/);
  assert.match(source, /-port 5556/);
  assert.match(source, /reverse "tcp:\$FIXTURE_PORT" "tcp:\$FIXTURE_PORT"/);
  assert.doesNotMatch(source, /adb\s+kill-server|adb\s+start-server|pm\s+grant|appops|run-as\s+com\.yawf\.stream\.tv/);
  const readOnlyJob = source.slice(source.indexOf("  signed-tv-api36:"));
  const privilegedJob = source.slice(source.indexOf("  transport:"), source.indexOf("  signed-tv-api36:"));
  assert.doesNotMatch(readOnlyJob, /GH_TOKEN|contents:\s*write|gh\s+(api|release)/);
  assert.doesNotMatch(privilegedJob, /actions\/checkout|scripts\/|npm |node |gradle |cargo /);
  assert.match(privilegedJob, /contents: write/);
  assert.match(privilegedJob, /git\/ref\/tags\/\$TV_RELEASE_TAG/);
  assert.match(privilegedJob, /TV_TAG_OBJECT: 3dd4097c4e9c11a2efbf231389b9078a78f635c1/);
  assert.match(privilegedJob, /git\/tags\/\$TV_TAG_OBJECT/);
  assert.ok(privilegedJob.indexOf('# END TV_ANNOTATED_TAG_BINDING') < privilegedJob.indexOf('actions/runs/$TV_SIGNING_RUN_ID'));
  assert.ok(privilegedJob.indexOf('actions/runs/$TV_SIGNING_RUN_ID') < privilegedJob.indexOf("-H 'Accept: application/octet-stream'"));
  assert.match(privilegedJob, /actions\/runs\/\$TV_SIGNING_RUN_ID/);
  assert.match(readOnlyJob, /needs: transport/);
  assert.match(readOnlyJob, /permissions:\s*\n      contents: read\s*\n      actions: read/);
  assert.match(readOnlyJob, /uses: actions\/download-artifact@v4/);
  assert.doesNotMatch(source, /input\s+(tap|swipe|text)/);
  const finish = source.slice(source.indexOf("finish() {"), source.indexOf("trap finish EXIT"));
  assert.ok(finish.indexOf("capture_failure") < finish.indexOf("cleanup"));
  assert.match(source, /captureBeforeCleanup=true/);
  assert.match(source, /assert packages == \["com\.yawf\.stream\.tv"\], packages/);
}

function javaMethod(source, name) {
  const signature = new RegExp(`private\\s+[A-Za-z0-9_.<>]+\\s+${name}\\(`);
  const match = signature.exec(source);
  const start = match?.index ?? -1;
  assert.notEqual(start, -1, name);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unclosed Java method ${name}`);
}

function assertObservationOnly(source) {
  for (const name of ["waitForPositionAtLeast", "readPositionSeconds"]) {
    const body = javaMethod(source, name);
    assert.doesNotMatch(body,
      /press(?:DPad|KeyCode)|sendNativeDpadKey|revealControls|focusAndActivate|focusTarget/);
  }
  assert.match(source, /playPauseSelector\("Pause"\).*semantic Pause state before pausing/s);
  assert.match(source, /playPauseSelector\("Play"\).*semantic Play state before resuming/s);
}

function parseUiHierarchy(xml) {
  const document = { attributes: {}, children: [] };
  const stack = [document];
  const tokens = xml.match(/<node\b[^>]*?\/?\s*>|<\/node>/g) ?? [];
  for (const token of tokens) {
    if (token === "</node>") {
      assert.ok(stack.length > 1, "retained hierarchy has an unmatched node close");
      stack.pop();
      continue;
    }
    const attributes = {};
    for (const match of token.matchAll(/([a-z-]+)="([^"]*)"/g)) {
      attributes[match[1]] = match[2];
    }
    const node = { attributes, children: [] };
    stack.at(-1).children.push(node);
    if (!/\/\s*>$/.test(token)) stack.push(node);
  }
  assert.equal(stack.length, 1, "retained hierarchy has an unclosed node");
  return document;
}

function descendants(node) {
  return node.children.flatMap(child => [child, ...descendants(child)]);
}

function isVisibleNode(node) {
  const bounds = node.attributes.bounds ?? "";
  return node.attributes["visible-to-user"] === "true"
    && bounds !== ""
    && bounds !== "[0,0][0,0]";
}

function replaceUnique(source, search, replacement, label) {
  assert.equal(source.split(search).length, 2, `${label} mutation anchor must be unique`);
  return source.replace(search, replacement);
}

function mutateUniqueNode(xml, marker, mutate) {
  const nodes = [...xml.matchAll(/<node\b[^>]*?\/?\s*>/g)]
    .filter(match => match[0].includes(marker));
  assert.equal(nodes.length, 1, `unique retained XML node: ${marker}`);
  const original = nodes[0][0];
  const replacement = mutate(original);
  assert.notEqual(replacement, original, `retained XML node mutation: ${marker}`);
  return xml.slice(0, nodes[0].index) + replacement
    + xml.slice(nodes[0].index + original.length);
}

function uniqueXmlNode(xml, marker) {
  const nodes = [...xml.matchAll(/<node\b[^>]*?\/?\s*>/g)]
    .filter(match => match[0].includes(marker));
  assert.equal(nodes.length, 1, `unique retained XML node: ${marker}`);
  return nodes[0][0];
}

function parsedNativeSurfaceCandidates(xml, mutant = {}) {
  const hierarchy = parseUiHierarchy(xml);
  const allNodes = descendants(hierarchy);
  const roots = allNodes.filter(node => {
    const attributes = node.attributes;
    return attributes.class === "android.widget.FrameLayout"
      && (attributes["resource-id"] ?? "") === "";
  });
  return roots.map(root => {
    const controllers = descendants(root).filter(node =>
      node.attributes.package === productPackage
        && node.attributes.class === "android.widget.FrameLayout"
        && node.attributes["resource-id"] === `${productPackage}:id/exo_controller`);
    const controller = controllers.length === 1 ? controllers[0] : null;
    const playPauseScope = mutant.globalPlayPause ? allNodes : descendants(controller ?? { children: [] });
    const playPause = playPauseScope.filter(node =>
      node.attributes.package === productPackage
        && node.attributes.class === "android.widget.ImageButton"
        && node.attributes["resource-id"] === `${productPackage}:id/exo_play_pause`
        && /^(?:Play|Pause)$/.test(node.attributes["content-desc"] ?? ""));
    const contentFrames = descendants(root).filter(node =>
      node.attributes.package === productPackage
        && node.attributes.class === "android.widget.FrameLayout"
        && node.attributes["resource-id"] === `${productPackage}:id/exo_content_frame`);
    const contentFrame = contentFrames.length === 1 ? contentFrames[0] : null;
    const videoScope = mutant.globalVideoSurface
      ? allNodes
      : descendants(contentFrame ?? { children: [] });
    const videoSurfaces = videoScope.filter(node =>
      node.attributes.package === productPackage
        && node.attributes.class === "android.view.SurfaceView");
    const state = playPause.length === 1 ? playPause[0] : null;
    return {
      rootPackage: root.attributes.package ?? null,
      rootClass: root.attributes.class ?? null,
      description: Object.hasOwn(root.attributes, "content-desc")
        ? root.attributes["content-desc"]
        : null,
      rootClickable: root.attributes.clickable === "true",
      rootEnabled: root.attributes.enabled === "true",
      rootFocusable: root.attributes.focusable === "true",
      rootVisible: isVisibleNode(root),
      controllerCount: controllers.length,
      controllerVisible: controller !== null && isVisibleNode(controller),
      playPauseCount: playPause.length,
      playPauseClickable: state !== null && state.attributes.clickable === "true",
      playPauseEnabled: state !== null && state.attributes.enabled === "true",
      playPauseFocusable: state !== null && state.attributes.focusable === "true",
      playPauseVisible: state !== null && isVisibleNode(state),
      contentFrameCount: contentFrames.length,
      contentFrameVisible: contentFrame !== null && isVisibleNode(contentFrame),
      videoSurfaceCount: videoSurfaces.length,
      videoSurfaceVisible: videoSurfaces.length === 1 && isVisibleNode(videoSurfaces[0]),
    };
  });
}

function modeledNativeSurfaceAdmission(candidate, mutant = {}) {
  const exactRoot = (mutant.ignoreRootPackage || candidate.rootPackage === productPackage)
    && candidate.rootClass === "android.widget.FrameLayout"
    && candidate.rootClickable
    && candidate.rootEnabled
    && candidate.rootFocusable
    && candidate.rootVisible;
  const describedControls = mutant.admitAnyDescription
    ? candidate.description !== null && candidate.description !== ""
    : /^(?:Show|Hide) player controls$/.test(candidate.description ?? "");
  const emptyDescription = candidate.description === null || candidate.description === "";
  const visibleControllerState = (mutant.allowDuplicateController
    ? candidate.controllerCount >= 1 : candidate.controllerCount === 1)
    && candidate.controllerVisible
    && (mutant.allowDuplicatePlayPause
      ? candidate.playPauseCount >= 1 : candidate.playPauseCount === 1)
    && candidate.playPauseClickable
    && candidate.playPauseEnabled
    && candidate.playPauseFocusable
    && candidate.playPauseVisible;
  const exactVideoContent = (mutant.ignoreVideoContent || (
    candidate.contentFrameCount === 1
      && candidate.contentFrameVisible
      && candidate.videoSurfaceCount === 1
      && candidate.videoSurfaceVisible
  ));
  return exactRoot
    && (describedControls || (emptyDescription && visibleControllerState))
    && exactVideoContent;
}

function retainedXmlAdmitsNativeSurface(xml, mutant = {}) {
  const admitted = parsedNativeSurfaceCandidates(xml, mutant)
    .filter(candidate => modeledNativeSurfaceAdmission(candidate, mutant));
  return mutant.allowDuplicateRoots ? admitted.length >= 1 : admitted.length === 1;
}

function retainedXmlVisibleTimeBars(xml) {
  return descendants(parseUiHierarchy(xml)).filter(node =>
    node.attributes.package === productPackage
      && node.attributes["resource-id"] === `${productPackage}:id/exo_progress`
      && node.attributes.class === "android.widget.SeekBar"
      && node.attributes.enabled === "true"
      && isVisibleNode(node));
}

function assertNativeSurfacePolicy(source, surfaceSource = read(nativeSurfaceJavaPath)) {
  assert.match(surfaceSource,
    /Pattern\.compile\("\^\(\?:Show\|Hide\) player controls\$"\);/);
  assert.match(surfaceSource,
    /describedControls \|\| \(emptyDescription && visibleControllerState\)/);
  assert.match(surfaceSource,
    /candidate\.controllerCount == 1[\s\S]*candidate\.playPauseCount == 1/);
  assert.match(surfaceSource,
    /candidate\.playPauseClickable[\s\S]*candidate\.playPauseEnabled[\s\S]*candidate\.playPauseFocusable[\s\S]*candidate\.playPauseVisible/);
  assert.match(surfaceSource,
    /candidate\.contentFrameCount == 1[\s\S]*candidate\.contentFrameVisible[\s\S]*candidate\.videoSurfaceCount == 1[\s\S]*candidate\.videoSurfaceVisible/);

  const rootSelector = javaMethod(source, "nativePlayerSurfaceRootSelector");
  assert.match(rootSelector,
    /By\.clazz\("android\.widget\.FrameLayout"\)\s*\.pkg\(PRODUCT_PACKAGE\)\s*\.clickable\(true\)\s*\.enabled\(true\)\s*\.focusable\(true\)/s);
  assert.doesNotMatch(rootSelector, /\.desc\(/);
  const controllerSelector = javaMethod(source, "nativePlayerControllerSelector");
  assert.match(controllerSelector,
    /By\.res\(PRODUCT_PACKAGE, "exo_controller"\)\s*\.pkg\(PRODUCT_PACKAGE\)\s*\.clazz\("android\.widget\.FrameLayout"\)/s);
  const stateSelector = javaMethod(source, "nativePlayerStateSelector");
  assert.match(stateSelector,
    /By\.res\(PRODUCT_PACKAGE, "exo_play_pause"\)\s*\.pkg\(PRODUCT_PACKAGE\)\s*\.clazz\("android\.widget\.ImageButton"\)\s*\.desc\(Pattern\.compile\("\^\(\?:Play\|Pause\)\$"\)\)/s);
  const contentSelector = javaMethod(source, "nativeContentFrameSelector");
  assert.match(contentSelector,
    /By\.res\(PRODUCT_PACKAGE, "exo_content_frame"\)\s*\.pkg\(PRODUCT_PACKAGE\)\s*\.clazz\("android\.widget\.FrameLayout"\)/s);
  const videoSelector = javaMethod(source, "nativeVideoSurfaceSelector");
  assert.match(videoSelector,
    /By\.clazz\("android\.view\.SurfaceView"\)\.pkg\(PRODUCT_PACKAGE\)/);

  const waiter = javaMethod(source, "waitForNativePlayerSurface");
  assert.match(waiter, /long deadline = SystemClock\.uptimeMillis\(\) \+ MEDIA_WAIT;/);
  assert.match(waiter,
    /observeFreshNative\(\s*\(\) -> readNativePlayerSurfaceSnapshot\(label\)\)/s);
  const reader = javaMethod(source, "readNativePlayerSurfaceSnapshot");
  assert.match(reader,
    /List<UiObject2> roots = device\.findObjects\(nativePlayerSurfaceRootSelector\(\)\);/);
  assert.match(reader,
    /RuntimeTvNativeSurface\.Candidate candidate = readNativePlayerSurfaceCandidate\(root\);/);
  assert.match(reader, /if \(RuntimeTvNativeSurface\.admits\(candidate\)\) \{\s*admitted\+\+;/s);
  assert.match(reader, /if \(admitted > 1\)/);
  assert.match(reader,
    /if \(admitted == 1\) return NativeSurfaceSnapshot\.complete\(admittedFocus\);/);
  assert.match(reader, /readCurrentNativeFocus\(root, 1\)/);
  assert.match(reader, /BoundsSnapshot\.from\(currentFocus\.bounds\)/);
  assert.doesNotMatch(reader, /device\.findObjects?\(By\.focused\(true\)\)/);
  const focusReader = javaMethod(source, "readCurrentNativeFocus");
  assert.match(focusReader, /playerRoot\.findObjects\(By\.focused\(true\)\)/);
  assert.match(reader, /root\.isFocused\(\)/);
  assert.match(reader, /BoundsSnapshot\.from\(root\.getVisibleBounds\(\)\)/);

  const candidateReader = javaMethod(source, "readNativePlayerSurfaceCandidate");
  assert.match(candidateReader,
    /List<UiObject2> controllers = root\.findObjects\(nativePlayerControllerSelector\(\)\);/);
  assert.match(candidateReader,
    /List<UiObject2> playPause = controller\.findObjects\(nativePlayerStateSelector\(\)\);/);
  assert.match(candidateReader,
    /List<UiObject2> contentFrames = root\.findObjects\(nativeContentFrameSelector\(\)\);/);
  assert.match(candidateReader,
    /List<UiObject2> videoSurfaces = contentFrame\.findObjects\(\s*nativeVideoSurfaceSelector\(\)\);/s);
  for (const getter of [
    "root.getApplicationPackage()",
    "root.getClassName()",
    "root.getContentDescription()",
    "root.isClickable()",
    "root.isEnabled()",
    "root.isFocusable()",
    "root.getVisibleBounds()",
    "controller.getVisibleBounds()",
    "state.isClickable()",
    "state.isEnabled()",
    "state.isFocusable()",
    "state.getVisibleBounds()",
    "contentFrame.getVisibleBounds()",
    "videoSurfaces.get(0).getVisibleBounds()",
  ]) assert.ok(candidateReader.includes(getter), `missing native surface snapshot getter: ${getter}`);
  assert.doesNotMatch(candidateReader, /return\s+(?:root|controller|state|contentFrame|videoSurfaces)/);

  const reveal = javaMethod(source, "revealControls");
  assert.match(reveal,
    /observeFreshNative\(\s*\(\) -> readNativePlayerSurfaceSnapshot\("native PlayerView before control reveal"\)\)/s);
  assert.ok(reveal.indexOf("surface.complete")
    < reveal.indexOf("sendNativeDpadKey(KeyEvent.KEYCODE_DPAD_DOWN)"));
  assert.match(reveal, /assertNotNull\([\s\S]*surface\.focus\);/);
  assert.equal((reveal.match(/sendNativeDpadKey\(KeyEvent\.KEYCODE_DPAD_DOWN\)/g) ?? []).length, 1);
  assert.match(reveal, /waitForNativePresence\(playPauseSelector\(\), 5_000\)/);

  const flow = javaMethod(source, "runFlow");
  assert.equal((flow.match(/waitForNativePlayerSurface\(/g) ?? []).length, 3);
  assert.doesNotMatch(flow, /By\.desc\("YAWF Android TV 4:3 runtime fixture"\)/);
  for (const [surface, clock] of [
    ['waitForNativePlayerSurface("native PlayerView");', "long first = waitForPositionAtLeast(2, MEDIA_WAIT);"],
    ['waitForNativePlayerSurface("reentered native PlayerView");', "waitForPositionAtLeast(2, MEDIA_WAIT);"],
    ['waitForNativePlayerSurface("recovery PlayerView");', "waitForPositionAtLeast(2, MEDIA_WAIT);"],
  ]) {
    const surfaceIndex = flow.indexOf(surface);
    const revealIndex = flow.indexOf("revealControls();", surfaceIndex);
    const clockIndex = flow.indexOf(clock, surfaceIndex);
    assert.ok(surfaceIndex >= 0 && surfaceIndex < revealIndex && revealIndex < clockIndex,
      `${surface} must precede ordinary D-pad reveal and hidden clock observation`);
  }
}

function assertClockDriverPolicy(source) {
  const selector = javaMethod(source, "positionTimeBarSelector");
  assert.match(selector,
    /By\.res\(PRODUCT_PACKAGE, "exo_progress"\)\s*\.pkg\(PRODUCT_PACKAGE\)\s*\.clazz\("android\.widget\.SeekBar"\)\s*\.enabled\(true\)/s);

  const reader = javaMethod(source, "readPositionSeconds");
  assert.match(reader, /return observeFreshNative\(this::readPositionSecondsSnapshot\);/);
  const snapshotReader = javaMethod(source, "readPositionSecondsSnapshot");
  assert.match(snapshotReader,
    /List<UiObject2> timeBars = device\.findObjects\(positionTimeBarSelector\(\)\);/);
  assert.match(snapshotReader, /return RuntimeTvClock\.readUniqueVisibleTimeBar\(/);
  assert.match(snapshotReader, /timeBar -> !timeBar\.getVisibleBounds\(\)\.isEmpty\(\)/);
  assert.match(snapshotReader, /UiObject2::getContentDescription/);
  assert.doesNotMatch(snapshotReader,
    /getText|exo_position|By\.text|fixture|status|press(?:DPad|KeyCode)|revealControls|focusAndActivate|focusTarget/);

  const observer = javaMethod(source, "waitForPositionAtLeast");
  assert.match(observer, /long value = readPositionSeconds\(\);/);
  assert.doesNotMatch(observer,
    /getText|getContentDescription|press(?:DPad|KeyCode)|revealControls|focusAndActivate|focusTarget/);
}

function assertImeDismissalPolicy(source) {
  assert.match(source,
    /private static final String PINNED_TV_IME = "com\.google\.android\.inputmethod\.latin";/);
  const flow = javaMethod(source, "runFlow");
  const addressVerified = flow.indexOf(
    'assertEquals("Server address was not entered through the visible UI", FIXTURE_URL, address.getText());',
  );
  const dismissal = flow.indexOf("dismissVisiblePinnedTvIme();");
  const connect = flow.indexOf("focusConnectWithFirstDpadDownAndActivate();");
  assert.ok(addressVerified >= 0 && addressVerified < dismissal && dismissal < connect,
    "the exact entered address must be verified before IME dismissal and Connect activation");

  const body = javaMethod(source, "dismissVisiblePinnedTvIme");
  assert.match(body, /BySelector imeSelector = By\.pkg\(PINNED_TV_IME\);/);
  assert.match(body,
    /UiObject2 ime = waitFor\(imeSelector, UI_WAIT, "visible pinned TV input method"\);/);
  assert.match(body, /!ime\.getVisibleBounds\(\)\.isEmpty\(\)/);
  assert.equal((body.match(/device\.pressBack\(\)/g) ?? []).length, 1,
    "IME dismissal must send exactly one remote Back");
  assert.match(body, /device\.wait\(Until\.gone\(imeSelector\), UI_WAIT\)/);
  assert.doesNotMatch(body,
    /executeShellCommand|input\s+keyevent|pressDPad|pressKeyCode|\.click\s*\(|\bfor\s*\(|\bwhile\s*\(/);
}

function assertSetupFocusRoutingPolicy(source) {
  const setup = javaMethod(source, "showServerSetup");
  const start = setup.indexOf("address.setOnKeyListener((view, keyCode, event) -> {");
  const end = setup.indexOf("        });", start);
  assert.ok(start >= 0 && end > start, "server address must define bounded key routing");
  const listener = setup.slice(start, end);
  assert.match(listener, /keyCode == KeyEvent\.KEYCODE_DPAD_DOWN/);
  assert.match(listener, /event\.getAction\(\) == KeyEvent\.ACTION_DOWN/);
  assert.match(listener, /connect\.requestFocus\(\);\s*return true;/s);
  assert.match(listener, /}\s*return false;\s*$/s);
  assert.equal((listener.match(/connect\.requestFocus\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(listener,
    /performClick|callOnClick|setText|dispatchKeyEvent|executeShellCommand|KEYCODE_DPAD_(?:UP|LEFT|RIGHT)/);
}

function assertFirstDpadConnectPolicy(source) {
  const flow = javaMethod(source, "runFlow");
  const imeGone = flow.indexOf("dismissVisiblePinnedTvIme();");
  const connect = flow.indexOf("focusConnectWithFirstDpadDownAndActivate();");
  assert.ok(imeGone >= 0 && imeGone < connect,
    "first Connect navigation must begin only after exact IME dismissal");

  const body = javaMethod(source, "focusConnectWithFirstDpadDownAndActivate");
  const addressFocused = body.indexOf('By.clazz("android.widget.EditText").focused(true)');
  const down = body.indexOf("device.pressDPadDown();");
  const connectFocused = body.indexOf('waitFor(focusedConnect, UI_WAIT, "Connect focused by first D-pad Down");');
  const center = body.indexOf("device.pressDPadCenter();");
  assert.ok(addressFocused >= 0 && addressFocused < down && down < connectFocused && connectFocused < center,
    "focused address, first D-pad Down, exact Connect focus, and center activation must stay ordered");
  assert.match(body,
    /BySelector focusedConnect = By\.clazz\("android\.widget\.Button"\)\s*\.text\("Connect"\)\s*\.focused\(true\);/s);
  assert.equal((body.match(/device\.pressDPadDown\(\)/g) ?? []).length, 1);
  assert.equal((body.match(/device\.pressDPadCenter\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(body,
    /pressBack|pressKeyCode|focusTarget|focusAndActivate|executeShellCommand|\.click\s*\(|\bfor\s*\(|\bwhile\s*\(/);
}

function assertJavaSemanticPolicy(source) {
  for (const marker of [
    'assertTrue("Playback position did not advance"',
    'assertTrue("Decoded upper-video ROI did not change while playback advanced"',
    'assertTrue("Position advanced materially while paused"',
    'assertTrue("D-pad seek did not move by a meaningful delta"',
    'assertTrue("Back did not restore focus to the WebView or one of its descendants"',
    'checks.put("decodedFrameChanged", true)',
    'checks.put("playbackRecoveredAfterError", true)',
    'checks.put("fitGeometryVerified", false)',
  ]) assert.ok(source.includes(marker), marker);
  assert.doesNotMatch(source, /\.click\s*\(/);
  assert.doesNotMatch(source, /input\s+(tap|swipe)|executeShellCommand|SharedPreferences/);
}

test("host admission and semantic receipt policy self-tests execute", () => {
  const result = spawnSync(python, [hostPath, "--self-test"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 9 tests/);
  assert.match(result.stderr, /test_pause_sample_evidence_names_are_exact_and_bounded.*ok/);
});

test("fixture path and native bridge contract self-tests execute", () => {
  const result = runPythonSelfTest(fixturePath);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 2 tests/);
});

test("host tests kill removal of decoded-frame semantic admission", () => {
  killedPythonMutant(hostPath, '"playingPositionAdvanced", "decodedFrameChanged", "pauseStable",',
    '"playingPositionAdvanced", "pauseStable",');
});

test("host tests kill replacement-install admission regression", () => {
  killedPythonMutant(hostPath,
    'if list(command)[-3:] != ["install", "--no-streaming", str(product_apk)]:',
    'if list(command)[-2:] != ["-r", str(product_apk)]:');
});

test("host tests kill removal of diagnostic URL redaction", () => {
  killedPythonMutant(hostPath,
    'value = URL.sub("<redacted-url>", value)',
    'value = value');
});

test("fixture tests kill traversal and bridge payload regressions independently", () => {
  killedPythonMutant(fixturePath,
    'if not url_path.startswith("/media/") or ".." in decoded.parts:',
    'if not url_path.startswith("/media/"):');
  killedPythonMutant(fixturePath,
    "title:'YAWF Android TV 4:3 runtime fixture',sourceFileName:'fixture-master.m3u8',",
    "title:'YAWF Android TV 4:3 runtime fixture',sourceFileName:'fixture-master.mp4',");
});

test("workflow is manual, fail-closed, revision-4 TV-only, and device scoped", () => {
  const source = read(workflowPath);
  assertWorkflowPolicy(source);
  for (const [before, after] of [
    ["TV_RELEASE_ID: 419588272", "TV_RELEASE_ID: 1"],
    ["TV_ASSET_ID: 662821004", "TV_ASSET_ID: 1"],
    ["TV_SOURCE_REVISION: 2aa6a41664756526123a566c062053e15ab646cb", "TV_SOURCE_REVISION: " + "0".repeat(40)],
    ['TV_SIGNING_RUN_ID: "39607327164"', 'TV_SIGNING_RUN_ID: "1"'],
    ['TV_VERSION_NAME: 2.3.28', 'TV_VERSION_NAME: 2.3.25'],
    ['TV_VERSION_CODE: "20328"', 'TV_VERSION_CODE: "20325"'],
    ["TV_APK_SHA256: f1f6e7f3481a4b461bf2d090a25dc42af9ff1dfb44cdd4760064a12c35d76f4c", "TV_APK_SHA256: " + "0".repeat(64)],
    ['TV_APK_SIZE: "5056795"', 'TV_APK_SIZE: "0"'],
    ["TV_SIGNER_SHA256: 6d8ec5466423e10e5c751132bb0f6a6ddf95a8d9f3378772d7809fce616eec1e", "TV_SIGNER_SHA256: " + "0".repeat(64)],
  ]) {
    assert.ok(source.includes(before));
    assert.throws(() => assertWorkflowPolicy(source.replace(before, after)));
  }
  assert.throws(() => assertWorkflowPolicy(source.replace(
    'SYSTEM_IMAGE_REVISION: "4"', 'SYSTEM_IMAGE_REVISION: "3"')));
  assert.throws(() => assertWorkflowPolicy(source.replace(
    'if [ "$result" -ne 0 ]; then capture_failure; fi\n            cleanup',
    'cleanup\n            if [ "$result" -ne 0 ]; then capture_failure; fi')));
  assert.throws(() => assertWorkflowPolicy(source.replace(
    "name: Retrieve only fixed asset metadata and bytes without repository checkout",
    "uses: actions/checkout@v4")));
  assert.throws(() => assertWorkflowPolicy(source.replace(
    "name: Download the isolated static transport artifact",
    "name: Download the isolated static transport artifact\n        env:\n          GH_TOKEN: forbidden")));
});

test("SDK admission invokes the newly installed emulator before PATH becomes available", () => {
  const source = read(workflowPath);
  assertSetupEmulatorPath(source);
  const mutant = source.replace('"$sdk_root/emulator/emulator" -version', 'emulator -version');
  assert.notEqual(mutant, source);
  assert.throws(() => assertSetupEmulatorPath(mutant));
});

test("TV muting uses the media_session service rather than the absent legacy shell binary", () => {
  const source = read(workflowPath);
  assertScopedVolumeCommand(source);
  const mutant = source.replace('shell cmd media_session volume', 'shell media volume');
  assert.notEqual(mutant, source);
  assert.throws(() => assertScopedVolumeCommand(mutant));
});

test("TV harness can discover only the exact signed product package", () => {
  const source = read(manifestPath);
  assertHarnessVisibilityPolicy(source);
  const missing = source.replace(/\s*<queries>[\s\S]*?<\/queries>\s*/, "\n");
  assert.notEqual(missing, source);
  assert.throws(() => assertHarnessVisibilityPolicy(missing));
  const wrongPackage = source.replace("com.yawf.stream.tv", "com.yawf.stream.wrong");
  assert.notEqual(wrongPackage, source);
  assert.throws(() => assertHarnessVisibilityPolicy(wrongPackage));
});

test("TV setup dismisses the exact visible pinned IME once before focusing Connect", () => {
  const source = read(javaPath);
  assertImeDismissalPolicy(source);
  const mutants = [
    source.replace(
      '        device.pressBack();\n        assertTrue("Pinned TV input method did not dismiss after one remote Back",',
      '        assertTrue("Pinned TV input method did not dismiss after one remote Back",',
    ),
    source.replace("Until.gone(imeSelector)", "Until.hasObject(imeSelector)"),
    source.replace("com.google.android.inputmethod.latin", "com.google.android.inputmethod.wrong"),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, source);
    assert.throws(() => assertImeDismissalPolicy(mutant));
  }
});

test("TV setup routes only first D-pad Down from the address to Connect", () => {
  const product = read(mainActivityPath);
  const harness = read(javaPath);
  assertSetupFocusRoutingPolicy(product);
  assertFirstDpadConnectPolicy(harness);
  for (const mutant of [
    product.replace("KeyEvent.KEYCODE_DPAD_DOWN", "KeyEvent.KEYCODE_DPAD_UP"),
    product.replace("KeyEvent.ACTION_DOWN", "KeyEvent.ACTION_UP"),
    product.replace("connect.requestFocus();", "connect.performClick();"),
  ]) {
    assert.notEqual(mutant, product);
    assert.throws(() => assertSetupFocusRoutingPolicy(mutant));
  }
  for (const mutant of [
    harness.replace("        device.pressDPadDown();\n", ""),
    harness.replace(".focused(true);", ".enabled(true);"),
    harness.replace("        device.pressDPadCenter();\n", ""),
  ]) {
    assert.notEqual(mutant, harness);
    assert.throws(() => assertFirstDpadConnectPolicy(mutant));
  }
});

test("position observers cannot toggle or repair playback", () => {
  const source = read(javaPath);
  assertObservationOnly(source);
  const observer = javaMethod(source, "waitForPositionAtLeast");
  const mutant = source.replace(observer, observer.replace(
    "while (SystemClock.uptimeMillis() < deadline) {",
    "while (SystemClock.uptimeMillis() < deadline) { device.pressDPadCenter();",
  ));
  assert.throws(() => assertObservationOnly(mutant));
});

test("actual Java clock reader accepts exact clocks and rejects malformed or ambiguous inputs", () => {
  const result = runJavaClockProbe();
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("actual Java clock tests kill prefix acceptance", () => {
  killedJavaClockMutant("if (!matcher.matches()) {", "if (!matcher.find()) {");
});

test("actual Java clock tests kill out-of-range field acceptance", () => {
  killedJavaClockMutant(
    "if (minutes > 59 || seconds > 59) {",
    "if (minutes > 60 || seconds > 60) {",
  );
});

test("actual Java clock tests kill duplicate visible time-bar acceptance", () => {
  killedJavaClockMutant(
    "if (visibleCandidates.size() != 1) {",
    "if (visibleCandidates.isEmpty()) {",
  );
});

test("actual Java clock tests kill visible filtering bypass", () => {
  killedJavaClockMutant(
    "if (visible.test(candidate)) visibleCandidates.add(candidate);",
    "visibleCandidates.add(candidate);",
  );
});

test("actual Java clock tests kill content-description accessor bypass", () => {
  killedJavaClockMutant(
    "return parsePositionClock(contentDescription.apply(visibleCandidates.get(0)));",
    "return parsePositionClock(\"00:02\");",
  );
});

test("retained Media3 XML has one exact visible product time bar", () => {
  const retained = read(retainedTimeBarXmlPath);
  assert.equal(
    createHash("sha256").update(retained).digest("hex"),
    "1859fa733ffc9c6f9bc3167e762c32c7590077725c3a777b03783b1f932fbf6a",
    "the positive fixture must remain the LF-normalized retained run-39852077335 XML",
  );
  const admitted = retainedXmlVisibleTimeBars(retained);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].attributes["content-desc"], "00:06");

  const timeBarPackage = 'resource-id="com.yawf.stream.tv:id/exo_progress" class="android.widget.SeekBar" package="com.yawf.stream.tv"';
  assert.equal(retained.split(timeBarPackage).length, 2, "retained time-bar package anchor");
  const wrongPackage = retained.replace(
    timeBarPackage,
    'resource-id="com.yawf.stream.tv:id/exo_progress" class="android.widget.SeekBar" package="com.example.lookalike"',
  );
  assert.equal(retainedXmlVisibleTimeBars(wrongPackage).length, 0);

  const timeBarNode = /\s*<node\b[^>]*resource-id="com\.yawf\.stream\.tv:id\/exo_progress"[^>]*\/>/;
  assert.match(retained, timeBarNode);
  assert.equal(retainedXmlVisibleTimeBars(retained.replace(timeBarNode, "")).length, 0);

  const duplicate = retained.replace("</hierarchy>", [
    '  <node text="" resource-id="com.yawf.stream.tv:id/exo_progress"',
    ' class="android.widget.SeekBar" package="com.yawf.stream.tv" content-desc="00:07"',
    ' clickable="false" enabled="true" focusable="true"',
    ' visible-to-user="true" bounds="[0,996][1920,1080]" />',
    "</hierarchy>",
  ].join(""));
  assert.equal(retainedXmlVisibleTimeBars(duplicate).length, 2);
});

test("TV clock driver uses the exact product time bar and content description", () => {
  assertClockDriverPolicy(read(javaPath));
});

test("TV clock driver tests kill getText accessor substitution", () => {
  const source = read(javaPath);
  const mutant = source.replace("UiObject2::getContentDescription", "UiObject2::getText");
  assert.notEqual(mutant, source);
  assert.throws(() => assertClockDriverPolicy(mutant));
});

test("TV clock driver tests kill product-scope omission", () => {
  const source = read(javaPath);
  const selector = javaMethod(source, "positionTimeBarSelector");
  const mutant = source.replace(selector, selector.replace("                .pkg(PRODUCT_PACKAGE)\n", ""));
  assert.notEqual(mutant, source);
  assert.throws(() => assertClockDriverPolicy(mutant));
});

test("TV clock driver tests kill SeekBar-class omission", () => {
  const source = read(javaPath);
  const selector = javaMethod(source, "positionTimeBarSelector");
  const mutant = source.replace(selector, selector.replace('                .clazz("android.widget.SeekBar")\n', ""));
  assert.notEqual(mutant, source);
  assert.throws(() => assertClockDriverPolicy(mutant));
});

test("TV clock driver tests kill enabled-state omission", () => {
  const source = read(javaPath);
  const selector = javaMethod(source, "positionTimeBarSelector");
  const mutant = source.replace(selector, selector.replace("                .enabled(true);", ";"));
  assert.notEqual(mutant, source);
  assert.throws(() => assertClockDriverPolicy(mutant));
});

test("TV clock driver tests kill exo_progress resource omission", () => {
  const source = read(javaPath);
  const selector = javaMethod(source, "positionTimeBarSelector");
  const mutantSelector = selector.replace(
    'return By.res(PRODUCT_PACKAGE, "exo_progress")\n                .pkg(PRODUCT_PACKAGE)',
    "return By.pkg(PRODUCT_PACKAGE)",
  );
  const mutant = source.replace(selector, mutantSelector);
  assert.notEqual(mutant, source);
  assert.throws(() => assertClockDriverPolicy(mutant));
});

test("actual native surface predicate admits retained hidden and current visible Media3 states only", () => {
  const retained = read(retainedPlayerXmlPath);
  const visible = read(retainedVisibleControllerXmlPath);
  assert.equal(
    createHash("sha256").update(retained).digest("hex"),
    "8c73f6a050335672b50f042a744cc789d98cefd98888bf6d9e789788aa301aae",
    "the executable positive fixture must remain the LF-normalized retained run-39845934272 XML",
  );
  assert.equal(
    createHash("sha256").update(visible).digest("hex"),
    "2bc4590aec57414776b3735edf2fe2d9ac5440f7b77dfd585a417c9201dfc9d5",
    "the executable visible fixture must remain the LF-normalized retained run-39859606150 XML",
  );
  assert.equal(retainedXmlAdmitsNativeSurface(retained), true);
  assert.equal(retainedXmlAdmitsNativeSurface(visible), true,
    "the real visible Media3 controller with an empty root description must be admitted");

  const hiddenRootMarker = 'resource-id="" class="android.widget.FrameLayout" package="com.yawf.stream.tv" content-desc="Show player controls"';
  const visibleRootMarker = 'resource-id="" class="android.widget.FrameLayout" package="com.yawf.stream.tv" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true"';
  const controllerMarker = `resource-id="${productPackage}:id/exo_controller"`;
  const playPauseMarker = `resource-id="${productPackage}:id/exo_play_pause"`;
  const contentMarker = `resource-id="${productPackage}:id/exo_content_frame"`;
  const surfaceMarker = 'class="android.view.SurfaceView" package="com.yawf.stream.tv"';
  const hiddenHide = mutateUniqueNode(retained, hiddenRootMarker,
    node => node.replace('content-desc="Show player controls"', 'content-desc="Hide player controls"'));
  const nullDescription = mutateUniqueNode(visible, visibleRootMarker,
    node => node.replace(' content-desc=""', ""));
  const unrelatedDescription = mutateUniqueNode(visible, visibleRootMarker,
    node => node.replace('content-desc=""', 'content-desc="unrelated player frame"'));
  const wrongRootPackage = mutateUniqueNode(visible, visibleRootMarker,
    node => node.replace('package="com.yawf.stream.tv"', 'package="com.example.lookalike"'));
  const wrongControllerPackage = mutateUniqueNode(visible, controllerMarker,
    node => node.replace('package="com.yawf.stream.tv"', 'package="com.example.lookalike"'));
  const wrongPlayPausePackage = mutateUniqueNode(visible, playPauseMarker,
    node => node.replace('package="com.yawf.stream.tv"', 'package="com.example.lookalike"'));
  const wrongContentPackage = mutateUniqueNode(visible, contentMarker,
    node => node.replace('package="com.yawf.stream.tv"', 'package="com.example.lookalike"'));
  const wrongSurfacePackage = mutateUniqueNode(visible, surfaceMarker,
    node => node.replace('package="com.yawf.stream.tv"', 'package="com.example.lookalike"'));
  const missingController = mutateUniqueNode(visible, controllerMarker,
    node => node.replace(`${productPackage}:id/exo_controller`, `${productPackage}:id/missing_controller`));
  const missingPlayPause = mutateUniqueNode(visible, playPauseMarker,
    node => node.replace(`${productPackage}:id/exo_play_pause`, `${productPackage}:id/missing_play_pause`));
  const missingContent = mutateUniqueNode(visible, contentMarker,
    node => node.replace(`${productPackage}:id/exo_content_frame`, `${productPackage}:id/missing_content`));
  const missingSurface = mutateUniqueNode(visible, surfaceMarker,
    node => node.replace("android.view.SurfaceView", "android.view.TextureView"));
  const disabledPlayPause = mutateUniqueNode(visible, playPauseMarker,
    node => node.replace('enabled="true"', 'enabled="false"'));

  const emptyBounds = new Map([
    ["root", [visibleRootMarker, visible]],
    ["controller", [controllerMarker, visible]],
    ["play/pause", [playPauseMarker, visible]],
    ["content", [contentMarker, visible]],
    ["surface", [surfaceMarker, visible]],
  ]);
  const emptyBoundCases = [...emptyBounds].map(([label, [marker, xml]]) => ({
    label: `empty ${label} bounds`,
    candidates: parsedNativeSurfaceCandidates(mutateUniqueNode(xml, marker,
      node => node.replace(/bounds="[^"]+"/, 'bounds="[0,0][0,0]"'))),
    expected: false,
  }));

  const playPauseNode = uniqueXmlNode(visible, playPauseMarker);
  const playPauseOutsideController = replaceUnique(visible, playPauseNode, "",
    "play/pause ownership").replace("</hierarchy>", `${playPauseNode}</hierarchy>`);
  assert.equal(retainedXmlAdmitsNativeSurface(playPauseOutsideController), false);
  assert.equal(retainedXmlAdmitsNativeSurface(
    playPauseOutsideController, { globalPlayPause: true }), true,
  "a global play/pause query mutant must ignore controller ownership");
  const surfaceNode = uniqueXmlNode(visible, surfaceMarker);
  const surfaceOutsideContent = replaceUnique(visible, surfaceNode, "",
    "SurfaceView ownership").replace("</hierarchy>", `${surfaceNode}</hierarchy>`);
  assert.equal(retainedXmlAdmitsNativeSurface(surfaceOutsideContent), false);
  assert.equal(retainedXmlAdmitsNativeSurface(
    surfaceOutsideContent, { globalVideoSurface: true }), true,
  "a global SurfaceView query mutant must ignore content-frame ownership");

  const visibleCandidates = parsedNativeSurfaceCandidates(visible);
  const visibleCandidate = visibleCandidates.find(candidate => modeledNativeSurfaceAdmission(candidate));
  assert.ok(visibleCandidate, "current retained XML must yield one admitted candidate snapshot");
  const cases = [
    { label: "old hidden Show description", candidates: parsedNativeSurfaceCandidates(retained), expected: true },
    { label: "old hidden Hide description", candidates: parsedNativeSurfaceCandidates(hiddenHide), expected: true },
    { label: "current visible empty description", candidates: visibleCandidates, expected: true },
    { label: "current visible null description", candidates: parsedNativeSurfaceCandidates(nullDescription), expected: true },
    { label: "unrelated nonempty description", candidates: parsedNativeSurfaceCandidates(unrelatedDescription), expected: false },
    { label: "wrong root package", candidates: parsedNativeSurfaceCandidates(wrongRootPackage), expected: false },
    { label: "wrong controller package", candidates: parsedNativeSurfaceCandidates(wrongControllerPackage), expected: false },
    { label: "wrong play pause package", candidates: parsedNativeSurfaceCandidates(wrongPlayPausePackage), expected: false },
    { label: "wrong content package", candidates: parsedNativeSurfaceCandidates(wrongContentPackage), expected: false },
    { label: "wrong surface package", candidates: parsedNativeSurfaceCandidates(wrongSurfacePackage), expected: false },
    { label: "missing controller", candidates: parsedNativeSurfaceCandidates(missingController), expected: false },
    { label: "missing play pause", candidates: parsedNativeSurfaceCandidates(missingPlayPause), expected: false },
    { label: "missing content", candidates: parsedNativeSurfaceCandidates(missingContent), expected: false },
    { label: "missing surface", candidates: parsedNativeSurfaceCandidates(missingSurface), expected: false },
    { label: "disabled play pause", candidates: parsedNativeSurfaceCandidates(disabledPlayPause), expected: false },
    { label: "play pause outside controller", candidates: parsedNativeSurfaceCandidates(playPauseOutsideController), expected: false },
    { label: "surface outside content", candidates: parsedNativeSurfaceCandidates(surfaceOutsideContent), expected: false },
    { label: "duplicate admitted root", candidates: [...visibleCandidates, { ...visibleCandidate }], expected: false },
    { label: "duplicate controller", candidates: [{ ...visibleCandidate, controllerCount: 2 }], expected: false },
    { label: "duplicate play pause", candidates: [{ ...visibleCandidate, playPauseCount: 2 }], expected: false },
    { label: "duplicate content", candidates: [{ ...visibleCandidate, contentFrameCount: 2 }], expected: false },
    { label: "duplicate surface", candidates: [{ ...visibleCandidate, videoSurfaceCount: 2 }], expected: false },
    ...emptyBoundCases,
  ];
  const result = runJavaNativeSurfaceProbe(cases);
  assert.equal(result.status, 0,
    `actual native surface predicate probe failed:\n${result.stdout}\n${result.stderr}`);

  const helper = read(nativeSurfaceJavaPath);
  const mutants = [
    helper.replace(
      "(describedControls || (emptyDescription && visibleControllerState))",
      "describedControls"),
    helper.replace(
      "candidate.description != null\n                && CONTROLS_DESCRIPTION.matcher(candidate.description).matches()",
      "candidate.description != null"),
    helper.replace("candidate.controllerCount == 1", "candidate.controllerCount >= 1"),
    helper.replace("candidate.playPauseCount == 1", "candidate.playPauseCount >= 1"),
    helper.replace("                && exactVideoContent;", ";"),
    helper.replace("                && candidate.videoSurfaceVisible;", ";"),
    helper.replace("PRODUCT_PACKAGE.equals(candidate.rootPackage)\n                && ", ""),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, helper, "native surface helper mutant anchor must exist");
    const mutantResult = runJavaNativeSurfaceProbe(cases, mutant);
    assert.notEqual(mutantResult.status, 0,
      `actual native surface helper mutant survived:\n${mutantResult.stdout}\n${mutantResult.stderr}`);
  }
});

test("TV driver uses the unique product-scoped Media3 surface for admission and reveal", () => {
  const source = read(javaPath);
  assertNativeSurfacePolicy(source);
  const selector = javaMethod(source, "nativePlayerSurfaceRootSelector");
  const reader = javaMethod(source, "readNativePlayerSurfaceSnapshot");
  const candidateReader = javaMethod(source, "readNativePlayerSurfaceCandidate");
  const reveal = javaMethod(source, "revealControls");
  const mutants = [
    source.replace(selector, selector.replace("                .pkg(PRODUCT_PACKAGE)\n", "")),
    source.replace(selector, selector.replace(
      ".pkg(PRODUCT_PACKAGE)", '.pkg("com.yawf.stream.wrong")')),
    source.replace(reader, reader.replace(
      "if (RuntimeTvNativeSurface.admits(candidate)) {", "if (true) {")),
    source.replace(candidateReader, candidateReader.replace(
      "controller.findObjects(nativePlayerStateSelector())",
      "root.findObjects(nativePlayerStateSelector())")),
    source.replace(candidateReader, candidateReader.replace(
      "contentFrame.findObjects(\n                    nativeVideoSurfaceSelector())",
      "root.findObjects(\n                    nativeVideoSurfaceSelector())")),
    source.replace(reveal, reveal.replace(
      "NativeSurfaceSnapshot surface = observeFreshNative(",
      "NativeSurfaceSnapshot surface = ")),
    source.replace(
      'waitForNativePlayerSurface("reentered native PlayerView");\n        revealControls();',
      'waitForNativePlayerSurface("reentered native PlayerView");'),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, source, "native surface mutant anchor must exist");
    assert.throws(() => assertNativeSurfacePolicy(mutant));
  }
});

test("instrumentation requires observable playback behavior rather than click-only success", () => {
  const source = read(javaPath);
  assertJavaSemanticPolicy(source);
  assertObservationOnly(source);
  assert.match(source, /webView\.isFocused\(\) \|\| webView\.findObject\(By\.focused\(true\)\) != null/);
  const mutant = source.replace(
    'checks.put("decodedFrameChanged", true);',
    'checks.put("decodedFrameChanged", false);',
  );
  assert.throws(() => assertJavaSemanticPolicy(mutant));
});

test("all admission files compile or parse without touching Android SDK", () => {
  execFileSync(python, ["-c", [
    "from pathlib import Path",
    `compile(Path(${JSON.stringify(hostPath)}).read_text(), ${JSON.stringify(hostPath)}, 'exec')`,
    `compile(Path(${JSON.stringify(fixturePath)}).read_text(), ${JSON.stringify(fixturePath)}, 'exec')`,
  ].join(";")]);
  JSON.parse(execFileSync(python, ["-c", [
    "import json,re,pathlib",
    `s=pathlib.Path(${JSON.stringify(javaPath)}).read_text()`,
    `p=pathlib.Path(${JSON.stringify(mainActivityPath)}).read_text()`,
    "assert s.count('{')==s.count('}') and p.count('{')==p.count('}')",
    "print(json.dumps({'javaBraceBalance':True,'productJavaBraceBalance':True}))",
  ].join(";")], { encoding: "utf8" }));
  assertWorkflowPolicy(read(workflowPath));
});

function executeTagBinding(code, refMutation = () => {}, tagMutation = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "yawf-tv-tag-binding-"));
  const ref = {ref: "refs/tags/v2.3.28-web", object: {type: "tag", sha: "3dd4097c4e9c11a2efbf231389b9078a78f635c1"}};
  const tag = {sha: "3dd4097c4e9c11a2efbf231389b9078a78f635c1", tag: "v2.3.28-web", object: {type: "commit", sha: "2aa6a41664756526123a566c062053e15ab646cb"}};
  refMutation(ref); tagMutation(tag);
  writeFileSync(join(directory, "tv-tag-ref.json"), JSON.stringify(ref));
  writeFileSync(join(directory, "tv-annotated-tag.json"), JSON.stringify(tag));
  return spawnSync(python, ["-I", "-B", "-c", code], {encoding: "utf8", env: {...process.env,
    RUNNER_TEMP: directory, TV_RELEASE_TAG: "v2.3.28-web",
    TV_TAG_OBJECT: "3dd4097c4e9c11a2efbf231389b9078a78f635c1", TV_SOURCE_REVISION: "2aa6a41664756526123a566c062053e15ab646cb"}});
}

test("actual annotated TV tag binding peels only the fixed object to its fixed commit", () => {
  const source = read(workflowPath);
  const code = source.split('# BEGIN TV_ANNOTATED_TAG_BINDING\n')[1].split('# END TV_ANNOTATED_TAG_BINDING')[0]
    .split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
  const original = executeTagBinding(code);
  assert.equal(original.status, 0, original.stdout + original.stderr);
  const cases = [
    [ref => {ref.ref = "refs/tags/v2.3.27-web";}, () => {}, 'assert tag_ref["ref"] == "refs/tags/" + env["TV_RELEASE_TAG"]'],
    [ref => {ref.object.type = "commit";}, () => {}, 'assert tag_ref["object"]["type"] == "tag"'],
    [ref => {ref.object.sha = "0".repeat(40);}, () => {}, 'assert tag_ref["object"]["sha"] == env["TV_TAG_OBJECT"]'],
    [() => {}, tag => {tag.sha = "0".repeat(40);}, 'assert annotated["sha"] == env["TV_TAG_OBJECT"]'],
    [() => {}, tag => {tag.tag = "v2.3.27-web";}, 'assert annotated["tag"] == env["TV_RELEASE_TAG"]'],
    [() => {}, tag => {tag.object.type = "tag";}, 'assert annotated["object"]["type"] == "commit"'],
    [() => {}, tag => {tag.object.sha = "0".repeat(40);}, 'assert annotated["object"]["sha"] == env["TV_SOURCE_REVISION"]'],
  ];
  for (const [refMutation, tagMutation, assertion] of cases) {
    assert.notEqual(executeTagBinding(code, refMutation, tagMutation).status, 0, assertion);
    assert.equal(code.split(assertion).length, 2, assertion);
    const mutant = code.replace(assertion, 'pass');
    assert.notEqual(mutant, code);
    const admitted = executeTagBinding(mutant, refMutation, tagMutation);
    assert.equal(admitted.status, 0, 'The removed binding must admit its otherwise rejected mismatch: ' + assertion);
  }
});
