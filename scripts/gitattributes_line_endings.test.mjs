import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const attributesPath = join(repositoryRoot, ".gitattributes");
const LF_POLICY = "* text=auto eol=lf";
const VENDOR_LFS_RULE =
  "Vendor/VLCKit.xcframework/** filter=lfs diff=lfs merge=lfs -text";
const textFixtures = [
  ".github/workflows/release.yml",
  "scripts/check_release_readiness.mjs",
  "website-app/src/lib/site.ts",
];

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function hasCarriageReturn(bytes) {
  return bytes.includes(0x0d);
}

async function writeFixtureFile(cwd, relativePath, contents) {
  const path = join(cwd, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function withGitFixture(attributes, run) {
  const cwd = await mkdtemp(join(tmpdir(), "yawf-gitattributes-"));
  try {
    git(cwd, ["init", "--quiet", "--initial-branch=main"]);
    git(cwd, ["config", "user.name", "Line Ending Test"]);
    git(cwd, ["config", "user.email", "line-ending-test@example.invalid"]);
    git(cwd, ["config", "core.autocrlf", "true"]);
    await writeFile(join(cwd, ".gitattributes"), attributes);
    await writeFixtureFile(
      cwd,
      textFixtures[0],
      "name: Release\r\non: workflow_dispatch\r\n",
    );
    await writeFixtureFile(
      cwd,
      textFixtures[1],
      "const pattern = /release$/;\n",
    );
    await writeFixtureFile(
      cwd,
      textFixtures[2],
      "export const release = 'current';\r\n",
    );
    const binary = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x41, 0x0d, 0x0a]);
    await writeFile(join(cwd, "fixture.bin"), binary);

    git(cwd, ["add", ".gitattributes", ...textFixtures, "fixture.bin"]);
    git(cwd, ["commit", "--quiet", "-m", "Create line ending fixture"]);
    await run({ cwd, binary });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function assertLfCheckout(attributes) {
  await withGitFixture(attributes, async ({ cwd, binary }) => {
    for (const relativePath of [...textFixtures, "fixture.bin"]) {
      await rm(join(cwd, relativePath));
    }
    git(cwd, ["checkout", "--", ...textFixtures, "fixture.bin"]);

    for (const relativePath of textFixtures) {
      const checkout = await readFile(join(cwd, relativePath));
      assert.equal(
        hasCarriageReturn(checkout),
        false,
        `${relativePath} must check out with LF under core.autocrlf=true`,
      );
      const committed = execFileSync(
        "git",
        ["show", `HEAD:${relativePath}`],
        { cwd },
      );
      assert.equal(
        hasCarriageReturn(committed),
        false,
        `${relativePath} must be normalized to LF in Git`,
      );
    }

    assert.deepEqual(await readFile(join(cwd, "fixture.bin")), binary);
    assert.deepEqual(
      execFileSync("git", ["show", "HEAD:fixture.bin"], { cwd }),
      binary,
    );

    const textAttributes = git(cwd, [
      "check-attr",
      "text",
      "eol",
      "--",
      textFixtures[0],
    ]);
    assert.match(textAttributes, /: text: auto(?:\r?\n|$)/);
    assert.match(textAttributes, /: eol: lf(?:\r?\n|$)/);

    const lfsAttributes = git(cwd, [
      "check-attr",
      "filter",
      "diff",
      "merge",
      "text",
      "--",
      "Vendor/VLCKit.xcframework/fixture.bin",
    ]);
    assert.match(lfsAttributes, /: filter: lfs(?:\r?\n|$)/);
    assert.match(lfsAttributes, /: diff: lfs(?:\r?\n|$)/);
    assert.match(lfsAttributes, /: merge: lfs(?:\r?\n|$)/);
    assert.match(lfsAttributes, /: text: unset(?:\r?\n|$)/);
  });
}

test("repository policy pins text checkouts to LF before the existing LFS override", async () => {
  const attributes = await readFile(attributesPath, "utf8");
  const lines = attributes.trimEnd().split(/\r?\n/);
  assert.equal(lines.filter((line) => line === LF_POLICY).length, 1);
  assert.equal(lines.filter((line) => line === VENDOR_LFS_RULE).length, 1);
  assert.ok(lines.indexOf(LF_POLICY) < lines.indexOf(VENDOR_LFS_RULE));
});

test("LF policy controls Windows-style text checkouts without changing binary or LFS handling", async () => {
  await assertLfCheckout(await readFile(attributesPath, "utf8"));
});

test("the checkout regression returns when the LF policy is removed", async () => {
  const attributes = await readFile(attributesPath, "utf8");
  const withoutLfPolicy = attributes
    .split(/\r?\n/)
    .filter((line) => line !== LF_POLICY)
    .join("\n");
  await assert.rejects(
    assertLfCheckout(withoutLfPolicy),
    /must check out with LF under core\.autocrlf=true/,
  );
});
