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
  const exactUpdateScrolls = source.match(
    /scrollUntilVisibleProductSemantic\(\s*"Check for Android updates", "android\.widget\.Button", true, Direction\.DOWN\)/g,
  ) ?? [];
  if (exactUpdateScrolls.length !== 2) {
    failures.push("both pre-update and post-update controls must use exact visible Button identity");
  }
  const baselineReveal = source.match(
    /private void revealPublicBaselineAndroidUpdateControl\([\s\S]*?\n    }\n\n    private /,
  )?.[0] ?? "";
  if (!/"ANDROID APK UPDATES", "android\.widget\.TextView", false, Direction\.UP/.test(baselineReveal)
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

function validateLegacyAccessibilityActivation(source) {
  const failures = [];
  const runFlowBeforeConsent = source.match(
    /private void runFlow\(\) throws Exception \{[\s\S]*?waitFor\(By\.text\("Check for Android updates\?"\)/,
  )?.[0] ?? "";
  const method = source.match(
    /private void activatePublicBaselineAndroidUpdateControl\(\)[\s\S]*?\n    }\n\n    private /,
  )?.[0] ?? "";
  const exactNodeMethod = source.match(
    /private boolean isExactLegacyUpdateAccessibilityNode\([\s\S]*?\n    }\n\n    private /,
  )?.[0] ?? "";

  const requiredRunFlow = [
    [
      /revealPublicBaselineAndroidUpdateControl\(\);[\s\S]*?capture\("android-update-card"\);\s*activatePublicBaselineAndroidUpdateControl\(\);\s*waitFor\(By\.text\("Check for Android updates\?"\)/,
      "legacy accessibility activation is not immediately followed by the exact native consent assertion",
    ],
  ];
  const requiredActivation = [
    [
      /productTextOrDescriptionSelectors\(\s*text, "android\.widget\.Button", true\)/,
      "legacy control is not freshly located by exact clickable Button identity",
    ],
    [/assertNoBindingTerms\(\)/, "legacy activation omitted the existing admission guard"],
    [
      /findAnyNow\(selectors\)/,
      "legacy control is not freshly fetched immediately before activation",
    ],
    [
      /isVisibleAboveBottomNavigation\(visibleControl\)/,
      "legacy control does not retain the existing safe visible-bounds gate",
    ],
    [
      /Rect expectedBounds = visibleControl\.getVisibleBounds\(\)/,
      "legacy accessibility match is not tied to the admitted visible control bounds",
    ],
    [
      /instrumentation\.getUiAutomation\(\)\.getRootInActiveWindow\(\)/,
      "legacy activation does not query a fresh standard accessibility tree",
    ],
    [
      /assertEquals\("Legacy Android update accessibility control was not unique", 1, matches\)/,
      "legacy accessibility activation does not require exactly one matching node",
    ],
    [
      /getActionList\(\)\.contains\(\s*AccessibilityNodeInfo\.AccessibilityAction\.ACTION_CLICK\)/,
      "legacy accessibility node does not have to advertise ACTION_CLICK",
    ],
    [
      /assertTrue\(\s*"Legacy Android update accessibility ACTION_CLICK was rejected",\s*control\.performAction\(AccessibilityNodeInfo\.ACTION_CLICK\)\)/,
      "legacy ACTION_CLICK result is not required to succeed",
    ],
    [
      /Used one legacy accessibility-assisted activation for the exact public 2\.3\.21 [\s\S]*?this is not ordinary touch UX proof/,
      "legacy activation log does not distinguish accessibility assistance from ordinary touch UX proof",
    ],
  ];
  const requiredNode = [
    [
      /node\.getPackageName\(\) == null[\s\S]*?OtaFlowPolicy\.PRODUCT_PACKAGE\.contentEquals\(node\.getPackageName\(\)\)/,
      "legacy accessibility node is not restricted to the product package",
    ],
    [
      /node\.getClassName\(\) == null[\s\S]*?"android\.widget\.Button"\.contentEquals\(node\.getClassName\(\)\)/,
      "legacy accessibility node is not restricted to the exact Button class",
    ],
    [
      /text\.contentEquals\(nodeText == null \? "" : nodeText\)[\s\S]*?\|\| text\.contentEquals\(nodeDescription == null \? "" : nodeDescription\)/,
      "legacy accessibility node is not restricted to exact text or description",
    ],
    [/node\.isEnabled\(\)/, "legacy accessibility node is not required to be enabled"],
    [/node\.isClickable\(\)/, "legacy accessibility node is not required to be clickable"],
    [/node\.isVisibleToUser\(\)/, "legacy accessibility node is not required to be visible"],
    [
      /!nodeBounds\.isEmpty\(\) && nodeBounds\.equals\(expectedBounds\)/,
      "legacy accessibility node bounds do not exactly match the admitted control",
    ],
  ];

  for (const [pattern, message] of requiredRunFlow) {
    if (!pattern.test(runFlowBeforeConsent)) failures.push(message);
  }
  for (const [pattern, message] of requiredActivation) {
    if (!pattern.test(method)) failures.push(message);
  }
  for (const [pattern, message] of requiredNode) {
    if (!pattern.test(exactNodeMethod)) failures.push(message);
  }
  if ((method.match(/performAction\(AccessibilityNodeInfo\.ACTION_CLICK\)/g) ?? []).length !== 1) {
    failures.push("legacy accessibility ACTION_CLICK must be performed exactly once");
  }
  if (/clickProductSemantic\(\s*"Check for Android updates"/.test(runFlowBeforeConsent)) {
    failures.push("legacy baseline still uses the focus-changing ordinary touch helper");
  }
  if (/executeShellCommand|device\.click\s*\(|\b(?:invoke|reflection|setAccessible)\b/i.test(method)) {
    failures.push("legacy activation introduced a shell, coordinate, reflection, or private invocation bypass");
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
      '"ANDROID APK UPDATES", "android.widget.TextView", false, Direction.UP',
      '"Android APK updates", "android.widget.TextView", false, Direction.UP',
    ],
    [
      '"ANDROID APK UPDATES", "android.widget.TextView", false, Direction.UP',
      '"ANDROID APK UPDATES", "android.widget.TextView", false, Direction.DOWN',
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

test("legacy 2.3.21 updater uses one exact accessibility-assisted activation", async () => {
  const source = await readFile(runtimePath, "utf8");
  assert.deepEqual(validateLegacyAccessibilityActivation(source), []);

  const mutants = [
    [
      "activatePublicBaselineAndroidUpdateControl();",
      'clickProductSemantic("Check for Android updates", "android.widget.Button", SHORT_WAIT_MS);',
    ],
    [
      'assertEquals("Legacy Android update accessibility control was not unique", 1, matches);',
      'assertTrue("Legacy Android update accessibility control was present", matches >= 1);',
    ],
    [
      "control.getActionList().contains(\n                            AccessibilityNodeInfo.AccessibilityAction.ACTION_CLICK)",
      "true",
    ],
    [
      'assertTrue(\n                    "Legacy Android update accessibility ACTION_CLICK was rejected",\n                    control.performAction(AccessibilityNodeInfo.ACTION_CLICK));',
      "control.performAction(AccessibilityNodeInfo.ACTION_CLICK);",
    ],
    [
      "|| !node.isVisibleToUser())",
      ")",
    ],
    [
      "return !nodeBounds.isEmpty() && nodeBounds.equals(expectedBounds);",
      "return !nodeBounds.isEmpty();",
    ],
  ];
  for (const [before, after] of mutants) {
    assert.ok(source.includes(before), `mutation site missing: ${before}`);
    assert.notDeepEqual(
      validateLegacyAccessibilityActivation(source.replace(before, after)),
      [],
      `legacy activation mutant survived: ${before}`,
    );
  }
});
