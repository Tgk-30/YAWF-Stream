# macOS media runtime source notices

This directory describes a build recipe. It does not grant additional rights
beyond each component's own license.

- The recipe is pinned to `iina/deps-buildscripts` commit
  `ee35579ded3ea95d839d85c2686d96dc505ee344`.
- x264 is pinned to VideoLAN commit
  `b35605ace3ddf7c1a5d67a2eb553f034aef41d55`. Its `COPYING` file is included
  in the corresponding-source archive produced by the build.
- FFmpeg remains configured with `--enable-gpl --enable-version3` and now also
  `--enable-libx264`. Distribution must comply with the resulting GPL terms.
- Every downloaded or checked-out component remains accompanied by the
  license, copying, notice, copyright, and authors files present in its source
  tree. The generated provenance lists their paths and SHA-256 hashes.
- The corresponding-source archive contains the verified component source
  archives, exact component Git checkouts with submodules, our patch and x264
  build addition, this notice, build instructions, and checksums. It excludes
  compiled output, temporary files, and `.git` metadata.
- The upstream recipe repository has no top-level license in the pinned tree.
  Its redistribution rights are unresolved, so the source bundle does not
  republish that recipe tree or archive. It instead records the exact official
  acquisition URL, commit, size, and SHA-256 plus the patch applied locally.

The archive SHA-256 values for the IINA recipe and x264 are observed digests of
the pinned official HTTPS archives. They are not upstream signatures. This
workflow does not claim that licensing is cleared for distribution.
