import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimePath = new URL(
  "./android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeFlowTest.java",
  import.meta.url,
);

function validateObservationTiming(source) {
  const failures = [];
  const required = [
    [
      /private static final long TOUR_MOUNT_WAIT_MS = 5_000;/,
      "tour observation deadline changed from 5000ms",
    ],
    [
      /private static final long TOUR_OBSERVATION_IDLE_TIMEOUT_MS = 0;/,
      "tour observation still permits an implicit idle wait",
    ],
    [
      /Configurator configurator = Configurator\.getInstance\(\);\s*long previousIdleTimeout = configurator\.getWaitForIdleTimeout\(\);\s*configurator\.setWaitForIdleTimeout\(TOUR_OBSERVATION_IDLE_TIMEOUT_MS\);\s*try \{\s*observeOrdinaryTourDismissal\(\);\s*\} finally \{\s*configurator\.setWaitForIdleTimeout\(previousIdleTimeout\);\s*\}/,
      "zero-idle observation is not scoped and restored with try/finally",
    ],
    [
      /queryExactTourNode\(\s*"welcome-dialog", FlowPolicy\.WELCOME_TOUR_DIALOG, false\)/,
      "exact Welcome-tour dialog observation was removed",
    ],
    [
      /queryExactTourNode\(\s*"discover", FlowPolicy\.DISCOVER_BUTTON, true\)/,
      "exact visible Discover observation was removed",
    ],
    [
      /queryExactTourNode\(\s*"setup-reminder", FlowPolicy\.STREAMING_SETUP_REMINDER, true\)/,
      "exact visible setup-reminder observation was removed",
    ],
    [
      /FlowPolicy\.isTourDismissalSettled\(consecutiveAbsentSamples\)/,
      "settled three-sample policy is no longer authoritative",
    ],
    [
      /By\.text\(spec\.label\(\)\)\s*\.pkg\(FlowPolicy\.PRODUCT_PACKAGE\)\s*\.clazz\(spec\.className\(\)\)/,
      "observation lost exact text, product package, or class identity",
    ],
    [
      /!requireVisibleBounds \|\| !object\.getVisibleBounds\(\)\.isEmpty\(\)/,
      "Discover or reminder visibility no longer requires nonempty bounds",
    ],
  ];
  for (const [pattern, message] of required) {
    if (!pattern.test(source)) failures.push(message);
  }

  const dismissalMethod = source.match(
    /private void dismissOrdinaryTours\(\)[\s\S]*?\n    }\n\n    private void observeOrdinaryTourDismissal/,
  )?.[0] ?? "";
  if ((dismissalMethod.match(/object\.click\(\);/g) ?? []).length !== 1) {
    failures.push("ordinary tour dismissal must retain exactly one guarded Skip click");
  }
  const observationMethod = source.match(
    /private void observeOrdinaryTourDismissal\(\)[\s\S]*?\n    }\n\n    private TimedNodeQuery/,
  )?.[0] ?? "";
  if (/\.click\(|pressBack\(|clearCache\(/.test(observationMethod)) {
    failures.push("observation performs recovery input, another click, or unnecessary cache mutation");
  }
  if ((source.match(/setWaitForIdleTimeout\(/g) ?? []).length !== 2) {
    failures.push("idle timeout scope has more than one set and one restore");
  }
  return failures;
}

test("tour dismissal observation disables only implicit idle and restores configuration", async () => {
  const source = await readFile(runtimePath, "utf8");
  assert.deepEqual(validateObservationTiming(source), []);

  const mutants = [
    [
      "TOUR_OBSERVATION_IDLE_TIMEOUT_MS = 0",
      "TOUR_OBSERVATION_IDLE_TIMEOUT_MS = 250",
    ],
    [
      "configurator.setWaitForIdleTimeout(previousIdleTimeout);",
      "configurator.setWaitForIdleTimeout(TOUR_OBSERVATION_IDLE_TIMEOUT_MS);",
    ],
    [
      "observeOrdinaryTourDismissal();",
      "SystemClock.sleep(TOUR_MOUNT_WAIT_MS);",
    ],
    [
      "TOUR_MOUNT_WAIT_MS = 5_000",
      "TOUR_MOUNT_WAIT_MS = 6_000",
    ],
    [
      "FlowPolicy.isTourDismissalSettled(consecutiveAbsentSamples)",
      "consecutiveAbsentSamples >= 2",
    ],
    [
      ".pkg(FlowPolicy.PRODUCT_PACKAGE)\n                            .clazz(spec.className())",
      ".clazz(spec.className())",
    ],
    [
      ".clazz(spec.className())",
      ".clazz(\"android.view.View\")",
    ],
    [
      "!requireVisibleBounds || !object.getVisibleBounds().isEmpty()",
      "!requireVisibleBounds || present",
    ],
    [
      '"setup-reminder", FlowPolicy.STREAMING_SETUP_REMINDER, true',
      '"setup-reminder", FlowPolicy.STREAMING_SETUP_REMINDER, false',
    ],
  ];
  for (const [before, after] of mutants) {
    assert.ok(source.includes(before), `mutation site missing: ${before}`);
    assert.notDeepEqual(
      validateObservationTiming(source.replace(before, after)),
      [],
      `observation timing mutant survived: ${before}`,
    );
  }
});
