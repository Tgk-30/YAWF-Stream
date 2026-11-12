import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { validateReminderNavigationCss, validateSetupFlowLayout } from "./check_app_responsive_contract.mjs";

const read = (name) => readFileSync(new URL(`../web/src/components/${name}.css`, import.meta.url), "utf8");
const css = { navCss: read("NavRail"), setupNudgeCss: read("SetupNudge"), installPromptCss: read("InstallPrompt") };
const mobile = "@media (max-width: 699px), (max-width: 950px) and (max-height: 500px)";

test("reminders follow actual nav breakpoints, including914x411 and both boundary sides", () => {
  assert.deepEqual(validateReminderNavigationCss(css), []);
});

test("a phone-only setup query cannot conceal missing short-landscape action geometry", () => {
  const setupNudgeCss = css.setupNudgeCss.replace(mobile, "@media (max-width: 640px)");
  assert.notEqual(setupNudgeCss, css.setupNudgeCss);
  const failures = validateReminderNavigationCss({ ...css, setupNudgeCss });
  assert.ok(failures.some((failure) => failure.includes("setup-nudge 914x411: bounded flow width")));
  assert.ok(failures.some((failure) => failure.includes("setup-nudge 641x800")));
});

test("floating or clipped setup guidance is rejected at every viewport", () => {
  for (const declaration of ["position: fixed;", "max-height: 100px;", "overflow-y: auto;", "z-index: 40;"]) {
    const setupNudgeCss = css.setupNudgeCss + `\n${mobile} { .setup-nudge { ${declaration} } }`;
    assert.ok(validateReminderNavigationCss({ ...css, setupNudgeCss })
      .some((failure) => failure.includes("setup-nudge 914x411:")), declaration);
  }
});

test("old phone-only install layout is rejected in short landscape", () => {
  const installPromptCss = css.installPromptCss.replace(mobile, "@media (max-width: 699px)");
  assert.notEqual(installPromptCss, css.installPromptCss);
  assert.ok(validateReminderNavigationCss({ ...css, installPromptCss })
    .some((failure) => failure.includes("install-prompt 914x411: bottom")));
});

test("a later offset regression fails even when the shared query still exists", () => {
  const setupNudgeCss = css.setupNudgeCss + `\n${mobile} { .setup-nudge { bottom: var(--sp-lg); } }`;
  assert.ok(validateReminderNavigationCss({ ...css, setupNudgeCss })
    .some((failure) => failure.includes("setup-nudge 914x411: bottom")));
});

test("clipped overflow or undersized dismiss targets cannot satisfy the mobile contract", () => {
  for (const [from, to] of [["overflow-y: auto;", "overflow-y: hidden;"], ["width: 44px;", "width: 28px;"]]) {
    const installPromptCss = css.installPromptCss.replace(from, to);
    assert.notEqual(installPromptCss, css.installPromptCss);
    assert.ok(validateReminderNavigationCss({ ...css, installPromptCss }).length > 0);
  }
});


test("legacy and dynamic viewport bounds are independently required", () => {
  for (const unit of ["vh", "dvh"]) {
    const installPromptCss = css.installPromptCss.replace(`calc(100${unit} -`, "calc(200vh -");
    assert.notEqual(installPromptCss, css.installPromptCss);
    assert.ok(validateReminderNavigationCss({ ...css, installPromptCss })
      .some((failure) => failure.includes("install-prompt 914x411: max-height")));
  }
});

test("flow placement, fixed-search clearance and independent reserves reject individual regressions", () => {
  const appSource = readFileSync(new URL("../web/src/App.tsx", import.meta.url), "utf8");
  const appCss = readFileSync(new URL("../web/src/App.css", import.meta.url), "utf8");
  assert.deepEqual(validateSetupFlowLayout({ appSource, appCss }), []);
  for (const [from, to] of [
    ['className="app-setup-region"', 'className="floating-setup"'],
    ['data-install-prompt={showInstallPrompt || undefined}', 'data-install-prompt={showSetupNudge || showInstallPrompt || undefined}'],
  ]) {
    const changed = appSource.replace(from, to);
    assert.notEqual(changed, appSource);
    assert.ok(validateSetupFlowLayout({ appSource: changed, appCss }).length > 0);
  }
  for (const [from, to] of [
    [".app[data-install-prompt]", ".app[data-setup-nudge]"],
    [" + max(44px, calc(44px * var(--density-scale))) + var(--sp-md)", " + 0px + var(--sp-md)"],
    ["padding-bottom: var(--mobile-nav-reserve);", "padding-bottom: 0;"],
    ["padding-bottom: calc(var(--mobile-nav-reserve) + calc(128px", "padding-bottom: calc(var(--mobile-nav-reserve) + calc(0px"],
  ]) {
    const changed = appCss.replace(from, to);
    assert.notEqual(changed, appCss);
    assert.ok(validateSetupFlowLayout({ appSource, appCss: changed }).length > 0, from);
  }
});

test("importing the pure contract does not print or exit the CLI", () => {
  const moduleUrl = new URL("./check_app_responsive_contract.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `await import(${JSON.stringify(moduleUrl)}); process.stdout.write("import returned\\n");`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "import returned\n");
  assert.equal(result.stderr, "");
});
