// @vitest-environment jsdom
//
// Component coverage for the first-run feature tour. Verifies the step sequence,
// Back/Next gating, the progress counter/dots, keyboard navigation, and every
// dismissal path (Skip button, Escape, Get started on the last step).

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { WelcomeGuide } from "./WelcomeGuide";

const TOTAL = 7;

describe("WelcomeGuide", () => {
  beforeEach(() => vi.clearAllMocks());

  it("backs the translucent card tint with an opaque theme surface", () => {
    const css = readFileSync("src/components/WelcomeGuide.css", "utf8");
    const cardRule = css.match(/\.welcome-card\s*\{([^}]*)\}/s)?.[1] ?? "";

    expect(cardRule).toContain(
      "linear-gradient(var(--glass-tint-hero), var(--glass-tint-hero)),",
    );
    expect(cardRule).toContain("var(--bg-2, rgb(12, 13, 18))");
    expect(cardRule).toContain(
      "backdrop-filter: blur(var(--glass-blur-hero, 36px)) saturate(1.3)",
    );
  });

  it("renders the first step with Back disabled and the 1 / N counter", () => {
    render(<WelcomeGuide onClose={() => {}} />);
    expect(
      screen.getByRole("dialog", { name: "Welcome tour" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Welcome to YAWF Stream")).toBeInTheDocument();
    expect(screen.getByText(`1 / ${TOTAL}`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
  });

  it("advances through steps with Next and the counter tracks", async () => {
    const user = userEvent.setup();
    render(<WelcomeGuide onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(`2 / ${TOTAL}`)).toBeInTheDocument();
    // Step content swaps after the AnimatePresence exit/enter completes.
    expect(await screen.findByText("How it works")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
  });

  it("steps backward with Back", async () => {
    const user = userEvent.setup();
    render(<WelcomeGuide onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(`3 / ${TOTAL}`)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText(`2 / ${TOTAL}`)).toBeInTheDocument();
  });

  it("renders keycap chips on the shortcut step", async () => {
    const user = userEvent.setup();
    render(<WelcomeGuide onClose={() => {}} />);
    // Step 5 (index 4) carries the ⌘ K keys.
    for (let i = 0; i < 4; i++) {
      await user.click(screen.getByRole("button", { name: "Next" }));
    }
    expect(screen.getByText(`5 / ${TOTAL}`)).toBeInTheDocument();
    expect(await screen.findByText("Move fast")).toBeInTheDocument();
    expect(screen.getByText("⌘")).toBeInTheDocument();
    expect(screen.getByText("K")).toBeInTheDocument();
  });

  it("describes vibe discovery without claiming AI is configured", async () => {
    const user = userEvent.setup();
    render(<WelcomeGuide onClose={() => {}} />);
    for (let i = 0; i < 3; i++) {
      await user.click(screen.getByRole("button", { name: "Next" }));
    }
    expect(screen.getByText(/describe a vibe/i)).toHaveTextContent(
      "Browse Discover or search any title without AI. If you configure AI later",
    );
    expect(screen.queryByText(/let the AI build a lineup/i)).not.toBeInTheDocument();
  });

  it("shows 'Get started' on the last step and calls onClose when clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<WelcomeGuide onClose={onClose} />);
    for (let i = 0; i < TOTAL - 1; i++) {
      await user.click(screen.getByRole("button", { name: "Next" }));
    }
    expect(screen.getByText(`${TOTAL} / ${TOTAL}`)).toBeInTheDocument();
    const finish = screen.getByRole("button", { name: "Get started" });
    expect(finish).toBeInTheDocument();
    await user.click(finish);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers an 'Open Settings' path on the last step when onOpenSettings is given", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onOpenSettings = vi.fn();
    render(<WelcomeGuide onClose={onClose} onOpenSettings={onOpenSettings} />);
    // No setup CTA on earlier steps.
    expect(
      screen.queryByRole("button", { name: /Set up streaming in Settings/i }),
    ).not.toBeInTheDocument();
    for (let i = 0; i < TOTAL - 1; i++) {
      await user.click(screen.getByRole("button", { name: "Next" }));
    }
    const cta = await screen.findByRole("button", {
      name: /Set up streaming in Settings/i,
    });
    await user.click(cta);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lets focused setup CTA Enter open Settings instead of treating it as global Next", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onOpenSettings = vi.fn();
    render(<WelcomeGuide onClose={onClose} onOpenSettings={onOpenSettings} />);
    for (let i = 0; i < TOTAL - 1; i++) {
      await user.click(screen.getByRole("button", { name: "Next" }));
    }
    const cta = screen.getByRole("button", { name: /Set up streaming in Settings/i });
    cta.focus();
    await user.keyboard("{Enter}");
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Skip dismisses the tour via onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<WelcomeGuide onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Skip the tour" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lets focused Skip Enter dismiss instead of advancing the tour", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<WelcomeGuide onClose={onClose} />);
    const skip = screen.getByRole("button", { name: "Skip the tour" });
    skip.focus();
    await user.keyboard("{Enter}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByText(`1 / ${TOTAL}`)).toBeInTheDocument();
  });

  it("lets focused Back Enter move backward instead of advancing globally", async () => {
    const user = userEvent.setup();
    render(<WelcomeGuide onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    const back = screen.getByRole("button", { name: "Back" });
    back.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByText(`2 / ${TOTAL}`)).toBeInTheDocument();
  });

  it("Escape dismisses the tour", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<WelcomeGuide onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ArrowRight/Enter advance and ArrowLeft goes back via keyboard", async () => {
    const user = userEvent.setup();
    render(<WelcomeGuide onClose={() => {}} />);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText(`2 / ${TOTAL}`)).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(screen.getByText(`3 / ${TOTAL}`)).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByText(`2 / ${TOTAL}`)).toBeInTheDocument();
  });

  it("Enter on the last step closes (Next maps to onClose)", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<WelcomeGuide onClose={onClose} />);
    for (let i = 0; i < TOTAL - 1; i++) {
      await user.click(screen.getByRole("button", { name: "Next" }));
    }
    await user.keyboard("{Enter}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Back never goes below the first step", async () => {
    const user = userEvent.setup();
    render(<WelcomeGuide onClose={() => {}} />);
    // Back is disabled at step 0, but ArrowLeft handler also clamps at 0.
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByText(`1 / ${TOTAL}`)).toBeInTheDocument();
  });

  it("ignores unrelated keyboard keys", async () => {
    const user = userEvent.setup();
    render(<WelcomeGuide onClose={() => {}} />);
    await user.keyboard("{Tab}");
    expect(screen.getByText(`1 / ${TOTAL}`)).toBeInTheDocument();
  });
});
