import { describe, expect, it } from "vitest";
import {
  normalizeMetadataLanguage,
  normalizeMetadataRegion,
  resolveInterfaceLocale,
  translate,
} from "./localization";

describe("localization", () => {
  it("uses a supported device locale and falls back safely", () => {
    expect(resolveInterfaceLocale("system", ["fr-CA", "en-US"])).toBe("fr");
    expect(resolveInterfaceLocale("system", ["pt-PT"])).toBe("pt-BR");
    expect(resolveInterfaceLocale("system", ["ja-JP"])).toBe("en");
    expect(resolveInterfaceLocale("ar", ["en-US"])).toBe("ar");
  });

  it("normalizes metadata language and region without throwing", () => {
    expect(normalizeMetadataLanguage("fr-fr")).toBe("fr-FR");
    expect(normalizeMetadataLanguage("not_a_locale")).toBe("en-US");
    expect(normalizeMetadataRegion("ae")).toBe("AE");
    expect(normalizeMetadataRegion("USA")).toBe("US");
  });

  it("falls back to the caller's English copy for untranslated keys", () => {
    expect(translate("de", "nav.settings", "Settings")).toBe("Einstellungen");
    expect(translate("en", "nav.settings", "Settings")).toBe("Settings");
  });
});
