// @vitest-environment jsdom
//
// Component coverage for the Local Mode profile picker, focused on the lock
// screen's routing: with more than one profile the grid comes first so anyone
// can pick their own; with a single profile there is nothing to choose, so the
// unlock goes straight to its password (and offers no dead-end Back).

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LocalProfile } from "../storage/ProfileRegistry";
import { DEFAULT_PROFILE_AVATAR, DEFAULT_PROFILE_COLOR } from "../data/profileAvatars";

// `crypto.randomUUID` is typed as a dashed template literal, so the readable
// stand-in ids these tests assert on need the cast to stand in for one.
type RandomUUID = ReturnType<Crypto["randomUUID"]>;

const switchLocalProfile = vi.fn();
const refreshProfiles = vi.fn();
const createProfileRecord = vi.fn();
let profiles: LocalProfile[] = [];
let activeProfile: LocalProfile | null = null;

vi.mock("../store/AppStore", () => ({
  useAppStore: () => ({ activeProfile, profiles, refreshProfiles, switchLocalProfile }),
}));

vi.mock("../storage/ProfileRegistry", () => ({
  createProfileRecord: (...args: Parameters<typeof createProfileRecord>) => createProfileRecord(...args),
}));

import { LocalProfilePicker } from "./LocalProfilePicker";

function profile(over: Partial<LocalProfile> = {}): LocalProfile {
  return {
    id: "default",
    name: "You",
    avatar: "😀",
    color: "#6366f1",
    isDefault: true,
    isAdmin: true,
    createdAt: 0,
    ...over,
  } as LocalProfile;
}

beforeEach(() => {
  switchLocalProfile.mockReset().mockResolvedValue({ ok: true });
  refreshProfiles.mockReset();
  createProfileRecord.mockReset();
  profiles = [];
  activeProfile = null;
});

describe("LocalProfilePicker lock screen", () => {
  it("goes straight to the password when a single locked profile exists", async () => {
    const only = profile({ passwordHash: "pbkdf2:v1:x" });
    profiles = [only];
    activeProfile = only;

    render(<LocalProfilePicker mode="lock" onClose={() => {}} />);

    expect(screen.getByRole("heading", { name: "Enter password" })).toBeInTheDocument();
    // No grid: there was nothing to choose between.
    expect(screen.queryByRole("button", { name: /You/ })).toBeNull();
    // ...and therefore no Back, which would strand the user on an empty grid.
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeInTheDocument();
  });

  it("unlocks the sole profile with the typed password", async () => {
    const only = profile({ passwordHash: "pbkdf2:v1:x" });
    profiles = [only];
    activeProfile = only;
    const onClose = vi.fn();

    render(<LocalProfilePicker mode="lock" onClose={onClose} />);
    await userEvent.type(screen.getByLabelText(/Password/), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Unlock" }));

    expect(switchLocalProfile).toHaveBeenCalledWith("default", "hunter2");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows the selection grid first when several profiles exist", () => {
    const owner = profile({ passwordHash: "pbkdf2:v1:x" });
    const kid = profile({ id: "kid", name: "Kid", isDefault: false, isAdmin: false });
    profiles = [owner, kid];
    activeProfile = owner;

    render(<LocalProfilePicker mode="lock" onClose={() => {}} />);

    expect(screen.getByRole("heading", { name: "Unlock a profile" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Enter password" })).toBeNull();
    expect(screen.getByText(/^You/)).toBeInTheDocument();
    expect(screen.getByText("Kid")).toBeInTheDocument();
  });

  it("offers Back from the password form when a grid is behind it", async () => {
    const owner = profile({ passwordHash: "pbkdf2:v1:x" });
    const kid = profile({ id: "kid", name: "Kid", isDefault: false, isAdmin: false });
    profiles = [owner, kid];
    activeProfile = owner;

    render(<LocalProfilePicker mode="lock" onClose={() => {}} />);
    await userEvent.click(screen.getByText(/^You/));

    expect(screen.getByRole("heading", { name: "Enter password" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    // Back returns to the choice, rather than trapping the user.
    expect(screen.getByRole("heading", { name: "Unlock a profile" })).toBeInTheDocument();
  });

  it("lets an unprotected profile through without a password", async () => {
    const owner = profile({ passwordHash: "pbkdf2:v1:x" });
    const kid = profile({ id: "kid", name: "Kid", isDefault: false, isAdmin: false });
    profiles = [owner, kid];
    activeProfile = owner;
    const onClose = vi.fn();

    render(<LocalProfilePicker mode="lock" onClose={onClose} />);
    await userEvent.click(screen.getByText("Kid"));

    expect(switchLocalProfile).toHaveBeenCalledWith("kid");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("still shows the grid in switch mode for a single profile", () => {
    // Switching is an explicit request to choose, so never auto-jump here.
    const only = profile({ passwordHash: "pbkdf2:v1:x" });
    profiles = [only];
    activeProfile = only;

    render(<LocalProfilePicker onClose={() => {}} />);

    expect(screen.getByRole("heading", { name: "Who’s watching?" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Enter password" })).toBeNull();
  });
});

describe("LocalProfilePicker create-your-profile", () => {
  it("offers profile creation on the launch chooser and the lock, where nobody is signed in", () => {
    const owner = profile({ passwordHash: "pbkdf2:v1:x", isAdmin: false });
    const kid = profile({ id: "kid", name: "Kid", isDefault: false, isAdmin: false });
    profiles = [owner, kid];
    activeProfile = owner;

    // Lock: the active profile is not admin, but a newcomer must still be able
    // to make their own profile rather than being stuck at someone's password.
    const { unmount } = render(<LocalProfilePicker mode="lock" onClose={() => {}} />);
    expect(screen.getByText("Create your profile")).toBeInTheDocument();
    unmount();

    render(<LocalProfilePicker mode="select" onClose={() => {}} />);
    expect(screen.getByText("Create your profile")).toBeInTheDocument();
  });

  it("keeps creation admin-only in switch mode, where a profile IS signed in", () => {
    const owner = profile({ isAdmin: false });
    const kid = profile({ id: "kid", name: "Kid", isDefault: false, isAdmin: false });
    profiles = [owner, kid];
    activeProfile = owner;

    render(<LocalProfilePicker onClose={() => {}} />);
    expect(screen.queryByText("Add profile")).toBeNull();
    expect(screen.queryByText("Create your profile")).toBeNull();
  });

  it("asks who's watching (never 'unlock') on the launch chooser, with no way to dismiss it", () => {
    const a = profile();
    const b = profile({ id: "kid", name: "Kid", isDefault: false });
    profiles = [a, b];
    activeProfile = a;

    render(<LocalProfilePicker mode="select" onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: "Who’s watching?" })).toBeInTheDocument();
    // A launch choice has no Cancel: dismissing it would skip the choice.
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("rejects adding a profile with an empty name", async () => {
    const user = userEvent.setup();
    createProfileRecord.mockResolvedValue(undefined);

    render(<LocalProfilePicker mode="select" onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: /Create your profile/ }));
    await user.click(screen.getByRole("button", { name: /Add profile/ }));

    expect(createProfileRecord).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a profile name.");
    expect(switchLocalProfile).not.toHaveBeenCalled();
    expect(refreshProfiles).not.toHaveBeenCalled();
  });

  it("creates a profile and switches into it for select mode", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockReturnValue("created-id" as RandomUUID);

    createProfileRecord.mockResolvedValue(undefined);
    render(<LocalProfilePicker mode="select" onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: /Create your profile/ }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Junior");
    await user.click(screen.getByRole("button", { name: /Add profile/ }));

    expect(createProfileRecord).toHaveBeenCalledWith({
      id: "created-id",
      name: "Junior",
      avatar: DEFAULT_PROFILE_AVATAR,
      color: DEFAULT_PROFILE_COLOR,
      isDefault: false,
      isAdmin: false,
      createdAt: expect.any(Number),
    });
    expect(refreshProfiles).toHaveBeenCalledTimes(1);
    expect(switchLocalProfile).toHaveBeenCalledWith("created-id");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    randomUUID.mockRestore();
  });

  it("creates a profile in switch mode but keeps the picker open", async () => {
    const user = userEvent.setup();
    createProfileRecord.mockResolvedValue(undefined);

    profiles = [profile({ isDefault: true })];
    activeProfile = profile({ id: "admin", name: "You", isAdmin: true });

    const onClose = vi.fn();
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockReturnValue("created-id-2" as RandomUUID);
    render(<LocalProfilePicker mode="switch" onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: /Add profile/ }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Sibling");
    await user.click(screen.getByRole("button", { name: "Add profile" }));

    expect(createProfileRecord).toHaveBeenCalledWith(expect.objectContaining({
      id: "created-id-2",
      name: "Sibling",
      isDefault: false,
      isAdmin: false,
    }));
    expect(refreshProfiles).toHaveBeenCalledTimes(1);
    expect(switchLocalProfile).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    randomUUID.mockRestore();
  });

  it("shows incorrect-password when unlock fails with bad-password", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const owner = profile({ passwordHash: "pbkdf2:v1:x" });
    const child = profile({ id: "kid", name: "Kid", isDefault: false, isAdmin: false });
    profiles = [owner, child];
    activeProfile = owner;
    switchLocalProfile.mockResolvedValueOnce({ ok: false, reason: "bad-password" as const });

    render(<LocalProfilePicker mode="lock" onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: /You/ }));
    await user.type(screen.getByLabelText(/Password/), "wrong");
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect password.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows not found when a direct profile switch fails", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const owner = profile();
    const child = profile({ id: "kid", name: "Kid", isDefault: false, isAdmin: false, passwordHash: undefined });
    profiles = [owner, child];
    activeProfile = owner;
    switchLocalProfile.mockResolvedValueOnce({ ok: false, reason: "not-found" as const });

    render(<LocalProfilePicker onClose={onClose} />);
    await user.click(screen.getByText("Kid"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That profile is no longer available.",
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
