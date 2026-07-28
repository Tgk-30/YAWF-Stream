// DebridStreamer desktop player commands.
//
// Two playback backends cover browser-native and desktop-native formats:
//   1. In-webview playback (hls.js / native <video>) for HLS/MP4 - the browser path.
//   2. Desktop hand-off to a native player (VLC/mpv) for MKV/HEVC the webview can't decode.
// This command is the desktop direct-play seam: hand a Real-Debrid direct link to a
// native player. On macOS we try VLC, then mpv/IINA as fallbacks.

use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

mod playback_auth;
mod playback_proxy;

// Bundled-mpv player (Phase 3 P1): spawns the mpv sidecar and drives it over
// JSON IPC. See player.rs for the `--wid` in-window-embedding caveat (macOS).
// Desktop-only: there is no mpv sidecar to spawn on mobile.
#[cfg(desktop)]
mod player;

// In-window mpv render-API player (v0.5): drives mpv's render API into our own
// NSOpenGLView composited behind the transparent webview. The real "beyond IINA"
// in-window path is implemented in render_player.rs on macOS.
mod render_player;

// OS-keychain SecretStore backend (keychain_get / keychain_set / keychain_delete).
// Desktop-only: `keyring` is target-gated to the three desktop OSes in
// Cargo.toml and ships no Android backend, so the JS SecretStore falls back to
// its Dexie store on mobile exactly as it does in a plain browser.
#[cfg(desktop)]
mod keychain;

// Desktop Host Mode: supervises the bundled/self-built Server Mode process so a
// desktop app can host the PWA/API for other devices. Desktop-only: it spawns a
// bundled Node runtime, which mobile does not ship.
#[cfg(desktop)]
mod server_host;

// Native downloads and optional ffmpeg optimization pipeline. Desktop-only: the
// transcode path shells out to an ffmpeg binary that mobile does not ship.
#[cfg(desktop)]
mod downloads;

// DLNA/UPnP discovery and transport control for LAN MediaRenderers.
mod cast;

// The external players we can detect + hand a stream to, in default-preference
// order. macOS entries are .app names (opened via LaunchServices); "mpv" is also
// probed on PATH for a CLI/Homebrew install with no .app.
#[cfg(target_os = "macos")]
const MACOS_PLAYERS: &[&str] = &["IINA", "VLC", "mpv", "QuickTime Player", "Infuse"];

#[cfg(target_os = "macos")]
fn macos_app_installed(app: &str) -> bool {
    // `open -Ra <app>` exits 0 iff the app is registered with LaunchServices.
    Command::new("open")
        .args(["-Ra", app])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn cli_on_path(bin: &str) -> bool {
    Command::new(bin)
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// The external media players actually installed on this machine, so the UI can
/// offer only real choices (and pick a sensible default).
fn list_external_players_blocking() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        let mut found: Vec<String> = MACOS_PLAYERS
            .iter()
            .filter(|app| **app == "mpv" || macos_app_installed(app))
            .map(|s| s.to_string())
            .collect();
        // mpv is often a CLI-only Homebrew install (no .app) - keep it only if
        // actually present.
        found.retain(|p| p != "mpv" || cli_on_path("mpv"));
        found
    }
    #[cfg(not(target_os = "macos"))]
    {
        ["mpv", "vlc", "mpc-hc64", "mpc-hc", "PotPlayerMini64"]
            .iter()
            .filter(|b| cli_on_path(b))
            .map(|s| s.to_string())
            .collect()
    }
}

#[tauri::command]
async fn list_external_players() -> Vec<String> {
    tokio::task::spawn_blocking(list_external_players_blocking)
        .await
        .unwrap_or_default()
}

/// The locally-installed tunnel clients. Detection is deliberately advisory:
/// authentication and tunnel creation remain interactive user-controlled flows.
#[derive(Clone, Debug, Serialize)]
struct ToolInfo {
    installed: bool,
    version: Option<String>,
    detail: Option<String>,
}

impl ToolInfo {
    fn absent() -> Self {
        Self {
            installed: false,
            version: None,
            detail: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
struct TunnelTools {
    cloudflared: ToolInfo,
    tailscale: ToolInfo,
}

/// Installation details used only to give the desktop Settings screen accurate
/// uninstall guidance. These helpers inspect paths only and never modify them.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AppInstallInfo {
    os: &'static str,
    format: &'static str,
    app_bundle_path: Option<String>,
    appimage_path: Option<String>,
}

fn nearest_app_bundle_ancestor(executable: &Path) -> Option<String> {
    executable
        .ancestors()
        .find(|ancestor| {
            ancestor
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".app"))
        })
        .map(|ancestor| ancestor.to_string_lossy().into_owned())
}

fn classify_install_format(
    os: &str,
    executable: Option<&Path>,
    appimage_path: Option<&str>,
    app_bundle_path: Option<&str>,
) -> &'static str {
    match os {
        "macos" if app_bundle_path.is_some() => "macos-app",
        "windows" => "windows",
        "linux" if appimage_path.is_some_and(|path| !path.is_empty()) => "linux-appimage",
        "linux" if executable.is_some_and(|path| path.starts_with("/usr/")) => "linux-deb",
        _ => "unknown",
    }
}

fn current_os() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        "linux"
    }
}

fn detect_app_install_info(
    os: &'static str,
    executable: Option<&Path>,
    appimage_path: Option<String>,
) -> AppInstallInfo {
    let app_bundle_path = if os == "macos" {
        executable.and_then(nearest_app_bundle_ancestor)
    } else {
        None
    };
    let format = classify_install_format(
        os,
        executable,
        appimage_path.as_deref(),
        app_bundle_path.as_deref(),
    );
    AppInstallInfo {
        os,
        format,
        app_bundle_path,
        appimage_path: if os == "linux" { appimage_path } else { None },
    }
}

#[tauri::command]
fn app_install_info() -> AppInstallInfo {
    let executable = std::env::current_exe().ok();
    let appimage_path = std::env::var("APPIMAGE").ok();
    detect_app_install_info(current_os(), executable.as_deref(), appimage_path)
}

const TUNNEL_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Run a small local CLI probe without allowing an unhealthy executable to
/// stall the Tauri command indefinitely. A missing executable is normal.
fn probe_command(command: &str, args: &[&str]) -> Option<Output> {
    let mut child = Command::new(command)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + TUNNEL_PROBE_TIMEOUT;

    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn first_version_line(output: &Output) -> Option<String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    first_non_empty_line(&stdout, &stderr)
}

fn first_non_empty_line(stdout: &str, stderr: &str) -> Option<String> {
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

/// `Some(None)` means the executable ran successfully but did not print a
/// parseable version line, which is still an installed tool.
fn probe_version(command: &str, args: &[&str]) -> Option<Option<String>> {
    let output = probe_command(command, args)?;
    if output.status.success() {
        Some(first_version_line(&output))
    } else {
        None
    }
}

fn tailscale_detail_from_status_json(output: &Output) -> Option<String> {
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    tailscale_detail_from_status_json_text(&stdout)
}

fn tailscale_detail_from_status_json_text(status_json: &str) -> Option<String> {
    let status: serde_json::Value = serde_json::from_str(status_json).ok()?;
    let state = status.get("BackendState")?.as_str()?;
    Some(tailscale_detail_from_backend_state(state))
}

fn tailscale_detail_from_backend_state(state: &str) -> String {
    if state.eq_ignore_ascii_case("running") {
        "connected".to_string()
    } else {
        "installed, not logged in".to_string()
    }
}

fn tailscale_detail(command: &str) -> String {
    if let Some(output) = probe_command(command, &["status", "--json"]) {
        if let Some(detail) = tailscale_detail_from_status_json(&output) {
            return detail;
        }
    }
    if let Some(output) = probe_command(command, &["ip", "-4"]) {
        if output.status.success()
            && String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|line| !line.trim().is_empty())
        {
            return "connected".to_string();
        }
    }
    "installed, not logged in".to_string()
}

fn detect_tunnel_tools_blocking() -> TunnelTools {
    let cloudflared = match probe_version("cloudflared", &["--version"]) {
        Some(version) => ToolInfo {
            installed: true,
            version,
            detail: None,
        },
        None => ToolInfo::absent(),
    };

    let tailscale_probe = if let Some(version) = probe_version("tailscale", &["version"]) {
        Some(("tailscale", version))
    } else {
        #[cfg(target_os = "macos")]
        {
            let app_cli = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
            probe_version(app_cli, &["version"]).map(|version| (app_cli, version))
        }
        #[cfg(not(target_os = "macos"))]
        {
            None
        }
    };
    let tailscale = match tailscale_probe {
        Some((command, version)) => ToolInfo {
            installed: true,
            version,
            detail: Some(tailscale_detail(command)),
        },
        None => ToolInfo::absent(),
    };

    TunnelTools {
        cloudflared,
        tailscale,
    }
}

/// Detect the locally-installed tunnel clients. This detects and guides only;
/// `cloudflared tunnel login` and `tailscale up` intentionally stay interactive.
#[tauri::command]
async fn detect_tunnel_tools() -> TunnelTools {
    match tokio::task::spawn_blocking(detect_tunnel_tools_blocking).await {
        Ok(tools) => tools,
        Err(_) => TunnelTools {
            cloudflared: ToolInfo::absent(),
            tailscale: ToolInfo::absent(),
        },
    }
}

/// Hand `url` to an external player. `preferred` (a value from
/// `list_external_players`) is tried first; otherwise the default order is used.
fn open_in_external_player_blocking(
    url: String,
    preferred: Option<String>,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        // Preferred first (when still installed), then the default order.
        let mut order: Vec<String> = Vec::new();
        if let Some(p) = preferred.as_deref() {
            if !p.is_empty() {
                order.push(p.to_string());
            }
        }
        for app in MACOS_PLAYERS {
            if !order.iter().any(|o| o == app) {
                order.push(app.to_string());
            }
        }
        for app in &order {
            let opened = if app == "mpv" {
                // CLI mpv: spawn directly (no .app).
                Command::new("mpv").arg(&url).spawn().is_ok()
            } else {
                Command::new("open")
                    .args(["-a", app, &url])
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false)
            };
            if opened {
                return Ok(format!("Opened in {app}"));
            }
        }
        Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok("Opened with the system default handler".into())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let mut order: Vec<String> = Vec::new();
        if let Some(p) = preferred {
            if !p.is_empty() {
                order.push(p);
            }
        }
        for bin in ["mpv", "vlc"] {
            if !order.iter().any(|o| o == bin) {
                order.push(bin.to_string());
            }
        }
        for bin in &order {
            if Command::new(bin).arg(&url).spawn().is_ok() {
                return Ok(format!("Opened in {bin}"));
            }
        }
        Err("No external player (mpv/vlc) found on PATH".into())
    }
}

#[tauri::command]
async fn open_in_external_player(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, playback_proxy::ExternalPlaybackState>,
    url: String,
    preferred: Option<String>,
    stream_authorization: Option<String>,
) -> Result<String, String> {
    let lease = playback_auth::authenticated_playback_for_window(
        &window,
        &url,
        stream_authorization.as_deref(),
    )?
    .map(playback_proxy::start)
    .transpose()?;
    let handoff_url = lease
        .as_ref()
        .map(|lease| lease.url().to_string())
        .unwrap_or(url);
    let status = tokio::task::spawn_blocking(move || {
        open_in_external_player_blocking(handoff_url, preferred)
    })
    .await
    .map_err(|error| error.to_string())??;
    state.set(lease);
    Ok(status)
}

/// Reveal a completed download without opening the media file. Every platform
/// command receives the path as one argument, never through a shell, and any
/// launch/status failure is returned to the webview as a normal Tauri error.
fn reveal_in_file_manager_blocking(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .args(["-R", path.as_str()])
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            return Ok(());
        }
        Err(format!("open -R exited with {status}"))
    }

    #[cfg(target_os = "windows")]
    {
        let status = Command::new("explorer")
            .arg(format!("/select,{path}"))
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("explorer exited with {status}"));
    }

    #[cfg(target_os = "linux")]
    {
        let directory = Path::new(&path)
            .parent()
            .filter(|directory| !directory.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let status = Command::new("xdg-open")
            .arg(directory)
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("xdg-open exited with {status}"));
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = path;
        Err("Revealing files is not supported on this platform".to_string())
    }
}

#[tauri::command]
async fn reveal_in_file_manager(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || reveal_in_file_manager_blocking(path))
        .await
        .map_err(|error| error.to_string())?
}

/// macOS: the window is created `transparent: true` so the in-window player can
/// reveal a native video layer through the webview. Give the NSWindow an opaque
/// app-color background permanently. The video view lives above this background
/// and below the webview. The webview itself is made opaque separately at startup
/// and becomes transparent only for the render player's lifetime.
#[cfg(target_os = "macos")]
fn opaque_window_background<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use objc2_app_kit::{NSColor, NSWindow};
    use tauri::Manager;
    let Some(win) = app.webview_windows().into_values().next() else {
        return;
    };
    let Ok(ns) = win.ns_window() else { return };
    // Setup runs on the main thread; NSWindow properties must be set there.
    let ns_window: &NSWindow = unsafe { &*(ns as *const NSWindow) };
    // The default Midnight --bg-1, shared with the WKWebView fallback.
    let (red, green, blue) = render_player::APP_BASE_BACKGROUND_RGB;
    let color =
        NSColor::colorWithSRGBRed_green_blue_alpha(red / 255.0, green / 255.0, blue / 255.0, 1.0);
    ns_window.setBackgroundColor(Some(&color));
    ns_window.setOpaque(true);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Native HTTP client used by the webview (`@tauri-apps/plugin-http`) to
        // reach indexer/debrid/addon hosts without the browser CORS policy.
        .plugin(tauri_plugin_http::init())
        // Shell plugin: used from Rust to spawn the bundled mpv sidecar (P1).
        .plugin(tauri_plugin_shell::init())
        // Process plugin: lets the webview `relaunch()` the app after the
        // auto-updater downloads + installs a new version (see updater.ts).
        .plugin(tauri_plugin_process::init())
        // Authenticated external-player handoffs use one revocable loopback
        // capability at a time, without exporting server credentials.
        .manage(playback_proxy::ExternalPlaybackState::default())
        // At-most-one in-window render-API player (v0.5). On mobile this resolves
        // to the libmpv-free stub in render_player/stub.rs.
        .manage(render_player::PlayerState::default());

    // State owned by the desktop-only modules above.
    #[cfg(desktop)]
    {
        builder = builder
            // At-most-one mpv instance, shared across the mpv_* commands.
            .manage(player::MpvState::default())
            // At-most-one local DebridStreamer server process.
            .manage(server_host::ServerState::default())
            // All active and paused download/transcode jobs, keyed by frontend UUID.
            .manage(downloads::DownloadsState::default());
    }

    // Auto-updater is desktop-only. The JS side (web/src/lib/updater.ts) calls
    // the plugin's `check()` once on launch; releases are signed with the
    // updater keypair and published as `latest.json` on GitHub Releases.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    let builder = builder.setup(|app| {
        #[cfg(target_os = "macos")]
        opaque_window_background(app.handle());
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        render_player::set_initial_webview_opaque(app.handle()).map_err(std::io::Error::other)?;
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        render_player::debug_log_startup();
        // Dev-only player smoke: DS_PLAYER_SMOKE=<url> auto-loads a stream in
        // the in-window player a few seconds after launch, so the surface can
        // be exercised without configuring indexers/debrid.
        #[cfg(all(
            debug_assertions,
            any(target_os = "macos", target_os = "windows", target_os = "linux")
        ))]
        if let Ok(url) = std::env::var("DS_PLAYER_SMOKE") {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                if let Err(e) = render_player::create_player(
                    handle.clone(),
                    std::collections::HashMap::new(),
                    Vec::new(),
                ) {
                    eprintln!("DS_PLAYER_SMOKE create failed: {e}");
                    return;
                }
                use tauri::Manager;
                let state = handle.state::<render_player::PlayerState>();
                let guard = state.0.lock().ok();
                if let Some(p) = guard.as_ref().and_then(|g| g.as_ref()) {
                    if let Err(e) = render_player::run_mpv_command(&p.mpv, "loadfile", &[&url]) {
                        eprintln!("DS_PLAYER_SMOKE loadfile failed: {e}");
                    }
                }
                // NOTE: the video renders BEHIND the webview; unless the page
                // adds `mpv-active` on <html> (EmbeddedPlayer does), the page
                // hides it. This smoke exercises the native surface + decode
                // path; visibility is verified through the real player UI.
            });
        }
        let _ = &app;
        Ok(())
    });

    // generate_handler! cannot cfg individual entries, so mobile gets its own
    // list: the desktop-only modules are not compiled in at all there.
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        app_install_info,
        render_player::player_init,
        render_player::player_load,
        render_player::player_command,
        render_player::player_set_property,
        render_player::player_get_property,
        render_player::player_add_subtitle,
        render_player::player_set_audio_passthrough,
        render_player::player_set_hdr_policy,
        render_player::player_set_video_margin,
        render_player::player_set_rect,
        render_player::player_destroy,
        cast::cast_discover,
        cast::cast_load,
        cast::cast_control,
        cast::cast_status,
        cast::cast_set_volume,
    ]);

    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        open_in_external_player,
        list_external_players,
        detect_tunnel_tools,
        reveal_in_file_manager,
        app_install_info,
        player::mpv_play,
        player::mpv_pause,
        player::mpv_resume,
        player::mpv_seek,
        player::mpv_get_position,
        player::mpv_stop,
        render_player::player_init,
        render_player::player_load,
        render_player::player_command,
        render_player::player_set_property,
        render_player::player_get_property,
        render_player::player_add_subtitle,
        render_player::player_set_audio_passthrough,
        render_player::player_set_hdr_policy,
        render_player::player_set_video_margin,
        render_player::player_set_rect,
        render_player::player_destroy,
        keychain::keychain_get,
        keychain::keychain_set,
        keychain::keychain_delete,
        server_host::desktop_server_status,
        server_host::desktop_server_start,
        server_host::desktop_server_stop,
        downloads::download_start,
        downloads::download_pause,
        downloads::download_resume,
        downloads::download_cancel,
        downloads::download_force_stop,
        downloads::transcode_start,
        downloads::transcode_cancel,
        downloads::downloads_ffmpeg_available,
        downloads::downloads_default_dir,
        downloads::downloads_available_space,
        downloads::download_delete_file,
        cast::cast_discover,
        cast::cast_load,
        cast::cast_control,
        cast::cast_status,
        cast::cast_set_volume,
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{classify_install_format, detect_app_install_info, nearest_app_bundle_ancestor};
    use std::path::Path;

    #[test]
    fn finds_the_nearest_macos_app_bundle_ancestor() {
        let executable =
            Path::new("/Applications/DebridStreamer.app/Contents/MacOS/DebridStreamer");
        assert_eq!(
            nearest_app_bundle_ancestor(executable).as_deref(),
            Some("/Applications/DebridStreamer.app")
        );
        assert_eq!(
            nearest_app_bundle_ancestor(Path::new("/usr/local/bin/debridstreamer")),
            None
        );
    }

    #[test]
    fn classifies_install_formats_from_paths_and_appimage() {
        assert_eq!(
            classify_install_format(
                "macos",
                Some(Path::new(
                    "/Applications/DebridStreamer.app/Contents/MacOS/DebridStreamer"
                )),
                None,
                Some("/Applications/DebridStreamer.app"),
            ),
            "macos-app"
        );
        assert_eq!(
            classify_install_format("windows", None, None, None),
            "windows"
        );
        assert_eq!(
            classify_install_format(
                "linux",
                Some(Path::new("/tmp/DebridStreamer")),
                Some("/tmp/DebridStreamer.AppImage"),
                None
            ),
            "linux-appimage"
        );
        assert_eq!(
            classify_install_format(
                "linux",
                Some(Path::new("/usr/bin/debridstreamer")),
                None,
                None
            ),
            "linux-deb"
        );
        assert_eq!(
            classify_install_format("linux", Some(Path::new("/opt/debridstreamer")), None, None),
            "unknown"
        );
    }

    #[test]
    fn reports_only_platform_relevant_paths() {
        let info = detect_app_install_info(
            "linux",
            Some(Path::new("/usr/bin/debridstreamer")),
            Some("/tmp/DebridStreamer.AppImage".to_string()),
        );
        assert_eq!(info.format, "linux-appimage");
        assert_eq!(info.app_bundle_path, None);
        assert_eq!(
            info.appimage_path.as_deref(),
            Some("/tmp/DebridStreamer.AppImage")
        );
    }
}

#[cfg(test)]
mod tunnel_tool_tests {
    use super::{
        first_non_empty_line, tailscale_detail_from_backend_state,
        tailscale_detail_from_status_json_text,
    };

    #[test]
    fn version_line_prefers_stdout_and_trims_whitespace() {
        assert_eq!(
            first_non_empty_line("\n cloudflared version 2026.1.0 \n", "fallback"),
            Some("cloudflared version 2026.1.0".to_string())
        );
    }

    #[test]
    fn version_line_uses_stderr_when_stdout_is_empty() {
        assert_eq!(
            first_non_empty_line("", "\n1.82.0\n"),
            Some("1.82.0".to_string())
        );
    }

    #[test]
    fn tailscale_backend_state_is_human_readable() {
        assert_eq!(tailscale_detail_from_backend_state("Running"), "connected");
        assert_eq!(
            tailscale_detail_from_backend_state("NeedsLogin"),
            "installed, not logged in"
        );
    }

    #[test]
    fn tailscale_status_json_is_interpreted_without_panicking() {
        assert_eq!(
            tailscale_detail_from_status_json_text(r#"{"BackendState":"Running"}"#),
            Some("connected".to_string())
        );
        assert_eq!(tailscale_detail_from_status_json_text("not json"), None);
    }
}
