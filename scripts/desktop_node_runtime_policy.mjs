// Node22 remains supported LTS and its official macOS binaries retain min11.
// Other packages keep Node24. Final package gates still inspect actual binaries.
export const MACOS_NODE_RUNTIME_VERSION = "22.23.3";
export const DEFAULT_NODE_RUNTIME_VERSION = "24.17.0";

export function desktopNodeRuntimeVersion(platform, override) {
  if (override != null) {
    const version = override.replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a plain Node runtime semver");
    return version;
  }
  return platform.startsWith("darwin-") ? MACOS_NODE_RUNTIME_VERSION : DEFAULT_NODE_RUNTIME_VERSION;
}
