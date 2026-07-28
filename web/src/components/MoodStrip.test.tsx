// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("./Icon", () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}));

import { MoodStrip } from "./MoodStrip";

describe("MoodStrip", () => {
  it("renders the header and starter suggestion chips", () => {
    render(<MoodStrip />);
    expect(screen.getByText("Describe a vibe")).toBeInTheDocument();
    expect(screen.getByText("Cozy fall mysteries")).toBeInTheDocument();
    expect(screen.getByText("Slow-burn thrillers")).toBeInTheDocument();
  });

  it("disables Curate until the prompt has non-whitespace text", async () => {
    render(<MoodStrip />);
    const curate = screen.getByRole("button", { name: "Curate" });
    expect(curate).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox"), "rainy noir");
    expect(curate).toBeEnabled();
  });

  it("fires onCurate with the trimmed vibe on Curate click", async () => {
    const onCurate = vi.fn();
    render(<MoodStrip onCurate={onCurate} />);
    await userEvent.type(screen.getByRole("textbox"), "  rainy noir  ");
    await userEvent.click(screen.getByRole("button", { name: "Curate" }));
    expect(onCurate).toHaveBeenCalledWith("rainy noir");
  });

  it("fires onCurate when a suggestion chip is tapped", async () => {
    const onCurate = vi.fn();
    render(<MoodStrip onCurate={onCurate} />);
    await userEvent.click(screen.getByText("Feel-good road trips"));
    expect(onCurate).toHaveBeenCalledWith("Feel-good road trips");
  });

  it("submits the vibe on Enter in the prompt field", async () => {
    const onCurate = vi.fn();
    render(<MoodStrip onCurate={onCurate} />);
    await userEvent.type(screen.getByRole("textbox"), "noir{Enter}");
    expect(onCurate).toHaveBeenCalledWith("noir");
  });

  it("shows a loading spinner label and blocks new curation while loading", async () => {
    const onCurate = vi.fn();
    render(<MoodStrip onCurate={onCurate} loading />);
    expect(screen.getByText("Curating")).toBeInTheDocument();
    // Curate is disabled while loading.
    expect(
      screen.getByRole("button", { name: /Curating/ }),
    ).toBeDisabled();
    // Chip taps are ignored while loading.
    await userEvent.click(screen.getByText("Cozy fall mysteries"));
    expect(onCurate).not.toHaveBeenCalled();
  });

  it("renders an error message with the error styling when error is set", () => {
    render(<MoodStrip error="Something failed" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Something failed");
    expect(status).toHaveClass("is-error");
  });

  it("renders a status message when status is set and there is no error", () => {
    render(<MoodStrip status="Curating your lineup" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Curating your lineup");
    expect(status).not.toHaveClass("is-error");
  });

  it("keeps the discovery copy product-focused when AI is not available", () => {
    render(<MoodStrip aiAvailable={false} />);
    expect(
      screen.getByText("Search by mood, era, genre, or theme"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/AI key/i)).not.toBeInTheDocument();
  });

  it("applies search variant class names", () => {
    render(<MoodStrip variant="search" />);
    const heading = screen.getByText("Describe a vibe").closest("section")!;

    expect(heading).toHaveClass("mood-search");
  });
});
