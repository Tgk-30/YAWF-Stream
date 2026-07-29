import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetProfileRegistryForTesting,
  createProfileRecord,
  dbNameForProfile,
  deleteProfileRecord,
  ensureDefaultProfile,
  getActiveProfileId,
  getAutoEnterProfileId,
  getProfile,
  isMultiUserEnabled,
  listProfiles,
  setActiveProfileId,
  setAutoEnterProfileId,
  setMultiUserEnabled,
  closeProfileRegistry,
  updateProfileRecord,
} from "./ProfileRegistry";

afterEach(async () => {
  await __resetProfileRegistryForTesting();
});

describe("ProfileRegistry", () => {
  it("creates, reads, updates, and deletes registry profiles", async () => {
    await createProfileRecord({
      id: "one", name: "One", isDefault: false, isAdmin: false, createdAt: 1,
    });
    expect(await listProfiles()).toHaveLength(1);
    await updateProfileRecord("one", { name: "Renamed", color: "#7c5cff" });
    expect(await getProfile("one")).toMatchObject({ name: "Renamed", color: "#7c5cff" });
    await deleteProfileRecord("one");
    expect(await getProfile("one")).toBeUndefined();
  });

  it("seeds the default owner and tracks the active id", async () => {
    const profile = await ensureDefaultProfile({ name: "Brendan", avatar: "🎬" });
    expect(profile).toMatchObject({ id: "default", isDefault: true, isAdmin: true, name: "Brendan", avatar: "🎬" });
    expect(await getActiveProfileId()).toBe("default");
    await setActiveProfileId("other");
    expect(await getActiveProfileId()).toBe("other");
  });

  it("uses a remembered active profile when one already exists", async () => {
    await setActiveProfileId("legacy");
    await createProfileRecord({
      id: "default",
      name: "Default",
      isDefault: true,
      isAdmin: true,
      createdAt: 10,
    });

    const profile = await ensureDefaultProfile({ name: "Will not win", avatar: "" });
    expect(profile).toMatchObject({ id: "default", name: "Default" });
    expect(await getActiveProfileId()).toBe("legacy");
  });

  it("reuses the built-in default profile branch when default already exists", async () => {
    await createProfileRecord({
      id: "default",
      name: "Default",
      isDefault: true,
      isAdmin: true,
      createdAt: 10,
    });

    const profile = await ensureDefaultProfile({ name: "Ignored", avatar: "Avatar" });

    expect(profile).toMatchObject({ id: "default", name: "Default", isDefault: true });
    expect(await getActiveProfileId()).toBe("default");
  });

  it("keeps the first existing profile active and accepts seed defaults", async () => {
    await createProfileRecord({
      id: "legacy",
      name: "Legacy",
      isDefault: false,
      isAdmin: true,
      createdAt: 5,
    });
    await setActiveProfileId("legacy");

    const profile = await ensureDefaultProfile({ name: "", avatar: "" });
    expect(profile.id).toBe("legacy");
    expect(profile.name).toBe("Legacy");
    expect(await getActiveProfileId()).toBe("legacy");
  });

  it("falls back to default profile seeds when no profile exists", async () => {
    const profile = await ensureDefaultProfile({ name: "", avatar: "" });
    expect(profile.id).toBe("default");
    expect(profile.name).toBe("You");
    expect(profile.avatar).toBeUndefined();
  });

  it("defaults multi-user to enabled and persists its setting", async () => {
    expect(await isMultiUserEnabled()).toBe(true);
    await setMultiUserEnabled(false);
    expect(await isMultiUserEnabled()).toBe(false);
  });

  it("uses the legacy database for default and a named database for others", () => {
    expect(dbNameForProfile({ id: "default", isDefault: true })).toBe("debridstreamer");
    expect(dbNameForProfile({ id: "abc", isDefault: false })).toBe("debridstreamer_p_abc");
  });

  it("supports string inputs for db names and uses defaults for unknown profile state", () => {
    expect(dbNameForProfile("default", false)).toBe("debridstreamer_p_default");
    expect(dbNameForProfile("abc", true)).toBe("debridstreamer");
    expect(dbNameForProfile("abc")).toBe("debridstreamer_p_abc");
  });

  it("persists and clears auto-enter profile ids", async () => {
    expect(await getAutoEnterProfileId()).toBe(null);

    await setAutoEnterProfileId("profile-1");
    expect(await getAutoEnterProfileId()).toBe("profile-1");

    await setAutoEnterProfileId(null);
    expect(await getAutoEnterProfileId()).toBe(null);
  });

  it("falls back to the first existing profile when there is no default entry", async () => {
    await createProfileRecord({
      id: "legacy",
      name: "Legacy",
      isDefault: false,
      isAdmin: true,
      createdAt: 5,
    });

    const profile = await ensureDefaultProfile({ name: "Fallback" });
    expect(profile.id).toBe("legacy");
    expect(await getActiveProfileId()).toBe("legacy");
  });

  it("can close the profile registry database", () => {
    expect(() => closeProfileRegistry()).not.toThrow();
  });
});
