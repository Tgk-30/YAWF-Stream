import { describe, expect, it } from "vitest";
import { visibleTabs } from "./Settings";

describe("visibleTabs", () => {
  const ids = (opts: { serverMode: boolean; simpleMode: boolean }) =>
    visibleTabs(opts).map((t) => t.id);

  it("Advanced + Server Mode shows all 10 tabs", () => {
    expect(ids({ serverMode: true, simpleMode: false })).toEqual([
      "appearance",
      "language",
      "playback",
      "privacy",
      "install",
      "updates",
      "server",
      "keys",
      "debrid",
      "sources",
    ]);
  });

  it("Advanced + Local hides only the Server tab", () => {
    const out = ids({ serverMode: false, simpleMode: false });
    expect(out).not.toContain("server");
    expect(out).toContain("sources");
    expect(out).toContain("updates");
  });

  it("Simple keeps help and diagnostics visible while hiding server and sources", () => {
    const out = ids({ serverMode: true, simpleMode: true });
    expect(out).toEqual([
      "appearance",
      "language",
      "playback",
      "privacy",
      "install",
      "updates",
      "keys",
      "debrid",
    ]);
    expect(out).toContain("updates");
    expect(out).not.toContain("server");
    expect(out).not.toContain("sources");
  });

  it("Simple + Local also hides the Server tab", () => {
    expect(ids({ serverMode: false, simpleMode: true })).not.toContain("server");
  });
});
