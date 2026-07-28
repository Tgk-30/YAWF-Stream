// @vitest-environment jsdom
//
// ProfileMenu preset-avatar gallery: the presets render inside the popover, a
// click stores that preset's data URL as the avatar, and the active one is
// marked selected. (Upload/name are exercised implicitly by the popover open.)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PRESET_AVATARS } from "./AvatarPresets";

const updateSettings = vi.fn();
const updateProfileRecord = vi.fn();
let activeProfile: { id: string } | null = { id: "profile-1" };
let isServerMode = false;
const refreshProfiles = vi.fn();
let mockSettings: { userName: string; userAvatar: string } = {
  userName: "",
  userAvatar: "",
};

vi.mock("../store/AppStore", () => ({
  useAppStore: () => ({
    settings: mockSettings,
    updateSettings,
    activeProfile,
    refreshProfiles,
  }),
}));
vi.mock("../lib/serverMode", () => ({ isServerMode: () => isServerMode }));
vi.mock("../storage/ProfileRegistry", () => ({
  updateProfileRecord: (...args: Parameters<typeof updateProfileRecord>) =>
    Promise.resolve(updateProfileRecord(...args)),
}));
vi.mock("./Icon", () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

import { ProfileMenu } from "./ProfileMenu";

beforeEach(() => {
  updateSettings.mockReset();
  updateProfileRecord.mockReset();
  updateProfileRecord.mockResolvedValue(undefined);
  refreshProfiles.mockReset();
  mockSettings = { userName: "", userAvatar: "" };
  isServerMode = false;
  activeProfile = { id: "profile-1" };
});
afterEach(() => cleanup());

async function openPopover() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Your profile" }));
  return user;
}

describe("ProfileMenu preset avatars", () => {
  it("renders all 8 presets in the popover", async () => {
    render(<ProfileMenu />);
    await openPopover();
    for (const preset of PRESET_AVATARS) {
      expect(
        screen.getByRole("button", { name: preset.label }),
      ).toBeInTheDocument();
    }
    expect(PRESET_AVATARS).toHaveLength(8);
  });

  it("stores the chosen preset's data URL as the avatar", async () => {
    render(<ProfileMenu />);
    const user = await openPopover();
    await user.click(screen.getByRole("button", { name: "Film" }));
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ userAvatar: PRESET_AVATARS[0].dataUrl }),
    );
  });

  it("marks the active preset as selected", async () => {
    mockSettings = { userName: "", userAvatar: PRESET_AVATARS[1].dataUrl };
    render(<ProfileMenu />);
    await openPopover();
    expect(
      screen.getByRole("button", { name: "Popcorn" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Film" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("presets are self-contained SVG data URLs (no external assets)", () => {
    for (const p of PRESET_AVATARS) {
      expect(p.dataUrl.startsWith("data:image/svg+xml")).toBe(true);
    }
  });

  it("syncs user-name edits into local and profile registry storage", async () => {
    render(<ProfileMenu />);
    await openPopover();
    fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), {
      target: { value: "Ada" },
    });
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ userName: "Ada" }),
    );
    expect(updateProfileRecord).toHaveBeenCalledWith("profile-1", { name: "Ada" });
    await waitFor(() => expect(refreshProfiles).toHaveBeenCalledTimes(1));
  });

  it("removes the current avatar", async () => {
    mockSettings = {
      userName: "Ada",
      userAvatar: PRESET_AVATARS[0].dataUrl,
    };
    render(<ProfileMenu />);
    await openPopover();

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ userAvatar: "" }),
    );
    expect(updateProfileRecord).toHaveBeenCalledWith("profile-1", { avatar: "" });
    await waitFor(() => expect(refreshProfiles).toHaveBeenCalledTimes(1));
  });

  it("does not sync local profile fields when server mode is enabled", async () => {
    isServerMode = true;
    mockSettings = { userName: "", userAvatar: "" };
    render(<ProfileMenu />);
    await openPopover();
    fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), {
      target: { value: "Server User" },
    });

    expect(updateProfileRecord).not.toHaveBeenCalled();
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ userName: "Server User" }),
    );
  });

  it("closes the popover when the scrim is clicked", async () => {
    render(<ProfileMenu />);
    await openPopover();
    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(closeButton).toBeInTheDocument();
    await userEvent.click(closeButton);
    expect(screen.queryByRole("textbox", { name: "Your name" })).toBeNull();
  });

  it("supports opening switch mode when requested", async () => {
    const onSwitchProfile = vi.fn();
    render(<ProfileMenu onSwitchProfile={onSwitchProfile} showSwitch />);
    await openPopover();
    await userEvent.click(screen.getByRole("button", { name: "Switch profile" }));
    expect(onSwitchProfile).toHaveBeenCalledTimes(1);
  });

  it("processes photo uploads and stores avatar data URL when possible", async () => {
    const originalImage = (globalThis as { Image: unknown }).Image;
    const originalCreateElement = document.createElement.bind(document);
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = vi.fn(() => "blob:avatar");
    const revokeObjectURL = vi.fn();
    const drawImage = vi.fn();

    class FakeImage {
      width = 200;
      height = 120;
      onload: ((event?: ProgressEvent) => void) | null = null;
      onerror: ((event?: ErrorEvent) => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => {
          this.onload?.(new ProgressEvent("load"));
        });
      }
    }

    Object.defineProperty(globalThis, "Image", { configurable: true, value: FakeImage });
    vi.spyOn(document, "createElement").mockImplementation((name: string) => {
      if (name !== "canvas") return originalCreateElement(name);
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage }),
        toDataURL: () => "data:image/jpeg;base64,U29tZUJpbmFyeURhdGE=",
      } as unknown as HTMLCanvasElement;
    });
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });

    try {
      mockSettings = { userName: "", userAvatar: "" };
      render(<ProfileMenu />);
      await openPopover();
      await userEvent.click(screen.getByRole("button", { name: "Add photo" }));

      const input = document.querySelector("input[type=\"file\"]") as HTMLInputElement;
      fireEvent.change(input, {
        target: { files: [new File(["avatar"], "avatar.png", { type: "image/png" })] },
      });

      await waitFor(() =>
        expect(updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({ userAvatar: "data:image/jpeg;base64,U29tZUJpbmFyeURhdGE=" }),
        ),
      );
      expect(updateProfileRecord).toHaveBeenCalledWith(
        "profile-1",
        { avatar: "data:image/jpeg;base64,U29tZUJpbmFyeURhdGE=" },
      );
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:avatar");
      expect(revokeObjectURL).toHaveBeenCalledTimes(1);
      expect(drawImage).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperties(globalThis, {
        Image: { value: originalImage },
      });
      Object.defineProperties(document, {
        createElement: { value: originalCreateElement },
      });
      Object.defineProperties(URL, {
        createObjectURL: { configurable: true, value: originalCreateObjectURL },
        revokeObjectURL: { configurable: true, value: originalRevokeObjectURL },
      });
      vi.restoreAllMocks();
    }
  });

  it("surfaces a photo read error and keeps previous avatar", async () => {
    const originalImage = (globalThis as { Image: unknown }).Image;
    const originalCreateElement = document.createElement.bind(document);
    const originalCreateObjectURL = URL.createObjectURL;
    class BrokenImage {
      onload: ((event?: ProgressEvent) => void) | null = null;
      onerror: ((event?: ErrorEvent) => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => {
          this.onerror?.(new ErrorEvent("error"));
        });
      }
    }

    Object.defineProperty(globalThis, "Image", { configurable: true, value: BrokenImage });
    vi.spyOn(document, "createElement").mockImplementation((name: string) => {
      if (name !== "canvas") return originalCreateElement(name);
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
        toDataURL: () => "data:image/jpeg;base64,U29tZUJpbmFyeURhdGE=",
      } as unknown as HTMLCanvasElement;
    });
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => "blob:avatar") },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });

    try {
      render(<ProfileMenu />);
      await openPopover();
      await userEvent.click(screen.getByRole("button", { name: "Add photo" }));

      const input = document.querySelector("input[type=\"file\"]") as HTMLInputElement;
      fireEvent.change(input, {
        target: { files: [new File(["bad"], "bad.png", { type: "image/png" })] },
      });

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "That image could not be read. Try a JPEG or PNG.",
      );
      expect(updateSettings).not.toHaveBeenCalled();
    } finally {
      Object.defineProperties(globalThis, {
        Image: { value: originalImage },
      });
      Object.defineProperties(document, {
        createElement: { value: originalCreateElement },
      });
      Object.defineProperties(URL, {
        createObjectURL: { configurable: true, value: originalCreateObjectURL },
        revokeObjectURL: { configurable: true, value: URL.revokeObjectURL },
      });
      vi.restoreAllMocks();
    }
  });

  it("surfaces an error when the chosen image has empty dimensions", async () => {
    const originalImage = (globalThis as { Image: unknown }).Image;
    const originalCreateElement = document.createElement.bind(document);
    const originalCreateObjectURL = URL.createObjectURL;

    class ZeroImage {
      width = 0;
      height = 0;
      onload: ((event?: ProgressEvent) => void) | null = null;
      onerror: ((event?: ErrorEvent) => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => {
          this.onload?.(new ProgressEvent("load"));
        });
      }
    }

    Object.defineProperty(globalThis, "Image", { configurable: true, value: ZeroImage });
    vi.spyOn(document, "createElement").mockImplementation((name: string) => {
      if (name !== "canvas") return originalCreateElement(name);
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
        toDataURL: () => "data:image/jpeg;base64,ignored",
      } as unknown as HTMLCanvasElement;
    });
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => "blob:avatar") },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });

    try {
      render(<ProfileMenu />);
      await openPopover();
      await userEvent.click(screen.getByRole("button", { name: "Add photo" }));
      const input = document.querySelector("input[type=\"file\"]") as HTMLInputElement;
      fireEvent.change(input, { target: { files: [new File(["bad"], "bad.png", { type: "image/png" })] } });

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "That image could not be read. Try a JPEG or PNG.",
      );
      expect(updateSettings).not.toHaveBeenCalled();
    } finally {
      Object.defineProperties(globalThis, {
        Image: { value: originalImage },
      });
      Object.defineProperties(document, {
        createElement: { value: originalCreateElement },
      });
      Object.defineProperties(URL, {
        createObjectURL: { configurable: true, value: originalCreateObjectURL },
        revokeObjectURL: { configurable: true, value: URL.revokeObjectURL },
      });
      vi.restoreAllMocks();
    }
  });
});
