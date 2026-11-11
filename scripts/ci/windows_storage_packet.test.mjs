import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { admitPacket, createPacket, inspectCheckout, PACKET_LIMITS, packetFailure, packetOverlapsGeneratedTree, validatePacketManifest } from "./windows_storage_packet.mjs";

const source = "a".repeat(40), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const trees = ["server/.build/windows-storage-observer", "server/dist", "web/dist"];
const privatePath = "server/src/privateStorage.ts", csPath = "server/native/windows/StorageDescriptorObserver.cs";
function put(root, path, value) { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); }
function checkout(repo, pin) { assert.equal(pin, source); return { privateStorageSha256: hash(readFileSync(join(repo, privatePath))), observerSourceSha256: hash(readFileSync(join(repo, csPath))) }; }
function fixture(action) {
  const root = mkdtempSync(join(tmpdir(), "yawf-windows-packet-")); const repo = join(root, "producer"), consumer = join(root, "consumer"), packet = join(root, "packet");
  for (const target of [repo, consumer]) { put(target, privatePath, "fixed private storage source"); put(target, csPath, "fixed observer source"); }
  const bytes = Buffer.from("tiny non-executable fixture"); const b = { schemaVersion: 1, protocol: "yawf-windows-storage-descriptor-v1",
    sourceSha256: checkout(repo, source).observerSourceSha256, compilerSha256: "b".repeat(64), frameworkTarget: ".NETFramework,Version=v4.8",
    referenceSha256: Object.fromEntries(["mscorlib.dll", "System.dll", "System.Core.dll", "System.Web.Extensions.dll"].map(name => [name, "c".repeat(64)])),
    unsignedHelperSha256: hash(bytes), helperSha256: hash(bytes), helperSize: bytes.length };
  put(repo, trees[0] + "/compile.json", JSON.stringify(b)); put(repo, trees[0] + "/unsigned/StorageDescriptorObserver.exe", bytes);
  for (const target of [trees[0] + "/runtime", "server/dist/windows-storage-observer"]) {
    put(repo, target + "/binding.json", JSON.stringify(b)); put(repo, target + "/StorageDescriptorObserver.exe", bytes);
  }
  put(repo, "server/dist/index.cjs", `/* YAWF_WINDOWS_STORAGE_BINDING:${JSON.stringify(b)} */\nthrow Error("Packet JavaScript must never execute");\n`);
  put(repo, "web/dist/index.html", "<html>tiny public fixture</html>");
  try { action({ root, repo, consumer, packet, binding: b }); } finally { rmSync(root, { recursive: true, force: true }); }
}
function create(f) { return createPacket({ repo: f.repo, packet: f.packet, source, checkout }); }
function admit(f, sha256, extra = {}) { return admitPacket({ repo: f.consumer, packet: f.packet, source, sha256, checkout, ...extra }); }
function metadata(f) { return JSON.parse(readFileSync(join(f.packet, "packet.json"))); }
function edit(f, action) { const m = metadata(f); action(m); const bytes = Buffer.from(JSON.stringify(m)); writeFileSync(join(f.packet, "packet.json"), bytes); return hash(bytes); }
function untouched(f) { for (const tree of trees) assert.equal(existsSync(join(f.consumer, tree)), false); }

test("create and admit copy only the three hash-bound trees without executing payload code", () => fixture(f => {
  const receipt = create(f); const m = metadata(f);
  assert.equal(m.sourceRevision, source); assert.equal(receipt.files, 8); assert.equal(m.files.some(file => file.path === "packet.json"), false);
  assert.equal(m.privateStorageSha256, checkout(f.repo, source).privateStorageSha256);
  assert.ok(!JSON.stringify(m).includes(f.root));
  assert.deepEqual(m.files.map(file => file.path), m.files.map(file => file.path).sort());
  assert.deepEqual(admit(f, receipt.packetSha256), receipt);
  for (const file of m.files) assert.equal(hash(readFileSync(join(f.consumer, file.path))), file.sha256);
}));

test("checkout admission binds exact HEAD, clean source and file bytes using read-only Git commands", () => fixture(f => {
  const calls = []; const run = (command, args, options) => {
    calls.push(args); assert.equal(command, "git"); assert.ok(args.includes("--no-replace-objects")); assert.ok(args.includes("core.fsmonitor=false"));
    assert.equal(options.env.GIT_CONFIG_NOSYSTEM, "1"); assert.equal(options.timeout, 10_000);
    if (args.includes("--show-toplevel")) return Buffer.from(f.repo + "\n");
    if (args.includes("HEAD") && args.includes("--verify")) return Buffer.from(source + "\n");
    if (args.includes("show")) return readFileSync(join(f.repo, args.at(-1).slice(41)));
    return Buffer.alloc(0);
  };
  assert.deepEqual(inspectCheckout(f.repo, source, { run }), checkout(f.repo, source));
  assert.equal(calls.length, 5); assert.ok(calls.some(args => args.includes("--no-ext-diff")));
  assert.throws(() => inspectCheckout(f.repo, "d".repeat(40), { run }));
  assert.throws(() => inspectCheckout(f.repo, source, { run(...args) { if (args[1].includes("show")) return Buffer.from("different source"); return run(...args); } }));
}));

test("operator digest and source pins are checked before checkout or destination creation", () => fixture(f => {
  const receipt = create(f); let calls = 0; const denied = () => { calls++; throw Error("must not inspect checkout"); };
  assert.throws(() => admit(f, "0".repeat(64), { checkout: denied }));
  assert.throws(() => admit(f, receipt.packetSha256, { source: "d".repeat(40), checkout: denied }));
  assert.equal(calls, 0); untouched(f);
}));

test("schema, traversal, prefix, canonical order and case-colliding closure are refused", () => fixture(f => {
  create(f); const original = readFileSync(join(f.packet, "packet.json"));
  for (const mutate of [m => { m.extra = true; }, m => { delete m.sourceRevision; }, m => { m.files[0].path = "../escape"; },
    m => { m.files[0].path = "server/elsewhere/file"; }, m => { m.files.reverse(); },
    m => { m.files.push({ ...m.files.at(-1), path: "web/dist/INDEX.html" }); m.files.sort((a, b) => a.path < b.path ? -1 : 1); },
    m => { m.files.push({ ...m.files.at(-1), path: "web/dist/Assets/a.js" }, { ...m.files.at(-1), path: "web/dist/assets/b.js" }); m.files.sort((a, b) => a.path < b.path ? -1 : 1); }]) {
    writeFileSync(join(f.packet, "packet.json"), original); const sha = edit(f, mutate); assert.throws(() => admit(f, sha)); untouched(f);
  }
}));

test("every payload byte, size and extra file is checked before any target is copied", () => fixture(f => {
  const receipt = create(f), target = join(f.packet, "web/dist/index.html"), original = readFileSync(target);
  writeFileSync(target, Buffer.alloc(original.length, 65)); assert.throws(() => admit(f, receipt.packetSha256)); untouched(f);
  writeFileSync(target, "short"); assert.throws(() => admit(f, receipt.packetSha256)); untouched(f);
  writeFileSync(target, original); put(f.packet, "web/dist/extra.js", "extra"); assert.throws(() => admit(f, receipt.packetSha256)); untouched(f);
}));

test("checkout source mismatches and loader sidecars cannot be authorized by a new packet digest", () => fixture(f => {
  create(f); put(f.consumer, csPath, "different source"); const original = readFileSync(join(f.packet, "packet.json"));
  assert.throws(() => admit(f, hash(original))); untouched(f); put(f.consumer, csPath, "fixed observer source");
  put(f.packet, trees[0] + "/runtime/StorageDescriptorObserver.exe.config", "loader configuration");
  const sha = edit(f, m => { m.files.push({ path: trees[0] + "/runtime/StorageDescriptorObserver.exe.config", bytes: 20, sha256: hash("loader configuration") }); m.files.sort((a, b) => a.path < b.path ? -1 : 1); });
  assert.throws(() => admit(f, sha)); untouched(f);
}));

test("symlink or junction indirection is refused even when referenced bytes match", () => fixture(f => {
  const receipt = create(f), target = join(f.packet, "web/dist/index.html"), foreign = join(f.root, "foreign.html");
  writeFileSync(foreign, readFileSync(target)); rmSync(target);
  symlinkSync(foreign, target); assert.throws(() => admit(f, receipt.packetSha256)); untouched(f);
}));

test("existing packet roots and generated destinations are never replaced", () => fixture(f => {
  const receipt = create(f); assert.throws(() => create(f));
  put(f.consumer, "server/dist/keep", "existing generated bytes"); assert.throws(() => admit(f, receipt.packetSha256));
  assert.equal(readFileSync(join(f.consumer, "server/dist/keep"), "utf8"), "existing generated bytes");
  assert.equal(existsSync(join(f.consumer, trees[0])), false);
}));

test("Windows case-variant generated-tree overlap is refused before checkout or any write", () => fixture(f => {
  for (const tree of ["SERVER\\DIST", "SERVER\\.BUILD\\WINDOWS-STORAGE-OBSERVER", "WEB\\DIST"]) {
    assert.equal(packetOverlapsGeneratedTree("C:\\qa\\repo", `c:\\QA\\REPO\\${tree}`, "win32"), true);
    assert.equal(packetOverlapsGeneratedTree("C:\\qa\\repo", `C:\\qa\\repo\\${tree}\\new-packet`, "win32"), true);
  }
  assert.equal(packetOverlapsGeneratedTree("C:\\qa\\repo", "C:\\qa\\repo\\SERVER\\DIST-sibling\\new-packet", "win32"), false);
  assert.equal(packetOverlapsGeneratedTree("/qa/repo", "/qa/repo/SERVER/DIST/new-packet", "posix"), false);
  assert.equal(packetOverlapsGeneratedTree("/qa/repo", "/qa/repo/server/dist/new-packet", "posix"), true);
  create(f); const before = metadata(f).files;
  const packet = join(f.repo, "SERVER", "DIST", "new-packet"); let calls = 0;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try { assert.throws(() => createPacket({ repo: f.repo, packet, source, checkout(...args) { calls++; return checkout(...args); } })); }
  finally { Object.defineProperty(process, "platform", platform); }
  assert.equal(calls, 0); assert.equal(existsSync(packet), false);
  for (const file of before) assert.equal(hash(readFileSync(join(f.repo, file.path))), file.sha256);
}));

test("manifest, file count, per-file and aggregate bounds reject without large fixture allocation", () => fixture(f => {
  const receipt = create(f), base = metadata(f);
  const invalid = [m => { m.files = Array.from({ length: PACKET_LIMITS.files + 1 }, (_, i) => ({ path: `web/dist/f${String(i).padStart(3, "0")}.js`, bytes: 1, sha256: "b".repeat(64) })); },
    m => { m.files[0].bytes = PACKET_LIMITS.fileBytes + 1; },
    m => { for (const file of m.files) file.bytes = PACKET_LIMITS.fileBytes; }];
  for (const mutate of invalid) { const m = structuredClone(base); mutate(m); assert.throws(() => validatePacketManifest(m, source)); }
  writeFileSync(join(f.packet, "packet.json"), " ".repeat(PACKET_LIMITS.manifestBytes + 1));
  assert.throws(() => admit(f, receipt.packetSha256)); untouched(f);
}));

test("checkout failures expose fixed Git stages without retaining raw process data", () => fixture(f => {
  for (const [stage, command] of [["checkout-git-head", "--verify"], ["checkout-git-root", "--show-toplevel"],
    ["checkout-git-diff", "diff"], ["checkout-source", "show"]]) {
    let failure;
    try { inspectCheckout(f.repo, source, { run(_file, args) {
      if (args.includes(command)) throw Object.assign(Error("raw-private-stderr /private/fixture source-body"), { stderr: "raw-private-stderr", stdout: "source-body", path: "/private/fixture" });
      if (args.includes("--verify")) return Buffer.from(source + "\n");
      if (args.includes("--show-toplevel")) return Buffer.from(f.repo + "\n");
      return Buffer.alloc(0);
    } }); } catch (error) { failure = error; }
    assert.deepEqual(packetFailure(failure), { ok: false, error: "WINDOWS_STORAGE_PACKET_FAILED", stage, reason: "operation-failed" });
    for (const key of ["cause", "stdout", "stderr", "path"]) assert.equal(Object.hasOwn(failure, key), false);
    assert.doesNotMatch(JSON.stringify(packetFailure(failure)), /raw-private|source-body|\/private/);
  }
}));

test("create failure stages preserve refusals and expose no offending paths or source content", () => fixture(f => {
  function refused(action, stage, reason) {
    let failure; try { action(); } catch (error) { failure = error; }
    assert.deepEqual(packetFailure(failure), { ok: false, error: "WINDOWS_STORAGE_PACKET_FAILED", stage, reason });
    assert.equal(existsSync(f.packet), false);
  }
  refused(() => createPacket({ repo: f.repo, packet: join(f.repo, "server/dist/forbidden"), source, checkout }), "path", "guard-rejected");
  refused(() => createPacket({ repo: f.repo, packet: f.packet, source, checkout() { throw Error("raw-private-checkout"); } }), "checkout", "operation-failed");
  const binding = join(f.repo, trees[0], "runtime/binding.json"), original = readFileSync(binding);
  writeFileSync(binding, "invalid"); refused(() => create(f), "prepared-binding", "operation-failed"); writeFileSync(binding, original);
  const invalid = join(f.repo, "web/dist/bad private name.js"); writeFileSync(invalid, "not retained");
  refused(() => create(f), "collect", "entry-path"); rmSync(invalid);
  refused(() => createPacket({ repo: f.repo, packet: f.packet, source, checkout(...args) { return { ...checkout(...args), extra: true }; } }), "manifest", "guard-rejected");
  refused(() => createPacket({ repo: f.repo, packet: join(f.root, "missing-parent/new-packet"), source, checkout }), "write", "operation-failed");
  const receipt = create(f); let failure;
  try { admit(f, "0".repeat(64)); } catch (error) { failure = error; }
  assert.deepEqual(packetFailure(failure), { ok: false, error: "WINDOWS_STORAGE_PACKET_FAILED", stage: "packet-digest", reason: "digest-mismatch" });
  assert.match(receipt.packetSha256, /^[0-9a-f]{64}$/); untouched(f);
}));

test("CLI failure emits only the exact fixed classification schema", () => {
  assert.deepEqual(packetFailure(Object.assign(Error("private raw message"), { stage: "private path", stderr: "private raw stderr" })),
    { ok: false, error: "WINDOWS_STORAGE_PACKET_FAILED", stage: "arguments", reason: "operation-failed" });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./windows_storage_packet.mjs", import.meta.url)), "invalid-mode"],
    { encoding: "utf8", timeout: 5000, maxBuffer: 16_000, env: { PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir() } });
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.match(result.stderr.trim(), /^\{"ok":false,"error":"WINDOWS_STORAGE_PACKET_FAILED",/);
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, error: "WINDOWS_STORAGE_PACKET_FAILED", stage: "arguments", reason: "guard-rejected" });
});
