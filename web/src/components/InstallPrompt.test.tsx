// @vitest-environment jsdom
//
// Coverage for the mobile add-to-home-screen card: the eligibility gate
// (never Tauri, never standalone, mobile browsers only), iOS manual steps,
// the Android one-tap install flow via a captured beforeinstallprompt, the
// Android no-event menu fallback, the plain-HTTP explanation that replaces it
// when the origin is not a secure context, and dismissal.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BeforeInstallPromptEvent } from "../lib/platform";

const deviceKindMock = vi.fn<() => string>(() => "ios");
const isStandaloneMock = vi.fn(() => false);
const isMobileMock = vi.fn(() => true);
const isSecureMock = vi.fn(() => true);
vi.mock("../lib/platform", () => ({
  deviceKind: () => deviceKindMock(),
  isStandaloneDisplay: () => isStandaloneMock(),
  isMobileBrowser: () => isMobileMock(),
  isSecureContextForInstall: () => isSecureMock(),
}));

const isTauriMock = vi.fn(() => false);
vi.mock("../lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}));

const getInstallPromptMock = vi.fn<() => BeforeInstallPromptEvent | null>(
  () => null,
);
const consumeInstallPrompt = vi.fn();
vi.mock("../lib/installPrompt", () => ({
  getInstallPrompt: () => getInstallPromptMock(),
  subscribeInstallPrompt: () => () => {},
  consumeInstallPrompt: () => consumeInstallPrompt(),
}));

import { InstallPrompt, isInstallPromptEligible } from "./InstallPrompt";

function fakePromptEvent(outcome: "accepted" | "dismissed") {
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    userChoice: Promise.resolve({ outcome, platform: "web" }),
  } as unknown as BeforeInstallPromptEvent;
}

describe("isInstallPromptEligible", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isTauriMock.mockReturnValue(false);
    isStandaloneMock.mockReturnValue(false);
    isMobileMock.mockReturnValue(true);
  });

  it("is eligible in a plain mobile browser", () => {
    expect(isInstallPromptEligible()).toBe(true);
  });

  it("is never eligible inside Tauri", () => {
    isTauriMock.mockReturnValue(true);
    expect(isInstallPromptEligible()).toBe(false);
  });

  it("is never eligible once running standalone (already installed)", () => {
    isStandaloneMock.mockReturnValue(true);
    expect(isInstallPromptEligible()).toBe(false);
  });

  it("is never eligible on a desktop browser", () => {
    isMobileMock.mockReturnValue(false);
    expect(isInstallPromptEligible()).toBe(false);
  });
});

describe("InstallPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getInstallPromptMock.mockReturnValue(null);
  });

  it("shows the Safari Share → Add to Home Screen steps on iOS", () => {
    deviceKindMock.mockReturnValue("ios");
    render(<InstallPrompt onDismiss={() => {}} />);
    expect(screen.getByText("Install YAWF Stream")).toBeInTheDocument();
    expect(screen.getByText(/Tap the Share button/)).toBeInTheDocument();
    expect(screen.getByText("Add to Home Screen")).toBeInTheDocument();
    // No one-tap install on iOS - Safari has no beforeinstallprompt.
    expect(
      screen.queryByRole("button", { name: "Install" }),
    ).not.toBeInTheDocument();
  });

  it("offers one-tap Install on Android when the prompt event was captured", async () => {
    const user = userEvent.setup();
    deviceKindMock.mockReturnValue("android");
    const event = fakePromptEvent("accepted");
    getInstallPromptMock.mockReturnValue(event);
    const onDismiss = vi.fn();
    render(<InstallPrompt onDismiss={onDismiss} />);
    await user.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(consumeInstallPrompt).toHaveBeenCalledTimes(1);
  });

  it("keeps the card up when the user dismisses the browser install dialog", async () => {
    const user = userEvent.setup();
    deviceKindMock.mockReturnValue("android");
    const event = fakePromptEvent("dismissed");
    getInstallPromptMock.mockReturnValue(event);
    const onDismiss = vi.fn();
    render(<InstallPrompt onDismiss={onDismiss} />);
    await user.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(consumeInstallPrompt).toHaveBeenCalledTimes(1));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("falls back to browser-menu steps on Android without a captured event", () => {
    deviceKindMock.mockReturnValue("android");
    getInstallPromptMock.mockReturnValue(null);
    isSecureMock.mockReturnValue(true);
    render(<InstallPrompt onDismiss={() => {}} />);
    expect(screen.getByText(/Open your browser menu/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Install" }),
    ).not.toBeInTheDocument();
  });

  // Chromium hides the install entry outright on a plain-HTTP origin, so the
  // menu copy above would send the user hunting for something that is absent.
  it("explains the plain-HTTP cause on Android instead of the menu steps", () => {
    deviceKindMock.mockReturnValue("android");
    getInstallPromptMock.mockReturnValue(null);
    isSecureMock.mockReturnValue(false);
    render(<InstallPrompt onDismiss={() => {}} />);
    expect(screen.getByText(/served over plain HTTP/)).toBeInTheDocument();
    expect(screen.queryByText(/Open your browser menu/)).not.toBeInTheDocument();
  });

  // iOS Add to Home Screen is not gated on a secure context, so an insecure
  // origin must not swap Safari's steps for an Android-only explanation.
  it("keeps the iOS steps on an insecure origin", () => {
    deviceKindMock.mockReturnValue("ios");
    getInstallPromptMock.mockReturnValue(null);
    isSecureMock.mockReturnValue(false);
    render(<InstallPrompt onDismiss={() => {}} />);
    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument();
    expect(screen.queryByText(/served over plain HTTP/)).not.toBeInTheDocument();
  });

  it("dismiss button calls onDismiss", async () => {
    const user = userEvent.setup();
    deviceKindMock.mockReturnValue("ios");
    const onDismiss = vi.fn();
    render(<InstallPrompt onDismiss={onDismiss} />);
    await user.click(
      screen.getByRole("button", { name: "Dismiss install suggestion" }),
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
