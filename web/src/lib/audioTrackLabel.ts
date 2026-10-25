import {
  PLAYBACK_LANGUAGE_OPTIONS,
  normalizeLanguagePreference,
} from "./languagePreference";

const LANGUAGE_LABELS = new Map(
  PLAYBACK_LANGUAGE_OPTIONS.map(({ value, label }) => [value, label]),
);

// Exact metadata sentinels indicate that no language was determined. Keep
// arbitrary unknown text and codes visible, but do not expose these tokens.
const UNDETERMINED_LANGUAGE_VALUES = new Set([
  "und",
  "unknown",
  "none",
  "null",
  "n/a",
  "na",
  "default",
]);

const MISSING_LANGUAGE_TITLE_VALUES = new Set([...UNDETERMINED_LANGUAGE_VALUES, "original"]);

/** Exact metadata sentinels used only when a value is in a language context. */
export function isUndeterminedLanguage(value: unknown): boolean {
  return typeof value === "string" && MISSING_LANGUAGE_TITLE_VALUES.has(value.trim().toLowerCase());
}

function isUndeterminedTitle(value: string): boolean {
  return UNDETERMINED_LANGUAGE_VALUES.has(value.toLowerCase());
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

interface ParsedLanguageCode {
  canonical: string;
  script: string | null;
  region: string | null;
  display: string;
}

function parseLanguageCode(value: unknown): ParsedLanguageCode | null {
  const raw = cleanText(value);
  if (!raw || (raw.includes("-") && raw.includes("_"))) return null;
  const separator = raw.includes("_") ? "_" : "-";
  const parts = raw.split(separator);
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !part)) {
    return null;
  }

  const [base, second, third] = parts;
  if (!/^[a-z]{2,3}$/i.test(base!)) return null;
  const canonical = normalizeLanguagePreference(base);
  const language = canonical == null ? null : LANGUAGE_LABELS.get(canonical);
  if (canonical == null || language == null) return null;

  let script: string | null = null;
  let region: string | null = null;
  if (second != null) {
    if (/^[a-z]{4}$/i.test(second)) {
      script = `${second[0]!.toUpperCase()}${second.slice(1).toLowerCase()}`;
    } else if (/^(?:[a-z]{2}|[0-9]{3})$/i.test(second) && third == null) {
      region = second.toUpperCase();
    } else {
      return null;
    }
  }
  if (third != null) {
    if (script == null || !/^(?:[a-z]{2}|[0-9]{3})$/i.test(third)) return null;
    region = third.toUpperCase();
  }

  const qualifiers = [script, region].filter((part): part is string => part != null);
  return {
    canonical,
    script,
    region,
    display: qualifiers.length === 0
      ? language
      : `${language} (${qualifiers.join("-")})`,
  };
}

function strictlyExtends(
  base: ParsedLanguageCode,
  candidate: ParsedLanguageCode,
): boolean {
  if (base.canonical !== candidate.canonical) return false;
  if (base.script != null && base.script !== candidate.script) return false;
  if (base.region != null && base.region !== candidate.region) return false;
  return (base.script == null && candidate.script != null) ||
    (base.region == null && candidate.region != null);
}

/**
 * Expands a language code only when the complete value is language metadata.
 * Human titles are deliberately excluded so commentary, channel, and layout
 * details remain exactly as supplied by the source.
 */
export function readableAudioLanguageLabel(value: unknown): string | null {
  return parseLanguageCode(value)?.display ?? null;
}

/** A readable player label without changing the track's selection identity. */
export function audioTrackLabel(
  label: unknown,
  language: unknown,
  fallback: string,
): string {
  const title = cleanText(label);
  const languageValue = cleanText(language);
  if (title && !isUndeterminedTitle(title)) {
    const titleCode = parseLanguageCode(title);
    if (titleCode != null) {
      const languageCode = parseLanguageCode(languageValue);
      return languageCode != null && strictlyExtends(titleCode, languageCode)
        ? languageCode.display
        : titleCode.display;
    }
    return title;
  }
  return isUndeterminedLanguage(languageValue)
    ? fallback
    : (readableAudioLanguageLabel(languageValue) ?? languageValue) || fallback;
}
