import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("zod collection limits", () => {
  it("rejects over-limit arrays before element refiners while accepting bounded input", () => {
    let refinements = 0;
    const schema = z.array(z.number().refine(() => {
      refinements += 1;
      return true;
    })).max(2);

    expect(schema.safeParse([1, 2]).success).toBe(true);
    expect(refinements).toBe(2);
    expect(schema.safeParse([1, 2, 3]).success).toBe(false);
    expect(refinements).toBe(2);
  });
});
