// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AvatarPicker } from "./AvatarPicker";

describe("AvatarPicker", () => {
  const onChange = vi.fn<(emoji: string) => void>();

  beforeEach(() => {
    onChange.mockReset();
  });

  it("renders the active category for the current avatar and its options", () => {
    render(<AvatarPicker value="🦸" onChange={onChange} />);

    const tablist = screen.getByRole("tablist", { name: /avatar categories/i });
    expect(tablist).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Characters avatars" })).toBeInTheDocument();

    const selectedTab = screen.getByRole("tab", { name: "Characters" });
    expect(selectedTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("radio", { name: "🦸" })).toHaveAttribute("aria-checked", "true");
  });

  it("switches category tabs and keeps aria labels in sync", async () => {
    render(<AvatarPicker value="🎬" onChange={onChange} idPrefix="profile" />);

    await fireEvent.click(screen.getByRole("tab", { name: "Animals" }));
    expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-label", "Animals avatars");

    await fireEvent.click(screen.getByRole("tab", { name: "People" }));
    expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-label", "People avatars");

    expect(screen.getByRole("radiogroup")).toHaveAttribute("id", "profile-avatar-panel");
  });

  it("calls onChange when a new avatar is selected and supports arrow-key navigation", () => {
    render(<AvatarPicker value="🧙" onChange={onChange} />);

    const current = screen.getByRole("radio", { name: "🧙" });
    const next = screen.getByRole("radio", { name: "🦸" });
    expect(current).toHaveAttribute("aria-checked", "true");

    fireEvent.click(next);
    expect(onChange).toHaveBeenCalledWith("🦸");
    onChange.mockClear();

    current.focus();
    fireEvent.keyDown(current, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("🦸");

    fireEvent.keyDown(current, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("😈");
  });

  it("supports up and down arrow navigation through computed columns", () => {
    const computedStyle = vi.spyOn(window, "getComputedStyle").mockReturnValue({
      gridTemplateColumns: "1fr 1fr",
      // keep the minimal contract the control reads
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getPropertyValue: () => "1fr 1fr",
    } as unknown as CSSStyleDeclaration);
    render(<AvatarPicker value="😀" onChange={onChange} />);

    const hero = screen.getByRole("radio", { name: "😀" });
    hero.focus();
    fireEvent.keyDown(hero, { key: "ArrowDown" });
    expect(onChange).toHaveBeenCalledWith("🤓");

    onChange.mockClear();
    fireEvent.keyDown(hero, { key: "ArrowUp" });
    expect(onChange).toHaveBeenCalledWith("👑");
    computedStyle.mockRestore();
  });

  it("uses the first item for focus when the selected avatar is unknown", () => {
    render(<AvatarPicker value="not-an-avatar" onChange={onChange} />);
    const cells = screen.getAllByRole("radio");
    expect(cells[0]).toHaveAttribute("tabIndex", "0");
    expect(cells[1]).toHaveAttribute("tabIndex", "-1");
  });
});
