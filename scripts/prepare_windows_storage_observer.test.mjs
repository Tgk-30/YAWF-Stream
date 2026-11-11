import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bindWindowsStorageObserver, bundledObserverBinding, compileWindowsStorageObserver, copyObserverDirectory,
  preparedObserver, REFERENCE_NAMES, STORAGE_OBSERVER_COMPILER, STORAGE_OBSERVER_EXE, STORAGE_OBSERVER_REFERENCES,
  validateObserverBinding, verifyObserverDirectory } from "./prepare_windows_storage_observer.mjs";
import { buildServer } from "../server/build.mjs";

const source = readFileSync(new URL("../server/native/windows/StorageDescriptorObserver.cs", import.meta.url));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

test("privacy predicate and two-call native Read semantics remain byte-identical", () => {
  const transport = readFileSync(new URL("../server/src/privateStorage.ts", import.meta.url), "utf8");
  const start = transport.indexOf("export function windowsStorageDescriptorIsPrivate(");
  const end = transport.indexOf("\n}\n", start) + 2;
  assert.equal(digest(transport.slice(start, end)), "c7d1240570f0cdcba8d106fd963e18a0f072be6a4ba64954ac242914cfba430d");
  const previous = readFileSync(new URL("../server/test/fixtures/windowsStorageOriginalObserver.ps1", import.meta.url), "utf8");
  const method = text => text.slice(text.indexOf("  public static byte[] Read(string path) {"), text.indexOf("\n  }", text.indexOf("  public static byte[] Read(string path) {")) + 4);
  assert.equal(method(source.toString()), method(previous));
  assert.ok(source.includes(Buffer.from('internal const string Protocol = "yawf-windows-storage-descriptor-v1";')));
  assert.doesNotMatch(transport, /powershell|Add-Type|EncodedCommand/);
});
function fixture(action) {
  const root = mkdtempSync(join(tmpdir(), "yawf-observer-source-"));
  const path = join(root, "server", "native", "windows", "StorageDescriptorObserver.cs");
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source);
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    const result = action(root);
    if (result && typeof result.then === "function") return result.finally(cleanup);
    cleanup(); return result;
  } catch (error) { cleanup(); throw error; }
}
function compile(root, inspect = () => {}) {
  return compileWindowsStorageObserver({ root, platform: "win32",
    read(path) { assert.ok(path === STORAGE_OBSERVER_COMPILER || REFERENCE_NAMES.some(name => path === join(STORAGE_OBSERVER_REFERENCES, name))); return Buffer.from(path === STORAGE_OBSERVER_COMPILER ? "compiler" : "reference"); },
    run(file, args, options) {
      inspect(file, args, options);
      writeFileSync(args.find(x => x.startsWith("/out:")).slice(5), "unsigned fixture executable");
    } });
}
const runtime = root => join(root, "server", ".build", "windows-storage-observer", "runtime");
const unsigned = root => join(root, "server", ".build", "windows-storage-observer", "unsigned", STORAGE_OBSERVER_EXE);
function prepared(root) { const b = compile(root); bindWindowsStorageObserver(b.helperSha256, { root }); return b; }

test("compile uses only the fixed in-box compiler and explicit Framework4.8 references without debug output", () => fixture(root => {
  const b = compile(root, (file, args, options) => {
    assert.equal(file, "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe");
    for (const flag of ["/noconfig", "/nostdlib+", "/debug-", "/optimize+", "/platform:anycpu"]) assert.ok(args.includes(flag));
    assert.deepEqual(args.filter(x => x.startsWith("/reference:")), REFERENCE_NAMES.map(name => `/reference:${join(STORAGE_OBSERVER_REFERENCES, name)}`));
    assert.equal(options.timeout, 60_000); assert.equal(options.maxBuffer, 256_000);
    assert.ok(!args.some(x => /pdb|debug\+|fullpaths/i.test(x)));
  });
  assert.equal(b.sourceSha256, digest(source)); assert.equal(b.compilerSha256, digest("compiler"));
  assert.equal(b.frameworkTarget, ".NETFramework,Version=v4.8");
  assert.ok(!JSON.stringify(b).includes(root));
}));

test("compile refuses non-Windows, missing prerequisites and existing producer bytes", () => fixture(root => {
  let reads = 0;
  assert.throws(() => compileWindowsStorageObserver({ root, platform: "darwin", read() { reads++; return Buffer.from("fixture"); } }));
  assert.equal(reads, 0);
  assert.throws(() => compileWindowsStorageObserver({ root, platform: "win32", read() { throw Error("missing"); } }));
  const foreign = join(root, "not-build"); mkdirSync(foreign);
  const link = join(root, "server", ".build"); symlinkSync(foreign, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => compile(root)); assert.equal(existsSync(join(foreign, "windows-storage-observer")), false); rmSync(link);
  compile(root); const before = readFileSync(unsigned(root));
  assert.throws(() => compile(root)); assert.deepEqual(readFileSync(unsigned(root)), before);
}));

test("compile failure removes only its new incomplete output and never records compiler diagnostics", () => fixture(root => {
  assert.throws(() => compileWindowsStorageObserver({ root, platform: "win32", read() { return Buffer.from("fixture"); },
    run() { throw Error("private compiler output"); } }), error => !String(error).includes("private compiler output"));
  assert.equal(existsSync(join(root, "server", ".build", "windows-storage-observer")), false);
  assert.deepEqual(readFileSync(join(root, "server", "native", "windows", "StorageDescriptorObserver.cs")), source);
}));

test("bind requires the operator hash of final bytes and preserves post-sign bytes across builds", async () => {
  await fixture(async root => {
    const original = compile(root); writeFileSync(unsigned(root), "post-sign fixture executable");
    assert.throws(() => bindWindowsStorageObserver(original.helperSha256, { root }));
    const finalHash = digest("post-sign fixture executable"); const b = bindWindowsStorageObserver(finalHash, { root });
    assert.equal(b.helperSha256, finalHash); assert.equal(b.unsignedHelperSha256, original.helperSha256);
    assert.throws(() => bindWindowsStorageObserver(finalHash, { root }));
    let options;
    await buildServer({ root, platform: "win32", bundle(value) { options = value; writeFileSync(value.outfile, value.banner.js + "\n"); } });
    assert.equal(JSON.parse(options.define.__YAWF_WINDOWS_STORAGE_BINDING__).helperSha256, finalHash);
    assert.equal(bundledObserverBinding(join(root, "server", "dist", "index.cjs")).helperSha256, finalHash);
    assert.equal(digest(readFileSync(join(root, "server", "dist", "windows-storage-observer", STORAGE_OBSERVER_EXE))), finalHash);
    assert.equal(digest(readFileSync(unsigned(root))), finalHash);
  });
});

test("bind and preparation reject source drift, binary tampering and unknown provenance fields", () => fixture(root => {
  const b = compile(root); const path = join(root, "server", "native", "windows", "StorageDescriptorObserver.cs");
  writeFileSync(path, Buffer.concat([source, Buffer.from("\n// drift\n")]));
  assert.throws(() => bindWindowsStorageObserver(b.helperSha256, { root })); writeFileSync(path, source);
  bindWindowsStorageObserver(b.helperSha256, { root });
  writeFileSync(join(runtime(root), STORAGE_OBSERVER_EXE), "tampered"); assert.throws(() => preparedObserver(root));
  assert.throws(() => validateObserverBinding({ ...b, extra: true }));
  assert.throws(() => validateObserverBinding({ ...b, protocol: "other" }));
  assert.throws(() => validateObserverBinding({ ...b, referenceSha256: {} }));
}));

test("verification rejects loader sidecars and redirected helper directories", () => fixture(root => {
  const b = prepared(root);
  for (const name of ["StorageDescriptorObserver.exe.config", "System.Web.Extensions.dll", "StorageDescriptorObserver.exe.local"]) {
    const path = join(runtime(root), name); writeFileSync(path, "loader sidecar");
    assert.throws(() => verifyObserverDirectory(runtime(root), b)); rmSync(path);
  }
  const link = join(root, "redirected"); symlinkSync(runtime(root), link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => verifyObserverDirectory(link, b));
}));

test("copy admits exact bytes only and refuses overwrite or mutable manifest authorization", () => fixture(root => {
  const b = prepared(root); const dest = join(root, "copied"); copyObserverDirectory(runtime(root), dest, b);
  assert.throws(() => copyObserverDirectory(runtime(root), dest, b));
  const changed = { ...b, helperSha256: digest("replacement"), helperSize: 11 };
  writeFileSync(join(runtime(root), STORAGE_OBSERVER_EXE), "replacement");
  writeFileSync(join(runtime(root), "binding.json"), JSON.stringify(changed));
  assert.throws(() => verifyObserverDirectory(runtime(root), b));
}));

test("generic builds need no generated helper while Windows builds fail before deleting prior output", async () => {
  await fixture(async root => {
    const dist = join(root, "server", "dist"); mkdirSync(dist); writeFileSync(join(dist, "keep"), "old output");
    await assert.rejects(buildServer({ root, platform: "win32", bundle() { assert.fail("must not bundle"); } }));
    assert.equal(readFileSync(join(dist, "keep"), "utf8"), "old output");
    await buildServer({ root, platform: "darwin", bundle(options) {
      assert.equal(options.define.__YAWF_WINDOWS_STORAGE_BINDING__, "null");
      assert.equal(options.banner.js, "/* YAWF_WINDOWS_STORAGE_BINDING:null */");
      writeFileSync(options.outfile, options.banner.js + "\n");
    } });
    assert.equal(bundledObserverBinding(join(dist, "index.cjs")), null);
    assert.equal(existsSync(join(dist, "windows-storage-observer")), false);
  });
});
