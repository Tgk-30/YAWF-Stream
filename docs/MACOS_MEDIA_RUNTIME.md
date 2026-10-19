# macOS 11 media runtime build

This recipe compiles a native, single-architecture libmpv, FFmpeg, ffprobe, and
their media dependencies for macOS 11.0. It does not rewrite Mach-O deployment
metadata, cross-compile, sign code, install Homebrew packages, or change the
application's release floor.

## Inputs and boundary

- The upstream recipe is the official `iina/deps-buildscripts` archive at
  commit `ee35579ded3ea95d839d85c2686d96dc505ee344`. Its URL, exact byte count,
  and observed SHA-256 are in `scripts/macos-media-runtime/manifest.json`.
- The deterministic patch sets `MACOSX_DEPLOYMENT_TARGET=11.0`, defaults to
  eight jobs, permits an explicit bounded job override, enables `ffmpeg` and
  `ffprobe`, disables `ffplay`, preserves GPL and version 3 configuration, and
  enables libx264.
- x264 is compiled as a shared library before FFmpeg from official VideoLAN
  commit `b35605ace3ddf7c1a5d67a2eb553f034aef41d55`.
- The two Git-only components and every recursively acquired submodule are
  checked against the exact commits in the manifest before any build begins.
- The upstream recipe repository has no top-level license at the pinned commit.
  Recipe redistribution rights remain unresolved. The generated component
  source bundle therefore contains our manifest, patch, x264 build addition,
  instructions, and acquired component sources and notices, but does not
  republish the upstream recipe tree or archive.

The ARM prototype completed 32 packages in 11 minutes 23 seconds and found 57
original Mach-O files with a macOS 11.0 minimum. It also passed an owned TLS 1.3
fixture. That is source-build evidence on the prototype host, not proof that the
runtime works on macOS 11 hardware. Intel has not been built or executed.

## Prerequisites

Run on macOS on the architecture being built. Supported native architectures
are `arm64` and `x86_64`. The driver rejects cross-compilation. It checks for
the recipe's compiler and build tools, including clang, Xcode `xcrun`, Meson,
Ninja, NASM, CMake, pkg-config, Autoconf tooling, Git, curl, and tar. It never
installs missing tools.

Use a dedicated caller-owned cache parent. The driver creates and mutates only
an identity-named child with its own marker:

```sh
node scripts/build_macos_media_runtime.mjs \
  --workspace /absolute/path/to/owned-media-runtime-cache \
  --arch "$(uname -m)" \
  --jobs 8
```

The job override must be between 1 and 16. A completed matching identity is
verified from `SHA256SUMS` and reused. A mismatched or unmarked existing child
is rejected instead of being removed. Cached archives are accepted only when
their credential-free HTTPS source, expected size, and SHA-256 match.

## Outputs and integration contract

The command prints JSON containing the owned build root and two intentionally
different installation paths:

- `buildInstallPrefix` is the private, ephemeral
  `<owned-root>/recipe/install/<arch>` source-build prefix. The relocation
  stage must consume this path in place. Source-built absolute library aliases
  and Mach-O dependency paths still refer to this original prefix before
  relocation.
- `installPrefix` is the copied `<owned-root>/artifacts/install/<arch>` tree.
  It is an unrelocated artifact and evidence archive only. Its copied absolute
  symlinks can still point back to the original source-build prefix, so a
  strict relocation stage must not use this copy as its input.

The artifact directory contains:

- `install/<arch>/`: the unrelocated copy described above, retained for
  inventory and source-build evidence rather than as relocation input.
- `provenance.json`: pins, build plan, acquired archive evidence, full install
  inventory, the relative installation prefix, compiled FFmpeg configuration,
  component-source inventory, license-notice inventory, and explicit false
  values for signing, deployment-minimum rewriting, and DYLD use.
- `yawf-macos-media-runtime-source-<identity>.tar.gz`: acquired component
  source archives and exact Git source trees without `.git`, compiled output,
  build directories, or temporary files. It includes license notices,
  checksums, a source-bundle manifest, this driver and document, the manifest,
  patch, and x264 build addition. Repository-relative paths are preserved.
- `SHA256SUMS`: hashes for every distributable file in the artifact directory.

Root integration must relocate the dylib closure, verify every Mach-O slice
against the application floor, package it, and perform authorized release
signing separately. It should relocate `buildInstallPrefix` in place, then
copy only the root stager's validated output into the distributable runtime.
Do not set `DYLD_LIBRARY_PATH` or similar variables for final packaging. The
unrelocated FFmpeg executable is not run by this driver:
its source-prefix libraries may use `@rpath` without an executable `LC_RPATH`.
The driver instead verifies the generated FFmpeg `config.h` enables libx264,
ffmpeg, and ffprobe while disabling ffplay. After relocation, integration must
execute FFmpeg without a DYLD override and confirm it lists the `libx264`
encoder, then run media, TLS, seek, subtitle, and macOS 11 hardware validation
before claiming support.

For a completed cache hit, the driver verifies every regular file in the
original `buildInstallPrefix` against the recorded artifact `installInventory`
before returning either path. A missing, already relocated, or otherwise
changed original prefix fails closed instead of silently rebuilding or using
the artifact copy. Symlinks are intentionally not followed or hashed as real
files; strict alias and relocation policy remains the root stager's job.

## Distribution risks

FFmpeg remains GPL/version 3 with libx264 enabled. Component source and license
obligations are deliberately preserved in the generated source bundle. The
workflow does not claim licensing clearance, and the unresolved upstream recipe
redistribution question remains a release decision. No output is uploaded or
published by this script.
