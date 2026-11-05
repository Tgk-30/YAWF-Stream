import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateFolderFormsCss } from "./check_app_responsive_contract.mjs";

const libraryCss = readFileSync(new URL("../web/src/screens/LibraryScreens.css", import.meta.url), "utf8");
const themeCss = readFileSync(new URL("../web/src/theme/theme.css", import.meta.url), "utf8");

test("shared folder editors are bounded and wrap without reducing 44px targets", () => {
  assert.deepEqual(validateFolderFormsCss(libraryCss, themeCss), []);
});

test("the predecessor nowrap editor is rejected even though its outer folder bar wraps", () => {
  const predecessor = libraryCss.replace(
    /\.lib-folder-new \{[\s\S]*?\n\}/,
    `.lib-folder-new {
  display: inline-flex;
  align-items: center;
  gap: calc(6px * var(--density-scale));
}`,
  );
  assert.notEqual(predecessor, libraryCss);
  assert.ok(validateFolderFormsCss(predecessor, themeCss).some((failure) => failure.includes("must wrap")));
});

test("losing either editor or input bounds cannot pass the folder contract", () => {
  for (const selector of [".lib-folder-new", ".lib-folder-input"]) {
    const start = libraryCss.indexOf(`${selector} {`);
    const end = libraryCss.indexOf("}", start);
    const block = libraryCss.slice(start, end).replace("max-width: 100%;", "max-width: none;");
    const mutant = libraryCss.slice(0, start) + block + libraryCss.slice(end);
    assert.notEqual(mutant, libraryCss);
    assert.ok(validateFolderFormsCss(mutant, themeCss).some((failure) => failure.includes("bounded")));
  }
});

test("touch targets and the already-wrapping Library rename toolbar stay protected", () => {
  assert.ok(validateFolderFormsCss(libraryCss.replace("min-height: 44px;", "min-height: 32px;"), themeCss)
    .some((failure) => failure.includes("44px")));
  assert.ok(validateFolderFormsCss(libraryCss, themeCss.replace("min-height: 44px;", "min-height: 32px;"))
    .some((failure) => failure.includes("44px")));
  const start = libraryCss.indexOf(".lib-folder-tools {");
  const renamed = libraryCss.slice(0, start) + libraryCss.slice(start).replace("flex-wrap: wrap;", "flex-wrap: nowrap;");
  assert.ok(validateFolderFormsCss(renamed, themeCss).some((failure) => failure.includes("rename")));
});
