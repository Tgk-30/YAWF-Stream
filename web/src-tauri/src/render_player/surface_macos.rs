// The mpv render API currently exposes an OpenGL surface on macOS. Keep the
// platform deprecation allowance confined to this module while the migration
// described in EMBEDDED_PLAYER.md remains open.
#![allow(deprecated)]

// macOS video surface: mpv render API into a layer-backed CAOpenGLLayer,
// composited BEHIND the transparent WKWebView.
//
//   * A `CAOpenGLLayer` subclass (VideoLayer) hosts the GL surface. CoreAnimation
//     owns the context + backbuffer and calls our draw callback on its render
//     thread; we render an mpv frame into the bound FBO there. Being LAYER-BACKED,
//     it survives window occlusion/activation/Space changes - unlike a bare
//     NSOpenGLContext+NSView, which detaches (goes black) on those events.
//   * The layer is hosted in a plain NSView inserted below the WKWebView.
//   * mpv (vo=libmpv) + an `mpv_render_context` (OpenGL) drive the pixels; mpv's
//     render-update callback pokes the layer (`setNeedsDisplay`) when a new frame
//     is ready - CoreAnimation then calls our draw callback.
//
// This file owns ONLY the surface; the mpv lifecycle lives in `core.rs`. It
// implements the `VideoSurface` trait (set_rect is a no-op - the host view
// autoresizes with the content view; detach performs the ordered teardown).

use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr, CString};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use libmpv2::Mpv;

use dispatch2::{DispatchQueue, DispatchTime};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSColor, NSView, NSWindow, NSWindowDidEnterFullScreenNotification,
    NSWindowDidExitFullScreenNotification, NSWindowOrderingMode, NSWindowStyleMask,
    NSWindowWillCloseNotification, NSWindowWillEnterFullScreenNotification,
    NSWindowWillExitFullScreenNotification,
};
use objc2_core_foundation::CFTimeInterval;
use objc2_core_video::CVTimeStamp;
use objc2_foundation::{
    ns_string, NSNotification, NSNotificationCenter, NSNumber, NSObject, NSPoint, NSRect, NSSize,
};
use objc2_open_gl::{
    CGLChoosePixelFormat, CGLContextObj, CGLCreateContext, CGLError, CGLGetCurrentContext,
    CGLLockContext, CGLPixelFormatAttribute, CGLPixelFormatObj, CGLReleaseContext,
    CGLRetainContext, CGLSetCurrentContext, CGLUnlockContext,
};
use objc2_quartz_core::{CAAutoresizingMask, CALayer, CAOpenGLLayer};
use objc2_web_kit::WKWebView;

use tauri::{AppHandle, Manager, Runtime};

use super::core::{rp_debug_enabled, rp_log, PreInit, VideoSurface};
use super::APP_BASE_BACKGROUND_RGB;

// GL enum constants we need (not worth a GL crate).
const GL_FRAMEBUFFER_BINDING: u32 = 0x8CA6;
// 3.2 Core profile value for kCGLPFAOpenGLProfile.
const CGL_OGLP_VERSION_3_2_CORE: u32 = 0x3200;
// Render at no more than 1.5x the video's display dimensions on each axis.
// The layer keeps its full point bounds, so Core Animation performs any final
// window-sized composite scaling without changing NSWindow geometry.
const VIDEO_RENDER_SUPERSAMPLE: f64 = 1.5;

/// Apply the WKWebView half of the playback compositing contract. `setOpaque:`
/// and the `drawsBackground` KVC key are private WebKit controls, but this app is
/// notarized outside the App Store and Wry already relies on the inverse setup
/// for transparent windows. `underPageBackgroundColor` is public on macOS 12+.
/// Every caller reaches this function on AppKit's main thread.
fn set_webview_opaque(webview: &WKWebView, opaque: bool) {
    let _mtm =
        MainThreadMarker::new().expect("WKWebView opacity must be changed on the main thread");
    let draws_background = NSNumber::new_bool(opaque);
    let color = if opaque {
        let (red, green, blue) = APP_BASE_BACKGROUND_RGB;
        NSColor::colorWithSRGBRed_green_blue_alpha(red / 255.0, green / 255.0, blue / 255.0, 1.0)
    } else {
        NSColor::clearColor()
    };

    unsafe {
        let _: () = msg_send![webview, setOpaque: opaque];
        let _: () = msg_send![webview,
            setValue: &*draws_background,
            forKey: ns_string!("drawsBackground")
        ];
        webview.setUnderPageBackgroundColor(Some(&color));
    }
}

/// Wry creates this WKWebView non-opaque because the window remains configured
/// as transparent for embedded playback. Override that default during app setup;
/// the surface lifecycle temporarily reverses it while native video is attached.
pub(crate) fn set_initial_webview_opaque<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let webview_window = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next())
        .ok_or("no app webview window for opacity setup")?;
    webview_window
        .with_webview(|webview| {
            let webview_ptr = webview.inner() as usize;
            if webview_ptr != 0 {
                let webview: &WKWebView = unsafe { &*(webview_ptr as *const WKWebView) };
                set_webview_opaque(webview, true);
            }
        })
        .map_err(|e| format!("could not configure native webview opacity: {e}"))
}

// ---- GL symbol resolution ------------------------------------------------
fn gl_get_proc_address(_ctx: &(), name: &str) -> *mut c_void {
    static GL: OnceLock<usize> = OnceLock::new();
    let handle = *GL.get_or_init(|| {
        let path = CString::new("/System/Library/Frameworks/OpenGL.framework/OpenGL").unwrap();
        unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_NOW | libc::RTLD_GLOBAL) as usize }
    });
    if handle == 0 {
        return std::ptr::null_mut();
    }
    let cname = match CString::new(name) {
        Ok(c) => c,
        Err(_) => return std::ptr::null_mut(),
    };
    unsafe { libc::dlsym(handle as *mut c_void, cname.as_ptr()) }
}

fn gl_fn<T: Copy>(name: &str) -> Option<T> {
    let p = gl_get_proc_address(&(), name);
    if p.is_null() {
        None
    } else {
        Some(unsafe { std::mem::transmute_copy::<*mut c_void, T>(&p) })
    }
}

/// Read `glGetIntegerv(pname)` (single value).
fn gl_get_int(pname: u32) -> i32 {
    type F = unsafe extern "C" fn(u32, *mut i32);
    match gl_fn::<F>("glGetIntegerv") {
        Some(f) => {
            let mut v = 0i32;
            unsafe { f(pname, &mut v) };
            v
        }
        None => 0,
    }
}

/// Cover the complete drawable. OpenGL viewport dimensions are backing pixels.
fn gl_set_viewport(w: i32, h: i32) {
    type F = unsafe extern "C" fn(i32, i32, i32, i32);
    if let Some(f) = gl_fn::<F>("glViewport") {
        unsafe { f(0, 0, w, h) };
    }
}

fn positive_finite(value: f64) -> bool {
    value.is_finite() && value > 0.0
}

fn safe_render_dimension(value: f64) -> i32 {
    if !positive_finite(value) {
        return 1;
    }
    value.round().clamp(1.0, i32::MAX as f64) as i32
}

/// Return the uniform linear scale applied to a full-window backing target.
/// A uniform factor preserves the layer/window aspect, so mpv still owns the
/// aspect-fit bars inside its FBO instead of Core Animation stretching them.
fn render_target_budget_factor(
    backing_width: f64,
    backing_height: f64,
    video_width: i64,
    video_height: i64,
) -> f64 {
    if !positive_finite(backing_width)
        || !positive_finite(backing_height)
        || video_width <= 0
        || video_height <= 0
    {
        return 1.0;
    }
    let cap_width = video_width as f64 * VIDEO_RENDER_SUPERSAMPLE;
    let cap_height = video_height as f64 * VIDEO_RENDER_SUPERSAMPLE;
    if !positive_finite(cap_width) || !positive_finite(cap_height) {
        return 1.0;
    }
    let factor = (cap_width / backing_width)
        .min(cap_height / backing_height)
        .min(1.0);
    if positive_finite(factor) {
        factor
    } else {
        1.0
    }
}

#[cfg(test)]
fn capped_render_target_dimensions(
    backing_width: f64,
    backing_height: f64,
    video_width: i64,
    video_height: i64,
) -> (i32, i32) {
    let factor =
        render_target_budget_factor(backing_width, backing_height, video_width, video_height);
    (
        safe_render_dimension(backing_width * factor),
        safe_render_dimension(backing_height * factor),
    )
}

fn effective_contents_scale(
    bounds: NSSize,
    backing_scale: f64,
    video_width: i64,
    video_height: i64,
) -> f64 {
    let safe_backing_scale = if positive_finite(backing_scale) {
        backing_scale
    } else {
        1.0
    };
    if !positive_finite(bounds.width) || !positive_finite(bounds.height) {
        return safe_backing_scale;
    }
    let backing_width = bounds.width * safe_backing_scale;
    let backing_height = bounds.height * safe_backing_scale;
    let factor =
        render_target_budget_factor(backing_width, backing_height, video_width, video_height);
    let scale = safe_backing_scale * factor;
    if positive_finite(scale) {
        scale
    } else {
        safe_backing_scale
    }
}

fn render_update_has_frame(flags: u64) -> bool {
    flags & u64::from(libmpv2_sys::mpv_render_update_flag_MPV_RENDER_UPDATE_FRAME) != 0
}

fn should_queue_callback_redraw(
    lifecycle: CallbackLifecycle,
    update_pending: bool,
    force_render: bool,
    main_dispatch_queued: bool,
) -> bool {
    lifecycle == CallbackLifecycle::Live
        && (update_pending || force_render)
        && !main_dispatch_queued
}

fn should_requeue_after_draw(
    lifecycle: CallbackLifecycle,
    update_pending: bool,
    force_render: bool,
) -> bool {
    lifecycle == CallbackLifecycle::Live && (update_pending || force_render)
}

// ---- The layer-backed video surface -------------------------------------
// libmpv2 5.0.3 releases its Rust callback allocation before calling
// mpv_render_context_free. libmpv can still enter that callback from its VO
// thread during free, so that Drop order is unsafe here. Own the raw context and
// callback allocation together and release them in the required order:
// quiesce, unregister, free, then release the callback allocation. The layer's
// render mutex serializes update, render, and this teardown.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
enum CallbackLifecycle {
    Live = 0,
    Quiescing = 1,
    Freed = 2,
}

impl CallbackLifecycle {
    fn from_raw(value: u8) -> Self {
        match value {
            0 => Self::Live,
            1 => Self::Quiescing,
            _ => Self::Freed,
        }
    }
}

/// Send-safe state shared with mpv's render-update callback. The callback must
/// never capture or dereference an Objective-C object off-main: it can run
/// concurrently with `mpv_render_context_free` during teardown. Holding only this
/// Arc (a raw layer pointer plus lifecycle atomics) is what keeps it sound.
struct RenderCallbackState {
    layer_ptr: AtomicUsize,
    lifecycle: AtomicU8,
    update_pending: AtomicBool,
    main_dispatch_queued: AtomicBool,
    context_mismatch_logged: AtomicBool,
    force_render: AtomicBool,
}

impl RenderCallbackState {
    fn lifecycle(&self) -> CallbackLifecycle {
        CallbackLifecycle::from_raw(self.lifecycle.load(Ordering::Acquire))
    }

    fn is_live(&self) -> bool {
        self.lifecycle() == CallbackLifecycle::Live
    }

    fn begin_teardown(&self) {
        self.lifecycle
            .store(CallbackLifecycle::Quiescing as u8, Ordering::Release);
        self.layer_ptr.store(0, Ordering::Release);
        self.update_pending.store(false, Ordering::Release);
        self.force_render.store(false, Ordering::Release);
    }

    fn mark_freed(&self) {
        self.lifecycle
            .store(CallbackLifecycle::Freed as u8, Ordering::Release);
    }
}

struct RenderUpdateCallbackContext {
    state: Arc<RenderCallbackState>,
}

unsafe extern "C" fn raw_gl_get_proc_address(
    _context: *mut c_void,
    name: *const c_char,
) -> *mut c_void {
    if name.is_null() {
        return std::ptr::null_mut();
    }
    let Ok(name) = CStr::from_ptr(name).to_str() else {
        return std::ptr::null_mut();
    };
    gl_get_proc_address(&(), name)
}

unsafe extern "C" fn render_update_callback(context: *mut c_void) {
    if context.is_null() {
        return;
    }
    let callback = &*(context as *const RenderUpdateCallbackContext);
    if !callback.state.is_live() {
        return;
    }
    callback.state.update_pending.store(true, Ordering::Release);
    queue_callback_redraw(callback.state.clone());
}

struct RawRenderContext {
    context: NonNull<libmpv2_sys::mpv_render_context>,
    gl_context: CGLContextObj,
    callback_context: Box<RenderUpdateCallbackContext>,
}

unsafe impl Send for RawRenderContext {}

fn render_context_matches_creation(creation_context: usize, draw_context: usize) -> bool {
    creation_context == draw_context
}

impl RawRenderContext {
    fn new(
        mpv: &Mpv,
        gl_context: CGLContextObj,
        callback: Arc<RenderCallbackState>,
    ) -> Result<Self, i32> {
        if gl_context.is_null() {
            return Err(libmpv2_sys::mpv_error_MPV_ERROR_INVALID_PARAMETER);
        }
        let mut open_gl = libmpv2_sys::mpv_opengl_init_params {
            get_proc_address: Some(raw_gl_get_proc_address),
            get_proc_address_ctx: std::ptr::null_mut(),
        };
        let mut parameters = [
            libmpv2_sys::mpv_render_param {
                type_: libmpv2_sys::mpv_render_param_type_MPV_RENDER_PARAM_API_TYPE,
                data: libmpv2_sys::MPV_RENDER_API_TYPE_OPENGL.as_ptr() as *mut c_void,
            },
            libmpv2_sys::mpv_render_param {
                type_: libmpv2_sys::mpv_render_param_type_MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
                data: (&mut open_gl as *mut libmpv2_sys::mpv_opengl_init_params).cast(),
            },
            libmpv2_sys::mpv_render_param {
                type_: libmpv2_sys::mpv_render_param_type_MPV_RENDER_PARAM_INVALID,
                data: std::ptr::null_mut(),
            },
        ];
        let mut raw_context = std::ptr::null_mut();
        let result = unsafe {
            libmpv2_sys::mpv_render_context_create(
                &mut raw_context,
                mpv.ctx.as_ptr(),
                parameters.as_mut_ptr(),
            )
        };
        if result < 0 {
            return Err(result);
        }
        let Some(context) = NonNull::new(raw_context) else {
            return Err(libmpv2_sys::mpv_error_MPV_ERROR_GENERIC);
        };

        // CAOpenGLLayer owns the context passed to draw. Keep an explicit retain
        // so the exact context used for creation remains valid through an
        // explicit teardown or an unexpected layer ivar drop.
        let retained_gl_context = unsafe { CGLRetainContext(gl_context) };
        if retained_gl_context.is_null() {
            unsafe { libmpv2_sys::mpv_render_context_free(context.as_ptr()) };
            return Err(libmpv2_sys::mpv_error_MPV_ERROR_GENERIC);
        }
        let mut callback_context = Box::new(RenderUpdateCallbackContext { state: callback });
        unsafe {
            libmpv2_sys::mpv_render_context_set_update_callback(
                context.as_ptr(),
                Some(render_update_callback),
                (&mut *callback_context as *mut RenderUpdateCallbackContext).cast(),
            );
        }
        Ok(Self {
            context,
            gl_context: retained_gl_context,
            callback_context,
        })
    }

    fn update(&self) -> u64 {
        unsafe { libmpv2_sys::mpv_render_context_update(self.context.as_ptr()) }
    }

    fn render(&self, fbo: i32, width: i32, height: i32, flip: bool) -> Result<(), i32> {
        let mut fbo = libmpv2_sys::mpv_opengl_fbo {
            fbo,
            w: width,
            h: height,
            internal_format: 0,
        };
        let mut flip = i32::from(flip);
        let mut parameters = [
            libmpv2_sys::mpv_render_param {
                type_: libmpv2_sys::mpv_render_param_type_MPV_RENDER_PARAM_OPENGL_FBO,
                data: (&mut fbo as *mut libmpv2_sys::mpv_opengl_fbo).cast(),
            },
            libmpv2_sys::mpv_render_param {
                type_: libmpv2_sys::mpv_render_param_type_MPV_RENDER_PARAM_FLIP_Y,
                data: (&mut flip as *mut i32).cast(),
            },
            libmpv2_sys::mpv_render_param {
                type_: libmpv2_sys::mpv_render_param_type_MPV_RENDER_PARAM_INVALID,
                data: std::ptr::null_mut(),
            },
        ];
        let result = unsafe {
            libmpv2_sys::mpv_render_context_render(self.context.as_ptr(), parameters.as_mut_ptr())
        };
        if result < 0 {
            Err(result)
        } else {
            Ok(())
        }
    }
}

impl Drop for RawRenderContext {
    fn drop(&mut self) {
        let callback = &self.callback_context.state;
        callback.begin_teardown();

        // The OpenGL render API requires every mpv_render_* call, including
        // free, to run with the exact creation context current. Explicit
        // teardown takes the Option out of its mutex before this Drop runs, so
        // taking the CGL lock here preserves draw's lock order.
        let lock_status = unsafe { CGLLockContext(self.gl_context) };
        if lock_status != CGLError::NoError {
            rp_log(&format!(
                "RawRenderContext.drop: CGLLockContext failed: {}",
                lock_status.0
            ));
        }
        let previous_context = unsafe { CGLGetCurrentContext() };
        let needs_context_switch = previous_context != self.gl_context;
        let set_status = if needs_context_switch {
            unsafe { CGLSetCurrentContext(self.gl_context) }
        } else {
            CGLError::NoError
        };
        if set_status != CGLError::NoError {
            // Free anyway so the render context cannot outlive mpv. The retained
            // CGL context and CGL lock still provide the strongest available
            // teardown boundary after a context-switch failure.
            rp_log(&format!(
                "RawRenderContext.drop: CGLSetCurrentContext failed: {}",
                set_status.0
            ));
        }
        unsafe {
            libmpv2_sys::mpv_render_context_set_update_callback(
                self.context.as_ptr(),
                None,
                std::ptr::null_mut(),
            );
            libmpv2_sys::mpv_render_context_free(self.context.as_ptr());
        }
        callback.mark_freed();

        if needs_context_switch && set_status == CGLError::NoError {
            let restore_status = unsafe { CGLSetCurrentContext(previous_context) };
            if restore_status != CGLError::NoError {
                rp_log(&format!(
                    "RawRenderContext.drop: restoring CGL context failed: {}",
                    restore_status.0
                ));
            }
        }
        if lock_status == CGLError::NoError {
            let unlock_status = unsafe { CGLUnlockContext(self.gl_context) };
            if unlock_status != CGLError::NoError {
                rp_log(&format!(
                    "RawRenderContext.drop: CGLUnlockContext failed: {}",
                    unlock_status.0
                ));
            }
        }
        unsafe { CGLReleaseContext(self.gl_context) };
        // callback_context drops only after this Drop implementation returns.
    }
}

fn queue_callback_redraw(callback: Arc<RenderCallbackState>) {
    let lifecycle = callback.lifecycle();
    let update_pending = callback.update_pending.load(Ordering::Acquire);
    let force_render = callback.force_render.load(Ordering::Acquire);
    let main_dispatch_queued = callback.main_dispatch_queued.load(Ordering::Acquire);
    if !should_queue_callback_redraw(
        lifecycle,
        update_pending,
        force_render,
        main_dispatch_queued,
    ) || callback
        .main_dispatch_queued
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }

    DispatchQueue::main().exec_async(move || {
        // This latch represents only delivery to the main queue. Core Animation
        // may coalesce or discard the invalidation during a drawable transition,
        // so never keep later updates blocked until draw happens.
        callback
            .main_dispatch_queued
            .store(false, Ordering::Release);
        // Teardown and this closure both serialize on the main queue. Re-check
        // the flag because the redraw may have been queued before teardown ran.
        if !callback.is_live() {
            return;
        }
        let ptr = callback.layer_ptr.load(Ordering::Acquire);
        if ptr == 0 {
            return;
        }
        let layer: &VideoLayer = unsafe { &*(ptr as *const VideoLayer) };
        // This invalidation is only a coalesced wake for the CA render thread.
        // VideoLayer.draw consumes update() and calls render() only for FRAME.
        layer.setNeedsDisplay();
    });
}

fn finish_callback_redraw(callback: &Arc<RenderCallbackState>) {
    // Close the race where an update or forced redraw arrived after draw consumed
    // its flags. Main-queue delivery has its own shorter-lived coalescing latch.
    if should_requeue_after_draw(
        callback.lifecycle(),
        callback.update_pending.load(Ordering::Acquire),
        callback.force_render.load(Ordering::Acquire),
    ) {
        queue_callback_redraw(callback.clone());
    }
}

#[derive(Clone, Copy)]
struct FrameSnapshot {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl FrameSnapshot {
    fn from_rect(rect: NSRect) -> Self {
        Self {
            x: rect.origin.x,
            y: rect.origin.y,
            width: rect.size.width,
            height: rect.size.height,
        }
    }

    fn as_rect(self) -> NSRect {
        NSRect::new(
            NSPoint::new(self.x, self.y),
            NSSize::new(self.width, self.height),
        )
    }
}

/// Send-safe native geometry and window-wrap state. Objective-C objects are held
/// only as raw addresses and are dereferenced exclusively on AppKit's main
/// thread. The atomics are updated by mpv's event thread.
struct SurfaceState {
    window_ptr: usize,
    content_view_ptr: usize,
    webview_ptr: usize,
    webview_sibling_ptr: usize,
    host_ptr: AtomicUsize,
    layer_ptr: AtomicUsize,
    dwidth: AtomicI64,
    dheight: AtomicI64,
    first_draw_logged: AtomicBool,
    last_draw_width: AtomicI64,
    last_draw_height: AtomicI64,
    geometry_check_queued: AtomicBool,
    last_main_geometry: Mutex<String>,
    wrap_active: AtomicBool,
    wrap_needs_resize: AtomicBool,
    wrap_dispatch_queued: AtomicBool,
    wrap_reconciling: AtomicBool,
    wrap_postcondition_attempts: AtomicU8,
    wrap_constraint_applied: AtomicBool,
    wrap_has_applied: AtomicBool,
    wrap_restore_pending: AtomicBool,
    pre_wrap_frame: Mutex<Option<FrameSnapshot>>,
    fullscreen_session_active: AtomicBool,
    fullscreen_enter_in_flight: AtomicBool,
    fullscreen_exit_in_flight: AtomicBool,
    fullscreen_transition_seq: AtomicUsize,
    webview_transparent: AtomicBool,
    dead: AtomicBool,
}

impl SurfaceState {
    fn new(
        window_ptr: usize,
        content_view_ptr: usize,
        webview_ptr: usize,
        webview_sibling_ptr: usize,
    ) -> Arc<Self> {
        Arc::new(Self {
            window_ptr,
            content_view_ptr,
            webview_ptr,
            webview_sibling_ptr,
            host_ptr: AtomicUsize::new(0),
            layer_ptr: AtomicUsize::new(0),
            dwidth: AtomicI64::new(0),
            dheight: AtomicI64::new(0),
            first_draw_logged: AtomicBool::new(false),
            last_draw_width: AtomicI64::new(0),
            last_draw_height: AtomicI64::new(0),
            geometry_check_queued: AtomicBool::new(false),
            last_main_geometry: Mutex::new(String::new()),
            wrap_active: AtomicBool::new(false),
            wrap_needs_resize: AtomicBool::new(true),
            wrap_dispatch_queued: AtomicBool::new(false),
            wrap_reconciling: AtomicBool::new(false),
            wrap_postcondition_attempts: AtomicU8::new(0),
            wrap_constraint_applied: AtomicBool::new(false),
            wrap_has_applied: AtomicBool::new(false),
            wrap_restore_pending: AtomicBool::new(false),
            pre_wrap_frame: Mutex::new(None),
            fullscreen_session_active: AtomicBool::new(false),
            fullscreen_enter_in_flight: AtomicBool::new(false),
            fullscreen_exit_in_flight: AtomicBool::new(false),
            fullscreen_transition_seq: AtomicUsize::new(0),
            webview_transparent: AtomicBool::new(false),
            dead: AtomicBool::new(false),
        })
    }

    fn dimension_text(&self) -> (String, String) {
        let width = self.dwidth.load(Ordering::Acquire);
        let height = self.dheight.load(Ordering::Acquire);
        (
            if width > 0 {
                width.to_string()
            } else {
                "?".to_string()
            },
            if height > 0 {
                height.to_string()
            } else {
                "?".to_string()
            },
        )
    }
}

fn claim_webview_transparency(surface: &SurfaceState) -> bool {
    !surface.webview_transparent.swap(true, Ordering::AcqRel)
}

fn claim_webview_opacity_restore(surface: &SurfaceState) -> bool {
    surface.webview_transparent.swap(false, Ordering::AcqRel)
}

fn make_webview_transparent_on_main(surface: &SurfaceState) -> bool {
    if surface.webview_ptr == 0 || !claim_webview_transparency(surface) {
        return false;
    }
    let webview: &WKWebView = unsafe { &*(surface.webview_ptr as *const WKWebView) };
    set_webview_opaque(webview, false);
    rp_log(&format!(
        "RPGEO event=webview-opacity engine=native-mpv opaque=false window=0x{:x}",
        surface.window_ptr
    ));
    true
}

fn restore_webview_opacity_on_main(surface: &SurfaceState, reason: &str) -> bool {
    if surface.webview_ptr == 0 || !claim_webview_opacity_restore(surface) {
        return false;
    }
    let webview: &WKWebView = unsafe { &*(surface.webview_ptr as *const WKWebView) };
    set_webview_opaque(webview, true);
    rp_log(&format!(
        "RPGEO event=webview-opacity engine=native-mpv opaque=true reason={reason} window=0x{:x}",
        surface.window_ptr
    ));
    true
}

fn note_fullscreen_will_enter(surface: &Arc<SurfaceState>) {
    surface
        .fullscreen_transition_seq
        .fetch_add(1, Ordering::AcqRel);
    // Do not clear contentAspectRatio here. WillEnter is close to AppKit's exit
    // frame snapshot, and a valid windowed ratio does not need to be rewritten
    // for fullscreen layout. The live surface reconciles only after DidExit.
    surface
        .fullscreen_session_active
        .store(true, Ordering::Release);
    surface
        .fullscreen_enter_in_flight
        .store(true, Ordering::Release);
    surface
        .fullscreen_exit_in_flight
        .store(false, Ordering::Release);
    schedule_fullscreen_enter_revalidation(surface.clone());
}

fn note_fullscreen_did_enter(surface: &SurfaceState) {
    surface
        .fullscreen_transition_seq
        .fetch_add(1, Ordering::AcqRel);
    surface
        .fullscreen_session_active
        .store(true, Ordering::Release);
    surface
        .fullscreen_enter_in_flight
        .store(false, Ordering::Release);
    surface
        .fullscreen_exit_in_flight
        .store(false, Ordering::Release);
}

fn note_fullscreen_will_exit(surface: &SurfaceState) {
    surface
        .fullscreen_transition_seq
        .fetch_add(1, Ordering::AcqRel);
    surface
        .fullscreen_session_active
        .store(true, Ordering::Release);
    surface
        .fullscreen_enter_in_flight
        .store(false, Ordering::Release);
    surface
        .fullscreen_exit_in_flight
        .store(true, Ordering::Release);
}

/// Returns true when this DidExit completed the current fullscreen session.
/// A nested WillEnter posted by another observer takes precedence.
fn note_fullscreen_did_exit(surface: &SurfaceState) -> bool {
    surface
        .fullscreen_transition_seq
        .fetch_add(1, Ordering::AcqRel);
    surface
        .fullscreen_exit_in_flight
        .store(false, Ordering::Release);
    if surface.fullscreen_enter_in_flight.load(Ordering::Acquire) {
        return false;
    }
    surface
        .fullscreen_session_active
        .store(false, Ordering::Release);
    true
}

// AppKit can abort a fullscreen ENTER without posting any NSNotification:
// windowDidFailToEnterFullScreen goes only to the window delegate, which tao
// owns. An aborted enter would leave the in-flight/session latches set forever,
// blocking every future windowed wrap and surviving player restarts through
// inherited teardown-cleanup state. Revalidate shortly after the latch is set:
// if no Will/Did notification has arrived and the styleMask FullScreen bit is
// still clear, release the stale latch.
const FULLSCREEN_ENTER_REVALIDATE_DELAY: std::time::Duration = std::time::Duration::from_secs(2);

fn schedule_fullscreen_enter_revalidation(surface: Arc<SurfaceState>) {
    let expected_seq = surface.fullscreen_transition_seq.load(Ordering::Acquire);
    let Ok(when) = DispatchTime::try_from(FULLSCREEN_ENTER_REVALIDATE_DELAY) else {
        return;
    };
    let _ = DispatchQueue::main().after(when, move || {
        revalidate_fullscreen_enter_on_main(&surface, expected_seq);
    });
}

fn revalidate_fullscreen_enter_on_main(surface: &SurfaceState, expected_seq: usize) {
    // Any Will/Did fullscreen notification since scheduling owns the state now.
    if surface.fullscreen_transition_seq.load(Ordering::Acquire) != expected_seq {
        return;
    }
    if !surface.fullscreen_enter_in_flight.load(Ordering::Acquire) {
        return;
    }
    if surface.window_ptr == 0 {
        return;
    }
    // The dereference is safe while the latch is set: every teardown and close
    // path clears enter_in_flight on the main thread (discard_window_wrap_state)
    // before the window can deallocate, and this block runs on the main thread.
    let window: &NSWindow = unsafe { &*(surface.window_ptr as *const NSWindow) };
    if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
        // The transition really is under way (or landed); DidEnter resolves it.
        return;
    }
    surface
        .fullscreen_enter_in_flight
        .store(false, Ordering::Release);
    surface
        .fullscreen_session_active
        .store(false, Ordering::Release);
    rp_log(&format!(
        "RPGEO event=window-wrap engine=native-mpv action=fullscreen-enter-revalidate repair=stale-enter-latch window=0x{:x}",
        surface.window_ptr
    ));
    log_fullscreen_state_on_main(surface, "enter-revalidate-repair");
}

// A surface can be torn down while its NSWindow is fullscreen. The host view
// cannot own the eventual cleanup because teardown removes that view and all of
// its notification registrations. This small observer is retained independently
// in a main-thread-only registry until the window exits fullscreen or closes.
struct PostFullscreenCleanupIvars {
    surface: Arc<SurfaceState>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "DSPostFullscreenCleanup"]
    #[ivars = PostFullscreenCleanupIvars]
    #[thread_kind = MainThreadOnly]
    struct PostFullscreenCleanup;

    impl PostFullscreenCleanup {
        #[unsafe(method(windowWillEnterFullScreen:))]
        fn window_will_enter_full_screen(&self, _notification: &NSNotification) {
            note_fullscreen_will_enter(&self.ivars().surface);
        }

        #[unsafe(method(windowDidEnterFullScreen:))]
        fn window_did_enter_full_screen(&self, _notification: &NSNotification) {
            note_fullscreen_did_enter(&self.ivars().surface);
        }

        #[unsafe(method(windowWillExitFullScreen:))]
        fn window_will_exit_full_screen(&self, _notification: &NSNotification) {
            note_fullscreen_will_exit(&self.ivars().surface);
        }

        #[unsafe(method(windowDidExitFullScreen:))]
        fn window_did_exit_full_screen(&self, _notification: &NSNotification) {
            let surface = &self.ivars().surface;
            // Preserve a nested WillEnter from another DidExit observer. If a
            // new transition has already begun, this helper remains registered
            // for that fullscreen session's eventual DidExit.
            if !note_fullscreen_did_exit(surface) {
                return;
            }
            finish_post_fullscreen_cleanup_on_main(self, true, "did-exit-fullscreen");
        }

        #[unsafe(method(windowWillClose:))]
        fn window_will_close(&self, _notification: &NSNotification) {
            finish_post_fullscreen_cleanup_on_main(self, false, "window-close");
        }
    }
);

impl PostFullscreenCleanup {
    fn new(mtm: MainThreadMarker, surface: Arc<SurfaceState>) -> Retained<Self> {
        let this = mtm
            .alloc::<Self>()
            .set_ivars(PostFullscreenCleanupIvars { surface });
        unsafe { msg_send![super(this), init] }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LayerContextAction {
    Create,
    RetainExisting,
}

fn layer_context_action(context: Option<usize>) -> LayerContextAction {
    if context.is_some() {
        LayerContextAction::RetainExisting
    } else {
        LayerContextAction::Create
    }
}

struct LayerOwnedCglContext(CGLContextObj);

unsafe impl Send for LayerOwnedCglContext {}

impl Drop for LayerOwnedCglContext {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CGLReleaseContext(self.0) };
        }
    }
}

struct VideoLayerIvars {
    render: Mutex<Option<RawRenderContext>>,
    // Field order is a lifetime contract. An unexpected ivar drop first frees
    // the mpv render context, then releases the layer's stable CGL reference,
    // then releases mpv ownership.
    owned_gl_context: Mutex<Option<LayerOwnedCglContext>>,
    mpv: Arc<Mpv>,
    callback: Arc<RenderCallbackState>,
    surface: Arc<SurfaceState>,
}

define_class!(
    #[unsafe(super(CAOpenGLLayer))]
    #[name = "DSVideoLayer"]
    #[ivars = VideoLayerIvars]
    struct VideoLayer;

    impl VideoLayer {
        // Provide a 3.2-core, accelerated pixel format for mpv's GL renderer.
        #[unsafe(method(copyCGLPixelFormatForDisplayMask:))]
        fn copy_cgl_pixel_format(&self, _mask: u32) -> CGLPixelFormatObj {
            let attribs = [
                CGLPixelFormatAttribute::CGLPFAAccelerated,
                CGLPixelFormatAttribute::CGLPFAOpenGLProfile,
                CGLPixelFormatAttribute(CGL_OGLP_VERSION_3_2_CORE),
                CGLPixelFormatAttribute(0),
            ];
            let mut pf: CGLPixelFormatObj = std::ptr::null_mut();
            let mut n: i32 = 0;
            unsafe {
                CGLChoosePixelFormat(
                    NonNull::new(attribs.as_ptr() as *mut CGLPixelFormatAttribute).unwrap(),
                    NonNull::new(&mut pf).unwrap(),
                    NonNull::new(&mut n).unwrap(),
                );
            }
            pf
        }

        #[unsafe(method(copyCGLContextForPixelFormat:))]
        fn copy_cgl_context(&self, pf: CGLPixelFormatObj) -> CGLContextObj {
            if pf.is_null() {
                rp_log("VideoLayer.copyCGLContext: null pixel format");
                return std::ptr::null_mut();
            }
            let Ok(mut owned) = self.ivars().owned_gl_context.lock() else {
                rp_log("VideoLayer.copyCGLContext: context ownership lock poisoned");
                return std::ptr::null_mut();
            };
            let context = match layer_context_action(
                owned.as_ref().map(|context| context.0 as usize),
            ) {
                LayerContextAction::RetainExisting => owned
                    .as_ref()
                    .map(|context| context.0)
                    .unwrap_or(std::ptr::null_mut()),
                LayerContextAction::Create => {
                    let mut context: CGLContextObj = std::ptr::null_mut();
                    let status = unsafe {
                        CGLCreateContext(
                            pf,
                            std::ptr::null_mut(),
                            NonNull::new(&mut context).unwrap(),
                        )
                    };
                    if status != CGLError::NoError || context.is_null() {
                        rp_log(&format!(
                            "VideoLayer.copyCGLContext: CGLCreateContext failed: {}",
                            status.0
                        ));
                        return std::ptr::null_mut();
                    }
                    owned.replace(LayerOwnedCglContext(context));
                    context
                }
            };
            let retained = unsafe { CGLRetainContext(context) };
            if retained.is_null() {
                rp_log("VideoLayer.copyCGLContext: CGLRetainContext failed");
            }
            retained
        }

        #[unsafe(method(releaseCGLContext:))]
        fn release_cgl_context(&self, ctx: CGLContextObj) {
            if ctx.is_null() {
                return;
            }
            // Balance the retained reference returned to CA by copyCGLContext.
            unsafe { CGLReleaseContext(ctx) };
        }

        #[unsafe(method(canDrawInCGLContext:pixelFormat:forLayerTime:displayTime:))]
        fn can_draw(
            &self,
            _ctx: CGLContextObj,
            _pf: CGLPixelFormatObj,
            _t: CFTimeInterval,
            _ts: *const CVTimeStamp,
        ) -> bool {
            true
        }

        // Disable ALL implicit animations on this layer. As a sublayer, CA would
        // otherwise animate every autoresize geometry change (~0.25s), so the
        // video lags behind the window edge during a drag-resize ("not locked
        // to the sides"). Returning NSNull means "no action" for every key.
        #[unsafe(method(actionForKey:))]
        fn action_for_key(&self, _key: *const AnyObject) -> *mut AnyObject {
            unsafe { msg_send![objc2::class!(NSNull), null] }
        }

        #[unsafe(method(drawInCGLContext:pixelFormat:forLayerTime:displayTime:))]
        fn draw(
            &self,
            ctx: CGLContextObj,
            pf: CGLPixelFormatObj,
            t: CFTimeInterval,
            ts: *const CVTimeStamp,
        ) {
            let ivars = self.ivars();
            if ctx.is_null() {
                rp_log("VideoLayer.draw: null CGL context; waiting for a later invalidation");
                return;
            }
            let lock_status = unsafe { CGLLockContext(ctx) };
            if lock_status != CGLError::NoError {
                rp_log(&format!(
                    "VideoLayer.draw: CGLLockContext failed; waiting for a later invalidation: {}",
                    lock_status.0
                ));
                return;
            }
            // Teardown has started - do not touch mpv/render at all.
            if !ivars.callback.is_live() {
                unsafe { CGLUnlockContext(ctx) };
                unsafe {
                    let _: () = msg_send![super(self),
                        drawInCGLContext: ctx, pixelFormat: pf,
                        forLayerTime: t, displayTime: ts];
                }
                return;
            }

            let mut render_slot = ivars.render.lock().unwrap();
            if render_slot.is_none() {
                // Re-check dead now that we hold the lock (teardown may have run
                // between the check above and acquiring the lock).
                if !ivars.callback.is_live() {
                    drop(render_slot);
                    unsafe { CGLUnlockContext(ctx) };
                    return;
                }
                match RawRenderContext::new(&ivars.mpv, ctx, ivars.callback.clone()) {
                    Ok(rc) => {
                        rp_log("VideoLayer.draw: RenderContext created");
                        *render_slot = Some(rc);
                    }
                    Err(e) => rp_log(&format!("VideoLayer.draw: RenderContext failed: {e}")),
                }
            }

            let context_matches = render_slot
                .as_ref()
                .map(|render| {
                    render_context_matches_creation(
                        render.gl_context as usize,
                        ctx as usize,
                    )
                })
                .unwrap_or(true);
            if !context_matches {
                if !ivars
                    .callback
                    .context_mismatch_logged
                    .swap(true, Ordering::AcqRel)
                {
                    rp_log(
                        "VideoLayer.draw: CGL context differs from render-context creation; mpv render deferred",
                    );
                }
                // Keep all update and force flags pending. A later genuine layer
                // invalidation can retry if Core Animation restores the context.
                drop(render_slot);
                unsafe { CGLUnlockContext(ctx) };
                return;
            }
            ivars
                .callback
                .context_mismatch_logged
                .store(false, Ordering::Release);
            if render_slot.is_none() {
                // Creation failures are retried only by the bounded attach nudge
                // or a later genuine update/resize. Do not self-schedule a loop.
                ivars.callback.force_render.store(true, Ordering::Release);
                drop(render_slot);
                unsafe { CGLUnlockContext(ctx) };
                return;
            }

            let forced = ivars.callback.force_render.swap(false, Ordering::AcqRel);
            let had_update = ivars.callback.update_pending.swap(false, Ordering::AcqRel);
            let mut should_render = forced;
            if had_update {
                if let Some(sr) = render_slot.as_ref() {
                    should_render |= render_update_has_frame(sr.update());
                }
            }

            if should_render {
                // CALayer bounds are points; contentsScale maps them to the
                // backing store's capped pixels. GL_VIEWPORT is mutable drawing
                // state, not framebuffer-size metadata, so never feed it back as
                // the drawable size after mpv has changed it.
                let bounds = self.bounds();
                let scale = self.contentsScale();
                let w = safe_render_dimension(bounds.size.width * scale);
                let h = safe_render_dimension(bounds.size.height * scale);
                let fbo = gl_get_int(GL_FRAMEBUFFER_BINDING);
                let previous_w = ivars
                    .surface
                    .last_draw_width
                    .swap(i64::from(w), Ordering::AcqRel);
                let previous_h = ivars
                    .surface
                    .last_draw_height
                    .swap(i64::from(h), Ordering::AcqRel);
                let first_draw = !ivars
                    .surface
                    .first_draw_logged
                    .swap(true, Ordering::AcqRel);
                if first_draw && rp_debug_enabled() {
                    let cached = ivars
                        .surface
                        .last_main_geometry
                        .lock()
                        .map(|v| v.clone())
                        .unwrap_or_default();
                    let frame = self.frame();
                    let (dwidth, dheight) = ivars.surface.dimension_text();
                    rp_log(&format!(
                        "RPGEO event=first-draw engine=native-mpv {cached} draw.layer.frame={} draw.layer.bounds={} draw.contentsScale={scale:.3} mpv_target_px={w}x{h} fbo={fbo} dwidth={dwidth} dheight={dheight} correction_check=queued",
                        rect_text(frame),
                        rect_text(bounds),
                    ));
                }
                // AppKit can resize the fullscreen content hierarchy after the
                // first frame. Re-arm the main-thread check whenever the target
                // handed to mpv changes. Transition draws coalesce into one check.
                if first_draw
                    || previous_w != i64::from(w)
                    || previous_h != i64::from(h)
                {
                    queue_geometry_check(ivars.surface.clone(), first_draw);
                }
                gl_set_viewport(w, h);
                if let Some(sr) = render_slot.as_ref() {
                    if let Err(e) = sr.render(fbo, w, h, true) {
                        rp_log(&format!("VideoLayer.draw: render failed: {e}"));
                    }
                }
            }
            drop(render_slot);
            finish_callback_redraw(&ivars.callback);
            unsafe { CGLUnlockContext(ctx) };
            // Let CAOpenGLLayer's default implementation flush the context.
            unsafe {
                let _: () = msg_send![super(self),
                    drawInCGLContext: ctx,
                    pixelFormat: pf,
                    forLayerTime: t,
                    displayTime: ts];
            }
        }
    }
);

impl VideoLayer {
    fn new(mpv: Arc<Mpv>, surface: Arc<SurfaceState>) -> Retained<Self> {
        let callback = Arc::new(RenderCallbackState {
            layer_ptr: AtomicUsize::new(0),
            lifecycle: AtomicU8::new(CallbackLifecycle::Live as u8),
            update_pending: AtomicBool::new(false),
            main_dispatch_queued: AtomicBool::new(false),
            context_mismatch_logged: AtomicBool::new(false),
            force_render: AtomicBool::new(false),
        });
        let this = Self::alloc().set_ivars(VideoLayerIvars {
            render: Mutex::new(None),
            owned_gl_context: Mutex::new(None),
            mpv,
            callback: callback.clone(),
            surface: surface.clone(),
        });
        let layer: Retained<Self> = unsafe { msg_send![super(this), init] };
        // Publish the real layer pointer only after init, for the send-safe
        // render-update callback to reach the layer without capturing a raw
        // Objective-C pointer of its own.
        callback
            .layer_ptr
            .store(Retained::as_ptr(&layer) as usize, Ordering::Release);
        surface
            .layer_ptr
            .store(Retained::as_ptr(&layer) as usize, Ordering::Release);
        layer
    }
}

fn sync_layer_render_scale(
    layer: &VideoLayer,
    surface: &SurfaceState,
    bounds: NSSize,
    backing_scale: f64,
) -> bool {
    let video_width = surface.dwidth.load(Ordering::Acquire);
    let video_height = surface.dheight.load(Ordering::Acquire);
    let expected = effective_contents_scale(bounds, backing_scale, video_width, video_height);
    if (layer.contentsScale() - expected).abs() <= 0.001 {
        return false;
    }
    layer.setContentsScale(expected);
    true
}

fn display_layer_forced(layer: &VideoLayer) {
    layer
        .ivars()
        .callback
        .force_render
        .store(true, Ordering::Release);
    layer.display();
}

fn queue_layer_forced_redraw(layer: &VideoLayer) {
    let callback = layer.ivars().callback.clone();
    callback.force_render.store(true, Ordering::Release);
    queue_callback_redraw(callback);
}

// ---- Host view: coalesces video-layer redraws during resize -------------
// The video layer autoresizes to fill this view, but CAOpenGLLayer only
// reallocates its GL drawable + re-renders when explicitly asked. Overriding
// setFrameSize (called by AppKit on every resize step) requests a forced redraw
// at the new capped resolution, even while paused or ended. The callback latch
// coalesces a resize burst instead of synchronously rendering inside AppKit.
struct HostIvars {
    layer: Retained<VideoLayer>,
    surface: Arc<SurfaceState>,
}

define_class!(
    #[unsafe(super(NSView))]
    #[name = "DSVideoHostView"]
    #[ivars = HostIvars]
    #[thread_kind = MainThreadOnly]
    struct HostView;

    impl HostView {
        #[unsafe(method(setFrameSize:))]
        fn set_frame_size(&self, size: NSSize) {
            let surface = &self.ivars().surface;
            surface
                .host_ptr
                .store(self as *const HostView as usize, Ordering::Release);
            unsafe {
                let _: () = msg_send![super(self), setFrameSize: size];
            }
            let layer = &self.ivars().layer;
            // A fullscreen transition can move the window to a screen with a
            // different backing scale without delivering the backing callback
            // before this resize. Always pair the resized bounds with the live
            // window scale before requesting the redraw.
            let b = self.bounds();
            if let Some(window) = self.window() {
                sync_layer_render_scale(layer, surface, b.size, window.backingScaleFactor());
            }
            // Resize the layer to the view + force CAOpenGLLayer to reallocate
            // its GL drawable at the new size (a plain setNeedsDisplay does not
            // reliably grow it). Wrapped so the geometry change doesn't animate.
            layer.setFrame(b);
            layer.setBounds(NSRect::new(NSPoint::new(0.0, 0.0), b.size));
            log_geometry_on_main(
                "set-frame-size",
                surface,
                &format!("requested={:.2}x{:.2}", size.width, size.height),
            );
            queue_layer_forced_redraw(layer);
        }

        // AppKit fires this whenever the backing SCALE FACTOR changes - most often
        // when the window is dragged between a Retina (2x) and a non-Retina (1x)
        // display. contentsScale is otherwise set ONCE at setup, so without this the
        // CAOpenGLLayer keeps rendering at the launch display's pixel density:
        // half-resolution (soft/blurry) on 1x→2x, or wastefully 2x on 2x→1x. Re-sync
        // it and force a render at the current capped target resolution.
        #[unsafe(method(viewDidChangeBackingProperties))]
        fn view_did_change_backing_properties(&self) {
            unsafe {
                let _: () = msg_send![super(self), viewDidChangeBackingProperties];
            }
            let scale = self
                .window()
                .map(|w| w.backingScaleFactor())
                .unwrap_or(1.0);
            let layer = &self.ivars().layer;
            let b = self.bounds();
            sync_layer_render_scale(layer, &self.ivars().surface, b.size, scale);
            layer.setFrame(b);
            layer.setBounds(NSRect::new(NSPoint::new(0.0, 0.0), b.size));
            log_geometry_on_main(
                "backing-change",
                &self.ivars().surface,
                &format!("new_scale={scale:.3}"),
            );
            queue_layer_forced_redraw(layer);
        }

        #[unsafe(method(windowWillEnterFullScreen:))]
        fn window_will_enter_full_screen(&self, _notification: &NSNotification) {
            let surface = &self.ivars().surface;
            note_fullscreen_will_enter(surface);
            log_fullscreen_state_on_main(surface, "will-enter");
        }

        #[unsafe(method(windowDidEnterFullScreen:))]
        fn window_did_enter_full_screen(&self, _notification: &NSNotification) {
            let surface = &self.ivars().surface;
            note_fullscreen_did_enter(surface);
            log_fullscreen_state_on_main(surface, "did-enter");
            if surface.dead.load(Ordering::Acquire) {
                return;
            }
            // AppKit owns the NSWindow frame during the transition, but the video
            // hierarchy is ours. Repair it against the final screen-sized content
            // bounds even if autoresizing did not invoke setFrameSize.
            verify_and_repair_geometry_on_main(
                surface,
                Some("did-enter-fullscreen-check"),
                true,
            );
        }

        #[unsafe(method(windowWillExitFullScreen:))]
        fn window_will_exit_full_screen(&self, _notification: &NSNotification) {
            let surface = &self.ivars().surface;
            note_fullscreen_will_exit(surface);
            log_fullscreen_state_on_main(surface, "will-exit");
        }

        #[unsafe(method(windowDidExitFullScreen:))]
        fn window_did_exit_full_screen(&self, _notification: &NSNotification) {
            let surface = &self.ivars().surface;
            let session_completed = note_fullscreen_did_exit(surface);
            log_fullscreen_state_on_main(surface, "did-exit");
            if surface.dead.load(Ordering::Acquire) {
                return;
            }
            if session_completed {
                // Apply dimensions deferred during the transition before the
                // final forced frame, so mpv sees the final windowed drawable.
                resume_window_wrap_on_main(surface);
            }
            verify_and_repair_geometry_on_main(
                surface,
                Some("did-exit-fullscreen-check"),
                true,
            );
        }

        #[unsafe(method(windowWillClose:))]
        fn window_will_close(&self, _notification: &NSNotification) {
            let surface = self.ivars().surface.clone();
            // Removing the host is part of teardown. Hold the receiver until this
            // notification method returns so removeFromSuperview cannot release it
            // out from under the current Objective-C call.
            let _keep_alive: Option<Retained<HostView>> = unsafe {
                Retained::retain(self as *const HostView as *mut HostView)
            };
            teardown_surface_on_main(&surface, "window-close", false);
        }
    }
);

impl HostView {
    fn new(
        mtm: MainThreadMarker,
        frame: NSRect,
        layer: Retained<VideoLayer>,
        surface: Arc<SurfaceState>,
    ) -> Retained<Self> {
        let this = mtm
            .alloc::<HostView>()
            .set_ivars(HostIvars { layer, surface });
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }
}

// ---- Geometry diagnostics + self-healing -------------------------------

fn rect_text(rect: NSRect) -> String {
    format!(
        "({:.2},{:.2},{:.2},{:.2})",
        rect.origin.x, rect.origin.y, rect.size.width, rect.size.height
    )
}

fn rect_matches(a: NSRect, b: NSRect) -> bool {
    const EPSILON: f64 = 0.25;
    (a.origin.x - b.origin.x).abs() <= EPSILON
        && (a.origin.y - b.origin.y).abs() <= EPSILON
        && (a.size.width - b.size.width).abs() <= EPSILON
        && (a.size.height - b.size.height).abs() <= EPSILON
}

/// Capture every coordinate space that can explain a four-sided inset. This is
/// called only on the AppKit main thread. Each call writes one greppable RPGEO
/// line and also caches the numeric snapshot for the CA first-draw callback.
fn log_geometry_on_main(event: &str, surface: &SurfaceState, extra: &str) {
    if !rp_debug_enabled() {
        return;
    }
    if surface.window_ptr == 0 || surface.content_view_ptr == 0 {
        rp_log(&format!(
            "RPGEO event={event} engine=native-mpv geometry=unavailable {extra}"
        ));
        return;
    }

    let window: &NSWindow = unsafe { &*(surface.window_ptr as *const NSWindow) };
    let content: &NSView = unsafe { &*(surface.content_view_ptr as *const NSView) };
    let window_frame = window.frame();
    let content_frame = content.frame();
    let content_bounds = content.bounds();
    let content_layout = window.contentLayoutRect();
    let safe = content.safeAreaInsets();
    let window_scale = window.backingScaleFactor();
    let actual_content_ptr = window
        .contentView()
        .map(|view| Retained::as_ptr(&view) as usize)
        .unwrap_or(0);

    let (webview_frame, webview_bounds) = if surface.webview_ptr != 0 {
        let view: &NSView = unsafe { &*(surface.webview_ptr as *const NSView) };
        (rect_text(view.frame()), rect_text(view.bounds()))
    } else {
        ("?".to_string(), "?".to_string())
    };
    let (sibling_frame, sibling_bounds) = if surface.webview_sibling_ptr != 0 {
        let sibling: &NSView = unsafe { &*(surface.webview_sibling_ptr as *const NSView) };
        (rect_text(sibling.frame()), rect_text(sibling.bounds()))
    } else {
        ("?".to_string(), "?".to_string())
    };

    let host_ptr = surface.host_ptr.load(Ordering::Acquire);
    let (host_frame, host_bounds, host_parent_ptr) = if host_ptr != 0 {
        let host: &NSView = unsafe { &*(host_ptr as *const NSView) };
        let parent = unsafe { host.superview() }
            .map(|view| Retained::as_ptr(&view) as usize)
            .unwrap_or(0);
        (rect_text(host.frame()), rect_text(host.bounds()), parent)
    } else {
        ("?".to_string(), "?".to_string(), 0)
    };

    let layer_ptr = surface.layer_ptr.load(Ordering::Acquire);
    let (layer_frame, layer_bounds, scale, target_width, target_height) = if layer_ptr != 0 {
        let layer: &VideoLayer = unsafe { &*(layer_ptr as *const VideoLayer) };
        let bounds = layer.bounds();
        let scale = layer.contentsScale();
        (
            rect_text(layer.frame()),
            rect_text(bounds),
            scale,
            (bounds.size.width * scale).round().max(1.0) as i32,
            (bounds.size.height * scale).round().max(1.0) as i32,
        )
    } else {
        ("?".to_string(), "?".to_string(), 0.0, 0, 0)
    };
    let content_aspect = window.contentAspectRatio();
    let fullscreen = window.styleMask().contains(NSWindowStyleMask::FullScreen);
    let (dwidth, dheight) = surface.dimension_text();
    let last_draw_width = surface.last_draw_width.load(Ordering::Acquire);
    let last_draw_height = surface.last_draw_height.load(Ordering::Acquire);
    let fields = format!(
        "window.ptr=0x{:x} window.frame={} window.backingScale={:.3} content.ptr=0x{:x} content.actual=0x{:x} content.frame={} content.bounds={} contentLayoutRect={} content.safe=({:.2},{:.2},{:.2},{:.2}) webview.ptr=0x{:x} webview.frame={} webview.bounds={} sibling.ptr=0x{:x} sibling.frame={} sibling.bounds={} host.ptr=0x{:x} host.super=0x{:x} host.frame={} host.bounds={} layer.ptr=0x{:x} layer.frame={} layer.bounds={} contentsScale={:.3} mpv_target_px={}x{} last_draw_target_px={}x{} dwidth={} dheight={} contentAspect={:.3}x{:.3} fullscreen={}",
        surface.window_ptr,
        rect_text(window_frame),
        window_scale,
        surface.content_view_ptr,
        actual_content_ptr,
        rect_text(content_frame),
        rect_text(content_bounds),
        rect_text(content_layout),
        safe.top,
        safe.left,
        safe.bottom,
        safe.right,
        surface.webview_ptr,
        webview_frame,
        webview_bounds,
        surface.webview_sibling_ptr,
        sibling_frame,
        sibling_bounds,
        host_ptr,
        host_parent_ptr,
        host_frame,
        host_bounds,
        layer_ptr,
        layer_frame,
        layer_bounds,
        scale,
        target_width,
        target_height,
        last_draw_width,
        last_draw_height,
        dwidth,
        dheight,
        content_aspect.width,
        content_aspect.height,
        fullscreen,
    );
    if let Ok(mut cached) = surface.last_main_geometry.lock() {
        *cached = fields.clone();
    }
    rp_log(&format!(
        "RPGEO event={event} engine=native-mpv {fields} {extra}"
    ));
}

fn queue_geometry_check(surface: Arc<SurfaceState>, log_first_draw_result: bool) {
    if surface.dead.load(Ordering::Acquire)
        || surface.geometry_check_queued.swap(true, Ordering::AcqRel)
    {
        return;
    }
    DispatchQueue::main().exec_async(move || {
        surface
            .geometry_check_queued
            .store(false, Ordering::Release);
        if surface.dead.load(Ordering::Acquire) {
            return;
        }
        let log_event = if log_first_draw_result {
            Some("first-draw-check")
        } else {
            None
        };
        verify_and_repair_geometry_on_main(&surface, log_event, false);
    });
}

/// Verify the native hierarchy after CoreAnimation has actually drawn. This runs
/// after attach, at fullscreen completion, and whenever the rendered target size
/// changes. If a framework changed the hierarchy or frame, move the host back
/// below the WKWebView's top-level sibling and re-fill contentView.bounds. This
/// reads NSWindow geometry but mutates only NSView and CALayer properties.
fn verify_and_repair_geometry_on_main(
    surface: &SurfaceState,
    log_event: Option<&str>,
    force_display: bool,
) {
    if surface.dead.load(Ordering::Acquire) {
        return;
    }
    let host_ptr = surface.host_ptr.load(Ordering::Acquire);
    let layer_ptr = surface.layer_ptr.load(Ordering::Acquire);
    if surface.window_ptr == 0 || surface.content_view_ptr == 0 || host_ptr == 0 || layer_ptr == 0 {
        if let Some(event) = log_event {
            log_geometry_on_main(event, surface, "correction=unavailable");
        }
        return;
    }
    let window: &NSWindow = unsafe { &*(surface.window_ptr as *const NSWindow) };
    let content: &NSView = unsafe { &*(surface.content_view_ptr as *const NSView) };
    let host: &HostView = unsafe { &*(host_ptr as *const HostView) };
    let layer: &VideoLayer = unsafe { &*(layer_ptr as *const VideoLayer) };
    let mut corrections = Vec::new();

    let parent_ptr = unsafe { host.superview() }
        .map(|view| Retained::as_ptr(&view) as usize)
        .unwrap_or(0);
    if parent_ptr != surface.content_view_ptr {
        let sibling = if surface.webview_sibling_ptr != 0 {
            Some(unsafe { &*(surface.webview_sibling_ptr as *const NSView) })
        } else {
            None
        };
        content.addSubview_positioned_relativeTo(host, NSWindowOrderingMode::Below, sibling);
        corrections.push("parent");
    }

    let expected_host = content.bounds();
    if !rect_matches(host.frame(), expected_host) {
        host.setFrame(expected_host);
        corrections.push("host-frame");
    }
    let host_bounds = host.bounds();
    let expected_layer_bounds = NSRect::new(NSPoint::new(0.0, 0.0), host_bounds.size);
    if !rect_matches(layer.frame(), host_bounds) {
        layer.setFrame(host_bounds);
        corrections.push("layer-frame");
    }
    if !rect_matches(layer.bounds(), expected_layer_bounds) {
        layer.setBounds(expected_layer_bounds);
        corrections.push("layer-bounds");
    }
    if sync_layer_render_scale(
        layer,
        surface,
        host_bounds.size,
        window.backingScaleFactor(),
    ) {
        corrections.push("contents-scale");
    }
    if force_display {
        // A fullscreen transition may discard a previously delivered Core
        // Animation invalidation. Draw against the final repaired geometry now
        // instead of relying on any asynchronous scheduling state.
        display_layer_forced(layer);
    } else if !corrections.is_empty() {
        queue_layer_forced_redraw(layer);
    }
    let correction = if corrections.is_empty() {
        "none".to_string()
    } else {
        corrections.join(",")
    };
    if let Some(event) = log_event {
        log_geometry_on_main(event, surface, &format!("correction={correction}"));
    } else if !corrections.is_empty() {
        log_geometry_on_main(
            "drawable-change-check",
            surface,
            &format!("correction={correction}"),
        );
    }
}

// ---- Native NSWindow aspect lifecycle ----------------------------------

fn gcd(mut a: i64, mut b: i64) -> i64 {
    while b != 0 {
        let remainder = a % b;
        a = b;
        b = remainder;
    }
    a.max(1)
}

fn positive_finite_size(size: NSSize) -> bool {
    size.width.is_finite() && size.height.is_finite() && size.width > 0.0 && size.height > 0.0
}

fn positive_finite_rect(rect: NSRect) -> bool {
    rect.origin.x.is_finite() && rect.origin.y.is_finite() && positive_finite_size(rect.size)
}

fn normalized_aspect(width: i64, height: i64) -> Option<NSSize> {
    if width <= 0 || height <= 0 {
        return None;
    }
    let divisor = gcd(width, height);
    let aspect = NSSize::new((width / divisor) as f64, (height / divisor) as f64);
    if positive_finite_size(aspect) {
        Some(aspect)
    } else {
        None
    }
}

fn validated_video_aspect(width: i64, height: i64) -> Option<(f64, NSSize)> {
    let normalized = normalized_aspect(width, height)?;
    let scalar = width as f64 / height as f64;
    if scalar.is_finite() && scalar > 0.0 {
        Some((scalar, normalized))
    } else {
        None
    }
}

fn validated_content_minimum(minimum: NSSize) -> Option<NSSize> {
    if !minimum.width.is_finite()
        || !minimum.height.is_finite()
        || minimum.width < 0.0
        || minimum.height < 0.0
    {
        return None;
    }
    Some(NSSize::new(minimum.width.max(1.0), minimum.height.max(1.0)))
}

fn size_meets_minimum(size: NSSize, minimum: NSSize) -> bool {
    positive_finite_size(size)
        && positive_finite_size(minimum)
        && size.width >= minimum.width
        && size.height >= minimum.height
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WrapPostconditionDecision {
    Complete,
    Retry,
    Pending,
}

const MAX_WRAP_POSTCONDITION_ATTEMPTS: u8 = 4;

fn wrap_postcondition_decision(
    observed: NSSize,
    target: NSSize,
    attempts: u8,
) -> WrapPostconditionDecision {
    const EPSILON: f64 = 0.25;
    if positive_finite_size(observed)
        && positive_finite_size(target)
        && (observed.width - target.width).abs() <= EPSILON
        && (observed.height - target.height).abs() <= EPSILON
    {
        WrapPostconditionDecision::Complete
    } else if attempts.saturating_add(1) >= MAX_WRAP_POSTCONDITION_ATTEMPTS {
        WrapPostconditionDecision::Pending
    } else {
        WrapPostconditionDecision::Retry
    }
}

fn screen_limits(window: &NSWindow) -> (Option<NSRect>, NSSize) {
    let visible = window.screen().map(|screen| screen.visibleFrame());
    let maximum = visible
        .map(|frame| window.contentRectForFrameRect(frame).size)
        .unwrap_or_else(|| NSSize::new(f64::MAX / 4.0, f64::MAX / 4.0));
    (visible, maximum)
}

fn bounded_minimum(minimum: NSSize, maximum: NSSize) -> NSSize {
    NSSize::new(
        minimum.width.max(1.0).min(maximum.width.max(1.0)),
        minimum.height.max(1.0).min(maximum.height.max(1.0)),
    )
}

fn aspect_preserving_screen_clamp(size: NSSize, maximum: NSSize) -> NSSize {
    let scale = (maximum.width.max(1.0) / size.width.max(1.0))
        .min(maximum.height.max(1.0) / size.height.max(1.0))
        .min(1.0);
    NSSize::new(size.width * scale, size.height * scale)
}

fn exact_size_or_letterbox(exact: NSSize, minimum: NSSize, maximum: NSSize) -> (NSSize, bool) {
    let fitted = aspect_preserving_screen_clamp(exact, maximum);
    if fitted.width + 0.01 >= minimum.width.max(1.0)
        && fitted.height + 0.01 >= minimum.height.max(1.0)
    {
        (fitted, false)
    } else {
        // The visible screen cannot contain this aspect at or above both
        // content minimums. This is the only path that permits letterboxing.
        (bounded_minimum(minimum, maximum), true)
    }
}

/// Preserve width, but grow it when the resulting exact-aspect height would
/// violate the content minimum. Any screen clamp scales both axes together.
fn width_based_wrap_size(
    current: NSSize,
    aspect: f64,
    minimum: NSSize,
    maximum: NSSize,
) -> (NSSize, bool) {
    let mut width = current.width.max(minimum.width).max(1.0);
    let mut height = width / aspect;
    if height + 0.01 < minimum.height.max(1.0) {
        height = minimum.height.max(1.0);
        width = height * aspect;
    }
    exact_size_or_letterbox(NSSize::new(width, height), minimum, maximum)
}

/// Preserve height for tall content, growing it when the resulting exact-aspect
/// width would violate the content minimum. The final clamp stays exact-aspect.
fn height_based_wrap_size(
    current: NSSize,
    aspect: f64,
    minimum: NSSize,
    maximum: NSSize,
) -> (NSSize, bool) {
    let mut height = current.height.max(minimum.height).max(1.0);
    let mut width = height * aspect;
    if width + 0.01 < minimum.width.max(1.0) {
        width = minimum.width.max(1.0);
        height = width / aspect;
    }
    exact_size_or_letterbox(NSSize::new(width, height), minimum, maximum)
}

/// The first wrap follows the content axis: wide video preserves width and tall
/// video preserves height. Both paths grow the preserved axis to satisfy the
/// other minimum before applying an aspect-preserving screen clamp.
fn first_wrap_size(
    current: NSSize,
    aspect: f64,
    minimum: NSSize,
    maximum: NSSize,
) -> (NSSize, bool) {
    if aspect >= 1.0 {
        width_based_wrap_size(current, aspect, minimum, maximum)
    } else {
        height_based_wrap_size(current, aspect, minimum, maximum)
    }
}

/// Later aspect changes keep the established width-preserving behavior, with
/// the same minimum-driven growth and exact-aspect screen clamp as a wide first
/// wrap.
fn width_preserving_wrap_size(
    current: NSSize,
    aspect: f64,
    minimum: NSSize,
    maximum: NSSize,
) -> (NSSize, bool) {
    width_based_wrap_size(current, aspect, minimum, maximum)
}

fn centered_frame_within_visible(
    window: &NSWindow,
    old_frame: NSRect,
    content_size: NSSize,
    visible_frame: Option<NSRect>,
) -> NSRect {
    let content_rect = NSRect::new(NSPoint::new(0.0, 0.0), content_size);
    let fitted_size = window.frameRectForContentRect(content_rect).size;
    let mut origin = NSPoint::new(
        old_frame.origin.x + (old_frame.size.width - fitted_size.width) / 2.0,
        old_frame.origin.y + (old_frame.size.height - fitted_size.height) / 2.0,
    );
    if let Some(visible) = visible_frame {
        let max_x = visible.origin.x + (visible.size.width - fitted_size.width).max(0.0);
        let max_y = visible.origin.y + (visible.size.height - fitted_size.height).max(0.0);
        origin.x = origin.x.max(visible.origin.x).min(max_x);
        origin.y = origin.y.max(visible.origin.y).min(max_y);
    }
    NSRect::new(origin, fitted_size)
}

fn set_window_frame_if_valid_on_main(
    surface: &SurfaceState,
    window: &NSWindow,
    frame: NSRect,
    target: &str,
) -> bool {
    if !positive_finite_rect(frame) {
        log_geometry_on_main(
            "window-wrap",
            surface,
            &format!(
                "action=skip-invalid-frame target={target} proposed_frame={}",
                rect_text(frame)
            ),
        );
        return false;
    }
    window.setFrame_display(frame, true);
    true
}

fn set_window_content_aspect_if_valid_on_main(
    surface: &SurfaceState,
    window: &NSWindow,
    aspect: NSSize,
) -> bool {
    if !positive_finite_size(aspect) {
        log_geometry_on_main(
            "window-wrap",
            surface,
            &format!(
                "action=skip-invalid-content-aspect proposed_ratio={}x{}",
                aspect.width, aspect.height
            ),
        );
        return false;
    }
    window.setContentAspectRatio(aspect);
    true
}

// NSNotificationCenter does not own selector observers strongly. Keep exactly
// one post-fullscreen cleanup alive per NSWindow without placing it on the host
// view that teardown removes. The registry contains raw retained pointers only;
// all insertion/removal and Objective-C dereferences happen on the main thread.
static POST_FULLSCREEN_CLEANUPS: OnceLock<Mutex<HashMap<usize, usize>>> = OnceLock::new();

fn post_fullscreen_cleanup_registry() -> &'static Mutex<HashMap<usize, usize>> {
    POST_FULLSCREEN_CLEANUPS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn take_post_fullscreen_cleanup_on_main(
    window_ptr: usize,
    expected_observer_ptr: Option<usize>,
) -> Option<Retained<PostFullscreenCleanup>> {
    let raw = {
        let mut registry = post_fullscreen_cleanup_registry().lock().unwrap();
        let observer_ptr = *registry.get(&window_ptr)?;
        if let Some(expected) = expected_observer_ptr {
            if expected != observer_ptr {
                return None;
            }
        }
        registry.remove(&window_ptr)
    }?;
    unsafe { Retained::from_raw(raw as *mut PostFullscreenCleanup) }
}

fn discard_window_wrap_state(surface: &SurfaceState) {
    surface.wrap_needs_resize.store(false, Ordering::Release);
    surface
        .wrap_postcondition_attempts
        .store(0, Ordering::Release);
    surface
        .wrap_constraint_applied
        .store(false, Ordering::Release);
    surface.wrap_has_applied.store(false, Ordering::Release);
    surface.wrap_restore_pending.store(false, Ordering::Release);
    surface
        .fullscreen_session_active
        .store(false, Ordering::Release);
    surface
        .fullscreen_enter_in_flight
        .store(false, Ordering::Release);
    surface
        .fullscreen_exit_in_flight
        .store(false, Ordering::Release);
    if let Ok(mut saved) = surface.pre_wrap_frame.lock() {
        *saved = None;
    }
}

fn cancel_post_fullscreen_cleanup_on_main(
    window_ptr: usize,
    reason: &str,
) -> Option<(bool, bool, bool, bool)> {
    let observer = take_post_fullscreen_cleanup_on_main(window_ptr, None)?;
    let center = NSNotificationCenter::defaultCenter();
    unsafe { center.removeObserver(&observer) };
    let surface = &observer.ivars().surface;
    let transition_state = (
        surface.fullscreen_session_active.load(Ordering::Acquire),
        surface.fullscreen_enter_in_flight.load(Ordering::Acquire),
        surface.fullscreen_exit_in_flight.load(Ordering::Acquire),
        surface.webview_transparent.load(Ordering::Acquire),
    );
    discard_window_wrap_state(surface);
    rp_log(&format!(
        "post-fullscreen-cleanup: action=cancel window=0x{window_ptr:x} reason={reason}"
    ));
    Some(transition_state)
}

fn register_post_fullscreen_cleanup_on_main(surface: Arc<SurfaceState>) {
    let window_ptr = surface.window_ptr;
    if window_ptr == 0 {
        return;
    }
    let _ = cancel_post_fullscreen_cleanup_on_main(window_ptr, "replace");

    let mtm = MainThreadMarker::new()
        .expect("post-fullscreen cleanup must be registered on the main thread");
    let window: &NSWindow = unsafe { &*(window_ptr as *const NSWindow) };
    let observer = PostFullscreenCleanup::new(mtm, surface);
    let center = NSNotificationCenter::defaultCenter();
    unsafe {
        center.addObserver_selector_name_object(
            &observer,
            objc2::sel!(windowWillEnterFullScreen:),
            Some(NSWindowWillEnterFullScreenNotification),
            Some(window),
        );
        center.addObserver_selector_name_object(
            &observer,
            objc2::sel!(windowDidEnterFullScreen:),
            Some(NSWindowDidEnterFullScreenNotification),
            Some(window),
        );
        center.addObserver_selector_name_object(
            &observer,
            objc2::sel!(windowWillExitFullScreen:),
            Some(NSWindowWillExitFullScreenNotification),
            Some(window),
        );
        center.addObserver_selector_name_object(
            &observer,
            objc2::sel!(windowDidExitFullScreen:),
            Some(NSWindowDidExitFullScreenNotification),
            Some(window),
        );
        center.addObserver_selector_name_object(
            &observer,
            objc2::sel!(windowWillClose:),
            Some(NSWindowWillCloseNotification),
            Some(window),
        );
    }
    let observer_ptr = Retained::as_ptr(&observer) as usize;
    let retained_ptr = Retained::into_raw(observer) as usize;
    post_fullscreen_cleanup_registry()
        .lock()
        .unwrap()
        .insert(window_ptr, retained_ptr);
    rp_log(&format!(
        "post-fullscreen-cleanup: action=register window=0x{window_ptr:x} observer=0x{observer_ptr:x}"
    ));
}

fn finish_post_fullscreen_cleanup_on_main(
    observer: &PostFullscreenCleanup,
    apply_window_cleanup: bool,
    reason: &str,
) {
    let window_ptr = observer.ivars().surface.window_ptr;
    let observer_ptr = observer as *const PostFullscreenCleanup as usize;
    let Some(owner) = take_post_fullscreen_cleanup_on_main(window_ptr, Some(observer_ptr)) else {
        return;
    };

    // The registry-owned retain keeps the observer alive through this callback.
    // Stop every notification before its retain is released at function exit.
    let center = NSNotificationCenter::defaultCenter();
    unsafe { center.removeObserver(observer) };

    let surface = &owner.ivars().surface;
    let mut window_cleanup_applied = false;
    if apply_window_cleanup {
        let cleared = clear_window_aspect_on_main(surface, reason);
        if cleared {
            window_cleanup_applied = true;
            restore_pre_wrap_frame_on_main(surface, reason);
        }
    }
    // Teardown deliberately kept the webview transparent for the same complete
    // fullscreen interval as the deferred NSWindow cleanup. This is a view-only
    // WebKit mutation, not an NSWindow frame/aspect mutation, but sharing the
    // established DidExit point keeps one lifecycle authority.
    restore_webview_opacity_on_main(surface, reason);
    discard_window_wrap_state(surface);
    rp_log(&format!(
        "post-fullscreen-cleanup: action=finish window=0x{window_ptr:x} observer=0x{observer_ptr:x} reason={reason} applied={window_cleanup_applied}"
    ));
}

fn save_pre_wrap_frame_on_main(surface: &SurfaceState, frame: NSRect) -> bool {
    let first_wrap = !surface.wrap_has_applied.load(Ordering::Acquire);
    if !first_wrap {
        return false;
    }
    if !positive_finite_rect(frame) {
        log_geometry_on_main(
            "window-wrap",
            surface,
            &format!(
                "action=skip-invalid-frame-snapshot proposed_frame={}",
                rect_text(frame)
            ),
        );
        return false;
    }
    if let Ok(mut saved) = surface.pre_wrap_frame.lock() {
        if saved.is_none() {
            *saved = Some(FrameSnapshot::from_rect(frame));
        }
    }
    first_wrap
}

/// AppKit owns every NSWindow property for the complete fullscreen lifecycle.
/// The style bit covers stable fullscreen and the explicit flags cover both
/// transition intervals. The session latch deliberately stays set from
/// WillEnter through DidExit as a conservative fallback if WillExit is late or
/// absent while AppKit has already cleared the style bit.
fn fullscreen_blocks_window_mutation(
    style_fullscreen: bool,
    session_active: bool,
    enter_in_flight: bool,
    exit_in_flight: bool,
) -> bool {
    style_fullscreen || session_active || enter_in_flight || exit_in_flight
}

fn in_fullscreen_or_transition_on_main(surface: &SurfaceState, window: &NSWindow) -> bool {
    fullscreen_blocks_window_mutation(
        window.styleMask().contains(NSWindowStyleMask::FullScreen),
        surface.fullscreen_session_active.load(Ordering::Acquire),
        surface.fullscreen_enter_in_flight.load(Ordering::Acquire),
        surface.fullscreen_exit_in_flight.load(Ordering::Acquire),
    )
}

fn window_property_mutation_allowed_on_main(surface: &SurfaceState, window: &NSWindow) -> bool {
    !in_fullscreen_or_transition_on_main(surface, window)
}

fn log_fullscreen_state_on_main(surface: &SurfaceState, event: &str) {
    if surface.window_ptr == 0 {
        return;
    }
    let window: &NSWindow = unsafe { &*(surface.window_ptr as *const NSWindow) };
    let style_fullscreen = window.styleMask().contains(NSWindowStyleMask::FullScreen);
    let session_active = surface.fullscreen_session_active.load(Ordering::Acquire);
    let enter_in_flight = surface.fullscreen_enter_in_flight.load(Ordering::Acquire);
    let exit_in_flight = surface.fullscreen_exit_in_flight.load(Ordering::Acquire);
    log_geometry_on_main(
        "window-wrap",
        surface,
        &format!(
            "action=fullscreen-state event={event} style_fullscreen={style_fullscreen} session_active={session_active} enter_in_flight={enter_in_flight} exit_in_flight={exit_in_flight}"
        ),
    );
}

fn restore_pre_wrap_frame_on_main(surface: &SurfaceState, reason: &str) -> bool {
    let saved = surface.pre_wrap_frame.lock().ok().and_then(|frame| *frame);
    let Some(saved) = saved else {
        surface.wrap_restore_pending.store(false, Ordering::Release);
        return false;
    };
    if surface.window_ptr == 0 {
        surface.wrap_restore_pending.store(true, Ordering::Release);
        return false;
    }
    let window: &NSWindow = unsafe { &*(surface.window_ptr as *const NSWindow) };
    let saved_frame = saved.as_rect();
    if !positive_finite_rect(saved_frame) {
        if let Ok(mut frame) = surface.pre_wrap_frame.lock() {
            *frame = None;
        }
        surface.wrap_restore_pending.store(false, Ordering::Release);
        log_geometry_on_main(
            "window-wrap",
            surface,
            &format!(
                "action=discard-invalid-session-frame reason={reason} proposed_frame={}",
                rect_text(saved_frame)
            ),
        );
        return true;
    }
    // Re-evaluate the complete predicate immediately before setFrame. Queued
    // reconciliation may have been requested before a transition began.
    if !window_property_mutation_allowed_on_main(surface, window) {
        surface.wrap_restore_pending.store(true, Ordering::Release);
        log_geometry_on_main(
            "window-wrap",
            surface,
            &format!("action=defer-session-frame-restore reason={reason}"),
        );
        return false;
    }
    if !set_window_frame_if_valid_on_main(surface, window, saved_frame, "session-restore") {
        return false;
    }
    if let Ok(mut saved_frame) = surface.pre_wrap_frame.lock() {
        *saved_frame = None;
    }
    surface.wrap_restore_pending.store(false, Ordering::Release);
    log_geometry_on_main(
        "window-wrap",
        surface,
        &format!("action=restore-session-frame reason={reason}"),
    );
    true
}

fn clear_window_aspect_on_main(surface: &SurfaceState, reason: &str) -> bool {
    if surface.window_ptr == 0 {
        return false;
    }
    let window: &NSWindow = unsafe { &*(surface.window_ptr as *const NSWindow) };
    // Cancelling the content ratio is a real NSWindow property mutation. Never
    // do it while fullscreen or while either transition is in flight.
    if !window_property_mutation_allowed_on_main(surface, window) {
        log_geometry_on_main(
            "window-wrap",
            surface,
            &format!("action=defer-clear reason={reason}"),
        );
        return false;
    }
    // Positive unit resize increments cancel the mutually exclusive content
    // aspect constraint without passing a zero-dimension ratio to AppKit.
    window.setContentResizeIncrements(NSSize::new(1.0, 1.0));
    surface
        .wrap_constraint_applied
        .store(false, Ordering::Release);
    log_geometry_on_main(
        "window-wrap",
        surface,
        &format!("action=clear reason={reason}"),
    );
    true
}

fn reconcile_window_wrap_on_main(surface: &Arc<SurfaceState>) {
    if surface.dead.load(Ordering::Acquire) {
        return;
    }
    // Fullscreen state gates NSWindow properties only. Host/layer/FBO geometry
    // remains live and is reconciled before any fullscreen early return below.
    verify_and_repair_geometry_on_main(surface, None, false);
    if surface.wrap_reconciling.swap(true, Ordering::AcqRel) {
        return;
    }

    let reconcile = || {
        if surface.window_ptr == 0 || surface.content_view_ptr == 0 {
            return;
        }
        let window: &NSWindow = unsafe { &*(surface.window_ptr as *const NSWindow) };
        if in_fullscreen_or_transition_on_main(surface, window) {
            return;
        }
        let restore_pending = surface.wrap_restore_pending.load(Ordering::Acquire);
        if restore_pending {
            clear_window_aspect_on_main(surface, "playback-ended");
            restore_pre_wrap_frame_on_main(surface, "playback-ended");
        }
        if !surface.wrap_active.load(Ordering::Acquire) {
            if !restore_pending {
                clear_window_aspect_on_main(surface, "inactive");
            }
            return;
        }

        let width = surface.dwidth.load(Ordering::Acquire);
        let height = surface.dheight.load(Ordering::Acquire);
        let Some((aspect, normalized_aspect)) = validated_video_aspect(width, height) else {
            // Leave the current frame and constraint untouched. A later positive
            // dwidth/dheight pair queues another reconciliation.
            surface.wrap_needs_resize.store(true, Ordering::Release);
            rp_log(&format!(
                "RPGEO event=window-wrap engine=native-mpv action=skip-invalid-video-dimensions dwidth={width} dheight={height} retry=pending"
            ));
            return;
        };

        let content: &NSView = unsafe { &*(surface.content_view_ptr as *const NSView) };
        let before = content.bounds().size;
        let old_frame = window.frame();
        if !positive_finite_size(before) || !positive_finite_rect(old_frame) {
            surface.wrap_needs_resize.store(true, Ordering::Release);
            log_geometry_on_main(
                "window-wrap",
                surface,
                &format!(
                    "action=skip-invalid-current-geometry content={}x{} window_frame={}",
                    before.width,
                    before.height,
                    rect_text(old_frame)
                ),
            );
            return;
        }
        let first_wrap = save_pre_wrap_frame_on_main(surface, old_frame);
        let resize_requested = surface.wrap_needs_resize.load(Ordering::Acquire);
        let mut resized = false;
        let mut internal_letterbox = false;
        let mut fitted_target = None;
        if resize_requested {
            let raw_minimum = window.contentMinSize();
            let Some(minimum) = validated_content_minimum(raw_minimum) else {
                log_geometry_on_main(
                    "window-wrap",
                    surface,
                    &format!(
                        "action=skip-invalid-content-minimum content_min={}x{}",
                        raw_minimum.width, raw_minimum.height
                    ),
                );
                return;
            };
            let (visible_frame, maximum) = screen_limits(window);
            if !positive_finite_size(maximum) {
                log_geometry_on_main(
                    "window-wrap",
                    surface,
                    &format!(
                        "action=skip-invalid-screen-maximum content_max={}x{}",
                        maximum.width, maximum.height
                    ),
                );
                return;
            }
            let (fitted, letterbox) = if first_wrap {
                first_wrap_size(before, aspect, minimum, maximum)
            } else {
                width_preserving_wrap_size(before, aspect, minimum, maximum)
            };
            if !size_meets_minimum(fitted, minimum) {
                surface.wrap_needs_resize.store(true, Ordering::Release);
                log_geometry_on_main(
                    "window-wrap",
                    surface,
                    &format!(
                        "action=skip-invalid-fitted-size fitted={}x{} content_min={}x{}",
                        fitted.width, fitted.height, minimum.width, minimum.height
                    ),
                );
                return;
            }
            internal_letterbox = letterbox;
            fitted_target = Some(fitted);
            if (fitted.width - before.width).abs() > 0.01
                || (fitted.height - before.height).abs() > 0.01
            {
                let centered =
                    centered_frame_within_visible(window, old_frame, fitted, visible_frame);
                // Remove any ratio retained from an earlier file before applying
                // the exact fitted content size. Otherwise AppKit can constrain
                // setFrame with the old ratio and postpone the new ratio until
                // the user's first manual resize.
                if !window_property_mutation_allowed_on_main(surface, window) {
                    surface.wrap_needs_resize.store(true, Ordering::Release);
                    return;
                }
                if !clear_window_aspect_on_main(surface, "pre-video-wrap") {
                    surface.wrap_needs_resize.store(true, Ordering::Release);
                    return;
                }
                // The clear above can synchronously run AppKit code. Re-check at
                // the exact setFrame call site in case a transition has started.
                if !window_property_mutation_allowed_on_main(surface, window) {
                    surface.wrap_needs_resize.store(true, Ordering::Release);
                    return;
                }
                if !set_window_frame_if_valid_on_main(surface, window, centered, "video-wrap") {
                    surface.wrap_needs_resize.store(true, Ordering::Release);
                    return;
                }
                resized = true;
            }
        }

        if let Some(target) = fitted_target {
            let observed = content.bounds().size;
            let attempts = surface.wrap_postcondition_attempts.load(Ordering::Acquire);
            match wrap_postcondition_decision(observed, target, attempts) {
                WrapPostconditionDecision::Complete => {
                    surface.wrap_needs_resize.store(false, Ordering::Release);
                    surface
                        .wrap_postcondition_attempts
                        .store(0, Ordering::Release);
                }
                WrapPostconditionDecision::Retry => {
                    surface
                        .wrap_postcondition_attempts
                        .store(attempts.saturating_add(1), Ordering::Release);
                    log_geometry_on_main(
                        "window-wrap",
                        surface,
                        &format!(
                            "action=retry-content-postcondition target={:.2}x{:.2} observed={:.2}x{:.2}",
                            target.width, target.height, observed.width, observed.height
                        ),
                    );
                    queue_window_wrap_reconcile(surface.clone());
                    return;
                }
                WrapPostconditionDecision::Pending => {
                    log_geometry_on_main(
                        "window-wrap",
                        surface,
                        &format!(
                            "action=content-postcondition-pending target={:.2}x{:.2} observed={:.2}x{:.2} retry=exhausted",
                            target.width, target.height, observed.width, observed.height
                        ),
                    );
                    return;
                }
            }
        }

        // setFrame above can synchronously run AppKit code, so the aspect call
        // gets its own fresh transition check rather than sharing the prior one.
        if !window_property_mutation_allowed_on_main(surface, window) {
            surface.wrap_needs_resize.store(true, Ordering::Release);
            return;
        }
        if !set_window_content_aspect_if_valid_on_main(surface, window, normalized_aspect) {
            surface.wrap_needs_resize.store(true, Ordering::Release);
            return;
        }
        surface
            .wrap_constraint_applied
            .store(true, Ordering::Release);
        surface.wrap_has_applied.store(true, Ordering::Release);
        if resize_requested {
            let layer_ptr = surface.layer_ptr.load(Ordering::Acquire);
            if layer_ptr != 0 {
                let layer: &VideoLayer = unsafe { &*(layer_ptr as *const VideoLayer) };
                display_layer_forced(layer);
            }
        }
        if rp_debug_enabled() {
            let after = content.bounds().size;
            let minimum = window.contentMinSize();
            log_geometry_on_main(
                "window-wrap",
                surface,
                &format!(
                    "action=apply ratio={:.0}x{:.0} policy={} resized={} internal_letterbox={} content_before={:.2}x{:.2} content_after={:.2}x{:.2} content_min={:.2}x{:.2}",
                    normalized_aspect.width,
                    normalized_aspect.height,
                    if first_wrap {
                        if width >= height {
                            "first-wide-width"
                        } else {
                            "first-tall-height"
                        }
                    } else {
                        "width-preserving"
                    },
                    resized,
                    internal_letterbox,
                    before.width,
                    before.height,
                    after.width,
                    after.height,
                    minimum.width,
                    minimum.height,
                ),
            );
        }
    };
    reconcile();
    surface.wrap_reconciling.store(false, Ordering::Release);
}

fn queue_window_wrap_reconcile(surface: Arc<SurfaceState>) {
    if surface.dead.load(Ordering::Acquire)
        || surface.wrap_dispatch_queued.swap(true, Ordering::AcqRel)
    {
        return;
    }
    DispatchQueue::main().exec_async(move || {
        surface.wrap_dispatch_queued.store(false, Ordering::Release);
        if !surface.dead.load(Ordering::Acquire) {
            reconcile_window_wrap_on_main(&surface);
        }
    });
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ResumeWrapDecision {
    Skip,
    Reconcile,
    ResizeAndReconcile,
}

fn resume_wrap_decision(
    dead: bool,
    window_available: bool,
    fullscreen_blocked: bool,
    wrap_active: bool,
) -> ResumeWrapDecision {
    if dead || !window_available || fullscreen_blocked {
        ResumeWrapDecision::Skip
    } else if wrap_active {
        ResumeWrapDecision::ResizeAndReconcile
    } else {
        ResumeWrapDecision::Reconcile
    }
}

fn resume_window_wrap_on_main(surface: &Arc<SurfaceState>) {
    let dead = surface.dead.load(Ordering::Acquire);
    if dead || surface.window_ptr == 0 {
        return;
    }
    let window: &NSWindow = unsafe { &*(surface.window_ptr as *const NSWindow) };
    // DidExit is the normal resume point, but evaluate the full predicate here
    // as well. This also protects against a new transition initiated by another
    // observer before this callback runs.
    match resume_wrap_decision(
        dead,
        true,
        in_fullscreen_or_transition_on_main(surface, window),
        surface.wrap_active.load(Ordering::Acquire),
    ) {
        ResumeWrapDecision::Skip => return,
        ResumeWrapDecision::Reconcile => {}
        ResumeWrapDecision::ResizeAndReconcile => {
            surface.wrap_needs_resize.store(true, Ordering::Release);
            surface
                .wrap_postcondition_attempts
                .store(0, Ordering::Release);
        }
    }
    reconcile_window_wrap_on_main(surface);
}

fn register_window_observers(host: &HostView, window: &NSWindow) {
    let center = NSNotificationCenter::defaultCenter();
    unsafe {
        center.addObserver_selector_name_object(
            host,
            objc2::sel!(windowWillEnterFullScreen:),
            Some(NSWindowWillEnterFullScreenNotification),
            Some(window),
        );
        center.addObserver_selector_name_object(
            host,
            objc2::sel!(windowDidEnterFullScreen:),
            Some(NSWindowDidEnterFullScreenNotification),
            Some(window),
        );
        center.addObserver_selector_name_object(
            host,
            objc2::sel!(windowWillExitFullScreen:),
            Some(NSWindowWillExitFullScreenNotification),
            Some(window),
        );
        center.addObserver_selector_name_object(
            host,
            objc2::sel!(windowDidExitFullScreen:),
            Some(NSWindowDidExitFullScreenNotification),
            Some(window),
        );
        center.addObserver_selector_name_object(
            host,
            objc2::sel!(windowWillClose:),
            Some(NSWindowWillCloseNotification),
            Some(window),
        );
    }
}

fn remove_window_observers(host: &HostView) {
    let center = NSNotificationCenter::defaultCenter();
    unsafe { center.removeObserver(host) };
}

fn teardown_surface_on_main(surface: &Arc<SurfaceState>, reason: &str, restore_window_frame: bool) {
    if surface.dead.swap(true, Ordering::AcqRel) {
        return;
    }
    surface.wrap_active.store(false, Ordering::Release);

    let host_ptr = surface.host_ptr.load(Ordering::Acquire);
    let layer_ptr = surface.layer_ptr.load(Ordering::Acquire);
    if layer_ptr != 0 {
        let layer: &VideoLayer = unsafe { &*(layer_ptr as *const VideoLayer) };
        layer.ivars().callback.begin_teardown();
    }

    let window_cleanup_deferred = if restore_window_frame && surface.window_ptr != 0 {
        let window: &NSWindow = unsafe { &*(surface.window_ptr as *const NSWindow) };
        if in_fullscreen_or_transition_on_main(surface, window) {
            // Register before removing the host's observers. The independent
            // helper owns an Arc<SurfaceState>, so the saved frame and transition
            // flags remain alive after the host and MacosSurface are gone.
            register_post_fullscreen_cleanup_on_main(surface.clone());
            true
        } else {
            let had_saved_frame = surface
                .pre_wrap_frame
                .lock()
                .map(|frame| frame.is_some())
                .unwrap_or(false);
            let cleared = clear_window_aspect_on_main(surface, reason);
            let restored = restore_pre_wrap_frame_on_main(surface, reason);
            if !cleared || (had_saved_frame && !restored) {
                // A setter above can synchronously run AppKit. If that started a
                // fullscreen transition, preserve the still-pending work rather
                // than discarding it at the end of teardown.
                register_post_fullscreen_cleanup_on_main(surface.clone());
                true
            } else {
                false
            }
        }
    } else {
        // windowWillClose needs no cosmetic cleanup. In particular, never touch
        // a closing fullscreen window just to reset a constraint it cannot reuse.
        false
    };

    surface.wrap_needs_resize.store(false, Ordering::Release);
    if !window_cleanup_deferred {
        discard_window_wrap_state(surface);
    }

    if host_ptr != 0 {
        let host: &HostView = unsafe { &*(host_ptr as *const HostView) };
        remove_window_observers(host);
    }
    if layer_ptr != 0 {
        let layer: &VideoLayer = unsafe { &*(layer_ptr as *const VideoLayer) };
        // Free mpv_render_context while the host hierarchy still retains the
        // layer. RawRenderContext keeps its callback allocation alive until
        // after callback unregistration and mpv_render_context_free return.
        // Release the render mutex before Drop acquires the CGL context lock:
        // draw acquires CGL first and then the render mutex.
        let render = {
            let mut slot = layer.ivars().render.lock().unwrap();
            slot.take()
        };
        drop(render);
    }
    if host_ptr != 0 {
        let host: &HostView = unsafe { &*(host_ptr as *const HostView) };
        // Safe during fullscreen: this changes only the content-view hierarchy
        // and does not issue an NSWindow property mutation.
        host.removeFromSuperview();
    }
    surface.host_ptr.store(0, Ordering::Release);
    surface.layer_ptr.store(0, Ordering::Release);
    if !window_cleanup_deferred {
        restore_webview_opacity_on_main(surface, reason);
    }
}

/// The macOS surface handle. Native pointers and cleanup ownership live in the
/// shared state so explicit detach and NSWindowWillClose use one idempotent path.
pub struct MacosSurface {
    state: Arc<SurfaceState>,
}

impl VideoSurface for MacosSurface {
    fn set_rect(&self, _x: i32, _y: i32, _w: i32, _h: i32) {
        // No-op: the host view autoresizes with the content view (see attach), so
        // the video always fills the window without explicit DOM-driven geometry.
    }

    fn video_file_started(&self) {
        self.state.dwidth.store(0, Ordering::Release);
        self.state.dheight.store(0, Ordering::Release);
        self.state.wrap_active.store(false, Ordering::Release);
        self.state
            .wrap_restore_pending
            .store(false, Ordering::Release);
        self.state.wrap_has_applied.store(false, Ordering::Release);
        if let Ok(mut saved) = self.state.pre_wrap_frame.lock() {
            *saved = None;
        }
        self.state.wrap_needs_resize.store(true, Ordering::Release);
        self.state
            .wrap_postcondition_attempts
            .store(0, Ordering::Release);
        queue_window_wrap_reconcile(self.state.clone());
    }

    fn video_dimensions_changed(&self, width: i64, height: i64) {
        if validated_video_aspect(width, height).is_none() {
            rp_log(&format!(
                "RPGEO event=window-wrap engine=native-mpv action=reject-invalid-video-dimensions dwidth={width} dheight={height} retry=next-property-change"
            ));
            return;
        }
        let old_width = self.state.dwidth.load(Ordering::Acquire);
        let old_height = self.state.dheight.load(Ordering::Acquire);
        let aspect_changed = old_width <= 0
            || old_height <= 0
            || (old_width as i128 * height as i128) != (width as i128 * old_height as i128);
        self.state.dwidth.store(width, Ordering::Release);
        self.state.dheight.store(height, Ordering::Release);
        self.state.wrap_active.store(true, Ordering::Release);
        if aspect_changed || !self.state.wrap_constraint_applied.load(Ordering::Acquire) {
            self.state.wrap_needs_resize.store(true, Ordering::Release);
            self.state
                .wrap_postcondition_attempts
                .store(0, Ordering::Release);
        }
        queue_window_wrap_reconcile(self.state.clone());
    }

    fn video_playback_ended(&self) {
        self.state.wrap_active.store(false, Ordering::Release);
        self.state
            .wrap_restore_pending
            .store(true, Ordering::Release);
        // A later keep-open replay is a subsequent wrap in this player session,
        // so it uses the width-preserving policy after this frame restoration.
        self.state.wrap_needs_resize.store(true, Ordering::Release);
        queue_window_wrap_reconcile(self.state.clone());
    }

    fn detach(&self) {
        let state = self.state.clone();
        let teardown = move || teardown_surface_on_main(&state, "detach", true);
        // detach normally runs off the main thread (async commands / Player drop);
        // exec_sync onto the main queue preserves the ordering there. If a future
        // caller is already ON the main thread, run inline instead - dispatch_sync
        // onto the queue we are running on would self-deadlock.
        if MainThreadMarker::new().is_some() {
            teardown();
        } else {
            DispatchQueue::main().exec_sync(teardown);
        }
    }
}

/// Build the macOS video surface on the main thread and bind it to mpv. Tauri's
/// `with_webview` callback supplies the exact NSWindow and WKWebView for this app
/// window, so setup never guesses from NSApplication.keyWindow/mainWindow.
/// The render-API surface needs nothing set up before mpv is initialized.
pub fn surface_pre_init<R: Runtime>(_app: &AppHandle<R>) -> Result<PreInit, String> {
    Ok(PreInit {
        options: Vec::new(),
        handle: 0,
    })
}

pub fn surface_attach<R: Runtime>(
    app: &AppHandle<R>,
    mpv: Arc<Mpv>,
    _handle: usize,
) -> Result<Arc<dyn VideoSurface>, String> {
    let webview_window = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next())
        .ok_or("no app webview window for the video surface")?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<(usize, usize, Arc<SurfaceState>), String>>();
    webview_window
        .with_webview(move |webview| {
            let window_ptr = webview.ns_window() as usize;
            let webview_ptr = webview.inner() as usize;
            let setup = setup_on_main(mpv, window_ptr, webview_ptr);
            if let Err(send_error) = tx.send(setup) {
                // A timeout can drop the receiver while this main-thread callback
                // is still queued. If setup already attached the view and made the
                // webview transparent, immediately route it through normal teardown.
                if let Ok((_host_ptr, _layer_ptr, state)) = send_error.0 {
                    teardown_surface_on_main(&state, "attach-result-abandoned", true);
                }
            }
        })
        .map_err(|e| format!("could not access the native webview: {e}"))?;
    let (_host_view_ptr, layer_ptr, state) =
        rx.recv_timeout(std::time::Duration::from_secs(8))
            .map_err(|_| "timed out setting up the video surface".to_string())??;

    // Wait for the CA layer's first draw to create the mpv RenderContext BEFORE we
    // return - so mpv's vo=libmpv finds it the moment a file is loaded. Without
    // this, `create_player` returns and the caller loads a file before the async
    // first draw runs → mpv opens vo=libmpv with "No render context set" → the
    // video output fails permanently (black). We run off the main thread, so the
    // main run loop keeps drawing the layer while we poll.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        let ready = {
            let layer: &VideoLayer = unsafe { &*(layer_ptr as *const VideoLayer) };
            layer
                .ivars()
                .render
                .lock()
                .map(|g| g.is_some())
                .unwrap_or(false)
        };
        if ready {
            rp_log("attach_surface: render context ready");
            break;
        }
        if std::time::Instant::now() >= deadline {
            rp_log("attach_surface: WARN render context not ready after 3s");
            break;
        }
        // Nudge a redraw (harmless if one is already pending) and yield.
        DispatchQueue::main().exec_async({
            let p = layer_ptr;
            move || {
                let l: &VideoLayer = unsafe { &*(p as *const VideoLayer) };
                l.setNeedsDisplay();
            }
        });
        std::thread::sleep(std::time::Duration::from_millis(15));
    }

    Ok(Arc::new(MacosSurface { state }))
}

// ---- Main-thread surface setup ------------------------------------------
fn top_level_content_sibling(content_ptr: usize, webview_ptr: usize) -> usize {
    let mut current_ptr = webview_ptr;
    // WKWebView may be wrapped by one or more Wry/Tao views. Walk upward until
    // the current view is a direct child of NSWindow.contentView.
    for _ in 0..16 {
        if current_ptr == 0 || current_ptr == content_ptr {
            return 0;
        }
        let current: &NSView = unsafe { &*(current_ptr as *const NSView) };
        let parent_ptr = unsafe { current.superview() }
            .map(|view| Retained::as_ptr(&view) as usize)
            .unwrap_or(0);
        if parent_ptr == content_ptr {
            return current_ptr;
        }
        current_ptr = parent_ptr;
    }
    0
}

/// Returns (host_view_ptr, layer_ptr, shared surface state).
fn setup_on_main(
    mpv: Arc<Mpv>,
    window_ptr: usize,
    webview_ptr: usize,
) -> Result<(usize, usize, Arc<SurfaceState>), String> {
    rp_log("setup_on_main: start");
    let mtm = MainThreadMarker::new().ok_or("setup must run on the main thread")?;
    if window_ptr == 0 || webview_ptr == 0 {
        return Err("Tauri returned a null native window or webview".to_string());
    }
    let ns_window: &NSWindow = unsafe { &*(window_ptr as *const NSWindow) };
    let webview: &NSView = unsafe { &*(webview_ptr as *const NSView) };
    let content = ns_window.contentView().ok_or("no content view")?;
    let content_ptr = Retained::as_ptr(&content) as usize;
    let webview_sibling_ptr = top_level_content_sibling(content_ptr, webview_ptr);
    let backing_scale = ns_window.backingScaleFactor();
    let bounds = content.bounds();
    let state = SurfaceState::new(window_ptr, content_ptr, webview_ptr, webview_sibling_ptr);
    // A newly attached live surface supersedes any cleanup left by an older
    // surface on the same window. Cancel only after all fallible discovery is
    // complete, then carry its transition and opacity ownership into this state.
    // The new surface observes and reconciles the eventual DidExit itself.
    let inherited_fullscreen_state =
        cancel_post_fullscreen_cleanup_on_main(window_ptr, "surface-reattach");
    if let Some((session_active, enter_in_flight, exit_in_flight, webview_transparent)) =
        inherited_fullscreen_state
    {
        state
            .fullscreen_session_active
            .store(session_active, Ordering::Release);
        state
            .fullscreen_enter_in_flight
            .store(enter_in_flight, Ordering::Release);
        state
            .fullscreen_exit_in_flight
            .store(exit_in_flight, Ordering::Release);
        // The old deferred cleanup is being replaced by a new live surface. Carry
        // opacity ownership with the fullscreen latches so setup does not issue a
        // redundant transparent flip and the new teardown performs the one restore.
        state
            .webview_transparent
            .store(webview_transparent, Ordering::Release);
        if enter_in_flight {
            schedule_fullscreen_enter_revalidation(state.clone());
        }
    }
    if ns_window
        .styleMask()
        .contains(NSWindowStyleMask::FullScreen)
    {
        state
            .fullscreen_session_active
            .store(true, Ordering::Release);
    }
    rp_log(&format!(
        "setup_on_main: exact Tauri window=0x{window_ptr:x} webview=0x{webview_ptr:x} content=0x{content_ptr:x} sibling=0x{webview_sibling_ptr:x} content {}x{} scale {}",
        bounds.size.width as i32,
        bounds.size.height as i32,
        backing_scale
    ));

    // Host view (layer-hosting) filling the content view in POINTS. Using the
    // content bounds verbatim preserves a non-zero bounds origin if AppKit/Wry
    // ever supplies one; contentsScale is applied only to the GL target below.
    let frame = bounds;
    let layer = VideoLayer::new(mpv, state.clone());
    sync_layer_render_scale(&layer, &state, bounds.size, backing_scale);
    // mpv renders into the full layer FBO. keepaspect bars are inside that FBO,
    // and the macOS profile explicitly paints them opaque black. Decoded frames
    // also fill their video rectangle, so the complete layer is opaque.
    layer.setOpaque(true);
    // Draw only when there's a new frame (mpv's update callback pokes
    // setNeedsDisplay) or the bounds change - not 60fps continuously. This also
    // makes CA reallocate the GL drawable to the new size on resize, so the
    // video always refreshes at its current capped resolution instead of keeping
    // a stretched stale texture.
    layer.setAsynchronous(false);
    layer.setNeedsDisplayOnBoundsChange(true);
    layer.setAutoresizingMask(
        CAAutoresizingMask::LayerWidthSizable | CAAutoresizingMask::LayerHeightSizable,
    );

    // Layer-BACKED host that re-renders the video layer on every resize step.
    let host = HostView::new(mtm, frame, layer.clone(), state.clone());
    state
        .host_ptr
        .store(Retained::as_ptr(&host) as usize, Ordering::Release);
    host.setWantsLayer(true);
    layer.setFrame(host.bounds());
    layer.setBounds(NSRect::new(NSPoint::new(0.0, 0.0), host.bounds().size));

    // Configure autoresizing before insertion, then set the frame again after
    // insertion. This avoids an attach-time snapshot becoming permanent if Wry
    // lays out the content hierarchy in the same run-loop turn.
    content.setAutoresizesSubviews(true);
    host.setAutoresizingMask(
        objc2_app_kit::NSAutoresizingMaskOptions::ViewWidthSizable
            | objc2_app_kit::NSAutoresizingMaskOptions::ViewHeightSizable,
    );

    // Add the video layer as a sublayer of the host's backing layer.
    let backing: *mut AnyObject = unsafe { msg_send![&*host, layer] };
    if !backing.is_null() {
        let sublayer: &CALayer = &layer;
        unsafe {
            let _: () = msg_send![backing, addSublayer: sublayer];
        }
    }

    // Insert immediately BELOW the WKWebView's top-level content sibling. Passing
    // None here made the ordering dependent on every other framework-owned view.
    let sibling = if webview_sibling_ptr != 0 {
        Some(unsafe { &*(webview_sibling_ptr as *const NSView) })
    } else {
        None
    };
    // This is the exact player-init visibility boundary: make the WKWebView
    // transparent immediately before attaching the native video view, and before
    // the synchronous first draw below can produce a visible frame.
    make_webview_transparent_on_main(&state);
    content.addSubview_positioned_relativeTo(&host, NSWindowOrderingMode::Below, sibling);
    host.setFrame(content.bounds());
    register_window_observers(&host, ns_window);
    log_geometry_on_main(
        "attach",
        &state,
        &format!(
            "insertion=below-webview-sibling webview.direct_parent=0x{:x}",
            unsafe { webview.superview() }
                .map(|view| Retained::as_ptr(&view) as usize)
                .unwrap_or(0)
        ),
    );

    // Force a SYNCHRONOUS first draw NOW (async=false → display() draws on this
    // thread), which creates the mpv RenderContext before we return. Otherwise
    // `create_player` returns + the caller loads a file before the async first
    // draw runs, and mpv opens vo=libmpv with "No render context set" → the video
    // output fails permanently (vo-configured=no, black). Eager creation makes the
    // player robust to a load-immediately-after-init sequence.
    display_layer_forced(&layer);
    rp_log(&format!(
        "setup_on_main: layer host inserted below webview; render_ready={}",
        layer
            .ivars()
            .render
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false)
    ));
    Ok((
        Retained::as_ptr(&host) as usize,
        Retained::as_ptr(&layer) as usize,
        state,
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        capped_render_target_dimensions, claim_webview_opacity_restore, claim_webview_transparency,
        first_wrap_size, fullscreen_blocks_window_mutation, layer_context_action,
        render_context_matches_creation, render_update_has_frame, resume_wrap_decision,
        should_queue_callback_redraw, should_requeue_after_draw, wrap_postcondition_decision,
        CallbackLifecycle, LayerContextAction, RenderCallbackState, ResumeWrapDecision,
        SurfaceState, WrapPostconditionDecision,
    };
    use objc2_foundation::NSSize;
    use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};

    #[test]
    fn render_target_pixel_budget_preserves_window_aspect() {
        assert_eq!(
            capped_render_target_dimensions(5120.0, 2880.0, 1920, 1080),
            (2880, 1620)
        );
        assert_eq!(
            capped_render_target_dimensions(5120.0, 2160.0, 1920, 1080),
            (2880, 1215)
        );
        assert_eq!(
            capped_render_target_dimensions(1440.0, 900.0, 1920, 1080),
            (1440, 900)
        );
    }

    #[test]
    fn render_target_pixel_budget_rejects_degenerate_domains() {
        assert_eq!(
            capped_render_target_dimensions(5120.0, 2880.0, 0, 1080),
            (5120, 2880)
        );
        assert_eq!(
            capped_render_target_dimensions(f64::NAN, 0.0, 1920, 1080),
            (1, 1)
        );
    }

    #[test]
    fn render_update_flags_and_update_redraws_are_coalesced() {
        assert!(!render_update_has_frame(0));
        let frame = u64::from(libmpv2_sys::mpv_render_update_flag_MPV_RENDER_UPDATE_FRAME);
        assert!(render_update_has_frame(frame));
        assert!(render_update_has_frame(frame | 0x80));

        assert!(should_queue_callback_redraw(
            CallbackLifecycle::Live,
            true,
            false,
            false
        ));
        assert!(!should_queue_callback_redraw(
            CallbackLifecycle::Live,
            true,
            false,
            true
        ));
        assert!(!should_queue_callback_redraw(
            CallbackLifecycle::Live,
            false,
            false,
            false
        ));
        assert!(!should_queue_callback_redraw(
            CallbackLifecycle::Quiescing,
            true,
            false,
            false
        ));
    }

    #[test]
    fn forced_redraws_queue_without_updates_and_coalesce() {
        assert!(should_queue_callback_redraw(
            CallbackLifecycle::Live,
            false,
            true,
            false
        ));
        assert!(should_queue_callback_redraw(
            CallbackLifecycle::Live,
            true,
            true,
            false
        ));
        assert!(!should_queue_callback_redraw(
            CallbackLifecycle::Live,
            false,
            true,
            true
        ));
        assert!(!should_queue_callback_redraw(
            CallbackLifecycle::Freed,
            true,
            true,
            false
        ));
    }

    #[test]
    fn delivered_but_dropped_invalidation_does_not_block_forced_redraw() {
        assert!(!should_queue_callback_redraw(
            CallbackLifecycle::Live,
            false,
            true,
            true
        ));
        // Main-queue delivery releases the dispatch latch. No CA draw is required
        // before a fullscreen completion can request another forced redraw.
        assert!(should_queue_callback_redraw(
            CallbackLifecycle::Live,
            false,
            true,
            false
        ));
    }

    #[test]
    fn update_arriving_during_draw_requeues_after_consumed_flags() {
        assert!(should_requeue_after_draw(
            CallbackLifecycle::Live,
            true,
            false
        ));
        assert!(should_requeue_after_draw(
            CallbackLifecycle::Live,
            false,
            true
        ));
        assert!(!should_requeue_after_draw(
            CallbackLifecycle::Live,
            false,
            false
        ));
        assert!(!should_requeue_after_draw(
            CallbackLifecycle::Quiescing,
            true,
            true
        ));
    }

    #[test]
    fn render_context_identity_must_match_before_mpv_calls() {
        assert!(render_context_matches_creation(0x1000, 0x1000));
        assert!(!render_context_matches_creation(0x1000, 0x2000));
    }

    #[test]
    fn layer_context_ownership_creates_once_then_retains_for_ca() {
        assert_eq!(layer_context_action(None), LayerContextAction::Create);
        assert_eq!(
            layer_context_action(Some(0x1000)),
            LayerContextAction::RetainExisting
        );
    }

    #[test]
    fn callback_teardown_quiesces_before_the_context_is_marked_freed() {
        let callback = RenderCallbackState {
            layer_ptr: AtomicUsize::new(1),
            lifecycle: AtomicU8::new(CallbackLifecycle::Live as u8),
            update_pending: AtomicBool::new(true),
            main_dispatch_queued: AtomicBool::new(false),
            context_mismatch_logged: AtomicBool::new(false),
            force_render: AtomicBool::new(true),
        };

        assert!(callback.is_live());
        callback.begin_teardown();
        assert_eq!(callback.lifecycle(), CallbackLifecycle::Quiescing);
        assert_eq!(callback.layer_ptr.load(Ordering::Acquire), 0);
        assert!(!callback.update_pending.load(Ordering::Acquire));
        assert!(!callback.force_render.load(Ordering::Acquire));
        assert!(!should_queue_callback_redraw(
            callback.lifecycle(),
            true,
            true,
            false
        ));
        callback.mark_freed();
        assert_eq!(callback.lifecycle(), CallbackLifecycle::Freed);
    }

    #[test]
    fn wrap_postcondition_completes_only_after_observed_target() {
        let target = NSSize::new(1280.0, 720.0);
        assert_eq!(
            wrap_postcondition_decision(NSSize::new(1280.1, 719.9), target, 0),
            WrapPostconditionDecision::Complete
        );
        assert_eq!(
            wrap_postcondition_decision(NSSize::new(1280.0, 860.0), target, 0),
            WrapPostconditionDecision::Retry
        );
        assert_eq!(
            wrap_postcondition_decision(NSSize::new(1280.0, 860.0), target, 3),
            WrapPostconditionDecision::Pending
        );
        assert_eq!(
            wrap_postcondition_decision(NSSize::new(1280.0, 860.0), target, 2),
            WrapPostconditionDecision::Retry
        );
        assert_eq!(
            wrap_postcondition_decision(NSSize::new(1280.0, 720.0), target, 2),
            WrapPostconditionDecision::Complete
        );
    }

    #[test]
    fn first_wrap_actively_matches_wide_and_tall_video_aspects() {
        let minimum = NSSize::new(320.0, 240.0);
        let maximum = NSSize::new(1600.0, 1000.0);

        let (wide, wide_letterbox) =
            first_wrap_size(NSSize::new(1000.0, 800.0), 16.0 / 9.0, minimum, maximum);
        assert!((wide.width - 1000.0).abs() < 0.01);
        assert!((wide.height - 562.5).abs() < 0.01);
        assert!(wide.width >= minimum.width && wide.height >= minimum.height);
        assert!(!wide_letterbox);

        let (tall, tall_letterbox) =
            first_wrap_size(NSSize::new(1000.0, 800.0), 9.0 / 16.0, minimum, maximum);
        assert!((tall.width - 450.0).abs() < 0.01);
        assert!((tall.height - 800.0).abs() < 0.01);
        assert!(tall.width >= minimum.width && tall.height >= minimum.height);
        assert!(!tall_letterbox);
    }

    #[test]
    fn fullscreen_defers_wrap_until_did_exit_then_requests_resize() {
        assert!(fullscreen_blocks_window_mutation(false, true, false, true));
        assert_eq!(
            resume_wrap_decision(false, true, true, true),
            ResumeWrapDecision::Skip
        );
        assert!(!fullscreen_blocks_window_mutation(
            false, false, false, false
        ));
        assert_eq!(
            resume_wrap_decision(false, true, false, true),
            ResumeWrapDecision::ResizeAndReconcile
        );
        assert_eq!(
            resume_wrap_decision(false, true, false, false),
            ResumeWrapDecision::Reconcile
        );
    }

    #[test]
    fn webview_opacity_lifecycle_claims_each_flip_once() {
        let state = SurfaceState::new(0, 0, 0, 0);

        assert!(claim_webview_transparency(&state));
        assert!(!claim_webview_transparency(&state));
        assert!(claim_webview_opacity_restore(&state));
        assert!(!claim_webview_opacity_restore(&state));
    }
}
