// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { ErrorBoundary } from "./ErrorBoundary";

// The return type is annotated because TypeScript infers `void` (not `never`)
// for a function *declaration* whose body only throws, and `void` is not a
// valid JSX element type. The component still always throws.
function FailingChild(): ReactNode {
  throw new Error("broken screen");
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
