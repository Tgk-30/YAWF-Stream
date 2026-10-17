//! Local-only entry to the native, fixed-channel Android update dialog.
#[cfg(target_os = "android")]
#[tauri::command]
pub async fn mobile_check_android_updates(webview: tauri::Webview) -> Result<(), String> {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let pending = Arc::new(AtomicBool::new(true));
    let callback_pending = Arc::clone(&pending);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform| {
            platform.jni_handle().exec(move |env, activity, _| {
                if !callback_pending.swap(false, Ordering::AcqRel) {
                    return;
                }
                let opened = env
                    .call_method(activity, "checkAndroidUpdates", "()V", &[])
                    .is_ok();
                if !opened && env.exception_check().unwrap_or(false) {
                    let _ = env.exception_clear();
                }
                let _ = sender.send(opened);
            });
        })
        .map_err(|_| "The native Android update dialog is unavailable.".to_string())?;
    match tokio::time::timeout(std::time::Duration::from_secs(4), receiver).await {
        Ok(Ok(true)) => Ok(()),
        _ => {
            pending.store(false, Ordering::Release);
            Err("The native Android update dialog did not respond.".to_string())
        }
    }
}
