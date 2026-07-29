// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultSettings, type AppSettings } from "../../data/settings";
import { ScreenId } from "../../components/NavRail";

const iconRender = vi.hoisted(() => vi.fn(() => null));

vi.mock("../../components/Icon", () => ({
  Icon: iconRender,
}));

vi.mock("../../components/InfoTip", () => ({
  InfoTip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const forceCrossGroupOrderSentinel = "__cross-group-order__" as unknown as ScreenId;

vi.mock("../../components/NavRail", async () => {
  const actual = await vi.importActual<typeof import("../../components/NavRail")>(
    "../../components/NavRail",
  );
  return {
    ...actual,
    applyNavCustomization: (items: readonly (typeof actual.NAV_RAIL_ITEMS)[number][], opts: { order: readonly ScreenId[]; hidden: readonly ScreenId[] }) => {
      if (opts.order.includes(forceCrossGroupOrderSentinel)) {
        const byId = new Map(items.map((item) => [item.id, item]));
        const discover = byId.get("discover");
        const settings = byId.get("settings");
        const search = byId.get("search");
        if (discover && settings && search) {
          return [discover, settings, search, ...items.filter((item) => item.id !== "discover" && item.id !== "settings" && item.id !== "search")];
        }
      }
      return actual.applyNavCustomization(items, opts);
    },
  };
});

import { AppearanceSettings, type AppearanceSettingsProps } from "./AppearanceSettings";

function openDetails(summaryText: RegExp) {
  const match = screen
    .getAllByText(summaryText)
    .map((node) => node.closest("summary"))
    .find((summary) => summary !== null);
  if (!match) {
    throw new Error(`Could not find details summary ${summaryText}`);
  }
  return match as HTMLElement;
}

function buildProps(overrides: Partial<AppearanceSettingsProps> = {}, draft: Partial<AppSettings> = {}) {
  const resolvedDraft = {
    ...defaultSettings(),
    ...draft,
  };
  return {
    props: {
      draft: resolvedDraft,
      serverMode: false,
      smartPreload: false,
      onApplyAppearance: vi.fn(),
      onSmartPreloadChange: vi.fn(),
      onReplayWelcomeGuide: vi.fn(),
      onReplayTierWelcome: vi.fn(),
      ...overrides,
    },
  };
}

beforeEach(() => {
  iconRender.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("AppearanceSettings nav customizer edge cases", () => {
  it("does not cross groups when moving up/down and stays unchanged", async () => {
    const user = userEvent.setup();
    const { props } = buildProps(undefined, {
      appearanceNavOrder: [forceCrossGroupOrderSentinel],
      appearanceNavHidden: [],
    });

    render(<AppearanceSettings {...props} />);
    await user.click(openDetails(/Layout and navigation/i));

    await user.click(screen.getByRole("button", { name: "Move Discover down" }));
    expect(props.onApplyAppearance).not.toHaveBeenCalled();
  });

  it("does not allow hiding the locked Settings item", async () => {
    const user = userEvent.setup();
    const { props } = buildProps(undefined, {
      appearanceNavOrder: [],
      appearanceNavHidden: [],
    });

    render(<AppearanceSettings {...props} />);
    await user.click(openDetails(/Layout and navigation/i));

    const hideSettings = screen.getByRole("button", { name: /Hide Settings/ });
    expect(hideSettings).toBeDisabled();
    await user.click(hideSettings);

    expect(props.onApplyAppearance).not.toHaveBeenCalled();
  });
});
