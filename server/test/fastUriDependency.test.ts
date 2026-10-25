import { describe, expect, it } from "vitest";
import fastUri from "fast-uri";

describe("fast-uri security backport", () => {
  it("rejects a percent-encoded URI scheme instead of activating it", () => {
    const encodedScheme = "%6Aavascript:alert(1)";

    expect(fastUri.parse(encodedScheme).error).toBe("URI scheme is malformed.");
    expect(fastUri.normalize(encodedScheme)).toBe(encodedScheme);
    expect(fastUri.equal(encodedScheme, encodedScheme)).toBe(false);
    expect(() => fastUri.resolve("https://example.com/app/", encodedScheme)).toThrow(
      "URI scheme is malformed.",
    );
  });
});
