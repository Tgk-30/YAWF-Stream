// First-run detection for the persona onboarding wizard.
//
// The wizard is a LOCAL-MODE concern: a server-pinned build (configured server
// URL) goes straight to ServerModeGate's auth, never the wizard. We use a
// dedicated `onboarding_completed` Store flag - NOT `storage_port_initialized`,
// which flips on the first settings load before the user has done anything.

import { getStore } from "../storage";
import { configuredServerURL } from "./serverMode";

const ONBOARDING_KEY = "onboarding_completed";
const QUICK_SETUP_ACK_KEY = "quick_setup_acknowledged";

export function devBypassesOnboarding(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").has("qa-skip-onboarding");
  } catch {
    return false;
  }
}

/** The FORCED key gate: in Local Mode the app is unusable without a catalog
 *  key (TMDB or OMDb) and can't stream without a debrid token, so a launch
 *  missing either re-opens the wizard as mandatory - regardless of the
 *  onboarding_completed flag. Pure so the rule is unit-testable; the caller
 *  supplies effective state (env-provided TMDB keys count via hasTmdb). */
export function needsKeyOnboarding(input: {
  serverMode: boolean;
  hasTmdb: boolean;
  omdbKey: string;
  hasDebrid: boolean;
  quickSetupAcknowledged?: boolean;
}): boolean {
  if (input.serverMode) return false;
  if (input.quickSetupAcknowledged === true) return false;
  const hasCatalog = input.hasTmdb || input.omdbKey.trim().length > 0;
  return !hasCatalog || !input.hasDebrid;
}

export async function hasQuickSetupAcknowledgement(): Promise<boolean> {
  try {
    return (await getStore().getSetting(QUICK_SETUP_ACK_KEY)) === "true";
  } catch {
    return false;
  }
}

/** Deliberate keyless-route acknowledgement. It suppresses only the forced
 * credential gate; Settings remains available and no credential is created. */
export async function markQuickSetupAcknowledged(): Promise<void> {
  await getStore().setSetting(QUICK_SETUP_ACK_KEY, "true");
}

/** True only on a genuine first run in Local Mode (no prior onboarding, no
 *  configured server URL). */
export async function isFirstRun(): Promise<boolean> {
  if (devBypassesOnboarding()) return false;
  if (configuredServerURL() != null) return false;
  try {
    const done = await getStore().getSetting(ONBOARDING_KEY);
    return done == null;
  } catch {
    // If the store can't be read, don't trap the user behind onboarding.
    return false;
  }
}

/** Persist that onboarding is finished so the wizard never reappears. */
export async function markOnboardingComplete(): Promise<void> {
  try {
    await getStore().setSetting(ONBOARDING_KEY, "true");
  } catch {
    // Non-fatal - worst case the wizard shows again next launch.
  }
}
