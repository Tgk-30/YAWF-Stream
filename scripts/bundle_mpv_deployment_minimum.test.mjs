import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_SCRIPT = join(
  REPOSITORY_ROOT,
  "web",
  "src-tauri",
  "scripts",
  "bundle-mpv-deps.sh",
);

function writeExecutable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function installFakeTools(bin) {
  writeExecutable(
    join(bin, "otool"),
    `#!/bin/sh
set -eu
printf 'otool|%s\\n' "$*" >> "$TOOL_LOG"
case "$1" in
  -L)
    printf '%s:\\n' "$2"
    ;;
  -l)
    minimum=$(LC_ALL=C sed -n 's/^MINOS=//p' "$2")
    cat <<EOF
Load command 1
      cmd LC_BUILD_VERSION
 platform MACOS
    minos $minimum
      sdk 26.0
EOF
    ;;
  *)
    printf 'unsupported fake otool invocation: %s\\n' "$*" >&2
    exit 64
    ;;
esac
`,
  );

  writeExecutable(
    join(bin, "install_name_tool"),
    `#!/bin/sh
set -eu
printf 'install_name_tool|%s\\n' "$*" >> "$TOOL_LOG"
`,
  );

  writeExecutable(
    join(bin, "codesign"),
    `#!/bin/sh
set -eu
printf 'codesign|%s\\n' "$*" >> "$TOOL_LOG"
`,
  );

  // This fake implements the deployment-minimum rewrite semantics of the
  // removed block. A regression that invokes vtool therefore changes the
  // fixture bytes instead of passing merely because the real tool is absent.
  writeExecutable(
    join(bin, "vtool"),
    `#!/bin/sh
set -eu
printf 'vtool|%s\\n' "$*" >> "$TOOL_LOG"
output=''
input=''
previous=''
for argument in "$@"; do
  if [ "$previous" = '-output' ]; then output="$argument"; fi
  if [ -f "$argument" ]; then input="$argument"; fi
  previous="$argument"
done
[ -n "$input" ] || { echo 'fake vtool did not receive an input file' >&2; exit 65; }
[ -n "$output" ] || output="$input"
temporary="$output.fake-vtool"
LC_ALL=C sed 's/^MINOS=26\\.0$/MINOS=10.13/' "$input" > "$temporary"
mv "$temporary" "$output"
`,
  );
}

test(
  "bundling preserves the source deployment minimum without invoking a header rewrite",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "yawf-mpv-minimum-"));
    const bin = join(root, "bin");
    const output = join(root, "frameworks");
    const input = join(root, "libmpv.2.dylib");
    const toolLog = join(root, "tools.log");
    const original = Buffer.from([
      0xcf, 0xfa, 0xed, 0xfe,
      ...Buffer.from("\nMACHO-FIXTURE\nMINOS=26.0\nPAYLOAD=unchanged\n"),
    ]);

    mkdirSync(bin, { recursive: true });
    installFakeTools(bin);
    writeFileSync(input, original);
    writeFileSync(toolLog, "");

    try {
      const environment = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TOOL_LOG: toolLog,
      };
      const result = spawnSync("/bin/bash", [BUNDLE_SCRIPT, input, output], {
        cwd: REPOSITORY_ROOT,
        env: environment,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const bundled = join(output, "libmpv.2.dylib");
      assert.deepEqual(readFileSync(bundled), original);

      const metadata = spawnSync(join(bin, "otool"), ["-l", bundled], {
        env: environment,
        encoding: "utf8",
      });
      assert.equal(metadata.status, 0, metadata.stderr);
      assert.match(metadata.stdout, /\bminos 26\.0\b/);

      const calls = readFileSync(toolLog, "utf8").trim().split("\n");
      assert.equal(calls.some((call) => call.startsWith("vtool|")), false);
      assert.equal(
        calls.some((call) => call.startsWith("install_name_tool|-id ")),
        true,
      );
      assert.equal(
        calls.some((call) => call.startsWith("codesign|--force --sign - ")),
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
