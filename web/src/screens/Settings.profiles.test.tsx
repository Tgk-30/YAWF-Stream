// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../data/settings";
import type { LocalProfile } from "../storage/ProfileRegistry";

const mocks = vi.hoisted(() => ({ store: {} as Record<string, unknown>, write: vi.fn(), refresh: vi.fn(), updateSettings: vi.fn() }));
vi.mock("../store/AppStore", () => ({ useAppStore: () => mocks.store, isPlayerNavigationPending: () => false }));
vi.mock("../storage/ProfileRegistry", () => ({
  updateProfileRecord: mocks.write, getAutoEnterProfileId: async () => null,
  createProfileRecord: vi.fn(), deleteProfileRecord: vi.fn(), setMultiUserEnabled: vi.fn(), setAutoEnterProfileId: vi.fn(),
}));
vi.mock("../lib/serverMode", () => ({ isServerMode: () => false, configuredServerURL: () => null, configuredServerURLSource: () => null, saveServerURL: vi.fn() }));
vi.mock("../lib/ServerSessionContext", () => ({ useServerSession: () => null, useSetServerSession: () => vi.fn(), useTranscodeAvailable: () => false }));
vi.mock("../lib/appVersion", () => ({ getAppVersion: async () => "test" }));
vi.mock("../lib/tauri", async (original) => ({ ...await original<typeof import("../lib/tauri")>(), isTauri: () => false, isDesktopTauri: () => false }));
import { Settings } from "./Settings";

const a: LocalProfile = { id: "a", name: "You", isDefault: true, isAdmin: true, createdAt: 1 };
const b: LocalProfile = { id: "b", name: "Other", isDefault: false, isAdmin: true, createdAt: 2 };
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function names() { return screen.getAllByRole("textbox", { name: "Name" }) as HTMLInputElement[]; }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.write.mockResolvedValue(undefined); mocks.refresh.mockResolvedValue(undefined); mocks.updateSettings.mockResolvedValue({ ok: true });
  mocks.store = { settings: { ...defaultSettings(), userName: "You" }, services: null, updateSettings: mocks.updateSettings, simpleMode: false, activeProfile: a, profiles: [a, b], multiUserEnabled: true, refreshProfiles: mocks.refresh, pendingSettingsSection: "profiles", clearPendingSettingsSection: vi.fn() };
});
afterEach(cleanup);

describe("local profile name editing", () => {
  it("shows every typed character immediately while record writes and stale props are pending", async () => {
    const pending = deferred(); mocks.write.mockReturnValue(pending.promise);
    const view = render(<Settings />);
    const input = names()[0];
    fireEvent.change(input, { target: { value: "O" } });
    expect(input.value).toBe("O");
    view.rerender(<Settings />);
    expect(names()[0].value).toBe("O");
    fireEvent.change(names()[0], { target: { value: "OTA Runner" } });
    expect(names()[0].value).toBe("OTA Runner");
    await act(async () => pending.resolve());
    await waitFor(() => expect(mocks.write).toHaveBeenLastCalledWith("a", { name: "OTA Runner" }));
    view.rerender(<Settings />);
    expect(names()[0].value).toBe("OTA Runner");
    expect(mocks.updateSettings).toHaveBeenLastCalledWith(expect.objectContaining({ userName: "OTA Runner" }));
  });
  it("serializes rapid name writes and syncs only the latest name using current settings", async () => {
    const first = deferred(); mocks.write.mockImplementationOnce(() => first.promise);
    const view = render(<Settings />);
    fireEvent.change(names()[0], { target: { value: "O" } });
    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(1));
    fireEvent.change(names()[0], { target: { value: "OT" } });
    fireEvent.change(names()[0], { target: { value: "OTA Runner" } });
    expect(names()[0].value).toBe("OTA Runner");
    await act(async () => { await Promise.resolve(); });
    expect(mocks.write).toHaveBeenCalledTimes(1);
    mocks.store.settings = { ...defaultSettings(), userName: "You", userAvatar: "new-avatar" };
    view.rerender(<Settings />);
    await act(async () => first.resolve());
    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(3));
    expect(mocks.write.mock.calls).toEqual([["a", { name: "O" }], ["a", { name: "OT" }], ["a", { name: "OTA Runner" }]]);
    expect(mocks.updateSettings).toHaveBeenCalledTimes(1);
    expect(mocks.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ userName: "OTA Runner", userAvatar: "new-avatar" }));
  });

  it("does not let a late stale refresh replace an acknowledged draft", async () => {
    const view = render(<Settings />);
    fireEvent.change(names()[0], { target: { value: "OTA Runner" } });
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    mocks.store.profiles = [{ ...a, name: "OTA Runner" }, b]; view.rerender(<Settings />);
    expect(names()[0].value).toBe("OTA Runner");
    mocks.store.profiles = [a, b]; view.rerender(<Settings />);
    expect(names()[0].value).toBe("OTA Runner");
  });

  it("keeps profile drafts and pending completions owned by their record id across switching", async () => {
    const pendingA = deferred();
    mocks.write.mockImplementation((id: string) => id === "a" ? pendingA.promise : Promise.resolve());
    const view = render(<Settings />);
    fireEvent.change(names()[0], { target: { value: "Alice" } });
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith("a", { name: "Alice" }));
    mocks.store.activeProfile = b; mocks.store.settings = { ...defaultSettings(), userName: "Other" };
    view.rerender(<Settings />);
    expect(names()[0].value).toBe("Alice"); expect(names()[1].value).toBe("Other");
    fireEvent.change(names()[1], { target: { value: "Bob" } });
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ userName: "Bob" })));
    await act(async () => pendingA.resolve());
    expect(mocks.updateSettings.mock.calls.map(([settings]) => settings.userName)).toEqual(["Bob"]);
    expect(mocks.write.mock.calls).toEqual([["a", { name: "Alice" }], ["b", { name: "Bob" }]]);
    expect(names()[0].value).toBe("Alice"); expect(names()[1].value).toBe("Bob");
  });

  it("can reconcile a pending name when that same profile becomes active again", async () => {
    const pending = deferred(); mocks.write.mockReturnValue(pending.promise);
    const view = render(<Settings />);
    fireEvent.change(names()[0], { target: { value: "Alice" } });
    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    mocks.store.activeProfile = b; mocks.store.settings = { ...defaultSettings(), userName: "Other" }; view.rerender(<Settings />);
    mocks.store.activeProfile = a; mocks.store.settings = { ...defaultSettings(), userName: "You", userAvatar: "current-avatar" }; view.rerender(<Settings />);
    await act(async () => pending.resolve());
    expect(mocks.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ userName: "Alice", userAvatar: "current-avatar" }));
  });

  it("bounds names to 40 characters in the draft and atomic record patch", async () => {
    render(<Settings />);
    fireEvent.change(names()[0], { target: { value: "A".repeat(45) } });
    expect(names()[0].value).toBe("A".repeat(40));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith("a", { name: "A".repeat(40) }));
  });

  it.each(["record", "settings", "refresh"])("retains the draft and reports a %s failure without an unhandled rejection", async (step) => {
    if (step === "record") mocks.write.mockRejectedValue(new Error("record failed"));
    if (step === "settings") mocks.updateSettings.mockResolvedValue({ ok: false });
    if (step === "refresh") mocks.refresh.mockRejectedValue(new Error("refresh failed"));
    render(<Settings />);
    fireEvent.change(names()[0], { target: { value: "OTA Runner" } });
    await screen.findByText("The profile name could not be fully saved. Your edit is kept here.");
    expect(names()[0].value).toBe("OTA Runner");
  });

  it("does not sync settings from an editor that was unmounted while its record write was pending", async () => {
    const pending = deferred(); mocks.write.mockReturnValue(pending.promise);
    const view = render(<Settings />);
    fireEvent.change(names()[0], { target: { value: "Alice" } });
    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    view.unmount(); await act(async () => pending.resolve());
    expect(mocks.updateSettings).not.toHaveBeenCalled(); expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("orders queued registry writes across editor remounts so a new draft persists last", async () => {
    const first = deferred();
    let persisted = "You";
    mocks.write.mockImplementation((_id: string, patch: { name: string }) =>
      (patch.name === "O" ? first.promise : Promise.resolve()).then(() => { persisted = patch.name; }),
    );
    const oldEditor = render(<Settings />);
    fireEvent.change(names()[0], { target: { value: "O" } });
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith("a", { name: "O" }));
    fireEvent.change(names()[0], { target: { value: "OT" } });
    oldEditor.unmount();
    render(<Settings />);
    fireEvent.change(names()[0], { target: { value: "NEW" } });
    expect(names()[0].value).toBe("NEW");
    await act(async () => { await Promise.resolve(); });
    await act(async () => first.resolve());
    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(3));
    expect(persisted).toBe("NEW");
    expect(mocks.write.mock.calls).toEqual([["a", { name: "O" }], ["a", { name: "OT" }], ["a", { name: "NEW" }]]);
    expect(mocks.updateSettings.mock.calls.map(([settings]) => settings.userName)).toEqual(["NEW"]);
    expect(names()[0].value).toBe("NEW");
  });

});
