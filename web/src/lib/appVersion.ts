import { isTauri } from "./tauri";

type AppVersionProviders = {
  isTauri: () => boolean;
  native: () => Promise<string>;
  browser: () => string;
};

const defaultProviders: AppVersionProviders = {
  isTauri,
  native: async () => {
    const { getVersion } = await import("@tauri-apps/api/app");
    return getVersion();
  },
  browser: () => __APP_VERSION__,
};

type ParsedAppVersion = {
  core: [number, number, number];
  prerelease: string[] | null;
};

/**
 * Oldest desktop package whose audited native command ABI can host the current
 * web bundle. This is deliberately independent from __APP_VERSION__: server and
 * Android-only releases do not require a new desktop package.
 */
export const DESKTOP_NATIVE_COMPATIBILITY_FLOOR = "2.3.6";

function parseAppVersion(value: string): ParsedAppVersion | null {
  const match = value
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (match == null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? null,
  };
}

/** Compare two application versions using the SemVer precedence needed by the
 * desktop compatibility gate. Returns a negative number when left is older. */
export function compareAppVersions(left: string, right: string): number {
  const a = parseAppVersion(left);
  const b = parseAppVersion(right);
  if (a == null || b == null) return left.localeCompare(right, undefined, { numeric: true });

  for (let index = 0; index < a.core.length; index += 1) {
    const difference = a.core[index] - b.core[index];
    if (difference !== 0) return difference;
  }
  if (a.prerelease == null && b.prerelease == null) return 0;
  if (a.prerelease == null) return 1;
  if (b.prerelease == null) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart == null) return -1;
    if (rightPart == null) return 1;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber != null && rightNumber != null) {
      if (leftNumber !== rightNumber) return leftNumber - rightNumber;
    } else if (leftNumber != null) {
      return -1;
    } else if (rightNumber != null) {
      return 1;
    } else {
      const difference = leftPart.localeCompare(rightPart);
      if (difference !== 0) return difference;
    }
  }
  return 0;
}

/** Whether a native desktop package is below the separately audited ABI floor. */
export function requiresDesktopNativeUpdate(
  nativeVersion: string,
  compatibilityFloor = DESKTOP_NATIVE_COMPATIBILITY_FLOOR,
): boolean {
  return compareAppVersions(nativeVersion, compatibilityFloor) < 0;
}

/** Read only the native package version. Unlike getAppVersion, this returns
 * null instead of falling back to the hosted web bundle, because treating the
 * server version as the desktop version would hide a compatibility mismatch. */
export async function getNativeAppVersion(
  providers: AppVersionProviders = defaultProviders,
): Promise<string | null> {
  if (!providers.isTauri()) return null;
  try {
    return await providers.native();
  } catch {
    return null;
  }
}

/** Resolve the displayed app version for the current runtime. */
export async function getAppVersion(
  providers: AppVersionProviders = defaultProviders,
): Promise<string> {
  return (await getNativeAppVersion(providers)) ?? providers.browser();
}
