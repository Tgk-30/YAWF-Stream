# Security Decisions

This log records the supported trust boundaries for YAWF Stream. It is the
release reference for security behavior that is intentional, including risks
that are accepted during the v0.9 beta.

## Supported threat model

YAWF Stream protects accounts and provider credentials from remote users who do
not have an authenticated session. It isolates account and profile data on the
server, limits desktop webview privileges, redacts support diagnostics, and
requires signed desktop updates.

The project does not claim to protect secrets after an attacker controls the
host OS, the browser profile, the YAWF Stream data directory, or the server
encryption key. Public multi-tenant hosting is not supported.

## Decision log

| ID | Status | Decision | Enforcement |
| --- | --- | --- | --- |
| SEC-001 | Accepted | Server Mode is private and self-hosted. Internet exposure requires HTTPS plus a trusted access layer or reverse proxy. | `SECURITY.md`, deployment guides, secure-cookie production default |
| SEC-002 | Accepted | Browser sessions use an httpOnly session cookie and a separate CSRF token. Every unsafe authenticated route requires the CSRF token. | server route tests and the security decision check |
| SEC-003 | Accepted | Server provider credentials and upstream stream URLs are encrypted with AES-256-GCM. The key is supplied by the operator or generated with mode `0600`. Database and key backups must remain together. | crypto tests, config tests, server schema |
| SEC-004 | Accepted | Desktop credentials are app-local data. They are not claimed to resist a compromised local account. The browser and desktop stores must scrub older plaintext migration sources after a durable move. | settings, IndexedDB, and keychain migration tests |
| SEC-005 | Accepted | Diagnostics contain capability state and bounded event codes, never configured secrets, provider URLs, raw stream URLs, cookies, or CSRF tokens. | diagnostics redaction tests |
| SEC-006 | Accepted | The desktop webview may contact user-configured HTTP and HTTPS providers, but it receives no shell or filesystem plugin permission. Follow-mode HTTP and HTTPS origins, including custom ports, use a separate capability with explicitly enumerated non-secret app commands; keychain commands remain local-only. External URL opening is scoped to HTTP, HTTPS, and the Windows installed-app settings page. Process control is limited to restart for the signed updater. | Tauri capability and app permission files, plus the security decision check |
| SEC-007 | Accepted | Desktop updates require the configured Tauri public key. Public macOS builds also require Developer ID signing and notarization. | release readiness and release workflow secret gates |
| SEC-008 | Windows channel gate | The release pipeline requires Azure Artifact Signing for the Windows application, MSI, and NSIS setup executable. The generated signing config validates the Azure origin and never serializes client identity credentials. Windows artifacts stay disabled unless `YAWF_RELEASE_WINDOWS=true`; when enabled, clean-install verification fails unless each installer and installed application has a valid signature. The macOS, Linux, Android TV, and server channels may ship while Windows remains held. | Explicit Windows release variable, Windows signing secret gate, pinned signing CLI, tested Tauri config generator, MSI and NSIS clean-install verification |
| SEC-009 | Accepted | macOS disables library validation and allows JIT only because the built-in libmpv player loads a bundled signed dependency graph and compiles GPU shaders. No additional entitlement is granted. | `entitlements.plist`, notarization, clean-install verification |
| SEC-010 | Accepted | Released database migrations are append-only, transactional, fixture-tested, and refuse databases created by a newer unsupported app. | migration hashes and server migration tests |
| SEC-011 | Accepted | Native playback of Server Mode proxy URLs uses a short-lived bearer capability bound to one stream session. The bearer is attached as a file-local libmpv header with redirects disabled, never placed in the URL or stored as a global player property. Follow-mode pages can use only the explicitly allowlisted player commands, properties, observations, and initialization options. | server route tests, native player unit tests, Tauri ACL test, and the security decision check |
| SEC-012 | Accepted | The Android TV WebView stays on the configured server origin, disables file/content access, popup windows, and third-party cookies, and can hand only same-origin playback URLs plus a bounded short-lived bearer to Media3. Native playback forwards only bounded `CF_Authorization`, `CF_Session`, and `CF_AppSession` cookies, never the YAWF Stream `ds_session` cookie. Plain HTTP is accepted only for trusted LAN or encrypted tailnet use; public remote access requires HTTPS. Production APKs use one stable signing identity whose public certificate digest is pinned in the repository and enforced before upload and during clean-install verification. | Android unit/lint gates, bridge and playback-header tests, signed release job, pinned certificate digest, APK clean-install verification, and the security decision check |
| SEC-013 | Accepted | Phone remote sessions are profile-bound and temporary. Pairing codes are single-use and stored only as hashes; controller capabilities are random, stored only as hashes, expire, and can submit only the bounded playback-command allowlist. The controller never receives a provider credential, raw stream URL, or video bytes. | remote registry tests, authenticated route tests, bounded queue, and the security decision check |

## Release rules

1. `node scripts/check_security_decisions.mjs` must pass in CI and the desktop
   release workflow.
2. A released migration string must never be edited. Add the next numbered
   migration instead.
3. Clean-install jobs must pass for both macOS architectures, the Linux
   AppImage, the Linux desktop deb, and the self-hosted server deb before a
   draft release is published. When `YAWF_RELEASE_WINDOWS=true`, both Windows
   installer formats and the installed application must also pass signature and
   clean-launch verification. The Android TV APK must pass signature, package,
   version, Leanback, and optional-touchscreen verification.
4. Any change to cookie flags, CSRF enforcement, CSP, Tauri capabilities,
   updater keys, encryption, diagnostics export, or install verification needs
   a matching test and a decision-log update.

## Windows security blocker

- Windows remains held while `YAWF_RELEASE_WINDOWS` is absent or false.
- Before setting it to true, provision the Azure Artifact Signing account,
  certificate profile, service principal permissions, and six repository
  secrets documented in `docs/RELEASE_AND_UPDATES.md`.
- Complete one Windows draft release and observe valid Authenticode signatures
  for the MSI, NSIS setup executable, and installed application in the
  clean-install jobs. An unsigned Windows artifact must never be published.
