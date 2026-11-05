// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("./Icon", () => ({ Icon: () => <span data-testid="icon" /> }));

import { SettingsSearch } from "./SettingsSearch";

const ALL = new Set([
  "appearance",
  "playback",
  "privacy",
  "profiles",
  "keys",
  "debrid",
  "sources",
  "updates",
  "install",
  "server",
]);

describe("SettingsSearch", () => {
  it("backs floating search results with an opaque theme surface and 44px actions", () => {
    const css = readFileSync("src/components/SettingsSearch.css", "utf8");
    const surface = css.match(/\.settings-search-results\.glass-raised\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(surface, "floating search results must obscure underlying category labels without blur").toMatch(/background:\s*var\(--bg-1\)\s*;/);
    for (const selector of [".settings-search-result", ".settings-search-empty button"]) {
      const block = css.slice(css.indexOf(`${selector} {`)).split("}")[0];
      expect(block, `${selector} must retain a 44px minimum action target`).toMatch(/min-height:\s*44px/);
    }
  });

  it("surfaces matches and jumps to the setting's tab on click", async () => {
    const onJump = vi.fn();
    const user = userEvent.setup();
    render(<SettingsSearch onJump={onJump} visibleTabs={ALL} />);
    await user.type(screen.getByLabelText("Search settings"), "player");
    const result = await screen.findByRole("button", { name: /Built-in player/ });
    await user.click(result);
    expect(onJump).toHaveBeenCalledWith("playback");
  });

  it("matches on keywords not present in the visible label", async () => {
    const onJump = vi.fn();
    const user = userEvent.setup();
    render(<SettingsSearch onJump={onJump} visibleTabs={ALL} />);
    // "landing" is a keyword of the "Start on (default tab)" entry.
    await user.type(screen.getByLabelText("Search settings"), "landing");
    await user.click(await screen.findByRole("button", { name: /Start on/ }));
    expect(onJump).toHaveBeenCalledWith("appearance");
  });

  it("hides results whose tab is not currently visible", async () => {
    const user = userEvent.setup();
    render(
      <SettingsSearch onJump={vi.fn()} visibleTabs={new Set(["appearance"])} />,
    );
    // "debrid" lives on the Providers tab, which isn't visible here.
    await user.type(screen.getByLabelText("Search settings"), "debrid");
    expect(screen.queryByRole("button", { name: /Debrid provider/ })).toBeNull();
    expect(screen.getByText("No settings match “debrid”")).toBeInTheDocument();
  });

  it("shows nothing for a query shorter than 2 characters", async () => {
    const user = userEvent.setup();
    render(<SettingsSearch onJump={vi.fn()} visibleTabs={ALL} />);
    await user.type(screen.getByLabelText("Search settings"), "a");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("searches profile appearance and protection controls", async () => {
    const onJump = vi.fn();
    const user = userEvent.setup();
    render(<SettingsSearch onJump={onJump} visibleTabs={ALL} />);

    await user.type(screen.getByLabelText("Search settings"), "avatar");
    await user.click(screen.getByRole("button", { name: /Avatar and profile color/ }));

    expect(onJump).toHaveBeenCalledWith("profiles");
  });

  it("shows a clear action when no settings match", async () => {
    const user = userEvent.setup();
    render(<SettingsSearch onJump={vi.fn()} visibleTabs={ALL} />);

    const input = screen.getByLabelText("Search settings");
    await user.type(input, "definitely missing");
    expect(screen.getByText("No settings match “definitely missing”")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(input).toHaveValue("");
    expect(screen.queryByText(/No settings match/)).toBeNull();
  });

  it.each([
    ["audio", "Default audio language"],
    ["subtitle", "Default subtitles"],
    ["speed", "Default playback speed"],
    ["volume", "Default volume"],
    ["remember", "Remember audio and subtitle choices per title"],
  ])("finds the real %s playback setting and jumps to the reachable Playback tab", async (query, label) => {
    const onJump = vi.fn();
    render(<SettingsSearch onJump={onJump} visibleTabs={ALL} />);
    await userEvent.type(screen.getByLabelText("Search settings"), query);
    const result = screen.getByRole("button", { name: `${label}Playback` });
    expect(readFileSync("src/screens/Settings.tsx", "utf8")).toContain(label);
    await userEvent.click(result);
    expect(onJump).toHaveBeenCalledWith("playback");
  });

  it.each(["audio", "subtitle"])("does not expose %s matches when Playback is unreachable", async (query) => {
    const onJump = vi.fn();
    render(<SettingsSearch onJump={onJump} visibleTabs={new Set(["appearance"])} />);
    await userEvent.type(screen.getByLabelText("Search settings"), query);
    expect(screen.getByText(`No settings match “${query}”`)).toBeInTheDocument();
    expect(onJump).not.toHaveBeenCalled();
  });

});
