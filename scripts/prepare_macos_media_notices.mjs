#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function prepareMediaNotices(buildRoot, outputInput) {
  const output = resolve(outputInput);
  if (existsSync(output)) throw new Error("Notice output must not exist");
  const root = realpathSync(buildRoot), sources = realpathSync(join(root, "recipe/sources"));
  const provenance = JSON.parse(readFileSync(join(root, "artifacts/provenance.json")));
  const notices = provenance.sourceInventory?.notices;
  if (!Array.isArray(notices) || !notices.length) throw new Error("Component notice inventory is missing");
  const plan = notices.map(({ path, sha256 }) => {
    if (typeof path !== "string" || isAbsolute(path) || path.split(/[\\/]/).some((part) => !part || part === "." || part === "..") || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Unsafe notice entry");
    const source = realpathSync(join(sources, path));
    const within = relative(sources, source);
    if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within) || !statSync(source).isFile()) throw new Error("Notice escapes component sources");
    if (createHash("sha256").update(readFileSync(source)).digest("hex") !== sha256) throw new Error("Component notice hash mismatch");
    return { source, path };
  });
  // Fail before any copy if provenance would expose a local build path.
  const serialized = JSON.stringify(provenance, null, 2);
  if (serialized.includes(root) || serialized.includes("/Users/") || serialized.includes("/Volumes/")) throw new Error("Provenance contains a workstation path");
  mkdirSync(output, { recursive: true });
  for (const { source, path } of plan) {
    const destination = join(output, "components", path);
    mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination);
  }
  writeFileSync(join(output, "provenance.json"), `${serialized}\n`);
  copyFileSync(new URL("./macos-media-runtime/SOURCE-NOTICES.md", import.meta.url), join(output, "SOURCE-NOTICES.md"));
  writeFileSync(join(output, "README.txt"), "Bundled media components retain their own licenses, including GPL-covered mpv, FFmpeg and x264. Exact component notices and provenance are included. Corresponding component source and build instructions accompany the release. This index does not replace any component license or claim legal clearance.\n");
  return { files: plan.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: node scripts/prepare_macos_media_notices.mjs <build-root> <new-output>");
    console.log(JSON.stringify(prepareMediaNotices(...process.argv.slice(2))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
