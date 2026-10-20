import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareReplayMediaNotices } from "./prepare_macos_replay_notices.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const projectLicense = readFileSync(new URL("../LICENSE", import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "replay-notices-"));
  const source = join(root, "source"), provenance = join(source, "provenance.json"), output = join(root, "output");
  mkdirSync(join(source, "component-sources/example"), { recursive: true });
  mkdirSync(join(source, "replay-controls"));
  const notice = Buffer.from("license\n");
  writeFileSync(join(source, "component-sources/example/LICENSE"), notice);
  writeFileSync(join(source, "SOURCE-INVENTORY.json"), JSON.stringify({ notices: [{ path: "example/LICENSE", sha256: hash(notice) }] }));
  writeFileSync(join(source, "replay-controls/PROJECT-LICENSE.txt"), projectLicense);
  writeFileSync(join(source, "OWNED-FILE-MANIFEST.json"), JSON.stringify({
    schemaVersion: 1,
    licensingCleared: false,
    files: [{ path: "replay-controls/PROJECT-LICENSE.txt", bytes: projectLicense.length, sha256: hash(projectLicense) }],
  }));
  writeFileSync(join(source, "replay-controls/SOURCE-NOTICES.md"), "source notice\n");
  writeFileSync(provenance, JSON.stringify({ licensingCleared: false, architecture: "arm64" }));
  return { root, source, provenance, output, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("copies only hash-verified component notices and preserves false clearance", () => {
  const value = fixture();
  try {
    assert.deepEqual(prepareReplayMediaNotices(value.source, value.provenance, value.output), { files: 1 });
    assert.equal(readFileSync(join(value.output, "components/example/LICENSE"), "utf8"), "license\n");
    assert.deepEqual(readFileSync(join(value.output, "PROJECT-LICENSE.txt")), projectLicense);
    assert.equal(JSON.parse(readFileSync(join(value.output, "provenance.json"))).licensingCleared, false);
    assert.deepEqual(JSON.parse(readFileSync(join(value.output, "NOTICE-INVENTORY.json"))).ownedFiles, [{
      path: "PROJECT-LICENSE.txt",
      bytes: projectLicense.length,
      sha256: hash(projectLicense),
    }]);
  } finally { value.cleanup(); }
});

test("rejects a missing or tampered owned project license before output", () => {
  for (const mode of ["missing-manifest-entry", "missing-file", "tampered"]) {
    const value = fixture();
    try {
      if (mode === "missing-manifest-entry") {
        const manifest = JSON.parse(readFileSync(join(value.source, "OWNED-FILE-MANIFEST.json")));
        manifest.files = [];
        writeFileSync(join(value.source, "OWNED-FILE-MANIFEST.json"), JSON.stringify(manifest));
      } else if (mode === "missing-file") {
        rmSync(join(value.source, "replay-controls/PROJECT-LICENSE.txt"));
      } else {
        const tampered = Buffer.from(projectLicense);
        tampered[0] ^= 1;
        writeFileSync(join(value.source, "replay-controls/PROJECT-LICENSE.txt"), tampered);
      }
      assert.throws(() => prepareReplayMediaNotices(value.source, value.provenance, value.output), /project license/i);
      assert.equal(existsSync(value.output), false);
    } finally { value.cleanup(); }
  }
});

test("rejects notice hash drift and a clearance claim before output", () => {
  for (const mode of ["hash", "clearance"]) {
    const value = fixture();
    try {
      if (mode === "hash") writeFileSync(join(value.source, "component-sources/example/LICENSE"), "changed\n");
      else writeFileSync(value.provenance, JSON.stringify({ licensingCleared: true }));
      assert.throws(() => prepareReplayMediaNotices(value.source, value.provenance, value.output));
    } finally { value.cleanup(); }
  }
});
