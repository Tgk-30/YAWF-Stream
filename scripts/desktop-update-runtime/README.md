# Disposable desktop updater runtime test

This is a qualification fixture, not a release builder. The entry point refuses
to run outside a GitHub-hosted macOS test job. It never installs into
`/Applications`, reads a user profile, or uses production signing credentials.

The workflow builds two versions of the current Rust host with a unique test
bundle identifier and a test-only frontend. The frontend imports the real
production playback and updater facades. A loopback-only service supplies
generated media and an update archive signed with a fresh disposable key. The
checked-in production updater configuration, keys, capabilities, and permissions
are not modified. Test overrides permit HTTP only for this loopback feed.

The media libraries and fixture generator come from the pinned, hash-checked
public desktop 2.3.58 package. Its existing bundle signature is verified before
use. Both architectures use their corresponding native package. Fixture app
bundles are ad-hoc signed, not Developer ID signed or notarized.

The observer requires ordered playback, pause, update deferral, native destroy
acknowledgement, exactly one archive download, actual installation, old-process
exit, a new process booting the target version, and post-update native playback.
It independently checks the installed executable hash, bundle version and
signature, plus preservation of a marker in the isolated test home. It records
HTTP requests, frontend stage receipts and bounded build/process logs. Private
keys are removed before launch and never included in evidence artifacts.
The existing native debug tracer is enabled only after exclusively claiming its
fixed log path on the disposable runner. A bounded head/tail snapshot is retained
after exact fixture-process cleanup, then the owned log is removed. An existing
unrelated log is never read or overwritten.
An early, same-host CGL probe records the exact accelerated 3.2-core context
requirements. A separately labeled default control runs only if the exact
attempt is unavailable. This diagnostic neither changes the application graphics
policy nor proves Core Animation drawing or video rendering. Compile, timeout,
signal, restoration, or malformed-output failures are distinct from a successful
observation of unsupported capability. The early receipt is uploaded before the
long native builds so it can be inspected without restarting those producers.

Run the fixture contracts with:

```sh
node --test scripts/desktop-update-runtime/*.test.mjs
```

The GitHub workflow runs the actual native qualification on Apple Silicon and
Intel. Passing this test does not prove physical audio/video output, every player
UI action, provider playback, Developer ID/notarized release installation, or
the update transaction across a destroyed WebView document. Those remain
separate qualification requirements. In particular, a successful ordinary
transaction must not be used to waive the cross-document admission defect.

## Separate WKWebView HTML5 reader lane

The four-job matrix keeps both strict MPV jobs and adds independently labeled
`wkwebview-html5` jobs on both architectures. `--run` remains the MPV lane;
`--run-wkwebview` selects the separate production `VideoPlayer` HTML5 reader and
real `UpdateBanner`. The hosted runner guard, native updater, ephemeral signing,
exact process-exit/successor PID, installed hash/version, signature, and preserved
isolated-home checks are shared unchanged. Evidence and artifacts identify the
reader type and cannot be combined into an MPV pass.

The WKWebView lane requires actual muted H264 clock progress and decoded
`videoWidth`, real Pause and Play controls, production keyboard seeking, and a
real Close button followed by React unmount, released activity, paused detached
media and a stopped media clock. While paused, an independent real
`PendingUpdate.install()` must reject with production `UpdateDeferredError` and
its unused candidate is closed. The Banner then performs a manual installation
only after the host has acknowledged reader closure. The host requires exactly
one archive request after that acknowledgement and installation request, then a
new native process and repeated actual playback/control observations. This does
not claim automatic queued intent or MPV issued-command teardown coverage.

A graphics-limited runner may pass the separate WKWebView lane while the MPV
lane still fails. A working default CGL2.1 control does not replace the production
accelerated core3.2 profile, and neither CGL capability nor HTML5 playback waives
strict MPV rendering readiness or proves physical audio/video output.
