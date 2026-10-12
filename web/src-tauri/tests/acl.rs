use tauri::utils::acl::RemoteUrlPattern;

#[test]
fn follow_mode_capability_covers_dynamic_server_ports() {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/remote.json")).unwrap();
    let patterns = capability["remote"]["urls"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().parse::<RemoteUrlPattern>().unwrap())
        .collect::<Vec<_>>();

    for url in [
        "http://127.0.0.1:43110/",
        "http://192.168.1.5:43110/",
        "https://stream.example.com/",
        "https://stream.example.com:8443/",
    ] {
        let parsed = url.parse().unwrap();
        assert!(
            patterns.iter().any(|pattern| pattern.test(&parsed)),
            "follow-mode capability did not match {url}",
        );
    }
}

#[test]
fn follow_mode_does_not_expose_the_legacy_unvalidated_player_loader() {
    let permissions = include_str!("../permissions/remote-desktop-commands.toml");
    let allowed = permissions
        .lines()
        .map(str::trim)
        .filter_map(|line| line.strip_prefix('"')?.strip_suffix("\","))
        .collect::<Vec<_>>();

    assert!(!allowed.contains(&"player_load"));
    assert!(allowed.contains(&"player_command"));
}

#[test]
fn mobile_capability_matches_the_explicit_main_window() {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/mobile.json")).unwrap();
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();

    assert_eq!(config["app"]["windows"][0]["label"], "main");
    assert_eq!(capability["windows"][0], "main");
    assert!(capability["platforms"]
        .as_array()
        .unwrap()
        .iter()
        .any(|platform| platform == "android"));
    assert!(capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|permission| permission == "mobile-commands"));
    assert!(capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|permission| permission["identifier"] == "http:default"));
}

#[test]
fn mobile_capability_does_not_grant_desktop_player_handoffs() {
    let permissions = include_str!("../permissions/mobile-commands.toml");
    let allowed = permissions
        .lines()
        .map(str::trim)
        .filter_map(|line| line.strip_prefix('"')?.strip_suffix("\","))
        .collect::<Vec<_>>();

    assert!(!allowed.contains(&"open_in_external_player"));
    assert!(!allowed.contains(&"mpv_play"));
}

#[test]
fn android_external_player_capability_is_local_main_window_only() {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/android-external-player.json")).unwrap();

    assert_eq!(capability["identifier"], "android-external-player");
    assert_eq!(capability["local"], true);
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert_eq!(capability["platforms"], serde_json::json!(["android"]));
    assert_eq!(
        capability["permissions"],
        serde_json::json!(["android-external-player-command"])
    );
    assert!(capability.get("remote").is_none());
}

#[test]
fn android_external_player_permission_grants_only_the_validated_chooser() {
    let permission = include_str!("../permissions/android-external-player.toml");
    let allowed = permission
        .lines()
        .map(str::trim)
        .find_map(|line| {
            line.strip_prefix("commands.allow = [\"")?
                .strip_suffix("\"]")
        })
        .unwrap();

    assert_eq!(allowed, "mobile_open_external_player");
    assert!(!include_str!("../permissions/mobile-commands.toml")
        .contains("mobile_open_external_player"));
    assert!(!include_str!("../permissions/remote-desktop-commands.toml")
        .contains("mobile_open_external_player"));
}

#[test]
fn android_chooser_clears_pending_java_exceptions_without_exposing_details() {
    let source = include_str!("../src/mobile_external_player.rs");

    assert!(source.contains("env.exception_check()"));
    assert!(source.contains("env.exception_clear()"));
    assert!(!source.contains("exception_describe"));
}

#[test]
fn mobile_build_injects_an_authoritative_webview_marker() {
    let source = include_str!("../src/lib.rs");

    assert!(source.contains(
        "#[cfg(mobile)]\n    let builder = builder.append_invoke_initialization_script("
    ));
    assert!(source
        .contains(";Object.defineProperty(window, '__YAWF_TAURI_MOBILE__', { value: true });"));
}

#[test]
fn android_build_injects_a_platform_specific_webview_marker() {
    let source = include_str!("../src/lib.rs");
    let marker = ";Object.defineProperty(window, '__YAWF_TAURI_ANDROID__', { value: true });";
    let marker_offset = source.find(marker).expect("Android marker is missing");
    let marker_prefix = &source[..marker_offset];
    let cfg_offset = marker_prefix
        .rfind("#[cfg(")
        .expect("Android marker has no target guard");

    assert_eq!(
        marker_prefix[cfg_offset..].lines().next(),
        Some("#[cfg(target_os = \"android\")]")
    );
    assert_eq!(source.matches(marker).count(), 1);
}
