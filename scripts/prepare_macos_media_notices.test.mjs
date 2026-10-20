import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { prepareMediaNotices } from "./prepare_macos_media_notices.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "yawf-media-notices-"));
  mkdirSync(join(root, "recipe/sources/component"), { recursive: true }); mkdirSync(join(root, "artifacts"));
  writeFileSync(join(root, "recipe/sources/component/LICENSE"), "GPL fixture text");
  const provenance = { sourceInventory: { notices: [{ path: "component/LICENSE", sha256: createHash("sha256").update("GPL fixture text").digest("hex") }] } };
  const save = () => writeFileSync(join(root, "artifacts/provenance.json"), JSON.stringify(provenance));
  save(); return { root, provenance, save, output: join(root, "notices"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
test("copies verified component notices and truthful provenance", () => {
  const f = fixture(); try {
    assert.deepEqual(prepareMediaNotices(f.root, f.output), { files: 1 });
    assert.equal(readFileSync(join(f.output, "components/component/LICENSE"), "utf8"), "GPL fixture text");
    assert.deepEqual(JSON.parse(readFileSync(join(f.output, "provenance.json"))), f.provenance);
  } finally { f.cleanup(); }
});
for (const [name, mutate, expected] of [
  ["unsafe path", (f) => { f.provenance.sourceInventory.notices[0].path = "../escape"; }, /Unsafe/],
  ["changed notice", (f) => { writeFileSync(join(f.root, "recipe/sources/component/LICENSE"), "changed"); }, /hash mismatch/],
  ["private provenance", (f) => { f.provenance.private = "/Users/private/build"; }, /workstation path/],
  ["escaping notice symlink", (f) => { writeFileSync(join(f.root, "outside"), "GPL fixture text"); symlinkSync(join(f.root, "outside"), join(f.root, "recipe/sources/component/ESCAPE")); f.provenance.sourceInventory.notices[0].path = "component/ESCAPE"; }, /escapes/],
]) test(`rejects ${name} before writing`, () => {
  const f = fixture(); try {
    mutate(f); f.save(); assert.throws(() => prepareMediaNotices(f.root, f.output), expected); assert.equal(existsSync(f.output), false);
  } finally { f.cleanup(); }
});
test("refuses existing notice output without altering it", () => {
  const f = fixture(); try {
    mkdirSync(f.output); writeFileSync(join(f.output, "keep"), "unchanged");
    assert.throws(() => prepareMediaNotices(f.root, f.output), /must not exist/); assert.equal(readFileSync(join(f.output, "keep"), "utf8"), "unchanged");
  } finally { f.cleanup(); }
});
