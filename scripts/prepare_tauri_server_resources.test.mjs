import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareTauriServerResources } from "./prepare_tauri_server_resources.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture(action) {
  const root = mkdtempSync(join(tmpdir(), "yawf-server-resources-"));
  mkdirSync(join(root, "server", "dist"), { recursive: true });
  mkdirSync(join(root, "web", "dist"), { recursive: true });
  writeFileSync(join(root, "web", "dist", "index.html"), "<html></html>");
  try { action(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function server(root, enabled = true) {
  const bytes = Buffer.from("fixed resource fixture executable");
  const binding = enabled ? { schemaVersion: 1, protocol: "yawf-windows-storage-descriptor-v1", sourceSha256: "a".repeat(64), compilerSha256: "b".repeat(64),
    frameworkTarget: ".NETFramework,Version=v4.8", referenceSha256: Object.fromEntries(["mscorlib.dll", "System.dll", "System.Core.dll", "System.Web.Extensions.dll"].map(name => [name, "c".repeat(64)])),
    unsignedHelperSha256: digest(bytes), helperSha256: digest(bytes), helperSize: bytes.length } : null;
  writeFileSync(join(root, "server", "dist", "index.cjs"), `/* YAWF_WINDOWS_STORAGE_BINDING:${JSON.stringify(binding)} */\n`);
  if (binding) {
    const directory = join(root, "server", "dist", "windows-storage-observer"); mkdirSync(directory);
    writeFileSync(join(directory, "StorageDescriptorObserver.exe"), bytes); writeFileSync(join(directory, "binding.json"), JSON.stringify(binding));
  }
  return binding;
}
const destination = root => join(root, "web", "src-tauri", "resources", "server");

test("Windows resources preserve the bound observer beside the server bundle, independent of Node", () => fixture(root => {
  const binding = server(root); prepareTauriServerResources({ root, platform: "win32" });
  const dir = join(destination(root), "windows-storage-observer");
  assert.equal(digest(readFileSync(join(dir, "StorageDescriptorObserver.exe"))), binding.helperSha256);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "binding.json"))), binding);
  assert.equal(existsSync(join(destination(root), "node")), false);
}));

test("resource preparation rejects replacement helper and manifest against the bundle binding before removal", () => fixture(root => {
  const binding = server(root); const dir = join(root, "server", "dist", "windows-storage-observer");
  mkdirSync(destination(root), { recursive: true }); writeFileSync(join(destination(root), "keep"), "previous resource bytes");
  const bytes = Buffer.from("replacement"); writeFileSync(join(dir, "StorageDescriptorObserver.exe"), bytes);
  writeFileSync(join(dir, "binding.json"), JSON.stringify({ ...binding, helperSha256: digest(bytes), helperSize: bytes.length }));
  assert.throws(() => prepareTauriServerResources({ root, platform: "win32" }));
  assert.equal(readFileSync(join(destination(root), "keep"), "utf8"), "previous resource bytes");
}));

test("non-Windows resource preparation works without any generated helper", () => fixture(root => {
  server(root, false); prepareTauriServerResources({ root, platform: "darwin" });
  assert.equal(existsSync(join(destination(root), "index.cjs")), true);
  assert.equal(existsSync(join(destination(root), "windows-storage-observer")), false);
}));

test("Windows resources refuse missing bindings and all unexpected loader sidecars", () => fixture(root => {
  server(root, false); assert.throws(() => prepareTauriServerResources({ root, platform: "win32" }));
  const binding = server(root);
  const directory = join(root, "server", "dist", "windows-storage-observer");
  writeFileSync(join(directory, "StorageDescriptorObserver.exe.config"), "sidecar");
  assert.throws(() => prepareTauriServerResources({ root, platform: "win32" }));
  assert.equal(existsSync(destination(root)), false);
  assert.ok(binding);
}));
