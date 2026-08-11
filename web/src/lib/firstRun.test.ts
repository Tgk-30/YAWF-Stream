import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DexieStore } from "../storage/DexieStore";
import { __setStoreForTesting, getStore } from "../storage";
import {
  hasQuickSetupAcknowledgement,
  isFirstRun,
  markOnboardingComplete,
  markQuickSetupAcknowledged,
  needsKeyOnboarding,
} from "./firstRun";

const g = globalThis as Record<string, unknown>;
let counter = 0;

describe("firstRun", () => {
  beforeEach(() => {
    counter += 1;
    __setStoreForTesting(new DexieStore(`first-run-${counter}-${Date.now()}`));
    delete g.__DEBRIDSTREAMER_SERVER_URL__;
  });
  afterEach(() => {
    __setStoreForTesting(null);
    delete g.__DEBRIDSTREAMER_SERVER_URL__;
  });

  it("is true on a fresh local install", async () => {
    await expect(isFirstRun()).resolves.toBe(true);
  });

  it("is false after onboarding is marked complete", async () => {
    expect(await isFirstRun()).toBe(true);
    await markOnboardingComplete();
    expect(await isFirstRun()).toBe(false);
  });

  it("never shows on a server-pinned build (configured server URL)", async () => {
    g.__DEBRIDSTREAMER_SERVER_URL__ = "https://stream.example.com";
    await expect(isFirstRun()).resolves.toBe(false);
  });

  it("does NOT treat storage_port_initialized as the onboarding flag", async () => {
    await getStore().setSetting("storage_port_initialized", "true");
    await expect(isFirstRun()).resolves.toBe(true);
  });

  it("persists the deliberate Quick setup acknowledgement across reads", async () => {
    await expect(hasQuickSetupAcknowledgement()).resolves.toBe(false);
    await markQuickSetupAcknowledged();
    await expect(hasQuickSetupAcknowledgement()).resolves.toBe(true);
  });
});

describe("needsKeyOnboarding", () => {
  const base = { serverMode: false, hasTmdb: false, omdbKey: "", hasDebrid: false };

  it("forces when nothing is configured", () => {
    expect(needsKeyOnboarding(base)).toBe(true);
  });

  it("forces with a catalog key but no debrid token", () => {
    expect(needsKeyOnboarding({ ...base, hasTmdb: true })).toBe(true);
  });

  it("forces with a debrid token but no catalog key", () => {
    expect(needsKeyOnboarding({ ...base, hasDebrid: true })).toBe(true);
  });

  it("passes with TMDB + debrid", () => {
    expect(needsKeyOnboarding({ ...base, hasTmdb: true, hasDebrid: true })).toBe(false);
  });

  it("accepts an OMDb key as the catalog minimum", () => {
    expect(
      needsKeyOnboarding({ ...base, omdbKey: "abc123", hasDebrid: true }),
    ).toBe(false);
  });

  it("ignores a whitespace-only OMDb key", () => {
    expect(needsKeyOnboarding({ ...base, omdbKey: "   ", hasDebrid: true })).toBe(true);
  });

  it("never forces in Server Mode (the server owns keys)", () => {
    expect(needsKeyOnboarding({ ...base, serverMode: true })).toBe(false);
  });

  it("does not force missing keys after the deliberate Quick setup route", () => {
    expect(needsKeyOnboarding({ ...base, quickSetupAcknowledged: true })).toBe(false);
  });
});
