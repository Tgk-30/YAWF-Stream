# YAWF Stream for Android TV

This TV-only app connects to a self-hosted YAWF Stream server, loads its
ten-foot `/tv` interface, and hands playback to AndroidX Media3 instead of the
system WebView video element.

## Requirements

- Android TV or Google TV with Android 6.0 or newer
- A YAWF Stream server reachable from the TV
- HTTPS for remote access, or an HTTP address on a trusted home network

## Build

Use JDK 17, Android SDK 36, and Gradle 9.5:

```sh
gradle :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

Production APKs must be signed with the stable YAWF Stream Android signing key.
Do not publish debug-signed or unsigned builds as updates because Android ties
future upgrades to the original signing identity.

## Security boundary

The WebView can navigate only within the configured server origin. Playback
requests from that trusted origin may include a short-lived playback bearer.
The bridge passes it directly to Media3 as an HTTP header and never logs or
persists it. Session cookies remain in Android's WebView cookie store.
