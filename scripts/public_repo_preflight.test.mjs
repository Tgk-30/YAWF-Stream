import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function createFixture() {
  const cwd = await mkdtemp(join(tmpdir(), "yawf-public-preflight-"));
  await mkdir(join(cwd, "scripts"), { recursive: true });
  await Promise.all([
    copyFile(join(root, ".gitignore"), join(cwd, ".gitignore")),
    copyFile(join(root, ".dockerignore"), join(cwd, ".dockerignore")),
    copyFile(
      join(root, "scripts/public_repo_preflight.mjs"),
      join(cwd, "scripts/public_repo_preflight.mjs"),
    ),
    writeFile(join(cwd, "README.md"), "# Public fixture\n"),
  ]);
  git(cwd, ["init", "--quiet"]);
  git(cwd, ["config", "user.name", "Public Preflight Test"]);
  git(cwd, ["config", "user.email", "public-preflight@example.invalid"]);
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "--quiet", "-m", "Initial fixture"]);
  return cwd;
}

function runPreflight(cwd, args = [], env = process.env) {
  return spawnSync(process.execPath, ["scripts/public_repo_preflight.mjs", ...args], {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 30 * 1024 * 1024,
  });
}

function addLargeHeadAndLateForbiddenRef(cwd) {
  const branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const segment = `history-${"x".repeat(166)}`;
  const prefix = Array.from({ length: 12 }, (_, index) => `${index}-${segment}`).join("/");
  const input = [];
  const data = (value) => {
    input.push(`data ${Buffer.byteLength(value)}\n${value}\n`);
  };

  input.push(`commit refs/heads/${branch}\nmark :1\nauthor Public Preflight Test <public-preflight@example.invalid> 1 +0000\ncommitter Public Preflight Test <public-preflight@example.invalid> 1 +0000\n`);
  data("Bulk history beyond the default child-process buffer\n");
  input.push(`from ${head}\n`);
  for (let index = 0; index < 540; index += 1) {
    input.push(`M 100644 inline ${prefix}/entry-${String(index).padStart(4, "0")}.txt\n`);
    data(`bulk-${index}\n`);
  }
  input.push("\ncommit refs/heads/late-forbidden\nmark :2\nauthor Public Preflight Test <public-preflight@example.invalid> 2 +0000\ncommitter Public Preflight Test <public-preflight@example.invalid> 2 +0000\n");
  data("Add a forbidden historical path after the large history\n");
  input.push("from :1\nM 100644 inline AI-WORKFLOW.md\n");
  data("Local-only orchestration instructions\n");
  input.push("\ncommit refs/heads/late-forbidden\nmark :3\nauthor Public Preflight Test <public-preflight@example.invalid> 3 +0000\ncommitter Public Preflight Test <public-preflight@example.invalid> 3 +0000\n");
  data("Remove the forbidden path from the side ref tip\n");
  input.push("from :2\nD AI-WORKFLOW.md\n\ndone\n");

  const imported = spawnSync("git", ["fast-import", "--quiet"], {
    cwd,
    input: input.join(""),
    encoding: "utf8",
  });
  assert.equal(imported.status, 0, imported.stderr);
}

async function withFixture(run) {
  const cwd = await createFixture();
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("accepts a clean public repository", async () => {
  await withFixture(async (cwd) => {
    const result = runPreflight(cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Public repo preflight passed/);
  });
});

test("scans HEAD and all refs beyond one MiB and still finds a late forbidden blob", async () => {
  await withFixture(async (cwd) => {
    addLargeHeadAndLateForbiddenRef(cwd);
    const headObjects = execFileSync("git", ["rev-list", "--objects", "HEAD"], {
      cwd,
      encoding: "buffer",
      maxBuffer: 20 * 1024 * 1024,
    });
    const allObjects = execFileSync("git", ["rev-list", "--objects", "--all"], {
      cwd,
      encoding: "buffer",
      maxBuffer: 20 * 1024 * 1024,
    });
    assert.ok(headObjects.byteLength > 1024 * 1024, `HEAD object list was ${headObjects.byteLength} bytes`);
    assert.ok(allObjects.byteLength > 1024 * 1024, `all-ref object list was ${allObjects.byteLength} bytes`);

    const headResult = runPreflight(cwd);
    assert.equal(headResult.status, 0, headResult.stderr.slice(-4000));
    assert.match(headResult.stdout, /Public repo preflight passed/);

    const allResult = runPreflight(cwd, ["--all-refs"]);
    assert.equal(allResult.status, 1, allResult.stderr.slice(-4000));
    assert.match(allResult.stderr, /Historical assistant instruction file: AI-WORKFLOW\.md/);
    assert.doesNotMatch(allResult.stderr, /ENOBUFS/);
  });
});

test("fails closed instead of truncating git output beyond the bounded cap", async () => {
  await withFixture(async (cwd) => {
    const bin = join(cwd, "fake-bin");
    await mkdir(bin);
    const fakeGit = join(bin, "git");
    await writeFile(
      fakeGit,
      `#!${process.execPath}\nprocess.stdout.write(Buffer.alloc(20 * 1024 * 1024 + 1, 0x61));\n`,
    );
    await chmod(fakeGit, 0o755);

    const result = runPreflight(cwd, [], { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Git command output exceeded 20971520 bytes/);
    assert.doesNotMatch(result.stdout, /Public repo preflight passed/);
  });
});

test("rejects a tracked local planning artifact", async () => {
  await withFixture(async (cwd) => {
    await writeFile(join(cwd, "TARGET.md"), "Local release target\n");
    git(cwd, ["add", "--force", "TARGET.md"]);

    const result = runPreflight(cwd);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Tracked local planning or handoff artifact: TARGET\.md/);
  });
});

test("rejects credential material even when it is force-added", async () => {
  await withFixture(async (cwd) => {
    await writeFile(join(cwd, "release.pem"), "not a real private key\n");
    git(cwd, ["add", "--force", "release.pem"]);

    const result = runPreflight(cwd);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Tracked credential or signing material: release\.pem/);
  });
});

test("rejects provider-shaped tokens without storing one in this repository", async () => {
  await withFixture(async (cwd) => {
    const providerShapedToken = ["ghp", "_", "A".repeat(36)].join("");
    await writeFile(join(cwd, "local-secret.txt"), `${providerShapedToken}\n`);

    const result = runPreflight(cwd);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Possible GitHub token in unignored untracked file: local-secret\.txt/);
    assert.equal(result.stderr.includes(providerShapedToken), false);
  });
});

test("rejects an assistant instruction file removed from the current tree", async () => {
  await withFixture(async (cwd) => {
    await writeFile(join(cwd, "AI-WORKFLOW.md"), "Local-only instructions\n");
    git(cwd, ["add", "--force", "AI-WORKFLOW.md"]);
    git(cwd, ["commit", "--quiet", "-m", "Add local instructions"]);
    git(cwd, ["rm", "--quiet", "AI-WORKFLOW.md"]);
    git(cwd, ["commit", "--quiet", "-m", "Remove local instructions"]);

    const result = runPreflight(cwd);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Historical assistant instruction file: AI-WORKFLOW\.md/);
  });
});
