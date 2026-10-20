# Independent macOS media source replay controller

This is a technical replay prototype. It is not a licensing clearance or a release authorization.

The controller builds only from a previously extracted YAWF corresponding-source bundle. Its commands contain no download step, it disables build-system dependency fallback, and it does not execute the omitted upstream recipe controls, sign artifacts, package an app, or modify another build cache. Empty proxy variables and command-string validation are defense in depth, not operating-system network isolation. An eventual replay must also run inside a separately reviewed OS-level network-denied environment. The 33-package plan was transcribed from generated configuration receipts in the completed 2026-10-18 arm64 build: `config.status`, `CMakeCache.txt`, Meson `cmd_line.txt`, OpenSSL `configdata.pm`, FFmpeg/x264 `config.mak`, and the build log.

## Inputs

- An extracted source bundle directory containing `component-sources/`, `SOURCE-INVENTORY.json`, and `SHA256SUMS`.
- A new empty caller-owned output directory.
- A native macOS host matching `arm64` or `x86_64`.
- Xcode command-line tools and explicit build-tool paths for CMake, Meson, Ninja, pkg-config, Autoconf, Automake, Libtool, Perl, Python, Make, and NASM where required.

The source verifier checks the complete checksum inventory, the exact 33 source directories, normalized paths, and symlink containment before copying source trees. It copies the extracted patched trees, including pinned submodule contents, instead of re-extracting original archives.

## Normalize the pinned source archive

`normalize_source_archive.py` accepts only the SHA-256 pinned in `archive-normalizer-plan.json`. It streams the archive without extracting it, rejects duplicate or escaping paths, hardlinks, special files, unknown link targets, and configured size/count overruns. Absolute links are changed only when their targets are beneath the exact recorded runner-owned `recipe/sources` prefix and the equivalent target exists inside `component-sources`. All other links are rejected. PAX `linkpath` metadata is removed when a link is transformed so it cannot override the contained relative target.

The new archive preserves every original regular member byte except the intentionally regenerated `SHA256SUMS`. It adds `NORMALIZATION-PROVENANCE.json`, `OWNED-FILE-MANIFEST.json`, the independent replay controls, the exact canonical runtime-output inventory, and the owned source, confinement, relocation, notice, minimum and smoke controls used by the shipping producer. The original source manifest remains present and continues to state that licensing is not cleared.

```sh
python3 normalize_source_archive.py \
  --input /path/to/pinned-original.tar.gz \
  --output /new/path/normalized.tar.gz \
  --project-root /path/to/DebridStreamer \
  --reference-source-root /path/to/original/recipe/sources
```

The output must not already exist. This is an additive post-build source transformation. It does not modify the binary build cache or establish legal clearance.

## Review without building

```sh
controller=/path/to/controller
source_bundle=/path/to/yawf-macos-media-runtime-source
output=/path/to/new-empty-output

node "$controller/replay_macos_media_sources.mjs" verify \
  --source-root "$source_bundle"

node "$controller/replay_macos_media_sources.mjs" init \
  --output-root "$output"

node "$controller/replay_macos_media_sources.mjs" commands \
  --source-root "$source_bundle" \
  --output-root "$output" \
  --arch arm64 \
  --jobs 8 \
  --sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  --tool-path '/explicit/build/tools:/usr/bin:/bin:/usr/sbin:/sbin'
```

`commands` creates one marked child and writes `COMMANDS.json`; it does not execute the commands. The child is never deleted or reused. Use a newly initialized output root for another review or build.

## Build, only after review authorization

Replace `commands` with `build` using a fresh initialized output root. The controller builds sequentially in the recorded order, limits package-level parallelism to 1 through 16 jobs, checks each expected product, and retains `STATUS.json` on success or failure. Before and after each package install, it inventories every regular Mach-O file in the owned prefix by content hash. Every new or changed Mach-O, including one outside the 57 required product paths, must be single-architecture for the selected native target, declare a macOS 11.0 minimum, and have no Homebrew or `/usr/local` dependency. A package may not remove an earlier Mach-O or satisfy its required products with stale outputs. The per-package diff is retained in `INSTALL-AUDIT.json`.

The environment limits pkg-config, CMake, and Meson package discovery to the replay prefix and selected SDK, disables dependency fallback/download behavior, clears proxy and ambient include/library variables, and propagates the macOS 11 target. CMake receives an explicit find root containing only the owned prefix and SDK. Meson receives the owned prefix in both setup arguments and its machine file. System SDK frameworks remain permitted. These controls do not replace the required OS-level network-denial wrapper.

The focused checks configure, but do not build, a minimal CMake probe that must find a library under the owned prefix and must not find one under a simulated host package-manager prefix. They also validate that the pinned LuaJIT top-level and `src/Makefile` route command-line `CFLAGS`, `LDFLAGS`, `TARGET_CFLAGS`, and `TARGET_LDFLAGS` into their compile and link option variables before replay commands are emitted.

Before any configured CMake, Meson, OpenSSL, FFmpeg, or x264 package advances to compilation, the replay checks its generated configuration receipt. Requested options, prefix, architecture, SDK, macOS 11 target, FFmpeg program and feature macros, x264 shared-only selection, and mpv selections must be present. OpenSSL `configdata.pm` must retain the owned prefix, native Darwin target, shared-library mode, SDK, architecture, and macOS 11 compiler and linker flags. Expected outputs are exact regular-file paths for the 55 canonical staged dylibs plus `ffmpeg` and `ffprobe`; globs and symlink-only substitutes are rejected.

## Focused tests

```sh
node --test "$controller/replay_macos_media_sources.test.mjs"
python3 -m unittest -v "$controller/normalize_source_archive_test.py"
```

The focused tests above do not establish a full native replay. Actual native
ARM and Intel replay results must be recorded separately.

## Unsigned shipping producer

`scripts/ci/produce_macos_media_runtime.py` first creates one content-addressed
normalized archive from the exact transport pinned by `shipping-source-pins.json`.
The transport is retained in a dedicated unpublished source-seed release, not an
expiring Actions artifact. Release and asset IDs, repository, draft state, target,
size and SHA-256 are verified before preparation. Historical Actions provenance
is retained but is never used as a fallback download.
Both native architecture jobs consume those same bytes. The producer safely
admits the archive, executes the controller bundled inside it, and derives the
only staging prefix as `replay-<arch>-macos11/install/<arch>` inside a new marked
output. The controller, relocation, minimum check, natural smoke and notice copy
run under one network-denied and exact-child-write sandbox profile.

The raw prefix may contain audited build helpers. The stager retains the exact
55 canonical top-level dylibs, including libraries not reachable from its three
root executables, plus `ffmpeg` and `ffprobe`. Other raw-prefix programs are not
shipped. The producer verifies this exact 57-file binary contract before it
creates an unsigned transport. Every raw-prefix regular file is hashed in the
install inventory and every Mach-O is accounted for by the controller audit.
Developer ID signing, notarization and publication remain separate release
steps.
