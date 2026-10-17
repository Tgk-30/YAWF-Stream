const MAX_EXTERNAL_PLAYER_URL_BYTES: usize = 8 * 1024;
const INVALID_URL_MESSAGE: &str = "The stream link is not a valid HTTP(S) URL.";
const DISPATCH_PENDING: u8 = 0;
const DISPATCH_CANCELLED: u8 = 1;
const DISPATCHING: u8 = 2;

struct ChooserDispatchState(std::sync::atomic::AtomicU8);

impl ChooserDispatchState {
    fn pending() -> Self {
        Self(std::sync::atomic::AtomicU8::new(DISPATCH_PENDING))
    }

    /** Claim the irreversible startActivity boundary. */
    fn begin_dispatch(&self) -> bool {
        self.0
            .compare_exchange(
                DISPATCH_PENDING,
                DISPATCHING,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_ok()
    }

    /** Cancel only while Android launch is still preventable. */
    fn cancel_pending(&self) -> bool {
        self.0
            .compare_exchange(
                DISPATCH_PENDING,
                DISPATCH_CANCELLED,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_ok()
    }

    fn is_pending(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Acquire) == DISPATCH_PENDING
    }

    #[cfg(test)]
    fn value(&self) -> u8 {
        self.0.load(std::sync::atomic::Ordering::Acquire)
    }
}

fn canonical_external_player_url(raw: &str) -> Result<String, &'static str> {
    if raw.is_empty()
        || raw.len() > MAX_EXTERNAL_PLAYER_URL_BYTES
        || raw.trim() != raw
        || raw.chars().any(char::is_control)
    {
        return Err(INVALID_URL_MESSAGE);
    }

    let parsed = tauri::Url::parse(raw).map_err(|_| INVALID_URL_MESSAGE)?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none_or(str::is_empty)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(INVALID_URL_MESSAGE);
    }

    let canonical = parsed.to_string();
    if canonical.len() > MAX_EXTERNAL_PLAYER_URL_BYTES {
        return Err(INVALID_URL_MESSAGE);
    }
    Ok(canonical)
}

#[cfg(target_os = "android")]
fn prepare_android_chooser<'local>(
    env: &mut jni::JNIEnv<'local>,
    url: &str,
) -> jni::errors::Result<jni::objects::JObject<'local>> {
    use jni::objects::{JObject, JValue};

    let action = JObject::from(env.new_string("android.intent.action.VIEW")?);
    let intent = env.new_object(
        "android/content/Intent",
        "(Ljava/lang/String;)V",
        &[JValue::Object(&action)],
    )?;

    let url = JObject::from(env.new_string(url)?);
    let uri = env
        .call_static_method(
            "android/net/Uri",
            "parse",
            "(Ljava/lang/String;)Landroid/net/Uri;",
            &[JValue::Object(&url)],
        )?
        .l()?;
    let mime_type = JObject::from(env.new_string("video/*")?);
    env.call_method(
        &intent,
        "setDataAndType",
        "(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/Intent;",
        &[JValue::Object(&uri), JValue::Object(&mime_type)],
    )?;

    let chooser_title = JObject::from(env.new_string("Open with video player")?);
    env.call_static_method(
        "android/content/Intent",
        "createChooser",
        "(Landroid/content/Intent;Ljava/lang/CharSequence;)Landroid/content/Intent;",
        &[JValue::Object(&intent), JValue::Object(&chooser_title)],
    )?
    .l()
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn mobile_open_external_player(
    webview: tauri::Webview,
    url: String,
) -> Result<String, String> {
    let canonical = canonical_external_player_url(&url).map_err(str::to_string)?;

    use std::sync::Arc;
    use std::time::Duration;

    const CHOOSER_DISPATCH_TIMEOUT: Duration = Duration::from_secs(4);
    const OPEN_FAILED: &str = "The Android player chooser could not be opened.";

    let dispatch_state = Arc::new(ChooserDispatchState::pending());
    let callback_state = Arc::clone(&dispatch_state);
    let (sender, mut receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            platform_webview.jni_handle().exec(move |env, activity, _| {
                if !callback_state.is_pending() {
                    let _ = sender.send(false);
                    return;
                }
                let chooser = match prepare_android_chooser(env, &canonical) {
                    Ok(chooser) => chooser,
                    Err(_) => {
                        if env.exception_check().unwrap_or(false) {
                            let _ = env.exception_clear();
                        }
                        let _ = sender.send(false);
                        return;
                    }
                };
                // This CAS is the last operation before startActivity. A
                // deadline that wins during JNI argument preparation cancels
                // the launch; a deadline after this point must await its result.
                if !callback_state.begin_dispatch() {
                    let _ = sender.send(false);
                    return;
                }
                let opened = env
                    .call_method(
                        activity,
                        "startActivity",
                        "(Landroid/content/Intent;)V",
                        &[jni::objects::JValue::Object(&chooser)],
                    )
                    .is_ok();
                if !opened && env.exception_check().unwrap_or(false) {
                    let _ = env.exception_clear();
                }
                let _ = sender.send(opened);
            });
        })
        .map_err(|_| OPEN_FAILED.to_string())?;

    match tokio::time::timeout(CHOOSER_DISPATCH_TIMEOUT, &mut receiver).await {
        Ok(Ok(true)) => Ok("Player chooser opened. Select a video app to continue.".to_string()),
        Ok(Ok(false)) | Ok(Err(_)) => Err(OPEN_FAILED.to_string()),
        Err(_) if dispatch_state.cancel_pending() => {
            Err("The Android player chooser did not respond.".to_string())
        }
        Err(_) => {
            // startActivity already crossed its irreversible boundary. Do not
            // report a timeout while the chooser may still open.
            match receiver.await {
                Ok(true) => {
                    Ok("Player chooser opened. Select a video app to continue.".to_string())
                }
                Ok(false) | Err(_) => Err(OPEN_FAILED.to_string()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_external_player_url, ChooserDispatchState, DISPATCHING, DISPATCH_CANCELLED,
        MAX_EXTERNAL_PLAYER_URL_BYTES,
    };

    #[test]
    fn canonicalizes_valid_http_and_https_stream_urls() {
        assert_eq!(
            canonical_external_player_url("https://media.example/video?id=42").unwrap(),
            "https://media.example/video?id=42"
        );
        assert_eq!(
            canonical_external_player_url("http://127.0.0.1:43110").unwrap(),
            "http://127.0.0.1:43110/"
        );
    }

    #[test]
    fn rejects_non_network_or_hostless_urls() {
        for rejected in [
            "file:///sdcard/movie.mp4",
            "content://media/external/video/1",
            "intent://media.example/video",
            "javascript:alert(1)",
            "//media.example/video",
            "https://",
        ] {
            assert!(
                canonical_external_player_url(rejected).is_err(),
                "{rejected}"
            );
        }
    }

    #[test]
    fn rejects_credentials_controls_and_surrounding_whitespace() {
        for rejected in [
            "https://user:secret@media.example/video",
            "https://media.example/video\nnext",
            " https://media.example/video",
            "https://media.example/video\u{7f}",
        ] {
            assert!(canonical_external_player_url(rejected).is_err());
        }
    }

    #[test]
    fn rejects_oversized_urls_without_echoing_them() {
        let marker = "private-stream-marker";
        let oversized = format!(
            "https://media.example/video?{}{}",
            marker,
            "x".repeat(MAX_EXTERNAL_PLAYER_URL_BYTES)
        );
        let error = canonical_external_player_url(&oversized).unwrap_err();
        assert!(!error.contains(marker));
    }

    #[test]
    fn dispatch_deadline_cancels_before_android_preparation_starts() {
        let state = ChooserDispatchState::pending();

        assert!(state.cancel_pending());
        assert!(!state.begin_dispatch());
        assert_eq!(state.value(), DISPATCH_CANCELLED);
    }

    #[test]
    fn dispatch_deadline_cancels_while_android_intent_is_being_prepared() {
        let state = ChooserDispatchState::pending();
        assert!(state.is_pending());

        assert!(state.cancel_pending());
        assert!(!state.begin_dispatch());
        assert_eq!(state.value(), DISPATCH_CANCELLED);
    }

    #[test]
    fn dispatch_started_before_deadline_cannot_be_reported_as_cancelled() {
        let state = ChooserDispatchState::pending();

        assert!(state.begin_dispatch());
        assert!(!state.cancel_pending());
        assert_eq!(state.value(), DISPATCHING);
    }
}
