import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const scriptPath = path.resolve('scripts/prepare_android_tauri_api_fixture.py');
const common = String.raw`
import dataclasses, hashlib, importlib.util, io, json, os, pathlib, sys, tarfile, tempfile, types, zipfile
script = pathlib.Path(${JSON.stringify(scriptPath)})
spec = importlib.util.spec_from_file_location("api_fixture_helper", script)
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)
def sha(data): return hashlib.sha256(data).hexdigest()
def fixture():
    base = pathlib.Path(tempfile.mkdtemp(prefix="tauri-fixture-unit-", dir=os.environ["TMPDIR"]))
    source = base / "tauri-2.12.4"
    contents = {
      "Cargo.toml": b'[package]\nname = "tauri"\nversion = "2.12.4"\n',
      "mobile/android/build.gradle.kts": b"plugins { }\n",
      "mobile/android/src/main/java/app/tauri/plugin/Plugin.kt": b"package app.tauri.plugin\n",
      "mobile/android/src/main/java/app/tauri/plugin/PluginManager.kt": b"package app.tauri.plugin\n",
      "mobile/android/src/main/java/app/tauri/plugin/PluginHandle.kt": b"package app.tauri.plugin\n",
    }
    for rel, data in contents.items():
      target = source / rel
      target.parent.mkdir(parents=True, exist_ok=True)
      target.write_bytes(data)
    archive = base / "tauri-2.12.4.crate"
    with tarfile.open(archive, "w:gz") as tf:
      for rel, data in contents.items():
        info = tarfile.TarInfo("tauri-2.12.4/" + rel)
        info.size = len(data)
        tf.addfile(info, io.BytesIO(data))
    jar = base / "classes.jar"
    with zipfile.ZipFile(jar, "w", compression=zipfile.ZIP_DEFLATED) as zf:
      # Synthetic ZIP contents exercise validation only; this is never a CLI input.
      for name in mod.REQUIRED_API_CLASSES: zf.writestr(name, b"synthetic-unit-fixture-not-bytecode")
      zf.writestr("META-INF/test.kotlin_module", b"fixture")
    lock = base / "Cargo.lock"
    checksum = sha(archive.read_bytes())
    lock.write_text('version = 4\n\n[[package]]\nname = "tauri"\nversion = "2.12.4"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "' + checksum + '"\n', encoding="utf-8")
    output = base / "out"
    output.mkdir()
    policy = mod.Policy("tauri", "2.12.4", checksum,
      {rel: sha(data) for rel, data in contents.items()}, tuple(mod.REQUIRED_API_CLASSES))
    args = types.SimpleNamespace(cargo_lock=lock, crate_archive=archive, api_source=source,
      classes_jar=jar, output=output, build_environment="unit-fixture")
    return types.SimpleNamespace(base=base, source=source, contents=contents, archive=archive,
      jar=jar, lock=lock, output=output, policy=policy, args=args)
def expect_error(call, code):
    try: call()
    except mod.FixtureError as error:
      assert str(error) == code, (str(error), code)
      return
    raise AssertionError("expected fixed refusal " + code)
`;

async function withPythonFixture(assertions) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'api-fixture-tests-'));
  try {
    const python = `${common}\n${assertions}\n`;
    const result = spawnSync('python3', ['-c', python], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: tempRoot },
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^PASS_[A-Z_]+\s*$/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('synthetic unit fixture validates and copies only the three expected output files', async () => {
  await withPythonFixture(String.raw`
f = fixture()
result = mod.prepare(f.args, policy=f.policy)
assert result["ok"] is True and result["outputFileCount"] == 3
assert sorted(p.name for p in f.output.iterdir()) == ["SHA256SUMS", "api-source-receipt.json", "tauri-android-api-classes.jar"]
copied = (f.output / "tauri-android-api-classes.jar").read_bytes()
assert copied == f.jar.read_bytes() and sha(copied) == sha(f.jar.read_bytes())
receipt = json.loads((f.output / "api-source-receipt.json").read_text())
assert receipt["schemaVersion"] == 1 and receipt["sourceFiles"] == f.policy.source_files
assert receipt["classesJarSha256"] == sha(copied) and receipt["buildEnvironment"] == "unit-fixture"
assert not any("/" in value for value in receipt.values() if isinstance(value, str))
assert "tauri-android-api-classes.jar" in (f.output / "SHA256SUMS").read_text()
print("PASS_COPY_RECEIPT")
`);
});

test('locked archive, complete source bytes, and hard source hashes reject independent drift', async () => {
  await withPythonFixture(String.raw`
f = fixture()
f.policy = dataclasses.replace(f.policy, crate_checksum="0" * 64)
expect_error(lambda: mod.prepare(f.args, policy=f.policy), "LOCKED_CRATE_CHECKSUM_MISMATCH")
assert list(f.output.iterdir()) == []
f = fixture()
(f.source / "mobile/android/src/main/java/app/tauri/plugin/Plugin.kt").write_bytes(b"drift")
expect_error(lambda: mod.prepare(f.args, policy=f.policy), "CRATE_SOURCE_ARCHIVE_DIVERGENCE")
assert list(f.output.iterdir()) == []
f = fixture()
f.policy = dataclasses.replace(f.policy, source_files={**f.policy.source_files, "Cargo.toml": "0" * 64})
expect_error(lambda: mod.prepare(f.args, policy=f.policy), "PINNED_SOURCE_HASH_MISMATCH")
print("PASS_SOURCE_DRIFT_GUARDS")
`);
});

test('JAR validation requires the exact API surface and refuses product or native payloads', async () => {
  await withPythonFixture(String.raw`
f = fixture()
with zipfile.ZipFile(f.jar, "w") as zf:
  zf.writestr("app/tauri/plugin/Plugin.class", b"fixture")
expect_error(lambda: mod.prepare(f.args, policy=f.policy), "JAR_REQUIRED_API_CLASS_MISSING")
assert list(f.output.iterdir()) == []
f = fixture()
with zipfile.ZipFile(f.jar, "w") as zf:
  for name in mod.REQUIRED_API_CLASSES: zf.writestr(name, b"fixture")
  zf.writestr("com/tgk30/debridstreamer/Secret.class", b"not-allowed")
expect_error(lambda: mod.prepare(f.args, policy=f.policy), "JAR_UNEXPECTED_CLASS_PACKAGE")
f = fixture()
with zipfile.ZipFile(f.jar, "w") as zf:
  for name in mod.REQUIRED_API_CLASSES: zf.writestr(name, b"fixture")
  zf.writestr("lib/arm64-v8a/libnative.so", b"not-allowed")
expect_error(lambda: mod.prepare(f.args, policy=f.policy), "JAR_FORBIDDEN_PAYLOAD")
print("PASS_JAR_BOUNDARIES")
`);
});

test('archive traversal, unexpected Android build inputs, and symlinks fail closed', async () => {
  await withPythonFixture(String.raw`
f = fixture()
bad_archive = f.base / "bad.crate"
with tarfile.open(bad_archive, "w:gz") as tf:
  info = tarfile.TarInfo("tauri-2.12.4/../../escape")
  info.size = 1
  tf.addfile(info, io.BytesIO(b"x"))
f.args.crate_archive = bad_archive
f.policy = dataclasses.replace(f.policy, crate_checksum=sha(bad_archive.read_bytes()))
f.lock.write_text('version = 4\n\n[[package]]\nname = "tauri"\nversion = "2.12.4"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "' + f.policy.crate_checksum + '"\n')
expect_error(lambda: mod.prepare(f.args, policy=f.policy), "UNSAFE_MEMBER_PATH")
f = fixture()
(f.source / "mobile/android/src/main/java/Injected.kt").write_text("package injected")
expect_error(lambda: mod.prepare(f.args, policy=f.policy), "UNEXPECTED_ANDROID_BUILD_INPUT")
f = fixture()
link = f.base / "jar-link.jar"
link.symlink_to(f.jar)
f.args.classes_jar = link
expect_error(lambda: mod.prepare(f.args, policy=f.policy), "SYMLINK_INPUT_REFUSED")
print("PASS_PATH_AND_INPUT_GUARDS")
`);
});

test('production policy stays hard-pinned and CLI exposes no test-policy override', async () => {
  await withPythonFixture(String.raw`
assert mod.PRODUCTION_POLICY.crate_name == "tauri"
assert mod.PRODUCTION_POLICY.crate_version == "2.12.4"
assert mod.PRODUCTION_POLICY.crate_checksum == "f316751027fc2644221d1a448564d519efb07067fda584879d9cda966391d212"
assert mod.PRODUCTION_POLICY.source_files == mod.SOURCE_FILES
expect_error(lambda: mod._parse_args(["--cargo-lock", "x", "--crate-archive", "x", "--api-source", "x", "--classes-jar", "x", "--output", "x", "--build-environment", "test", "--policy", "override"]), "ARGUMENTS_INVALID")
f = fixture()
expect_error(lambda: mod.prepare(f.args, policy=mod.PRODUCTION_POLICY), "LOCKED_CRATE_CHECKSUM_MISMATCH")
assert list(f.output.iterdir()) == []
print("PASS_FIXED_POLICY")
`);
});
