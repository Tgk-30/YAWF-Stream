// @vitest-environment jsdom
//
// DetailHero: cinematic detail header. These tests cover the backdrop render +
// onError gradient fallback, the conditional meta/genre/overview blocks, the
// primary Play / Watchlist handlers, the optional Request button across its four
// states, and the optional taste-signal (thumbs) control.

import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { DetailHero } from "./DetailHero";
import type { MediaItem } from "../models/media";

function makeItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "m1",
    type: "movie",
    title: "Blade Runner",
    year: 1982,
    posterPath: "/poster.jpg",
    backdropPath: "/backdrop.jpg",
    overview: "A blade runner must pursue replicants.",
    genres: ["Sci-Fi", "Thriller"],
    imdbRating: 8.1,
    runtime: 117,
    status: "Released",
    tmdbId: 78,
    lastFetched: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const noop = () => {};

describe("DetailHero backdrop", () => {
  it("renders the w1280 backdrop image when a backdrop is present", () => {
    const { container } = render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
      />,
    );
    const img = container.querySelector("img.detail-hero-backdrop") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toBe("https://image.tmdb.org/t/p/w1280/backdrop.jpg");
    expect(container.querySelector(".detail-hero-backdrop.hero-gradient")).toBeNull();
  });

  it("falls back to the gradient (not a broken-image frame) when onError fires", () => {
    const { container } = render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
      />,
    );
    const img = container.querySelector("img.detail-hero-backdrop") as HTMLImageElement;
    fireEvent.error(img);
    expect(container.querySelector("img.detail-hero-backdrop")).toBeNull();
    expect(container.querySelector(".detail-hero-backdrop.hero-gradient")).not.toBeNull();
  });

  it("does not carry a failed backdrop fallback to a different detail item", () => {
    const { container, rerender } = render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
      />,
    );
    fireEvent.error(container.querySelector("img.detail-hero-backdrop")!);

    rerender(
      <DetailHero
        item={makeItem({ id: "m2", title: "Alien", backdropPath: "/alien.jpg" })}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
      />,
    );

    const img = container.querySelector("img.detail-hero-backdrop") as HTMLImageElement;
    expect(img.src).toBe("https://image.tmdb.org/t/p/w1280/alien.jpg");
    expect(container.querySelector(".detail-hero-backdrop.hero-gradient")).toBeNull();
  });

  it("renders the gradient directly when the item has no backdrop", () => {
    const { container } = render(
      <DetailHero
        item={makeItem({ backdropPath: null })}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
      />,
    );
    expect(container.querySelector("img.detail-hero-backdrop")).toBeNull();
    expect(container.querySelector(".detail-hero-backdrop.hero-gradient")).not.toBeNull();
  });

  it("supports an actionable setup label for the primary playback control", () => {
    const onPlay = vi.fn();
    render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={onPlay}
        playLabel="Set up streaming"
        onToggleWatchlist={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Set up streaming" }));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it("replays the CSS animation layers when the detail title changes", () => {
    const { container, rerender } = render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
      />,
    );
    const firstContent = container.querySelector(".detail-hero-content");
    const firstBackdrop = container.querySelector(".detail-hero-backdrop-layer");

    rerender(
      <DetailHero
        item={makeItem({ id: "m2", title: "Alien" })}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
      />,
    );

    expect(container.querySelector(".detail-hero-content")).not.toBe(firstContent);
    expect(container.querySelector(".detail-hero-backdrop-layer")).not.toBe(firstBackdrop);
  });
});

describe("DetailHero content", () => {
  it("renders the poster image with the title as alt text", () => {
    const { container } = render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
      />,
    );
    const poster = container.querySelector("img.detail-hero-poster") as HTMLImageElement;
    expect(poster).not.toBeNull();
    expect(poster.src).toBe("https://image.tmdb.org/t/p/w342/poster.jpg");
    expect(poster.alt).toBe("Blade Runner");
  });

  it("omits the poster when there is no poster path", () => {
    const { container } = render(
      <DetailHero
        item={makeItem({ posterPath: null })}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
      />,
    );
    expect(container.querySelector("img.detail-hero-poster")).toBeNull();
  });

  it("replaces a failed poster with a placeholder tile", () => {
    const { container } = render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
      />,
    );
    fireEvent.error(container.querySelector("img.detail-hero-poster")!);
    expect(container.querySelector("img.detail-hero-poster")).toBeNull();
    expect(container.querySelector(".detail-hero-poster-placeholder")).not.toBeNull();
  });

  it("renders the title, rating, meta bits, genres and overview", () => {
    const { container } = render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Blade Runner");
    // rating 8.1 -> "8.1"
    expect(screen.getByText("8.1")).toBeInTheDocument();
    // meta bits: year, runtime "1h 57m", status
    expect(screen.getByText("1982")).toBeInTheDocument();
    expect(screen.getByText("1h 57m")).toBeInTheDocument();
    expect(screen.getByText("Released")).toBeInTheDocument();
    // genres (chips), capped at 4
    const chips = container.querySelectorAll(".detail-genre-chip");
    expect(chips).toHaveLength(2);
    expect(screen.getByText("Sci-Fi")).toBeInTheDocument();
    expect(screen.getByText("A blade runner must pursue replicants.")).toBeInTheDocument();
  });

  it("places supplied external ratings beside the TMDB score in the hero", () => {
    const { container } = render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
        externalRatings={<span data-testid="external-ratings">IMDb 8.2</span>}
      />,
    );
    const ratings = container.querySelector(".detail-hero-ratings")!;
    expect(within(ratings as HTMLElement).getByText("8.1")).toBeInTheDocument();
    expect(within(ratings as HTMLElement).getByTestId("external-ratings")).toBeInTheDocument();
  });

  it.each(["Watched", "Completed"] as const)(
    "renders the %s completion indicator when supplied by Detail",
    (completionLabel) => {
      render(
        <DetailHero
          item={makeItem()}
          inWatchlist={false}
          onPlay={noop}
          onToggleWatchlist={noop}
          completionLabel={completionLabel}
        />,
      );
      expect(screen.getByLabelText(completionLabel)).toHaveClass(
        "detail-hero-completion",
      );
    },
  );

  it("hides the rating chip when the rating is N/A", () => {
    const { container } = render(
      <DetailHero
        item={makeItem({ imdbRating: null })}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
      />,
    );
    expect(container.querySelector(".detail-hero-rating")).toBeNull();
  });

  it("caps the genre chips at four", () => {
    const { container } = render(
      <DetailHero
        item={makeItem({ genres: ["A", "B", "C", "D", "E", "F"] })}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
      />,
    );
    expect(container.querySelectorAll(".detail-genre-chip")).toHaveLength(4);
  });

  it("omits the genres block and overview when both are empty", () => {
    const { container } = render(
      <DetailHero
        item={makeItem({ genres: [], overview: null })}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
      />,
    );
    expect(container.querySelector(".detail-hero-genres")).toBeNull();
    expect(container.querySelector(".detail-hero-overview")).toBeNull();
  });

  it("omits all meta bits when year, runtime and status are absent", () => {
    const { container } = render(
      <DetailHero
        item={makeItem({ year: null, runtime: 0, status: null })}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
      />,
    );
    expect(container.querySelectorAll(".detail-hero-metabit")).toHaveLength(0);
  });
});

describe("DetailHero primary actions", () => {
  it("calls onPlay when Play is clicked", () => {
    const onPlay = vi.fn();
    render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={onPlay}
        onToggleWatchlist={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Play/ }));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it("does not own the Detail overlay Back control", () => {
    render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("shows 'Watchlist' and calls onToggleWatchlist when not in the watchlist", () => {
    const onToggle = vi.fn();
    render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={onToggle}
      />,
    );
    const btn = screen.getByRole("button", { name: /Watchlist/ });
    expect(btn.className).not.toContain("is-on");
    expect(btn).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("shows 'In watchlist' with is-on when already in the watchlist", () => {
    render(
      <DetailHero
        item={makeItem()}
        inWatchlist={true}
        onPlay={noop}
        onToggleWatchlist={noop}
      />,
    );
    const btn = screen.getByRole("button", { name: /In watchlist/ });
    expect(btn.className).toContain("is-on");
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });
});

describe("DetailHero request button", () => {
  it("is hidden entirely when onRequest is not provided", () => {
    const { container } = render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
      />,
    );
    expect(container.querySelector(".detail-request")).toBeNull();
  });

  it("renders the idle Request label, is enabled, and calls onRequest", () => {
    const onRequest = vi.fn();
    render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
        onRequest={onRequest}
        requestState="idle"
      />,
    );
    const btn = screen.getByRole("button", { name: "Request" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.className).not.toContain("is-on");
    fireEvent.click(btn);
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it("shows the busy label and is disabled while requesting", () => {
    render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
        onRequest={noop}
        requestState="requesting"
      />,
    );
    const btn = screen.getByRole("button", { name: /Requesting/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.className).not.toContain("is-on");
  });

  it("shows the 'Requested' confirmation with is-on and disabled when requested", () => {
    render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
        onRequest={noop}
        requestState="requested"
      />,
    );
    const btn = screen.getByRole("button", { name: "Requested" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.className).toContain("is-on");
    expect(btn.title).toBe("Request sent");
  });

  it("shows the 'Already requested' state with is-on and disabled", () => {
    render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
        onRequest={noop}
        requestState="already"
      />,
    );
    const btn = screen.getByRole("button", { name: "Already requested" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.className).toContain("is-on");
    expect(btn.title).toBe("Already requested");
  });
});

describe("DetailHero taste signal", () => {
  it("is hidden entirely when onTasteSignal is not provided", () => {
    const { container } = render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
      />,
    );
    expect(container.querySelector(".detail-taste")).toBeNull();
  });

  it("renders both thumb controls with no active state by default", () => {
    render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
        onTasteSignal={noop}
      />,
    );
    const like = screen.getByRole("button", { name: "I like this" });
    const dislike = screen.getByRole("button", { name: "Not for me" });
    expect(like).toHaveAttribute("aria-pressed", "false");
    expect(dislike).toHaveAttribute("aria-pressed", "false");
    expect(like.className).not.toContain("is-liked");
    expect(dislike.className).not.toContain("is-disliked");
  });

  it("calls onTasteSignal('liked') when the like thumb is clicked", () => {
    const onTaste = vi.fn();
    render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
        onTasteSignal={onTaste}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "I like this" }));
    expect(onTaste).toHaveBeenCalledWith("liked");
  });

  it("calls onTasteSignal('disliked') when the dislike thumb is clicked", () => {
    const onTaste = vi.fn();
    render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
        onTasteSignal={onTaste}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Not for me" }));
    expect(onTaste).toHaveBeenCalledWith("disliked");
  });

  it("marks the like thumb active when tasteSignal is 'liked'", () => {
    render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
        onTasteSignal={noop}
        tasteSignal="liked"
      />,
    );
    const like = screen.getByRole("button", { name: "I like this" });
    expect(like).toHaveAttribute("aria-pressed", "true");
    expect(like.className).toContain("is-liked");
  });

  it("marks the dislike thumb active when tasteSignal is 'disliked'", () => {
    render(
      <DetailHero
        item={makeItem()}
        inWatchlist={false}
        onPlay={noop}
        onToggleWatchlist={noop}
        onTasteSignal={noop}
        tasteSignal="disliked"
      />,
    );
    const dislike = screen.getByRole("button", { name: "Not for me" });
    expect(dislike).toHaveAttribute("aria-pressed", "true");
    expect(dislike.className).toContain("is-disliked");
  });
});
