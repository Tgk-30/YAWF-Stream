// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use crate::{Error, InitializationScript, RGBA};
use crossbeam_channel::*;
use jni::{
  errors::Result as JniResult,
  objects::{GlobalRef, JMap, JObject, JString},
  JNIEnv, JavaVM,
};
use once_cell::sync::Lazy;
use std::{
  collections::BTreeMap,
  ffi::c_void,
  os::unix::prelude::*,
  sync::{Arc, Mutex},
};

use super::{find_class, EvalCallback, WebviewId, EVAL_CALLBACKS, EVAL_ID_GENERATOR};

pub type ActivityId = i32;

static CHANNEL: Lazy<(
  Sender<(ActivityId, WebViewMessage)>,
  Receiver<(ActivityId, WebViewMessage)>,
)> = Lazy::new(|| bounded(8));
pub static MAIN_PIPE: Lazy<[OwnedFd; 2]> = Lazy::new(|| {
  let mut pipe: [RawFd; 2] = Default::default();
  unsafe { libc::pipe(pipe.as_mut_ptr()) };
  #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
  unsafe {
    let flags = libc::fcntl(pipe[1], libc::F_GETFL);
    libc::fcntl(pipe[1], libc::F_SETFL, flags | libc::O_NONBLOCK);
  }
  unsafe { pipe.map(|fd| OwnedFd::from_raw_fd(fd)) }
});

#[derive(Clone)]
pub struct ActivityProxy {
  pub activity: GlobalRef,
  pub window_manager: GlobalRef,
  pub webview: Option<GlobalRef>,
  #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
  pub webview_id: Option<WebviewId>,
  #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
  pub webview_activity: Option<GlobalRef>,
  #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
  pub webview_generation: Option<u64>,
  pub java_vm: *mut c_void,
}

unsafe impl Send for ActivityProxy {}

impl ActivityProxy {
  pub fn new(vm: JavaVM, activity: GlobalRef, window_manager: GlobalRef) -> Self {
    Self {
      activity,
      window_manager,
      webview: None,
      #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
      webview_id: None,
      #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
      webview_activity: None,
      #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
      webview_generation: None,
      java_vm: vm.get_java_vm_pointer() as *mut _,
    }
  }
}

static ACTIVITY_PROXY: once_cell::sync::Lazy<Mutex<BTreeMap<ActivityId, ActivityProxy>>> =
  Lazy::new(|| Mutex::new(BTreeMap::new()));

pub fn activity_proxy(id: ActivityId) -> Option<ActivityProxy> {
  ACTIVITY_PROXY.lock().unwrap().get(&id).cloned()
}

fn remove_activity_proxy(id: ActivityId) {
  ACTIVITY_PROXY.lock().unwrap().remove(&id);
}

pub fn register_activity_proxy(
  vm: JavaVM,
  id: ActivityId,
  activity: GlobalRef,
  window_manager: GlobalRef,
) {
  let mut activity_proxy = ACTIVITY_PROXY.lock().unwrap();
  if let Some(proxy) = activity_proxy.get_mut(&id) {
    proxy.activity = activity;
    proxy.window_manager = window_manager;
    proxy.java_vm = vm.get_java_vm_pointer() as *mut _;
  } else {
    let proxy = ActivityProxy::new(vm, activity, window_manager);
    activity_proxy.insert(id, proxy);
  }
}

pub fn activity_id_for_window_manager(window_manager: JObject) -> Option<ActivityId> {
  for (activity_id, proxy) in ACTIVITY_PROXY.lock().unwrap().iter() {
    let vm = unsafe { JavaVM::from_raw(proxy.java_vm.cast()) }.unwrap();
    let mut env = vm.attach_current_thread_as_daemon().unwrap();
    let equals = env
      .call_method(
        proxy.window_manager.as_obj(),
        "equals",
        "(Ljava/lang/Object;)Z",
        &[(&window_manager).into()],
      )
      .and_then(|v| v.z())
      .unwrap_or_default();
    if equals {
      return Some(*activity_id);
    }
  }
  None
}

pub fn first_activity_id() -> Option<ActivityId> {
  ACTIVITY_PROXY.lock().unwrap().keys().next().cloned()
}

pub fn get_webview(activity_id: ActivityId) -> Option<GlobalRef> {
  ACTIVITY_PROXY
    .lock()
    .unwrap()
    .get(&activity_id)
    .unwrap()
    .webview
    .as_ref()
    .cloned()
}

#[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
#[derive(Clone)]
struct OwnedWebView {
  generation: u64,
  activity: GlobalRef,
  object: GlobalRef,
  assigned: bool,
}

#[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
static PENDING_OWNED: Lazy<Mutex<BTreeMap<(ActivityId, WebviewId), Vec<OwnedWebView>>>> =
  Lazy::new(|| Mutex::new(BTreeMap::new()));

pub struct MainPipe<'a> {
  pub env: JNIEnv<'a>,
}

impl<'a> MainPipe<'a> {
  #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
  pub(crate) fn try_send_owned(activity_id: ActivityId, message: WebViewMessage) -> bool {
    let flags = unsafe { libc::fcntl(MAIN_PIPE[1].as_raw_fd(), libc::F_GETFL) };
    if flags < 0 || flags & libc::O_NONBLOCK == 0 {
      return false;
    }
    if CHANNEL.0.try_send((activity_id, message)).is_err() {
      return false;
    }
    // Nonblocking writer: EAGAIN means an existing readable wakeup already
    // guarantees a drain. A failed wakeup never fabricates an acknowledgement.
    let byte = [0u8];
    let written = unsafe { libc::write(MAIN_PIPE[1].as_raw_fd(), byte.as_ptr().cast(), 1) };
    written == 1
      || (written < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EAGAIN))
  }

  pub(crate) fn send(activity_id: ActivityId, message: WebViewMessage) {
    const BYTE: [u8; 1] = [0];
    if CHANNEL.0.send((activity_id, message)).is_ok() {
      unsafe {
        libc::write(
          MAIN_PIPE[1].as_raw_fd(),
          BYTE.as_ptr() as *const _,
          BYTE.len(),
        )
      };
    }
  }

  pub fn recv(&mut self) -> JniResult<()> {
    let package = super::PACKAGE.get().unwrap();
    while let Ok((activity_id, message)) = CHANNEL.1.try_recv() {
      #[cfg(all(
        target_os = "android",
        feature = "android-app-create-webview-completion"
      ))]
      {
        let creating = matches!(&message, WebViewMessage::CreateWebView(_));
        if let Err(error) = self.handle_message(package, activity_id, message) {
          if !creating {
            return Err(error);
          }
          // Only this opted-in app acknowledges creation from a later FIFO JNI
          // message. A failed create must not unregister the pipe before it.
          if self.env.exception_check()? {
            self.env.exception_clear()?;
          }
        }
      }
      #[cfg(not(all(
        target_os = "android",
        feature = "android-app-create-webview-completion"
      )))]
      self.handle_message(package, activity_id, message)?;
    }
    Ok(())
  }

  #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
  fn on_owned_activity_destroy(
    &mut self,
    activity_id: ActivityId,
    webview_id: &WebviewId,
    is_changing_configurations: bool,
    owner: &GlobalRef,
  ) -> JniResult<()> {
    let Some(proxy) = activity_proxy(activity_id) else {
      return Ok(());
    };
    let current_owner = self
      .env
      .is_same_object(proxy.activity.as_obj(), owner.as_obj())?;
    let generation = super::WEBVIEW_ATTRIBUTES
      .lock()
      .unwrap()
      .get(&activity_id)
      .filter(|attrs| attrs.id == *webview_id)
      .map(|attrs| attrs.owned_generation);
    if let Some(generation) = generation {
      // Retire only physically acknowledged destroyed-Activity objects. A late
      // old-owner callback can release old refs, never newer same-id metadata.
      if !current_owner {
        let Some(objects) = self.owned_candidates(activity_id, webview_id) else {
          return Ok(());
        };
        let mut known_owner = false;
        for object in objects {
          if self
            .env
            .is_same_object(object.activity.as_obj(), owner.as_obj())?
          {
            known_owner = true;
            break;
          }
        }
        if !known_owner {
          return Ok(());
        }
      }
      self.retire_destroyed_owned(activity_id, webview_id, Some(owner))?;
      if !current_owner || is_changing_configurations {
        return Ok(());
      }
      if !self
        .owned_candidates(activity_id, webview_id)
        .is_some_and(|objects| objects.is_empty())
      {
        return Ok(());
      }
      let mut proxies = ACTIVITY_PROXY.lock().unwrap();
      let Some(current) = proxies.get(&activity_id) else {
        return Ok(());
      };
      if !self
        .env
        .is_same_object(current.activity.as_obj(), owner.as_obj())?
      {
        return Ok(());
      }
      if super::destroy_owned_handlers(activity_id, webview_id, generation) {
        proxies.remove(&activity_id);
      }
    } else if current_owner && !is_changing_configurations && webview_id.is_empty() {
      // Early Back before any WebView has no logical attributes/object to
      // clean. Remove only this exact empty owner, never a later owner.
      let pending = PENDING_OWNED.lock().unwrap();
      if pending.keys().any(|(id, _)| *id == activity_id) {
        return Ok(());
      }
      let attributes = super::WEBVIEW_ATTRIBUTES.lock().unwrap();
      if attributes.contains_key(&activity_id) {
        return Ok(());
      }
      let mut proxies = ACTIVITY_PROXY.lock().unwrap();
      if let Some(current) = proxies.get(&activity_id) {
        if self
          .env
          .is_same_object(current.activity.as_obj(), owner.as_obj())?
          && current.webview.is_none()
          && current.webview_id.is_none()
          && current.webview_activity.is_none()
          && current.webview_generation.is_none()
        {
          proxies.remove(&activity_id);
        }
      }
    }
    Ok(())
  }

  #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
  fn owned_candidates(
    &self,
    activity_id: ActivityId,
    webview_id: &WebviewId,
  ) -> Option<Vec<OwnedWebView>> {
    let proxy = activity_proxy(activity_id)?;
    let generation = {
      let attributes = super::WEBVIEW_ATTRIBUTES.lock().unwrap();
      let attrs = attributes.get(&activity_id)?;
      if attrs.id != *webview_id {
        return None;
      }
      attrs.owned_generation
    };
    let pending = PENDING_OWNED.lock().unwrap();
    if pending
      .keys()
      .any(|(owner, id)| *owner == activity_id && id != webview_id)
    {
      return None;
    }
    let mut objects = pending
      .get(&(activity_id, webview_id.clone()))
      .cloned()
      .unwrap_or_default();
    match (
      proxy.webview_id,
      proxy.webview,
      proxy.webview_activity,
      proxy.webview_generation,
    ) {
      (Some(id), Some(object), Some(activity), Some(stored_generation))
        if id == *webview_id && stored_generation == generation =>
      {
        objects.push(OwnedWebView {
          generation,
          activity,
          object,
          assigned: true,
        });
      }
      (None, None, None, None) => (),
      _ => return None,
    }
    if objects.iter().any(|object| object.generation != generation) {
      return None;
    }
    Some(objects)
  }

  #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
  fn retire_destroyed_owned(
    &mut self,
    activity_id: ActivityId,
    webview_id: &WebviewId,
    only_owner: Option<&GlobalRef>,
  ) -> JniResult<()> {
    let objects = self
      .owned_candidates(activity_id, webview_id)
      .ok_or(jni::errors::Error::NullPtr("owned recreation conflict"))?;
    for owned in objects {
      if let Some(owner) = only_owner {
        if !self
          .env
          .is_same_object(owned.activity.as_obj(), owner.as_obj())?
        {
          continue;
        }
      }
      // Only a genuinely destroyed prior Activity can be physically retired
      // during healthy recreation. A live owner is never destroyed by Create.
      if !self
        .env
        .call_method(owned.activity.as_obj(), "isDestroyed", "()Z", &[])?
        .z()?
      {
        continue;
      }
      if !self
        .env
        .call_method(
          owned.activity.as_obj(),
          "destroyOwnedWebView",
          "(Landroid/webkit/WebView;Z)Z",
          &[owned.object.as_obj().into(), owned.assigned.into()],
        )?
        .z()?
      {
        return Err(jni::errors::Error::NullPtr(
          "owned recreation cleanup unconfirmed",
        ));
      }
      let mut pending = PENDING_OWNED.lock().unwrap();
      let key = (activity_id, webview_id.clone());
      if let Some(objects) = pending.get_mut(&key) {
        let mut position = None;
        for (index, object) in objects.iter().enumerate() {
          if self
            .env
            .is_same_object(object.object.as_obj(), owned.object.as_obj())?
            && self
              .env
              .is_same_object(object.activity.as_obj(), owned.activity.as_obj())?
          {
            position = Some(index);
            break;
          }
        }
        if let Some(index) = position {
          objects.remove(index);
        }
        if objects.is_empty() {
          pending.remove(&key);
        }
      }
      let mut proxies = ACTIVITY_PROXY.lock().unwrap();
      if let Some(proxy) = proxies.get_mut(&activity_id) {
        if proxy.webview_id.as_ref() == Some(webview_id)
          && proxy
            .webview
            .as_ref()
            .map(|v| self.env.is_same_object(v.as_obj(), owned.object.as_obj()))
            .transpose()?
            .unwrap_or(false)
          && proxy
            .webview_activity
            .as_ref()
            .map(|v| self.env.is_same_object(v.as_obj(), owned.activity.as_obj()))
            .transpose()?
            .unwrap_or(false)
        {
          proxy.webview = None;
          proxy.webview_id = None;
          proxy.webview_activity = None;
          proxy.webview_generation = None;
        }
      }
    }
    Ok(())
  }

  #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
  fn destroy_owned(&mut self, activity_id: ActivityId, webview_id: &WebviewId) -> JniResult<bool> {
    let generation = {
      let attributes = super::WEBVIEW_ATTRIBUTES.lock().unwrap();
      let Some(attrs) = attributes.get(&activity_id) else {
        return Ok(false);
      };
      if attrs.id != *webview_id {
        return Ok(false);
      }
      attrs.owned_generation
    };
    let Some(objects) = self.owned_candidates(activity_id, webview_id) else {
      return Ok(false);
    };
    if objects.is_empty() {
      return Ok(false);
    }
    for owned in &objects {
      if !self
        .env
        .call_method(
          owned.activity.as_obj(),
          "destroyOwnedWebView",
          "(Landroid/webkit/WebView;Z)Z",
          &[owned.object.as_obj().into(), owned.assigned.into()],
        )?
        .z()?
      {
        return Ok(false);
      }
    }
    // JNI/app callbacks cannot authorize removal of a foreign or newer owner.
    let Some(current) = self.owned_candidates(activity_id, webview_id) else {
      return Ok(false);
    };
    if current.len() != objects.len() {
      return Ok(false);
    }
    for (current, owned) in current.iter().zip(&objects) {
      if !self
        .env
        .is_same_object(current.object.as_obj(), owned.object.as_obj())?
        || !self
          .env
          .is_same_object(current.activity.as_obj(), owned.activity.as_obj())?
      {
        return Ok(false);
      }
    }
    let mut pending = PENDING_OWNED.lock().unwrap();
    let mut proxies = ACTIVITY_PROXY.lock().unwrap();
    let Some(proxy) = proxies.get_mut(&activity_id) else {
      return Ok(false);
    };
    if !super::destroy_owned_handlers(activity_id, webview_id, generation) {
      return Ok(false);
    }
    pending.remove(&(activity_id, webview_id.clone()));
    if proxy.webview_id.as_ref() == Some(webview_id) {
      proxy.webview_id = None;
      proxy.webview = None;
      proxy.webview_activity = None;
      proxy.webview_generation = None;
    }
    Ok(true)
  }

  fn handle_message(
    &mut self,
    package: &str,
    activity_id: ActivityId,
    message: WebViewMessage,
  ) -> JniResult<()> {
    match message {
      WebViewMessage::CreateWebView(attrs) => {
        let Some(ActivityProxy { activity, .. }) = activity_proxy(activity_id) else {
          #[cfg(debug_assertions)]
          eprintln!("no activity found for activity id: {}", activity_id);
          return Ok(());
        };
        let CreateWebViewAttributes {
          url,
          html,
          #[cfg(any(debug_assertions, feature = "devtools"))]
          devtools,
          transparent,
          background_color,
          headers,
          on_webview_created,
          autoplay,
          user_agent,
          initialization_scripts,
          id,
          javascript_disabled,
          #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
          owned_generation,
          ..
        } = attrs;

        let string_class = self.env.find_class("java/lang/String")?;
        let initialization_scripts_array = self.env.new_object_array(
          initialization_scripts.len() as i32,
          string_class,
          self.env.new_string("")?,
        )?;
        for (i, init_script) in initialization_scripts.into_iter().enumerate() {
          self.env.set_object_array_element(
            &initialization_scripts_array,
            i as i32,
            self.env.new_string(init_script.script)?,
          )?;
        }
        #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
        let owned_id = id.clone();
        #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
        {
          let attributes = super::WEBVIEW_ATTRIBUTES.lock().unwrap();
          if attributes
            .get(&activity_id)
            .map(|attrs| (&attrs.id, attrs.owned_generation))
            != Some((&owned_id, owned_generation))
          {
            // A cloned, already-queued Create cannot resurrect a retired id.
            return Ok(());
          }
        }
        #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
        self.retire_destroyed_owned(activity_id, &owned_id, None)?;
        #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
        {
          let objects = self
            .owned_candidates(activity_id, &owned_id)
            .ok_or(jni::errors::Error::NullPtr("owned creation conflict"))?;
          if objects.len() >= 8 {
            return Err(jni::errors::Error::NullPtr("owned instance bound"));
          }
          for owned in objects {
            if self
              .env
              .is_same_object(owned.activity.as_obj(), activity.as_obj())?
            {
              return Err(jni::errors::Error::NullPtr(
                "owned current Activity already assigned",
              ));
            }
          }
        }
        let id = self.env.new_string(id)?;
        // Create webview
        let rust_webview_class =
          find_class(&mut self.env, &activity, format!("{package}/RustWebView"))?;
        let webview = self.env.new_object(
          &rust_webview_class,
          "(Landroid/content/Context;[Ljava/lang/String;Ljava/lang/String;)V",
          &[
            (&activity).into(),
            (&initialization_scripts_array).into(),
            (&id).into(),
          ],
        )?;
        #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
        {
          // Journal before setWebView/app hooks or any mount. A failed early
          // GlobalRef cannot leave an assigned or mounted object.
          let object = self.env.new_global_ref(&webview)?;
          PENDING_OWNED
            .lock()
            .unwrap()
            .entry((activity_id, owned_id.clone()))
            .or_default()
            .push(OwnedWebView {
              generation: owned_generation,
              activity: activity.clone(),
              object,
              assigned: false,
            });
        }
        // get settings
        let web_settings = self
          .env
          .call_method(
            &webview,
            "getSettings",
            "()Landroid/webkit/WebSettings;",
            &[],
          )?
          .l()?;
        // set media autoplay
        self.env.call_method(
          &web_settings,
          "setMediaPlaybackRequiresUserGesture",
          "(Z)V",
          &[(!autoplay).into()],
        )?;
        // set user-agent
        if let Some(user_agent) = user_agent {
          let user_agent = self.env.new_string(user_agent)?;
          self.env.call_method(
            &web_settings,
            "setUserAgentString",
            "(Ljava/lang/String;)V",
            &[(&user_agent).into()],
          )?;
        }

        // disable javascript
        if javascript_disabled {
          self.env.call_method(
            &web_settings,
            "setJavaScriptEnabled",
            "(Z)V",
            &[false.into()],
          )?;
        }

        #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
        {
          let mut pending = PENDING_OWNED.lock().unwrap();
          let owned = pending
            .get_mut(&(activity_id, owned_id.clone()))
            .and_then(|objects| objects.last_mut())
            .ok_or(jni::errors::Error::NullPtr("owned pending view"))?;
          // The Java setter can throw after assigning mWebView.
          owned.assigned = true;
        }
        let webview_class_name = format!("{package}/RustWebView");
        self.env.call_method(
          &activity,
          "setWebView",
          format!("(L{webview_class_name};)V"),
          &[(&webview).into()],
        )?;
        // Navigation
        if let Some(u) = url {
          if let Ok(url) = self.env.new_string(u) {
            load_url(&mut self.env, &webview, &url, headers, true)?;
          }
        } else if let Some(h) = html {
          if let Ok(html) = self.env.new_string(h) {
            load_html(&mut self.env, &webview, &html)?;
          }
        }
        // Enable devtools
        #[cfg(any(debug_assertions, feature = "devtools"))]
        self.env.call_static_method(
          &rust_webview_class,
          "setWebContentsDebuggingEnabled",
          "(Z)V",
          &[devtools.into()],
        )?;
        if transparent {
          set_background_color(&mut self.env, &webview, (0, 0, 0, 0))?;
        } else if let Some(color) = background_color {
          set_background_color(&mut self.env, &webview, color)?;
        }
        // Create and set webview client
        let client_class_name = format!("{package}/RustWebViewClient");
        let rust_webview_client_class =
          find_class(&mut self.env, &activity, client_class_name.clone())?;
        let webview_client = self.env.new_object(
          &rust_webview_client_class,
          format!("(L{webview_class_name};Landroid/content/Context;)V"),
          &[(&webview).into(), (&activity).into()],
        )?;
        self.env.call_method(
          &webview,
          "setWebViewClient",
          "(Landroid/webkit/WebViewClient;)V",
          &[(&webview_client).into()],
        )?;
        // Create and set webchrome client
        let rust_webchrome_client_class = find_class(
          &mut self.env,
          &activity,
          format!("{package}/RustWebChromeClient"),
        )?;
        let web_chrome_client = self.env.new_object(
          &rust_webchrome_client_class,
          format!("(L{package}/WryActivity;Ljava/lang/String;)V"),
          &[(&activity).into(), (&id).into()],
        )?;
        self.env.call_method(
          &webview,
          "setWebChromeClient",
          "(Landroid/webkit/WebChromeClient;)V",
          &[(&web_chrome_client).into()],
        )?;

        // Add javascript interface (IPC)
        let ipc_class = find_class(&mut self.env, &activity, format!("{package}/Ipc"))?;
        let ipc = self.env.new_object(
          ipc_class,
          format!("(L{webview_class_name};L{client_class_name};)V"),
          &[(&webview).into(), (&webview_client).into()],
        )?;
        let ipc_str = self.env.new_string("ipc")?;
        self.env.call_method(
          &webview,
          "addJavascriptInterface",
          "(Ljava/lang/Object;Ljava/lang/String;)V",
          &[(&ipc).into(), (&ipc_str).into()],
        )?;

        // Set content view
        self.env.call_method(
          &activity,
          "setContentView",
          "(Landroid/view/View;)V",
          &[(&webview).into()],
        )?;

        if let Some(on_webview_created) = on_webview_created {
          if let Err(_e) = on_webview_created(super::Context {
            env: &mut self.env,
            activity: &activity,
            webview: &webview,
          }) {
            #[cfg(feature = "tracing")]
            tracing::warn!("failed to run webview created hook: {_e}");
            #[cfg(all(
              target_os = "android",
              feature = "android-app-create-webview-completion"
            ))]
            {
              // A failed app/plugin hook is not a stored, usable WebView for
              // this opt-in host, even when it returned a non-JNI error.
              if self.env.exception_check()? {
                self.env.exception_clear()?;
              }
              return Ok(());
            }
          }
        }

        #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
        {
          let mut pending = PENDING_OWNED.lock().unwrap();
          let key = (activity_id, owned_id.clone());
          let mut proxies = ACTIVITY_PROXY.lock().unwrap();
          let proxy = proxies
            .get_mut(&activity_id)
            .ok_or(jni::errors::Error::NullPtr("owned activity disappeared"))?;
          let objects = pending
            .get_mut(&key)
            .ok_or(jni::errors::Error::NullPtr("owned journal disappeared"))?;
          let next = objects
            .last()
            .ok_or(jni::errors::Error::NullPtr("owned journal empty"))?;
          if !self.env.is_same_object(next.object.as_obj(), &webview)?
            || !self
              .env
              .is_same_object(next.activity.as_obj(), activity.as_obj())?
            || !self
              .env
              .is_same_object(proxy.activity.as_obj(), activity.as_obj())?
            || (proxy.webview_id.is_some() && proxy.webview_id.as_ref() != Some(&owned_id))
            || proxy.webview.is_some() != proxy.webview_id.is_some()
            || proxy.webview.is_some() != proxy.webview_activity.is_some()
            || proxy.webview.is_some() != proxy.webview_generation.is_some()
            || proxy
              .webview_generation
              .is_some_and(|value| value != owned_generation)
          {
            return Err(jni::errors::Error::NullPtr("owned storage conflict"));
          }
          // All JNI checks precede storage. Preserve any live prior owner for
          // exact cleanup, but retire destroyed owners before future allocation.
          let next = objects.pop().unwrap();
          if let (Some(object), Some(owner)) = (proxy.webview.take(), proxy.webview_activity.take())
          {
            objects.push(OwnedWebView {
              generation: owned_generation,
              activity: owner,
              object,
              assigned: true,
            });
          }
          if objects.is_empty() {
            pending.remove(&key);
          }
          proxy.webview_id = Some(owned_id);
          proxy.webview_activity = Some(next.activity);
          proxy.webview_generation = Some(next.generation);
          proxy.webview = Some(next.object);
        }
        #[cfg(all(
          target_os = "android",
          feature = "android-app-owned-window-destroy",
          feature = "android-app-create-webview-completion"
        ))]
        {
          // Observe exact storage only after both ownership locks have dropped.
          // This optional notification is not the app's cold construction ACK.
          if self
            .env
            .call_method(
              &activity,
              "notifyOwnedWebViewStored",
              "(Landroid/webkit/WebView;)V",
              &[(&webview).into()],
            )
            .is_err()
            && self.env.exception_check()?
          {
            self.env.exception_clear()?;
          }
        }
        #[cfg(not(all(target_os = "android", feature = "android-app-owned-window-destroy")))]
        {
          let webview = self.env.new_global_ref(webview)?;

          ACTIVITY_PROXY
            .lock()
            .unwrap()
            .get_mut(&activity_id)
            .unwrap()
            .webview
            .replace(webview);
        }
      }
      #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
      WebViewMessage::DestroyOwned {
        webview_id,
        callback,
      } => {
        let result = self.destroy_owned(activity_id, &webview_id);
        if result.is_err() && self.env.exception_check()? {
          self.env.exception_clear()?;
        }
        callback(result.unwrap_or(false));
      }
      WebViewMessage::Eval(script, callback) => {
        if let Some(webview) = get_webview(activity_id) {
          let id = EVAL_ID_GENERATOR.next() as i32;

          #[cfg(feature = "tracing")]
          let span = std::sync::Mutex::new(Some(SendEnteredSpan(
            tracing::debug_span!("wry::eval").entered(),
          )));

          EVAL_CALLBACKS
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(
              id,
              Box::new(move |result| {
                #[cfg(feature = "tracing")]
                span.lock().unwrap().take();

                if let Some(callback) = &callback {
                  callback(result);
                }
              }),
            );

          let s = self.env.new_string(script)?;
          self.env.call_method(
            webview.as_obj(),
            "evalScript",
            "(ILjava/lang/String;)V",
            &[id.into(), (&s).into()],
          )?;
        }
      }
      WebViewMessage::SetBackgroundColor(background_color) => {
        if let Some(webview) = get_webview(activity_id) {
          set_background_color(&mut self.env, webview.as_obj(), background_color)?;
        }
      }
      WebViewMessage::GetWebViewVersion(tx) => {
        if let Some(activity) = activity_proxy(activity_id).map(|p| p.activity) {
          match self
            .env
            .call_method(activity, "getVersion", "()Ljava/lang/String;", &[])
            .and_then(|v| v.l())
            .and_then(|s| {
              let s = JString::from(s);
              self
                .env
                .get_string(&s)
                .map(|v| v.to_string_lossy().to_string())
            }) {
            Ok(version) => {
              tx.send(Ok(version)).unwrap();
            }
            Err(e) => tx.send(Err(e.into())).unwrap(),
          }
        } else {
          tx.send(Err(Error::ActivityNotFound)).unwrap();
        }
      }
      WebViewMessage::GetUrl(tx) => {
        if let Some(webview) = get_webview(activity_id) {
          let url = self
            .env
            .call_method(webview.as_obj(), "getUrl", "()Ljava/lang/String;", &[])
            .and_then(|v| v.l())
            .and_then(|s| {
              let s = JString::from(s);
              self
                .env
                .get_string(&s)
                .map(|v| v.to_string_lossy().to_string())
            })
            .unwrap_or_default();

          tx.send(url).unwrap()
        }
      }
      WebViewMessage::Jni(f) => {
        match activity_proxy(activity_id).map(|p| (p.activity.clone(), p.webview)) {
          Some((activity, Some(webview))) => {
            f(&mut self.env, &activity, webview.as_obj());
          }
          Some((activity, None)) => {
            f(&mut self.env, &activity, &JObject::null());
          }
          _ => {
            f(&mut self.env, &JObject::null(), &JObject::null());
          }
        }
      }
      WebViewMessage::LoadUrl(url, headers) => {
        if let Some(webview) = get_webview(activity_id) {
          let url = self.env.new_string(url)?;
          load_url(&mut self.env, webview.as_obj(), &url, headers, false)?;
        }
      }
      WebViewMessage::ClearAllBrowsingData => {
        if let Some(webview) = get_webview(activity_id) {
          self
            .env
            .call_method(webview, "clearAllBrowsingData", "()V", &[])?;
        }
      }
      WebViewMessage::LoadHtml(html) => {
        if let Some(webview) = get_webview(activity_id) {
          let html = self.env.new_string(html)?;
          load_html(&mut self.env, webview.as_obj(), &html)?;
        }
      }
      WebViewMessage::Reload => {
        if let Some(webview) = get_webview(activity_id) {
          reload(&mut self.env, webview.as_obj())?;
        }
      }
      WebViewMessage::GoForward => {
        if let Some(webview) = get_webview(activity_id) {
          go_forward(&mut self.env, webview.as_obj())?;
        }
      }
      WebViewMessage::GoBack => {
        if let Some(webview) = get_webview(activity_id) {
          go_back(&mut self.env, webview.as_obj())?;
        }
      }
      WebViewMessage::CanGoForward(tx) => {
        if let Some(webview) = get_webview(activity_id) {
          tx.send(can_go_forward(&mut self.env, webview.as_obj())?)
            .unwrap();
        }
      }
      WebViewMessage::CanGoBack(tx) => {
        if let Some(webview) = get_webview(activity_id) {
          tx.send(can_go_back(&mut self.env, webview.as_obj())?)
            .unwrap();
        }
      }
      WebViewMessage::GetCookies(tx, url) => {
        if let Some(webview) = get_webview(activity_id) {
          let url = self.env.new_string(url)?;
          let cookies = self
            .env
            .call_method(
              webview,
              "getCookies",
              "(Ljava/lang/String;)Ljava/lang/String;",
              &[(&url).into()],
            )
            .and_then(|v| v.l())
            .and_then(|s| {
              let s = JString::from(s);
              self
                .env
                .get_string(&s)
                .map(|v| v.to_string_lossy().to_string())
            })
            .unwrap_or_default();

          tx.send(
            cookies
              .split("; ")
              .flat_map(|c| cookie::Cookie::parse(c.to_string()))
              .collect(),
          )
          .unwrap();
        }
      }
      WebViewMessage::OnDestroy {
        activity_id,
        webview_id,
        is_changing_configurations,
        #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
        owned_activity,
      } => {
        #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
        {
          let result = self.on_owned_activity_destroy(
            activity_id,
            &webview_id,
            is_changing_configurations,
            &owned_activity,
          );
          if result.is_err() && self.env.exception_check()? {
            self.env.exception_clear()?;
          }
        }
        #[cfg(not(all(target_os = "android", feature = "android-app-owned-window-destroy")))]
        {
          // Default Wry lifecycle behavior is unchanged.
          if !is_changing_configurations {
            super::destroy_webview(activity_id, &webview_id);
            remove_activity_proxy(activity_id);
          }
        }
      }
    }
    Ok(())
  }
}

fn load_url<'a>(
  env: &mut JNIEnv<'a>,
  webview: &JObject<'a>,
  url: &JString<'a>,
  headers: Option<http::HeaderMap>,
  main_thread: bool,
) -> JniResult<()> {
  let function = if main_thread {
    "loadUrlMainThread"
  } else {
    "loadUrl"
  };
  if let Some(headers) = headers {
    let obj = env.new_object("java/util/HashMap", "()V", &[])?;
    let headers_map = {
      let headers_map = JMap::from_env(env, &obj)?;
      for (name, value) in headers.iter() {
        let key = env.new_string(name)?;
        let value = env.new_string(value.to_str().unwrap_or_default())?;
        headers_map.put(env, &key, &value)?;
      }
      headers_map
    };
    env.call_method(
      webview,
      function,
      "(Ljava/lang/String;Ljava/util/Map;)V",
      &[url.into(), (&headers_map).into()],
    )?;
  } else {
    env.call_method(webview, function, "(Ljava/lang/String;)V", &[url.into()])?;
  }
  Ok(())
}

fn load_html<'a>(env: &mut JNIEnv<'a>, webview: &JObject<'a>, html: &JString<'a>) -> JniResult<()> {
  env.call_method(
    webview,
    "loadHTMLMainThread",
    "(Ljava/lang/String;)V",
    &[html.into()],
  )?;
  Ok(())
}

fn reload<'a>(env: &mut JNIEnv<'a>, webview: &JObject<'a>) -> JniResult<()> {
  env.call_method(webview, "reload", "()V", &[])?;
  Ok(())
}

fn go_forward<'a>(env: &mut JNIEnv<'a>, webview: &JObject<'a>) -> JniResult<()> {
  env.call_method(webview, "goForward", "()V", &[])?;
  Ok(())
}

fn go_back<'a>(env: &mut JNIEnv<'a>, webview: &JObject<'a>) -> JniResult<()> {
  env.call_method(webview, "goBack", "()V", &[])?;
  Ok(())
}

fn can_go_forward<'a>(env: &mut JNIEnv<'a>, webview: &JObject<'a>) -> JniResult<bool> {
  Ok(env.call_method(webview, "canGoForward", "()Z", &[])?.z()?)
}

fn can_go_back<'a>(env: &mut JNIEnv<'a>, webview: &JObject<'a>) -> JniResult<bool> {
  Ok(env.call_method(webview, "canGoBack", "()Z", &[])?.z()?)
}

fn set_background_color<'a>(
  env: &mut JNIEnv<'a>,
  webview: &JObject<'a>,
  (r, g, b, a): RGBA,
) -> JniResult<()> {
  let color = (a as i32) << 24 | (r as i32) << 16 | (g as i32) << 8 | (b as i32);
  env.call_method(webview, "setBackgroundColor", "(I)V", &[color.into()])?;
  Ok(())
}

pub(crate) enum WebViewMessage {
  CreateWebView(CreateWebViewAttributes),
  #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
  DestroyOwned {
    webview_id: WebviewId,
    callback: Box<dyn FnOnce(bool) + Send>,
  },
  Eval(String, Option<EvalCallback>),
  SetBackgroundColor(RGBA),
  GetWebViewVersion(Sender<Result<String, Error>>),
  GetUrl(Sender<String>),
  GetCookies(Sender<Vec<cookie::Cookie<'static>>>, String),
  Jni(Box<dyn FnOnce(&mut JNIEnv, &JObject, &JObject) + Send>),
  LoadUrl(String, Option<http::HeaderMap>),
  LoadHtml(String),
  Reload,
  GoForward,
  GoBack,
  CanGoForward(Sender<bool>),
  CanGoBack(Sender<bool>),
  ClearAllBrowsingData,
  OnDestroy {
    activity_id: ActivityId,
    webview_id: WebviewId,
    is_changing_configurations: bool,
    #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
    owned_activity: GlobalRef,
  },
}

#[derive(Clone)]
pub(crate) struct CreateWebViewAttributes {
  pub id: String,
  #[cfg(all(target_os = "android", feature = "android-app-owned-window-destroy"))]
  pub owned_generation: u64,
  pub url: Option<String>,
  pub html: Option<String>,
  #[cfg(any(debug_assertions, feature = "devtools"))]
  pub devtools: bool,
  pub transparent: bool,
  pub background_color: Option<RGBA>,
  pub headers: Option<http::HeaderMap>,
  pub autoplay: bool,
  pub on_webview_created:
    Option<Arc<dyn Fn(super::Context) -> JniResult<()> + Send + Sync + 'static>>,
  pub user_agent: Option<String>,
  pub initialization_scripts: Vec<InitializationScript>,
  pub javascript_disabled: bool,
}

// SAFETY: only use this when you are sure the span will be dropped on the same thread it was entered
#[cfg(feature = "tracing")]
struct SendEnteredSpan(tracing::span::EnteredSpan);

#[cfg(feature = "tracing")]
unsafe impl Send for SendEnteredSpan {}
