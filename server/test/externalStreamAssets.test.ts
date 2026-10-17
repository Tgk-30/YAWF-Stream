import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalStreamAssets } from "../src/externalStreamAssets.js";

const expiry = () => new Date(Date.now() + 60_000).toISOString();
const asset = (name: string) => ({ url: `https://media.example/${name}`, kind: "asset" as const });
afterEach(() => vi.useRealTimers());

describe("external stream discovered-asset index", () => {
  it("isolates graphs and only exposes registered exact opaque IDs", () => {
    const registry = new ExternalStreamAssets();
    const entry = asset("segment.ts?private=fixture");
    const id = ExternalStreamAssets.id(entry);
    registry.register("one", expiry(), [entry, entry]);
    expect(id).toMatch(/^[a-f0-9]{64}\.ts$/);
    expect(id).not.toContain("private");
    expect(registry.get("one", id)).toEqual(entry);
    expect(registry.get("two", id)).toBeNull();
    expect(registry.get("one", "https://other.example/video")).toBeNull();
    expect(registry.get("one", `${id}/../other`)).toBeNull();
    const copy = registry.get("one", id)!;
    copy.url = "https://other.example/";
    expect(registry.get("one", id)).toEqual(entry);
    registry.remove("one");
    expect(registry.get("one", id)).toBeNull();
  });

  it.each(["ts", "m4s", "mp4", "aac", "vtt", "key", "json"])("retains safe %s suffixes for media demuxers", (suffix) => {
    expect(ExternalStreamAssets.id(asset(`private-name.${suffix}?private=query`)))
      .toMatch(new RegExp(`^[a-f0-9]{64}\\.${suffix}$`));
    expect(ExternalStreamAssets.id(asset("extensionless"))).toMatch(/\.ts$/);
    expect(ExternalStreamAssets.id(asset("segment.verylongextension"))).toMatch(/\.ts$/);
  });

  it("retires expired entries and distinguishes playlists from byte assets", () => {
    vi.useFakeTimers();
    const registry = new ExternalStreamAssets();
    const byteAsset = asset("extensionless");
    const manifest = { ...byteAsset, kind: "manifest" as const };
    registry.register("one", expiry(), [byteAsset, manifest]);
    expect(ExternalStreamAssets.id(manifest)).toMatch(/\.m3u8$/);
    expect(ExternalStreamAssets.id(manifest)).not.toBe(ExternalStreamAssets.id(byteAsset));
    vi.advanceTimersByTime(60_001);
    expect(registry.get("one", ExternalStreamAssets.id(byteAsset))).toBeNull();
    expect(() => registry.register("one", "not-a-date", [byteAsset])).toThrow();
  });

  it("bounds sessions with least-recently-used retirement", () => {
    const registry = new ExternalStreamAssets({ sessions: 2, assetsPerSession: 4, assets: 4, urlBytes: 1000 });
    const one = asset("one");
    registry.register("one", expiry(), [one]);
    registry.register("two", expiry(), [one]);
    expect(registry.get("one", ExternalStreamAssets.id(one))).toEqual(one);
    registry.register("three", expiry(), [one]);
    expect(registry.get("two", ExternalStreamAssets.id(one))).toBeNull();
    expect(registry.get("one", ExternalStreamAssets.id(one))).toEqual(one);
  });

  it("fails atomically on per-stream and global asset/URL budgets", () => {
    const entries = [asset("one"), asset("two")];
    for (const limits of [
      { sessions: 2, assetsPerSession: 1, assets: 5, urlBytes: 1000 },
      { sessions: 2, assetsPerSession: 5, assets: 1, urlBytes: 1000 },
      { sessions: 2, assetsPerSession: 5, assets: 5, urlBytes: 1 },
    ]) {
      const registry = new ExternalStreamAssets(limits);
      expect(() => registry.register("one", expiry(), entries)).toThrow("asset budget");
      expect(registry.get("one", ExternalStreamAssets.id(entries[0]!))).toBeNull();
    }
    const registry = new ExternalStreamAssets({ sessions: 2, assetsPerSession: 1, assets: 4, urlBytes: 1000 });
    registry.register("one", expiry(), [entries[0]!]);
    expect(() => registry.register("one", expiry(), [entries[1]!])).toThrow();
    expect(registry.get("one", ExternalStreamAssets.id(entries[0]!))).toEqual(entries[0]);
    registry.clear();
    expect(registry.get("one", ExternalStreamAssets.id(entries[0]!))).toBeNull();
  });
});
