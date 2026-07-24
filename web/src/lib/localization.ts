export const INTERFACE_LANGUAGE_OPTIONS = [
  { value: "system", label: "Use device language" },
  { value: "en", label: "English" },
  { value: "pt-BR", label: "Português (Brasil)" },
  { value: "fr", label: "Français" },
  { value: "es", label: "Español" },
  { value: "de", label: "Deutsch" },
  { value: "it", label: "Italiano" },
  { value: "ar", label: "العربية" },
] as const;

export const METADATA_LANGUAGE_OPTIONS = [
  { value: "en-US", label: "English (United States)" },
  { value: "pt-BR", label: "Português (Brasil)" },
  { value: "fr-FR", label: "Français (France)" },
  { value: "es-ES", label: "Español (España)" },
  { value: "de-DE", label: "Deutsch (Deutschland)" },
  { value: "it-IT", label: "Italiano (Italia)" },
  { value: "ar-AE", label: "العربية (الإمارات)" },
] as const;

export const METADATA_REGION_OPTIONS = [
  { value: "US", label: "United States" },
  { value: "BR", label: "Brazil" },
  { value: "FR", label: "France" },
  { value: "ES", label: "Spain" },
  { value: "DE", label: "Germany" },
  { value: "IT", label: "Italy" },
  { value: "AE", label: "United Arab Emirates" },
  { value: "GB", label: "United Kingdom" },
  { value: "CA", label: "Canada" },
  { value: "AU", label: "Australia" },
] as const;

export type InterfaceLanguage =
  (typeof INTERFACE_LANGUAGE_OPTIONS)[number]["value"];

export function normalizeInterfaceLanguage(value: unknown): InterfaceLanguage {
  return INTERFACE_LANGUAGE_OPTIONS.some((option) => option.value === value)
    ? (value as InterfaceLanguage)
    : "system";
}

export function normalizeMetadataLanguage(value: unknown): string {
  if (typeof value !== "string") return "en-US";
  try {
    const locale = new Intl.Locale(value.trim());
    return locale.toString();
  } catch {
    return "en-US";
  }
}

export function normalizeMetadataRegion(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z]{2}$/.test(value.trim())
    ? value.trim().toUpperCase()
    : "US";
}

const SUPPORTED: ReadonlySet<string> = new Set(
  INTERFACE_LANGUAGE_OPTIONS.map((option) => option.value).filter(
    (value) => value !== "system",
  ),
);

export function resolveInterfaceLocale(
  preference: unknown,
  deviceLanguages: readonly string[] = navigator.languages,
): string {
  const normalized = normalizeInterfaceLanguage(preference);
  if (normalized !== "system") return normalized;
  for (const language of deviceLanguages) {
    if (SUPPORTED.has(language)) return language;
    const base = language.split("-", 1)[0] ?? "";
    if (SUPPORTED.has(base)) return base;
    if (base === "pt") return "pt-BR";
  }
  return "en";
}

export function applyDocumentLocale(preference: unknown): string {
  const locale = resolveInterfaceLocale(preference);
  document.documentElement.lang = locale;
  document.documentElement.dir = locale.startsWith("ar") ? "rtl" : "ltr";
  return locale;
}

type TranslationKey =
  | "nav.discover"
  | "nav.search"
  | "nav.library"
  | "nav.watchlist"
  | "nav.calendar"
  | "nav.history"
  | "nav.downloads"
  | "nav.assistant"
  | "nav.debrid"
  | "nav.settings"
  | "common.skipContent"
  | "route.page";

const translations: Readonly<
  Record<string, Partial<Record<TranslationKey, string>>>
> = {
  "pt-BR": {
    "nav.discover": "Descobrir",
    "nav.search": "Buscar",
    "nav.library": "Biblioteca",
    "nav.watchlist": "Minha lista",
    "nav.calendar": "Calendário",
    "nav.history": "Histórico",
    "nav.downloads": "Downloads",
    "nav.assistant": "Assistente",
    "nav.debrid": "Debrid",
    "nav.settings": "Configurações",
    "common.skipContent": "Pular para o conteúdo",
    "route.page": "página",
  },
  fr: {
    "nav.discover": "Découvrir",
    "nav.search": "Rechercher",
    "nav.library": "Bibliothèque",
    "nav.watchlist": "À regarder",
    "nav.calendar": "Calendrier",
    "nav.history": "Historique",
    "nav.downloads": "Téléchargements",
    "nav.assistant": "Assistant",
    "nav.debrid": "Debrid",
    "nav.settings": "Réglages",
    "common.skipContent": "Aller au contenu",
    "route.page": "page",
  },
  es: {
    "nav.discover": "Descubrir",
    "nav.search": "Buscar",
    "nav.library": "Biblioteca",
    "nav.watchlist": "Mi lista",
    "nav.calendar": "Calendario",
    "nav.history": "Historial",
    "nav.downloads": "Descargas",
    "nav.assistant": "Asistente",
    "nav.debrid": "Debrid",
    "nav.settings": "Ajustes",
    "common.skipContent": "Saltar al contenido",
    "route.page": "página",
  },
  de: {
    "nav.discover": "Entdecken",
    "nav.search": "Suchen",
    "nav.library": "Bibliothek",
    "nav.watchlist": "Merkliste",
    "nav.calendar": "Kalender",
    "nav.history": "Verlauf",
    "nav.downloads": "Downloads",
    "nav.assistant": "Assistent",
    "nav.debrid": "Debrid",
    "nav.settings": "Einstellungen",
    "common.skipContent": "Zum Inhalt springen",
    "route.page": "Seite",
  },
  it: {
    "nav.discover": "Scopri",
    "nav.search": "Cerca",
    "nav.library": "Libreria",
    "nav.watchlist": "Lista",
    "nav.calendar": "Calendario",
    "nav.history": "Cronologia",
    "nav.downloads": "Download",
    "nav.assistant": "Assistente",
    "nav.debrid": "Debrid",
    "nav.settings": "Impostazioni",
    "common.skipContent": "Vai al contenuto",
    "route.page": "pagina",
  },
  ar: {
    "nav.discover": "استكشف",
    "nav.search": "بحث",
    "nav.library": "المكتبة",
    "nav.watchlist": "قائمتي",
    "nav.calendar": "التقويم",
    "nav.history": "السجل",
    "nav.downloads": "التنزيلات",
    "nav.assistant": "المساعد",
    "nav.debrid": "Debrid",
    "nav.settings": "الإعدادات",
    "common.skipContent": "انتقل إلى المحتوى",
    "route.page": "صفحة",
  },
};

export function translate(
  locale: string,
  key: TranslationKey,
  fallback: string,
): string {
  return translations[locale]?.[key] ?? fallback;
}
