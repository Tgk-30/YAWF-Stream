// libmpv-free stub for platforms without an in-window surface: mobile, and any
// desktop OS before its surface lands. Provides the same Tauri command surface
// as `core.rs`, but returns errors instead of touching libmpv - so the crate
// links on every target without needing libmpv where no surface exists.
//
// This MUST stay command-for-command identical to core.rs. generate_handler!
// resolves every entry through this module on those targets, so a command that
// exists only in core.rs fails the build with a bare "cannot find
// __cmd__<name>" rather than anything pointing at the real cause.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Runtime, State, WebviewWindow, Window};

// Mirrors core.rs's PlayerState so `.manage()` and every command signature line
// up; the stub never stores anything in it.
#[derive(Default)]
pub struct PlayerState(#[allow(dead_code)] pub Mutex<Option<()>>);

const UNSUPPORTED: &str = "the in-window player is not available on this platform yet";

#[tauri::command]
pub fn player_init<R: Runtime>(
    _app: AppHandle<R>,
    _options: HashMap<String, String>,
    _observed: Vec<serde_json::Value>,
) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn player_load<R: Runtime>(
    _app: AppHandle<R>,
    _window: Window<R>,
    _state: State<'_, PlayerState>,
    _url: String,
) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn player_command<R: Runtime>(
    _window: WebviewWindow<R>,
    _state: State<'_, PlayerState>,
    _args: Vec<String>,
    _stream_authorization: Option<String>,
) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn player_set_property(
    _state: State<'_, PlayerState>,
    _name: String,
    _value: String,
) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn player_get_property(
    _state: State<'_, PlayerState>,
    _name: String,
) -> Result<serde_json::Value, String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn player_add_subtitle(
    _state: State<'_, PlayerState>,
    _contents: String,
    _label: String,
    _language: String,
) -> Result<i64, String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn player_set_audio_passthrough(
    _state: State<'_, PlayerState>,
    _enabled: bool,
) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn player_set_hdr_policy(
    _state: State<'_, PlayerState>,
    _policy: String,
) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn player_set_video_margin(_state: State<'_, PlayerState>, _bottom: f64) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn player_set_rect(
    _state: State<'_, PlayerState>,
    _x: i32,
    _y: i32,
    _width: i32,
    _height: i32,
) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn player_destroy<R: Runtime>(
    _app: AppHandle<R>,
    _state: State<'_, PlayerState>,
) -> Result<(), String> {
    Ok(())
}
