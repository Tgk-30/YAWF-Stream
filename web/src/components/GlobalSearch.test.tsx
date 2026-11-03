// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";

const globalSearchCss = readFileSync("src/components/GlobalSearch.css", "utf8");
const appCss = readFileSync("src/App.css", "utf8");

vi.mock("./Icon", () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}));
const search = vi.fn();
vi.mock("../store/AppStore", () => ({
  useAppActions: () => ({ search }),
}));

import { GlobalSearch } from "./GlobalSearch";

beforeEach(() => search.mockClear());

describe("GlobalSearch", () => {
  it("renders the search field with a magnifier and no clear button initially", () => {
    render(<GlobalSearch />);
    expect(
      screen.getByRole("textbox", { name: "Search movies and shows" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("icon-search")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Clear search" }),
    ).not.toBeInTheDocument();
  });

  it("reveals the clear button once there is text and clears on click", async () => {
    render(<GlobalSearch />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    await userEvent.type(input, "dune");
    const clear = screen.getByRole("button", { name: "Clear search" });
    expect(clear).toBeInTheDocument();
    await userEvent.click(clear);
    expect(input.value).toBe("");
    expect(
      screen.queryByRole("button", { name: "Clear search" }),
    ).not.toBeInTheDocument();
  });

  it("submits the trimmed query on Enter", async () => {
    render(<GlobalSearch />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "  dune  {Enter}");
    expect(search).toHaveBeenCalledWith("dune");
  });

  it("does not submit a blank/whitespace-only query", async () => {
    render(<GlobalSearch />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "   {Enter}");
    expect(search).not.toHaveBeenCalled();
  });
});

// This guards CSS source, not browser sticky geometry or native hit testing.
describe("GlobalSearch responsive positioning contract", () => {
  it("preserves the local phone and short-landscape sticky gap inside the inset scrollport", () => {
    const mobileRule = globalSearchCss.match(
      /@media\s*\(max-width:\s*699px\),\s*\(max-width:\s*950px\)\s*and\s*\(max-height:\s*500px\)\s*\{\s*\.global-search\s*\{([^}]+)\}/,
    )?.[1] ?? "";
    expect(mobileRule).toMatch(/position:\s*sticky;/);
    expect(mobileRule).toMatch(/top:\s*var\(--sp-sm\);/);
    expect(mobileRule).not.toContain("--safe-area-top");
    const mobileAppRule = appCss.match(
      /@media\s*\(max-width:\s*699px\),\s*\(max-width:\s*950px\)\s*and\s*\(max-height:\s*500px\)\s*\{[\s\S]*?\.app-content\s*\{([^}]+)\}/,
    )?.[1] ?? "";
    expect(mobileAppRule).toMatch(/padding-top:\s*var\(--safe-area-top\);/);
    expect(mobileAppRule).toMatch(/scroll-padding-top:\s*var\(--safe-area-top\);/);
    expect(mobileRule).not.toContain("--app-content-safe-top-consumed");
    expect(mobileRule).toContain("max(var(--sp-lg), var(--safe-area-right))");
    expect(mobileRule).toContain("max(var(--sp-lg), var(--safe-area-left))");
  });

  it("keeps coarse-pointer non-phone search in full safe viewport coordinates", () => {
    const coarseRule = globalSearchCss.match(
      /@media\s*\(pointer:\s*coarse\)\s*\{\s*(?:\/\*[\s\S]*?\*\/\s*)*\.global-search\s*\{([^}]+)\}/,
    )?.[1] ?? "";
    expect(coarseRule).toMatch(/position:\s*fixed;/);
    expect(coarseRule).toMatch(/top:\s*max\(var\(--sp-md\),\s*var\(--safe-area-top\)\);/);
    expect(coarseRule).not.toMatch(/(?:--app-content-safe-top-consumed|(?:right|left|width|z-index)\s*:)/);
    expect(globalSearchCss.indexOf("@media (pointer: coarse) {")).toBeLessThan(
      globalSearchCss.indexOf("@media (max-width: 699px), (max-width: 950px) and (max-height: 500px) {"),
    );
  });

  it("bounds only non-phone coarse search between the current rail and safe profile reserve", () => {
    const header = "@media (pointer: coarse) and (min-width: 951px),\n  (pointer: coarse) and (min-width: 700px) and (min-height: 501px) {";
    const rule = globalSearchCss.slice(globalSearchCss.indexOf(header)).match(/\.global-search\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(globalSearchCss).toContain(header);
    expect(rule).toMatch(/--global-search-right-reserve:\s*calc\(max\(var\(--sp-lg\),\s*var\(--safe-area-right\)\)\s*\+\s*44px\s*\+\s*var\(--sp-md\)\);/);
    expect(rule).toMatch(/right:\s*var\(--global-search-right-reserve\);/);
    expect(rule).toMatch(/width:\s*min\(520px,\s*max\(0px,\s*calc\(100%\s*-\s*max\(var\(--nav-safe-left,\s*0px\),\s*var\(--sp-lg\),\s*var\(--safe-area-left\)\)\s*-\s*var\(--global-search-right-reserve\)\)\)\);/);
    expect(globalSearchCss.indexOf(header)).toBeGreaterThan(
      globalSearchCss.indexOf("@media (min-width: 700px) and (max-width: 1199px) and (min-height: 501px) {"),
    );
  });

  it("retains absolute desktop and tablet search with its consumed top inset", () => {
    const baseRule = globalSearchCss.match(/\.global-search\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(baseRule).toMatch(/position:\s*absolute;/);
    expect(baseRule).toMatch(
      /top:\s*calc\(max\(var\(--sp-md\),\s*var\(--safe-area-top\)\)\s*-\s*var\(--app-content-safe-top-consumed,\s*0rem\)\);/,
    );
    expect(baseRule).toMatch(/width:\s*320px;/);
  });
});
