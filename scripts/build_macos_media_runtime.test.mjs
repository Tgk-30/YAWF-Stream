import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireVerifiedArchive,
  assertAllowedCommand,
  assertNativeArchitecture,
  buildMacosMediaRuntime,
  collectSourceInventory,
  createBuildPlan,
  createSourceBundleManifest,
  loadMediaRuntimeManifest,
  resolveBuildOutputContract,
  verifyBuildInstallPrefix,
  verifyFfmpegBuildConfiguration,
  verifyInstallTree,
  verifyPinnedGitSource,
} from "./build_macos_media_runtime.mjs";

const manifest = loadMediaRuntimeManifest();

function fixture() {
  return mkdtempSync(join(tmpdir(), "yawf-media-runtime-test-"));
}

test("pins the prototype recipe, x264, Git sources, and every resolved submodule", () => {
  assert.equal(
    manifest.upstreamRecipe.commit,
    "ee35579ded3ea95d839d85c2686d96dc505ee344",
  );
  assert.equal(
    manifest.upstreamRecipe.sha256,
    "06155eefcdd4e3372ffa8b9cf11f27a81adb020c2a26b7b39df07466ec3d8368",
  );
  assert.equal(
    manifest.x264.commit,
    "b35605ace3ddf7c1a5d67a2eb553f034aef41d55",
  );
  assert.equal(
    manifest.x264.sha256,
    "6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224",
  );
  assert.deepEqual(
    manifest.gitSources.map(({ name, commit }) => [name, commit]),
    [
      ["libjxl", "332feb17d17311c748445f7ee75c4fb55cc38530"],
      ["libplacebo", "cee9b076f2c63104ccfd497fa79c39a867293ec4"],
    ],
  );
  assert.equal(Object.keys(manifest.gitSources[0].submodules).length, 10);
  assert.equal(Object.keys(manifest.gitSources[1].submodules).length, 6);
  assert.equal(manifest.licensing.cleared, false);
  assert.equal(manifest.licensing.upstreamRecipeRedistribution, "unresolved");
});

test("rejects non-native and non-macOS builds before tools or network are used", async () => {
  const root = fixture();
  let downloads = 0;
  let commands = 0;
  try {
    await assert.rejects(
      buildMacosMediaRuntime({
        workspace: root,
        platform: "darwin",
        hostArch: "arm64",
        requestedArch: "x86_64",
        download: () => {
          downloads += 1;
        },
        runCommand: () => {
          commands += 1;
        },
        runCapture: () => {
          commands += 1;
        },
      }),
      /cross-compilation is not allowed/,
    );
    assert.equal(downloads, 0);
    assert.equal(commands, 0);
    assert.throws(
      () => assertNativeArchitecture({ platform: "linux", hostArch: "arm64" }),
      /only be built on macOS/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a checksum mismatch before a downloaded archive can be reused", () => {
  const root = fixture();
  const destination = join(root, "source.tar.gz");
  const expectedBytes = Buffer.from("expected bytes");
  const source = {
    name: "fixture",
    url: "https://example.invalid/source.tar.gz",
    bytes: expectedBytes.length,
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  };
  let downloads = 0;
  try {
    assert.throws(
      () =>
        acquireVerifiedArchive(source, destination, {
          download: (_url, temporary) => {
            downloads += 1;
            writeFileSync(temporary, Buffer.alloc(expectedBytes.length, 1));
          },
        }),
      /SHA-256 mismatch/,
    );
    assert.equal(downloads, 1);
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reuses a matching verified archive without accessing the network", () => {
  const root = fixture();
  const destination = join(root, "source.tar.gz");
  const bytes = Buffer.from("verified cached source");
  const source = {
    name: "fixture",
    url: "https://example.invalid/source.tar.gz",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  let downloads = 0;
  try {
    writeFileSync(destination, bytes);
    const result = acquireVerifiedArchive(source, destination, {
      download: () => {
        downloads += 1;
      },
    });
    assert.equal(result.reused, true);
    assert.equal(downloads, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plans x264 before FFmpeg with the required programs and no forbidden operations", () => {
  const plan = createBuildPlan(manifest, { arch: "arm64", jobs: 8 });
  assert.deepEqual(plan.packagesBeforeFfmpeg, ["x264"]);
  assert.deepEqual(plan.ffmpegPrograms, {
    ffmpeg: true,
    ffprobe: true,
    ffplay: false,
  });
  assert.deepEqual(plan.ffmpegFlags, [
    "--enable-gpl",
    "--enable-version3",
    "--enable-libx264",
  ]);
  assert.equal(
    plan.verification.executableEncoderSmoke,
    "deferred-until-relocated-staging",
  );
  assert.ok(plan.outputContract.includes("install/arm64/lib/libx264*.dylib"));
  assert.throws(() => assertAllowedCommand("brew", ["install", "nasm"]), /forbidden/);
  assert.throws(() => assertAllowedCommand("vtool", []), /forbidden/);
  assert.throws(() => assertAllowedCommand("codesign", []), /forbidden/);
  assert.throws(
    () => assertAllowedCommand("configure", ["--enable-cross-compile"]),
    /forbidden/,
  );
  assert.throws(
    () => assertAllowedCommand("make", [], { env: { DYLD_LIBRARY_PATH: "/tmp" } }),
    /forbidden/,
  );
});

test("verifies exact Git roots and recursive submodule pins rather than accepting a tag", () => {
  const source = manifest.gitSources[1];
  const status = Object.entries(source.submodules)
    .map(([path, commit]) => ` ${commit} ${path} (pinned)`)
    .join("\n");
  const calls = [];
  const runCapture = (_command, args) => {
    calls.push(args);
    return args.at(-1) === "HEAD" ? source.commit : status;
  };
  verifyPinnedGitSource(source, "/owned/libplacebo", runCapture);
  assert.equal(calls.length, 2);

  assert.throws(
    () =>
      verifyPinnedGitSource(source, "/owned/libplacebo", (_command, args) =>
        args.at(-1) === "HEAD"
          ? "0000000000000000000000000000000000000000"
          : status,
      ),
    /expected cee9b076/,
  );
  const changedSubmodule = status.replace(Object.values(source.submodules)[0], "0000000000000000000000000000000000000000");
  assert.throws(
    () => verifyPinnedGitSource(source, "/owned/libplacebo", (_command, args) => args.at(-1) === "HEAD" ? source.commit : changedSubmodule),
    /is not pinned/,
  );
});

test("inventories component archives and notices while excluding Git metadata", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, "component", ".git"), { recursive: true });
    writeFileSync(join(root, "component.tar.gz"), "archive");
    writeFileSync(join(root, "component", "LICENSE"), "license text");
    writeFileSync(join(root, "component", ".git", "config"), "private checkout metadata");
    writeFileSync(join(root, "component", ".git", "LICENSE"), "private git notice must not be included");
    const inventory = collectSourceInventory(root, manifest);
    assert.deepEqual(inventory.components, ["component"]);
    assert.deepEqual(inventory.archives.map(({ path }) => path), ["component.tar.gz"]);
    assert.deepEqual(inventory.notices.map(({ path }) => path), ["component/LICENSE"]);
    assert.equal(
      JSON.stringify(inventory).includes("private checkout metadata"),
      false,
    );
    assert.equal(inventory.gitSources.length, 2);
    const bundleManifest = createSourceBundleManifest(manifest, inventory);
    assert.equal(bundleManifest.upstreamRecipe.bundled, false);
    assert.equal(bundleManifest.upstreamRecipe.redistributionRights, "unresolved");
    assert.ok(
      bundleManifest.ownedFiles.some(
        ({ path }) => path === "scripts/build_macos_media_runtime.mjs",
      ),
    );
    assert.ok(
      bundleManifest.ownedFiles.some(
        ({ path }) => path === "docs/MACOS_MEDIA_RUNTIME.md",
      ),
    );
    assert.equal(bundleManifest.componentSources, inventory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifies compiled FFmpeg configuration without executing an unrelocated binary", () => {
  const root = fixture();
  const configDirectory = join(root, "build", "ffmpeg", "arm64");
  try {
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(
      join(configDirectory, "config.h"),
      [
        "#define CONFIG_LIBX264 1",
        "#define CONFIG_FFMPEG 1",
        "#define CONFIG_FFPROBE 1",
        "#define CONFIG_FFPLAY 0",
      ].join("\n"),
    );
    const evidence = verifyFfmpegBuildConfiguration(root, "arm64");
    assert.equal(evidence.libx264, true);
    assert.deepEqual(evidence.programs, {
      ffmpeg: true,
      ffprobe: true,
      ffplay: false,
    });
    assert.equal(evidence.executableEncoderSmokeDeferredUntilRelocation, true);

    writeFileSync(
      join(configDirectory, "config.h"),
      "#define CONFIG_LIBX264 0\n#define CONFIG_FFMPEG 1\n#define CONFIG_FFPROBE 1\n#define CONFIG_FFPLAY 0\n",
    );
    assert.throws(
      () => verifyFfmpegBuildConfiguration(root, "arm64"),
      /CONFIG_LIBX264 to 1/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires ffmpeg, ffprobe, shared mpv, and shared x264 while excluding ffplay", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "bin", "ffmpeg"), "fixture");
    writeFileSync(join(root, "bin", "ffprobe"), "fixture");
    writeFileSync(join(root, "lib", "libmpv.2.dylib"), "fixture");
    writeFileSync(join(root, "lib", "libx264.164.dylib"), "fixture");
    const products = verifyInstallTree(root);
    assert.deepEqual(products.mpv, ["lib/libmpv.2.dylib"]);
    assert.deepEqual(products.x264, ["lib/libx264.164.dylib"]);
    rmSync(join(root, "lib", "libx264.164.dylib"));
    assert.throws(() => verifyInstallTree(root), /shared libx264 dylib is missing/);
    writeFileSync(join(root, "lib", "libx264.164.dylib"), "fixture");
    writeFileSync(join(root, "bin", "ffplay"), "fixture");
    assert.throws(() => verifyInstallTree(root), /ffplay must not be installed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns distinct artifact and in-place build prefixes for fresh and reused output", () => {
  const root = fixture();
  const buildInstallPrefix = join(root, "recipe", "install", "arm64");
  const artifactInstallPrefix = join(root, "artifacts", "install", "arm64");
  const bytes = Buffer.from("source-built runtime");
  const installInventory = [
    {
      path: "lib/runtime.dylib",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  ];
  const provenance = {
    architecture: "arm64",
    installPrefix: "install/arm64",
    installInventory,
    sourceBundle: { file: "source.tar.gz" },
  };
  try {
    mkdirSync(join(buildInstallPrefix, "lib"), { recursive: true });
    mkdirSync(artifactInstallPrefix, { recursive: true });
    writeFileSync(join(buildInstallPrefix, "lib", "runtime.dylib"), bytes);

    const fresh = resolveBuildOutputContract(root, provenance);
    const reused = resolveBuildOutputContract(root, provenance, { reused: true });
    assert.equal(fresh.installPrefix, artifactInstallPrefix);
    assert.equal(fresh.buildInstallPrefix, buildInstallPrefix);
    assert.notEqual(fresh.installPrefix, fresh.buildInstallPrefix);
    assert.equal(fresh.reused, false);
    assert.equal(reused.installPrefix, artifactInstallPrefix);
    assert.equal(reused.buildInstallPrefix, buildInstallPrefix);
    assert.equal(reused.reused, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when the original build prefix no longer matches recorded real files", () => {
  const root = fixture();
  const buildInstallPrefix = join(root, "recipe", "install", "arm64");
  const original = Buffer.from("original runtime");
  const installInventory = [
    {
      path: "bin/ffmpeg",
      bytes: original.length,
      sha256: createHash("sha256").update(original).digest("hex"),
    },
  ];
  try {
    mkdirSync(join(buildInstallPrefix, "bin"), { recursive: true });
    writeFileSync(join(buildInstallPrefix, "bin", "ffmpeg"), original);
    assert.equal(
      verifyBuildInstallPrefix(buildInstallPrefix, installInventory),
      buildInstallPrefix,
    );

    writeFileSync(join(buildInstallPrefix, "bin", "ffmpeg"), "tampered runtime");
    assert.throws(
      () => verifyBuildInstallPrefix(buildInstallPrefix, installInventory),
      /file was changed: bin\/ffmpeg/,
    );
    assert.throws(
      () =>
        verifyBuildInstallPrefix(
          join(root, "recipe", "install", "x86_64"),
          installInventory,
        ),
      /original build install prefix is missing/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
