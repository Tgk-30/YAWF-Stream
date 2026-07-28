// @vitest-environment jsdom
//
// A11y regression: the card itself is the single keyboard-accessible button
// (opens Detail); the hover Play/More-info affordances are decorative and must
// be aria-hidden (not exposed as unreachable interactive controls).

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MediaCard } from "./MediaCard";
import type { MediaPreview } from "../models/media";

const item: MediaPreview = { id: "tt1", type: "movie", title: "Inception" };

function renderCard(
  overrides: Partial<MediaPreview> = {},
  showPosterRatings = true,
) {
  return render(
    <MediaCard
      item={{ ...item, ...overrides }}
      onSelect={() => {}}
      showPosterRatings={showPosterRatings}
    />,
  );
}

describe("MediaCard poster rating badge", () => {
  it("shows a rated card's persistent badge only while the preference is on", () => {
    const { rerender } = renderCard({ imdbRating: 8.2 });
    expect(screen.getByLabelText("Rating 8.2 out of 10")).toBeInTheDocument();

    rerender(
      <MediaCard
        item={{ ...item, imdbRating: 8.2 }}
        onSelect={() => {}}
        showPosterRatings={false}
      />,
    );
    expect(screen.queryByLabelText("Rating 8.2 out of 10")).toBeNull();
  });

  it("never shows a persistent badge for a ratingless card", () => {
    renderCard();
    expect(screen.queryByLabelText(/Rating .* out of 10/)).toBeNull();
  });
});

describe("MediaCard a11y", () => {
  it("exposes a single button with the title as its accessible name", () => {
    render(<MediaCard item={item} onSelect={() => {}} showPosterRatings={false} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Inception" }),
    ).toBeInTheDocument();
  });

  it("marks the decorative hover actions aria-hidden", () => {
    const { container } = render(
      <MediaCard item={item} onSelect={() => {}} showPosterRatings={false} />,
    );
    const actions = container.querySelector(".media-card-reveal-actions");
    expect(actions).not.toBeNull();
    expect(actions).toHaveAttribute("aria-hidden", "true");
  });

  it("invokes onSelect when the card is activated by keyboard", async () => {
    const onSelect = vi.fn();
    render(<MediaCard item={item} onSelect={onSelect} showPosterRatings={false} />);
    const card = screen.getByRole("button", { name: "Inception" });
    card.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(item);
  });
});

describe("MediaCard watched badge", () => {
  it("renders a Watched badge only when watched is set", () => {
    const { rerender } = render(
      <MediaCard item={item} onSelect={() => {}} showPosterRatings={false} />,
    );
    expect(screen.queryByLabelText("Watched")).toBeNull();

    rerender(<MediaCard item={item} onSelect={() => {}} watched showPosterRatings={false} />);
    expect(screen.getByLabelText("Watched")).toBeInTheDocument();
  });

  it("keeps the card a single button when the badge is shown (badge is not interactive)", () => {
    render(<MediaCard item={item} onSelect={() => {}} watched showPosterRatings={false} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});

describe("MediaCard play action fallback", () => {
  it("falls back to onSelect when onPlay is absent", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <MediaCard
        item={{ ...item, posterPath: "/poster.jpg" }}
        onSelect={onSelect}
        showPosterRatings={false}
      />
    );

    const playButton = container.querySelector(".media-card-play");
    if (playButton == null) {
      throw new Error("play affordance should be present");
    }
    fireEvent.click(playButton);

    expect(onSelect).toHaveBeenCalledWith({ ...item, posterPath: "/poster.jpg" });
  });

  it("uses onPlay directly when provided", () => {
    const onSelect = vi.fn();
    const onPlay = vi.fn();
    const { container } = render(
      <MediaCard
        item={{ ...item, posterPath: "/poster.jpg" }}
        onSelect={onSelect}
        onPlay={onPlay}
        showPosterRatings={false}
      />
    );

    const playButton = container.querySelector(".media-card-play");
    if (playButton == null) {
      throw new Error("play affordance should be present");
    }
    fireEvent.click(playButton);

    expect(onPlay).toHaveBeenCalledWith({ ...item, posterPath: "/poster.jpg" });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("MediaCard poster fallback", () => {
  it("uses the designed fallback for both a missing and failed search-result poster", () => {
    const noPoster: MediaPreview = { ...item, id: "missing", posterPath: null };
    const { container, rerender } = render(
      <MediaCard item={noPoster} onSelect={() => {}} showPosterRatings={false} />,
    );
    expect(container.querySelector(".media-card-fallback")).toBeInTheDocument();
    expect(container.querySelector(".media-card-fallback-initial")).toHaveTextContent("I");

    rerender(
      <MediaCard
        item={{ ...item, id: "failed", posterPath: "/missing-poster.jpg" }}
        onSelect={() => {}}
        showPosterRatings={false}
      />,
    );
    fireEvent.error(screen.getByRole("img", { name: "Inception" }));
    expect(container.querySelector(".media-card-fallback")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("removes shimmer only after the image load event fires", () => {
    const { container } = render(
      <MediaCard
        item={{ ...item, posterPath: "/poster.jpg" }}
        onSelect={() => {}}
        showPosterRatings={false}
      />,
    );

    expect(container.querySelector(".media-card-shimmer")).not.toBeNull();

    const img = screen.getByRole("img", { name: "Inception" });
    fireEvent.load(img);

    expect(container.querySelector(".media-card-shimmer")).toBeNull();
  });

  it("renders rank label and ranked accessible name", () => {
    render(<MediaCard item={item} onSelect={() => {}} rank={7} showPosterRatings={false} />);

    const button = screen.getByRole("button", { name: "#7: Inception" });
    expect(button).toHaveClass("media-card");
    expect(button).toHaveClass("is-ranked");
    expect(button.querySelector(".media-card-rank")).toHaveTextContent("7");
  });

  it("renders ready and corner-label overlays together", () => {
    render(
      <MediaCard
        item={item}
        onSelect={() => {}}
        ready
        cornerLabel="S2 E4"
        showPosterRatings={false}
      />,
    );

    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("S2 E4")).toBeInTheDocument();
  });

  it("renders and clamps the continue-watching progress bar", () => {
    const { container, rerender } = render(
      <MediaCard
        item={{ ...item, posterPath: null }}
        onSelect={() => {}}
        progress={1.25}
        showPosterRatings={false}
      />,
    );
    expect(container.querySelector(".media-card-progress-fill")).toHaveStyle({
      width: "100%",
    });

    rerender(
      <MediaCard
        item={{ ...item, posterPath: null }}
        onSelect={() => {}}
        progress={-0.2}
        showPosterRatings={false}
      />,
    );
    expect(container.querySelector(".media-card-progress-fill")).toBeNull();
  });

  it("shows reveal-level metadata when available", () => {
    const { container } = render(
      <MediaCard
        item={{ ...item, year: 2026, imdbRating: 8.4 }}
        onSelect={() => {}}
        showPosterRatings={false}
      />,
    );

    const revealMeta = container.querySelector(".media-card-reveal-meta");
    expect(revealMeta).not.toBeNull();
    expect(revealMeta).toHaveTextContent("2026");
    expect(revealMeta).toHaveTextContent("8.4");
  });
});
