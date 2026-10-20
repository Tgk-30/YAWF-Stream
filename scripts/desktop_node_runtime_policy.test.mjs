import assert from "node:assert/strict";
import test from "node:test";
import { desktopNodeRuntimeVersion } from "./desktop_node_runtime_policy.mjs";

test("both Mac architectures retain the verified Node22 bridge runtime", () => {
  for (const platform of ["darwin-arm64", "darwin-x64"]) assert.equal(desktopNodeRuntimeVersion(platform), "22.23.3");
});
test("non-Mac packages retain Node24", () => {
  for (const platform of ["linux-x64", "linux-arm64", "win-x64", "win-arm64"]) assert.equal(desktopNodeRuntimeVersion(platform), "24.17.0");
});
test("explicit runtime override is validated", () => {
  assert.equal(desktopNodeRuntimeVersion("darwin-arm64", "v22.23.3"), "22.23.3");
  assert.throws(() => desktopNodeRuntimeVersion("darwin-arm64", "22;echo unsafe"), /semver/);
  assert.throws(() => desktopNodeRuntimeVersion("darwin-arm64", ""), /semver/);
});
