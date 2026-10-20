// @vitest-environment jsdom
//
// HeroSpotlight: cinematic auto-rotating billboard. These tests cover the active
// item render, auto-advance interval, dot navigation, Play/More handlers, the
// backdrop preload effect (gated by smart-preload), and the empty/single guards.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { HeroSpotlight } from "./HeroSpotlight";
import type { MediaPreview } from "../models/media";

// Smart-preload preference - toggled per test via the mock fn's return value.
const isSmartPreloadEnabled = vi.fn(() => true);
vi.mock("../lib/smartPreload", () => ({
  isSmartPreloadEnabled: () => isSmartPreloadEnabled(),
}));

const items: MediaPreview[] = [
  { id: "a", type: "movie", title: "Alpha", year: 2001, imdbRating: 8.2, backdropPath: "/alpha.jpg" },
  { id: "b", type: "series", title: "Bravo", year: 2002, backdropPath: "/bravo.jpg" },
  { id: "c", type: "movie", title: "Charlie", backdropPath: "/charlie.jpg" },
];

beforeEach(() => {
  isSmartPreloadEnabled.mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("HeroSpotlight rendering", () => {
  it("renders the first item as the active title with year and rating", () => {
    render(<HeroSpotlight items={items} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Alpha");
    expect(screen.getByText("2001")).toBeInTheDocument();
    // imdbRating 8.2 -> "8.2" via ratingString
    expect(screen.getByText("8.2")).toBeInTheDocument();
    expect(screen.getByText("Featured")).toBeInTheDocument();
  });

  it("renders the active backdrop image with a w1280 TMDB URL", () => {
    const { container } = render(<HeroSpotlight items={items} />);
    const img = container.querySelector("img.hero-backdrop") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toBe("https://image.tmdb.org/t/p/w1280/alpha.jpg");
  });

  it("renders a gradient placeholder when the active item has no backdrop", () => {
    const noBackdrop: MediaPreview = { id: "z", type: "movie", title: "Zulu" };
    const { container } = render(<HeroSpotlight item={noBackdrop} />);
    expect(container.querySelector("img.hero-backdrop")).toBeNull();
    expect(container.querySelector(".hero-backdrop.hero-gradient")).not.toBeNull();
  });

  it("replaces a failed backdrop with the hero gradient", () => {
    const { container } = render(<HeroSpotlight items={items} />);
    fireEvent.error(container.querySelector("img.hero-backdrop")!);
    expect(container.querySelector("img.hero-backdrop")).toBeNull();
    expect(container.querySelector(".hero-backdrop.hero-gradient")).not.toBeNull();
  });

  it("keeps a failed backdrop on the gradient when the carousel revisits it", () => {
    const { container } = render(<HeroSpotlight items={items} />);
    fireEvent.error(container.querySelector("img.hero-backdrop")!);
    fireEvent.click(container.querySelectorAll<HTMLButtonElement>(".hero-dot")[1]);
    fireEvent.click(container.querySelectorAll<HTMLButtonElement>(".hero-dot")[0]);
    expect(
      [...container.querySelectorAll<HTMLImageElement>("img.hero-backdrop")].some((img) =>
        img.src.includes("/alpha.jpg"),
      ),
    ).toBe(false);
    expect(container.querySelector(".hero-backdrop.hero-gradient")).not.toBeNull();
  });

  it("evicts the oldest displayed-backdrop failure when the per-mount cache is full", () => {
    const makeItem = (index: number, id = `display-bound-${index}`): MediaPreview => ({
      id,
      type: "movie",
      title: `Display bound ${index}`,
      backdropPath: `/display-bound-${index}-regression.jpg`,
    });
    const { container, rerender } = render(<HeroSpotlight item={makeItem(0)} />);

    for (let index = 0; index <= 64; index += 1) {
      if (index > 0) rerender(<HeroSpotlight item={makeItem(index)} />);
      const displayed = [...container.querySelectorAll<HTMLImageElement>("img.hero-backdrop")]
        .find((image) => image.src.includes(`/display-bound-${index}-regression.jpg`));
      expect(displayed, `displayed backdrop ${index}`).toBeDefined();
      fireEvent.error(displayed!);
    }

    rerender(<HeroSpotlight item={makeItem(0, "display-bound-return")} />);
    expect(
      [...container.querySelectorAll<HTMLImageElement>("img.hero-backdrop")].some((image) =>
        image.src.includes("/display-bound-0-regression.jpg"),
      ),
    ).toBe(true);
  });

  it("retries a displayed-backdrop failure after the hero remounts", () => {
    const retryItem: MediaPreview = {
      id: "display-remount-regression",
      type: "movie",
      title: "Display remount",
      backdropPath: "/display-remount-regression.jpg",
    };
    const first = render(<HeroSpotlight item={retryItem} />);
    fireEvent.error(first.container.querySelector("img.hero-backdrop")!);
    expect(first.container.querySelector("img.hero-backdrop")).toBeNull();
    first.unmount();

    const second = render(<HeroSpotlight item={retryItem} />);
    expect(second.container.querySelector("img.hero-backdrop")?.getAttribute("src"))
      .toContain("/display-remount-regression.jpg");
  });

  it("renders the overview paragraph only when provided", () => {
    const { rerender, container } = render(<HeroSpotlight items={items} />);
    expect(container.querySelector(".hero-overview")).toBeNull();
    rerender(<HeroSpotlight items={items} overview="A thrilling ride." />);
    expect(screen.getByText("A thrilling ride.")).toBeInTheDocument();
  });

  it("omits the year/rating chips when the item lacks them", () => {
    // Charlie has no year and no imdbRating.
    const { container } = render(<HeroSpotlight item={items[2]} />);
    expect(container.querySelector(".hero-year")).toBeNull();
    expect(container.querySelector(".hero-rating")).toBeNull();
  });
});

describe("HeroSpotlight empty / single-item guards", () => {
  it("renders nothing when there are no items at all", () => {
    const { container } = render(<HeroSpotlight items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("does not render dot navigation for a single item", () => {
    const { container } = render(<HeroSpotlight item={items[0]} />);
    expect(container.querySelector(".hero-dots")).toBeNull();
  });

  it("renders dot navigation when there are multiple items", () => {
    const { container } = render(<HeroSpotlight items={items} />);
    expect(container.querySelector(".hero-dots")).not.toBeNull();
    // One dot button per item; the first is active.
    expect(container.querySelectorAll(".hero-dot")).toHaveLength(3);
    expect(container.querySelector(".hero-dot.is-active")).toBe(
      container.querySelectorAll(".hero-dot")[0],
    );
    expect(
      screen.getByRole("button", { name: "Alpha, featured 1 of 3" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("caps the rotation list at 6 items", () => {
    const many: MediaPreview[] = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      type: "movie",
      title: `Title ${i}`,
    }));
    const { container } = render(<HeroSpotlight items={many} />);
    expect(container.querySelectorAll(".hero-dot")).toHaveLength(6);
  });

  it("prefers items over the singular item prop when both are given", () => {
    const single: MediaPreview = { id: "single", type: "movie", title: "Single" };
    render(<HeroSpotlight items={items} item={single} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Alpha");
  });
});

describe("HeroSpotlight auto-advance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("advances to the next item after the interval elapses", () => {
    render(<HeroSpotlight items={items} intervalMs={5000} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Alpha");
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Bravo");
  });

  it("wraps back to the first item after the last", () => {
    render(<HeroSpotlight items={items} intervalMs={1000} />);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Alpha");
  });

  it("does not auto-advance when there is only a single item", () => {
    render(<HeroSpotlight item={items[0]} intervalMs={1000} />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Alpha");
  });

  it("does not auto-advance while suspended", () => {
    render(<HeroSpotlight items={items} intervalMs={1000} suspended />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Alpha");
  });
});

describe("HeroSpotlight dot navigation & hover pause", () => {
  it("jumps to a specific item when its dot is clicked", () => {
    const { container } = render(<HeroSpotlight items={items} />);
    const dots = container.querySelectorAll<HTMLButtonElement>(".hero-dot");
    fireEvent.click(dots[2]);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Charlie");
    expect(dots[2].className).toContain("is-active");
  });

  it("marks only the active dot with is-active", () => {
    const { container } = render(<HeroSpotlight items={items} />);
    const dots = container.querySelectorAll<HTMLButtonElement>(".hero-dot");
    expect(dots[0].className).toContain("is-active");
    expect(dots[1].className).not.toContain("is-active");
  });

  it("pauses auto-advance on hover and resumes on leave", () => {
    vi.useFakeTimers();
    const { container } = render(<HeroSpotlight items={items} intervalMs={1000} />);
    const hero = container.querySelector(".hero") as HTMLElement;
    // Hover -> paused: no advance even after several intervals.
    act(() => {
      hero.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Alpha");
    // Leave -> resumes.
    act(() => {
      hero.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Bravo");
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("pauses on keyboard focus and offers an explicit rotation toggle", () => {
    vi.useFakeTimers();
    render(<HeroSpotlight items={items} intervalMs={1000} />);
    const toggle = screen.getByRole("button", {
      name: "Pause featured title rotation",
    });
    fireEvent.focus(toggle);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Alpha");

    fireEvent.click(toggle);
    fireEvent.blur(toggle, { relatedTarget: document.body });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Alpha");
    expect(
      screen.getByRole("button", { name: "Resume featured title rotation" }),
    ).toHaveAttribute("aria-pressed", "true");
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });
});

describe("HeroSpotlight Play / More handlers", () => {
  it("calls onPlay with the active item", () => {
    const onPlay = vi.fn();
    render(<HeroSpotlight items={items} onPlay={onPlay} />);
    fireEvent.click(screen.getByRole("button", { name: /Play/ }));
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPlay).toHaveBeenCalledWith(items[0]);
  });

  it("calls onDetails with the active item", () => {
    const onDetails = vi.fn();
    render(<HeroSpotlight items={items} onDetails={onDetails} />);
    fireEvent.click(screen.getByRole("button", { name: /More info/ }));
    expect(onDetails).toHaveBeenCalledTimes(1);
    expect(onDetails).toHaveBeenCalledWith(items[0]);
  });

  it("does not throw when handlers are omitted", () => {
    render(<HeroSpotlight items={items} />);
    fireEvent.click(screen.getByRole("button", { name: /Play/ }));
    fireEvent.click(screen.getByRole("button", { name: /More info/ }));
    // No assertion needed beyond not throwing.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Alpha");
  });

  it("passes the currently active item (after navigation) to onPlay", () => {
    const onPlay = vi.fn();
    const { container } = render(<HeroSpotlight items={items} onPlay={onPlay} />);
    const dots = container.querySelectorAll<HTMLButtonElement>(".hero-dot");
    fireEvent.click(dots[1]);
    fireEvent.click(screen.getByRole("button", { name: /Play/ }));
    expect(onPlay).toHaveBeenCalledWith(items[1]);
  });
});

describe("HeroSpotlight backdrop preload effect", () => {
  interface TrackedImage {
    crossOrigin: string;
    onload: (() => void) | null;
    onerror: (() => void) | null;
    requestedUrl: string;
    src: string;
  }

  let created: TrackedImage[];
  let OriginalImage: typeof Image;
  let originalHiddenDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    created = [];
    OriginalImage = globalThis.Image;
    originalHiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
    class FakeImage {
      crossOrigin = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      requestedUrl = "";
      private _src = "";
      constructor() {
        created.push(this);
      }
      set src(v: string) {
        this._src = v;
        if (v) this.requestedUrl = v;
      }
      get src() {
        return this._src;
      }
    }
    // @ts-expect-error -- test double for the global Image constructor.
    globalThis.Image = FakeImage;
  });

  afterEach(() => {
    globalThis.Image = OriginalImage;
    if (originalHiddenDescriptor) {
      Object.defineProperty(document, "hidden", originalHiddenDescriptor);
    } else {
      delete (document as unknown as Record<string, unknown>).hidden;
    }
  });

  it("preloads the next backdrop when smart-preload is enabled", () => {
    isSmartPreloadEnabled.mockReturnValue(true);
    render(<HeroSpotlight items={items} />);
    // The preload effect creates an Image for the NEXT backdrop (index+1 -> bravo).
    const preloaded = created.find((c) => c.src.includes("/bravo.jpg"));
    expect(preloaded).toBeDefined();
    expect(preloaded!.src).toBe("https://image.tmdb.org/t/p/w1280/bravo.jpg");
  });

  it("detaches the preload Image src on cleanup", () => {
    isSmartPreloadEnabled.mockReturnValue(true);
    const { unmount } = render(<HeroSpotlight items={items} />);
    const preloaded = created.find((c) => c.src.includes("/bravo.jpg"));
    expect(preloaded).toBeDefined();
    unmount();
    // Cleanup sets src back to "" to abort the in-flight preload.
    expect(preloaded!.src).toBe("");
  });

  it("still preloads the next backdrop even when smart-preload is disabled", () => {
    // The next backdrop is a single image the carousel shows in ~7s regardless,
    // so it's preloaded unconditionally (same bytes, a beat earlier) - only the
    // expensive code-chunk preloads stay gated on smart-preload.
    isSmartPreloadEnabled.mockReturnValue(false);
    render(<HeroSpotlight items={items} />);
    expect(created.some((c) => c.src.includes("/bravo.jpg"))).toBe(true);
  });

  it("does not run the preload effect for a single item", () => {
    isSmartPreloadEnabled.mockReturnValue(true);
    render(<HeroSpotlight item={items[0]} />);
    // No "next backdrop" preload Image should be created (only the accent probe,
    // which uses the active /alpha.jpg, not a next-item backdrop).
    expect(created.some((c) => c.src.includes("/bravo.jpg"))).toBe(false);
  });

  it("does not probe or preload while suspended, then resumes both once", () => {
    const parkedItems: MediaPreview[] = [
      { ...items[0], id: "parked-a", backdropPath: "/parked-a.jpg" },
      { ...items[1], id: "parked-b", backdropPath: "/parked-b.jpg" },
    ];
    const { rerender } = render(<HeroSpotlight items={parkedItems} suspended />);
    expect(created).toHaveLength(0);
    rerender(<HeroSpotlight items={parkedItems} />);
    expect(created.filter((c) => c.src.includes("/parked-a.jpg"))).toHaveLength(1);
    expect(created.filter((c) => c.src.includes("/parked-b.jpg"))).toHaveLength(1);
  });

  it("creates no preload or accent-probe Images when initially hidden", () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    const hiddenItems: MediaPreview[] = [
      { ...items[0], id: "initially-hidden-a", backdropPath: "/initially-hidden-a-regression.jpg" },
      { ...items[1], id: "initially-hidden-b", backdropPath: "/initially-hidden-b-regression.jpg" },
    ];

    render(<HeroSpotlight items={hiddenItems} />);

    expect(created).toHaveLength(0);
  });

  it("aborts preload and probe work while suspended and resumes exactly one of each", () => {
    const suspendItems: MediaPreview[] = [
      { ...items[0], id: "suspend-active-a", backdropPath: "/suspend-active-a-regression.jpg" },
      { ...items[1], id: "suspend-active-b", backdropPath: "/suspend-active-b-regression.jpg" },
    ];
    const { rerender } = render(<HeroSpotlight items={suspendItems} />);
    const firstProbe = created.find((image) =>
      image.crossOrigin === "anonymous" &&
      image.requestedUrl.includes("/suspend-active-a-regression.jpg"));
    const firstPreload = created.find((image) =>
      image.crossOrigin === "" &&
      image.requestedUrl.includes("/suspend-active-b-regression.jpg"));
    expect(firstProbe).toBeDefined();
    expect(firstPreload).toBeDefined();

    rerender(<HeroSpotlight items={suspendItems} suspended />);
    expect(firstProbe).toMatchObject({ src: "", onload: null, onerror: null });
    expect(firstPreload!.src).toBe("");

    rerender(<HeroSpotlight items={suspendItems} />);
    expect(created.filter((image) =>
      image.crossOrigin === "anonymous" &&
      image.requestedUrl.includes("/suspend-active-a-regression.jpg")))
      .toHaveLength(2);
    expect(created.filter((image) =>
      image.crossOrigin === "" &&
      image.requestedUrl.includes("/suspend-active-b-regression.jpg")))
      .toHaveLength(2);
  });

  it("aborts preload and probe work while hidden and resumes exactly one of each", () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const visibilityItems: MediaPreview[] = [
      { ...items[0], id: "visibility-a", backdropPath: "/visibility-a-regression.jpg" },
      { ...items[1], id: "visibility-b", backdropPath: "/visibility-b-regression.jpg" },
    ];
    render(<HeroSpotlight items={visibilityItems} />);
    const firstProbe = created.find((image) =>
      image.crossOrigin === "anonymous" &&
      image.requestedUrl.includes("/visibility-a-regression.jpg"));
    const firstPreload = created.find((image) =>
      image.crossOrigin === "" &&
      image.requestedUrl.includes("/visibility-b-regression.jpg"));
    expect(firstProbe).toBeDefined();
    expect(firstPreload).toBeDefined();

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(firstProbe).toMatchObject({ src: "", onload: null, onerror: null });
    expect(firstPreload!.src).toBe("");

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(created.filter((image) =>
      image.crossOrigin === "anonymous" &&
      image.requestedUrl.includes("/visibility-a-regression.jpg")))
      .toHaveLength(2);
    expect(created.filter((image) =>
      image.crossOrigin === "" &&
      image.requestedUrl.includes("/visibility-b-regression.jpg")))
      .toHaveLength(2);
  });

  it("immediately aborts matching preload and probe work after a display failure", () => {
    const duplicateBackdropItems: MediaPreview[] = [
      { ...items[0], id: "matching-work-a", backdropPath: "/matching-work-regression.jpg" },
      { ...items[1], id: "matching-work-b", backdropPath: "/matching-work-regression.jpg" },
    ];
    const { container } = render(<HeroSpotlight items={duplicateBackdropItems} />);
    const probe = created.find((image) => image.crossOrigin === "anonymous");
    const preload = created.find((image) => image.crossOrigin === "");
    expect(probe).toBeDefined();
    expect(preload).toBeDefined();

    fireEvent.error(container.querySelector("img.hero-backdrop")!);

    expect(probe).toMatchObject({ src: "", onload: null, onerror: null });
    expect(preload!.src).toBe("");
    expect(created).toHaveLength(2);
  });

  it("does not display, prefetch, or probe a failed backdrop when revisited", () => {
    const failedItems: MediaPreview[] = [
      { ...items[0], id: "failed-revisit-a", backdropPath: "/failed-revisit-a-regression.jpg" },
      { ...items[1], id: "failed-revisit-b", backdropPath: "/failed-revisit-b-regression.jpg" },
      { ...items[2], id: "failed-revisit-c", backdropPath: "/failed-revisit-c-regression.jpg" },
    ];
    const { container } = render(<HeroSpotlight items={failedItems} />);
    const dots = container.querySelectorAll<HTMLButtonElement>(".hero-dot");
    fireEvent.click(dots[1]);
    const activeProbe = created.find((image) =>
      image.crossOrigin === "anonymous" &&
      image.requestedUrl.includes("/failed-revisit-b-regression.jpg"));
    expect(activeProbe).toBeDefined();
    fireEvent.error(
      [...container.querySelectorAll<HTMLImageElement>("img.hero-backdrop")]
        .find((image) => image.src.includes("/failed-revisit-b-regression.jpg"))!,
    );
    expect(activeProbe).toMatchObject({ src: "", onload: null, onerror: null });
    const failedRequestCount = created.filter((image) =>
      image.requestedUrl.includes("/failed-revisit-b-regression.jpg")).length;

    fireEvent.click(dots[2]);
    fireEvent.click(dots[0]);
    fireEvent.click(dots[1]);

    expect(created.filter((image) =>
      image.requestedUrl.includes("/failed-revisit-b-regression.jpg")))
      .toHaveLength(failedRequestCount);
    expect(
      [...container.querySelectorAll<HTMLImageElement>("img.hero-backdrop")].some((image) =>
        image.src.includes("/failed-revisit-b-regression.jpg"),
      ),
    ).toBe(false);
    expect(container.querySelector(".hero-backdrop.hero-gradient")).not.toBeNull();
  });

  it("preloads the following backdrop after advancing", () => {
    isSmartPreloadEnabled.mockReturnValue(true);
    const { container } = render(<HeroSpotlight items={items} />);
    created.length = 0;
    const dots = container.querySelectorAll<HTMLButtonElement>(".hero-dot");
    act(() => {
      dots[1].click();
    });
    // Active is now Bravo (index 1) -> next is Charlie (index 2).
    expect(created.some((c) => c.src.includes("/charlie.jpg"))).toBe(true);
  });
});

describe("HeroSpotlight per-title accent probe", () => {
  it("sets --title-accent-rgb from the dominant backdrop color on probe load", () => {
    // Drive a deterministic getImageData so extractDominantRGB returns a value.
    const vivid = new Uint8ClampedArray(24 * 14 * 4);
    for (let i = 0; i < vivid.length; i += 4) {
      vivid[i] = 200; // R high
      vivid[i + 1] = 40; // G low -> saturated, mid luminance
      vivid[i + 2] = 40; // B low
      vivid[i + 3] = 255;
    }
    const ctx = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: vivid })),
    };
    const getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    // Capture the probe Image so we can fire its onload manually.
    const OriginalImage = globalThis.Image;
    let probe: { onload: (() => void) | null; src: string } | null = null;
    class FakeImage {
      crossOrigin = "";
      onload: (() => void) | null = null;
      private _src = "";
      set src(v: string) {
        this._src = v;
        // The accent probe sets crossOrigin before src; treat it as the probe.
        if (this.crossOrigin === "anonymous") probe = this as unknown as typeof probe;
      }
      get src() {
        return this._src;
      }
    }
    // @ts-expect-error -- test double.
    globalThis.Image = FakeImage;

    try {
      const { container } = render(<HeroSpotlight item={items[0]} />);
      const hero = container.querySelector(".hero") as HTMLElement;
      expect(probe).not.toBeNull();
      act(() => {
        probe!.onload?.();
      });
      expect(hero.style.getPropertyValue("--title-accent-rgb")).not.toBe("");
    } finally {
      globalThis.Image = OriginalImage;
      getContextSpy.mockRestore();
    }
  });

  it("does not repeat a failed anonymous probe after rotating away and back", () => {
    interface ProbeImage {
      crossOrigin: string;
      onload: (() => void) | null;
      onerror: (() => void) | null;
      requestedUrl: string;
      src: string;
    }
    const OriginalImage = globalThis.Image;
    const created: ProbeImage[] = [];
    class FakeImage {
      crossOrigin = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      requestedUrl = "";
      private _src = "";
      constructor() {
        created.push(this);
      }
      set src(value: string) {
        this._src = value;
        if (value) this.requestedUrl = value;
      }
      get src() {
        return this._src;
      }
    }
    // @ts-expect-error -- test double.
    globalThis.Image = FakeImage;
    const probeItems: MediaPreview[] = [
      { ...items[0], id: "accent-error-a", backdropPath: "/accent-error-a-regression.jpg" },
      { ...items[1], id: "accent-error-b", backdropPath: "/accent-error-b-regression.jpg" },
    ];

    try {
      const { container } = render(<HeroSpotlight items={probeItems} />);
      const failedProbe = created.find((image) =>
        image.crossOrigin === "anonymous" &&
        image.requestedUrl.includes("/accent-error-a-regression.jpg"));
      expect(failedProbe).toBeDefined();
      act(() => failedProbe!.onerror?.());

      const dots = container.querySelectorAll<HTMLButtonElement>(".hero-dot");
      fireEvent.click(dots[1]);
      fireEvent.click(dots[0]);

      expect(created.filter((image) =>
        image.crossOrigin === "anonymous" &&
        image.requestedUrl.includes("/accent-error-a-regression.jpg")))
        .toHaveLength(1);
    } finally {
      globalThis.Image = OriginalImage;
    }
  });

  it("evicts the oldest failed anonymous probe when the shared cache is full", () => {
    interface ProbeImage {
      crossOrigin: string;
      onload: (() => void) | null;
      onerror: (() => void) | null;
      requestedUrl: string;
      src: string;
    }
    const OriginalImage = globalThis.Image;
    const created: ProbeImage[] = [];
    class FakeImage {
      crossOrigin = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      requestedUrl = "";
      private _src = "";
      constructor() {
        created.push(this);
      }
      set src(value: string) {
        this._src = value;
        if (value) this.requestedUrl = value;
      }
      get src() {
        return this._src;
      }
    }
    // @ts-expect-error -- test double.
    globalThis.Image = FakeImage;
    const makeItem = (index: number, id = `accent-bound-${index}`): MediaPreview => ({
      id,
      type: "movie",
      title: `Accent bound ${index}`,
      backdropPath: `/accent-bound-${index}-regression.jpg`,
    });

    try {
      const { rerender } = render(<HeroSpotlight item={makeItem(0)} />);
      for (let index = 0; index <= 64; index += 1) {
        if (index > 0) rerender(<HeroSpotlight item={makeItem(index)} />);
        const probe = [...created].reverse().find((image) =>
          image.crossOrigin === "anonymous" &&
          image.requestedUrl.includes(`/accent-bound-${index}-regression.jpg`));
        expect(probe, `accent probe ${index}`).toBeDefined();
        act(() => probe!.onerror?.());
      }

      rerender(<HeroSpotlight item={makeItem(0, "accent-bound-return")} />);
      expect(created.filter((image) =>
        image.crossOrigin === "anonymous" &&
        image.requestedUrl.includes("/accent-bound-0-regression.jpg")))
        .toHaveLength(2);

      rerender(<HeroSpotlight item={makeItem(64, "accent-bound-latest-return")} />);
      expect(created.filter((image) =>
        image.crossOrigin === "anonymous" &&
        image.requestedUrl.includes("/accent-bound-64-regression.jpg")))
        .toHaveLength(1);
    } finally {
      globalThis.Image = OriginalImage;
    }
  });
});
