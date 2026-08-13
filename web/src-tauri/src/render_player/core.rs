// Shared, PLATFORM-AGNOSTIC core of the in-window mpv player.
//
// Everything here is free of `#[cfg]` and identical on every OS: the mpv handle,
// the event loop that forwards property changes to the webview, property/command
// marshalling, the Tauri command surface, and the `VideoSurface` trait that is the
// ONLY platform-specific seam. Each OS provides a `surface_*.rs` that implements
// `VideoSurface` + an `attach_surface()` constructor; `mod.rs` selects one by cfg.
//
// The mpv lifecycle logic was lifted verbatim from the original macOS-only
// `render_player.rs` - see `surface_macos.rs` for the macOS render surface.

use std::collections::HashMap;
use std::ffi::{c_void, CStr};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use libmpv2::{Format, Mpv};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow, Window};

#[cfg(test)]
use crate::playback_auth::{
    cloudflare_access_cookie_header, cookie_path_matches, same_http_origin,
    MAX_ACCESS_COOKIE_VALUE_BYTES,
};
use crate::playback_auth::{
    cloudflare_access_cookie_header_for_stream, legacy_playback_for_window,
    validate_stream_authorization,
};

/// Trace log, OFF unless `DS_MPV_DEBUG` is set. GUI-app stderr is unreliable under
/// `tauri dev`, so when enabled this appends to a file. Shared by core + surfaces.
pub(crate) fn rp_debug_enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("DS_MPV_DEBUG").is_some())
}

pub(crate) fn rp_log(msg: &str) {
    use std::io::Write;
    if !rp_debug_enabled() {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/ds-rp-debug.log")
    {
        let _ = writeln!(f, "{msg}");
    }
}

/// The ONE platform-specific seam. A surface owns the native video rendering
/// (macOS: CAOpenGLLayer render API; Windows: a wid-embedded child HWND; Linux: a
/// wid-embedded X11 child window) and composites it with the app window. The mpv
/// handle is shared; a render-API surface binds an `mpv_render_context` to it,
/// while a wid surface just hands mpv a native window handle.
///
/// Object-safe (no `attach` here); construction is the cfg-selected free function
/// `attach_surface()`, so `Player` can hold an `Arc<dyn VideoSurface>` shared with
/// the mpv event thread.
pub trait VideoSurface: Send + Sync {
    /// Keep the video rect synced to the app layout, in BACKING pixels. A no-op on
    /// macOS (the surface autoresizes with the window) and on the wid-embed
    /// surfaces for now (mpv fills the wid window); the future refinement is a
    /// DOM-rect child reposition (SetWindowPos / XConfigureWindow).
    fn set_rect(&self, x: i32, y: i32, w: i32, h: i32);

    /// A new file is about to replace the current one. Render surfaces that own
    /// native window geometry use this to discard the prior video's aspect until
    /// mpv publishes the new dwidth/dheight pair.
    fn video_file_started(&self) {}

    /// mpv's aspect-corrected display dimensions changed. macOS uses this to wrap
    /// the NSWindow content area around the video; wid-based surfaces do nothing.
    fn video_dimensions_changed(&self, _width: i64, _height: i64) {}

    /// Playback reached EOF (or otherwise ended). Native window constraints and
    /// session-owned window geometry must be restored by the platform surface.
    fn video_playback_ended(&self) {}

    /// ORDERED teardown - the single most bug-prone invariant. Each surface MUST:
    /// stop its redraws, free any `mpv_render_context` (or DestroyWindow) BEFORE
    /// the shared `Arc<Mpv>` drops and destroys mpv (freeing a render context after
    /// mpv is destroyed is a use-after-free = the historical "back button crash"),
    /// and detach the native view on the UI thread. Must be idempotent.
    fn detach(&self);
}

/// A live in-window player: shared mpv + a platform surface + the event thread.
pub struct Player {
    pub(crate) mpv: Arc<Mpv>,
    surface: Arc<dyn VideoSurface>,
    event_stop: Arc<AtomicBool>,
    event_thread: Option<JoinHandle<()>>,
    legacy_proxy_lease: Option<crate::playback_proxy::ProxyLease>,
    subtitle_dir: Option<PathBuf>,
    shutdown_started: bool,
}

impl Player {
    /// Stop the event thread, then tear the surface down. The surface's `detach`
    /// owns the ordered render-context-before-mpv teardown; `self.mpv` drops after.
    fn shutdown(&mut self) {
        if std::mem::replace(&mut self.shutdown_started, true) {
            return;
        }
        self.event_stop.store(true, Ordering::Release);
        // The event thread blocks indefinitely in mpv_wait_event while quiet.
        // mpv_wakeup is the matching thread-safe interrupt and prevents shutdown
        // from depending on a periodic polling timeout.
        unsafe { libmpv2_sys::mpv_wakeup(self.mpv.ctx.as_ptr()) };
        if let Some(t) = self.event_thread.take() {
            let _ = t.join();
        }
        if let Some(dir) = self.subtitle_dir.take() {
            // Detach external subtitle tracks before removing their private
            // temporary files. This is required on Windows, where mpv may keep
            // an open file handle while the track is attached.
            let _ = self.mpv.command("sub-remove", &["all"]);
            let _ = fs::remove_dir_all(dir);
        }
        self.surface.detach();
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// One property to observe (from the JS `MpvConfig.observedProperties`).
#[derive(Deserialize)]
pub struct ObserveSpec {
    pub name: String,
    /// "flag" | "double" | "int64" | "string"
    pub format: String,
}

/// Tauri-managed: at most one in-window player at a time.
#[derive(Default)]
pub struct PlayerState(pub std::sync::Mutex<Option<Player>>, std::sync::Mutex<()>);

// ---- mpv event loop → webview events ------------------------------------
// Uses raw libmpv2-sys `mpv_wait_event` (libmpv2's safe wrapper panics on a
// MPV_FORMAT_NONE property change, which happens routinely when a property
// becomes unavailable). Emits `player-event` = { name, data } to the webview.
fn spawn_event_thread<R: Runtime>(
    app: AppHandle<R>,
    mpv: Arc<Mpv>,
    mut observed: Vec<ObserveSpec>,
    stop: Arc<AtomicBool>,
    surface: Arc<dyn VideoSurface>,
) -> JoinHandle<()> {
    // Window wrapping is Rust-owned and must not depend on which diagnostics the
    // frontend happens to request. Keep these observations internal-by-default;
    // duplicate names are avoided when the frontend already requested them.
    for (name, format) in [
        ("dwidth", "int64"),
        ("dheight", "int64"),
        ("eof-reached", "flag"),
    ] {
        if !observed.iter().any(|spec| spec.name == name) {
            observed.push(ObserveSpec {
                name: name.to_string(),
                format: format.to_string(),
            });
        }
    }

    std::thread::spawn(move || {
        // The primary handle already has its own event queue and libmpv's client
        // API is thread-safe. Do NOT create a secondary client here: libmpv2 5.0.3
        // wraps a possibly-null mpv_create_client result with NonNull::new_unchecked,
        // which aborts the process under a rapid create/destroy race instead of
        // returning an error.
        if stop.load(Ordering::Acquire) {
            return;
        }
        for (i, spec) in observed.iter().enumerate() {
            let fmt = match spec.format.as_str() {
                "flag" => Format::Flag,
                "double" => Format::Double,
                "int64" => Format::Int64,
                _ => Format::String,
            };
            let _ = mpv.observe_property(&spec.name, fmt, i as u64);
        }
        let ctx = mpv.ctx.as_ptr();
        let mut display_width: Option<i64> = None;
        let mut display_height: Option<i64> = None;
        let mut last_hot_emit: HashMap<String, Instant> = HashMap::new();
        const HOT_PROPERTY_INTERVAL: Duration = Duration::from_millis(200);
        while !stop.load(Ordering::Acquire) {
            let mut pending_properties: HashMap<String, Value> = HashMap::new();
            // Sleep until libmpv has an event. Player::shutdown calls mpv_wakeup
            // after setting `stop`, so this has no teardown-latency tradeoff.
            let mut wait_seconds = -1.0;
            let mut shutdown = false;
            loop {
                let ev = unsafe { &*libmpv2_sys::mpv_wait_event(ctx, wait_seconds) };
                match ev.event_id {
                    libmpv2_sys::mpv_event_id_MPV_EVENT_NONE => {}
                    libmpv2_sys::mpv_event_id_MPV_EVENT_SHUTDOWN => shutdown = true,
                    libmpv2_sys::mpv_event_id_MPV_EVENT_START_FILE => {
                        display_width = None;
                        display_height = None;
                        surface.video_file_started();
                        rp_log("RPGEO event=file-start engine=native-mpv dwidth=? dheight=?");
                    }
                    libmpv2_sys::mpv_event_id_MPV_EVENT_END_FILE => {
                        let ef = unsafe { &*(ev.data as *mut libmpv2_sys::mpv_event_end_file) };
                        surface.video_playback_ended();
                        rp_log(&format!(
                            "event thread: END_FILE reason={} error={}",
                            ef.reason, ef.error
                        ));
                        // mpv_end_file_reason (stable public ABI): EOF=0, STOP=2,
                        // QUIT=3, ERROR=4, REDIRECT=5. Only ERROR is a genuine playback
                        // FAILURE - a file `loadfile` ACCEPTED but that then failed to
                        // demux/decode (corrupt data, or a codec this build can't
                        // handle). `loadfile` returns success in that case and the
                        // decode error surfaces only here, asynchronously, so this is
                        // the sole signal the webview gets to fall back to the HLS
                        // transcode. EOF/stop/quit/redirect are normal and are never
                        // forwarded (a forwarded EOF would tear down the end card).
                        // Widen to i64 before comparing: `reason` is a bindgen enum
                        // alias whose primitive type (c_int vs c_uint) we don't pin
                        // here, and i64 fits either without a lint-flagged narrowing.
                        const MPV_END_FILE_REASON_ERROR: i64 = 4;
                        if ef.reason as i64 == MPV_END_FILE_REASON_ERROR {
                            let _ = app.emit(
                                "player-event",
                                json!({
                                    "name": "end-file",
                                    "data": { "error": true, "code": ef.error as i64 }
                                }),
                            );
                        }
                        rp_log(&format!(
                            "RPGEO event=file-end engine=native-mpv dwidth={} dheight={}",
                            display_width
                                .map(|v| v.to_string())
                                .unwrap_or_else(|| "?".to_string()),
                            display_height
                                .map(|v| v.to_string())
                                .unwrap_or_else(|| "?".to_string())
                        ));
                    }
                    libmpv2_sys::mpv_event_id_MPV_EVENT_PROPERTY_CHANGE => {
                        let prop = unsafe { &*(ev.data as *mut libmpv2_sys::mpv_event_property) };
                        if prop.name.is_null() {
                            wait_seconds = 0.0;
                            continue;
                        }
                        let name = unsafe { CStr::from_ptr(prop.name) }
                            .to_string_lossy()
                            .into_owned();
                        let data = unsafe { prop_data_to_json(prop.format, prop.data) };
                        let dimension_changed = match name.as_str() {
                            "dwidth" => {
                                display_width = data.as_i64().filter(|v| *v > 0);
                                true
                            }
                            "dheight" => {
                                display_height = data.as_i64().filter(|v| *v > 0);
                                true
                            }
                            _ => false,
                        };
                        if dimension_changed {
                            rp_log(&format!(
                                "RPGEO event=mpv-display-property engine=native-mpv property={name} dwidth={} dheight={}",
                                display_width
                                    .map(|v| v.to_string())
                                    .unwrap_or_else(|| "?".to_string()),
                                display_height
                                    .map(|v| v.to_string())
                                    .unwrap_or_else(|| "?".to_string())
                            ));
                            if let (Some(width), Some(height)) = (display_width, display_height) {
                                surface.video_dimensions_changed(width, height);
                            }
                        } else if name == "eof-reached" {
                            if data == Value::Bool(true) {
                                surface.video_playback_ended();
                            } else if data == Value::Bool(false) {
                                // Replay after keep-open does not necessarily emit a
                                // fresh START_FILE/dwidth pair. Re-apply the retained
                                // dimensions when EOF clears.
                                if let (Some(width), Some(height)) = (display_width, display_height)
                                {
                                    surface.video_dimensions_changed(width, height);
                                }
                            }
                        }
                        // mpv can enqueue several updates for the same property before
                        // this thread catches up. Keep only the newest owned value in
                        // this zero-timeout drain, while retaining one event per name.
                        pending_properties.insert(name, data);
                    }
                    _ => {}
                }

                if shutdown || stop.load(Ordering::Acquire) {
                    break;
                }
                if ev.event_id == libmpv2_sys::mpv_event_id_MPV_EVENT_NONE {
                    break;
                }
                wait_seconds = 0.0;
            }

            let now = Instant::now();
            for (name, data) in pending_properties {
                let is_hot = matches!(name.as_str(), "time-pos" | "demuxer-cache-time");
                if is_hot
                    && last_hot_emit
                        .get(&name)
                        .map(|last| now.duration_since(*last) < HOT_PROPERTY_INTERVAL)
                        .unwrap_or(false)
                {
                    continue;
                }
                if is_hot {
                    last_hot_emit.insert(name.clone(), now);
                }
                let _ = app.emit("player-event", json!({ "name": name, "data": data }));
            }
            if shutdown {
                break;
            }
        }
        rp_log("event thread: stopped");
    })
}

unsafe fn prop_data_to_json(format: libmpv2_sys::mpv_format, data: *mut c_void) -> Value {
    if data.is_null() {
        return Value::Null;
    }
    match format {
        libmpv2_sys::mpv_format_MPV_FORMAT_FLAG => json!(*(data as *mut i32) != 0),
        libmpv2_sys::mpv_format_MPV_FORMAT_INT64 => json!(*(data as *mut i64)),
        libmpv2_sys::mpv_format_MPV_FORMAT_DOUBLE => json!(*(data as *mut f64)),
        libmpv2_sys::mpv_format_MPV_FORMAT_STRING
        | libmpv2_sys::mpv_format_MPV_FORMAT_OSD_STRING => {
            let s = *(data as *mut *mut std::os::raw::c_char);
            if s.is_null() {
                Value::Null
            } else {
                json!(CStr::from_ptr(s).to_string_lossy().into_owned())
            }
        }
        _ => Value::Null,
    }
}

/// Options OWNED by the native renderer that frontend-supplied values must never
/// override, because they are required for safety. The app drives mpv entirely
/// through libmpv and does not use mpv's built-in Lua scripts; Homebrew's arm64
/// mpv bundles LuaJIT, and on newer macOS the Hardened Runtime rejects the
/// executable pages LuaJIT creates while loading built-ins such as stats/console
/// and kills the signed app with CODESIGNING/Invalid Page. `load-scripts=no` alone
/// only disables USER scripts in mpv 0.41, so every built-in script switch must be
/// turned off explicitly. Applied at init on macOS only (the crash is macOS-
/// specific and some switches need mpv >= 0.40), but the frontend-override block
/// in `create_player` uses this list on every platform. (vo/hwdec are deliberately
/// NOT here: they are single-sourced per-platform in `best_in_class_options` and
/// guarded separately in `create_player`.)
const FORCED_MPV_OPTIONS: &[(&str, &str)] = &[
    ("load-scripts", "no"),
    ("load-auto-profiles", "no"),
    ("load-commands", "no"),
    ("load-console", "no"),
    ("load-context-menu", "no"),
    ("load-positioning", "no"),
    ("load-select", "no"),
    ("load-stats-overlay", "no"),
    ("osc", "no"),
    ("ytdl", "no"),
];

fn is_forced_mpv_option(name: &str) -> bool {
    FORCED_MPV_OPTIONS.iter().any(|(forced, _)| *forced == name)
}

#[cfg(target_os = "macos")]
fn is_macos_opaque_surface_option(name: &str) -> bool {
    matches!(name, "background" | "background-color")
}

#[derive(Clone, Copy)]
enum VideoQualityProfile {
    Balanced,
    #[allow(dead_code)]
    Maximum,
}

const DEFAULT_VIDEO_QUALITY_PROFILE: VideoQualityProfile = VideoQualityProfile::Balanced;

// Keep the previous maximum-quality stack intact so a future native setting can
// select it without reconstructing or drifting any of its mpv options.
const MAXIMUM_QUALITY_PROFILE: &[(&str, &str)] = &[
    ("scale", "ewa_lanczossharp"),
    ("cscale", "ewa_lanczossharp"),
    ("dscale", "mitchell"),
    ("scale-antiring", "0.6"),
    ("cscale-antiring", "0.6"),
    ("correct-downscaling", "yes"),
    ("linear-downscaling", "yes"),
    ("sigmoid-upscaling", "yes"),
    ("deband", "yes"),
    ("deband-iterations", "2"),
    ("deband-threshold", "35"),
    ("deband-range", "16"),
    ("deband-grain", "4"),
    ("dither-depth", "auto"),
    ("dither", "error-diffusion"),
    ("error-diffusion", "sierra-lite"),
];

// Balanced keeps the audit's EWA luma scaler and the rest of the established
// quality controls, but makes the two targeted per-pixel savings: separable
// Lanczos chroma scaling and one deband step instead of two.
const BALANCED_QUALITY_PROFILE: &[(&str, &str)] = &[
    ("scale", "ewa_lanczossharp"),
    ("cscale", "lanczos"),
    ("dscale", "mitchell"),
    ("scale-antiring", "0.6"),
    ("cscale-antiring", "0.6"),
    ("correct-downscaling", "yes"),
    ("linear-downscaling", "yes"),
    ("sigmoid-upscaling", "yes"),
    ("deband", "yes"),
    ("deband-iterations", "1"),
    ("deband-threshold", "35"),
    ("deband-range", "16"),
    ("deband-grain", "4"),
    ("dither-depth", "auto"),
    ("dither", "error-diffusion"),
    ("error-diffusion", "sierra-lite"),
];

fn video_quality_options(profile: VideoQualityProfile) -> &'static [(&'static str, &'static str)] {
    match profile {
        VideoQualityProfile::Balanced => BALANCED_QUALITY_PROFILE,
        VideoQualityProfile::Maximum => MAXIMUM_QUALITY_PROFILE,
    }
}

/// Best-in-class mpv options applied to EVERY player before user overrides -
/// the same engine mpv/IINA use, tuned for balanced scaling, debanding,
/// hardware decode, and streaming-cache "debrid feel". Per-platform decode +
/// output are selected by `cfg!(target_os)`:
///   * macOS/Linux use the OpenGL render API → `vo=libmpv` is MANDATORY; the
///     quality options below still tune the gpu renderer the render API drives.
///     (gpu-next-as-a-vo does not apply under the render API - see the memory.)
///   * Windows wid-embeds mpv → it owns a native `vo=gpu-next` + d3d11.
///
/// hwdec is per-OS: zero-copy `videotoolbox` on macOS, `d3d11va` on Windows,
/// `auto-copy` (vaapi/nvdec) on Linux - all fall back to software automatically,
/// so they can't break playback. It is set ONLY here (the webview no longer
/// overrides it).
pub(crate) fn best_in_class_options() -> Vec<(&'static str, &'static str)> {
    let mut o = vec![
        // The native surface always fills the window; mpv owns any genuine
        // letterboxing and must never stretch the decoded picture to that surface.
        ("keepaspect", "yes"),
    ];
    o.extend_from_slice(video_quality_options(DEFAULT_VIDEO_QUALITY_PROFILE));
    o.extend_from_slice(&[
        // Streaming cache - the debrid-feel levers (instant seek both directions).
        ("cache", "yes"),
        // 256MiB forward buffer absorbs debrid latency spikes on 4K HEVC/AV1
        // (~40-80 Mbit/s fills 150MiB in ~15-30s); 50MiB back-buffer = instant
        // backward seek within the recent window.
        ("demuxer-max-bytes", "256MiB"),
        ("demuxer-max-back-bytes", "50MiB"),
        ("cache-secs", "60"),
        ("demuxer-readahead-secs", "20"),
        // Wait for the initial buffer before starting instead of starting then
        // immediately stalling on a cold debrid cache.
        ("cache-pause-initial", "yes"),
        // Only re-wake the network once the cache drains ~10s below full, instead
        // of on every tiny dip - steadier throughput, fewer stalls.
        ("demuxer-hysteresis-secs", "10"),
        ("hls-bitrate", "max"),
        // Subtitles (libass; per-style props are driven live by the app UI).
        ("sub-auto", "fuzzy"),
        // `yes` (mpv 0.41 renamed the old `scale`): scale ASS to the window but
        // RESPECT the track's positioning/styling so signs, karaoke and
        // top-positioned lines aren't mangled. (`force` was removed in 0.38.)
        ("sub-ass-override", "yes"),
        // Audio.
        ("gapless-audio", "weak"),
        // Normalize surround→stereo downmix so loud 5.1/7.1 scenes don't clip on
        // Mac laptop/desktop speakers (default is off).
        ("audio-normalize-downmix", "yes"),
    ]);
    #[cfg(target_os = "macos")]
    {
        o.push(("vo", "libmpv")); // render API requires vo=libmpv
                                  // ZERO-COPY VideoToolbox: the IOSurface stays on the GPU and is sampled
                                  // directly by mpv's GL renderer (no GPU→CPU→GPU round-trip) - ~2x the
                                  // throughput and a fraction of the memory of copy mode on 4K HEVC/AV1
                                  // 10-bit, with no green/black-frame issues under this OpenGL render path.
                                  // hwdec is single-sourced HERE (the webview no longer overrides it).
                                  // Software decode remains the automatic fallback if VT can't handle a codec.
        o.push(("hwdec", "videotoolbox"));
        o.push(("ao", "coreaudio"));
        // The full-window CAOpenGLLayer is marked opaque. Explicitly make mpv
        // blend alpha-bearing frames over opaque black and paint uncovered
        // keepaspect bars black so every pixel in the layer is genuinely opaque.
        o.push(("background", "color"));
        o.push(("background-color", "#000000"));
    }
    #[cfg(target_os = "linux")]
    {
        // wid-embed: mpv owns a native GL vo inside the X11 child window. `gpu`
        // (not `gpu-next`) is used for broad libmpv-version compat; gpu-context
        // auto picks x11egl/x11 and honours the quality options above.
        o.push(("vo", "gpu"));
        o.push(("gpu-context", "auto"));
        // Copy-mode vaapi/nvdec, SW fallback - can't break playback.
        o.push(("hwdec", "auto-copy"));
        o.push(("ao", "pipewire,pulse,alsa"));
    }
    #[cfg(target_os = "windows")]
    {
        o.push(("vo", "gpu-next")); // wid-embed: mpv owns its native vo
        o.push(("gpu-api", "d3d11"));
        o.push(("gpu-context", "d3d11"));
        o.push(("hwdec", "d3d11va"));
        o.push(("ao", "wasapi"));
    }
    o
}

/// What a surface contributes BEFORE mpv is initialized. The wid-embed surfaces
/// (Windows HWND, Linux X11 XID) pass `wid` as a pre-init option (mpv's `wid` is
/// init-only); the macOS render-API surface needs nothing pre-init and returns an
/// empty `PreInit`. The opaque `handle` (the native window id as a usize) is
/// handed back to `surface_attach`.
pub struct PreInit {
    pub options: Vec<(String, String)>,
    pub handle: usize,
}

/// Windows: `libmpv-2.dll` is DELAY-LOADED (build.rs) and ships in `resources/lib`,
/// NOT next to the exe - so the loader can't find it on its own. Load it by full
/// path here, ONCE, BEFORE any mpv FFI call. This is critical for safety: if the
/// DLL is absent, letting mpv be touched would trip the delay-load helper's
/// unhandled SEH exception and CRASH the process (an SEH, not a catchable Rust
/// error). By loading + checking first we instead return a normal `Err`, so the
/// webview shows the error card + the external-player fallback. Mirrors the macOS
/// dlopen preload. No-op success on non-Windows.
#[cfg(target_os = "windows")]
fn ensure_libmpv_loaded<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::LibraryLoader::{
        LoadLibraryExW, LOAD_WITH_ALTERED_SEARCH_PATH,
    };
    static LOADED: OnceLock<bool> = OnceLock::new();
    let ok = *LOADED.get_or_init(|| {
        let Ok(dir) = app.path().resource_dir() else {
            return false;
        };
        let dll = dir.join("lib").join("libmpv-2.dll");
        let wide: Vec<u16> = dll
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // LOAD_WITH_ALTERED_SEARCH_PATH also resolves the DLL's own deps from its
        // dir. A non-null handle means every export is now resolvable, so the
        // delay-load stubs bind on first use.
        let h = unsafe {
            LoadLibraryExW(
                wide.as_ptr(),
                std::ptr::null_mut(),
                LOAD_WITH_ALTERED_SEARCH_PATH,
            )
        };
        !h.is_null()
    });
    if ok {
        Ok(())
    } else {
        Err("the in-window player is unavailable: bundled libmpv-2.dll could not be loaded".into())
    }
}

// ---- Player creation (mpv + surface + event thread; NO loadfile) ---------
pub fn create_player<R: Runtime>(
    app: AppHandle<R>,
    options: HashMap<String, String>,
    observed: Vec<ObserveSpec>,
) -> Result<(), String> {
    let state = app.state::<PlayerState>();
    // Creation includes native surface attachment and can take multiple main-loop
    // turns on macOS. Keep the lifecycle lock until the new Player is published
    // so another create or destroy cannot interleave with any phase.
    let _lifecycle = state.1.lock().map_err(|_| "player lifecycle poisoned")?;

    // Windows: guarantee libmpv is loaded before any mpv FFI, or bail cleanly
    // (never crash via the delay-load SEH). No-op elsewhere.
    #[cfg(target_os = "windows")]
    ensure_libmpv_loaded(&app)?;

    let old = {
        let mut guard = state.0.lock().map_err(|_| "player state poisoned")?;
        guard.take()
    };
    if let Some(mut old) = old {
        old.shutdown();
    }

    // Phase 1: let the surface create any native handle it needs before mpv
    // (Windows: the child HWND) and contribute pre-init mpv options (Windows: wid).
    let pre = super::surface_pre_init(&app)?;

    let mpv = Mpv::with_initializer(|init| {
        // Best-in-class defaults first, then the surface's pre-init options, then
        // user options override - except `vo`/`hwdec` (Rust-owned on every
        // platform) and the forced safety options below.
        for (k, v) in best_in_class_options() {
            if let Err(e) = init.set_option(k, v) {
                rp_log(&format!("create_player: default {k}={v} ERR {e}"));
            }
        }
        // Apply the renderer-owned safety options next, macOS ONLY: they defend
        // against the LuaJIT Hardened Runtime crash (see FORCED_MPV_OPTIONS),
        // which is macOS-specific, and two of the switches (load-console,
        // load-commands) only exist on mpv >= 0.40 - an older Linux system libmpv
        // must not fail player creation over an unknown option. Non-fatal: an
        // option the local mpv rejects is logged and skipped, like the defaults.
        #[cfg(target_os = "macos")]
        for &(name, value) in FORCED_MPV_OPTIONS {
            if let Err(e) = init.set_option(name, value) {
                rp_log(&format!("create_player: forced {name}={value} ERR {e}"));
            }
        }
        for (k, v) in &pre.options {
            if let Err(e) = init.set_option(k.as_str(), v.as_str()) {
                rp_log(&format!("create_player: pre-init {k}={v} ERR {e}"));
            }
        }
        for (k, v) in &options {
            // vo and hwdec are Rust-owned on EVERY platform (single-sourced
            // per-OS in `best_in_class_options`); a frontend value must not
            // override either - vo=libmpv is a render-API mandate on macOS, and
            // hwdec is a stability/perf decision the webview no longer makes.
            if k == "vo" || k == "hwdec" {
                continue;
            }
            // The CAOpenGLLayer is marked opaque, so its mpv background policy
            // is part of the native compositing contract rather than a frontend
            // customization point.
            #[cfg(target_os = "macos")]
            if is_macos_opaque_surface_option(k) {
                continue;
            }
            // Never let a frontend value re-enable a renderer-owned safety option.
            if is_forced_mpv_option(k) {
                continue;
            }
            if let Err(e) = init.set_option(k.as_str(), v.as_str()) {
                rp_log(&format!("create_player: set_option {k}={v} ERR {e}"));
            }
        }
        Ok(())
    })
    .map_err(|e| format!("mpv init failed: {e}"))?;
    let mpv = Arc::new(mpv);
    rp_log("create_player: mpv created");

    // Phase 2: bind mpv to the native surface (macOS creates the render-context
    // surface; Windows/Linux wrap the already-wid'd native window). The
    // cfg-selected `surface_pre_init`/`surface_attach` live in the active surface.
    let surface = super::surface_attach(&app, mpv.clone(), pre.handle)?;

    let event_stop = Arc::new(AtomicBool::new(false));
    let event_thread = Some(spawn_event_thread(
        app.clone(),
        mpv.clone(),
        observed,
        event_stop.clone(),
        surface.clone(),
    ));

    let mut player = Player {
        mpv,
        surface,
        event_stop,
        event_thread,
        legacy_proxy_lease: None,
        subtitle_dir: None,
        shutdown_started: false,
    };
    let mut guard = match state.0.lock() {
        Ok(guard) => guard,
        Err(_) => {
            // Surface attachment has already made the macOS WKWebView transparent.
            // Route this late init failure through the normal ordered teardown so
            // every native resource and the default opacity are restored.
            player.shutdown();
            return Err("player state poisoned".to_string());
        }
    };
    *guard = Some(player);
    rp_log("create_player: ready");
    rp_log("RPGEO event=player-ready engine=native-mpv");
    Ok(())
}

fn with_player<T>(
    state: &State<'_, PlayerState>,
    f: impl FnOnce(&mut Player) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(|_| "player state poisoned")?;
    let p = guard.as_mut().ok_or("no player running")?;
    f(p)
}

fn validate_nonempty_mpv_value(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{label} is empty"));
    }
    if value.contains('\0') {
        return Err(format!("{label} contains NUL"));
    }
    Ok(())
}

/// Validate the complete string command surface before libmpv sees it. Follow
/// mode loads remote web content, so this must stay an explicit allowlist rather
/// than exposing libmpv commands such as `run` to the webview.
fn validate_mpv_command(name: &str, args: &[&str]) -> Result<(), String> {
    validate_nonempty_mpv_value("command name", name)?;
    for (index, arg) in args.iter().enumerate() {
        validate_nonempty_mpv_value(&format!("argument {index}"), arg)?;
    }

    match name {
        "loadfile" => {
            if !matches!(args.len(), 1 | 4) {
                return Err("loadfile requires a URL, optionally with resume options".to_string());
            }
            // url, flags, index, options. mpv 0.38 inserted the integer index
            // before options; accepting a key=value string here recreates Raw(-4).
            if let Some(flags) = args.get(1) {
                if *flags != "replace" {
                    return Err("loadfile only supports replace".to_string());
                }
            }
            if let Some(index) = args.get(2) {
                if *index != "-1" {
                    return Err("loadfile index must be -1".to_string());
                }
            }
            if let Some(options) = args.get(3) {
                for option in options.split(',') {
                    let (key, value) = option
                        .split_once('=')
                        .ok_or_else(|| "loadfile option is not key=value".to_string())?;
                    if key.trim().is_empty() || value.trim().is_empty() {
                        return Err("loadfile option has an empty key or value".to_string());
                    }
                    if key != "start"
                        || !value.starts_with('+')
                        || value[1..].parse::<u64>().is_err()
                    {
                        return Err("loadfile option is not allowed".to_string());
                    }
                }
            }
        }
        "seek" => {
            if args.len() != 2 || !matches!(args[1], "absolute" | "relative") {
                return Err("seek requires an amount and absolute or relative mode".to_string());
            }
            let amount = args
                .first()
                .ok_or_else(|| "seek amount is missing".to_string())?
                .parse::<f64>()
                .map_err(|_| "seek amount is not numeric".to_string())?;
            if !amount.is_finite() {
                return Err("seek amount is not finite".to_string());
            }
        }
        "cycle" => {
            if args != ["sub"] {
                return Err("cycle only supports the subtitle track".to_string());
            }
        }
        _ => return Err("command is not allowed".to_string()),
    }
    Ok(())
}

fn parse_mpv_release(version: &str) -> Option<(u64, u64)> {
    version
        .split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find_map(|candidate| {
            let mut numbers = candidate.split('.');
            let major = numbers.next()?.parse::<u64>().ok()?;
            let minor = numbers.next()?.parse::<u64>().ok()?;
            Some((major, minor))
        })
}

fn mpv_supports_loadfile_index(version: Option<&str>) -> bool {
    // A git build can expose only a hash. Such builds are newer than the packaged
    // 0.37 compatibility target, so an unparseable version uses the modern shape.
    version
        .and_then(parse_mpv_release)
        .map(|(major, minor)| major > 0 || minor >= 38)
        .unwrap_or(true)
}

/// The app uses the mpv 0.38+ canonical loadfile shape. Ubuntu 24.04 still ships
/// mpv 0.37, where options occupy the third slot, so remove the new index
/// placeholder only at the final libmpv boundary on that runtime.
fn command_args_for_runtime<'a>(
    name: &str,
    args: &'a [&'a str],
    mpv_version: Option<&str>,
) -> Vec<&'a str> {
    if name == "loadfile" && args.len() == 4 && !mpv_supports_loadfile_index(mpv_version) {
        vec![args[0], args[1], args[3]]
    } else {
        args.to_vec()
    }
}

pub fn run_mpv_command(mpv: &Mpv, name: &str, args: &[&str]) -> Result<(), String> {
    if let Err(reason) = validate_mpv_command(name, args) {
        rp_log(&format!(
            "RPGEO event=command-reject engine=native-mpv command={} reason={reason}",
            if name.trim().is_empty() {
                "<empty>"
            } else {
                name
            }
        ));
        return Err(format!("mpv command rejected: {reason}"));
    }

    run_validated_mpv_command(mpv, name, args)
}

fn run_validated_mpv_command(mpv: &Mpv, name: &str, args: &[&str]) -> Result<(), String> {
    let version = if name == "loadfile" && args.len() == 4 {
        mpv.get_property::<String>("mpv-version").ok()
    } else {
        None
    };
    let runtime_args = command_args_for_runtime(name, args, version.as_deref());
    if runtime_args.len() != args.len() {
        rp_log("RPGEO event=loadfile-compat engine=native-mpv runtime=pre-0.38 options-slot=third");
    }
    mpv.command(name, &runtime_args)
        .map_err(|e| format!("mpv command failed: {e}"))
}

fn validate_mpv_property(name: &str, value: &str) -> Result<(), String> {
    validate_nonempty_mpv_value("property name", name)?;
    validate_nonempty_mpv_value("property value", value)?;
    match name {
        "pause" | "mute" => {
            if matches!(value, "yes" | "no") {
                Ok(())
            } else {
                Err(format!("{name} must be yes or no"))
            }
        }
        "aid" | "sid" => {
            if matches!(value, "auto" | "no") || value.parse::<u64>().is_ok() {
                Ok(())
            } else {
                Err(format!("{name} must be auto, no, or a numeric track id"))
            }
        }
        "audio-device" => {
            if value.chars().count() > 256 {
                Err("audio-device is too long".to_string())
            } else {
                Ok(())
            }
        }
        "volume"
        | "speed"
        | "sub-delay"
        | "audio-delay"
        | "sub-scale"
        | "sub-pos"
        | "video-zoom"
        | "video-pan-x"
        | "video-pan-y"
        | "video-aspect-override" => {
            let number = value
                .parse::<f64>()
                .map_err(|_| format!("{name} must be numeric"))?;
            if !number.is_finite() {
                return Err(format!("{name} must be finite"));
            }
            if matches!(name, "speed" | "sub-scale") && number <= 0.0 {
                return Err(format!("{name} must be positive"));
            }
            if name == "sub-pos" && !(0.0..=100.0).contains(&number) {
                return Err("sub-pos must be between 0 and 100".to_string());
            }
            if name == "video-zoom" && !(-2.0..=3.0).contains(&number) {
                return Err("video-zoom must be between -2 and 3".to_string());
            }
            if matches!(name, "video-pan-x" | "video-pan-y") && !(-1.0..=1.0).contains(&number) {
                return Err(format!("{name} must be between -1 and 1"));
            }
            if name == "video-aspect-override" && number != -1.0 && number <= 0.0 {
                return Err("video-aspect-override must be -1 or positive".to_string());
            }
            Ok(())
        }
        _ => Err("property is not allowed".to_string()),
    }
}

fn validate_mpv_observation(spec: &ObserveSpec) -> Result<(), String> {
    let expected = match spec.name.as_str() {
        "pause" | "paused-for-cache" | "seeking" | "mute" | "eof-reached" => "flag",
        "time-pos" | "duration" | "volume" | "speed" | "demuxer-cache-time" | "container-fps"
        | "estimated-vf-fps" => "double",
        "aid"
        | "sid"
        | "audio-device"
        | "video-codec"
        | "audio-codec-name"
        | "hwdec-current"
        | "video-params/primaries"
        | "video-params/gamma" => "string",
        "video-params/w"
        | "video-params/h"
        | "dwidth"
        | "dheight"
        | "track-list/count"
        | "decoder-frame-drop-count"
        | "frame-drop-count" => "int64",
        _ => return Err(format!("observation {} is not allowed", spec.name)),
    };
    if spec.format != expected {
        return Err(format!("observation {} must use {expected}", spec.name));
    }
    Ok(())
}

fn validate_mpv_init_options(options: &HashMap<String, String>) -> Result<(), String> {
    for (name, value) in options {
        match name.as_str() {
            "keep-open" if matches!(value.as_str(), "yes" | "no") => {}
            "terminal" if value == "no" => {}
            "sub-font-size" => {
                let size = value
                    .parse::<u16>()
                    .map_err(|_| "sub-font-size must be an integer".to_string())?;
                if !(8..=160).contains(&size) {
                    return Err("sub-font-size must be between 8 and 160".to_string());
                }
            }
            _ => return Err(format!("initial option {name} is not allowed")),
        }
    }
    Ok(())
}

fn validate_player_command_request<'a>(
    args: &'a [String],
    stream_authorization: Option<&str>,
) -> Result<(&'a str, Vec<&'a str>, Option<String>), String> {
    let (name, rest) = args.split_first().ok_or("empty command")?;
    let rest_refs: Vec<&str> = rest.iter().map(String::as_str).collect();
    validate_mpv_command(name, &rest_refs)
        .map_err(|reason| format!("mpv command rejected: {reason}"))?;
    let authorization = if name == "loadfile" {
        validate_stream_authorization(rest_refs[0], stream_authorization)?
    } else if stream_authorization.is_some() {
        return Err("stream authorization is only valid with loadfile".to_string());
    } else {
        None
    };
    Ok((name, rest_refs, authorization))
}

fn loadfile_args_with_authorization(
    args: &[&str],
    authorization: Option<&str>,
    cookie_header: Option<&str>,
) -> Vec<String> {
    let Some(authorization) = authorization else {
        return args.iter().map(|arg| (*arg).to_string()).collect();
    };
    let mut options = args.get(3).copied().unwrap_or_default().to_string();
    if !options.is_empty() {
        options.push(',');
    }
    options.push_str("http-header-fields=Authorization: ");
    options.push_str(authorization);
    if let Some(cookie_header) = cookie_header {
        options.push_str(",http-header-fields-append=Cookie: ");
        options.push_str(cookie_header);
    }
    // FFmpeg forwards custom headers across redirects. Keep the bearer on the
    // exact server URL that minted it (and any same-origin Access cookies) by
    // disabling redirects for this file.
    options.push_str(",stream-lavf-o=max_redirects=0");
    vec![
        args[0].to_string(),
        args.get(1).copied().unwrap_or("replace").to_string(),
        args.get(2).copied().unwrap_or("-1").to_string(),
        options,
    ]
}

fn loadfile_args_with_proxy(args: &[&str], proxy_url: &str) -> Vec<String> {
    let mut rewritten: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    rewritten[0] = proxy_url.to_string();
    rewritten
}

// ---- Tauri commands ------------------------------------------------------

/// Create the player (mpv + surface + event thread). Loading a file is a separate
/// `player_command("loadfile", [url])`.
///
/// MUST be `async`: on macOS `create_player` blocks on a channel while the AppKit
/// surface is built on the main thread (via Tauri's native-webview callback). A
/// SYNC Tauri command runs ON the main thread, which would deadlock. Async commands
/// run off the main thread.
#[tauri::command]
pub async fn player_init<R: Runtime>(
    app: AppHandle<R>,
    options: HashMap<String, String>,
    observed: Vec<ObserveSpec>,
) -> Result<(), String> {
    validate_mpv_init_options(&options)?;
    for spec in &observed {
        validate_mpv_observation(spec)?;
    }
    create_player(app, options, observed)
}

/// Convenience: create with defaults + load a URL.
#[tauri::command]
pub async fn player_load<R: Runtime>(
    app: AppHandle<R>,
    _window: Window<R>,
    url: String,
) -> Result<(), String> {
    create_player(app.clone(), HashMap::new(), Vec::new())?;
    let state = app.state::<PlayerState>();
    with_player(&state, |p| {
        rp_log("RPGEO event=loadfile-command engine=native-mpv path=player_load argc=1 flags=default index=absent options=absent");
        run_mpv_command(&p.mpv, "loadfile", &[&url])
    })
}

#[tauri::command]
pub async fn player_command<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, PlayerState>,
    args: Vec<String>,
    stream_authorization: Option<String>,
) -> Result<(), String> {
    // Complete command validation must precede cookie-store access. In
    // particular, malformed loadfile option shapes cannot use this command as a
    // browser-cookie query primitive.
    let (name, rest_refs, authorization) =
        match validate_player_command_request(&args, stream_authorization.as_deref()) {
            Ok(validated) => validated,
            Err(reason) => {
                rp_log(&format!(
                    "RPGEO event=command-reject engine=native-mpv command={} reason={reason}",
                    args.first()
                        .filter(|name| !name.trim().is_empty())
                        .map(String::as_str)
                        .unwrap_or("<empty>")
                ));
                return Err(reason);
            }
        };
    // Only consult the invoking webview's cookie store for an authenticated
    // server stream on that webview's exact HTTP(S) origin. Local tauri:// UI
    // and remote cross-origin pages therefore cannot export browser cookies.
    let cookie_header = match (name, authorization.as_ref()) {
        ("loadfile", Some(_)) => cloudflare_access_cookie_header_for_stream(&window, rest_refs[0]),
        _ => None,
    };
    let mut legacy_proxy_lease = if name == "loadfile" && authorization.is_none() {
        legacy_playback_for_window(&window, rest_refs[0])?
            .map(crate::playback_proxy::start)
            .transpose()?
    } else {
        None
    };
    let mut retired_lease = None;
    let result = with_player(&state, |p| {
        if name == "loadfile" {
            // Do not include the URL: debrid links commonly contain credentials.
            let flags = match rest_refs.get(1).copied() {
                Some("replace") => "replace",
                Some(_) => "present",
                None => "default",
            };
            let index = match rest_refs.get(2).copied() {
                Some("-1") => "-1",
                Some(value) if value.parse::<i64>().is_ok() => "integer",
                Some(_) => "invalid",
                None => "absent",
            };
            let options = match rest_refs.get(3).copied() {
                Some(value) if value.split(',').any(|option| option.starts_with("start=")) => {
                    "start"
                }
                Some(_) => "present",
                None => "absent",
            };
            rp_log(&format!(
                "RPGEO event=loadfile-command engine=native-mpv path=player_command argc={} flags={flags} index={index} options={options}",
                rest_refs.len()
            ));
            if authorization.is_some() {
                rp_log("RPGEO event=stream-auth engine=native-mpv source=stream-capability");
            }
        }
        let runtime_owned = if let Some(lease) = legacy_proxy_lease.as_ref() {
            loadfile_args_with_proxy(&rest_refs, lease.url())
        } else if name == "loadfile" {
            loadfile_args_with_authorization(
                &rest_refs,
                authorization.as_deref(),
                cookie_header.as_deref(),
            )
        } else {
            rest_refs.iter().map(|arg| (*arg).to_string()).collect()
        };
        let runtime_refs: Vec<&str> = runtime_owned.iter().map(String::as_str).collect();
        let r = run_validated_mpv_command(&p.mpv, name, &runtime_refs);
        if name == "loadfile" {
            rp_log(&format!("cmd loadfile [url redacted] -> {r:?}"));
            if r.is_ok() {
                retired_lease =
                    std::mem::replace(&mut p.legacy_proxy_lease, legacy_proxy_lease.take());
            }
        } else {
            rp_log(&format!("cmd {name} {rest_refs:?} -> {r:?}"));
        }
        r
    });
    drop(retired_lease);
    result
}

#[tauri::command]
pub fn player_set_property(
    state: State<'_, PlayerState>,
    name: String,
    value: String,
) -> Result<(), String> {
    with_player(&state, |p| {
        if let Err(reason) = validate_mpv_property(&name, &value) {
            rp_log(&format!(
                "RPGEO event=property-reject engine=native-mpv property={name} reason={reason}"
            ));
            return Err(format!("set_property rejected: {reason}"));
        }
        let r = p
            .mpv
            .set_property(&name, value.as_str())
            .map_err(|e| format!("set_property failed: {e}"));
        rp_log(&format!("set {name}={value} -> {r:?}"));
        r
    })
}

/// Get a property as JSON. Only the two frontend-required aggregate properties
/// are exposed. They are assembled from mpv sub-properties to avoid raw
/// `mpv_node` FFI.
#[tauri::command]
pub fn player_get_property(state: State<'_, PlayerState>, name: String) -> Result<Value, String> {
    with_player(&state, |p| match name.as_str() {
        "track-list" => Ok(build_track_list(&p.mpv)),
        "chapter-list" => Ok(build_chapter_list(&p.mpv)),
        "audio-device-list" => Ok(build_audio_device_list(&p.mpv)),
        _ => Err("property is not allowed".to_string()),
    })
}

#[tauri::command]
pub fn player_set_audio_passthrough(
    state: State<'_, PlayerState>,
    enabled: bool,
) -> Result<(), String> {
    with_player(&state, |player| {
        let codecs = if enabled {
            "ac3,dts,dts-hd,eac3,truehd"
        } else {
            ""
        };
        player
            .mpv
            .set_property("audio-spdif", codecs)
            .map_err(|error| format!("could not change audio passthrough: {error}"))
    })
}

#[tauri::command]
pub fn player_set_hdr_policy(state: State<'_, PlayerState>, policy: String) -> Result<(), String> {
    with_player(&state, |player| {
        let (display_hint, tone_mapping) = match policy.as_str() {
            "auto" => ("no", "auto"),
            "preserve" => ("yes", "auto"),
            "tone-map" => ("no", "bt.2390"),
            _ => return Err("HDR policy is not allowed".to_string()),
        };
        player
            .mpv
            .set_property("target-colorspace-hint", display_hint)
            .map_err(|error| format!("could not change HDR display policy: {error}"))?;
        player
            .mpv
            .set_property("tone-mapping", tone_mapping)
            .map_err(|error| format!("could not change HDR tone mapping: {error}"))
    })
}

const MAX_SUBTITLE_BYTES: usize = 5 * 1024 * 1024;
const MAX_SUBTITLE_LABEL_CHARS: usize = 120;
const MAX_SUBTITLE_LANGUAGE_CHARS: usize = 32;

fn validate_subtitle_payload(contents: &str, label: &str, language: &str) -> Result<(), String> {
    if contents.is_empty() {
        return Err("subtitle file is empty".to_string());
    }
    if contents.len() > MAX_SUBTITLE_BYTES {
        return Err("subtitle file exceeds the 5 MB limit".to_string());
    }
    if contents.contains('\0') {
        return Err("subtitle file contains NUL".to_string());
    }
    if !contents
        .trim_start_matches('\u{feff}')
        .starts_with("WEBVTT")
    {
        return Err("subtitle file must be WebVTT".to_string());
    }
    validate_nonempty_mpv_value("subtitle label", label)?;
    validate_nonempty_mpv_value("subtitle language", language)?;
    if label.chars().count() > MAX_SUBTITLE_LABEL_CHARS {
        return Err("subtitle label is too long".to_string());
    }
    if language.chars().count() > MAX_SUBTITLE_LANGUAGE_CHARS {
        return Err("subtitle language is too long".to_string());
    }
    Ok(())
}

fn create_private_subtitle_dir() -> Result<PathBuf, String> {
    for _ in 0..8 {
        let mut random = [0_u8; 16];
        getrandom::getrandom(&mut random)
            .map_err(|error| format!("could not generate subtitle path: {error}"))?;
        let suffix = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let dir = std::env::temp_dir().join(format!("yawf-stream-subtitles-{suffix}"));
        #[cfg(unix)]
        let create_result = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700);
            builder.create(&dir)
        };
        #[cfg(not(unix))]
        let create_result = fs::create_dir(&dir);
        match create_result {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Err(error) = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
                    {
                        let _ = fs::remove_dir(&dir);
                        return Err(format!("could not secure subtitle directory: {error}"));
                    }
                }
                return Ok(dir);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!("could not create subtitle directory: {error}"));
            }
        }
    }
    Err("could not allocate a unique subtitle directory".to_string())
}

fn external_subtitle_id(mpv: &Mpv, path: &Path) -> Option<i64> {
    let path = path.to_string_lossy();
    let count = mpv.get_property::<i64>("track-list/count").ok()?;
    (0..count).find_map(|index| {
        let kind = mpv
            .get_property::<String>(&format!("track-list/{index}/type"))
            .ok()?;
        let external = mpv
            .get_property::<String>(&format!("track-list/{index}/external-filename"))
            .ok()?;
        if kind == "sub" && external == path {
            mpv.get_property::<i64>(&format!("track-list/{index}/id"))
                .ok()
        } else {
            None
        }
    })
}

/// Materialize a downloaded or translated WebVTT track inside a private
/// process-owned directory, attach it to mpv, and return its numeric track id.
/// This dedicated command avoids exposing mpv's arbitrary `sub-add` path surface.
#[tauri::command]
pub fn player_add_subtitle(
    state: State<'_, PlayerState>,
    contents: String,
    label: String,
    language: String,
) -> Result<i64, String> {
    validate_subtitle_payload(&contents, &label, &language)?;
    with_player(&state, |player| {
        if player.subtitle_dir.is_none() {
            player.subtitle_dir = Some(create_private_subtitle_dir()?);
        }
        let dir = player
            .subtitle_dir
            .as_ref()
            .ok_or_else(|| "subtitle directory is unavailable".to_string())?;
        let path = dir.join(format!(
            "track-{}.vtt",
            player
                .mpv
                .get_property::<i64>("track-list/count")
                .unwrap_or(0)
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| format!("could not create subtitle file: {error}"))?;
        file.write_all(contents.as_bytes())
            .and_then(|_| file.flush())
            .map_err(|error| format!("could not write subtitle file: {error}"))?;
        let path_string = path
            .to_str()
            .ok_or_else(|| "subtitle path is not valid UTF-8".to_string())?;
        if let Err(error) = player
            .mpv
            .command("sub-add", &[path_string, "select", &label, &language])
        {
            let _ = fs::remove_file(&path);
            return Err(format!("could not attach subtitle track: {error}"));
        }
        external_subtitle_id(&player.mpv, &path)
            .ok_or_else(|| "mpv did not expose the attached subtitle track".to_string())
    })
}

/// Reserve a fraction of the bottom of the video for the control bar so the
/// controls never cover the picture (mpv `video-margin-ratio-bottom`).
#[tauri::command]
pub fn player_set_video_margin(state: State<'_, PlayerState>, bottom: f64) -> Result<(), String> {
    with_player(&state, |p| {
        if !bottom.is_finite() || !(0.0..=1.0).contains(&bottom) {
            rp_log(&format!(
                "RPGEO event=property-reject engine=native-mpv property=video-margin-ratio-bottom reason=out-of-range value={bottom}"
            ));
            return Err("video margin must be finite and between 0 and 1".to_string());
        }
        let r = p
            .mpv
            .set_property("video-margin-ratio-bottom", bottom)
            .map_err(|e| format!("set video margin failed: {e}"));
        rp_log(&format!("video-margin {bottom} -> {r:?}"));
        r
    })
}

/// Sync the native video rect to the app layout (backing px). No-op on OSes whose
/// surface autoresizes with the window; used on Windows for the child HWND.
#[tauri::command]
pub fn player_set_rect(
    state: State<'_, PlayerState>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    with_player(&state, |p| {
        p.surface.set_rect(x, y, width, height);
        Ok(())
    })
}

#[tauri::command]
pub async fn player_destroy<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.state::<PlayerState>();
    let _lifecycle = state.1.lock().map_err(|_| "player lifecycle poisoned")?;
    let taken = {
        let mut guard = state.0.lock().map_err(|_| "player state poisoned")?;
        guard.take()
    };
    if let Some(mut p) = taken {
        p.shutdown();
    }
    Ok(())
}

fn build_track_list(mpv: &Mpv) -> Value {
    let count = mpv.get_property::<i64>("track-list/count").unwrap_or(0);
    let mut arr = Vec::new();
    for i in 0..count {
        let s = |p: &str| {
            mpv.get_property::<String>(&format!("track-list/{i}/{p}"))
                .ok()
        };
        let b = |p: &str| {
            mpv.get_property::<bool>(&format!("track-list/{i}/{p}"))
                .unwrap_or(false)
        };
        arr.push(json!({
            "id": mpv.get_property::<i64>(&format!("track-list/{i}/id")).ok(),
            "type": s("type"),
            "title": s("title"),
            "lang": s("lang"),
            "selected": b("selected"),
            "codec": s("codec"),
            "external": b("external"),
            "external-filename": s("external-filename"),
        }));
    }
    Value::Array(arr)
}

fn build_chapter_list(mpv: &Mpv) -> Value {
    let count = mpv.get_property::<i64>("chapter-list/count").unwrap_or(0);
    let mut arr = Vec::new();
    for i in 0..count {
        arr.push(json!({
            "title": mpv.get_property::<String>(&format!("chapter-list/{i}/title")).unwrap_or_default(),
            "time": mpv.get_property::<f64>(&format!("chapter-list/{i}/time")).unwrap_or(0.0),
        }));
    }
    Value::Array(arr)
}

fn build_audio_device_list(mpv: &Mpv) -> Value {
    let count = mpv
        .get_property::<i64>("audio-device-list/count")
        .unwrap_or(0);
    let mut devices = Vec::new();
    for index in 0..count {
        let name = mpv
            .get_property::<String>(&format!("audio-device-list/{index}/name"))
            .ok();
        let description = mpv
            .get_property::<String>(&format!("audio-device-list/{index}/description"))
            .ok();
        if let Some(name) = name {
            devices.push(json!({
                "name": name,
                "description": description,
            }));
        }
    }
    Value::Array(devices)
}

#[cfg(test)]
mod tests {
    use super::best_in_class_options;
    use super::cloudflare_access_cookie_header;
    use super::command_args_for_runtime;
    use super::cookie_path_matches;
    use super::is_forced_mpv_option;
    use super::loadfile_args_with_authorization;
    use super::loadfile_args_with_proxy;
    use super::mpv_supports_loadfile_index;
    use super::same_http_origin;
    use super::validate_mpv_command;
    use super::validate_mpv_init_options;
    use super::validate_mpv_observation;
    use super::validate_mpv_property;
    use super::validate_player_command_request;
    use super::validate_stream_authorization;
    use super::validate_subtitle_payload;
    use super::ObserveSpec;
    use super::MAX_ACCESS_COOKIE_VALUE_BYTES;
    use std::collections::HashMap;

    #[test]
    fn subtitle_payload_is_bounded_and_webvtt_only() {
        assert!(validate_subtitle_payload(
            "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n",
            "English",
            "en"
        )
        .is_ok());
        assert!(
            validate_subtitle_payload("1\n00:00:00,000 --> 00:00:01,000\nHi", "English", "en")
                .is_err()
        );
        assert!(validate_subtitle_payload("WEBVTT\n\0", "English", "en").is_err());
        assert!(validate_subtitle_payload("WEBVTT\n", "", "en").is_err());
    }

    #[test]
    fn stream_authorization_is_scoped_and_file_local() {
        let token = "A".repeat(43);
        let authorization = format!("Bearer {token}");
        let url = "https://stream.example/yawf/api/stream/stream_0123456789abcdef0123456789abcdef";
        assert_eq!(
            validate_stream_authorization(url, Some(&authorization)),
            Ok(Some(authorization.clone()))
        );
        for rejected in [
            "https://stream.example/api/streams/resolve",
            "https://stream.example/api/stream/",
            "https://user@stream.example/api/stream/stream_0123456789abcdef0123456789abcdef",
            "file:///api/stream/stream_0123456789abcdef0123456789abcdef",
        ] {
            assert!(validate_stream_authorization(rejected, Some(&authorization)).is_err());
        }
        assert!(validate_stream_authorization(url, Some("Bearer bad\r\nX-Leak: yes")).is_err());

        let fresh = loadfile_args_with_authorization(&[url], Some(&authorization), None);
        assert_eq!(fresh[0], url);
        assert_eq!(fresh[1], "replace");
        assert_eq!(fresh[2], "-1");
        assert!(fresh[3].contains("http-header-fields=Authorization: Bearer "));
        assert!(fresh[3].contains("stream-lavf-o=max_redirects=0"));

        let resumed = loadfile_args_with_authorization(
            &[url, "replace", "-1", "start=+125"],
            Some(&authorization),
            None,
        );
        assert!(resumed[3].starts_with("start=+125,"));
        let no_auth = loadfile_args_with_authorization(&[url], None, Some("CF_Session=ignored"));
        assert_eq!(no_auth, vec![url.to_string()]);
    }

    #[test]
    fn access_cookies_require_the_exact_http_origin() {
        let target = tauri::Url::parse(
            "https://db.tgk30.com/api/stream/stream_0123456789abcdef0123456789abcdef",
        )
        .unwrap();
        for same_origin in [
            "https://db.tgk30.com/",
            "https://db.tgk30.com:443/watch/episode",
        ] {
            assert!(same_http_origin(
                &tauri::Url::parse(same_origin).unwrap(),
                &target
            ));
        }
        for rejected in [
            "http://db.tgk30.com/",
            "https://db.tgk30.com:444/",
            "https://evil.example/",
            "tauri://localhost/",
        ] {
            assert!(!same_http_origin(
                &tauri::Url::parse(rejected).unwrap(),
                &target
            ));
        }
    }

    #[test]
    fn access_cookie_header_is_strictly_filtered_and_formatted() {
        let cookies = [
            ("ds_session", "must-not-leak", Some("/")),
            ("CF_Authorization", "auth.token-_~", Some("/")),
            ("CF_Session", "session=value", Some("/api")),
            ("CF_AppSession", "app-session", Some("/api/stream/")),
            ("CF_AppSession", "unsafe;injected=yes", Some("/")),
            ("CF_Session\r\nX-Leak", "bad-name", Some("/")),
        ];
        assert_eq!(
            cloudflare_access_cookie_header("/api/stream/stream_0123456789abcdef0123456789abcdef", cookies),
            Some(
                "CF_Authorization=auth.token-_~; CF_Session=session=value; CF_AppSession=app-session"
                    .to_string()
            )
        );

        for unsafe_value in [
            "line\rbreak",
            "line\nbreak",
            "nul\0byte",
            "mpv,option",
            "cookie;separator",
            "has space",
            "has\\slash",
            "has\"quote",
        ] {
            assert_eq!(
                cloudflare_access_cookie_header(
                    "/api/stream/stream_0123456789abcdef0123456789abcdef",
                    [("CF_Session", unsafe_value, Some("/"))]
                ),
                None
            );
        }
    }

    #[test]
    fn access_cookie_path_match_enforces_segment_boundaries() {
        for cookie_path in [
            "/",
            "/api",
            "/api/",
            "/api/stream/stream_0123456789abcdef0123456789abcdef",
        ] {
            assert!(cookie_path_matches(
                "/api/stream/stream_0123456789abcdef0123456789abcdef",
                Some(cookie_path)
            ));
        }
        for cookie_path in ["/ap", "/api/stream/stream", "/other"] {
            assert!(!cookie_path_matches(
                "/api/stream/stream_0123456789abcdef0123456789abcdef",
                Some(cookie_path)
            ));
        }
        assert!(!cookie_path_matches(
            "/api/stream/stream_0123456789abcdef0123456789abcdef",
            None
        ));
        assert!(!cookie_path_matches(
            "/api/stream/stream_0123456789abcdef0123456789abcdef",
            Some("api")
        ));
    }

    #[test]
    fn access_cookie_duplicates_use_the_longest_matching_path() {
        let cookies = [
            ("CF_Session", "root", Some("/")),
            ("CF_Session", "api", Some("/api")),
            (
                "CF_Session",
                "z-stream-specific",
                Some("/api/stream/stream_0123456789abcdef0123456789abcdef"),
            ),
            (
                "CF_Session",
                "stream-specific",
                Some("/api/stream/stream_0123456789abcdef0123456789abcdef"),
            ),
            ("CF_Session", "wrong-boundary", Some("/api/stream/stream")),
        ];
        assert_eq!(
            cloudflare_access_cookie_header(
                "/api/stream/stream_0123456789abcdef0123456789abcdef",
                cookies
            ),
            Some("CF_Session=stream-specific".to_string())
        );
    }

    #[test]
    fn access_cookie_header_rejects_oversize_values_and_totals() {
        let oversized = "A".repeat(MAX_ACCESS_COOKIE_VALUE_BYTES + 1);
        assert_eq!(
            cloudflare_access_cookie_header(
                "/api/stream/id",
                [("CF_Session", oversized.as_str(), Some("/"))]
            ),
            None
        );

        let maximum = "A".repeat(MAX_ACCESS_COOKIE_VALUE_BYTES);
        assert_eq!(
            cloudflare_access_cookie_header(
                "/api/stream/id",
                [
                    ("CF_Authorization", maximum.as_str(), Some("/")),
                    ("CF_Session", maximum.as_str(), Some("/")),
                ]
            ),
            None,
            "the combined Cookie header must also stay within its bound"
        );
    }

    #[test]
    fn malformed_loadfile_is_rejected_before_stream_cookie_eligibility() {
        let malformed_count = vec![
            "loadfile".to_string(),
            "https://db.tgk30.com/api/stream/id".to_string(),
            "replace".to_string(),
        ];
        let error =
            validate_player_command_request(&malformed_count, Some("not-a-bearer")).unwrap_err();
        assert_eq!(
            error,
            "mpv command rejected: loadfile requires a URL, optionally with resume options"
        );

        let malformed_options = vec![
            "loadfile".to_string(),
            "https://db.tgk30.com/api/stream/id".to_string(),
            "replace".to_string(),
            "-1".to_string(),
            "http-header-fields=Cookie: ds_session".to_string(),
        ];
        let error =
            validate_player_command_request(&malformed_options, Some("not-a-bearer")).unwrap_err();
        assert_eq!(
            error,
            "mpv command rejected: loadfile option is not allowed"
        );
    }

    #[test]
    fn synthesized_authenticated_loadfile_options_append_access_cookie() {
        let url = "https://db.tgk30.com/api/stream/stream_0123456789abcdef0123456789abcdef";
        let authorization = format!("Bearer {}", "A".repeat(43));
        let args = loadfile_args_with_authorization(
            &[url, "replace", "-1", "start=+125"],
            Some(&authorization),
            Some("CF_Session=access-session"),
        );
        assert_eq!(
            args,
            vec![
                url.to_string(),
                "replace".to_string(),
                "-1".to_string(),
                format!(
                    "start=+125,http-header-fields=Authorization: {authorization},http-header-fields-append=Cookie: CF_Session=access-session,stream-lavf-o=max_redirects=0"
                ),
            ]
        );
    }

    #[test]
    fn legacy_proxy_rewrites_only_the_loadfile_url() {
        let args = [
            "https://server.example/api/stream/stream_0123456789abcdef0123456789abcdef",
            "replace",
            "-1",
            "start=+125",
        ];
        assert_eq!(
            loadfile_args_with_proxy(&args, "http://127.0.0.1:1234/capability"),
            vec![
                "http://127.0.0.1:1234/capability",
                "replace",
                "-1",
                "start=+125",
            ]
        );
    }

    #[test]
    fn resumed_loadfile_uses_the_version_correct_options_slot() {
        let args = [
            "https://example.test/episode.mkv",
            "replace",
            "-1",
            "start=+125",
        ];
        assert_eq!(validate_mpv_command("loadfile", &args), Ok(()));

        let modern = command_args_for_runtime("loadfile", &args, Some("mpv 0.41.0"));
        assert_eq!(modern, args.to_vec());
        let legacy = command_args_for_runtime("loadfile", &args, Some("mpv 0.37.0"));
        assert_eq!(
            legacy,
            vec![args[0], args[1], args[3]],
            "mpv 0.37 expects options in the third slot"
        );
        assert!(!mpv_supports_loadfile_index(Some("mpv 0.37.0")));
        assert!(mpv_supports_loadfile_index(Some("mpv 0.38.0")));
        assert!(mpv_supports_loadfile_index(Some("mpv git-deadbeef")));
    }

    #[test]
    fn command_guard_rejects_the_regressed_and_empty_shapes() {
        assert!(validate_mpv_command(
            "loadfile",
            &["https://example.test/episode.mkv", "replace", "start=+125"]
        )
        .is_err());
        assert!(validate_mpv_command("loadfile", &[""]).is_err());
        assert!(validate_mpv_command(
            "loadfile",
            &[
                "https://example.test/episode.mkv",
                "replace",
                "-1",
                "start=+125,"
            ]
        )
        .is_err());
        assert!(validate_mpv_command("seek", &["NaN", "absolute"]).is_err());
        assert!(validate_mpv_command("seek", &["10", "unsafe-mode"]).is_err());
        assert!(validate_mpv_command("cycle", &["audio"]).is_err());
        assert!(validate_mpv_command("run", &["open", "https://example.test"]).is_err());
        assert!(validate_mpv_command(
            "loadfile",
            &[
                "https://example.test/episode.mkv",
                "replace",
                "-1",
                "http-header-fields=Cookie: secret"
            ]
        )
        .is_err());
    }

    #[test]
    fn property_guard_accepts_real_track_ids_and_rejects_bad_values() {
        assert_eq!(validate_mpv_property("aid", "2"), Ok(()));
        assert_eq!(validate_mpv_property("sid", "no"), Ok(()));
        assert_eq!(validate_mpv_property("sid", "auto"), Ok(()));
        assert_eq!(validate_mpv_property("pause", "yes"), Ok(()));
        assert_eq!(validate_mpv_property("mute", "no"), Ok(()));
        assert!(validate_mpv_property("aid", "none").is_err());
        assert!(validate_mpv_property("speed", "NaN").is_err());
        assert!(validate_mpv_property("pause", "false").is_err());
        assert!(validate_mpv_property("http-header-fields", "X-Test: value").is_err());
    }

    #[test]
    fn init_surface_rejects_arbitrary_options_and_observations() {
        let options = HashMap::from([
            ("keep-open".to_string(), "yes".to_string()),
            ("sub-font-size".to_string(), "44".to_string()),
            ("terminal".to_string(), "no".to_string()),
        ]);
        assert_eq!(validate_mpv_init_options(&options), Ok(()));
        assert!(validate_mpv_init_options(&HashMap::from([(
            "script".to_string(),
            "/tmp/unsafe.lua".to_string()
        )]))
        .is_err());
        assert_eq!(
            validate_mpv_observation(&ObserveSpec {
                name: "time-pos".to_string(),
                format: "double".to_string(),
            }),
            Ok(())
        );
        assert_eq!(
            validate_mpv_observation(&ObserveSpec {
                name: "track-list/count".to_string(),
                format: "int64".to_string(),
            }),
            Ok(())
        );
        assert_eq!(
            validate_mpv_observation(&ObserveSpec {
                name: "seeking".to_string(),
                format: "flag".to_string(),
            }),
            Ok(())
        );
        assert!(validate_mpv_observation(&ObserveSpec {
            name: "track-list/count".to_string(),
            format: "double".to_string(),
        })
        .is_err());
        assert!(validate_mpv_observation(&ObserveSpec {
            name: "http-header-fields".to_string(),
            format: "string".to_string(),
        })
        .is_err());
    }

    /// A frontend option must never be able to re-enable the renderer-owned safety
    /// switches that keep mpv's built-in Lua scripts (LuaJIT) from loading.
    #[test]
    fn frontend_cannot_override_native_player_safety_options() {
        for &(name, _) in super::FORCED_MPV_OPTIONS {
            assert!(is_forced_mpv_option(name), "{name} must stay forced");
        }
        assert!(!is_forced_mpv_option("cache"));
    }

    /// The best-in-class defaults are stable + platform-correct. Pure/headless -
    /// no GPU, no mpv instance - so it runs on every CI runner.
    #[test]
    fn best_in_class_options_are_quality_and_platform_correct() {
        let opts = best_in_class_options();
        let map: HashMap<&str, &str> = opts.iter().cloned().collect();
        // No duplicate keys (a later override would silently win).
        assert_eq!(map.len(), opts.len(), "duplicate option keys: {opts:?}");

        // Cross-platform quality baseline.
        assert_eq!(map.get("keepaspect"), Some(&"yes"));
        assert_eq!(map.get("scale"), Some(&"ewa_lanczossharp"));
        assert_eq!(map.get("cscale"), Some(&"lanczos"));
        assert_eq!(map.get("deband"), Some(&"yes"));
        assert_eq!(map.get("deband-iterations"), Some(&"1"));
        assert_eq!(map.get("dither"), Some(&"error-diffusion"));
        assert_eq!(map.get("cache"), Some(&"yes"));
        assert_eq!(map.get("demuxer-max-back-bytes"), Some(&"50MiB"));
        assert_eq!(map.get("sub-ass-override"), Some(&"yes"));
        assert_eq!(map.get("audio-normalize-downmix"), Some(&"yes"));
        assert_eq!(map.get("cache-pause-initial"), Some(&"yes"));
        assert!(
            map.contains_key("hwdec"),
            "hwdec must be set on every platform"
        );

        // Per-platform decode + output.
        #[cfg(target_os = "macos")]
        {
            assert_eq!(map.get("vo"), Some(&"libmpv")); // render API mandate
            assert_eq!(map.get("hwdec"), Some(&"videotoolbox")); // zero-copy VT
            assert_eq!(map.get("ao"), Some(&"coreaudio"));
            assert_eq!(map.get("background"), Some(&"color"));
            assert_eq!(map.get("background-color"), Some(&"#000000"));
        }
        #[cfg(target_os = "linux")]
        {
            assert_eq!(map.get("vo"), Some(&"gpu")); // wid-embed native vo
            assert_eq!(map.get("gpu-context"), Some(&"auto"));
            assert_eq!(map.get("hwdec"), Some(&"auto-copy"));
        }
        #[cfg(target_os = "windows")]
        {
            assert_eq!(map.get("vo"), Some(&"gpu-next")); // wid-embed native
            assert_eq!(map.get("hwdec"), Some(&"d3d11va"));
            assert_eq!(map.get("gpu-api"), Some(&"d3d11"));
        }
    }

    #[test]
    fn maximum_quality_profile_preserves_previous_expensive_settings() {
        let map: HashMap<&str, &str> = super::MAXIMUM_QUALITY_PROFILE.iter().copied().collect();
        assert_eq!(map.get("scale"), Some(&"ewa_lanczossharp"));
        assert_eq!(map.get("cscale"), Some(&"ewa_lanczossharp"));
        assert_eq!(map.get("deband-iterations"), Some(&"2"));
    }
}
