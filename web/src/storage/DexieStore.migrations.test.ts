import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { DexieStore } from "./DexieStore";
import { LEGACY_DEXIE_FIXTURES } from "./fixtures/legacyDexieFixtures";

const databases = new Set<string>();

afterEach(async () => {
  for (const name of databases) await Dexie.delete(name);
  databases.clear();
});

describe("versioned IndexedDB migrations", () => {
  for (const fixture of LEGACY_DEXIE_FIXTURES) {
    it(`upgrades the ${fixture.name} fixture without losing records`, async () => {
      const name = `migration-fixture-${fixture.version}-${Date.now()}-${Math.random()}`;
      databases.add(name);
      const legacy = new Dexie(name);
      legacy.version(fixture.version).stores(fixture.schema);
      await legacy.open();
      for (const [tableName, rows] of Object.entries(fixture.rows)) {
        if (rows.length > 0) await legacy.table(tableName).bulkPut(rows);
      }
      legacy.close();

      const upgraded = new DexieStore(name);
      try {
        expect(await upgraded.table("settings").get("ui_theme")).toEqual(
          fixture.rows.settings?.[0],
        );
        for (const [tableName, rows] of Object.entries(fixture.rows)) {
          expect(await upgraded.table(tableName).count(), tableName).toBe(rows.length);
        }
        const watchlist = await upgraded.table("watchlist").toArray() as Array<{
          folderId?: string | null;
        }>;
        expect(watchlist.every((row) => row.folderId === null)).toBe(true);
        expect(upgraded.table("watchlist").schema.idxByName.folderId).toBeDefined();
        expect(upgraded.tables.map((table) => table.name)).toEqual(
          expect.arrayContaining(["watchlistFolders", "downloads", "cachedResolutions"]),
        );
        expect(upgraded.verno).toBe(7);
        const history = await upgraded.table("watchHistory").toArray() as Array<{
          queuedNext?: boolean;
        }>;
        expect(history.every((row) => row.queuedNext === false)).toBe(true);
      } finally {
        upgraded.close();
      }

      const reopened = new DexieStore(name);
      try {
        expect(await reopened.table("watchlist").count()).toBe(1);
        expect(reopened.verno).toBe(7);
      } finally {
        reopened.close();
      }
    });
  }
});
