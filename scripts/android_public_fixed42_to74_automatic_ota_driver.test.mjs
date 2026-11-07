import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
const java = fs.readFileSync(new URL("./android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeOtaFlowTest.java", import.meta.url), "utf8");
function method(name) {
  const match = new RegExp(`\\bprivate\\s+[^\\n]+\\s+${name}\\(`).exec(java);
  assert.ok(match, name);
  let depth = 0;
  for (let i = java.indexOf("{", match.index); i < java.length; i++) {
    if (java[i] === "{") depth++;
    if (java[i] === "}" && --depth === 0) return java.slice(match.index, i + 1);
  }
  assert.fail(name);
}

test("42-to74 reuses unchanged actual fixed42 cancellation, marker and persistence helpers", () => {
  const frozen = {
    "enableAndCancelInitialFixed42CheckNoIdle": "d3656366a3f9ea8cd0a2cccefad86edd03cd589a223af1559d8a4b58cf941bef",
    "assertNoInitialEnableResultVisibleAtCurrentIdlePolicy": "4be3b9c425a05f856ce373d46e9bdd554cc86c6490c00510adcfc790ba97665d",
    "seedFixed42MeaningfulLocalState": "ad2dbd5d88ec17030b81c9324b719bd8019c90a6f139817d7a055b0a2a7ffc51",
    "assertFixed42MeaningfulLocalState": "0b1cc849520cd6afb17c9430e397c1eae0d25130f0a825a20fccfc72c89f4fa0",
    "dismissVisibleRecentTaskAndRelaunchThroughLauncher": "ed7bdc0672444b87799bb3a7a9195173bdbea63d90b386173d8cf6f9214eef5b",
    "launchFixed42ProductFromVisibleLauncher": "7c8494138d3ec31ad2fbdb99514dd17413f4128c9616457a0fd83fb40ef7e48b",
    "observeFixed42LauncherReadiness": "e828b36df7671d664d73ac89c4ea9ecb509266e6d53eb7cf475e770d863fd8d1",
    "cancelInitialManualCheckBeforeResult": "cf1ba9627d2785bf9d18fe4642af3b5344053d45f13c0dcbed9dbf29bee91a93"
};
  for (const [name, expected] of Object.entries(frozen)) {
    assert.equal(createHash("sha256").update(method(name)).digest("hex"), expected, name);
  }
});
test("exact74 admission dispatches before immutable legacy admission and uses visible launcher", () => {
  const admission = method("admitAutomaticTargetIdentity");
  assert.ok(admission.indexOf("admitFixed42To74TargetIdentity(arguments)") < admission.indexOf("boolean fixed42To61"));
  for (const name of ["launchProductFromVisibleLauncher", "returnToProductThroughVisibleLauncher"]) {
    const code = method(name);
    assert.match(code, /if \(isFixed42To74AutomaticMode\(\)\) \{[\s\S]*?launchVisibleAppFromLauncher\("YAWF Stream", OtaFlowPolicy.PRODUCT_PACKAGE, phase\)/);
  }
  assert.match(method("runAutomaticFlow"), /if \(isFixed42AutomaticMode\(\)\) \{\s*enableAndCancelInitialFixed42CheckNoIdle\(\)/);
  assert.match(java, /postInstallExactUpToDate74Observed/);
});
test("actual Java admission and no-idle cancellation reject adversarial states and each mutant", () => {
  const checker = fileURLToPath(new URL("./runtime_ota_fixed42_to74.test.py", import.meta.url));
  const result = spawnSync("python3", [checker], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.actualAdmissionCases, 24);
  assert.equal(report.actualCancellationCases, 12);
  assert.equal(report.individualMutants.length, 7);
  report.individualMutants.forEach((row) => assert.equal(row.killed, true));
});
test("new profile retains executable fresh visible launcher admission", () => {
  const checker = fileURLToPath(new URL("./runtime_ota_visible_launcher.test.py", import.meta.url));
  const result = spawnSync("python3", [checker], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
