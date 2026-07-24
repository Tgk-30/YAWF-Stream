// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HostAvailabilityBanner } from "./HostAvailabilityBanner";

vi.mock("../lib/serverMode", () => ({
  configuredServerURL: () => "https://server.example",
  isServerMode: () => true,
}));

describe("HostAvailabilityBanner", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays hidden while the server health check succeeds", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as typeof fetch;
    render(<HostAvailabilityBanner />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("distinguishes a device that is offline", async () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    global.fetch = vi.fn() as typeof fetch;
    render(<HostAvailabilityBanner />);
    expect(
      await screen.findByText("This device is offline"),
    ).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("explains an unreachable host and clears the warning after retry", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Load failed"))
      .mockResolvedValueOnce({ ok: true }) as typeof fetch;
    render(<HostAvailabilityBanner />);
    expect(
      await screen.findByText("Server connection lost"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/host may be asleep, powered off, or unavailable/),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
