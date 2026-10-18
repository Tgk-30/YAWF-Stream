#!/usr/bin/env bash
# Collect libmpv + its FULL non-system dependency tree (ffmpeg, libass, libplacebo,
# luajit, …) into an output dir, relocated so every dylib references its siblings
# via @rpath. The app is then linked against the relocated libmpv (whose id is
# @rpath/libmpv.2.dylib) and carries an rpath of @executable_path/../Frameworks
# (see build.rs), so on a clean Mac it loads these bundled copies - no Homebrew.
#
# Usage:  bundle-mpv-deps.sh <path-to-libmpv.2.dylib> <output-dir>
# CI runs this per-arch before the Tauri build, then points bundle.macOS.frameworks
# at <output-dir> and MPV_LIB_DIR at it (so the app links the relocated libmpv).
#
# Signing: dylibs are ad-hoc signed here so they load locally; CI re-signs the
# whole .app (Frameworks included) with the Developer ID during the Tauri build.
set -euo pipefail

LIBMPV="${1:?usage: bundle-mpv-deps.sh <libmpv.2.dylib> <out-dir>}"
OUT="${2:?usage: bundle-mpv-deps.sh <libmpv.2.dylib> <out-dir>}"
mkdir -p "$OUT"

# Preserve every original deployment minimum. Changing a load command does not
# make newer symbols or runtime behavior compatible with an older macOS release.
# The final application bundle must pass check_macos_bundle_minimum.mjs before
# release; replace or rebuild incompatible inputs rather than rewriting minos.

realpath_f() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }
# Non-system, relocatable deps of a dylib (Homebrew arm64 or Intel prefixes).
deps_of() { otool -L "$1" | awk 'NR>1{print $1}' | grep -E '^/opt/homebrew/|^/usr/local/' || true; }

# ---- 1. BFS the transitive dependency set (by resolved real path) -------------
# Keep this bash-3.2 compatible: macOS's system bash - and the CI mac runners'
# default `/usr/bin/env bash` - is 3.2, which has no `declare -A`. Track seen
# basenames in a newline-delimited string set instead of an associative array.
LF=$'\n'
seen="$LF"
queue=("$(realpath_f "$LIBMPV")")
files=()
while [ ${#queue[@]} -gt 0 ]; do
  cur="${queue[0]}"; queue=("${queue[@]:1}")
  [ -f "$cur" ] || continue
  real="$(realpath_f "$cur")"
  name="$(basename "$real")"
  case "$seen" in *"$LF$name$LF"*) continue ;; esac
  seen="$seen$name$LF"
  files+=("$real")
  while read -r dep; do queue+=("$(realpath_f "$dep")"); done < <(deps_of "$real")
done

# ---- 2. Copy every dylib flat into OUT (writable) -----------------------------
for real in "${files[@]}"; do
  cp -fL "$real" "$OUT/$(basename "$real")"
  chmod u+w "$OUT/$(basename "$real")"
done

# ---- 3. Relocate install names: id -> @rpath/name, deps -> @rpath/dep ---------
for real in "${files[@]}"; do
  f="$OUT/$(basename "$real")"
  install_name_tool -id "@rpath/$(basename "$real")" "$f"
  while read -r dep; do
    install_name_tool -change "$dep" "@rpath/$(basename "$(realpath_f "$dep")")" "$f" 2>/dev/null || true
  done < <(deps_of "$real")
  codesign --force --sign - "$f"
done

# ---- 4. Unversioned symlink so the linker's `-lmpv` finds it (link-time only;
#         at runtime the app references @rpath/libmpv.2.dylib directly) ---------
mpv_versioned="$(basename "$(realpath_f "$LIBMPV")")"
( cd "$OUT" && ln -sf "$mpv_versioned" libmpv.dylib )

echo "bundled ${#files[@]} dylibs into $OUT (+ libmpv.dylib link)"
ls "$OUT" | sed 's/^/  /'
