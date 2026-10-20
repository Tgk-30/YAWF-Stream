// Pure, React-free stream-search matching helpers.
//
// These back the two-pass stream search (an imdb-native pass + a title/name
// pass) in BOTH Local Mode (web/src/data/streams.ts) and Server Mode
// (server/src/media-runtime.js). They live in one module, imported by both, so
// the two modes can never drift into showing different lists - the same class
// of bug the Data Saver clamp comment warns about. Nothing here touches React
// or the DOM, so the server bundles it cleanly.

import {
  torrentResultSelectionKey,
  torrentResultHasUsableFileSelection,
  VideoQuality,
  type TorrentResult,
} from "../services/indexers/models";

/** The human-title query for the NAME-matching indexers (APIBay etc.). They
 * search torrent titles, so an imdb id returns nothing there - an episode needs
 * the `Title SxxEyy` form and a movie just the title. */
export function buildTitleQuery(
  title: string,
  season: number | null,
  episode: number | null,
): string {
  const base = title.trim();
  if (season != null && episode != null) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${base} S${pad(season)}E${pad(episode)}`;
  }
  return base;
}

/** Lowercase, fold the "&"/"and" connector, strip everything non-alphanumeric to
 * spaces, collapse. The "&" → "and" fold (applied to BOTH the title and the
 * release name) keeps the contiguous-phrase match in filterResultsByTitle from
 * dropping a valid release that spells the connector out - e.g. title
 * "Dungeons & Dragons" vs release "Dungeons.and.Dragons…", or "Tom & Jerry" vs
 * "Tom.and.Jerry…". */
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Keep only title-pass results whose release name contains the requested title
 * as a CONTIGUOUS whole-word phrase. The name-matching indexers (APIBay) do a
 * loose substring search, so requiring only that each title word appear somewhere
 * lets a different show leak in - e.g. "The Bear" would match
 * "The Adventures of Paddington Bear" because both "the" and "bear" are present.
 * Requiring the whole normalized title (" the bear ") as an adjacent run of whole
 * words rejects those cross-show matches while still tolerating the release's
 * separators/casing. Release names conventionally lead with the contiguous title,
 * and the imdb pass already covers the rare reordered/article-dropped release, so
 * this only tightens the (additive, best-effort) title pass. */
export function filterResultsByTitle(
  results: TorrentResult[],
  title: string,
): TorrentResult[] {
  const phrase = normalizeForMatch(title);
  if (phrase.length === 0) return results;
  const needle = ` ${phrase} `;
  return results.filter((r) => ` ${normalizeForMatch(r.title)} `.includes(needle));
}

/** A plausible release-year token (1900-2099). Applied to whole normalized
 * tokens, so resolution/codec digits ("2160p", "1920x1080", "x264") never
 * qualify - they normalize into tokens that aren't a bare 4-digit year. */
const YEAR_TOKEN = /^(?:19|20)\d{2}$/;

/** Year-range packs ("1997-2003", "1997 - 2016"). Matched on the RAW release
 * name because normalizeForMatch erases the dash that makes it a range. */
const YEAR_RANGE = /(?<![0-9])((?:19|20)\d{2})\s*[-–]\s*((?:19|20)\d{2})(?![0-9])/g;

/** True only when a release name carries year evidence and NONE of it is
 * compatible with `targetYear` (tolerance +/-1, since encode/festival years
 * routinely drift one off the canonical release year).
 *
 * Deliberately conservative in every ambiguous direction, because torrent
 * names are messy and this feeds a DOWN-RANK, not a filter:
 * - No parseable year -> false (many legit releases omit the year).
 * - ANY matching token wins over any number of mismatching ones, so remaster/
 *   encode-year noise ("Title.1997.REMASTERED.2016") can't sink a legit copy.
 * - A year-range pack agrees when the target falls inside the range.
 * - The requested title's own words are stripped first, so a year-bearing
 *   title ("2012", "Blade Runner 2049") is never read as a release year. */
export function releaseYearDisagrees(
  releaseName: string,
  title: string | null,
  targetYear: number | null | undefined,
): boolean {
  if (targetYear == null) return false;
  for (const m of releaseName.matchAll(YEAR_RANGE)) {
    const lo = parseInt(m[1], 10);
    const hi = parseInt(m[2], 10);
    if (lo <= hi && targetYear >= lo - 1 && targetYear <= hi + 1) return false;
  }
  let haystack = ` ${normalizeForMatch(releaseName)} `;
  if (title != null) {
    const phrase = normalizeForMatch(title);
    if (phrase.length > 0) haystack = haystack.split(` ${phrase} `).join(" ");
  }
  const years = haystack
    .split(" ")
    .filter((token) => YEAR_TOKEN.test(token))
    .map(Number);
  if (years.length === 0) return false;
  return years.every((year) => Math.abs(year - targetYear) > 1);
}

/** Merge two result sets: dedupe by torrent/file selection (keep the
 * higher-seeder copy) and
 * sort by year agreement (movies), then quality, then seeders. Lets the
 * imdb-based and title-based passes be combined without double-listing the
 * same torrent. */
function mergeResults(
  a: TorrentResult[],
  b: TorrentResult[],
  title: string | null,
  movieYear: number | null,
): TorrentResult[] {
  const bySelection = new Map<string, TorrentResult>();
  for (const r of a.concat(b)) {
    const key = torrentResultSelectionKey(r);
    const existing = bySelection.get(key);
    if (
      existing == null ||
      (!torrentResultHasUsableFileSelection(existing) && torrentResultHasUsableFileSelection(r)) ||
      (torrentResultHasUsableFileSelection(existing) === torrentResultHasUsableFileSelection(r) &&
        r.seeders > existing.seeders)
    ) bySelection.set(key, r);
  }
  // Year disagreement OUTRANKS quality: a wrong-year release is usually a
  // different film entirely (the v0.9.3 CV QA case - The Odyssey (2026)'s
  // Download menu led with the 1997/2016 adaptations), and a 4K copy of the
  // wrong movie is worse than a 720p copy of the right one. Down-rank only,
  // never drop: releaseYearDisagrees stays neutral on no-year names.
  return [...bySelection.values()]
    .map((r) => ({ r, offYear: releaseYearDisagrees(r.title, title, movieYear) }))
    .sort((x, y) => {
      if (x.offYear !== y.offYear) return x.offYear ? 1 : -1;
      if (x.r.quality !== y.r.quality) {
        return (
          VideoQuality.sortOrder(y.r.quality) - VideoQuality.sortOrder(x.r.quality)
        );
      }
      return y.r.seeders - x.r.seeders;
    })
    .map(({ r }) => r);
}

/** Combine an imdb-native pass with a title/name pass into one ranked result
 * set. The imdb pass is title-exact; the title pass is a loose name search, so
 * validate it against the requested title (when known) before merging. Shared
 * so Local + Server Mode fold the two passes together identically.
 *
 * `movieYear` is the requested MOVIE's release year, when known: releases
 * whose name carries a year incompatible with it are down-ranked below the
 * rest (never dropped - see releaseYearDisagrees). Callers MUST pass null for
 * series: episode releases are tagged with air/rip years that legitimately
 * differ from the series' first-air year (a 2005 show's season 9 rips say
 * 2013), so the signal only disambiguates same-titled MOVIES. */
export function combineStreamResults(
  byImdb: TorrentResult[],
  byTitle: TorrentResult[],
  title: string | null,
  movieYear: number | null = null,
): TorrentResult[] {
  const validatedByTitle =
    title != null ? filterResultsByTitle(byTitle, title) : byTitle;
  return mergeResults(byImdb, validatedByTitle, title, movieYear);
}
