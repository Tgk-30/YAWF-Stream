import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimePath = new URL(
  "./android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeOtaFlowTest.java",
  import.meta.url,
);

function refreshedStageBody(source) {
  const match = source.match(
    /private void waitForRefreshedWelcomeStage\([\s\S]*?\n    }\n\n    private /,
  );
  return match?.[0] ?? "";
}

function validateRefreshContract(source) {
  const failures = [];
  const body = refreshedStageBody(source);
  if (!body) failures.push("missing bounded refreshed welcome-stage observer");
  if (!/Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.UPSIDE_DOWN_CAKE/.test(body)) {
    failures.push("API 34 clearCache floor is not fail-closed");
  }
  if (!/instrumentation\.getUiAutomation\(\)\.clearCache\(\)/.test(body)) {
    failures.push("observer does not clear the public UiAutomation cache");
  }
  if (!/By\.text\(expectedTitle\)/.test(body) || /By\.textContains\(expectedTitle\)/.test(body)) {
    failures.push("observer does not require the exact expected title");
  }
  if (!/By\.text\(String\.valueOf\(oneBasedStep\)\)/.test(body)) {
    failures.push("observer does not require the exact expected counter");
  }
  if (!/dialog\.findObject\(titleSelector\)/.test(body)
      || !/dialog\.findObject\(counterSelector\)/.test(body)) {
    failures.push("title and counter are not scoped to the Welcome tour dialog");
  }
  if (!/settled >= WELCOME_STAGE_SETTLED_SAMPLES/.test(body)
      || !/WELCOME_STAGE_SETTLED_SAMPLES = 2/.test(source)) {
    failures.push("refreshed title and counter are not required to settle");
  }
  if (/\.(?:click|pressBack|pressEnter|pressKeyCode|swipe)\s*\(/.test(body)) {
    failures.push("observation helper performs UI input");
  }
  if (!/waitForRefreshedWelcomeStage\(\s*titles\[step \+ 1\],\s*step \+ 2,/.test(source)) {
    failures.push("welcome transition does not use the refreshed observer");
  }
  if (!/waitForRefreshedWelcomeClosed\(capturePrefix\)/.test(source)) {
    failures.push("final Welcome closure does not use refreshed observation");
  }
  const closed = source.match(
    /private void waitForRefreshedWelcomeClosed\([\s\S]*?\n    }\n\n    private /,
  )?.[0] ?? "";
  if (!/instrumentation\.getUiAutomation\(\)\.clearCache\(\)/.test(closed)
      || !/device\.findObject\(dialogSelector\) == null/.test(closed)) {
    failures.push("final Welcome closure is not observed after a cache refresh");
  }
  if (/\.(?:click|pressBack|pressEnter|pressKeyCode|swipe)\s*\(/.test(closed)) {
    failures.push("closure observer performs UI input");
  }
  return failures;
}

test("welcome transitions clear stale accessibility state and settle on exact title plus counter", async () => {
  const source = await readFile(runtimePath, "utf8");
  assert.deepEqual(validateRefreshContract(source), []);

  const mutants = [
    [
      "boolean cacheCleared = instrumentation.getUiAutomation().clearCache();\n"
        + "            UiObject2 dialog = cacheCleared ? device.findObject(dialogSelector) : null;",
      "boolean cacheCleared = true;\n"
        + "            UiObject2 dialog = cacheCleared ? device.findObject(dialogSelector) : null;",
    ],
    [
      "By.text(expectedTitle)",
      "By.textContains(expectedTitle)",
    ],
    [
      "By.text(String.valueOf(oneBasedStep))",
      "By.text(String.valueOf(oneBasedStep - 1))",
    ],
    [
      "dialog.findObject(counterSelector)",
      "device.findObject(counterSelector)",
    ],
    [
      "if (settled >= WELCOME_STAGE_SETTLED_SAMPLES)",
      "if (settled >= 1)",
    ],
    [
      "waitForRefreshedWelcomeClosed(capturePrefix)",
      "device.pressBack()",
    ],
  ];
  for (const [before, after] of mutants) {
    assert.equal(source.split(before).length - 1, 1, `mutation site must be unique: ${before}`);
    assert.notDeepEqual(
      validateRefreshContract(source.replace(before, after)),
      [],
      `semantic mutant survived: ${before}`,
    );
  }
});
