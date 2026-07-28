fn main() {
    // A build script is compiled for the HOST, so `#[cfg(target_os = ...)]` here
    // describes the machine doing the building, not the machine being built for.
    // Cross-compiling from macOS to Android used to emit the OpenGL framework
    // link and fail with "library kind `framework` is only supported on Apple
    // targets". Cargo passes the real target through CARGO_CFG_TARGET_OS.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    // libmpv2-sys emits `cargo:rustc-link-lib=mpv` but no search path, so the
    // linker can't find libmpv on its own. Point it at the system/Homebrew mpv
    // (dev) or the CI-fetched copy. At runtime the bundled dylib is used instead
    // (see render_player.rs / Stage 4 packaging) - this is link-time only.
    if target_os == "macos" {
        emit_mpv_link_search();
        // CGL functions (CGLChoosePixelFormat/CGLLockContext/…) used by the
        // CAOpenGLLayer video surface live in the OpenGL framework.
        println!("cargo:rustc-link-lib=framework=OpenGL");
        // Tauri's macOS framework bundler adds the runtime search path for
        // Contents/Frameworks. Adding the same path here produces a duplicate
        // linker warning in release packages. Development links Homebrew's
        // absolute libmpv path and does not need a bundle rpath.
    }

    // Windows: libmpv2-sys emits `cargo:rustc-link-lib=mpv`, so the MSVC linker
    // needs `mpv.lib` on its search path. CI generates that import lib from the
    // shinchiro mpv-dev package's mpv.def and points MPV_LIB_DIR (or MPV_SOURCE)
    // at the folder holding it. At runtime the bundled `libmpv-2.dll` (shipped
    // next to the exe) is loaded.
    if target_os == "windows" {
        println!("cargo:rerun-if-env-changed=MPV_LIB_DIR");
        println!("cargo:rerun-if-env-changed=MPV_SOURCE");
        for var in ["MPV_LIB_DIR", "MPV_SOURCE"] {
            if let Ok(dir) = std::env::var(var) {
                if !dir.is_empty() {
                    println!("cargo:rustc-link-search=native={dir}");
                    break;
                }
            }
        }
        // Delay-load libmpv-2.dll so the exe LAUNCHES even when the DLL isn't on
        // the loader's search path (it ships in resources/lib, not next to the
        // exe). `preload_bundled_libmpv()` in lib.rs LoadLibrary's it by full path
        // before the first mpv call, so the delay-load stub then binds to it. The
        // delay-load helper `__delayLoadHelper2` lives in delayimp.lib.
        println!("cargo:rustc-link-lib=delayimp");
        println!("cargo:rustc-link-arg=/DELAYLOAD:libmpv-2.dll");
    }

    // Linux: `libmpv-dev` puts libmpv.so on the default linker path (usually
    // /usr/lib/<triple>), so `-lmpv` resolves without help - but pin the exact
    // libdir via pkg-config when available so an out-of-tree mpv (e.g. a PPA or a
    // bundled tree pointed at by MPV_LIB_DIR) is found too.
    if target_os == "linux" {
        println!("cargo:rerun-if-env-changed=MPV_LIB_DIR");
        if let Ok(dir) = std::env::var("MPV_LIB_DIR") {
            if !dir.is_empty() {
                println!("cargo:rustc-link-search=native={dir}");
            }
        } else if let Ok(out) = std::process::Command::new("pkg-config")
            .args(["--variable=libdir", "mpv"])
            .output()
        {
            if out.status.success() {
                let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !dir.is_empty() {
                    println!("cargo:rustc-link-search=native={dir}");
                }
            }
        }
    }

    tauri_build::build()
}

fn emit_mpv_link_search() {
    use std::path::Path;

    println!("cargo:rerun-if-env-changed=MPV_LIB_DIR");

    // 1. Explicit override (CI can point straight at the fetched dylib dir).
    if let Ok(dir) = std::env::var("MPV_LIB_DIR") {
        if !dir.is_empty() {
            println!("cargo:rustc-link-search=native={dir}");
            return;
        }
    }

    // 2. pkg-config knows the exact libdir when mpv.pc is discoverable.
    if let Ok(out) = std::process::Command::new("pkg-config")
        .args(["--variable=libdir", "mpv"])
        .output()
    {
        if out.status.success() {
            let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !dir.is_empty() && Path::new(&dir).exists() {
                println!("cargo:rustc-link-search=native={dir}");
                return;
            }
        }
    }

    // 3. Common Homebrew prefixes (arm64 / x86_64).
    for dir in ["/opt/homebrew/lib", "/usr/local/lib"] {
        if Path::new(dir).join("libmpv.dylib").exists()
            || Path::new(dir).join("libmpv.2.dylib").exists()
        {
            println!("cargo:rustc-link-search=native={dir}");
            return;
        }
    }

    println!("cargo:warning=libmpv link path not found; set MPV_LIB_DIR or `brew install mpv`");
}
