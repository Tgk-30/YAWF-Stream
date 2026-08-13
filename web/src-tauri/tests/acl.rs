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
fn mobile_build_injects_an_authoritative_webview_marker() {
    let source = include_str!("../src/lib.rs");

    assert!(source.contains(
        "#[cfg(mobile)]\n    let builder = builder.append_invoke_initialization_script("
    ));
    assert!(source
        .contains(";Object.defineProperty(window, '__YAWF_TAURI_MOBILE__', { value: true });"));
}
