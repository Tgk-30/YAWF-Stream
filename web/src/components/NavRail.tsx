// Port of Sources/DebridStreamer/Views/Shell/NavRail.swift.
//
// Breakpoint-aware primary navigation: compact rail on tablets, labeled rail on
// wide desktop, and a five-item bottom bar on phones with a More drawer.

import { useLayoutEffect, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { useModalA11y } from "./useModalA11y";
import { isServerMode } from "../lib/serverMode";
import { useSimpleMode } from "../store/AppStore";
import type { LocalProfile } from "../storage/ProfileRegistry";
import { isImageAvatar } from "../data/profileAvatars";
import {
  useServerProfiles,
  useServerSession,
} from "../lib/ServerSessionContext";
import "./NavRail.css";
import { translate } from "../lib/localization";

// Screens with no working backend in Server Mode (Debrid Library is Tauri-only).
// The AI Assistant DOES work in Server Mode - it routes to /api/ai/recommend,
// which uses the server's stored provider key - so it is no longer hidden here.
const SERVER_MODE_HIDDEN: ReadonlySet<string> = new Set(["debrid", "downloads"]);
// Power-user destinations hidden in Simple mode (progressive disclosure). The
// essentials - discover/search/library/watchlist/history/settings - always show;
// Settings must never hide (it hosts the Simple/Advanced toggle).
const SIMPLE_MODE_HIDDEN: ReadonlySet<string> = new Set([
  "assistant",
  "debrid",
  "calendar",
]);

/** True when a screen is hidden from the nav under the current modes. */
export function isScreenHidden(
  id: ScreenId,
  opts: { serverMode: boolean; simpleMode: boolean },
): boolean {
  if (opts.serverMode && SERVER_MODE_HIDDEN.has(id)) return true;
  if (opts.simpleMode && SIMPLE_MODE_HIDDEN.has(id)) return true;
  return false;
}

/** Whether to show the "who's watching" switcher entry. */
export function shouldShowProfileSwitch(opts: {
  serverMode: boolean;
  hasHandler: boolean;
  profileCount: number;
  multiUserEnabled?: boolean;
}): boolean {
  return opts.hasHandler && opts.profileCount > 1 && (opts.serverMode || opts.multiUserEnabled === true);
}

/** Pure, testable nav filter for the current modes. */
export function visibleNavItems(
  items: readonly RailItem[],
  opts: { serverMode: boolean; simpleMode: boolean },
): RailItem[] {
  return items.filter((item) => !isScreenHidden(item.id, opts));
}

/** Apply the user's nav customization (from Settings -> Appearance -> Navigation):
 * remove hidden items and reorder the rest. Reorder is scoped WITHIN each nav
 * group so the grouped rail keeps its structure - moving an item changes its
 * position among its group-mates, never its group. Items the user hasn't
 * explicitly ranked keep their default order after the ranked ones (stable), and
 * "settings" can never be hidden (it hosts the Simple/Advanced toggle). This runs
 * before the mode filter, so a mode-gated screen still can't appear. Pure. */
export function applyNavCustomization(
  items: readonly RailItem[],
  opts: { order: readonly ScreenId[]; hidden: readonly ScreenId[] },
): RailItem[] {
  const hidden = new Set<ScreenId>(opts.hidden.filter((id) => id !== "settings"));
  const visible = items.filter((item) => !hidden.has(item.id));
  if (opts.order.length === 0) return visible;

  const rank = new Map<ScreenId, number>();
  opts.order.forEach((id, i) => rank.set(id, i));

  // Bucket by group, sort each bucket by (user rank, then original index) so the
  // comparator is a proper total order, then re-emit groups in their original
  // first-appearance order. Never sorts across groups.
  const buckets = new Map<string, RailItem[]>();
  for (const item of visible) {
    const bucket = buckets.get(item.group);
    if (bucket) bucket.push(item);
    else buckets.set(item.group, [item]);
  }
  for (const bucket of buckets.values()) {
    bucket
      .map((item, i) => ({ item, i, r: rank.get(item.id) ?? Infinity }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .forEach((entry, i) => (bucket[i] = entry.item));
  }
  const result: RailItem[] = [];
  const emitted = new Set<string>();
  for (const item of visible) {
    if (emitted.has(item.group)) continue;
    emitted.add(item.group);
    result.push(...buckets.get(item.group)!);
  }
  return result;
}

export type ScreenId =
  | "discover"
  | "search"
  | "library"
  | "watchlist"
  | "calendar"
  | "history"
  | "assistant"
  | "debrid"
  | "downloads"
  | "settings";

export type NavGroup = "Primary" | "Library" | "Tools" | "Account";

export interface RailItem {
  id: ScreenId;
  icon: IconName;
  label: string;
  mobileLabel?: string;
  group: NavGroup;
  mobile?: boolean;
}

const NAV_ITEMS: RailItem[] = [
  {
    id: "discover",
    icon: "discover",
    label: "Discover",
    mobileLabel: "Discover",
    group: "Primary",
    mobile: true,
  },
  { id: "search", icon: "search", label: "Search", group: "Primary", mobile: true },
  { id: "library", icon: "library", label: "Library", group: "Library", mobile: true },
  {
    id: "watchlist",
    icon: "watchlist",
    label: "Watchlist",
    mobileLabel: "Watchlist",
    group: "Library",
    mobile: true,
  },
  { id: "calendar", icon: "calendar", label: "Calendar", group: "Library" },
  { id: "history", icon: "history", label: "History", group: "Library" },
  { id: "downloads", icon: "debrid", label: "Downloads", group: "Library" },
  { id: "assistant", icon: "assistant", label: "Assistant", group: "Tools" },
  { id: "debrid", icon: "debrid", label: "Debrid", group: "Tools" },
  { id: "settings", icon: "settings", label: "Settings", group: "Account" },
];

const MOBILE_MORE_ITEMS = NAV_ITEMS.filter((item) => !item.mobile || item.id === "settings");
const GROUPS = ["Primary", "Library", "Tools", "Account"] as const;

/** The full nav item set + group order, exported so Settings can render the
 * reorder/hide customizer without duplicating this metadata. */
export const NAV_RAIL_ITEMS: readonly RailItem[] = NAV_ITEMS;
export const NAV_RAIL_GROUPS: readonly NavGroup[] = GROUPS;

interface NavRailProps {
  selected: ScreenId;
  onSelect: (id: ScreenId) => void;
  /** Prevent background navigation while a higher app overlay is active. */
  inert?: boolean;
  /** Opens the "who's watching" picker (Server Mode only). When absent or when
   *  the account has a single profile, the switch entry is not shown. */
  onSwitchProfile?: () => void;
  /** Local profile state is supplied by App, keeping this navigation component
   * independently testable and leaving server context behavior unchanged. */
  localProfile?: LocalProfile | null;
  localProfileCount?: number;
  localMultiUserEnabled?: boolean;
  /** User's per-item nav order (by screen id); [] means default order. */
  navOrder?: readonly ScreenId[];
  /** Screen ids the user hid from the nav; "settings" is always kept. */
  navHidden?: readonly ScreenId[];
  /** Followed episodes that aired since the user last visited Calendar. */
  calendarBadgeCount?: number;
  /** Resolved interface locale used for navigation labels. */
  interfaceLocale?: string;
}

export function shouldRenderNavGroup(
  group: "Primary" | "Library" | "Tools" | "Account",
  navItems: readonly {
    id: ScreenId;
    icon: IconName;
    label: string;
    mobileLabel?: string;
    group: "Primary" | "Library" | "Tools" | "Account";
    mobile?: boolean;
  }[],
  showProfileSwitch: boolean,
): boolean {
  return navItems.some((item) => item.group === group) || (group === "Account" && showProfileSwitch);
}

/** Shared empty default so an unset prop keeps a stable reference across renders. */
const EMPTY_NAV_IDS: readonly ScreenId[] = [];

function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed[0]!.toUpperCase() : "?";
}

const NAV_COLLAPSED_KEY = "ds_nav_collapsed";

export function NavRail({
  selected,
  onSelect,
  onSwitchProfile,
  localProfile,
  localProfileCount = 0,
  localMultiUserEnabled = false,
  navOrder = EMPTY_NAV_IDS,
  navHidden = EMPTY_NAV_IDS,
  calendarBadgeCount = 0,
  inert = false,
  interfaceLocale = "en",
}: NavRailProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreSheetRef = useModalA11y<HTMLDivElement>(
    () => setMoreOpen(false),
    moreOpen,
  );
  // Collapsed (icons-only) side rail - an ephemeral UI preference persisted to
  // localStorage. Reflected on the root so the layout var + content inset track.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return globalThis.localStorage?.getItem(NAV_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  useLayoutEffect(() => {
    document.documentElement.dataset.navCollapsed = collapsed ? "true" : "false";
  }, [collapsed]);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        globalThis.localStorage?.setItem(NAV_COLLAPSED_KEY, next ? "true" : "false");
      } catch {
        /* non-persistent is fine */
      }
      return next;
    });
  };
  const serverMode = isServerMode();
  const simpleMode = useSimpleMode();
  const session = useServerSession();
  const profiles = useServerProfiles();
  const navCustom = { order: navOrder, hidden: navHidden };
  const localize = (item: RailItem): RailItem => ({
    ...item,
    label: translate(
      interfaceLocale,
      `nav.${item.id}` as Parameters<typeof translate>[1],
      item.label,
    ),
    mobileLabel: translate(
      interfaceLocale,
      `nav.${item.id}` as Parameters<typeof translate>[1],
      item.mobileLabel ?? item.label,
    ),
  });
  const navItems = visibleNavItems(
    applyNavCustomization(NAV_ITEMS, navCustom),
    { serverMode, simpleMode },
  ).map(localize);
  const moreItems = visibleNavItems(
    applyNavCustomization(MOBILE_MORE_ITEMS, navCustom),
    { serverMode, simpleMode },
  ).map(localize);
  const moreSelected = moreItems.some((item) => item.id === selected);
  // Show the switcher only in Server Mode with a handler AND more than one
  // profile - a single-profile account has no one to switch to (no forced
  // picker, per the spec).
  const showProfileSwitch = shouldShowProfileSwitch({
    serverMode,
    hasHandler: onSwitchProfile != null,
    profileCount: serverMode ? profiles.length : (localMultiUserEnabled ? localProfileCount : 0),
    multiUserEnabled: localMultiUserEnabled,
  });
  const serverActiveProfile =
    session != null
      ? profiles.find((p) => p.id === session.profileId) ?? null
      : null;
  const activeName = serverMode ? session?.displayName ?? "profile" : localProfile?.name ?? "profile";

  function selectScreen(id: ScreenId) {
    setMoreOpen(false);
    onSelect(id);
  }

  return (
    <nav
      className="nav-rail"
      aria-label="Primary"
      ref={(element) => element?.toggleAttribute("inert", inert)}
    >
      <button
        type="button"
        className="nav-rail-collapse"
        data-mobile="false"
        onClick={toggleCollapsed}
        aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        aria-pressed={collapsed}
        title={collapsed ? "Expand" : "Collapse"}
      >
        <span className="nav-rail-collapse-glyph" aria-hidden>
          {collapsed ? "»" : "«"}
        </span>
      </button>

      {moreOpen && (
        <button
          type="button"
          className="nav-rail-more-scrim"
          aria-label="Dismiss more menu"
          onClick={() => setMoreOpen(false)}
        />
      )}

      {/* Skip groups with nothing to show (e.g. Tools when every tool is
          gated off) - an orphaned section label reads as a broken menu. The
          Account group also hosts the profile switcher, which isn't a navItem. */}
      {GROUPS.filter((group) => shouldRenderNavGroup(group, navItems, showProfileSwitch)).map(
        (group) => (
        <div key={group} className="nav-rail-section" data-group={group}>
          <div className="nav-rail-group-label">{group}</div>
          {group === "Account" && showProfileSwitch && (
            <button
              type="button"
              className="nav-rail-btn nav-rail-profile"
              data-mobile="false"
              onClick={() => {
                setMoreOpen(false);
                onSwitchProfile?.();
              }}
              title="Switch profile"
              aria-label={`Switch profile (current: ${activeName})`}
            >
              <span className="nav-rail-icon">
                <span
                  className="nav-rail-profile-avatar"
                  style={{ background: serverMode ? serverActiveProfile?.avatarColor ?? "#475569" : localProfile?.color ?? "#475569" }}
                  aria-hidden
                >
                  {serverMode ? (
                    initialOf(session?.displayName ?? "?")
                  ) : isImageAvatar(localProfile?.avatar) ? (
                    <img src={localProfile.avatar} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "inherit" }} />
                  ) : (
                    localProfile?.avatar || initialOf(activeName)
                  )}
                </span>
              </span>
              <span className="nav-rail-label">Switch</span>
            </button>
          )}
          {navItems.filter((item) => item.group === group).map((item) => (
            <NavRailButton
              key={item.id}
              item={item}
              selected={selected === item.id}
              onSelect={selectScreen}
              badgeCount={item.id === "calendar" ? calendarBadgeCount : 0}
            />
          ))}
        </div>
      ))}

      <button
        type="button"
        className={`nav-rail-btn nav-rail-more${moreSelected ? " is-selected" : ""}`}
        data-mobile="true"
        data-mobile-overflow="true"
        onClick={() => setMoreOpen((open) => !open)}
        aria-label="More navigation"
        aria-expanded={moreOpen}
        aria-controls="mobile-nav-more"
        title="More"
      >
        <span className="nav-rail-icon">
          <Icon name="more" size={20} filled={moreSelected} />
        </span>
        <span className="nav-rail-label">More</span>
      </button>

      {moreOpen && (
        <div
          id="mobile-nav-more"
          ref={moreSheetRef}
          className="nav-rail-more-sheet is-open"
          role="dialog"
          aria-modal="true"
          aria-label="More navigation"
          tabIndex={-1}
        >
          <div className="nav-rail-more-head">
            <span>More</span>
            <button
              type="button"
              className="nav-rail-more-close"
              onClick={() => setMoreOpen(false)}
              aria-label="Close more menu"
            >
              <Icon name="xmark" size={19} />
            </button>
          </div>
          {moreItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-rail-more-action${selected === item.id ? " is-selected" : ""}`}
              data-screen={item.id}
              onClick={() => selectScreen(item.id)}
              aria-label={navItemAriaLabel(item.label, item.id === "calendar" ? calendarBadgeCount : 0)}
            >
              <span className="nav-rail-more-icon">
                <Icon
                  name={item.icon}
                  size={18}
                  filled={selected === item.id}
                />
                {item.id === "calendar" && calendarBadgeCount > 0 && (
                  <span
                    className="nav-rail-badge"
                    data-testid="calendar-new-episode-badge"
                    aria-hidden="true"
                  >
                    {formatBadgeCount(calendarBadgeCount)}
                  </span>
                )}
              </span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </nav>
  );
}

function NavRailButton({
  item,
  selected,
  onSelect,
  badgeCount = 0,
}: {
  item: RailItem;
  selected: boolean;
  onSelect: (id: ScreenId) => void;
  badgeCount?: number;
}) {
  return (
    <button
      type="button"
      className={`nav-rail-btn${selected ? " is-selected" : ""}${item.mobileLabel != null ? " has-mobile-label" : ""}`}
      data-screen={item.id}
      data-mobile={item.mobile ? "true" : "false"}
      onClick={() => onSelect(item.id)}
      title={item.label}
      aria-label={navItemAriaLabel(item.label, badgeCount)}
      aria-current={selected ? "page" : undefined}
    >
      <span className="nav-rail-icon">
        <Icon name={item.icon} size={20} filled={selected} />
        {badgeCount > 0 && (
          <span
            className="nav-rail-badge"
            data-testid={item.id === "calendar" ? "calendar-new-episode-badge" : undefined}
            aria-hidden="true"
          >
            {formatBadgeCount(badgeCount)}
          </span>
        )}
      </span>
      <span
        className="nav-rail-label"
        data-mobile-label={item.mobileLabel}
      >
        {item.label}
      </span>
    </button>
  );
}

function formatBadgeCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

function navItemAriaLabel(label: string, badgeCount: number): string {
  if (badgeCount <= 0) return label;
  return `${label}, ${badgeCount} new episode${badgeCount === 1 ? "" : "s"}`;
}
