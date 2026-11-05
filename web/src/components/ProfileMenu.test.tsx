// @vitest-environment jsdom
//
// ProfileMenu preset-avatar gallery: the presets render inside the popover, a
// click stores that preset's data URL as the avatar, and the active one is
// marked selected. (Upload/name are exercised implicitly by the popover open.)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PRESET_AVATARS } from "./AvatarPresets";
import { readFileSync } from "node:fs";

const profileMenuCss = readFileSync("src/components/ProfileMenu.css", "utf8");

it("backs the floating profile dialog with an opaque theme surface without blur", () => {
  const rule = profileMenuCss.match(/\.profile-menu-pop\.glass-raised\s*\{([^}]+)\}/)?.[1] ?? "";
  expect(rule, "profile dialog needs its own reliable theme background above shared glass").toMatch(/background:\s*var\(--bg-1\)\s*;/);
});

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

// Source contracts only. Actual scrolling, occlusion and hit testing need the
// rendered app shell; jsdom does not implement those browser layout behaviors.
describe("ProfileMenu responsive positioning contract", () => {
  it("anchors avatar focus and hover scaling to the safe top-right edge", () => {
    const avatarRule = profileMenuCss.match(/\.profile-menu-avatar\s*\{([^}]+)\}/)?.[1] ?? "";
    const interactiveRule = profileMenuCss.match(
      /\.profile-menu-avatar:hover,\s*\.profile-menu-avatar:focus-visible\s*\{([^}]+)\}/,
    )?.[1] ?? "";
    expect(avatarRule).toMatch(/transform-origin:\s*top right;/);
    expect(avatarRule).toMatch(/width:\s*44px;/);
    expect(avatarRule).toMatch(/height:\s*44px;/);
    expect(interactiveRule).toMatch(/transform:\s*scale\(1\.05\);/);
  });

  it("keeps phone and short-landscape actions fixed below the full native top inset", () => {
    const mobileRule = profileMenuCss.match(
      /@media\s*\(max-width:\s*699px\),\s*\(max-width:\s*950px\)\s*and\s*\(max-height:\s*500px\)\s*\{\s*\.profile-menu\s*\{([^}]+)\}/,
    )?.[1] ?? "";
    expect(mobileRule).toMatch(/position:\s*fixed;/);
    expect(mobileRule).toMatch(/top:\s*max\(var\(--sp-md\),\s*var\(--safe-area-top\)\);/);
    expect(mobileRule).not.toContain("--app-content-safe-top-consumed");
    expect(mobileRule).not.toMatch(/(?:right|left|z-index):/);
  });

  it("keeps coarse-pointer profile action in full safe viewport coordinates", () => {
    const coarseRule = profileMenuCss.match(
      /@media\s*\(pointer:\s*coarse\)\s*\{\s*(?:\/\*[\s\S]*?\*\/\s*)*\.profile-menu\s*\{([^}]+)\}/,
    )?.[1] ?? "";
    expect(coarseRule).toMatch(/position:\s*fixed;/);
    expect(coarseRule).toMatch(/top:\s*max\(var\(--sp-md\),\s*var\(--safe-area-top\)\);/);
    expect(coarseRule).not.toMatch(/(?:--app-content-safe-top-consumed|(?:right|left|width|z-index)\s*:)/);
  });

  it("retains absolute desktop and tablet positioning with consumed top and safe right insets", () => {
    const baseRule = profileMenuCss.match(/\.profile-menu\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(baseRule).toMatch(/position:\s*absolute;/);
    expect(baseRule).toMatch(
      /top:\s*calc\(max\(var\(--sp-md\),\s*var\(--safe-area-top\)\)\s*-\s*var\(--app-content-safe-top-consumed,\s*0rem\)\);/,
    );
    expect(baseRule).toMatch(/right:\s*max\(var\(--sp-lg\),\s*var\(--safe-area-right\)\);/);
    expect(baseRule).toMatch(/z-index:\s*6;/);
  });
});

function keyEvent(target: Element, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  fireEvent(target, event);
  return event;
}

describe("ProfileMenu scoped Escape lifecycle", () => {
  it("closes from the focused name field and restores avatar focus without scrolling", async () => {
    render(<ProfileMenu />);
    const user = await openPopover();
    const avatar = screen.getByRole("button", { name: "Your profile" });
    const name = screen.getByRole("textbox", { name: "Your name" });
    await user.click(name);
    const focus = vi.spyOn(avatar, "focus");
    try {
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: "Profile" })).not.toBeInTheDocument();
      expect(avatar).toHaveAttribute("aria-expanded", "false");
      expect(avatar).toHaveFocus();
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(updateSettings).not.toHaveBeenCalled();
      expect(updateProfileRecord).not.toHaveBeenCalled();
    } finally { focus.mockRestore(); }
  });

  it("consumes open-popover Escape before underlying route shortcuts", async () => {
    const routeEscape = vi.fn();
    window.addEventListener("keydown", routeEscape);
    try {
      render(<ProfileMenu />);
      await openPopover();
      const event = keyEvent(screen.getByRole("textbox", { name: "Your name" }), "Escape");
      expect(event.defaultPrevented).toBe(true);
      expect(routeEscape).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: "Profile" })).not.toBeInTheDocument();
    } finally { window.removeEventListener("keydown", routeEscape); }
  });

  it("does not autofocus a text field when opening", () => {
    render(<><button>Outside focus</button><ProfileMenu /></>);
    const outside = screen.getByRole("button", { name: "Outside focus" });
    outside.focus();
    fireEvent.click(screen.getByRole("button", { name: "Your profile" }));
    expect(outside).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Your name" })).not.toHaveFocus();
  });

  it("leaves Escape untouched when closed and after ordinary close cleanup", async () => {
    const routeEscape = vi.fn();
    window.addEventListener("keydown", routeEscape);
    try {
      render(<ProfileMenu />);
      const avatar = screen.getByRole("button", { name: "Your profile" });
      expect(keyEvent(avatar, "Escape").defaultPrevented).toBe(false);
      await openPopover();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(keyEvent(avatar, "Escape").defaultPrevented).toBe(false);
      expect(routeEscape).toHaveBeenCalledTimes(2);
    } finally { window.removeEventListener("keydown", routeEscape); }
  });

  it("removes the open listener on unmount", async () => {
    const routeEscape = vi.fn();
    window.addEventListener("keydown", routeEscape);
    try {
      const view = render(<ProfileMenu />);
      await openPopover();
      view.unmount();
      expect(keyEvent(document.body, "Escape").defaultPrevented).toBe(false);
      expect(routeEscape).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener("keydown", routeEscape); }
  });

  it("does not consume other keys or composing Escape while open", async () => {
    render(<ProfileMenu />);
    await openPopover();
    const name = screen.getByRole("textbox", { name: "Your name" });
    expect(keyEvent(name, "ArrowLeft").defaultPrevented).toBe(false);
    expect(keyEvent(name, "Escape", { isComposing: true }).defaultPrevented).toBe(false);
    expect(screen.getByRole("dialog", { name: "Profile" })).toBeInTheDocument();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("lets a higher modal own its Escape without closing this popover", async () => {
    render(<><ProfileMenu /><div role="dialog" aria-modal="true" aria-label="Higher modal"><input aria-label="Higher modal input" /></div></>);
    await openPopover();
    const target = screen.getByRole("textbox", { name: "Higher modal input" });
    const owner = vi.fn();
    target.addEventListener("keydown", owner);
    try {
      expect(keyEvent(target, "Escape").defaultPrevented).toBe(false);
      expect(owner).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("dialog", { name: "Profile" })).toBeInTheDocument();
    } finally { target.removeEventListener("keydown", owner); }
  });
});
