import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimePath = new URL(
  "./android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeFlowTest.java",
  import.meta.url,
);

function method(source, start, end) {
  return source.match(new RegExp(`${start}[\\s\\S]*?${end}`))?.[0] ?? "";
}

function validateObservationTiming(source) {
  const failures = [];
  const require = (pattern, message, target = source) => {
    if (!pattern.test(target)) failures.push(message);
  };

  require(/import android\.os\.Build;/, "API-level guard import is missing");
  require(
    /private static final long TOUR_MOUNT_WAIT_MS = 5_000;/,
    "tour observation deadline changed from 5000ms",
  );
  require(
    /private static final long TOUR_OBSERVATION_IDLE_TIMEOUT_MS = 0;/,
    "tour observation permits an implicit idle wait",
  );
  require(
    /Configurator configurator = Configurator\.getInstance\(\);\s*long previousIdleTimeout = configurator\.getWaitForIdleTimeout\(\);\s*configurator\.setWaitForIdleTimeout\(TOUR_OBSERVATION_IDLE_TIMEOUT_MS\);\s*try \{\s*observeOrdinaryTourDismissal\(\);\s*\} finally \{\s*configurator\.setWaitForIdleTimeout\(previousIdleTimeout\);\s*\}/,
    "zero-idle observation is not scoped and restored with try/finally",
  );

  const dismissal = method(
    source,
    "private void dismissOrdinaryTours\\(\\)",
    "private void observeOrdinaryTourDismissal",
  );
  if ((dismissal.match(/object\.click\(\);/g) ?? []).length !== 1) {
    failures.push("ordinary tour dismissal must retain exactly one guarded Skip click");
  }

  const observation = method(
    source,
    "private void observeOrdinaryTourDismissal\\(\\)",
    "private TimedNodeQuery",
  );
  require(
    /boolean cacheRefreshRequired = Build\.VERSION\.SDK_INT\s*>= Build\.VERSION_CODES\.UPSIDE_DOWN_CAKE;\s*boolean cacheCleared = false;\s*boolean cacheKnown = true;\s*if \(cacheRefreshRequired\) \{\s*cacheCleared = instrumentation\.getUiAutomation\(\)\.clearCache\(\);\s*cacheKnown = cacheCleared;\s*\}/,
    "API 34 cache refresh is not guarded or its result is ignored",
    observation,
  );
  if ((source.match(/clearCache\(\)/g) ?? []).length !== 1) {
    failures.push("cache must be cleared exactly once per observation sample");
  }
  require(
    /Tour observation cache elapsedMs="\s*\+ \(SystemClock\.uptimeMillis\(\) - cacheStarted\)\s*\+ " required=" \+ cacheRefreshRequired\s*\+ " cleared=" \+ cacheCleared\s*\+ " known=" \+ cacheKnown/,
    "cache timing and status are not logged inside the sample budget",
    observation,
  );
  require(
    /boolean observationKnown = cacheKnown\s*&& dialog\.known && discover\.known && reminder\.known;/,
    "API 34 samples can be counted when cache refresh fails",
    observation,
  );
  require(
    /queryExactTourNode\(\s*"welcome-dialog", FlowPolicy\.WELCOME_TOUR_DIALOG, false\)/,
    "exact Welcome-tour dialog observation was removed",
    observation,
  );
  require(
    /queryExactTourNode\(\s*"discover", FlowPolicy\.DISCOVER_BUTTON, true\)/,
    "exact visible Discover observation was removed",
    observation,
  );
  require(
    /queryExactTourNode\(\s*"setup-reminder", FlowPolicy\.STREAMING_SETUP_REMINDER, true\)/,
    "exact visible setup-reminder observation was removed",
    observation,
  );
  const cacheCall = observation.indexOf("clearCache()");
  const firstQuery = observation.indexOf("queryExactTourNode(");
  if (cacheCall < 0 || firstQuery < 0 || cacheCall > firstQuery) {
    failures.push("cache is not refreshed before all three exact selectors");
  }
  require(
    /FlowPolicy\.isTourDismissalSettled\(consecutiveAbsentSamples\)/,
    "settled three-sample policy is no longer authoritative",
    observation,
  );
  require(
    /SystemClock\.sleep\(Math\.min\(250, remainingMs\)\);/,
    "bounded 250ms observation interval changed",
    observation,
  );
  if (/\.click\(|pressBack\(|pressDPad|pressEnter\(/.test(observation)) {
    failures.push("observation performs input or recovery");
  }

  require(
    /By\.text\(spec\.label\(\)\)\s*\.pkg\(FlowPolicy\.PRODUCT_PACKAGE\)\s*\.clazz\(spec\.className\(\)\)/,
    "observation lost exact text, product package, or class identity",
  );
  require(
    /!requireVisibleBounds \|\| !object\.getVisibleBounds\(\)\.isEmpty\(\)/,
    "Discover or reminder visibility no longer requires nonempty bounds",
  );
  return failures;
}

test("tour dismissal uses one API-guarded fresh-cache observation and restores idle configuration", async () => {
  const source = await readFile(runtimePath, "utf8");
  assert.deepEqual(validateObservationTiming(source), []);

  const mutants = [
    ["raises the deadline", (s) => s.replace("TOUR_MOUNT_WAIT_MS = 5_000", "TOUR_MOUNT_WAIT_MS = 6_000")],
    ["restores implicit idle", (s) => s.replace("TOUR_OBSERVATION_IDLE_TIMEOUT_MS = 0", "TOUR_OBSERVATION_IDLE_TIMEOUT_MS = 250")],
    ["drops the API-level guard", (s) => s.replace("if (cacheRefreshRequired) {", "if (true) {")],
    ["uses the API before level 34", (s) => s.replace(">= Build.VERSION_CODES.UPSIDE_DOWN_CAKE", ">= Build.VERSION_CODES.TIRAMISU")],
    ["skips the public refresh API", (s) => s.replace("instrumentation.getUiAutomation().clearCache()", "true")],
    ["ignores refresh failure", (s) => s.replace("cacheKnown = cacheCleared;", "cacheKnown = true;")],
    ["counts an unknown cache", (s) => s.replace("boolean observationKnown = cacheKnown\n                    &&", "boolean observationKnown = true\n                    &&")],
    ["duplicates the refresh", (s) => s.replace("cacheKnown = cacheCleared;", "cacheCleared = instrumentation.getUiAutomation().clearCache();\n                cacheKnown = cacheCleared;")],
    ["moves a query before refresh", (s) => s.replace(
      "long cacheStarted = SystemClock.uptimeMillis();",
      "TimedNodeQuery premature = queryExactTourNode(\n                    \"welcome-dialog\", FlowPolicy.WELCOME_TOUR_DIALOG, false);\n            long cacheStarted = SystemClock.uptimeMillis();",
    )],
    ["removes cache status logging", (s) => s.replace("+ \" known=\" + cacheKnown", "+ \" known=unreported\"")],
    ["changes the sample interval", (s) => s.replace("Math.min(250, remainingMs)", "Math.min(500, remainingMs)")],
    ["bypasses settled policy", (s) => s.replace("FlowPolicy.isTourDismissalSettled(consecutiveAbsentSamples)", "consecutiveAbsentSamples >= 2")],
    ["drops exact package identity", (s) => s.replace(".pkg(FlowPolicy.PRODUCT_PACKAGE)\n                            .clazz(spec.className())", ".clazz(spec.className())")],
    ["weakens visible bounds", (s) => s.replace("!requireVisibleBounds || !object.getVisibleBounds().isEmpty()", "!requireVisibleBounds || present")],
    ["repeats Skip input", (s) => s.replace("object.click();\n        log(\"Clicked one exact", "object.click();\n        object.click();\n        log(\"Clicked one exact")],
    ["fails to restore idle", (s) => s.replace("configurator.setWaitForIdleTimeout(previousIdleTimeout);", "configurator.setWaitForIdleTimeout(TOUR_OBSERVATION_IDLE_TIMEOUT_MS);")],
  ];
  for (const [name, mutate] of mutants) {
    const mutant = mutate(source);
    assert.notEqual(mutant, source, `${name}: mutation site missing`);
    assert.notDeepEqual(validateObservationTiming(mutant), [], `${name}: mutant survived`);
  }
});
