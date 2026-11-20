import { describe, expect, it } from "vitest";
import { storageEquivalenceStep } from "./fixtures/storageEquivalenceDiagnostics.js";

describe("Windows storage test-only diagnostics", () => {
  it("does not change a successful observation", () => {
    const result = { equivalent: true };
    expect(storageEquivalenceStep("descriptor-comparison", () => result)).toBe(result);
  });

  it.each([
    ["ETIMEDOUT", undefined, "timeout"],
    ["ENOENT", undefined, "not-found"],
    ["EPERM", undefined, "access-denied"],
    ["ENOBUFS", undefined, "output-limit"],
    [undefined, 2, "nonzero-exit"],
    ["invented-private-process-code", undefined, "assertion-or-unclassified"],
  ])("retains only an allowlisted category for code %s", (code, status, category) => {
    const hidden = "synthetic private path or descriptor";
    const raw = Object.assign(new Error(hidden, { cause: new Error(hidden) }), {
      code, status, stdout: hidden, stderr: hidden, path: hidden,
    });
    try {
      storageEquivalenceStep("reference-descriptor", () => { throw raw; });
      expect.unreachable("An unsuccessful observation must still fail");
    } catch (error) {
      expect(error).not.toBe(raw);
      expect(error).toMatchObject({
        message: `Native descriptor equivalence failed at reference-descriptor (${category}). Raw observations were not retained.`,
      });
      expect(error).not.toHaveProperty("cause");
      expect(error).not.toHaveProperty("stdout");
      expect(error).not.toHaveProperty("stderr");
      expect(error).not.toHaveProperty("path");
      expect((error as Error).stack).not.toContain(hidden);
    }
  });
});
