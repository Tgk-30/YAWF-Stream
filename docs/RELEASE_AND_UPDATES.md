# Release, Downloads, and OTA Updates

DebridStreamer ships three public-facing artifacts:

- Desktop app bundles from the Tauri project in `web/`, including the local
  Server Mode supervisor resources.
- Server Mode Docker image from the root `Dockerfile`.
- Static download website from `website/`, deployed at
  `https://tgk30.com/debridstreamer/` through Cloudflare.

## Desktop OTA Updates

The desktop app uses `tauri-plugin-updater`.

- Runtime check: `web/src/lib/updater.ts`
- User prompt and auto-install option: `web/src/components/UpdateBanner.tsx`
- Settings toggles: Settings -> Updates
- Update endpoint: `web/src-tauri/tauri.conf.json`
- Updater artifact generation: `bundle.createUpdaterArtifacts` in
  `web/src-tauri/tauri.conf.json`
- CI release workflow: `.github/workflows/web-release.yml`

The Tauri bundler creates signed updater artifacts, and the release workflow
publishes those bundles plus `latest.json` to GitHub Releases. After every
platform job finishes, the workflow generates `SHA256SUMS` for the complete
draft asset set and creates GitHub build-provenance attestations. Clean-install
verification starts only after those trust files exist. Installed desktop apps
read:

```text
https://github.com/Tgk-30/YAWF-Stream/releases/latest/download/latest.json
```

The updater public key is committed in `tauri.conf.json`; the private key must
be stored as GitHub Actions secrets:

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

macOS public releases also need Developer ID signing and notarization secrets as
listed in `web/PACKAGING.md`. The release workflow fails early if the updater
private key is missing, and the macOS job fails early if Developer ID /
notarization secrets are missing.

Windows public releases use Azure Artifact Signing through Tauri's custom sign
command. Windows artifacts are held by default. The Windows release job runs
only when the repository Actions variable `YAWF_RELEASE_WINDOWS` is exactly
`true`, and then requires these GitHub Actions secrets:

```text
AZURE_CLIENT_ID
AZURE_CLIENT_SECRET
AZURE_TENANT_ID
AZURE_ARTIFACT_SIGNING_ENDPOINT
AZURE_ARTIFACT_SIGNING_ACCOUNT
AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE
```

The service principal must have permission to use the named certificate profile.
The workflow installs the pinned `artifact-signing-cli` 0.11.0 release, signs
the Windows application, MSI, and NSIS setup executable during bundling, and
uses `scripts/generate_windows_signing_config.mjs` to validate the endpoint and
generate a test-covered Tauri config. The generator never writes Azure client
identity credentials into that file. See the
[Tauri Windows signing guide](https://v2.tauri.app/distribute/sign/windows/) and
[Microsoft Artifact Signing documentation](https://learn.microsoft.com/azure/artifact-signing/).

Do not enable `YAWF_RELEASE_WINDOWS` until all six secrets are provisioned. A
true value deliberately fails closed when any signing credential, installer
signature, or installed application signature is missing. Leaving the variable
absent or false publishes no Windows artifact and does not weaken the future
Windows gate.

GitHub Actions must be able to start hosted runners before any of those release
steps can run. If CI, Docker, Pages, and Cloudflare workflows all fail before
checkout with empty step logs, inspect the check-run annotations. A message
about failed account payments or increasing the spending limit is an account
billing/spending-limit blocker; no macOS, Linux, Windows, Docker, or website
artifacts will be produced until that is resolved.

## Cutting A Desktop Release

1. Update `version` in `web/src-tauri/tauri.conf.json`.
2. Confirm GitHub Actions billing/spending-limit status is healthy, then run
   readiness checks:

   ```sh
   node scripts/public_repo_preflight.mjs
   node scripts/public_repo_preflight.mjs --all-refs
   node scripts/check_release_readiness.mjs
   node scripts/check_security_decisions.mjs
   node scripts/check_swift_tests.mjs
   node scripts/check_local_package_artifact.mjs --require-current
   cd server && npm run typecheck && npm run build
   cd web && npm run typecheck && npm test && npm run build
   cargo check --manifest-path web/src-tauri/Cargo.toml
   ```

   The default public repo preflight scans tracked files, unignored untracked
   files, commit messages, and reachable `HEAD` history blobs for assistant
   notes, transcripts, `.env` files, private key blocks, and provider
   credential literals. Use `--all-refs` before pushing multiple branches or
   tags to a public remote so old local refs are scanned too.

   `check_swift_tests.mjs` runs the native Swift test suite from a
   `/private/tmp` SwiftPM scratch directory, links the packaged `VLCKit`
   framework into the test bundle search path, and fails on real assertion
   failures. It tolerates only the known SwiftPM/VLCKit process teardown signal
   after all assertions have passed.

   Before merging a version-bump pull request, set the Actions repository
   variable `YAWF_HOLD_WEBSITE_DEPLOY=true`. This keeps the currently published
   download page live while the new versioned assets are still in a draft.

3. Tag and push:

   ```sh
   git tag v0.1.0-web
   git push origin v0.1.0-web
   ```

4. Wait for the `Verify clean installs` job. It downloads the completed draft
   assets on fresh GitHub runners, installs both macOS DMGs, the Linux AppImage,
   the Linux desktop deb, and the self-hosted server deb on Ubuntu 22.04 and
   24.04. It boots every bundled or installed server and launches each desktop
   app with an empty profile. When `YAWF_RELEASE_WINDOWS=true`, it also installs
   the Windows MSI and NSIS setup executable and fails unless each installer and
   installed application has a valid Authenticode signature.
5. Review the draft GitHub Release created by `web-release`. Confirm that
   `SHA256SUMS` is present and that GitHub displays provenance for the release
   artifacts.
6. Publish only after all build and clean-install jobs pass. The latest
   published release becomes the OTA target.
7. Delete `YAWF_HOLD_WEBSITE_DEPLOY`, manually dispatch `cloudflare-site.yml`,
   and verify the live version and every visible download link. Do not leave the
   hold variable configured after the release is public.

To repeat installer verification without rebuilding the release:

```sh
gh workflow run clean-install.yml -f tag=vX.Y.Z-web -f include_windows=false
```

Use `include_windows=true` only for a release that actually contains the signed
Windows assets. The accepted trust boundaries and remaining Windows blocker are
recorded in `docs/SECURITY_DECISIONS.md`. macOS, Linux, Android TV, and server
artifacts may ship while the Windows channel remains held.

## Verify a downloaded artifact

Download `SHA256SUMS` from the same release as the installer. Verify from the
directory containing the downloaded files:

```sh
# Linux
sha256sum -c SHA256SUMS --ignore-missing

# macOS, for one file
shasum -a 256 "YAWF.Stream_<version>_aarch64.dmg"

# GitHub build provenance
gh attestation verify "<downloaded-file>" --repo Tgk-30/YAWF-Stream
```

The computed value must match the complete value in `SHA256SUMS`. Also confirm
the GitHub Release provenance and the platform trust signal. macOS packages
must pass Gatekeeper and notarization. The Linux AppImage uses the signed
desktop updater. The Debian desktop and server packages do not have an in-app
updater and must be replaced manually with a newer verified package.

## Download Website

The production website lives in `website-app/`; `website/` is the legacy static
fallback.

It publishes direct versioned links for the available macOS, Linux, and server
artifacts plus a GitHub Releases fallback. A held platform must be presented as
unavailable instead of linking to an asset that was not published.

Cloudflare deployment is handled by `.github/workflows/cloudflare-site.yml`.

For the public `tgk30.com/debridstreamer` path, deploy with:

```sh
CLOUDFLARE_API_TOKEN=... node scripts/deploy_website_cloudflare.mjs
```

The token must be an API token with `Account:Cloudflare Pages:Edit`,
`Account:Workers Scripts:Edit`, `Zone:Zone:Read`, and
`Zone:Workers Routes:Edit`.

The script publishes `website/` to Cloudflare Pages, then installs a Worker
route for `tgk30.com/debridstreamer*` so the existing root site and other paths
remain untouched.

The same Cloudflare deployment is also available as the
`.github/workflows/cloudflare-site.yml` workflow. Add `CLOUDFLARE_API_TOKEN` as
a repository secret before running it. If the token can see multiple accounts or
cannot discover the zone automatically, also add `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_ZONE_ID`.

## Public Support Files

Open-source release support files:

- `CONTRIBUTING.md`
- `SECURITY.md`
- `.github/ISSUE_TEMPLATE/bug_report.yml`
- `.github/ISSUE_TEMPLATE/install_support.yml`

## Server Mode Docker

The root `Dockerfile` builds:

- `web/dist` as the PWA client.
- `server/dist` as the API/runtime.
- A single runtime image that serves both.

`.github/workflows/docker-image.yml` publishes multi-arch images for
`linux/amd64` and `linux/arm64` to GHCR on `main`, version tags, and manual
runs. Compose examples live in `deploy/compose/`, and the Docker user guide is
`docs/DOCKER.md`.

The image name is derived from the repository in lowercase. A desktop release
tag such as `v1.0.0-web` also publishes server image tags `1.0.0` and `1.0`:

```text
ghcr.io/<owner>/<repo>:1.0.0
```

## Desktop Host Mode Packaging

The desktop app exposes Settings -> Install -> Host from this desktop. In a
release build, that card starts a local Server Mode process and opens
`http://127.0.0.1:43110`, which keeps profile/session cookies same-origin for
the hosted PWA. Other devices can use the desktop machine's LAN, Tailscale, or
tunnel address on the same port.

The host card detects a LAN URL when possible, renders a QR code, and provides
copy/share controls. Set `DEBRIDSTREAMER_DESKTOP_SHARE_URL` before launching the
desktop app to prefer a Tailscale or Cloudflare Tunnel URL in the QR/share card.

The release workflow prepares three resources before Tauri bundling:

- `server/dist/index.cjs`: bundled Server Mode entry.
- `web/dist`: hosted PWA assets copied to `resources/server/web-dist`.
- Node runtime binaries under `resources/server/node/<platform>`.

The helper scripts are:

```sh
node scripts/prepare_tauri_server_resources.mjs
node scripts/download_tauri_node_runtime.mjs darwin-arm64 darwin-x64
```

Local development can use the repo fallback after `cd server && npm run build`.
Downloaded releases use the packaged resources.

## Android TV Release

The `vX.Y.Z-web` release workflow also builds
`YAWF.Stream_Android.TV_X.Y.Z.apk` from `android-tv/`. The job requires the
stable Android signing identity in the four `ANDROID_TV_*` repository secrets,
runs unit tests and release lint, verifies the APK signature, and uploads the
APK before checksums and attestations are finalized.

The clean-install workflow downloads the published APK, verifies its signature,
checks that the signing certificate matches `android-tv/SIGNING_CERT_SHA256`,
and confirms that the manifest requires Leanback, does not require a touchscreen,
and exposes the Leanback launcher activity. Never replace the production
keystore: Android accepts updates only when the application ID and signing
identity remain stable.

The production certificate SHA-256 digest is:

```text
6d8ec5466423e10e5c751132bb0f6a6ddf95a8d9f3378772d7809fce616eec1e
```

Verify a downloaded APK with `apksigner verify --print-certs <file.apk>` and
compare the reported signer certificate SHA-256 digest before installing it.
