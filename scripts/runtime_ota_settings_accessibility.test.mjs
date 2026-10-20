import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimePath = new URL(
  "./android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeOtaFlowTest.java",
  import.meta.url,
);

function validateSettingsAccessibility(source) {
  const failures = [];
  const required = [
    [
      /productTextOrDescriptionSelectors\(\s*"Experience tier", "android\.widget\.RadioGroup", false\)/,
      "Experience tier is not matched by exact text-or-description, product package, class, and enabled state",
    ],
    [
      /scrollUntilVisibleProductSemantic\(\s*"Simple", "android\.widget\.RadioButton", true, Direction\.DOWN\)/,
      "Simple radio is not an exact visible clickable product control",
    ],
    [
      /revealPublicBaselineAndroidUpdateControl\(\)/,
      "public baseline updater disclosure is not handled through visible UI",
    ],
    [
      /scrollUntilVisibleProductSemantic\(\s*"Check for Android updates", "android\.widget\.Button", true, Direction\.DOWN\)/,
      "Android update button is not exact and visibly admitted",
    ],
    [
      /scrollUntilVisibleProductSemantic\(\s*"YAWF Stream v" \+ OtaFlowPolicy\.TARGET_VERSION,[\s\S]*?"android\.widget\.TextView",[\s\S]*?false,[\s\S]*?Direction\.DOWN\)/,
      "post-update version is not required to be visibly admitted",
    ],
    [
      /scrollUntilVisibleProductSemantic\(\s*"Install & setup", "android\.view\.View", true, Direction\.UP\)/,
      "Settings category cannot be recovered after the version scroll",
    ],
    [
      /objectBounds\.bottom <= navigationBounds\.top/,
      "visibility does not exclude controls covered by bottom navigation",
    ],
    [
      /findAnyNow\(productTextOrDescriptionSelectors\(\s*"Primary", "android\.view\.View", false\)\)/,
      "bottom-navigation boundary is not the exact Primary container",
    ],
    [
      /findAnyNow\(productTextOrDescriptionSelectors\(\s*"Settings page", "android\.view\.View", false\)\)/,
      "scroll gesture region is not derived from the exact Settings page",
    ],
    [
      /Rect gestureBounds = new Rect\(scrollBounds\);[\s\S]*?gestureBounds\.intersect\(settingsBounds\)[\s\S]*?int navigationClearance = navigationBounds\.height\(\);[\s\S]*?gestureBounds\.bottom = Math\.min\(\s*gestureBounds\.bottom, navigationBounds\.top - navigationClearance\)/,
      "scroll gesture region is not intersected with Settings and capped above the full navigation",
    ],
    [
      /scrollable\.setGestureMargins\(leftMargin, topMargin, rightMargin, bottomMargin\)/,
      "scrollable does not use margins derived from the bounded Settings region",
    ],
    [
      /int leftMargin = gestureBounds\.left - scrollBounds\.left;\s*int topMargin = gestureBounds\.top - scrollBounds\.top;\s*int rightMargin = scrollBounds\.right - gestureBounds\.right;\s*int bottomMargin = scrollBounds\.bottom - gestureBounds\.bottom;/,
      "gesture margins are not calculated from all four observed bounds",
    ],
    [
      /boolean canStillScroll = scrollable\.scroll\(direction, 0\.75f\);[\s\S]*?canStillScroll=" \+ canStillScroll/,
      "scroll return is not retained and logged with its documented can-still-scroll meaning",
    ],
    [
      /for \(int attempt = 0; attempt < 12; attempt\+\+\)/,
      "bounded 12-attempt Settings scroll limit changed",
    ],
    [
      /By\.text\(text\)\s*\.pkg\(OtaFlowPolicy\.PRODUCT_PACKAGE\)\s*\.clazz\(className\)\s*\.enabled\(true\)/,
      "text selector lost exact package, class, or enabled identity",
    ],
    [
      /By\.desc\(text\)\s*\.pkg\(OtaFlowPolicy\.PRODUCT_PACKAGE\)\s*\.clazz\(className\)\s*\.enabled\(true\)/,
      "description selector lost exact package, class, or enabled identity",
    ],
    [
      /API 36 WebView accessibility did not expose "\s*\+ "its selected state/,
      "Simple selection limitation is not recorded honestly",
    ],
  ];
  for (const [pattern, message] of required) {
    if (!pattern.test(source)) failures.push(message);
  }
  const exactUpdateScrolls = source.match(
    /scrollUntilVisibleProductSemantic\(\s*"Check for Android updates", "android\.widget\.Button", true, Direction\.DOWN\)/g,
  ) ?? [];
  if (exactUpdateScrolls.length !== 2) {
    failures.push("both pre-update and post-update controls must use exact visible Button identity");
  }
  const baselineReveal = source.match(
    /private void revealPublicBaselineAndroidUpdateControl\([\s\S]*?\n    }\n\n    private /,
  )?.[0] ?? "";
  if (!/"Android APK updates", "android\.widget\.TextView", false, Direction\.DOWN/.test(baselineReveal)
      || !/"Android APK updates", "android\.widget\.Button", true, Direction\.DOWN/.test(baselineReveal)
      || !/clickProductSemantic\("Android APK updates", "android\.widget\.Button", SHORT_WAIT_MS\)/.test(baselineReveal)
      || !/"Check for Android updates", "android\.widget\.Button", true, Direction\.DOWN/.test(baselineReveal)) {
    failures.push("public 2.3.21 updater tooltip is not opened and admitted through exact visible controls");
  }
  const settingsMethod = source.match(
    /private void openSettingsAndAssertSimple\([\s\S]*?\n    }\n\n    private /,
  )?.[0] ?? "";
  if (/simple\.(?:isChecked|isSelected)\(\)/.test(settingsMethod)) {
    failures.push("harness overclaims a Simple selected state absent from API 36 accessibility");
  }
  const scrollBoundsMethod = source.match(
    /private void configureSettingsScrollGesture\([\s\S]*?\n    }\n\n    private /,
  )?.[0] ?? "";
  if (!/"Settings page", "android\.view\.View", false/.test(scrollBoundsMethod)
      || !/"Primary", "android\.view\.View", false/.test(scrollBoundsMethod)) {
    failures.push("gesture margins are not derived from exact Settings-page and Primary identities");
  }
  if (/device\.click\s*\(\s*\d/.test(source) || /executeShellCommand/.test(source)) {
    failures.push("runtime introduced coordinate or shell bypasses");
  }
  if (/setGestureMargins?\(\s*\d/.test(source)) {
    failures.push("Settings scroll gesture uses fixed numeric margins");
  }
  if (/(?:assertTrue|assertFalse|if)\s*\([^\n]*scrollable\.scroll\(/.test(source)) {
    failures.push("scroll return is treated as gesture success instead of remaining scroll capacity");
  }
  return failures;
}

test("Settings and OTA controls require exact semantic identity and safe visibility", async () => {
  const source = await readFile(runtimePath, "utf8");
  assert.deepEqual(validateSettingsAccessibility(source), []);

  const mutants = [
    [
      '"Experience tier", "android.widget.RadioGroup", false',
      '"Experience tier", "android.view.View", false',
    ],
    [
      '"Simple", "android.widget.RadioButton", true, Direction.DOWN',
      '"Simple", "android.widget.Button", true, Direction.DOWN',
    ],
    [
      "objectBounds.bottom <= navigationBounds.top",
      "objectBounds.bottom <= device.getDisplayHeight()",
    ],
    [
      'findAnyNow(productTextOrDescriptionSelectors(\n                "Primary", "android.view.View", false))',
      "findAnyNow(webButtonSelectors(OtaFlowPolicy.MORE_NAVIGATION))",
    ],
    [
      'findAnyNow(productTextOrDescriptionSelectors(\n                "Settings page", "android.view.View", false))',
      'findAnyNow(productTextOrDescriptionSelectors(\n                "Settings", "android.view.View", false))',
    ],
    [
      "gestureBounds.intersect(settingsBounds)",
      "gestureBounds.intersect(scrollBounds)",
    ],
    [
      "gestureBounds.bottom, navigationBounds.top - navigationClearance",
      "gestureBounds.bottom, navigationBounds.top",
    ],
    [
      "scrollable.setGestureMargins(leftMargin, topMargin, rightMargin, bottomMargin)",
      "scrollable.setGestureMargin(0)",
    ],
    [
      "int bottomMargin = scrollBounds.bottom - gestureBounds.bottom;",
      "int bottomMargin = scrollBounds.bottom - navigationBounds.bottom;",
    ],
    [
      "boolean canStillScroll = scrollable.scroll(direction, 0.75f);",
      "assertTrue(scrollable.scroll(direction, 0.75f));",
    ],
    [
      ".pkg(OtaFlowPolicy.PRODUCT_PACKAGE)\n                .clazz(className)",
      ".clazz(className)",
    ],
    [
      '"Check for Android updates", "android.widget.Button", true, Direction.DOWN',
      '"Check for Android updates", "android.widget.TextView", true, Direction.DOWN',
    ],
    [
      '"Install & setup", "android.view.View", true, Direction.UP',
      '"Install & setup", "android.view.View", true, Direction.DOWN',
    ],
    [
      'clickProductSemantic("Android APK updates", "android.widget.Button", SHORT_WAIT_MS)',
      'log("Skipped baseline disclosure")',
    ],
    [
      "simple.isEnabled()",
      "simple.isSelected()",
    ],
  ];
  for (const [before, after] of mutants) {
    assert.ok(source.includes(before), `mutation site missing: ${before}`);
    assert.notDeepEqual(
      validateSettingsAccessibility(source.replace(before, after)),
      [],
      `semantic mutant survived: ${before}`,
    );
  }
});
