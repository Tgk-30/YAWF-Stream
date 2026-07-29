// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { WatchHistoryRecord } from "../storage/models";
import { ContinueWatchingRail } from "./ContinueWatchingRail";

function record(index: number): WatchHistoryRecord {
  return {
    id: `record-${index}`,
    mediaId: `media-${index}`,
    episodeId: null,
    progressSeconds: 60,
    durationSeconds: 600,
    completed: false,
    lastWatched: "2026-01-01T00:00:00.000Z",
    streamQuality: null,
    preview: {
      id: `media-${index}`,
      type: "movie",
      title: `Title ${index}`,
      backdropPath: `/backdrop-${index}.jpg`,
    },
  };
}

describe("ContinueWatchingRail", () => {
  const onResume = vi.fn();

  beforeEach(() => {
    onResume.mockReset();
  });

  it("returns null when there are no records", () => {
    const { container } = render(
      <ContinueWatchingRail records={[]} onResume={onResume} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("caps the home rail at eight cards", () => {
    const { container } = render(
      <ContinueWatchingRail
        records={Array.from({ length: 10 }, (_, index) => record(index))}
        onResume={onResume}
      />,
    );
    expect(container.querySelectorAll(".cw-card")).toHaveLength(8);
  });

  it("calls onResume for clicked items", () => {
    const one = record(1);
    render(<ContinueWatchingRail records={[one]} onResume={onResume} />);

    fireEvent.click(screen.getByRole("button", { name: /Continue Title 1/ }));
    expect(onResume).toHaveBeenCalledOnce();
    expect(onResume).toHaveBeenCalledWith(one.preview);
  });

  it("falls back when no image URL exists", () => {
    const noImage = {
      ...record(1),
      preview: {
        id: "media-1",
        type: "movie" as const,
        title: "No Image",
      },
    };

    render(<ContinueWatchingRail records={[noImage]} onResume={onResume} />);

    const resumeButton = screen.getByRole("button", { name: "Continue No Image" });
    expect(resumeButton).toBeInTheDocument();
    expect(resumeButton.querySelector(".cw-card-img-fallback")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("renders episode labels and minute remaining text", () => {
    const movieEpisode = {
      ...record(2),
      episodeId: "s3e7",
      progressSeconds: 5,
      durationSeconds: 300,
    };

    render(<ContinueWatchingRail records={[movieEpisode]} onResume={onResume} />);

    expect(screen.getByText("S3 E7")).toBeInTheDocument();
    expect(screen.getByText("5m left")).toBeInTheDocument();
  });

  it("formats hour/minute remaining text and omits when time is unavailable", () => {
    const missingDuration = {
      ...record(3),
      durationSeconds: null,
      progressSeconds: 1,
    };
    const longRunning = {
      ...record(4),
      durationSeconds: 4000,
      progressSeconds: 120,
    };
    const alreadyDone = {
      ...record(5),
      durationSeconds: 200,
      progressSeconds: 1000,
    };

    render(
      <ContinueWatchingRail
        records={[missingDuration, longRunning, alreadyDone]}
        onResume={onResume}
      />,
    );

    const cards = screen.getAllByRole("button");
    expect(cards[0].querySelector(".cw-card-left")).toBeNull();
    expect(cards[2].querySelector(".cw-card-left")).toBeNull();

    const longRunningLeft = cards[1].querySelector(".cw-card-left");
    expect(longRunningLeft).not.toBeNull();
    expect(longRunningLeft).toHaveTextContent("1h 05m left");
  });

  it("treats non-finite progress as zero when computing remaining time", () => {
    const weirdProgress = {
      ...record(6),
      progressSeconds: Number.NaN,
      durationSeconds: 120,
    };

    render(<ContinueWatchingRail records={[weirdProgress]} onResume={onResume} />);

    expect(screen.getByText("2m left")).toBeInTheDocument();
  });
});
