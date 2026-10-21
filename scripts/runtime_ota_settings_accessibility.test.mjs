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
      /tapVisibleAndroidUpdateCheckCard\((?:"android-update-card"|null)\)/,
      "public 2.3.25 updater card is not handled through visible UI",
    ],
    [
      /By\.text\("Android APK updates"\)\s*\.pkg\(OtaFlowPolicy\.PRODUCT_PACKAGE\)\s*\.clazz\("android\.widget\.TextView"\)\s*\.enabled\(true\)/,
      "Android update card title is not exact text, product package, TextView class, and enabled state",
    ],
    [
      /By\.text\("Check for Android updates"\)\s*\.pkg\(OtaFlowPolicy\.PRODUCT_PACKAGE\)\s*\.clazz\("android\.widget\.Button"\)\s*\.clickable\(true\)\s*\.enabled\(true\)/,
      "Android update Check button is not exact text, product package, Button class, clickable, and enabled",
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
      /Rect gestureBounds = new Rect\(scrollBounds\);[\s\S]*?gestureBounds\.intersect\(settingsBounds\)[\s\S]*?int navigationClearance = navigationBounds\.height\(\);[\s\S]*?gestureBounds\.top = gestureBounds\.top \+ navigationClearance;[\s\S]*?gestureBounds\.bottom = Math\.min\(\s*gestureBounds\.bottom, navigationBounds\.top - navigationClearance\)/,
      "scroll gesture region is not inset from both Settings edges and capped above the full navigation",
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
  const exactCardTaps = source.match(
    /tapVisibleAndroidUpdateCheckCard\((?:"android-update-card"|null)\);/g,
  ) ?? [];
  if (exactCardTaps.length !== 2) {
    failures.push("both pre-update and post-update checks must use the exact visible-card tap path");
  }
  const visibleCardTap = source.match(
    /private void tapVisibleAndroidUpdateCheckCard\(String captureLabel\)[\s\S]*?\n    }\n\n    private /,
  )?.[0] ?? "";
  if (!/By\.text\("Android APK updates"\)[\s\S]*?\.clazz\("android\.widget\.TextView"\)/.test(visibleCardTap)
      || !/By\.text\("Check for Android updates"\)[\s\S]*?\.clazz\("android\.widget\.Button"\)[\s\S]*?\.clickable\(true\)/.test(visibleCardTap)
      || !/assertNoBindingTerms\(\);[\s\S]*?button = device\.findObject\(check\);/.test(visibleCardTap)
      || !/isVisibleAboveBottomNavigation\(button\)/.test(visibleCardTap)
      || !/button\.click\(\);/.test(visibleCardTap)) {
    failures.push("public 2.3.25 visible update card is not guarded and tapped through its exact Check button");
  }
  if (/InfoTip|ANDROID APK UPDATES|revealPublicBaselineAndroidUpdateControl|AccessibilityNodeInfo|ACTION_CLICK|performAction/.test(visibleCardTap)) {
    failures.push("public 2.3.25 card path used a legacy disclosure or non-touch accessibility activation");
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
      "gestureBounds.top = gestureBounds.top + navigationClearance;",
      "gestureBounds.top = settingsBounds.top;",
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
      '"Install & setup", "android.view.View", true, Direction.UP',
      '"Install & setup", "android.view.View", true, Direction.DOWN',
    ],
    [
      'By.text("Android APK updates")',
      'By.text("Android APK Updates")',
    ],
    [
      '.clazz("android.widget.Button")\n                .clickable(true)',
      '.clazz("android.widget.TextView")\n                .clickable(true)',
    ],
    [
      "button.click();",
      "button.getAccessibilityNodeInfo().performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK);",
    ],
    [
      "assertNoBindingTerms();\n        button = device.findObject(check);",
      "button = device.findObject(check);",
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
