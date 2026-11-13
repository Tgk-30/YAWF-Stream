#!/usr/bin/env node
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, readdir, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const BASELINE = Object.freeze({
  archiveSha256: "32d1b9041c0ddc5ef9201edc9420028bb764be5aa6046071164d6b646ca89901",
  archiveSize: 95584873,
  bundleIdentifier: "com.tgk30.debridstreamer",
  version: "2.3.96",
  targetVersion: "2.3.103",
});
export const TARGET = Object.freeze({
  archiveSha256: "14b2d959277782f7defb3d934e7dc9e4f82b6b60fbe6951ca9625c840b5c9ec2",
  archiveSize: 95577725,
  subjectName: "YAWF.Stream_aarch64.app.tar.gz",
  source: "6463c35757b69a4143386497c755648259d25e7f",
  repository: "https://github.com/Tgk-30/YAWF-Stream",
  workflow: ".github/workflows/web-release.yml",
  ref: "refs/tags/v2.3.103-web",
});
export const RECEIPT_ATTACHMENT = Object.freeze({
  name: "MacOTARuntimeReceipt",
  testIdentifier: "MacOTARuntimeTests/testPublic96To103ThroughNormalUpdaterUI()",
  testIdentifierURL: "test://com.apple.xcode/MacOTARuntime/MacOTARuntimeTests/MacOTARuntimeTests/testPublic96To103ThroughNormalUpdaterUI",
});
const receiptSuggestedNamePattern = /^MacOTARuntimeReceipt_0_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

const fail = (message) => { throw new Error(message); };
const sha256 = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

// Consume gh's VERIFIED statement, never an unverified DSSE payload.
export function validateTargetAttestation(document) {
  if (!Array.isArray(document) || document.length !== 1) fail("one verified target attestation required");
  const result = document[0]?.verificationResult;
  const statement = result?.statement;
  const definition = statement?.predicate?.buildDefinition;
  const workflow = definition?.externalParameters?.workflow;
  const dependencies = definition?.resolvedDependencies;
  const subjects = statement?.subject;
  if (result?.mediaType !== "application/vnd.dev.sigstore.verificationresult+json;version=0.1" ||
      result?.verifiedIdentity?.runnerEnvironment !== "github-hosted" ||
      statement?._type !== "https://in-toto.io/Statement/v1" ||
      statement?.predicateType !== "https://slsa.dev/provenance/v1" ||
      definition?.buildType !== "https://actions.github.io/buildtypes/workflow/v1" ||
      definition?.internalParameters?.github?.runner_environment !== "github-hosted") fail("verified hosted SLSA target statement required");
  if (workflow?.repository !== TARGET.repository || workflow?.path !== TARGET.workflow || workflow?.ref !== TARGET.ref ||
      statement?.predicate?.runDetails?.builder?.id !== `${TARGET.repository}/${TARGET.workflow}@${TARGET.ref}`) fail("target signer workflow/ref mismatch");
  if (!Array.isArray(dependencies) || dependencies.length !== 1 ||
      dependencies[0]?.uri !== `git+${TARGET.repository}@${TARGET.ref}` ||
      dependencies[0]?.digest?.gitCommit !== TARGET.source) fail("target source dependency mismatch");
  if (!Array.isArray(subjects) || subjects.length < 1 || subjects.length > 64) fail("nonempty bounded target subjects required");
  const matches = subjects.filter(subject => subject?.name === TARGET.subjectName);
  if (matches.length !== 1 || matches[0]?.digest?.sha256 !== TARGET.archiveSha256) fail("exact target subject digest required");
}

async function verifyTarget(options) {
  if (!options.targetArchive || !options.targetAttestation) fail("exact target archive and verified attestation required");
  const archive = await admitOwnedPath(options.targetArchive, process.env.RUNNER_TEMP);
  const attestation = await admitOwnedPath(options.targetAttestation, process.env.RUNNER_TEMP);
  const info = await lstat(archive);
  if (!info.isFile() || info.size !== TARGET.archiveSize || await sha256(archive) !== TARGET.archiveSha256) fail("target archive hash/size mismatch");
  const proof = await lstat(attestation);
  if (!proof.isFile() || proof.size < 1 || proof.size > 2 * 1024 * 1024) fail("target attestation file bounds invalid");
  validateTargetAttestation(JSON.parse(await readFile(attestation, "utf8")));
}

export function readRuntimeFacts() {
  const account = os.userInfo();
  return {
    platform: process.platform,
    arch: process.arch,
    machine: os.machine(),
    type: os.type(),
    kernelRelease: os.release(),
    macOSVersion: run("/usr/bin/sw_vers", ["-productVersion"], { capture: true }),
    username: account.username,
    homedir: account.homedir,
    homedirRealpath: realpathSync(account.homedir),
    uid: account.uid,
    processUid: process.getuid?.(),
  };
}

export function admitHostedRunner(env, facts = readRuntimeFacts()) {
  if (env.CI !== "true" || env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted") fail("fresh GitHub-hosted runner required");
  if (env.RUNNER_OS !== "macOS" || env.RUNNER_ARCH !== "ARM64") fail("macOS 15 arm64 runner required");
  if (env.RUNNER_TEMP !== "/Users/runner/work/_temp") fail("GitHub-hosted RUNNER_TEMP required");
  if (env.HOME !== "/Users/runner") fail("GitHub-hosted runner HOME required");
  if (facts.platform !== "darwin" || facts.type !== "Darwin" || facts.arch !== "arm64" || facts.machine !== "arm64") fail("actual Darwin arm64 runtime required");
  if (!facts.macOSVersion?.startsWith("15.") || !facts.kernelRelease?.startsWith("24.")) fail("actual macOS 15 and Darwin 24 required");
  if (facts.username !== "runner" || facts.homedir !== "/Users/runner" || facts.homedirRealpath !== "/Users/runner") fail("actual GitHub-hosted runner account required");
  if (!Number.isInteger(facts.uid) || facts.uid <= 0 || facts.uid !== facts.processUid) fail("actual runner uid mismatch");
}

export async function admitOwnedPath(candidate, runnerTemp) {
  const lexicalRoot = path.resolve(runnerTemp);
  const root = await realpath(lexicalRoot);
  if (root !== lexicalRoot) fail("RUNNER_TEMP has a symlinked ancestor");
  const lexicalCandidate = path.resolve(candidate);
  if (lexicalCandidate !== candidate) fail("owned path must be absolute and normalized");
  const lexicalParent = path.dirname(lexicalCandidate);
  const parent = await realpath(lexicalParent);
  if (parent !== lexicalParent) fail("owned path has a symlinked ancestor");
  const joined = path.join(parent, path.basename(lexicalCandidate));
  const relative = path.relative(root, joined);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail("path escapes RUNNER_TEMP");
  try {
    const info = await lstat(joined);
    if (info.isSymbolicLink()) fail("owned path must not be a symlink");
    const resolved = await realpath(joined);
    if (resolved !== joined) fail("owned path resolves through a symlink");
    const resolvedRelative = path.relative(root, resolved);
    if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) fail("resolved path escapes RUNNER_TEMP");
    return resolved;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return joined;
  }
}

export async function bundleManifest(root) {
  const entries = [];
  async function visit(dir, relative = "") {
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name);
      const rel = path.posix.join(relative, name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) fail(`bundle symlink is not admitted: ${rel}`);
      if (info.isDirectory()) {
        entries.push(`d ${info.mode & 0o777} ${rel}`);
        await visit(full, rel);
      } else if (info.isFile()) {
        entries.push(`f ${info.mode & 0o777} ${await sha256(full)} ${rel}`);
      } else fail(`unsupported bundle entry: ${rel}`);
    }
  }
  await visit(root);
  return createHash("sha256").update(entries.join("\n") + "\n").digest("hex");
}

export function pathsOverlap(first, second) {
  const a = path.resolve(first);
  const b = path.resolve(second);
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

export async function loadReceiptAttachment(exportRoot, runnerTemp) {
  const root = await admitOwnedPath(exportRoot, runnerTemp);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) fail("attachment export root is not a directory");
  const manifestPath = await admitOwnedPath(path.join(root, "manifest.json"), runnerTemp);
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.size <= 0 || manifestInfo.size >= 64 * 1024) fail("attachment manifest bounds invalid");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(manifest) || manifest.length !== 1) fail("expected exactly one exported testcase attachment row");
  const [row] = manifest;
  if (row?.testIdentifier !== RECEIPT_ATTACHMENT.testIdentifier || row?.testIdentifierURL !== RECEIPT_ATTACHMENT.testIdentifierURL) fail("attachment testcase identity mismatch");
  if (!Array.isArray(row.attachments)) fail("attachment list missing");
  for (const attachment of row.attachments) {
    if (typeof attachment?.exportedFileName !== "string" || path.basename(attachment.exportedFileName) !== attachment.exportedFileName) fail("unsafe exported attachment filename");
  }
  const matches = row.attachments.filter((attachment) => typeof attachment.suggestedHumanReadableName === "string" && receiptSuggestedNamePattern.test(attachment.suggestedHumanReadableName));
  if (matches.length !== 1) fail("expected exactly one named lifecycle receipt attachment");
  const [attachment] = matches;
  if (attachment.isAssociatedWithFailure !== false || attachment.configurationName !== "Test Scheme Action" || attachment.deviceName !== "My Mac" || typeof attachment.deviceId !== "string" || attachment.deviceId.length === 0 || !Number.isFinite(attachment.timestamp)) fail("receipt attachment provenance mismatch");
  if (!/^[a-z0-9][a-z0-9._-]{0,127}\.json$/i.test(attachment.exportedFileName)) fail("receipt attachment filename safety mismatch");
  const receiptPath = await admitOwnedPath(path.join(root, attachment.exportedFileName), runnerTemp);
  if (path.dirname(receiptPath) !== root) fail("receipt attachment escaped export root");
  const receiptInfo = await lstat(receiptPath);
  if (!receiptInfo.isFile() || receiptInfo.size <= 0 || receiptInfo.size >= 64 * 1024) fail("receipt attachment bounds invalid");
  const bytes = await readFile(receiptPath);
  const receipt = JSON.parse(bytes.toString("utf8"));
  return {
    receipt,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    exportedFileName: attachment.exportedFileName,
  };
}

export function patchXCTestRun(document, environment) {
  const targets = Array.isArray(document.TestConfigurations)
    ? document.TestConfigurations.flatMap((configuration) => (configuration.TestTargets ?? []).map((target) => ({ name: target.BlueprintName, target })))
    : Object.entries(document)
      .filter(([key, value]) => key !== "__xctestrun_metadata__" && value && typeof value === "object")
      .map(([key, target]) => ({ name: key, target }));
  if (targets.length !== 1) fail("expected exactly one XCTest target");
  const [{ name, target }] = targets;
  if (name !== "MacOTARuntimeTests") fail("unexpected XCTest target");
  const generatedTargetEnvironment = {
    APP_DISTRIBUTOR_ID_OVERRIDE: "com.apple.AppStore",
    DYLD_FRAMEWORK_PATH: "__TESTROOT__/Release",
    DYLD_LIBRARY_PATH: "__TESTROOT__/Release",
    XCODE_SCHEME_NAME: "MacOTARuntime",
    __XCODE_BUILT_PRODUCTS_DIR_PATHS: "__TESTROOT__/Release",
    __XPC_DYLD_FRAMEWORK_PATH: "__TESTROOT__/Release",
    __XPC_DYLD_LIBRARY_PATH: "__TESTROOT__/Release",
  };
  if (target.UITargetAppEnvironmentVariables != null) {
    const actual = target.UITargetAppEnvironmentVariables;
    const expectedKeys = Object.keys(generatedTargetEnvironment).sort();
    const actualKeys = actual && typeof actual === "object" && !Array.isArray(actual) ? Object.keys(actual).sort() : [];
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) || expectedKeys.some((key) => actual[key] !== generatedTargetEnvironment[key])) {
      fail("unexpected generated target-app environment");
    }
    delete target.UITargetAppEnvironmentVariables;
  }
  for (const key of ["UITargetAppCommandLineArguments", "UITargetAppPath", "UITargetAppBundleIdentifier"]) {
    const value = target[key];
    const populated = typeof value === "string"
      ? value.length > 0
      : Array.isArray(value)
        ? value.length > 0
        : value && typeof value === "object"
          ? Object.keys(value).length > 0
          : value != null;
    if (populated) {
      fail(`refusing target-app injection through ${key}`);
    }
  }
  target.EnvironmentVariables = { ...(target.EnvironmentVariables ?? {}), ...environment };
  return document;
}

export function validateReceipt(receipt, expected) {
  if (receipt.appPath !== expected.appPath) fail("receipt app path mismatch");
  if (receipt.beforeVersion !== BASELINE.version || receipt.afterVersion !== BASELINE.targetVersion) fail("receipt version mismatch");
  if (!Number.isInteger(receipt.beforePID) || !Number.isInteger(receipt.afterPID) || receipt.beforePID === receipt.afterPID) fail("relaunch PID transition missing");
  if (receipt.beforeExecutablePath !== expected.executablePath || receipt.afterExecutablePath !== expected.executablePath) fail("process executable path mismatch");
  if (receipt.profileName !== "OTA Runner" || receipt.density !== "Compact" || receipt.watchlistTitle !== "Inception") fail("seeded state was not preserved");
  if (typeof receipt.preInstallReopenUsed !== "boolean") fail("pre-install launch-check receipt missing");
  if (receipt.normalQuitObserved !== true) fail("normal quit was not observed");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    timeout: options.timeout ?? 60_000,
    maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} exited ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  return result.stdout?.trim() ?? "";
}

async function plistValue(appPath, key) {
  return run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path.join(appPath, "Contents", "Info.plist")], { capture: true });
}

async function admitBundle(appPath, version) {
  if ((await lstat(appPath)).isSymbolicLink()) fail("app path must not be a symlink");
  if (await plistValue(appPath, "CFBundleIdentifier") !== BASELINE.bundleIdentifier) fail("bundle identifier mismatch");
  if (await plistValue(appPath, "CFBundleShortVersionString") !== version) fail("bundle version mismatch");
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  run("/usr/sbin/spctl", ["-a", "-vv", "-t", "exec", appPath]);
}

async function prepare(options) {
  if (options.runRoot !== path.join(process.env.RUNNER_TEMP, "mac-ota103")) fail("prepare requires the fixed private run root");
  const archive = await admitOwnedPath(options.archive96, process.env.RUNNER_TEMP);
  const archiveInfo = await stat(archive);
  if (archiveInfo.size !== BASELINE.archiveSize || await sha256(archive) !== BASELINE.archiveSha256) fail("public v2.3.96 archive identity mismatch");
  const runRoot = await admitOwnedPath(options.runRoot, process.env.RUNNER_TEMP);
  await mkdir(runRoot, { recursive: false });
  const privateRoot = path.join(runRoot, "private-app");
  await mkdir(privateRoot);
  const members = run("/usr/bin/tar", ["-tzf", archive], { capture: true }).split("\n").filter(Boolean);
  if (members.length === 0 || members.some((member) => member.startsWith("/") || member.split("/").includes(".."))) fail("archive has unsafe members");
  run("/usr/bin/tar", ["-xzf", archive, "-C", privateRoot]);
  const appPath = path.join(privateRoot, "YAWF Stream.app");
  await admitBundle(appPath, BASELINE.version);
  const executablePath = path.join(appPath, "Contents", "MacOS", await plistValue(appPath, "CFBundleExecutable"));
  const receipt = {
    appPath,
    executablePath,
    archiveSha256: BASELINE.archiveSha256,
    archiveSize: BASELINE.archiveSize,
    version: BASELINE.version,
    bundleManifestSha256: await bundleManifest(appPath),
  };
  await writeFile(path.join(runRoot, "prepared.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

async function execute(options) {
  await verifyTarget(options);
  if (!options.runRoot || !options.xctestrun || !options.expected103App) fail("execute requires --runRoot, --xctestrun, and --expected103App");
  if (options.runRoot !== path.join(process.env.RUNNER_TEMP, "mac-ota103")) fail("execute requires the fixed private run root");
  const runRoot = await admitOwnedPath(options.runRoot, process.env.RUNNER_TEMP);
  const prepared = JSON.parse(await readFile(path.join(runRoot, "prepared.json"), "utf8"));
  const admittedPreparedPath = await admitOwnedPath(prepared.appPath, process.env.RUNNER_TEMP);
  if (admittedPreparedPath !== prepared.appPath) fail("prepared app path changed");
  await admitBundle(prepared.appPath, BASELINE.version);
  if (await bundleManifest(prepared.appPath) !== prepared.bundleManifestSha256) fail("baseline bundle changed after preparation");
  const reference = await admitOwnedPath(options.expected103App, process.env.RUNNER_TEMP);
  if (pathsOverlap(prepared.appPath, reference)) fail("reference and candidate app trees overlap");
  await admitBundle(reference, BASELINE.targetVersion);
  const expectedDigest = await bundleManifest(reference);
  const configPath = path.join(runRoot, "test-config.json");
  await writeFile(configPath, JSON.stringify({
    appPath: prepared.appPath,
    expectedBeforeVersion: BASELINE.version,
    expectedAfterVersion: BASELINE.targetVersion,
  }) + "\n", { flag: "wx" });

  const original = await admitOwnedPath(options.xctestrun, process.env.RUNNER_TEMP);
  const json = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", original], { capture: true }));
  const patched = patchXCTestRun(json, {
    CI: "true",
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: process.env.RUNNER_OS,
    RUNNER_ARCH: process.env.RUNNER_ARCH,
    RUNNER_TEMP: process.env.RUNNER_TEMP,
    YAWF_OTA_CONFIG_PATH: configPath,
  });
  const patchedPath = path.join(path.dirname(original), "MacOTARuntime.patched.xctestrun");
  await writeFile(patchedPath, JSON.stringify(patched), { flag: "wx" });
  run("/usr/bin/plutil", ["-convert", "binary1", patchedPath]);

  const resultBundlePath = path.join(runRoot, "MacOTARuntime.xcresult");
  run("/usr/bin/xcodebuild", [
    "test-without-building",
    "-xctestrun", patchedPath,
    "-destination", "platform=macOS,arch=arm64",
    "-parallel-testing-enabled", "NO",
    "-only-testing:MacOTARuntimeTests/MacOTARuntimeTests/testPublic96To103ThroughNormalUpdaterUI",
    "-resultBundlePath", resultBundlePath,
  ], { timeout: 25 * 60 * 1000 });

  const attachmentRoot = path.join(runRoot, "receipt-attachments");
  run("/usr/bin/xcrun", [
    "xcresulttool", "export", "attachments",
    "--path", resultBundlePath,
    "--output-path", attachmentRoot,
    "--test-id", RECEIPT_ATTACHMENT.testIdentifier,
  ]);
  const attachmentReceipt = await loadReceiptAttachment(attachmentRoot, process.env.RUNNER_TEMP);
  const receipt = attachmentReceipt.receipt;
  validateReceipt(receipt, prepared);
  await admitBundle(prepared.appPath, BASELINE.targetVersion);
  await admitBundle(reference, BASELINE.targetVersion);
  const [actualDigest, finalReferenceDigest] = await Promise.all([bundleManifest(prepared.appPath), bundleManifest(reference)]);
  if (finalReferenceDigest !== expectedDigest) fail("independent public v2.3.103 reference changed during the UI test");
  if (actualDigest !== expectedDigest) fail("OTA-installed bundle differs from the independently downloaded public v2.3.103 bundle");
  receipt.bundleManifestSha256 = actualDigest;
  receipt.receiptAttachmentSha256 = attachmentReceipt.sha256;
  receipt.receiptAttachmentExportedFileName = attachmentReceipt.exportedFileName;
  await writeFile(path.join(runRoot, "verified.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith("--") || rest[index + 1] == null) fail("arguments must be --name value pairs");
    options[rest[index].slice(2)] = rest[index + 1];
  }
  return { command, options };
}

async function main() {
  admitHostedRunner(process.env);
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "verify-target") return verifyTarget(options);
  if (command === "prepare") return prepare(options);
  if (command === "execute") return execute(options);
  fail("usage: controller.mjs verify-target|prepare|execute ...");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
