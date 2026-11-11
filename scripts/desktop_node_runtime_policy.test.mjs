import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_NODE_RUNTIME_VERSION, MACOS_NODE_RUNTIME_VERSION, desktopNodeRuntimeVersion } from "./desktop_node_runtime_policy.mjs";

test("both Mac architectures retain the verified Node22 bridge runtime", () => {
  assert.equal(MACOS_NODE_RUNTIME_VERSION, "22.23.4");
  for (const platform of ["darwin-arm64", "darwin-x64"]) assert.equal(desktopNodeRuntimeVersion(platform), "22.23.4");
});
test("non-Mac packages retain Node24", () => {
  assert.equal(DEFAULT_NODE_RUNTIME_VERSION, "24.22.2");
  for (const platform of ["linux-x64", "linux-arm64", "win-x64", "win-arm64"]) assert.equal(desktopNodeRuntimeVersion(platform), "24.22.2");
});
test("explicit runtime override is validated", () => {
  for (const override of [undefined, null]) {
    assert.equal(desktopNodeRuntimeVersion("darwin-arm64", override), "22.23.4");
    assert.equal(desktopNodeRuntimeVersion("linux-x64", override), "24.22.2");
  }
  for (const platform of ["darwin-arm64", "linux-x64", "win-x64"]) {
    assert.equal(desktopNodeRuntimeVersion(platform, "v22.23.4"), "22.23.4");
    assert.equal(desktopNodeRuntimeVersion(platform, "24.22.2"), "24.22.2");
    for (const bad of ["22;echo unsafe", "", "latest", "22.23", "V22.23.4", "22.23.4-rc.1", " 22.23.4"])
      assert.throws(() => desktopNodeRuntimeVersion(platform, bad), /semver/);
  }
});
