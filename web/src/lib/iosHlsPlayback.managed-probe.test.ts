import { describe, expect, it } from "vitest";
import {
  IOS_HLS_COMPATIBILITY_MIME,
  supportsStandardIosHlsMse,
} from "./iosHlsPlayback";
import { supportsManagedIosHlsMse } from "./iosManagedHlsPlayback";

class StockManagedMediaSource {
  static isTypeSupported(mime: string): boolean {
    return mime === IOS_HLS_COMPATIBILITY_MIME;
  }
  addSourceBuffer() {}
}

describe("iPhone Managed Media Source admission experiment", () => {
  it("accepts the iPhone runtime shape without a global SourceBuffer constructor", () => {
    const stockIphone = { ManagedMediaSource: StockManagedMediaSource };
    expect(supportsStandardIosHlsMse(stockIphone)).toBe(false);
    expect(supportsManagedIosHlsMse(stockIphone)).toBe(true);
  });

  it("rejects an explicitly exposed but nonfunctional SourceBuffer", () => {
    for (const malformed of [
      { SourceBuffer: { prototype: {} } },
      { WebKitSourceBuffer: { prototype: { appendBuffer() {} } } },
    ]) {
      expect(supportsManagedIosHlsMse({ ...malformed, ManagedMediaSource: StockManagedMediaSource })).toBe(false);
    }
  });

  it("requires actual ManagedMediaSource buffer creation and codec capability", () => {
    class Unsupported extends StockManagedMediaSource {
      static isTypeSupported() { return false; }
    }
    class Unsafe extends StockManagedMediaSource {
      static isTypeSupported(): never { throw new Error("not available"); }
    }
    expect(supportsManagedIosHlsMse({ ManagedMediaSource: Unsupported })).toBe(false);
    expect(supportsManagedIosHlsMse({ ManagedMediaSource: Unsafe })).toBe(false);
    expect(supportsManagedIosHlsMse({ ManagedMediaSource: class StaticOnly {
      static isTypeSupported() { return true; }
    } })).toBe(false);
    expect(supportsManagedIosHlsMse({})).toBe(false);
  });
});
