# Independent macOS media runtime source notices

The shipped macOS media runtime is rebuilt from the component source trees in
the corresponding-source archive by `replay-controls/replay_macos_media_sources.mjs`.
The inherited IINA recipe controls in the original source seed are not executed.

The archive contains the exact independent controller, replay plan, shipping
output contract, confinement producer, relocation and verification tools used
for the build. `OWNED-FILE-MANIFEST.json` records their SHA-256 values. The
component notice inventory and each notice hash are recorded in
`SOURCE-INVENTORY.json`.

FFmpeg is configured with GPL and version 3 features and with x264. Component
sources and notices retain their own license terms. This notice does not grant
additional rights, establish binary equivalence with an earlier build, or claim
that distribution licensing has been cleared.
