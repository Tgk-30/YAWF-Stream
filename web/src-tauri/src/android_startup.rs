//! Android-only private native startup. The Tao event loop is never parked here.
use jni::{
    objects::{GlobalRef, JClass, JObject, JString, JValue},
    sys::{jint, jlong},
    JNIEnv, JavaVM, NativeMethod,
};
use std::sync::{
    atomic::{AtomicBool, AtomicI64, Ordering},
    mpsc::{self, Sender},
    OnceLock,
};
use tauri::{utils::config::WindowConfig, AppHandle, Manager, WebviewWindow, WebviewWindowBuilder};

const READY: i32 = 1;
const AUTHORIZED: i32 = 2;
const ATTACHED: i32 = 3;
const CANCELLED: i32 = 4;
const REFUSED: i32 = 5;
const DESTROYED: i32 = 6;
const CREATION_FAILED: i32 = 7;
static STARTED: AtomicBool = AtomicBool::new(false);
static BOOTSTRAP_EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);
static COMMITTED: AtomicBool = AtomicBool::new(false);
static CONSTRUCTION: AtomicI64 = AtomicI64::new(0);
static EVENTS: OnceLock<Sender<(i32, i64)>> = OnceLock::new();
static LABEL: OnceLock<String> = OnceLock::new();

pub(crate) fn defer_main_window(context: &mut tauri::Context<tauri::Wry>) -> WindowConfig {
    let windows = &mut context.config_mut().app.windows;
    assert_eq!(
        windows.iter().filter(|w| w.create).count(),
        1,
        "Android startup requires the single configured main window"
    );
    let main = windows
        .iter_mut()
        .find(|w| w.label == "main" && w.create)
        .expect("Android configured main window is missing");
    let original = main.clone();
    main.create = false;
    original
}

pub(crate) fn keep_startup_alive(code: Option<i32>) -> bool {
    code.is_none() && STARTED.load(Ordering::Acquire) && !COMMITTED.load(Ordering::Acquire)
}

pub(crate) fn window_destroyed(label: &str) {
    if LABEL.get().is_some_and(|expected| expected == label) && !COMMITTED.load(Ordering::Acquire) {
        if let Some(events) = EVENTS.get() {
            let _ = events.send((DESTROYED, 0));
        }
    }
}

// Registered only on the kept app-private helper class. Never a JS/Tauri command.
unsafe extern "system" fn native_signal(_env: JNIEnv, _class: JClass, kind: jint, ticket: jlong) {
    if ticket <= 0 || !(READY..=REFUSED).contains(&kind) {
        return;
    }
    if let Some(events) = EVENTS.get() {
        let _ = events.send((kind, ticket));
    }
}

pub(crate) fn start(app: AppHandle, config: WindowConfig) {
    if STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let _ = LABEL.set(config.label.clone());
    let (sender, receiver) = mpsc::channel();
    let _ = EVENTS.set(sender);
    // A dedicated receiver worker can sleep indefinitely without stopping Tao's
    // lifecycle pipe, Android UI, Retry, Back or later same-process Activity entry.
    let exit_app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("yawf-webview-startup".into())
        .spawn(move || {
            let Ok((vm, helper)) = connect_helper() else {
                bootstrap_failed(&app);
                return;
            };
            let Ok(mut env) = vm.attach_current_thread_as_daemon() else {
                bootstrap_failed(&app);
                return;
            };
            if call(&mut env, &helper, "onBridgeReady", "()V", &[]).is_err() {
                bootstrap_failed(&app);
                return;
            }
            let mut pending: Option<(i64, WebviewWindow)> = None;
            let mut destroying: Option<i64> = None;
            while let Ok((kind, ticket)) = receiver.recv() {
                match kind {
                    READY
                        if !COMMITTED.load(Ordering::Acquire)
                            && pending.is_none()
                            && destroying.is_none() =>
                    {
                        CONSTRUCTION.store(ticket, Ordering::Release);
                        if call(
                            &mut env,
                            &helper,
                            "authorizeConstruction",
                            "(J)V",
                            &[JValue::Long(ticket)],
                        )
                        .is_err()
                        {
                            fail_and_clear(&mut env, &helper, ticket);
                        }
                    }
                    AUTHORIZED
                        if !COMMITTED.load(Ordering::Acquire)
                            && pending.is_none()
                            && destroying.is_none()
                            && CONSTRUCTION.load(Ordering::Acquire) == ticket =>
                    {
                        let authorized = call(
                            &mut env,
                            &helper,
                            "isConstructionAuthorized",
                            "(J)Z",
                            &[JValue::Long(ticket)],
                        )
                        .and_then(|value| value.z())
                        .unwrap_or(false);
                        if !authorized {
                            clear(&mut env, &helper, ticket);
                            continue;
                        }
                        if app.get_webview_window(&config.label).is_some() {
                            // Never replace or destroy an unowned/preexisting window.
                            fail_and_clear(&mut env, &helper, ticket);
                            continue;
                        }
                        let result = WebviewWindowBuilder::from_config(&app, &config)
                            .and_then(|builder| builder.build());
                        match result {
                            Ok(window) => {
                                // build() only queues Android construction. No completion claim here.
                                let proof_window = window.clone();
                                pending = Some((ticket, window));
                                if queue_storage_proof(&proof_window, &helper, ticket).is_err() {
                                    let _ = call(
                                        &mut env,
                                        &helper,
                                        "constructionFailed",
                                        "(J)V",
                                        &[JValue::Long(ticket)],
                                    );
                                    destroy_pending(&mut pending, &mut destroying);
                                }
                            }
                            Err(_) => {
                                let _ = call(
                                    &mut env,
                                    &helper,
                                    "constructionFailed",
                                    "(J)V",
                                    &[JValue::Long(ticket)],
                                );
                                if let Some(window) = app.get_webview_window(&config.label) {
                                    // This label was absent immediately before our sole create attempt.
                                    pending = Some((ticket, window));
                                    destroy_pending(&mut pending, &mut destroying);
                                } else {
                                    clear(&mut env, &helper, ticket);
                                }
                            }
                        }
                    }
                    ATTACHED
                        if pending
                            .as_ref()
                            .is_some_and(|(expected, _)| *expected == ticket) =>
                    {
                        let attached = call(
                            &mut env,
                            &helper,
                            "isAttached",
                            "(J)Z",
                            &[JValue::Long(ticket)],
                        )
                        .and_then(|value| value.z())
                        .unwrap_or(false);
                        if attached {
                            COMMITTED.store(true, Ordering::Release);
                            pending = None;
                        }
                    }
                    CREATION_FAILED
                        if !COMMITTED.load(Ordering::Acquire)
                            && pending
                                .as_ref()
                                .is_some_and(|(expected, _)| *expected == ticket) =>
                    {
                        let _ = call(
                            &mut env,
                            &helper,
                            "constructionFailed",
                            "(J)V",
                            &[JValue::Long(ticket)],
                        );
                        destroy_pending(&mut pending, &mut destroying);
                    }
                    CANCELLED if !COMMITTED.load(Ordering::Acquire) => {
                        if pending
                            .as_ref()
                            .is_some_and(|(expected, _)| *expected == ticket)
                        {
                            destroy_pending(&mut pending, &mut destroying);
                        } else if CONSTRUCTION.load(Ordering::Acquire) == ticket {
                            clear(&mut env, &helper, ticket);
                        }
                    }
                    REFUSED
                        if pending.is_none() && CONSTRUCTION.load(Ordering::Acquire) == ticket =>
                    {
                        clear(&mut env, &helper, ticket);
                    }
                    DESTROYED => {
                        if let Some(old) = destroying.take() {
                            pending = None;
                            clear(&mut env, &helper, old);
                        }
                    }
                    _ => {}
                }
            }
        });
    if spawned.is_err() {
        bootstrap_failed(&exit_app);
    }
}

fn bootstrap_failed(app: &AppHandle) {
    if !BOOTSTRAP_EXIT_REQUESTED.swap(true, Ordering::AcqRel) {
        // STARTED stays poisoned. Explicit exit(1), never a duplicate worker or restart.
        app.exit(1);
    }
}

fn queue_storage_proof(
    window: &WebviewWindow,
    helper: &GlobalRef,
    ticket: i64,
) -> tauri::Result<()> {
    let helper = helper.clone();
    let exit_app = window.app_handle().clone();
    window.with_webview(move |platform| {
        platform.jni_handle().exec(move |env, _activity, webview| {
            // This message shares Wry's FIFO with CreateWebView. Only the exact
            // synchronously accepted object after ACTIVITY_PROXY storage qualifies.
            let attached = CONSTRUCTION.load(Ordering::Acquire) == ticket
                && call(
                    env,
                    &helper,
                    "constructionStored",
                    "(JLandroid/webkit/WebView;)Z",
                    &[JValue::Long(ticket), JValue::Object(webview)],
                )
                .and_then(|value| value.z())
                .unwrap_or(false);
            if let Some(events) = EVENTS.get() {
                if events
                    .send((if attached { ATTACHED } else { CREATION_FAILED }, ticket))
                    .is_ok()
                {
                    if attached {
                        COMMITTED.store(true, Ordering::Release);
                    }
                } else {
                    bootstrap_failed(&exit_app);
                }
            } else {
                bootstrap_failed(&exit_app);
            }
        });
    })
}

fn destroy_pending(pending: &mut Option<(i64, WebviewWindow)>, destroying: &mut Option<i64>) {
    if destroying.is_some() {
        return;
    }
    if let Some((ticket, window)) = pending.as_ref() {
        if window.destroy().is_ok() {
            *destroying = Some(*ticket);
        }
        // If destruction fails, quarantine remains. Never blindly create a second window.
    }
}

fn clear(env: &mut JNIEnv, helper: &GlobalRef, ticket: i64) {
    let _ = CONSTRUCTION.compare_exchange(ticket, 0, Ordering::AcqRel, Ordering::Acquire);
    let _ = call(
        env,
        helper,
        "constructionCleared",
        "(J)V",
        &[JValue::Long(ticket)],
    );
}
fn fail_and_clear(env: &mut JNIEnv, helper: &GlobalRef, ticket: i64) {
    let _ = call(
        env,
        helper,
        "constructionFailed",
        "(J)V",
        &[JValue::Long(ticket)],
    );
    clear(env, helper, ticket);
}
fn call<'a>(
    env: &mut JNIEnv<'a>,
    helper: &GlobalRef,
    method: &str,
    signature: &str,
    args: &[JValue],
) -> jni::errors::Result<jni::objects::JValueOwned<'a>> {
    let result = env.call_static_method(helper, method, signature, args);
    if result.is_err() {
        let _ = env.exception_clear();
    }
    result
}

fn connect_helper() -> Result<(JavaVM, GlobalRef), ()> {
    // Ready follows normal Android onCreate/context setup. Application context
    // survives zero-window Back/reentry, unlike a cached Activity/pthread FindClass.
    // Locked Tao 0.37.1 retains APPLICATION_CONTEXT as a OnceLock<GlobalRef> and
    // initializes ndk_context from it before setup; Activity removal does not clear it.
    let context = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(context.vm().cast()) }.map_err(|_| ())?;
    let helper = {
        let mut env = vm.attach_current_thread_as_daemon().map_err(|_| ())?;
        let application = unsafe { JObject::from_raw(context.context().cast()) };
        let loader = env
            .call_method(
                &application,
                "getClassLoader",
                "()Ljava/lang/ClassLoader;",
                &[],
            )
            .and_then(|v| v.l())
            .map_err(|_| ())?;
        let package: JString = env
            .call_method(&application, "getPackageName", "()Ljava/lang/String;", &[])
            .and_then(|v| v.l())
            .map_err(|_| ())?
            .into();
        let package: String = env.get_string(&package).map_err(|_| ())?.into();
        let name = env
            .new_string(format!("{package}.YawfWebViewStartup"))
            .map_err(|_| ())?;
        let class: JClass = env
            .call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[(&name).into()],
            )
            .and_then(|v| v.l())
            .map_err(|_| ())?
            .into();
        env.register_native_methods(
            &class,
            &[NativeMethod {
                name: "nativeSignal".into(),
                sig: "(IJ)V".into(),
                fn_ptr: native_signal as *mut std::ffi::c_void,
            }],
        )
        .map_err(|_| ())?;
        env.new_global_ref(&class).map_err(|_| ())?
    };
    Ok((vm, helper))
}
