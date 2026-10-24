// @vitest-environment jsdom
//
// Component coverage for the "Who's watching?" ProfilePicker (Server Mode).
// Exercises the grid render, switching a profile (re-hydrate + setSession +
// onClose), edit mode (Manage profiles), add (ProfileForm → createAccountProfile),
// rename (ProfileForm → updateAccountProfile), the two-step delete confirm with
// active-profile fallback switch, the kid UnlockPrompt password gate (incorrect
// password retry), and Escape-to-close.
//
// All network helpers (../lib/serverApi), the ServerSessionContext hooks, and
// the AppStore are mocked so the component renders deterministically.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServerProfileSummary } from "../lib/ServerSessionContext";

// ---- serverApi mocks --------------------------------------------------------
const fetchAccountProfiles = vi.fn();
const createAccountProfile = vi.fn();
const switchAccountProfile = vi.fn();
const updateAccountProfile = vi.fn();
const deleteAccountProfile = vi.fn();
const setProfilePin = vi.fn();
const setProfileBandwidthQuota = vi.fn();

vi.mock("../lib/serverApi", () => ({
  fetchAccountProfiles: (...a: unknown[]) => fetchAccountProfiles(...a),
  createAccountProfile: (...a: unknown[]) => createAccountProfile(...a),
  switchAccountProfile: (...a: unknown[]) => switchAccountProfile(...a),
  updateAccountProfile: (...a: unknown[]) => updateAccountProfile(...a),
  deleteAccountProfile: (...a: unknown[]) => deleteAccountProfile(...a),
  setProfilePin: (...a: unknown[]) => setProfilePin(...a),
  setProfileBandwidthQuota: (...a: unknown[]) => setProfileBandwidthQuota(...a),
}));

// ---- ServerSessionContext mocks --------------------------------------------
let mockSession: { profileId: string; role?: "owner" | "admin" | "member" } | null;
let mockProfiles: ServerProfileSummary[];
const setSession = vi.fn();
const setProfiles = vi.fn();

vi.mock("../lib/ServerSessionContext", () => ({
  useServerSession: () => mockSession,
  useServerProfiles: () => mockProfiles,
  useSetServerSession: () => setSession,
  useSetServerProfiles: () => setProfiles,
}));

// ---- AppStore mock ----------------------------------------------------------
const reloadProfileData = vi.fn();
vi.mock("../store/AppStore", () => ({
  useAppActions: () => ({ reloadProfileData }),
}));

import { ProfilePicker } from "./ProfilePicker";

function profile(over: Partial<ServerProfileSummary> = {}): ServerProfileSummary {
  return {
    id: "p1",
    displayName: "Alice",
    avatarColor: "#6366f1",
    simpleMode: false,
    isDefault: true,
    isKid: false,
    hasPin: false,
    bandwidthCapBytes: null,
    bandwidthUsageBytes: 0,
    bandwidthStatus: "ok",
    ...over,
  };
}

const ALICE = profile({ id: "p1", displayName: "Alice", isDefault: true });
const BOB = profile({ id: "p2", displayName: "Bob", isDefault: false, isKid: false });
const KID = profile({ id: "p3", displayName: "Kiddo", isDefault: false, isKid: true });

beforeEach(() => {
  vi.clearAllMocks();
  mockSession = { profileId: "p1" };
  mockProfiles = [ALICE, BOB, KID];
  // The on-open refresh resolves to the same list by default.
  fetchAccountProfiles.mockResolvedValue({
    profiles: mockProfiles,
    activeProfileId: "p1",
  });
  reloadProfileData.mockResolvedValue(undefined);
  setProfilePin.mockResolvedValue({
    profiles: { profiles: mockProfiles, activeProfileId: "p1" },
  });
  setProfileBandwidthQuota.mockResolvedValue({
    profiles: { profiles: mockProfiles, activeProfileId: "p1" },
  });
});

describe("ProfilePicker grid", () => {
  it("renders the dialog, every profile tile, the active marker, and the Kids badge", async () => {
    const onClose = vi.fn();
    render(<ProfilePicker onClose={onClose} />);

    expect(
      screen.getByRole("dialog", { name: "Who's watching?" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("Kiddo")).toBeInTheDocument();

    // Kids badge only on the kid profile.
    expect(screen.getByText("Kids")).toBeInTheDocument();

    // Active marker on Alice (current session profileId p1).
    const aliceTile = screen.getByText("Alice").closest("button")!;
    expect(aliceTile).toHaveAttribute("aria-current", "true");
    const bobTile = screen.getByText("Bob").closest("button")!;
    expect(bobTile).not.toHaveAttribute("aria-current");

    // On-open refresh fired with the fetched list.
    await waitFor(() => expect(setProfiles).toHaveBeenCalledWith(mockProfiles));
  });

  it("clicking the currently active profile is a no-op that just closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ProfilePicker onClose={onClose} />);

    await user.click(screen.getByText("Alice"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(switchAccountProfile).not.toHaveBeenCalled();
  });

  it("keeps the in-memory list when the on-open refresh rejects", async () => {
    fetchAccountProfiles.mockRejectedValueOnce(new Error("offline"));
    const onClose = vi.fn();
    render(<ProfilePicker onClose={onClose} />);
    // Tiles still render from the in-memory list.
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    // No throw; setProfiles never called from the failed refresh.
    await waitFor(() =>
      expect(setProfiles).not.toHaveBeenCalledWith(expect.anything()),
    );
  });

  it("Close button calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ProfilePicker onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("Escape closes the dialog (useModalA11y)", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ProfilePicker onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ProfilePicker switch", () => {
  it("preserves the server kid restriction when switching profiles", async () => {
    switchAccountProfile.mockResolvedValue({
      session: { profileId: "p3", username: "kiddo", displayName: "Kiddo", role: "member", avatarColor: null, simpleMode: true, isKid: true },
      profiles: { profiles: [ALICE, BOB, KID], activeProfileId: "p3" },
    });
    render(<ProfilePicker onClose={vi.fn()} />);
    await userEvent.click(screen.getByText("Kiddo"));
    await waitFor(() => expect(setSession).toHaveBeenCalledWith(expect.objectContaining({ profileId: "p3", isKid: true })));
  });

  it("keeps the target kid restriction when an older switch response omits it", async () => {
    switchAccountProfile.mockResolvedValue({
      session: { profileId: "p3", username: "kiddo", displayName: "Kiddo", role: "member", avatarColor: null, simpleMode: true },
      profiles: { profiles: [ALICE, BOB, KID], activeProfileId: "p3" },
    });
    render(<ProfilePicker onClose={vi.fn()} />);
    await userEvent.click(screen.getByText("Kiddo"));
    await waitFor(() => expect(setSession).toHaveBeenCalledWith(expect.objectContaining({ profileId: "p3", isKid: true })));
  });

  it("switches to a non-active profile: reloads data, sets session+profiles, closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    switchAccountProfile.mockResolvedValue({
      session: {
        profileId: "p2",
        username: "bob",
        displayName: "Bob",
        role: "member",
        avatarColor: "#22c55e",
        simpleMode: true,
      },
      profiles: { profiles: [ALICE, BOB, KID], activeProfileId: "p2" },
    });

    render(<ProfilePicker onClose={onClose} />);
    await user.click(screen.getByText("Bob"));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(switchAccountProfile).toHaveBeenCalledWith("p2", undefined);
    expect(reloadProfileData).toHaveBeenCalled();
    expect(setSession).toHaveBeenCalledWith({
      profileId: "p2",
      username: "bob",
      displayName: "Bob",
      role: "member",
      avatarColor: "#22c55e",
      simpleMode: true,
      isKid: false,
    });
    expect(setProfiles).toHaveBeenCalledWith([ALICE, BOB, KID]);
  });

  it("surfaces an inline error when the switch fails (non-kid path)", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    switchAccountProfile.mockRejectedValue(new Error("boom"));

    render(<ProfilePicker onClose={onClose} />);
    await user.click(screen.getByText("Bob"));

    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows a lock and prompts for the target profile PIN before switching", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const lockedBob = profile({ id: "p2", displayName: "Bob", isDefault: false, hasPin: true });
    mockProfiles = [ALICE, lockedBob, KID];
    switchAccountProfile.mockResolvedValue({
      session: {
        profileId: "p2",
        username: "bob",
        displayName: "Bob",
        role: "member",
        avatarColor: "#22c55e",
        simpleMode: true,
      },
      profiles: { profiles: mockProfiles, activeProfileId: "p2" },
    });

    render(<ProfilePicker onClose={onClose} />);
    expect(screen.getByLabelText("PIN protected")).toBeInTheDocument();
    await user.click(screen.getByText("Bob"));
    expect(screen.getByRole("dialog", { name: "Enter profile PIN" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("PIN"), "1234");
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() => expect(switchAccountProfile).toHaveBeenCalledWith("p2", "1234"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows Incorrect PIN after a 403 and leaves the current profile in place", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mockProfiles = [ALICE, profile({ id: "p2", displayName: "Bob", isDefault: false, hasPin: true })];
    switchAccountProfile.mockRejectedValue(Object.assign(new Error("protected"), { status: 403 }));

    render(<ProfilePicker onClose={onClose} />);
    await user.click(screen.getByText("Bob"));
    await user.type(screen.getByLabelText("PIN"), "1234");
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    expect(await screen.findByText("Incorrect PIN")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(setSession).not.toHaveBeenCalled();
  });
});

describe("ProfilePicker edit mode", () => {
  it("toggles Manage/Done and reveals add tile + per-tile actions", async () => {
    const user = userEvent.setup();
    render(<ProfilePicker onClose={vi.fn()} />);

    expect(screen.queryByText("Add profile")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Manage profiles" }));

    expect(screen.getByText("Add profile")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    // Default profile (Alice) has Edit but no Delete; Bob has both.
    const aliceActions = screen
      .getByText("Alice")
      .closest("li")!;
    expect(
      within(aliceActions).getByRole("button", { name: "Edit" }),
    ).toBeInTheDocument();
    expect(
      within(aliceActions).queryByRole("button", { name: /Delete Alice/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete Bob" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("Add profile")).not.toBeInTheDocument();
  });

  it("sets and clears a PIN, with the honest household-gate copy", async () => {
    const user = userEvent.setup();
    setProfilePin.mockImplementationOnce(() => {
      mockProfiles = [profile({ id: "p1", displayName: "Alice", hasPin: true }), BOB, KID];
      return Promise.resolve({ profiles: { profiles: mockProfiles, activeProfileId: "p1" } });
    });
    render(<ProfilePicker onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Manage profiles" }));
    await user.click(screen.getByRole("button", { name: "Set PIN for Alice" }));

    expect(
      screen.getByText("A household gate - it asks for a PIN to switch into this profile. It is not encryption and does not protect your data files."),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("New PIN (4-6 digits)"), "1234");
    await user.type(screen.getByLabelText("Confirm PIN"), "1234");
    await user.click(screen.getByRole("button", { name: "Set PIN" }));
    await waitFor(() => expect(setProfilePin).toHaveBeenCalledWith("p1", "1234"));

    // The picker now has the refreshed list from Set PIN, including its clear
    // action.
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove PIN for Alice" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Remove PIN for Alice" }));
    await waitFor(() => expect(setProfilePin).toHaveBeenCalledWith("p1", null));
  });

  it("owner sets and clears a warn-only monthly cap", async () => {
    const user = userEvent.setup();
    mockSession = { profileId: "p1", role: "owner" };
    setProfileBandwidthQuota.mockImplementationOnce(() => {
      mockProfiles = [
        profile({ id: "p1", displayName: "Alice", bandwidthCapBytes: 1024 ** 3 }),
        BOB,
        KID,
      ];
      return Promise.resolve({ profiles: { profiles: mockProfiles, activeProfileId: "p1" } });
    });
    render(<ProfilePicker onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Manage profiles" }));
    await user.click(screen.getByRole("button", { name: "Set monthly cap for Alice" }));
    await user.type(screen.getByLabelText("Monthly cap (GB)"), "1");
    await user.click(screen.getByRole("button", { name: "Save cap" }));
    await waitFor(() =>
      expect(setProfileBandwidthQuota).toHaveBeenCalledWith("p1", 1024 ** 3),
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Clear monthly cap for Alice" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Clear monthly cap for Alice" }));
    await waitFor(() => expect(setProfileBandwidthQuota).toHaveBeenCalledWith("p1", null));
  });

  it("Add → ProfileForm creates a profile and returns to the grid", async () => {
    const user = userEvent.setup();
    createAccountProfile.mockResolvedValue({
      profile: {
        id: "p9",
        displayName: "Charlie",
        avatarColor: "#3b82f6",
        simpleMode: true,
        isDefault: false,
        isKid: false,
        maturityMax: null,
      },
    });

    render(<ProfilePicker onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Manage profiles" }));
    await user.click(screen.getByText("Add profile"));

    // ProfileForm is shown.
    expect(
      screen.getByRole("dialog", { name: "Add profile" }),
    ).toBeInTheDocument();
    const nameInput = screen.getByLabelText("Name");
    await user.type(nameInput, "Charlie");
    // Pick a color (second dot) to exercise the color handler.
    await user.click(screen.getByRole("button", { name: "Use blue" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(createAccountProfile).toHaveBeenCalledWith({
        displayName: "Charlie",
        avatarColor: "#3b82f6",
        password: undefined,
      }),
    );
    // Back on the grid, list refreshed with the appended profile.
    await waitFor(() =>
      expect(setProfiles).toHaveBeenCalledWith([
        ALICE,
        BOB,
        KID,
        expect.objectContaining({ id: "p9", displayName: "Charlie" }),
      ]),
    );
    expect(
      await screen.findByRole("dialog", { name: "Who's watching?" }),
    ).toBeInTheDocument();
  });

  it("Add form Cancel returns to the grid without creating", async () => {
    const user = userEvent.setup();
    render(<ProfilePicker onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Manage profiles" }));
    await user.click(screen.getByText("Add profile"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(createAccountProfile).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Who's watching?" }),
    ).toBeInTheDocument();
  });

  it("Create is disabled until a name is entered, and a create error surfaces inline", async () => {
    const user = userEvent.setup();
    createAccountProfile.mockRejectedValue(new Error("name taken"));
    render(<ProfilePicker onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Manage profiles" }));
    await user.click(screen.getByText("Add profile"));

    const createBtn = screen.getByRole("button", { name: "Create" });
    expect(createBtn).toBeDisabled();

    await user.type(screen.getByLabelText("Name"), "Dup");
    expect(createBtn).toBeEnabled();
    // Fill the optional password so that branch (password !== "") is taken.
    await user.type(
      screen.getByLabelText("Password (optional)"),
      "secret",
    );
    await user.click(createBtn);

    expect(await screen.findByText("name taken")).toBeInTheDocument();
    await waitFor(() =>
      expect(createAccountProfile).toHaveBeenCalledWith(
        expect.objectContaining({ password: "secret" }),
      ),
    );
  });

  it("Edit → ProfileForm renames a profile (no password field) and refreshes", async () => {
    const user = userEvent.setup();
    updateAccountProfile.mockResolvedValue({
      ok: true,
      profiles: [
        { ...BOB, displayName: "Bobby" },
        ALICE,
        KID,
      ],
    });

    render(<ProfilePicker onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Manage profiles" }));

    const bobLi = screen.getByText("Bob").closest("li")!;
    await user.click(within(bobLi).getByRole("button", { name: "Edit" }));

    expect(
      screen.getByRole("dialog", { name: "Edit profile" }),
    ).toBeInTheDocument();
    // hidePassword: no password field in edit mode.
    expect(
      screen.queryByLabelText("Password (optional)"),
    ).not.toBeInTheDocument();

    const nameInput = screen.getByLabelText("Name");
    expect(nameInput).toHaveValue("Bob");
    await user.clear(nameInput);
    await user.type(nameInput, "Bobby");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateAccountProfile).toHaveBeenCalledWith("p2", {
        displayName: "Bobby",
        avatarColor: "#6366f1",
      }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Who's watching?" }),
    ).toBeInTheDocument();
  });
});

describe("ProfilePicker delete (two-step)", () => {
  it("Delete → Confirm removes a non-active profile and refreshes the list", async () => {
    const user = userEvent.setup();
    deleteAccountProfile.mockResolvedValue({
      ok: true,
      profiles: [ALICE, KID],
    });

    render(<ProfilePicker onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Manage profiles" }));

    await user.click(screen.getByRole("button", { name: "Delete Bob" }));
    // Two-step: a confirm group appears.
    const confirmGroup = screen.getByRole("group", { name: "Delete Bob?" });
    await user.click(
      within(confirmGroup).getByRole("button", { name: "Confirm" }),
    );

    await waitFor(() =>
      expect(deleteAccountProfile).toHaveBeenCalledWith("p2"),
    );
    await waitFor(() =>
      expect(setProfiles).toHaveBeenCalledWith([ALICE, KID]),
    );
    // Bob was NOT active → no fallback switch.
    expect(switchAccountProfile).not.toHaveBeenCalled();
  });

  it("Delete → Cancel drops the pending confirm", async () => {
    const user = userEvent.setup();
    render(<ProfilePicker onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Manage profiles" }));
    await user.click(screen.getByRole("button", { name: "Delete Bob" }));

    const confirmGroup = screen.getByRole("group", { name: "Delete Bob?" });
    await user.click(
      within(confirmGroup).getByRole("button", { name: "Cancel" }),
    );

    expect(deleteAccountProfile).not.toHaveBeenCalled();
    // Back to the plain Delete button.
    expect(
      screen.getByRole("button", { name: "Delete Bob" }),
    ).toBeInTheDocument();
  });

  it("deleting the ACTIVE profile converges onto the default fallback", async () => {
    // Make Bob the active profile so deleting him triggers the fallback switch.
    mockSession = { profileId: "p2" };
    const user = userEvent.setup();
    deleteAccountProfile.mockResolvedValue({
      ok: true,
      profiles: [ALICE, KID], // ALICE is isDefault
    });
    switchAccountProfile.mockResolvedValue({
      session: {
        profileId: "p1",
        username: "alice",
        displayName: "Alice",
        role: "owner",
        avatarColor: "#6366f1",
        simpleMode: false,
      },
      profiles: { profiles: [ALICE, KID], activeProfileId: "p1" },
    });

    render(<ProfilePicker onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Manage profiles" }));
    await user.click(screen.getByRole("button", { name: "Delete Bob" }));
    const confirmGroup = screen.getByRole("group", { name: "Delete Bob?" });
    await user.click(
      within(confirmGroup).getByRole("button", { name: "Confirm" }),
    );

    await waitFor(() =>
      expect(switchAccountProfile).toHaveBeenCalledWith("p1"),
    );
    expect(reloadProfileData).toHaveBeenCalled();
    await waitFor(() =>
      expect(setSession).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: "p1", displayName: "Alice" }),
      ),
    );
  });

  it("preserves the kid restriction on the active-profile deletion fallback", async () => {
    mockSession = { profileId: "p2" };
    deleteAccountProfile.mockResolvedValue({ ok: true, profiles: [KID] });
    switchAccountProfile.mockResolvedValue({
      session: { profileId: "p3", username: "kiddo", displayName: "Kiddo", role: "member", avatarColor: null, simpleMode: true, isKid: true },
      profiles: { profiles: [KID], activeProfileId: "p3" },
    });
    render(<ProfilePicker onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Manage profiles" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete Bob" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Delete Bob?" })).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(setSession).toHaveBeenCalledWith(expect.objectContaining({ profileId: "p3", isKid: true })));
  });

  it("surfaces an error when delete itself fails", async () => {
    const user = userEvent.setup();
    deleteAccountProfile.mockRejectedValue(new Error("nope"));
    render(<ProfilePicker onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Manage profiles" }));
    await user.click(screen.getByRole("button", { name: "Delete Bob" }));
    const confirmGroup = screen.getByRole("group", { name: "Delete Bob?" });
    await user.click(
      within(confirmGroup).getByRole("button", { name: "Confirm" }),
    );
    expect(await screen.findByText("nope")).toBeInTheDocument();
  });
});

describe("ProfilePicker kid UnlockPrompt", () => {
  beforeEach(() => {
    // ACTIVE profile is the kid → leaving it requires the account password.
    mockSession = { profileId: "p3" };
  });

  it("prompts for the account password when leaving a kid profile", async () => {
    const user = userEvent.setup();
    render(<ProfilePicker onClose={vi.fn()} />);

    await user.click(screen.getByText("Alice"));

    expect(
      screen.getByRole("dialog", { name: "Enter account password" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/required to leave a kids profile/)).toBeInTheDocument();
    // Target name shown in the copy.
    expect(screen.getByText("Alice")).toBeInTheDocument();
    // No switch yet - gated on the password.
    expect(switchAccountProfile).not.toHaveBeenCalled();
  });

  it("Unlock is disabled until a password is entered, then switches on submit", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    switchAccountProfile.mockResolvedValue({
      session: {
        profileId: "p1",
        username: "alice",
        displayName: "Alice",
        role: "owner",
        avatarColor: "#6366f1",
        simpleMode: false,
      },
      profiles: { profiles: [ALICE, BOB, KID], activeProfileId: "p1" },
    });

    render(<ProfilePicker onClose={onClose} />);
    await user.click(screen.getByText("Alice"));

    const unlockBtn = screen.getByRole("button", { name: "Unlock" });
    expect(unlockBtn).toBeDisabled();

    await user.type(screen.getByLabelText("Account password"), "hunter2");
    expect(unlockBtn).toBeEnabled();
    await user.click(unlockBtn);

    await waitFor(() =>
      expect(switchAccountProfile).toHaveBeenCalledWith("p1", "hunter2"),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows 'Incorrect password.' on a 403 and lets the user retry", async () => {
    const user = userEvent.setup();
    const err = Object.assign(new Error("forbidden"), { status: 403 });
    switchAccountProfile.mockRejectedValue(err);

    render(<ProfilePicker onClose={vi.fn()} />);
    await user.click(screen.getByText("Alice"));
    await user.type(screen.getByLabelText("Account password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    expect(await screen.findByText("Incorrect password.")).toBeInTheDocument();
    // Still on the unlock prompt; button re-enabled for retry.
    expect(screen.getByRole("button", { name: "Unlock" })).toBeEnabled();
  });

  it("shows the error message on a non-403 failure", async () => {
    const user = userEvent.setup();
    switchAccountProfile.mockRejectedValue(new Error("server down"));

    render(<ProfilePicker onClose={vi.fn()} />);
    await user.click(screen.getByText("Alice"));
    await user.type(screen.getByLabelText("Account password"), "pw");
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    expect(await screen.findByText("server down")).toBeInTheDocument();
  });

  it("Cancel closes the unlock prompt back to the grid", async () => {
    const user = userEvent.setup();
    render(<ProfilePicker onClose={vi.fn()} />);
    await user.click(screen.getByText("Alice"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("dialog", { name: "Who's watching?" }),
    ).toBeInTheDocument();
  });

  it("submits the password on Enter in the password field", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    switchAccountProfile.mockResolvedValue({
      session: {
        profileId: "p1",
        username: "alice",
        displayName: "Alice",
        role: "owner",
        avatarColor: null,
        simpleMode: false,
      },
      profiles: null,
    });

    render(<ProfilePicker onClose={onClose} />);
    await user.click(screen.getByText("Alice"));
    const input = screen.getByLabelText("Account password");
    await user.type(input, "pw{Enter}");

    await waitFor(() =>
      expect(switchAccountProfile).toHaveBeenCalledWith("p1", "pw"),
    );
  });
});
