// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const refreshMocks = vi.hoisted(() => ({
  prepare: vi.fn<() => Promise<void>>(),
  assertAllowed: vi.fn(),
  reload: vi.fn(),
}));
vi.mock("../lib/browserAppRefresh", () => ({
  prepareBrowserAppRefresh: refreshMocks.prepare,
  assertBrowserAppRefreshAllowed: refreshMocks.assertAllowed,
  reloadBrowserAppPage: refreshMocks.reload,
}));
import { ErrorBoundary } from "./ErrorBoundary";

// The return type is annotated because TypeScript infers `void` (not `never`)
// for a function *declaration* whose body only throws, and `void` is not a
// valid JSX element type. The component still always throws.
function FailingChild(): ReactNode {
  throw new Error("broken screen");
}

function StaleAssetChild(): ReactNode {
  throw new Error("Unable to preload CSS for /assets/TierOnboarding-DEXptdKN.css");
}

describe("ErrorBoundary", () => {
  const originalReload = window.location.reload;
  const originalError = console.error;

  afterEach(() => {
    Object.defineProperty(window, "location", {
      value: {
        ...window.location,
        reload: originalReload,
      },
      configurable: true,
    });
    console.error = originalError;
    vi.clearAllMocks();
    refreshMocks.prepare.mockResolvedValue(undefined);
  });

  it("renders a recovery card when a child throws", () => {
    render(
      <ErrorBoundary>
        <FailingChild />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText(/broken screen/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload app" })).toBeInTheDocument();
  });

  it("calls a local recovery action when Go home is provided", async () => {
    const onGoHome = vi.fn();
    render(
      <ErrorBoundary onGoHome={onGoHome} homeLabel="Close">
        <FailingChild />
      </ErrorBoundary>,
    );

    const action = screen.getByRole("button", { name: "Close" });
    await action.click();
    expect(onGoHome).toHaveBeenCalled();
  });

  it("supports overlay styling when asked", () => {
    render(
      <ErrorBoundary onGoHome={vi.fn()} overlay>
        <FailingChild />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveClass("error-boundary-overlay");
  });

  it("triggers a full reload fallback", () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      value: {
        ...window.location,
        reload,
      },
      configurable: true,
    });
    render(
      <ErrorBoundary>
        <FailingChild />
      </ErrorBoundary>,
    );

    screen.getByRole("button", { name: "Reload app" }).click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("offers an honest explicit recovery for a stale hashed asset", async () => {
    render(
      <ErrorBoundary>
        <StaleAssetChild />
      </ErrorBoundary>,
    );

    expect(screen.getByText("App files could not load")).toBeInTheDocument();
    expect(screen.getByText(/connection interruption/i)).toBeInTheDocument();
    expect(screen.getByText(/saved data will not be erased/i)).toBeInTheDocument();
    expect(refreshMocks.prepare).not.toHaveBeenCalled();

    screen.getByRole("button", { name: "Reload app" }).click();
    await waitFor(() => expect(refreshMocks.reload).toHaveBeenCalledTimes(1));
    expect(refreshMocks.prepare).toHaveBeenCalledTimes(1);
    expect(refreshMocks.assertAllowed).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed stale-asset recovery visible and retryable", async () => {
    refreshMocks.prepare.mockRejectedValue(new Error("offline"));
    render(
      <ErrorBoundary>
        <StaleAssetChild />
      </ErrorBoundary>,
    );

    screen.getByRole("button", { name: "Reload app" }).click();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Could not reload the app",
    );
    expect(screen.getByRole("button", { name: "Reload app" })).toBeEnabled();
    screen.getByRole("button", { name: "Reload app" }).click();
    await waitFor(() => expect(refreshMocks.prepare).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status")).toHaveTextContent("Could not reload the app");
    expect(refreshMocks.reload).not.toHaveBeenCalled();
  });

  it("deduplicates stale recovery and cancels it when the boundary owner changes", async () => {
    let resolve!: () => void;
    refreshMocks.prepare.mockImplementation(
      () => new Promise<void>((done) => { resolve = done; }),
    );
    const { rerender } = render(
      <ErrorBoundary resetKey="old">
        <StaleAssetChild />
      </ErrorBoundary>,
    );
    const reload = screen.getByRole("button", { name: "Reload app" });
    act(() => {
      reload.click();
      reload.click();
    });
    expect(refreshMocks.prepare).toHaveBeenCalledTimes(1);

    rerender(
      <ErrorBoundary resetKey="new">
        <div>Recovered owner</div>
      </ErrorBoundary>,
    );
    await act(async () => resolve());
    expect(await screen.findByText("Recovered owner")).toBeInTheDocument();
    expect(refreshMocks.assertAllowed).not.toHaveBeenCalled();
    expect(refreshMocks.reload).not.toHaveBeenCalled();
  });

  it("does not finish stale recovery after the boundary unmounts", async () => {
    let resolve!: () => void;
    refreshMocks.prepare.mockImplementation(
      () => new Promise<void>((done) => { resolve = done; }),
    );
    const { unmount } = render(
      <ErrorBoundary>
        <StaleAssetChild />
      </ErrorBoundary>,
    );
    screen.getByRole("button", { name: "Reload app" }).click();
    expect(refreshMocks.prepare).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => resolve());
    expect(refreshMocks.assertAllowed).not.toHaveBeenCalled();
    expect(refreshMocks.reload).not.toHaveBeenCalled();
  });

  it("resets from a caught error when the reset key changes", async () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="one">
        <FailingChild />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    rerender(
      <ErrorBoundary resetKey="two">
        <div>Recovered</div>
      </ErrorBoundary>,
    );

    expect(await screen.findByText("Recovered")).toBeInTheDocument();
  });

  it("logs component errors with optional label context", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary label="test-boundary">
        <FailingChild />
      </ErrorBoundary>,
    );

    expect(error).toHaveBeenCalledWith(
      "[ErrorBoundary test-boundary]",
      expect.any(Error),
      expect.any(String),
    );
  });

  it("surfaces a generic message when the captured error has no message", () => {
    function EmptyMessageErrorChild(): ReactNode {
      throw new Error();
    }

    render(
      <ErrorBoundary>
        <EmptyMessageErrorChild />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("An unexpected error occurred.")).toBeInTheDocument();
  });
});
