#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const within = (root, path) => path === root || (!relative(root, path).startsWith(`..${sep}`) && relative(root, path) !== ".." && !isAbsolute(relative(root, path)));

export function prepareReplayMediaNotices(sourceRootInput, provenanceInput, outputInput) {
  const sourceRoot = realpathSync(sourceRootInput);
  const components = realpathSync(join(sourceRoot, "component-sources"));
  const provenancePath = realpathSync(provenanceInput);
  const output = resolve(outputInput);
  if (existsSync(output)) throw new Error("Notice output must not exist");
  if (!within(sourceRoot, components) || !statSync(provenancePath).isFile()) throw new Error("Notice input is invalid");
  const inventory = JSON.parse(readFileSync(join(sourceRoot, "SOURCE-INVENTORY.json")));
  const ownedManifest = JSON.parse(readFileSync(join(sourceRoot, "OWNED-FILE-MANIFEST.json")));
  const provenance = JSON.parse(readFileSync(provenancePath));
  if (provenance?.licensingCleared !== false) throw new Error("Replay provenance must retain licensingCleared false");
  const serialized = JSON.stringify(provenance, null, 2);
  if (/\/(?:Users|Volumes|private\/tmp)\//.test(serialized)) throw new Error("Replay provenance contains a workstation path");
  if (!Array.isArray(inventory.notices) || inventory.notices.length === 0) throw new Error("Component notice inventory is missing");
  const plan = inventory.notices.map(({ path, sha256: expected }) => {
    if (typeof path !== "string" || isAbsolute(path) || path.split(/[\\/]/).some((part) => !part || part === "." || part === "..") || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("Unsafe component notice entry");
    const source = realpathSync(join(components, path));
    if (!within(components, source) || !statSync(source).isFile()) throw new Error("Component notice escapes source root");
    if (sha256(source) !== expected) throw new Error("Component notice hash mismatch");
    return { source, path, sha256: expected };
  });
  const licenseEntries = Array.isArray(ownedManifest?.files)
    ? ownedManifest.files.filter(({ path }) => path === "replay-controls/PROJECT-LICENSE.txt")
    : [];
  if (ownedManifest?.schemaVersion !== 1 || ownedManifest?.licensingCleared !== false || licenseEntries.length !== 1) {
    throw new Error("Owned project license manifest entry is missing");
  }
  const licenseEntry = licenseEntries[0];
  if (!Number.isSafeInteger(licenseEntry.bytes) || licenseEntry.bytes < 1 || !/^[a-f0-9]{64}$/.test(licenseEntry.sha256)) {
    throw new Error("Owned project license manifest entry is invalid");
  }
  const licenseInput = join(sourceRoot, licenseEntry.path);
  if (!existsSync(licenseInput)) throw new Error("Owned project license file is missing");
  const licenseSource = realpathSync(licenseInput);
  const licenseInfo = statSync(licenseSource);
  if (!within(sourceRoot, licenseSource) || !licenseInfo.isFile() || licenseInfo.size !== licenseEntry.bytes || sha256(licenseSource) !== licenseEntry.sha256) {
    throw new Error("Owned project license differs from its manifest");
  }
  mkdirSync(output, { recursive: true });
  for (const item of plan) {
    const destination = join(output, "components", item.path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(item.source, destination);
  }
  copyFileSync(licenseSource, join(output, "PROJECT-LICENSE.txt"));
  copyFileSync(join(sourceRoot, "replay-controls", "SOURCE-NOTICES.md"), join(output, "SOURCE-NOTICES.md"));
  writeFileSync(join(output, "provenance.json"), `${serialized}\n`);
  writeFileSync(join(output, "NOTICE-INVENTORY.json"), `${JSON.stringify({ schemaVersion: 1, files: plan.map(({ path, sha256 }) => ({ path, sha256 })), ownedFiles: [{ path: "PROJECT-LICENSE.txt", bytes: licenseEntry.bytes, sha256: licenseEntry.sha256 }] }, null, 2)}\n`);
  writeFileSync(join(output, "README.txt"), "Exact component notices and hashes are included. The corresponding source archive contains the component source and independent build controls. No licensing clearance is claimed.\n");
  return { files: plan.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 5) throw new Error("Usage: node scripts/prepare_macos_replay_notices.mjs <source-root> <provenance> <new-output>");
    console.log(JSON.stringify(prepareReplayMediaNotices(...process.argv.slice(2))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
