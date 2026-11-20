// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTVRemoteSession,
  revokeTVRemoteSession,
  type TVRemoteSession,
} from "../lib/serverApi";
import { getTVRemoteSession, setTVRemoteSession } from "../lib/tvRemoteSession";
import { TVPairingDock } from "./TVPairingDock";

vi.mock("../lib/serverMode", () => ({
  isServerMode: () => true,
}));

vi.mock("../lib/serverApi", () => ({
  createTVRemoteSession: vi.fn(),
  revokeTVRemoteSession: vi.fn(),
}));

const createSession = vi.mocked(createTVRemoteSession);
const revokeSession = vi.mocked(revokeTVRemoteSession);

function session(
  id: string,
  pairingCode: string,
  pairingExpiresAt: string,
): TVRemoteSession {
  return {
    id,
    pairingCode,
    pairingExpiresAt,
    expiresAt: "2026-07-25T00:00:00.000Z",
  };
}

describe("TVPairingDock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
    createSession.mockReset();
    revokeSession.mockReset().mockResolvedValue(undefined);
    setTVRemoteSession(null);
  });

  afterEach(() => {
    setTVRemoteSession(null);
    vi.useRealTimers();
  });

  it("keeps the pairing code out of the normal TV UI until requested", async () => {
    createSession.mockResolvedValue(
      session("session-1", "123456", "2026-07-24T12:15:00.000Z"),
    );

    render(<TVPairingDock />);

    await act(async () => {
      await Promise.resolve();
    });
    const show = screen.getByRole("button", { name: "Show phone remote code" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("123456")).not.toBeInTheDocument();
    fireEvent.click(show);
    expect(screen.getByText("123456")).toBeInTheDocument();
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("does not create a session while the initial TV screen is covered", async () => {
    createSession.mockResolvedValue(session("session-1", "123456", "2026-07-24T12:15:00.000Z"));
    const { rerender } = render(<TVPairingDock covered />);
    await act(async () => { await Promise.resolve(); });
    expect(createSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("complementary", { name: "Phone remote pairing" })).not.toBeInTheDocument();

    rerender(<TVPairingDock />);
    await act(async () => { await Promise.resolve(); });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("123456")).not.toBeInTheDocument();
  });

  it("hides the pairing interface over Detail without recreating its session", () => {
    setTVRemoteSession(session("session-1", "123456", "2026-07-24T12:15:00.000Z"));
    const { rerender } = render(<TVPairingDock />);
    fireEvent.click(screen.getByRole("button", { name: "Show phone remote code" }));
    expect(screen.getByText("123456")).toBeInTheDocument();
    rerender(<TVPairingDock covered />);
    expect(screen.queryByRole("complementary", { name: "Phone remote pairing" })).not.toBeInTheDocument();
    expect(screen.queryByText("123456")).not.toBeInTheDocument();
    rerender(<TVPairingDock />);
    expect(screen.getByRole("button", { name: "Show phone remote code" })).toBeInTheDocument();
    expect(createSession).not.toHaveBeenCalled();
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it("expires the code without revoking the viewer or replacing it automatically", async () => {
    const existing = session("session-1", "123456", "2026-07-24T12:00:01.000Z");
    setTVRemoteSession(existing);
    createSession.mockResolvedValue(
      session("session-2", "654321", "2026-07-24T12:15:01.000Z"),
    );

    render(<TVPairingDock />);
    fireEvent.click(screen.getByRole("button", { name: "Show phone remote code" }));
    expect(screen.getByText("123456")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(screen.queryByText("123456")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("The pairing code has expired.");
    expect(getTVRemoteSession()).toBe(existing);
    expect(revokeSession).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();

    const newCode = screen.getByRole("button", { name: "New code" });
    expect(newCode).toHaveAccessibleDescription("Creating a new code disconnects any paired phone.");
    await act(async () => { fireEvent.click(newCode); });

    expect(revokeSession).toHaveBeenCalledExactlyOnceWith("session-1");
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(screen.getByText("654321")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not rotate the session when its code expires behind the player", async () => {
    const existing = session("session-1", "123456", "2026-07-24T12:00:01.000Z");
    setTVRemoteSession(existing);
    const { rerender } = render(<TVPairingDock covered />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(getTVRemoteSession()).toBe(existing);
    expect(revokeSession).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("complementary", { name: "Phone remote pairing" })).not.toBeInTheDocument();

    rerender(<TVPairingDock />);
    fireEvent.click(screen.getByRole("button", { name: "Show phone remote code" }));
    expect(screen.queryByText("123456")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("The pairing code has expired.");
  });

  it.each(["2026-07-24T11:59:00.000Z", "invalid"])(
    "does not expose a stale or unusable code on opening (%s)",
    (expiresAt) => {
      const existing = session("session-1", "123456", expiresAt);
      setTVRemoteSession(existing);
      render(<TVPairingDock />);
      fireEvent.click(screen.getByRole("button", { name: "Show phone remote code" }));
      expect(screen.queryByText("123456")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("The pairing code has expired.");
      expect(getTVRemoteSession()).toBe(existing);
    },
  );
});
