import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyObserverDirectory, preparedObserver } from "../scripts/prepare_windows_storage_observer.mjs";

export async function buildServer({ root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), platform = process.platform, bundle } = {}) {
  const observer = platform === "win32" ? preparedObserver(root) : null;
  const dist = join(root, "server", "dist");
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const build = bundle ?? (await import("esbuild")).buildSync;
  build({ entryPoints: [join(root, "server", "src", "index.ts")], bundle: true, platform: "node", format: "cjs", target: "node24",
    banner: { js: `/* YAWF_WINDOWS_STORAGE_BINDING:${JSON.stringify(observer?.binding ?? null)} */` },
    outfile: join(dist, "index.cjs"), define: { __YAWF_WINDOWS_STORAGE_BINDING__: JSON.stringify(observer?.binding ?? null),
      "import.meta.url": "undefined" } });
  if (observer) copyObserverDirectory(observer.directory, join(dist, "windows-storage-observer"), observer.binding);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await buildServer(); } catch { console.error("Server build failed. On Windows, prepare and hash-bind the storage observer before building."); process.exitCode = 1; }
}
