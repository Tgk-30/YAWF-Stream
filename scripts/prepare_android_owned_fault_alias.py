#!/usr/bin/env python3
"""Prepare only a checksum-bound TEST APK source bridge for an actual R8 alias.

Never modifies product/source/keep/signatures, builds, installs, boots or signs.
The SDK queries are restricted to the two public Tauri dispatch classes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

from android_owned_startup_runtime import System as ProcessSystem, Refusal, strict_json
from prepare_android_tauri_api_fixture import SOURCE_FILES, PRODUCTION_POLICY, _validate_jar, FixtureError

SCOPE = "TEST_ONLY_MINIFIED_PLUGIN_ALIAS_NO_PRODUCT_MUTATION"
PLUGIN = "app.tauri.plugin.Plugin"
DESCRIPTOR = "Lapp/tauri/plugin/Plugin;"
METHOD = "(Landroid/webkit/WebView;)V"
CLASSES = ("app.tauri.plugin.PluginManager", "app.tauri.plugin.PluginHandle")
CRATE = "f316751027fc2644221d1a448564d519efb07067fda584879d9cda966391d212"
MODULE_FILES = {
    "README.md": "b5c971e96a6751609046650e5c8d5c435a890f45c1261485d7a093641930f06b",
    "app/build.gradle.kts": "f287aacede66c297d7cb66ebd12e0d9f2ae3d9db1f4c52121fd6e9e925adf4fb",
    "app/src/androidTest/AndroidManifest.xml": "bb1c618c5a517eba63d8c2355b1470a355b2baca85e393695b2e05dcc96001d3",
    "app/src/androidTest/java/com/yawf/ownedstartup/FaultOncePlugin.java": "14c3fb04da8343d19b4392b8b3c6eb31cf4cdfcea33776ba10ce36cdf18f1369",
    "app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyInstrumentationRunner.java": "a643859077b023a8a967327a134702a3394976b1e9fb5c485e835e7870ee0d6c",
    "app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyRetryTest.java": "408c30df3f62650236dc6c8d55bb4469acce7d8100026d6ced3fe99bb140a8e1",
    "app/src/main/AndroidManifest.xml": "301a12775b404acb424205c2289dbb25b15924e83ba54911a4739dd1d7238105",
    "build.gradle.kts": "08ebf0c379db7cd09ef90385dd9397e249498ce070c1b594a9735ab88ba7707f",
    "gradle.properties": "fb298af7d84d0e20523e7172625a8d975a11efa043c573ca97f8997a0e84fb5f",
    "settings.gradle.kts": "88efa22ce58254dc09f6e472d9b09ba3aa8e40db1e3967e73f24be6318c3beaf"
}
FAULT = "app/src/androidTest/java/com/yawf/ownedstartup/FaultOncePlugin.java"
KEYWORDS = set("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null _ record sealed permits var yield module requires exports opens to uses provides with transitive when".split())
FLOOR, CAP = 6 * 1024**3, 8 * 1024**2


def require(value, code):
    if not value:
        raise Refusal(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value, exists=True):
    path = Path(value)
    require(path.is_absolute() and path.resolve(strict=exists) == path, "CANONICAL_PATH_REQUIRED")
    return path


def read(path, cap):
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and not path.is_symlink() and 0 < before.st_size <= cap, "BOUNDED_REGULAR_FILE_REQUIRED")
    data = path.read_bytes()
    after = path.lstat()
    require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), "INPUT_CHANGED")
    return data


def hash_file(path, cap):
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and not path.is_symlink() and 0 < before.st_size <= cap, "BOUNDED_REGULAR_FILE_REQUIRED")
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024**2), b""):
            hasher.update(block)
    after = path.lstat()
    require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), "INPUT_CHANGED")
    return hasher.hexdigest(), after.st_size


def inventory(root):
    paths = {}
    require(root.is_dir(), "MODULE_DIRECTORY")
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            mode = path.lstat().st_mode
            require(not stat.S_ISLNK(mode) and (stat.S_ISDIR(mode) or stat.S_ISREG(mode)), "MODULE_LINK_OR_SPECIAL")
            if stat.S_ISREG(mode):
                paths[str(path.relative_to(root))] = path
    require(set(paths) == set(MODULE_FILES), "MODULE_INVENTORY")
    result = {name: sha(read(path, 256 * 1024)) for name, path in paths.items()}
    require(result == MODULE_FILES, "MODULE_SOURCE_DRIFT")
    return result


def sums(folder, expected):
    canonical(str(folder)); require(folder.is_dir(), "ARTIFACT_DIRECTORY")
    require({p.name for p in folder.iterdir()} == set(expected) | {"SHA256SUMS"}, "ARTIFACT_INVENTORY")
    found = {}
    for line in read(folder / "SHA256SUMS", 32768).decode("ascii").splitlines():
        match = re.fullmatch(r"([a-f0-9]{64})  ([A-Za-z0-9_.-]+)", line)
        require(match is not None and match[2] not in found, "SHA256SUMS_FORMAT")
        found[match[2]] = match[1]
    require(set(found) == set(expected), "SHA256SUMS_INVENTORY")
    for name, cap in expected.items():
        require(hash_file(folder / name, cap)[0] == found[name], "ARTIFACT_HASH_MISMATCH")
    return found


def json_object(path):
    value = strict_json(read(path, 32768))
    require(type(value) is dict, "JSON_OBJECT_REQUIRED")
    return value


def alias_from_mapping(mapping):
    blocks, rows, current = [], [], None
    for line in mapping.splitlines():
        header = re.fullmatch(r"(\S+) -> (\S+):", line)
        if header:
            if current is not None:
                blocks.append((current, rows))
            current = header.groups() if header[1] == PLUGIN else None
            rows = []
        elif current is not None:
            rows.append(line)
    if current is not None:
        blocks.append((current, rows))
    require(len(blocks) == 1 and blocks[0][0] == (PLUGIN, PLUGIN), "PLUGIN_CLASS_MAPPING")
    matches = []
    for line in blocks[0][1]:
        match = re.fullmatch(r"\s+(?:\d+:\d+:)?void load\(android\.webkit\.WebView\)(?::\d+(?::\d+)?)? -> (\S+)", line)
        if match:
            matches.append(match[1])
    require(len(matches) == 1, "LOAD_MAPPING_AMBIGUOUS_OR_MISSING")
    alias = matches[0]
    require(re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]{0,63}", alias) and alias not in KEYWORDS, "UNSAFE_JAVA_ALIAS")
    return alias


def class_methods(code, name):
    declarations = re.findall(r"(?m)^\.class ([^\r\n]+)$", code)
    require(len(declarations) == 1 and declarations[0].split()[-1] == "L" + name.replace(".", "/") + ";", "RUNTIME_CLASS_SCOPE")
    return declarations[0].split()[:-1], list(re.finditer(r"(?ms)^\.method ([^\r\n]+)\n(.*?)^\.end method\s*$", code))


def validate_runtime_method(code, alias):
    flags, methods = class_methods(code, PLUGIN)
    require("public" in flags and not set(flags) & {"final", "interface", "enum", "annotation"}, "PLUGIN_CLASS_NOT_EXTENSIBLE")
    found = [method for method in methods if method[1].split()[-1] == alias + METHOD]
    require(len(found) == 1, "RUNTIME_LOAD_SIGNATURE")
    method = found[0]
    flags = method[1].split()[:-1]
    section = code[:method.start()].rfind("# virtual methods")
    direct = code[:method.start()].rfind("# direct methods")
    require("public" in flags and not set(flags) & {"private", "protected", "static", "final", "constructor"} and section > direct,
            "RUNTIME_LOAD_NOT_PUBLIC_VIRTUAL")


def bridge(source, alias):
    anchor = "    @Override\n    public void load(WebView webView) {"
    require(source.count(anchor) == 1, "ORIGINAL_LOAD_OVERRIDE")
    if alias == "load":
        return source
    lexical = re.sub(r'/\*.*?\*/|//[^\n]*|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'', '', source, flags=re.S)
    require(alias not in re.findall(r"[A-Za-z_$][A-Za-z0-9_$]*", lexical), "FAULT_ALIAS_COLLISION")
    insertion = "    // TEST-APK-ONLY residual virtual dispatch bridge. Product APK is unchanged.\n" + \
                "    public void " + alias + "(WebView value) { load(value); }\n\n"
    adapted = source.replace(anchor, insertion + anchor)
    require(adapted.replace(insertion, "", 1) == source, "BRIDGE_INVERSE")
    return adapted


def virtual_calls(code, name, alias):
    _, methods = class_methods(code, name)
    count = 0
    pattern = re.compile(r"\s*invoke-virtual(?:/range)?\s+\{([^}\r\n]+)\},\s+" + re.escape(DESCRIPTOR + "->" + alias + METHOD) + r"\s*")
    for method in methods:
        for line in method[2].splitlines():
            match = pattern.fullmatch(line)
            if not match:
                continue
            registers = match[1].strip()
            normal = re.fullmatch(r"[vp]\d+\s*,\s*[vp]\d+", registers)
            ranged = re.fullmatch(r"([vp])(\d+)\s+\.\.\s+([vp])(\d+)", registers)
            require(normal is not None or (ranged is not None and ranged[1] == ranged[3] and int(ranged[4]) == int(ranged[2]) + 1), "VIRTUAL_CALL_REGISTER_SHAPE")
            count += 1
    return count


class Tools:
    platform = sys.platform
    environ = os.environ

    def analyze(self, executable, name, apk, guard, temporary):
        env = {"PATH": self.environ.get("PATH", ""), "HOME": str(temporary), "TMPDIR": str(temporary)}
        if "JAVA_HOME" in self.environ:
            env["JAVA_HOME"] = self.environ["JAVA_HOME"]
        code, out, _ = ProcessSystem().run([str(executable), "dex", "code", "--class", name, str(apk)],
                                         90, 2 * 1024**2, guard, env)
        require(code == 0, "CALLSITE_TOOL_FAILED")
        return out.decode("utf-8")


def prepare(args, tools=None):
    tools = tools or Tools()
    require(tools.platform == "linux" and tools.environ.get("GITHUB_ACTIONS") == "true", "HOST_NOT_ADMITTED")
    require(re.fullmatch(r"[a-f0-9]{40}", args.source) and re.fullmatch(r"[1-9][0-9]{0,19}", args.run), "SOURCE_RUN_FORMAT")
    temporary = canonical(tools.environ.get("RUNNER_TEMP", ""))
    inputs, output = canonical(args.inputs), canonical(args.output, False)
    require(inputs != temporary and output != temporary and inputs.is_relative_to(temporary) and output.is_relative_to(temporary) and
            not output.is_relative_to(inputs) and not output.exists(), "OWNED_FRESH_PATHS")
    def capacity():
        import shutil
        require(shutil.disk_usage(temporary).free >= FLOOR, "WORK_RESERVE")
        if output.exists():
            require(sum(p.lstat().st_blocks * 512 for p in output.rglob("*") if p.is_file()) <= CAP, "OUTPUT_CAP")
    capacity()
    require({p.name for p in inputs.iterdir()} == {"phone", "api", "candidate-run.json"}, "INPUT_INVENTORY")
    candidate = json_object(inputs / "candidate-run.json")
    require(set(candidate) == {"source", "runId", "artifacts"} and candidate["source"] == args.source and candidate["runId"] == args.run,
            "CANDIDATE_SOURCE_RUN")
    require(type(candidate["artifacts"]) is dict and set(candidate["artifacts"]) == {"android-phone-verification-candidate", "android-phone-api-fixture"}, "CANDIDATE_ARTIFACTS")
    for name, item in candidate["artifacts"].items():
        require(type(item) is dict and set(item) == {"id", "name", "size_in_bytes", "digest"} and item["name"] == name and
                type(item["id"]) is int and item["id"] > 0 and type(item["size_in_bytes"]) is int and item["size_in_bytes"] > 0 and
                re.fullmatch(r"sha256:[a-f0-9]{64}", item["digest"]), "CANDIDATE_ARTIFACTS")
    phone, api = inputs / "phone", inputs / "api"
    apk_name = "YAWF.Stream_Android_2.3.114.apk"
    phone_hashes = sums(phone, {apk_name: 160 * 1024**2, "android-update.json": 32768})
    api_hashes = sums(api, {"api-build-binding.json": 32768, "api-source-receipt.json": 32768,
                           "tauri-android-api-classes.jar": 32 * 1024**2, "android-r8-mapping.txt": 64 * 1024**2,
                           "plugin-runtime-code.txt": 2 * 1024**2})
    manifest = json_object(phone / "android-update.json")
    require(manifest.get("schemaVersion") == 1 and manifest.get("version") == "2.3.114" and manifest.get("versionCode") == 2003114 and
            manifest.get("packageName") == "com.tgk30.debridstreamer" and manifest.get("sourceRevision") == args.source and
            manifest.get("apk") == {"name": apk_name, "sha256": phone_hashes[apk_name], "size": (phone / apk_name).stat().st_size}, "PHONE_MANIFEST")
    binding = json_object(api / "api-build-binding.json")
    require(binding.get("schemaVersion") == 1 and binding.get("scope") == "COMPILE_ONLY_API_OUTPUT_NOT_RUNTIME_QUALIFICATION" and
            binding.get("source") == args.source and binding.get("runId") == args.run and binding.get("ordinaryApkBuildInSameJob") is True and
            binding.get("producerTaskInvokedInThisJob") is True and binding.get("producerTask") == ":tauri-android:bundleLibCompileToJarRelease" and
            binding.get("gradleProject") == ":tauri-android" and binding.get("freshCompilationClaim") is False and
            binding.get("minifiedHookAvailabilityClaim") is False and binding.get("releaseMappingSha256") == api_hashes["android-r8-mapping.txt"] and
            binding.get("pluginRuntimeCodeSha256") == api_hashes["plugin-runtime-code.txt"], "API_BUILD_BINDING")
    receipt = json_object(api / "api-source-receipt.json")
    jar = read(api / "tauri-android-api-classes.jar", 32 * 1024**2)
    require(receipt.get("schemaVersion") == 1 and receipt.get("crateName") == "tauri" and receipt.get("crateVersion") == "2.12.4" and
            receipt.get("crateChecksum") == CRATE and receipt.get("archiveSha256") == CRATE and receipt.get("sourceFiles") == SOURCE_FILES and
            receipt.get("classesJarSha256") == sha(jar) and bool(receipt.get("buildEnvironment")), "API_SOURCE_BINDING")
    jar_facts = _validate_jar(jar, PRODUCTION_POLICY)
    require(all(receipt.get(key) == value for key, value in jar_facts.items()), "API_JAR_COUNTS")
    module = canonical(str(Path(args.module).absolute()))
    original = inventory(module)
    alias = alias_from_mapping(read(api / "android-r8-mapping.txt", 64 * 1024**2).decode("utf-8"))
    validate_runtime_method(read(api / "plugin-runtime-code.txt", 2 * 1024**2).decode("utf-8"), alias)
    adapted_fault = bridge(read(module / FAULT, 256 * 1024).decode("utf-8"), alias)
    sdk = Path(args.sdk).resolve(strict=True)
    analyzer = sdk / "cmdline-tools/latest/bin/apkanalyzer"
    require(analyzer.is_file() and os.access(analyzer, os.X_OK) and analyzer.resolve().is_relative_to(sdk), "APK_ANALYZER_REQUIRED")
    callsites, code_files = {}, {}
    for name in CLASSES:
        code = tools.analyze(analyzer, name, phone / apk_name, capacity, temporary)
        require(len(code.encode()) <= 2 * 1024**2, "CALLSITE_CODE_CAP")
        count = virtual_calls(code, name, alias)
        callsites[name] = {"sha256": sha(code.encode()), "bytes": len(code.encode()), "virtualCalls": count}
        code_files[name.rsplit(".", 1)[1] + "-runtime-code.txt"] = code
    require(any(item["virtualCalls"] > 0 for item in callsites.values()), "VIRTUAL_DISPATCH_CALLSITE_MISSING")
    # Revalidate mutable inputs and exact source after the bounded tool calls.
    require(sums(phone, {apk_name: 160 * 1024**2, "android-update.json": 32768}) == phone_hashes and
            sums(api, {name: 64 * 1024**2 for name in api_hashes}) == api_hashes and inventory(module) == original, "INPUT_CHANGED")
    capacity(); output.mkdir(mode=0o700)
    copied = output / "module"; copied.mkdir()
    adapted = {}
    for name in original:
        destination = copied / name; destination.parent.mkdir(parents=True, exist_ok=True)
        data = adapted_fault.encode() if name == FAULT else read(module / name, 256 * 1024)
        destination.write_bytes(data); adapted[name] = sha(data)
    for name, code in code_files.items():
        (output / name).write_text(code)
    result = {"schemaVersion": 1, "scope": SCOPE, "candidate": {"source": args.source, "runId": args.run,
              "apk": {"sha256": phone_hashes[apk_name], "bytes": manifest["apk"]["size"]}},
              "api": {"classesJarSha256": sha(jar), "crateChecksum": CRATE,
              "mappingSha256": api_hashes["android-r8-mapping.txt"], "runtimeCodeSha256": api_hashes["plugin-runtime-code.txt"]},
              "faultAlias": alias, "originalModuleFiles": original, "adaptedModuleFiles": adapted, "callsites": callsites}
    (output / "TEST-BUILD-BINDING.json").write_text(json.dumps(result, sort_keys=True) + "\n")
    capacity()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("inputs", "source", "run", "module", "output", "sdk"):
        parser.add_argument("--" + key, required=True)
    try:
        result = prepare(parser.parse_args())
        print(json.dumps({"scope": SCOPE, "faultAlias": result["faultAlias"], "runtimeQualification": False}))
        return 0
    except (Refusal, FixtureError, OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({"scope": SCOPE, "code": str(error) if isinstance(error, (Refusal, FixtureError)) else "HOST_OR_INPUT_REFUSAL", "runtimeQualification": False}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
