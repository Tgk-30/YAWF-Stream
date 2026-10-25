// Captions menu (in-player OSD).
//
// A glass popover triggered by a CC button. It lets the user:
//   • toggle loaded subtitle tracks on/off (accent = active),
//   • search OpenSubtitles (auto-seeded with the title / imdb id + language),
//   • pick a result to download + attach,
//   • nudge the active track's delay (±),
//   • AI-translate the active track to a chosen language.
//
// Every network/AI affordance is gated: without an OpenSubtitles key the search
// box shows a clear "configure key" note; without an AI provider the translate
// row is hidden. Driven entirely by the useSubtitleTracks hook passed in.

import { useState } from "react";
import { Icon } from "../Icon";
import { useModalA11y } from "../useModalA11y";
import { useAppStore } from "../../store/AppStore";
import type { AppSettings } from "../../data/settings";
import type { UseSubtitleTracks } from "./useSubtitleTracks";
import type { SubtitleSearchParams } from "../../services/subtitles/OpenSubtitlesClient";

/** Caption text-color presets (white + the common high-legibility tints). */
export const SUBTITLE_COLORS = ["#ffffff", "#ffe066", "#9be7ff", "#9bffb0"];

const round2 = (n: number) => Math.round(n * 100) / 100;

const SEARCH_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
];

const TRANSLATE_TARGETS = [
  "English",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Italian",
  "Japanese",
  "Korean",
];

export interface EmbeddedCaptions {
  tracks: Array<{ id: string; label: string }>;
  activeTrackId: string | null;
  setActiveTrack: (id: string | null) => void;
}

interface CaptionsMenuProps {
  /** Optional so the native player retains its existing downloaded-track API. */
  embedded?: EmbeddedCaptions;
  subs: UseSubtitleTracks;
  /** Auto-seed for the search box. */
  seedTitle: string;
  seedImdbId: string | null;
  seedSeason: number | null;
  seedEpisode: number | null;
  onClose: () => void;
}

export function CaptionsMenu({
  subs,
  embedded,
  seedTitle,
  seedImdbId,
  seedSeason,
  seedEpisode,
  onClose,
}: CaptionsMenuProps) {
  const [query, setQuery] = useState(seedTitle);
  const [language, setLanguage] = useState("en");
  const [translateTo, setTranslateTo] = useState("English");

  const { settings, updateSettings } = useAppStore();
  const patchSub = (patch: Partial<AppSettings>) =>
    updateSettings({ ...settings, ...patch });

  const activeTrack = subs.tracks.find((t) => t.id === subs.activeTrackId) ?? null;
  const menuRef = useModalA11y<HTMLDivElement>(onClose);
  const captionsOff = subs.activeTrackId == null && embedded?.activeTrackId == null;

  function runSearch() {
    const params: SubtitleSearchParams = {
      imdbId: seedImdbId,
      // Prefer imdb id; only send the free-text query when no imdb id is known.
      query: seedImdbId ? null : query,
      season: seedSeason,
      episode: seedEpisode,
      languages: [language],
    };
    void subs.search(params);
  }

  return (
    <div
      ref={menuRef}
      className="captions-menu glass-lit"
      role="dialog"
      aria-modal="true"
      aria-label="Subtitles"
      tabIndex={-1}
    >
      <div className="captions-head">
        <span className="captions-title">Subtitles</span>
        <button
          type="button"
          className="player-close"
          onClick={onClose}
          aria-label="Close subtitles menu"
        >
          <Icon name="xmark" size={15} />
        </button>
      </div>

      {/* Loaded tracks + off toggle */}
      <div className="captions-section">
        <button
          type="button"
          className={`captions-track${captionsOff ? " is-active" : ""}`}
          aria-pressed={captionsOff}
          onClick={() => {
            embedded?.setActiveTrack(null);
            subs.setActiveTrack(null);
          }}
        >
          <Icon name={captionsOff ? "check" : "xmark"} size={13} />
          Off
        </button>
        {embedded?.tracks.map((track) => (
          <button
            key={track.id}
            type="button"
            className={`captions-track${track.id === embedded.activeTrackId ? " is-active" : ""}`}
            aria-pressed={track.id === embedded.activeTrackId}
            onClick={() => embedded.setActiveTrack(track.id)}
          >
            {track.id === embedded.activeTrackId && <Icon name="check" size={13} />}
            <span className="captions-track-label">{track.label}</span>
          </button>
        ))}
        {subs.tracks.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`captions-track${t.id === subs.activeTrackId ? " is-active" : ""}`}
            aria-pressed={t.id === subs.activeTrackId}
            onClick={() => subs.setActiveTrack(t.id)}
          >
            {t.id === subs.activeTrackId && <Icon name="check" size={13} />}
            <span className="captions-track-label">{t.label}</span>
            {t.translated && <span className="captions-badge">AI</span>}
          </button>
        ))}
      </div>

      {/* Per-track delay */}
      {activeTrack != null && (
        <div className="captions-section captions-delay">
          <span className="t-secondary">Delay</span>
          <div className="captions-delay-controls">
            <button
              type="button"
              className="chip"
              onClick={() => subs.setDelay(activeTrack.id, activeTrack.delayMs - 250)}
              aria-label="Subtitles earlier"
            >
              −0.25s
            </button>
            <span className="captions-delay-value">
              {(activeTrack.delayMs / 1000).toFixed(2)}s
            </span>
            <button
              type="button"
              className="chip"
              onClick={() => subs.setDelay(activeTrack.id, activeTrack.delayMs + 250)}
              aria-label="Subtitles later"
            >
              +0.25s
            </button>
          </div>
        </div>
      )}

      {/* Subtitle appearance (font size / color / background - persisted) */}
      <div className="captions-section captions-appearance">
        <span className="t-secondary">Appearance</span>
        <div className="captions-appearance-row">
          <span className="captions-appearance-label">Size</span>
          <div className="captions-delay-controls">
            <button
              type="button"
              className="chip"
              onClick={() =>
                patchSub({
                  subtitleFontScale: Math.max(0.7, round2(settings.subtitleFontScale - 0.1)),
                })
              }
              aria-label="Smaller subtitles"
            >
              A−
            </button>
            <span className="captions-delay-value">
              {Math.round(settings.subtitleFontScale * 100)}%
            </span>
            <button
              type="button"
              className="chip"
              onClick={() =>
                patchSub({
                  subtitleFontScale: Math.min(1.8, round2(settings.subtitleFontScale + 0.1)),
                })
              }
              aria-label="Larger subtitles"
            >
              A+
            </button>
          </div>
        </div>
        <div className="captions-appearance-row">
          <span className="captions-appearance-label">Color</span>
          <div className="captions-color-swatches">
            {SUBTITLE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`captions-swatch${
                  settings.subtitleTextColor === c ? " is-active" : ""
                }`}
                style={{ background: c }}
                onClick={() => patchSub({ subtitleTextColor: c })}
                aria-label={`Subtitle color ${c}`}
                aria-pressed={settings.subtitleTextColor === c}
              />
            ))}
          </div>
        </div>
        <div className="captions-appearance-row">
          <span className="captions-appearance-label">Background</span>
          <div className="captions-delay-controls">
            <button
              type="button"
              className="chip"
              onClick={() =>
                patchSub({
                  subtitleBgOpacity: Math.max(0, round2(settings.subtitleBgOpacity - 0.15)),
                })
              }
              aria-label="Less subtitle background"
            >
              −
            </button>
            <span className="captions-delay-value">
              {Math.round(settings.subtitleBgOpacity * 100)}%
            </span>
            <button
              type="button"
              className="chip"
              onClick={() =>
                patchSub({
                  subtitleBgOpacity: Math.min(0.95, round2(settings.subtitleBgOpacity + 0.15)),
                })
              }
              aria-label="More subtitle background"
            >
              +
            </button>
          </div>
        </div>
      </div>

      {/* AI translation (gated on a configured provider) */}
      {subs.canTranslate && activeTrack != null && (
        <div className="captions-section captions-translate">
          <select
            value={translateTo}
            onChange={(e) => setTranslateTo(e.target.value)}
            aria-label="Translate target language"
          >
            {TRANSLATE_TARGETS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            disabled={subs.translatingTrackId != null}
            onClick={() => void subs.translateTrack(activeTrack.id, translateTo)}
          >
            <Icon name="sparkles" size={13} />
            {subs.translatingTrackId === activeTrack.id
              ? subs.translateProgress
                ? `Translating ${subs.translateProgress.done}/${subs.translateProgress.total}`
                : "Translating…"
              : `Translate to ${translateTo}`}
          </button>
        </div>
      )}

      <div className="captions-divider" />

      {/* OpenSubtitles search */}
      {subs.canSearch ? (
        <div className="captions-section captions-search">
          <div className="captions-search-row">
            <input
              className="captions-search-input"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={seedImdbId ? "Searching by IMDb id" : "Search title…"}
              disabled={seedImdbId != null}
              aria-label="Subtitle title search"
              onKeyDown={(e) => {
                if (e.key === "Enter") runSearch();
              }}
            />
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              aria-label="Subtitle language"
            >
              {SEARCH_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-prominent"
              onClick={runSearch}
              disabled={subs.searching}
            >
              {subs.searching && (
                <span className="captions-search-spinner" aria-hidden="true" />
              )}
              {subs.searching ? "Searching…" : "Search"}
            </button>
          </div>

          {subs.searchError && (
            <p className="captions-error t-secondary" role="alert">
              {subs.searchError}
            </p>
          )}

          <div className="captions-results">
            {subs.results.map((r) => (
              <button
                key={r.fileId}
                type="button"
                className="captions-result"
                onClick={() => void subs.loadResult(r)}
                disabled={subs.loadingFileId != null}
              >
                <span className="captions-result-lang">
                  {r.language.toUpperCase()}
                </span>
                <span className="captions-result-name">{r.release}</span>
                <span className="captions-result-meta t-secondary">
                  {r.hearingImpaired ? "HI · " : ""}
                  {r.downloadCount.toLocaleString()}↓
                </span>
                {subs.loadingFileId === r.fileId && (
                  <span className="t-secondary">Loading…</span>
                )}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="captions-error t-secondary">
          Add an OpenSubtitles API key in Settings to search and download
          subtitles.
        </p>
      )}
    </div>
  );
}
