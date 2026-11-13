# YAWF Stream website

The cinematic marketing site for YAWF Stream.

## Local development

```sh
npm ci
npm run dev
```

The production build is mounted at `/debridstreamer/` while tgk30.com hosts the site. The Vite base path and React router basename must stay aligned.

## Validation

```sh
npm run build
cd ..
node scripts/check_website_app.mjs
node scripts/check_website_path_mount.mjs
```

## Deployment

Use `scripts/deploy_website_cloudflare.mjs` from the repository root. It builds and validates this project before publishing the static output through Cloudflare Pages and the mounted-path Worker.

## Narrow development toolchain exception

The website pins one reviewed npm override only:
`@typescript-eslint/typescript-estree@8.52.0` uses `minimatch` exactly `11.0.1`.
This is a development-only lint dependency edge, not a global override, an
upstream-supported parent upgrade, or a production vulnerability waiver. The
parent declares `^9.0.5`; the substitution deliberately crosses that range to
remove GHSA-g3hv-75wg-m249. Production dependency lock entries remain unchanged.

The actual pinned parent imports the CJS named `minimatch` function and calls it
only as `minimatch(filePath, pattern, { dot: true })`. Primary-source and actual
package comparisons on official Node22.23.4 and Node24.22.2 covered 7,912 matching
cases with no differences in that finite corpus. This is not blanket API or
semantic compatibility: minimatch11 removes makeRe/AST/RegExp internals, changes
some Windows/root/globstar behavior, and changes `a/` against `a/?(x)` from true
to false. Those APIs and project-service glob settings are not used by the
reviewed website config. Node18 is not qualified by the resolved dependency
closure.

`npm run build` runs `check:toolchain` before TypeScript or Vite. Its pure guard
requires the exact single version-scoped override, development-only locked
versions, unchanged reviewed ESLint config, and Node22/24. The actual build probe
checks installed resolution and package versions, hashes the actual parent
consumer, executes its named-function contract through the real CJS module,
and checks resolved ESLint parser options with projectService disabled. Any
parent, override, consumer or config change refuses and requires a new review;
there is no skip or audit-threshold relaxation. Pure guard tests need no website
node_modules: `node --test scripts/check_website_toolchain_override.test.mjs`
from the repository root.

Remove this exception only after a stable parent release declares a patched
minimatch range and its real installed consumer is reassessed. Update/remove the
override and its guard together after fresh full/production audits, lint,
TypeScript and canonical/legacy website build checks on the supported runtimes.
Do not widen the override or enable projectService/allowDefaultProject merely
to make a build pass.
