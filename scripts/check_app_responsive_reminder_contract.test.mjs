import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { validateReminderNavigationCss } from "./check_app_responsive_contract.mjs";

const read = (name) => readFileSync(new URL(`../web/src/components/${name}.css`, import.meta.url), "utf8");
const css = { navCss: read("NavRail"), setupNudgeCss: read("SetupNudge"), installPromptCss: read("InstallPrompt") };
const mobile = "@media (max-width: 699px), (max-width: 950px) and (max-height: 500px)";

test("reminders follow actual nav breakpoints, including914x411 and both boundary sides", () => {
  assert.deepEqual(validateReminderNavigationCss(css), []);
});

test("a correct stack-only query cannot conceal the old640px setup layout query", () => {
  const setupNudgeCss = css.setupNudgeCss.replace(mobile, "@media (max-width: 640px)") +
    `\n${mobile} { .setup-nudge { z-index: 29; } }`;
  assert.notEqual(setupNudgeCss, css.setupNudgeCss);
  const failures = validateReminderNavigationCss({ ...css, setupNudgeCss });
  assert.ok(failures.some((failure) => failure.includes("setup-nudge 914x411: bottom")));
  assert.ok(failures.some((failure) => failure.includes("setup-nudge 641x800")));
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
    const setupNudgeCss = css.setupNudgeCss.replace(`calc(100${unit} -`, "calc(200vh -");
    assert.notEqual(setupNudgeCss, css.setupNudgeCss);
    assert.ok(validateReminderNavigationCss({ ...css, setupNudgeCss })
      .some((failure) => failure.includes("setup-nudge 914x411: max-height")));
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
