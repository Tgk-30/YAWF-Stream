#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/common.sh"

DEP_NAME="x264"
VERSION="${X264_COMMIT}"
TARBALL="${DEP_NAME}-${VERSION}.tar.bz2"
SRC_DIR="${SOURCES_DIR}/${DEP_NAME}-${VERSION}"

build_for_arch() {
    local arch="$1"
    local prefix build_dir
    prefix="$(get_prefix "$arch")"
    build_dir="$(get_build_dir "$DEP_NAME" "$arch")"

    log_step "=== ${DEP_NAME} ${VERSION} - ${arch} ==="
    setup_arch_env "$arch"

    rm -rf "$build_dir"
    mkdir -p "$build_dir"
    cd "$build_dir"

    "${SRC_DIR}/configure" \
        --prefix="$prefix" \
        --host="$HOST_TRIPLE" \
        --enable-shared \
        --disable-static \
        --disable-cli \
        --extra-cflags="$CFLAGS" \
        --extra-ldflags="$LDFLAGS"

    make -j"$JOBS"
    make install
}

download_and_verify "$X264_URL" "$X264_SHA256" "$TARBALL"
extract_source "$TARBALL" "${DEP_NAME}-${VERSION}"

for arch in $ARCHS; do build_for_arch "$arch"; done
