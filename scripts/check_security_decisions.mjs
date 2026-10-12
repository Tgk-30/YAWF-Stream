#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function check(condition, message) {
  if (condition) console.log(`ok   ${message}`);
  else {
    failures.push(message);
    console.error(`fail ${message}`);
  }
}

const decisionsPath = "docs/SECURITY_DECISIONS.md";
check(existsSync(join(root, decisionsPath)), "Security decision log exists");
const decisions = read(decisionsPath);
for (let id = 1; id <= 13; id += 1) {
  check(decisions.includes(`SEC-${String(id).padStart(3, "0")}`), `Security decision SEC-${String(id).padStart(3, "0")} is recorded`);
}
check(
  /SEC-008[^\n]*NSIS[^\n]*config generator/.test(decisions),
  "Security decision SEC-008 covers NSIS and generated signing config",
);
check(
  /SEC-008[^\n]*YAWF_RELEASE_WINDOWS=true[^\n]*macOS, Linux, Android TV, and server channels may ship/.test(
    decisions,
  ),
  "Security decision SEC-008 records the held Windows channel without weakening its signing gate",
);

const capability = JSON.parse(read("web/src-tauri/capabilities/default.json"));
const remoteCapability = JSON.parse(
  read("web/src-tauri/capabilities/remote.json"),
);
const mobileCapability = JSON.parse(
  read("web/src-tauri/capabilities/mobile.json"),
);
const permissions = capability.permissions ?? [];
const remotePermissions = remoteCapability.permissions ?? [];
const permissionIds = permissions.map((entry) =>
  typeof entry === "string" ? entry : entry.identifier,
);
const remotePermissionIds = remotePermissions.map((entry) =>
  typeof entry === "string" ? entry : entry.identifier,
);
const mobilePermissionIds = (mobileCapability.permissions ?? []).map((entry) =>
  typeof entry === "string" ? entry : entry.identifier,
);
const remoteUrls = remoteCapability.remote?.urls ?? [];
check(capability.remote == null, "Local desktop capability has no remote scope");
check(
  remoteCapability.local === false &&
    ["https://*:*", "http://*:*"].every((url) => remoteUrls.includes(url)),
  "Follow-mode HTTP and HTTPS origins on custom ports receive the desktop capability",
);
check(
  permissionIds.includes("desktop-commands") &&
    remotePermissionIds.includes("remote-desktop-commands"),
  "Local and follow-mode desktop commands have separate app ACL permissions",
);
check(
  mobileCapability.windows?.includes("main") &&
    mobileCapability.platforms?.includes("android") &&
    mobileCapability.platforms?.includes("iOS") &&
    mobilePermissionIds.includes("mobile-commands") &&
    mobilePermissionIds.includes("http:default"),
  "Android and iOS main webviews receive the mobile command and HTTP capability",
);
const desktopPermission = read("web/src-tauri/permissions/desktop-commands.toml");
const remoteDesktopPermission = read(
  "web/src-tauri/permissions/remote-desktop-commands.toml",
);
const mobilePermission = read(
  "web/src-tauri/permissions/mobile-commands.toml",
);
const androidExternalPlayerCapability = JSON.parse(
  read("web/src-tauri/capabilities/android-external-player.json"),
);
const androidExternalPlayerPermission = read(
  "web/src-tauri/permissions/android-external-player.toml",
);
const androidExternalPlayerCommands = new Set(
  [...androidExternalPlayerPermission.matchAll(/commands\.allow\s*=\s*\[([^\]]*)\]/g)]
    .flatMap((match) => [...match[1].matchAll(/"([a-z][a-z0-9_]*)"/g)])
    .map((match) => match[1]),
);
check(
  androidExternalPlayerCapability.local === true &&
    androidExternalPlayerCapability.remote == null &&
    JSON.stringify(androidExternalPlayerCapability.windows) === '["main"]' &&
    JSON.stringify(androidExternalPlayerCapability.platforms) === '["android"]' &&
    JSON.stringify(androidExternalPlayerCapability.permissions) === '["android-external-player-command"]' &&
    androidExternalPlayerCommands.size === 1 &&
    androidExternalPlayerCommands.has("mobile_open_external_player"),
  "Android video chooser is restricted to the local main webview and its one command",
);
const androidRemoteSafeAreaCapability = JSON.parse(
  read("web/src-tauri/capabilities/android-remote-safe-area.json"),
);
const androidRemoteSafeAreaPermission = read(
  "web/src-tauri/permissions/android-remote-safe-area.toml",
);
const androidProjectPatcher = read("scripts/patch_tauri_android.mjs");
const mobileSafeAreaSource = read("web/src/lib/mobileSafeArea.ts");
// Inspect the current generated activity, not recognized historical templates.
const currentActivityStart = androidProjectPatcher.indexOf("function patchedMainActivity(packageName) {");
const currentActivityEnd = androidProjectPatcher.indexOf("\nfunction replacementState(", currentActivityStart);
const currentActivityTemplate = currentActivityStart >= 0 && currentActivityEnd > currentActivityStart
  ? androidProjectPatcher.slice(currentActivityStart, currentActivityEnd)
  : "";

const androidRemoteSafeAreaCommands = new Set(
  [...androidRemoteSafeAreaPermission.matchAll(/commands\.allow\s*=\s*\[([^\]]*)\]/g)]
    .flatMap((match) => [...match[1].matchAll(/"([a-z][a-z0-9_]*)"/g)])
    .map((match) => match[1]),
);
check(
  androidRemoteSafeAreaCapability.local === false &&
    JSON.stringify(androidRemoteSafeAreaCapability.windows) === '["main"]' &&
    JSON.stringify(androidRemoteSafeAreaCapability.platforms) === '["android"]' &&
    JSON.stringify(androidRemoteSafeAreaCapability.remote?.urls) === '["https://*:*","http://*:*"]' &&
    JSON.stringify(androidRemoteSafeAreaCapability.permissions) === '["android-remote-safe-area-command"]' &&
    androidRemoteSafeAreaCommands.size === 1 &&
    androidRemoteSafeAreaCommands.has("mobile_safe_area_insets") &&
    /SEC-014[^\n]*four nonnegative integer safe-area insets[^\n]*no origin attestation[^\n]*no external-player, file, credential, native-network or other native access/.test(decisions),
  "Remote Android main pages receive only read-only numeric safe-area insets",
);
const generatedInsetBridge = /@Keep\nclass YawfSafeAreaBridge\([\s\S]*?\n}\n\nclass MainActivity/.exec(
  currentActivityTemplate,
)?.[0];
const expectedGeneratedInsetBridge = `@Keep
class YawfSafeAreaBridge(
  private val snapshot: AtomicReference<String>,
) {
  @JavascriptInterface
  fun getInsets(): String = snapshot.get()
}

class MainActivity`;
check(
  generatedInsetBridge === expectedGeneratedInsetBridge &&
    (currentActivityTemplate.match(/@JavascriptInterface/g)?.length ?? 0) === 1 &&
    /private const val SAFE_AREA_BRIDGE_NAME = "__YAWF_NATIVE_SAFE_AREA__"/.test(
      androidProjectPatcher,
    ) &&
    /__YAWF_NATIVE_SAFE_AREA__/.test(mobileSafeAreaSource) &&
    /webView\.addJavascriptInterface\(safeAreaBridge, SAFE_AREA_BRIDGE_NAME\)/.test(
      androidProjectPatcher,
    ) &&
    /webView\.removeJavascriptInterface\(SAFE_AREA_BRIDGE_NAME\)/.test(
      androidProjectPatcher,
    ) &&
    /private const val SAFE_AREA_CHANGE_SCRIPT = "window\.dispatchEvent\(new Event\('yawf-native-safe-area-change'\)\)"/.test(
      androidProjectPatcher,
    ) &&
    /safeAreaSnapshot\.getAndSet\(nextSnapshot\) != nextSnapshot/.test(
      androidProjectPatcher,
    ) &&
    /webView\.evaluateJavascript\(SAFE_AREA_CHANGE_SCRIPT, null\)/.test(
      androidProjectPatcher,
    ) &&
    /const NATIVE_SAFE_AREA_CHANGE_EVENT = "yawf-native-safe-area-change"/.test(
      mobileSafeAreaSource,
    ) &&
    /addEventListener\(NATIVE_SAFE_AREA_CHANGE_EVENT, schedule\)/.test(
      mobileSafeAreaSource,
    ) &&
    /removeEventListener\(NATIVE_SAFE_AREA_CHANGE_EVENT, schedule\)/.test(
      mobileSafeAreaSource,
    ) &&
    !/__TAURI_INTERNALS__|__TAURI__/.test(androidProjectPatcher) &&
    !/setWebViewClient|setOnApplyWindowInsetsListener/.test(androidProjectPatcher),
  "Legacy Android inset transport exposes one cached getter and a fixed no-payload change event",
);
const desktopCommandNames = new Set(
  [...desktopPermission.matchAll(/^\s*"([a-z][a-z0-9_]*)",?\s*$/gm)].map(
    (match) => match[1],
  ),
);
const remoteDesktopCommandNames = new Set(
  [
    ...remoteDesktopPermission.matchAll(
      /^\s*"([a-z][a-z0-9_]*)",?\s*$/gm,
    ),
  ].map((match) => match[1]),
);
const mobileCommandNames = new Set(
  [...mobilePermission.matchAll(/^\s*"([a-z][a-z0-9_]*)",?\s*$/gm)].map(
    (match) => match[1],
  ),
);
const allMobileCommandNames = new Set([
  ...mobileCommandNames,
  ...androidExternalPlayerCommands,
]);
check(
  !mobileCommandNames.has("mobile_open_external_player") &&
    !desktopCommandNames.has("mobile_open_external_player") &&
    !remoteDesktopCommandNames.has("mobile_open_external_player"),
  "The chooser command is not granted by broader mobile, desktop or remote permissions",
);
const tauriLib = read("web/src-tauri/src/lib.rs");
// generate_handler! cannot cfg individual entries, so lib.rs registers one list
// per target family. Attribute each list to the cfg attribute guarding it rather
// than to its position in the file: reading the mobile list as though it were
// the desktop one is precisely the confusion this check exists to catch.
function handlerBlocks(source) {
  const blocks = new Map();
  const pattern = /\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/g;
  for (const match of source.matchAll(pattern)) {
    const preceding = source.slice(Math.max(0, match.index - 240), match.index);
    const cfg = [...preceding.matchAll(/#\[cfg\((desktop|mobile|target_os\s*=\s*"(?:android|ios)")\)\]/g)].pop();
    if (cfg) {
      const target = cfg[1].includes('"android"')
        ? "android"
        : cfg[1].includes('"ios"')
          ? "iOS"
          : cfg[1];
      blocks.set(target, match[1]);
    }
  }
  return blocks;
}
function registeredCommands(block) {
  return new Set(
    [
      ...block.matchAll(/^\s*(?:[a-z][a-z0-9_]*::)?([a-z][a-z0-9_]*),\s*$/gm),
    ].map((match) => match[1]),
  );
}
const invokeHandlers = handlerBlocks(tauriLib);
const registeredAndroidCommands = registeredCommands(invokeHandlers.get("android") ?? "");
const registeredIOSCommands = registeredCommands(invokeHandlers.get("iOS") ?? "");
const registeredDesktopCommands = registeredCommands(
  invokeHandlers.get("desktop") ?? "",
);
check(
  invokeHandlers.has("desktop") && invokeHandlers.has("android") && invokeHandlers.has("iOS"),
  "Desktop, Android and iOS invoke handler command lists are readable",
);
check(
  registeredDesktopCommands.size > 0 &&
    [...registeredDesktopCommands].every((command) =>
      desktopCommandNames.has(command),
    ) &&
    [...desktopCommandNames].every((command) => registeredDesktopCommands.has(command)),
  "Desktop app ACL stays in sync with every registered command",
);
const registeredMobileCommands = new Set(
  [...registeredAndroidCommands, ...registeredIOSCommands],
);
check(
  registeredAndroidCommands.has("mobile_open_external_player") &&
    !registeredIOSCommands.has("mobile_open_external_player") &&
    [...allMobileCommandNames].every((command) => registeredAndroidCommands.has(command)) &&
    [...registeredAndroidCommands].every((command) => allMobileCommandNames.has(command)) &&
    [...mobileCommandNames].every((command) => registeredIOSCommands.has(command)) &&
    [...registeredIOSCommands].every((command) => mobileCommandNames.has(command)),
  "Only Android registers the chooser; iOS retains exactly its mobile command surface",
);
check(
  registeredMobileCommands.size > 0 &&
    [...registeredMobileCommands].every((command) =>
      allMobileCommandNames.has(command),
    ) &&
    [...allMobileCommandNames].every((command) =>
      registeredMobileCommands.has(command),
    ),
  "Mobile app ACL stays in sync with every registered command",
);
check(
  [
    "player_init",
    "player_command",
    "player_set_property",
    "player_get_property",
    "player_set_video_margin",
    "player_set_rect",
    "player_destroy",
  ].every((command) => remoteDesktopCommandNames.has(command)),
  "Built-in player commands are allowed for follow-mode playback",
);
check(
  !remoteDesktopCommandNames.has("player_load"),
  "Follow-mode pages cannot use the legacy unvalidated player loader",
);
check(
  !["keychain_get", "keychain_set", "keychain_delete"].some((command) =>
    remoteDesktopCommandNames.has(command),
  ),
  "Follow-mode pages cannot access desktop keychain commands",
);

// v2.2.0 shipped an Android build in which no capability listed a mobile
// platform at all. Tauri denied every command including the HTTP plugin, so the
// app could not reach any indexer or debrid host, and nothing in the build or
// the test suite failed. The named checks above assert the mobile case that was
// missed; this loop asserts the general property, so a target added later
// cannot repeat it: every supported platform has a local capability, that
// capability grants every command the platform registers, and outbound HTTP is
// granted.
const SUPPORTED_PLATFORMS = ["macOS", "windows", "linux", "android", "iOS"];
const appPermissionCommands = new Map([
  ["desktop-commands", desktopCommandNames],
  ["remote-desktop-commands", remoteDesktopCommandNames],
  ["mobile-commands", mobileCommandNames],
  ["android-external-player-command", androidExternalPlayerCommands],
  ["android-remote-safe-area-command", androidRemoteSafeAreaCommands],
]);
const capabilities = readdirSync(join(root, "web/src-tauri/capabilities"))
  .filter((name) => name.endsWith(".json"))
  .flatMap((name) => {
    const parsed = JSON.parse(read(`web/src-tauri/capabilities/${name}`));
    return Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.capabilities)
        ? parsed.capabilities
        : [parsed];
  });
const androidRemoteCapabilities = capabilities.filter(
  (entry) =>
    (entry.platforms ?? SUPPORTED_PLATFORMS).includes("android") &&
    (entry.remote?.urls?.length ?? 0) > 0,
);
check(
  androidRemoteCapabilities.length === 1 &&
    androidRemoteCapabilities[0].identifier === "android-remote-safe-area" &&
    JSON.stringify(androidRemoteCapabilities[0].permissions) === '["android-remote-safe-area-command"]',
  "All Android remote capabilities together expose only the numeric inset getter",
);
for (const platform of SUPPORTED_PLATFORMS) {
  // An omitted platforms list means every platform, and local defaults to true.
  const applying = capabilities.filter(
    (entry) =>
      entry.local !== false &&
      (entry.platforms ?? SUPPORTED_PLATFORMS).includes(platform),
  );
  check(
    applying.length > 0,
    `Main window has a local capability on ${platform}`,
  );
  const grantedPermissionIds = applying.flatMap((entry) =>
    (entry.permissions ?? []).map((permission) =>
      typeof permission === "string" ? permission : permission.identifier,
    ),
  );
  const grantedCommands = new Set(
    grantedPermissionIds.flatMap((id) => [
      ...(appPermissionCommands.get(id) ?? []),
    ]),
  );
  const required = platform === "android"
    ? registeredAndroidCommands
    : platform === "iOS"
      ? registeredIOSCommands
      : registeredDesktopCommands;
  const ungranted = [...required].filter(
    (command) => !grantedCommands.has(command),
  );
  check(
    required.size > 0 && ungranted.length === 0,
    `Every command registered on ${platform} is granted by a capability${
      ungranted.length > 0 ? ` (ungranted: ${ungranted.join(", ")})` : ""
    }`,
  );
  check(
    grantedPermissionIds.includes("http:default"),
    `Outbound HTTP is granted on ${platform}`,
  );
}
check(!permissionIds.includes("opener:default"), "Desktop opener does not grant the default reveal permission");
check(!permissionIds.includes("process:default"), "Desktop process plugin does not grant exit permission");
check(permissionIds.includes("process:allow-restart"), "Desktop process plugin is limited to updater restart");
const opener = permissions.find(
  (entry) => typeof entry === "object" && entry.identifier === "opener:allow-open-url",
);
const openerUrls = (opener?.allow ?? []).map((entry) => entry.url);
check(
  ["https://*", "http://*", "ms-settings:appsfeatures"].every((url) => openerUrls.includes(url)),
  "Desktop external URL scope is explicit",
);
check(!permissionIds.some((id) => id.startsWith("shell:")), "Desktop webview has no shell permission");
check(!permissionIds.some((id) => id.startsWith("fs:")), "Desktop webview has no filesystem permission");
check(
  !remotePermissionIds.some((id) => id.startsWith("shell:") || id.startsWith("fs:")),
  "Follow-mode webview has no shell or filesystem permission",
);

const tauri = JSON.parse(read("web/src-tauri/tauri.conf.json"));
check(
  tauri.app?.windows?.[0]?.label === "main",
  "Configured main window label matches every capability",
);
const csp = tauri.app?.security?.csp ?? "";
check(csp.includes("default-src 'self'"), "Desktop CSP defaults to self");
check(csp.includes("object-src 'none'"), "Desktop CSP blocks objects");
check(csp.includes("frame-ancestors 'none'"), "Desktop CSP blocks framing");
check(!csp.includes("'unsafe-eval'"), "Desktop CSP blocks eval");
check(tauri.bundle?.createUpdaterArtifacts === true, "Updater artifacts remain enabled");
check((tauri.plugins?.updater?.pubkey ?? "").length > 40, "Updater public key is configured");

const releaseWorkflow = read(".github/workflows/web-release.yml");
const cleanInstallWorkflow = read(".github/workflows/clean-install.yml");
const windowsSigningConfig = read("scripts/generate_windows_signing_config.mjs");
check(
  /artifact-signing-cli --version 0\.11\.0 --locked/.test(releaseWorkflow) &&
    /AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE/.test(releaseWorkflow) &&
    /codesigning\\\.azure\\\.net/.test(windowsSigningConfig) &&
    !/AZURE_CLIENT_SECRET/.test(windowsSigningConfig),
  "Windows release signing uses the pinned Azure Artifact Signing path",
);
check(
  /Windows \$env:INSTALLER_KIND installer Authenticode signature is not valid/.test(
    cleanInstallWorkflow,
  ) &&
    /Installed app Authenticode signature is not valid/.test(cleanInstallWorkflow) &&
    /kind: msi/.test(cleanInstallWorkflow) &&
    /kind: nsis/.test(cleanInstallWorkflow),
  "Windows clean installs require valid MSI, NSIS, and app signatures",
);
check(
  /if:\s*matrix\.os == 'windows' && vars\.YAWF_RELEASE_WINDOWS == 'true'/.test(
    releaseWorkflow,
  ) &&
    /include_windows:\s*\$\{\{\s*vars\.YAWF_RELEASE_WINDOWS == 'true'\s*\}\}/.test(
      releaseWorkflow,
    ) &&
    /windows:[\s\S]{0,120}if:\s*inputs\.include_windows/.test(cleanInstallWorkflow),
  "Held Windows releases emit no artifact while enabled releases retain clean-install enforcement",
);

const serverConfig = read("server/src/config.ts");
const serverCrypto = read("server/src/crypto.ts");
const serverApp = read("server/src/app.ts");
const database = read("server/src/db.ts");
const diagnostics = read("web/src/lib/diagnostics.ts");
const nativePlayer = read("web/src-tauri/src/render_player/core.rs");
const androidManifest = read("android-tv/app/src/main/AndroidManifest.xml");
const androidMain = read(
  "android-tv/app/src/main/java/com/yawf/stream/tv/MainActivity.java",
);
const androidNetwork = read(
  "android-tv/app/src/main/res/xml/network_security_config.xml",
);
const androidSigningDigest = read("android-tv/SIGNING_CERT_SHA256");
const androidPlaybackHeaders = read(
  "android-tv/app/src/main/java/com/yawf/stream/tv/PlaybackHeaders.java",
);
const remoteControl = read("server/src/remoteControl.ts");
const serverUpdater = read("deploy/updater/yawf-server-update.mjs");
const serverUpdaterCopy = read("deploy/updater/volume-copy.mjs");
const serverUpdaterStatus = read("server/src/serverUpdaterStatus.ts");
const serverCompose = read("deploy/compose/docker-compose.ghcr.yml");
const serverUpdaterWrapper = read("deploy/updater/yawf-server-update");
check(
  /allowRawStreamUrls:[\s\S]{0,160}process\.env\.NODE_ENV !== "production"/.test(serverConfig),
  "Production raw stream URL creation defaults off",
);
check(/createCipheriv\("aes-256-gcm"/.test(serverCrypto), "Server secrets use AES-256-GCM");
check(/writeFileSync\(path, generated, \{ mode: 0o600 \}\)/.test(serverConfig), "Generated server key uses mode 0600");
check(/cookieOptions\(config, true\)/.test(serverApp), "Session cookie is httpOnly");
check(/requireCsrf\(request\)/.test(serverApp), "Unsafe authenticated routes enforce CSRF");
check(/BEGIN IMMEDIATE/.test(database) && /ROLLBACK/.test(database), "Database migrations are transactional");
check(/newer than supported version/.test(database), "Newer database versions fail closed");
check(/redactDiagnosticText/.test(diagnostics) && /LONG_CREDENTIAL/.test(diagnostics), "Diagnostics redact credential-shaped values");
check(
  /createHmac\("sha256", config\.secretKey\)/.test(serverApp) &&
    /streamPlaybackTokenMatches/.test(serverApp),
  "Server playback bearer is stream-scoped and authenticated",
);
check(
  /_ => return Err\("command is not allowed"\.to_string\(\)\)/.test(nativePlayer) &&
    /_ => Err\("property is not allowed"\.to_string\(\)\)/.test(nativePlayer) &&
    /stream-lavf-o=max_redirects=0/.test(nativePlayer),
  "Native player bridge is allowlisted and keeps playback authorization file-local",
);
check(
  /android\.software\.leanback/.test(androidManifest) &&
    /android\.hardware\.touchscreen/.test(androidManifest) &&
    /android:required="false"/.test(androidManifest) &&
    /ServerAddress\.sameOrigin\(serverBase, url\)/.test(androidMain) &&
    /setAllowFileAccess\(false\)/.test(androidMain) &&
    /setAllowContentAccess\(false\)/.test(androidMain) &&
    /setSupportMultipleWindows\(false\)/.test(androidMain) &&
    /setAcceptThirdPartyCookies\(webView, false\)/.test(androidMain) &&
    /!value\.startsWith\("Bearer "\)/.test(androidMain) &&
    /PlaybackHeaders\.cloudflareCookieHeader/.test(androidMain) &&
    /"CF_Authorization"/.test(androidPlaybackHeaders) &&
    /"CF_Session"/.test(androidPlaybackHeaders) &&
    /"CF_AppSession"/.test(androidPlaybackHeaders) &&
    !/"ds_session"/.test(androidPlaybackHeaders) &&
    /^[0-9a-f]{64}(?:\r?\n)?$/.test(androidSigningDigest) &&
    /SIGNING_CERT_SHA256/.test(releaseWorkflow) &&
    /SIGNING_CERT_SHA256/.test(cleanInstallWorkflow) &&
    !/<certificates src="user"/.test(androidNetwork),
  "Android TV confines its WebView and native playback bridge to the configured server",
);
check(
  /Validate Android signing secrets/.test(releaseWorkflow) &&
    /ANDROID_TV_KEYSTORE_BASE64/.test(releaseWorkflow) &&
    /:app:lintRelease :app:assembleRelease/.test(releaseWorkflow) &&
    /apksigner verify/.test(releaseWorkflow) &&
    /com\.yawf\.stream\.tv/.test(cleanInstallWorkflow),
  "Android TV releases require stable signing and verify the published package identity",
);
check(
  /randomInt\(0, 1_000_000\)/.test(remoteControl) &&
    /pairingCodeHash: digest\(pairingCode\)/.test(remoteControl) &&
    /controllerTokenHash = digest\(controllerToken\)/.test(remoteControl) &&
    /viewerProfileId !== viewerProfileId/.test(remoteControl) &&
    /REMOTE_COMMAND_LIMIT/.test(remoteControl) &&
    /REMOTE_SESSION_TTL_MS/.test(remoteControl),
  "Phone remote capabilities are hashed, profile-bound, expiring, and queue-bounded",
);
check(
  /REPOSITORY = "ghcr\.io\/tgk-30\/yawf-stream"/.test(serverUpdater) &&
    /server-update\.json/.test(serverUpdater) &&
    /candidate\.image\.digest/.test(serverUpdater) &&
    /"--no-deps", "debridstreamer"/.test(serverUpdater) &&
    /Active playback is in progress/.test(serverUpdater) &&
    /snapshotVolume/.test(serverUpdater) &&
    /rollback\(policy, journal\)/.test(serverUpdater) &&
    /stopAndConfirm/.test(serverUpdater) &&
    /registrationIdentity/.test(serverUpdater) &&
    /"--cap-add", "DAC_OVERRIDE", "--cap-add", "CHOWN"/.test(serverUpdater) &&
    /flock -n 9/.test(serverUpdaterWrapper) &&
    /isSymbolicLink\(\)/.test(serverUpdaterCopy) &&
    /O_NOFOLLOW/.test(serverUpdaterStatus) &&
    /readServerUpdaterStatus/.test(serverUpdaterStatus) &&
    !/docker\.sock/.test(serverCompose),
  "Server auto-update stays in the root host helper with immutable provenance, backup rollback, and read-only app status",
);

if (failures.length > 0) {
  console.error(`\n${failures.length} security decision check(s) failed.`);
  process.exit(1);
}
console.log("\nSecurity decision checks passed.");
