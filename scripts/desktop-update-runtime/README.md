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
