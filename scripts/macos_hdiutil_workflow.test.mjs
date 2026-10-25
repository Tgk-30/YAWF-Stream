import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/web-release.yml", import.meta.url), "utf8");

function failures(subject) {
  const selection = subject.indexOf("      - name: Select bounded macOS disk-image creator\n");
  const build = subject.indexOf("      - name: Build, bundle, sign & release\n");
  const preservation = subject.indexOf("      - name: Preserve macOS disk-image creator evidence\n");
  const minimum = subject.indexOf("      - name: Verify macOS bundle deployment minima\n");
  const prepare = subject.slice(selection, build);
  const preserve = subject.slice(preservation, minimum);
  return [
    selection >= 0 && selection < build,
    /if: matrix\.os == 'macos'/.test(prepare),
    prepare.includes('install -m 755 scripts/macos_hdiutil_retry.sh "$shim_bin/hdiutil"'),
    prepare.includes('test "$(command -v hdiutil)" = "$shim_bin/hdiutil"'),
    prepare.includes('test -x /usr/bin/hdiutil'),
    prepare.includes('shasum -a 256 "$shim_bin/hdiutil"'),
    prepare.includes('node web/node_modules/@tauri-apps/cli/tauri.js --version'),
    prepare.includes('echo "$shim_bin" >> "$GITHUB_PATH"'),
    prepare.includes('HDIUTIL_RETRY_RECEIPT=$RUNNER_TEMP/yawf-hdiutil-'),
    build < preservation && preservation < minimum,
    /if: always\(\) && matrix\.os == 'macos'/.test(preserve),
    preserve.includes("${{ env.HDIUTIL_RETRY_RECEIPT }}"),
    preserve.includes("${{ env.HDIUTIL_RETRY_EVIDENCE_DIR }}/"),
    !/retryAttempts:|\b(?:kill|killall|pkill)\b/.test(prepare),
  ].flatMap((passed, index) => passed ? [] : [index]);
}

test("release selects and records the confined macOS shim before packaging", () => {
  assert.deepEqual(failures(workflow), []);
});

test("selection, isolation and always-preserved evidence cannot be silently removed", () => {
  const mutants = [
    workflow.replace("Select bounded macOS disk-image creator", "Omitted disk-image creator"),
    workflow.replace("if: matrix.os == 'macos'\n        shell: bash\n        run: |\n          set -euo pipefail\n          shim_bin=", "if: always()\n        shell: bash\n        run: |\n          set -euo pipefail\n          shim_bin="),
    workflow.replace('test "$(command -v hdiutil)" = "$shim_bin/hdiutil"', ":"),
    workflow.replace("HDIUTIL_RETRY_RECEIPT=$RUNNER_TEMP/yawf-hdiutil-", "HDIUTIL_RETRY_RECEIPT=$evidence_dir/yawf-hdiutil-"),
    workflow.replace("if: always() && matrix.os == 'macos'", "if: success() && matrix.os == 'macos'"),
    workflow.replace("            ${{ env.HDIUTIL_RETRY_RECEIPT }}\n", ""),
  ];
  for (const [index, mutant] of mutants.entries()) {
    assert.notEqual(mutant, workflow, `mutation ${index} must bind`);
    assert.notDeepEqual(failures(mutant), [], `mutation ${index} must be rejected`);
  }
});
