// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DownloadRecord } from "../storage/models";

const tauriState = vi.hoisted(() => ({ on: false, desktop: false }));
const desktopQueue = vi.hoisted(() => ({
  records: [] as DownloadRecord[],
  manager: {
    subscribeRecords: vi.fn((listener: (records: DownloadRecord[]) => void) => {
      listener(desktopQueue.records);
      return () => {};
    }),
    subscribeProgress: vi.fn(() => () => {}),
    speedFor: vi.fn(() => undefined),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    forceStop: vi.fn(async () => {}),
  },
}));
const downloadsFfmpegAvailable = vi.hoisted(() => vi.fn(async () => true));
const playLocalFile = vi.hoisted(() => vi.fn());
const revealInFileManager = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../store/AppStore", () => ({
  useAppStore: () => ({
    services: { debrid: null },
    navigate: vi.fn(),
    playLocalFile,
  }),
}));
vi.mock("../lib/tauri", () => ({
  isTauri: () => tauriState.on,
  isDesktopTauri: () => tauriState.desktop,
  revealInFileManager,
}));
vi.mock("../storage", () => ({
  getStore: () => ({
    getMedia: async () => null,
    deleteDownload: async () => {},
  }),
}));
vi.mock("../services/downloads", () => ({
  startDownloadsRuntime: () => desktopQueue.manager,
}));
vi.mock("../lib/downloadsBridge", () => ({
  getDownloadsBridge: () => ({ downloadsFfmpegAvailable }),
}));

import {
  Downloads,
  groupDownloads,
  artworkKeyFor,
  DownloadPoster,
  DownloadShowBanner,
} from "./Downloads";

function record(overrides: Partial<DownloadRecord>): DownloadRecord {
  return {
    jobId: "job",
    mediaId: "movie",
    episodeId: null,
    title: "Movie",
    season: null,
    episode: null,
    infoHash: "hash",
    fileHint: null,
    mode: "full",
    optimizeProfile: null,
    keepAudioLangs: [],
    keepSubLangs: [],
    status: "queued",
    bytesDone: 0,
    bytesTotal: null,
    optimizePercent: null,
    destPath: null,
    error: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  tauriState.on = false;
  tauriState.desktop = false;
  desktopQueue.records = [];
  vi.clearAllMocks();
});

describe("Downloads honest desktop gate", () => {
  it("does not show unusable queue controls in a browser", () => {
    render(<Downloads />);
    expect(screen.getByText("Open the desktop app to download")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /download desktop app/i })).toBeInTheDocument();
    expect(screen.queryByText("Your download queue is empty")).not.toBeInTheDocument();
  });

  it("does not show desktop queue controls on Android", () => {
    tauriState.on = true;
    render(<Downloads />);
    expect(screen.getByText("Open the desktop app to download")).toBeInTheDocument();
    expect(downloadsFfmpegAvailable).not.toHaveBeenCalled();
  });
});

describe("Downloads desktop queue progress", () => {
  it("offers Play and Reveal only for a completed record with a local destination", async () => {
    tauriState.on = true;
    tauriState.desktop = true;
    desktopQueue.records = [
      record({ status: "completed", destPath: "/Downloads/Movie.mkv" }),
      record({
        jobId: "paused-job",
        title: "Paused movie",
        status: "paused",
        destPath: "/Downloads/Paused movie.mkv",
      }),
      record({ jobId: "missing-path", title: "Missing path", status: "completed" }),
    ];

    render(<Downloads />);

    const play = await screen.findByRole("button", { name: "Play Movie" });
    const reveal = screen.getByRole("button", { name: "Reveal Movie in folder" });
    expect(screen.queryByRole("button", { name: "Play Paused movie" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reveal Paused movie in folder" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Play Missing path" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reveal Missing path in folder" })).not.toBeInTheDocument();

    fireEvent.click(play);
    fireEvent.click(reveal);

    expect(playLocalFile).toHaveBeenCalledWith("/Downloads/Movie.mkv", "Movie");
    await waitFor(() => {
      expect(revealInFileManager).toHaveBeenCalledWith("/Downloads/Movie.mkv");
    });
  });

  it("renders the known source denominator as a determinate progress bar", async () => {
    tauriState.on = true;
    tauriState.desktop = true;
    desktopQueue.records = [
      record({
        status: "downloading",
        bytesDone: 5_000_000_000,
        bytesTotal: 10_000_000_000,
      }),
    ];

    render(<Downloads />);

    const bar = await screen.findByRole("progressbar", { name: "Movie download progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("50%");
  });

  it("renders a Content-Length-less download as indeterminate", async () => {
    tauriState.on = true;
    tauriState.desktop = true;
    desktopQueue.records = [
      record({
        status: "downloading",
        bytesDone: 5_000_000_000,
        bytesTotal: null,
      }),
    ];

    render(<Downloads />);

    const bar = await screen.findByRole("progressbar", { name: "Movie download progress" });
    expect(bar).toHaveClass("is-indeterminate");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar.firstElementChild).not.toHaveAttribute("style");
  });

  it("renders transcode percent without a fake byte pair", async () => {
    tauriState.on = true;
    tauriState.desktop = true;
    desktopQueue.records = [
      record({
        mode: "optimized",
        optimizeProfile: "remux",
        status: "optimizing",
        bytesDone: 8_000_000_000,
        bytesTotal: 8_000_000_000,
        optimizePercent: 42,
      }),
    ];

    render(<Downloads />);

    const bar = await screen.findByRole("progressbar", { name: "Movie download progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("42%");
    expect(screen.getByText(/Optimizing 42% -/)).toBeInTheDocument();
    expect(screen.queryByText(/100 B/)).not.toBeInTheDocument();
  });
});

describe("groupDownloads", () => {
  it("separates movies and nests series episodes by show then season", () => {
    const grouped = groupDownloads([
      record({ jobId: "movie", mediaId: "m1", title: "Arrival (2016)" }),
      record({
        jobId: "show-s2e2",
        mediaId: "show-a",
        episodeId: "s2e2",
        title: "The Bear S02E02 - Pasta",
        season: 2,
        episode: 2,
      }),
      record({
        jobId: "show-s1e3",
        mediaId: "show-a",
        episodeId: "s1e3",
        title: "The Bear S01E03 - Brigade",
        season: 1,
        episode: 3,
      }),
      record({
        jobId: "other-s1e1",
        mediaId: "show-b",
        episodeId: "s1e1",
        title: "Severance S01E01 - Good News About Hell",
        season: 1,
        episode: 1,
      }),
    ]);

    expect(grouped.movies.map((item) => item.jobId)).toEqual(["movie"]);
    expect(grouped.series.map((series) => series.title)).toEqual(["The Bear", "Severance"]);
    expect(grouped.series[0]?.seasons.map((season) => season.season)).toEqual([1, 2]);
    expect(grouped.series[0]?.seasons[0]?.records.map((item) => item.jobId)).toEqual([
      "show-s1e3",
    ]);
  });
});

describe("artworkKeyFor", () => {
  it("reduces a queue to its distinct media ids, sorted", () => {
    expect(
      artworkKeyFor([
        record({ jobId: "1", mediaId: "show-b" }),
        record({ jobId: "2", mediaId: "show-a" }),
        record({ jobId: "3", mediaId: "show-b" }),
      ]),
    ).toBe("show-a,show-b");
  });

  it("is unchanged when only progress moves, so ticks don't refetch artwork", () => {
    const before = artworkKeyFor([record({ jobId: "1", mediaId: "m", bytesDone: 0 })]);
    const after = artworkKeyFor([
      record({ jobId: "1", mediaId: "m", bytesDone: 5_000_000, status: "downloading" }),
    ]);
    expect(after).toBe(before);
  });

  it("is empty for an empty queue", () => {
    expect(artworkKeyFor([])).toBe("");
  });
});

describe("DownloadPoster", () => {
  const art = { poster: "https://img.test/p.jpg", backdrop: "https://img.test/b.jpg" };

  it("draws the progress bar over the poster artwork", () => {
    const { container } = render(
      <DownloadPoster art={art} title="Dune" progress={42} active />,
    );
    const image = container.querySelector(".downloads-poster img");
    expect(image).toHaveAttribute("src", art.poster);

    const bar = screen.getByRole("progressbar", { name: "Dune download progress" });
    // The bar is inside the poster, not a separate column.
    expect(container.querySelector(".downloads-poster")).toContainElement(bar);
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("42%");
  });

  it("falls back to a placeholder tile when no poster is cached", () => {
    const { container } = render(<DownloadPoster title="Dune" progress={0} active />);
    expect(container.querySelector(".downloads-poster img")).toBeNull();
    expect(container.querySelector(".downloads-poster-ph")).not.toBeNull();
    // The bar still renders so every row reads consistently.
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("only accents the bar while the job is in flight", () => {
    const { container: live } = render(
      <DownloadPoster art={art} title="A" progress={10} active />,
    );
    expect(live.querySelector(".downloads-poster-bar")).toHaveClass("is-active");

    const { container: done } = render(
      <DownloadPoster art={art} title="B" progress={100} active={false} />,
    );
    expect(done.querySelector(".downloads-poster-bar")).not.toHaveClass("is-active");
  });
});

describe("DownloadShowBanner", () => {
  it("uses the backdrop as a banner behind the poster and title", () => {
    const { container } = render(
      <DownloadShowBanner
        title="Severance"
        art={{ poster: "https://img.test/p.jpg", backdrop: "https://img.test/b.jpg" }}
      />,
    );
    expect(container.querySelector(".downloads-show-banner")).toHaveClass("has-backdrop");
    expect(container.querySelector(".downloads-show-backdrop")).toHaveAttribute(
      "src",
      "https://img.test/b.jpg",
    );
    expect(container.querySelector("img.downloads-show-poster")).toHaveAttribute(
      "src",
      "https://img.test/p.jpg",
    );
    expect(screen.getByRole("heading", { name: "Severance" })).toBeInTheDocument();
  });

  it("degrades to a plain heading when the title has no cached artwork", () => {
    const { container } = render(<DownloadShowBanner title="Severance" />);
    expect(container.querySelector(".downloads-show-banner")).not.toHaveClass("has-backdrop");
    expect(container.querySelector(".downloads-show-backdrop")).toBeNull();
    expect(container.querySelector(".downloads-show-poster.is-placeholder")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Severance" })).toBeInTheDocument();
  });
});
