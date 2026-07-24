// SettingsSearch - a "jump to a setting" box above the Settings tabs. Settings
// has grown large; this is a navigation aid, NOT an in-place field filter (that
// would risk the layout the Settings tests assert). Type a term, pick a match,
// and it switches to that setting's tab. The index is a hand-authored list of
// the most-searched settings mapped to their tab id.

import { useMemo, useState } from "react";
import { Icon } from "./Icon";
import "./SettingsSearch.css";

interface SearchEntry {
  label: string;
  tab: string;
  /** Extra search terms not in the visible label. */
  keywords?: string;
}

/** Human labels per tab id (mirrors the Settings TABS list) for the result hint. */
const TAB_LABEL: Record<string, string> = {
  appearance: "Appearance",
  language: "Language & region",
  playback: "Playback",
  privacy: "Privacy",
  install: "Install & setup",
  profiles: "Profiles",
  updates: "Updates",
  server: "Server",
  keys: "API keys",
  debrid: "Providers",
  sources: "Sources",
};

const SEARCH_INDEX: SearchEntry[] = [
  { label: "Theme", tab: "appearance", keywords: "dark light color" },
  { label: "Accent color", tab: "appearance", keywords: "tint highlight" },
  { label: "Start on (default tab)", tab: "appearance", keywords: "landing home screen launch" },
  { label: "Nav position", tab: "appearance", keywords: "bottom bar side rail dock" },
  { label: "Poster size", tab: "appearance", keywords: "density grid" },
  { label: "Text size", tab: "appearance", keywords: "font" },
  { label: "Motion", tab: "appearance", keywords: "animation reduce" },
  { label: "Interface language", tab: "language", keywords: "translation locale ui" },
  { label: "Metadata language", tab: "language", keywords: "tmdb title summary locale" },
  { label: "Metadata region", tab: "language", keywords: "country release rating territory" },
  { label: "Data Saver", tab: "playback", keywords: "bandwidth quality metered" },
  { label: "Built-in player", tab: "playback", keywords: "mpv embedded" },
  { label: "External player", tab: "playback", keywords: "vlc iina mpv" },
  { label: "Auto-advance episodes", tab: "playback", keywords: "next up autoplay" },
  { label: "Rating scale", tab: "playback", keywords: "stars ten hundred rate" },
  { label: "Local data and privacy", tab: "privacy", keywords: "storage network device erase" },
  { label: "Profile name", tab: "profiles", keywords: "account user household" },
  { label: "Avatar and profile color", tab: "profiles", keywords: "icon portrait palette" },
  { label: "Profile password", tab: "profiles", keywords: "pin lock protection sign in" },
  { label: "TMDB key", tab: "keys", keywords: "api metadata catalog" },
  { label: "OMDb key", tab: "keys", keywords: "api ratings" },
  { label: "AI provider", tab: "keys", keywords: "assistant openai anthropic ollama" },
  { label: "AI model", tab: "keys", keywords: "assistant gpt claude model" },
  { label: "Debrid provider", tab: "debrid", keywords: "real-debrid torbox alldebrid premiumize" },
  { label: "Sources / indexers", tab: "sources", keywords: "torrent addon jackett" },
  { label: "Auto-update", tab: "updates", keywords: "version install release" },
  { label: "Diagnostics", tab: "updates", keywords: "support logs provider smoke test troubleshooting" },
];

export function SettingsSearch({
  onJump,
  visibleTabs,
}: {
  onJump: (tab: string) => void;
  /** Only surface settings whose tab is currently reachable. */
  visibleTabs: Set<string>;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim();

  const results = useMemo(() => {
    const q = normalizedQuery.toLowerCase();
    if (q.length < 2) return [];
    return SEARCH_INDEX.filter(
      (e) =>
        visibleTabs.has(e.tab) &&
        (e.label.toLowerCase().includes(q) ||
          (e.keywords ?? "").toLowerCase().includes(q)),
    ).slice(0, 6);
  }, [normalizedQuery, visibleTabs]);

  return (
    <div className="settings-search">
      <Icon name="search" size={15} className="settings-search-icon" />
      <input
        className="settings-search-input"
        type="text"
        placeholder="Search settings…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search settings"
      />
      {normalizedQuery.length >= 2 && (
        <ul className="settings-search-results glass-raised">
          {results.length > 0 ? (
            results.map((r) => (
              <li key={r.label}>
                <button
                  type="button"
                  className="settings-search-result"
                  onClick={() => {
                    onJump(r.tab);
                    setQuery("");
                  }}
                >
                  <span className="settings-search-result-label">{r.label}</span>
                  <span className="settings-search-result-tab t-secondary">
                    {TAB_LABEL[r.tab] ?? r.tab}
                  </span>
                </button>
              </li>
            ))
          ) : (
            <li className="settings-search-empty">
              <span>No settings match “{normalizedQuery}”</span>
              <button type="button" onClick={() => setQuery("")}>
                Clear
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
