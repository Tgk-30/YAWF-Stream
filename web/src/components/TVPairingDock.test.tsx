// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTVRemoteSession,
  revokeTVRemoteSession,
  type TVRemoteSession,
} from "../lib/serverApi";
import { setTVRemoteSession } from "../lib/tvRemoteSession";
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

  it("creates a pairing code when the TV route opens", async () => {
    createSession.mockResolvedValue(
      session("session-1", "123456", "2026-07-24T12:15:00.000Z"),
    );

    render(<TVPairingDock />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("123456")).toBeInTheDocument();
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("replaces a pairing code as soon as it expires", async () => {
    setTVRemoteSession(
      session("session-1", "123456", "2026-07-24T12:00:01.000Z"),
    );
    createSession.mockResolvedValue(
      session("session-2", "654321", "2026-07-24T12:15:01.000Z"),
    );

    render(<TVPairingDock />);
    expect(screen.getByText("123456")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(screen.getByText("654321")).toBeInTheDocument();
    expect(revokeSession).toHaveBeenCalledWith("session-1");
    expect(createSession).toHaveBeenCalledTimes(1);
  });
});
