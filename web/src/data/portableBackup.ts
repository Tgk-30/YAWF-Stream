import { DexieStore, getStore } from "../storage";
import {
  createProfileRecord,
  dbNameForProfile,
  getActiveProfileId,
  getAutoEnterProfileId,
  isMultiUserEnabled,
  listProfiles,
  setActiveProfileId,
  setAutoEnterProfileId,
  setMultiUserEnabled,
  updateProfileRecord,
  type LocalProfile,
} from "../storage/ProfileRegistry";

const BACKUP_VERSION = 2;
const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
const MAX_PROFILE_BUNDLE_BYTES = 10 * 1024 * 1024;
const PORTABLE_TABLES = [
  "settings",
  "watchlist",
  "watchlistFolders",
  "watchHistory",
  "library",
  "folders",
  "tasteEvents",
  "mediaCache",
  "aiUsage",
] as const;

const SECRET_SETTING_KEYS = new Set([
  "tmdb_api_key",
  "trakt_client_id",
  "trakt_client_secret",
  "omdb_api_key",
  "ai_api_key",
  "opensubtitles_api_key",
]);

type PortableTableName = (typeof PORTABLE_TABLES)[number];
type PortableRows = Record<PortableTableName, Array<Record<string, unknown>>>;

type PortableProfile = Omit<LocalProfile, "passwordHash">;

export interface PortableProfileData {
  profile: PortableProfile;
  databaseName: string;
  data: PortableRows;
}

export interface PortableBackup {
  product: "YAWF Stream";
  format: "yawf-local-backup";
  version: typeof BACKUP_VERSION;
  createdAt: string;
  activeProfileId: string;
  autoEnterProfileId: string | null;
  multiUserEnabled: boolean;
  exclusions: string[];
  profiles: PortableProfileData[];
}

export interface PortableProfileBundle {
  product: "YAWF Stream";
  format: "yawf-profile-portable";
  version: 1;
  createdAt: string;
  settings: Array<{ key: string; value: string }>;
  watchlist: Array<{
    mediaId: string;
    addedAt: string;
    preview: Record<string, unknown>;
  }>;
  history: Array<{
    mediaId: string;
    episodeId: string | null;
    progressSeconds: number;
    durationSeconds: number | null;
    completed: boolean;
    lastWatched: string;
    streamQuality: string | null;
    preview: Record<string, unknown>;
  }>;
  folders: Array<{
    id: string;
    name: string;
    parentId: string | null;
    listType: "watchlist" | "favorites" | "custom";
    folderKind: "system_root" | "manual" | "watched" | "release_wait";
    isSystem: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  library: Array<{
    mediaId: string;
    folderId: string | null;
    listType: "watchlist" | "favorites" | "custom";
    addedAt: string;
    customListName: string | null;
    releaseDateHint: string | null;
    renewalStatus: string | null;
    preview: Record<string, unknown>;
  }>;
}

export interface PortableProfileConversion {
  bundle: PortableProfileBundle;
  profileName: string;
  skippedRows: number;
  omissions: string[];
}

function requireLocalStore(store = getStore()): DexieStore {
  if (!(store instanceof DexieStore)) {
    throw new Error("Local backup is available only in Local Mode.");
  }
  return store;
}

function isPortableSetting(row: unknown): row is { key: string; value: string } {
  if (row == null || typeof row !== "object") return false;
  const candidate = row as { key?: unknown; value?: unknown };
  return (
    typeof candidate.key === "string" &&
    typeof candidate.value === "string" &&
    !SECRET_SETTING_KEYS.has(candidate.key) &&
    !candidate.value.startsWith("secret:")
  );
}

function sanitizeProfile(profile: LocalProfile): PortableProfile {
  return {
    id: profile.id,
    name: profile.name,
    ...(profile.avatar == null ? {} : { avatar: profile.avatar }),
    ...(profile.color == null ? {} : { color: profile.color }),
    isDefault: profile.isDefault,
    isAdmin: profile.isAdmin,
    createdAt: profile.createdAt,
    ...(profile.lastUsedAt == null ? {} : { lastUsedAt: profile.lastUsedAt }),
  };
}

async function exportRows(local: DexieStore): Promise<PortableRows> {
  const data = {} as PortableRows;
  for (const tableName of PORTABLE_TABLES) {
    const rows = (await local.table(tableName).toArray()) as Array<
      Record<string, unknown>
    >;
    data[tableName] =
      tableName === "settings" ? rows.filter(isPortableSetting) : rows;
  }
  return data;
}

async function withProfileStore<T>(
  databaseName: string,
  activeStore: DexieStore,
  work: (store: DexieStore) => Promise<T>,
): Promise<T> {
  if (activeStore.name === databaseName) return work(activeStore);
  const temporaryStore = new DexieStore(databaseName);
  try {
    await temporaryStore.open();
    return await work(temporaryStore);
  } finally {
    temporaryStore.close();
  }
}

export async function exportPortableBackup(
  explicitStore?: DexieStore,
): Promise<PortableBackup> {
  const activeStore = requireLocalStore(explicitStore);
  const registryProfiles = explicitStore == null ? await listProfiles() : [];
  const profiles: LocalProfile[] =
    registryProfiles.length > 0
      ? registryProfiles
      : [
          {
            id: "default",
            name: "You",
            isDefault: true,
            isAdmin: true,
            createdAt: Date.now(),
          },
        ];
  const activeProfileId =
    explicitStore == null ? (await getActiveProfileId()) ?? profiles[0]!.id : profiles[0]!.id;
  const profileData: PortableProfileData[] = [];

  for (const profile of profiles) {
    const databaseName =
      explicitStore != null ? explicitStore.name : dbNameForProfile(profile);
    const data = await withProfileStore(databaseName, activeStore, exportRows);
    profileData.push({
      profile: sanitizeProfile(profile),
      databaseName,
      data,
    });
  }

  return {
    product: "YAWF Stream",
    format: "yawf-local-backup",
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    activeProfileId,
    autoEnterProfileId:
      explicitStore == null ? await getAutoEnterProfileId() : activeProfileId,
    multiUserEnabled:
      explicitStore == null ? await isMultiUserEnabled() : profiles.length > 1,
    exclusions: [
      "credentials and API keys",
      "profile password hashes",
      "resolved stream URLs",
      "device-specific download paths",
    ],
    profiles: profileData,
  };
}

function isPortableProfile(value: unknown): value is PortableProfile {
  if (value == null || typeof value !== "object") return false;
  const profile = value as Partial<PortableProfile> & { passwordHash?: unknown };
  return (
    typeof profile.id === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(profile.id) &&
    typeof profile.name === "string" &&
    profile.name.trim().length > 0 &&
    profile.name.length <= 80 &&
    typeof profile.isDefault === "boolean" &&
    typeof profile.isAdmin === "boolean" &&
    typeof profile.createdAt === "number" &&
    Number.isFinite(profile.createdAt) &&
    profile.passwordHash == null
  );
}

function validateRows(data: unknown): asserts data is PortableRows {
  if (data == null || typeof data !== "object") {
    throw new Error("Backup profile data is missing or invalid.");
  }
  const rows = data as Partial<PortableRows>;
  for (const tableName of PORTABLE_TABLES) {
    if (!Array.isArray(rows[tableName])) {
      throw new Error(`Backup table "${tableName}" is missing or invalid.`);
    }
  }
  if (!rows.settings!.every(isPortableSetting)) {
    throw new Error("Backup contains a secret-valued setting.");
  }
}

function validateBackup(value: unknown): asserts value is PortableBackup {
  if (value == null || typeof value !== "object") {
    throw new Error("Backup is not a JSON object.");
  }
  const candidate = value as Partial<PortableBackup>;
  if (
    candidate.product !== "YAWF Stream" ||
    candidate.format !== "yawf-local-backup" ||
    candidate.version !== BACKUP_VERSION ||
    !Array.isArray(candidate.profiles) ||
    candidate.profiles.length === 0 ||
    typeof candidate.activeProfileId !== "string" ||
    typeof candidate.multiUserEnabled !== "boolean" ||
    !(candidate.autoEnterProfileId == null || typeof candidate.autoEnterProfileId === "string")
  ) {
    throw new Error("Backup format or version is not supported.");
  }

  const ids = new Set<string>();
  let defaultProfiles = 0;
  for (const entry of candidate.profiles) {
    if (
      entry == null ||
      typeof entry !== "object" ||
      !isPortableProfile(entry.profile) ||
      typeof entry.databaseName !== "string" ||
      entry.databaseName.length === 0
    ) {
      throw new Error("Backup contains an invalid local profile.");
    }
    if (ids.has(entry.profile.id)) {
      throw new Error("Backup contains duplicate local profile IDs.");
    }
    ids.add(entry.profile.id);
    if (entry.profile.isDefault) defaultProfiles += 1;
    validateRows(entry.data);
  }
  if (defaultProfiles !== 1 || !ids.has(candidate.activeProfileId)) {
    throw new Error("Backup profile selection metadata is invalid.");
  }
  if (candidate.autoEnterProfileId != null && !ids.has(candidate.autoEnterProfileId)) {
    throw new Error("Backup automatic profile selection is invalid.");
  }
}

export function parsePortableBackup(text: string): PortableBackup {
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) {
    throw new Error("Backup is larger than the 100 MB safety limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Backup is not valid JSON.");
  }
  validateBackup(value);
  return value;
}

export function parsePortableProfileBundle(
  text: string,
): PortableProfileBundle {
  if (new TextEncoder().encode(text).byteLength > MAX_PROFILE_BUNDLE_BYTES) {
    throw new Error("Profile bundle is larger than the 10 MB safety limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Profile bundle is not valid JSON.");
  }
  const candidate = portableObject(value);
  if (
    candidate?.product !== "YAWF Stream" ||
    candidate.format !== "yawf-profile-portable" ||
    candidate.version !== 1 ||
    portableDate(candidate.createdAt) == null ||
    !Array.isArray(candidate.settings) ||
    !Array.isArray(candidate.watchlist) ||
    !Array.isArray(candidate.history) ||
    !Array.isArray(candidate.folders) ||
    !Array.isArray(candidate.library) ||
    candidate.settings.length > 300 ||
    candidate.watchlist.length > 10_000 ||
    candidate.history.length > 20_000 ||
    candidate.folders.length > 5_000 ||
    candidate.library.length > 20_000
  ) {
    throw new Error("Profile bundle format or version is not supported.");
  }
  if (!candidate.settings.every(isPortableSetting)) {
    throw new Error("Profile bundle contains a secret-valued setting.");
  }
  return value as PortableProfileBundle;
}

function portableObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function portableString(
  value: unknown,
  maxLength: number,
  allowEmpty = false,
): string | null {
  if (typeof value !== "string" || value.length > maxLength) return null;
  const trimmed = value.trim();
  return allowEmpty || trimmed.length > 0 ? trimmed : null;
}

function portableNullableString(
  value: unknown,
  maxLength: number,
): string | null | undefined {
  if (value == null) return null;
  return portableString(value, maxLength, true) ?? undefined;
}

function portableDate(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 80) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function portableNumber(value: unknown, minimum = 0): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum
    ? value
    : null;
}

function portablePreview(value: unknown): Record<string, unknown> | null {
  const preview = portableObject(value);
  if (preview == null) return null;
  try {
    if (JSON.stringify(preview).length > 32_768) return null;
  } catch {
    return null;
  }
  return preview;
}

function portableListType(
  value: unknown,
): "watchlist" | "favorites" | "custom" | null {
  return value === "watchlist" || value === "favorites" || value === "custom"
    ? value
    : null;
}

function portableFolderKind(
  value: unknown,
): "system_root" | "manual" | "watched" | "release_wait" | null {
  return value === "system_root" ||
    value === "manual" ||
    value === "watched" ||
    value === "release_wait"
    ? value
    : null;
}

/** Convert one selected profile from a full Local Mode backup into the
 * profile-scoped, secret-free Server Mode portability contract. Local-only
 * caches, taste events, AI cost history, and watchlist-folder assignments are
 * intentionally omitted because Server Mode has no equivalent tables. */
export function portableProfileBundleFromBackup(
  backup: PortableBackup,
  profileId = backup.activeProfileId,
): PortableProfileConversion {
  const selected = backup.profiles.find(
    (entry) => entry.profile.id === profileId,
  );
  if (selected == null) {
    throw new Error("The selected local profile is not present in this backup.");
  }

  let skippedRows = 0;
  const settings: PortableProfileBundle["settings"] = [];
  for (const raw of selected.data.settings) {
    if (!isPortableSetting(raw)) {
      skippedRows += 1;
      continue;
    }
    settings.push({ key: raw.key, value: raw.value });
  }

  const watchlist: PortableProfileBundle["watchlist"] = [];
  let omittedWatchlistAssignments = 0;
  for (const raw of selected.data.watchlist.slice(0, 10_000)) {
    const row = portableObject(raw);
    const mediaId = portableString(row?.mediaId, 128);
    const addedAt = portableDate(row?.addedAt);
    const preview = portablePreview(row?.preview);
    if (mediaId == null || addedAt == null || preview == null) {
      skippedRows += 1;
      continue;
    }
    if (portableString(row?.folderId, 128) != null) {
      omittedWatchlistAssignments += 1;
    }
    watchlist.push({ mediaId, addedAt, preview });
  }

  const history: PortableProfileBundle["history"] = [];
  for (const raw of selected.data.watchHistory.slice(0, 20_000)) {
    const row = portableObject(raw);
    const mediaId = portableString(row?.mediaId, 128);
    const episodeId = portableNullableString(row?.episodeId, 128);
    const progressSeconds = portableNumber(row?.progressSeconds);
    const durationSeconds =
      row?.durationSeconds == null
        ? null
        : portableNumber(row.durationSeconds, Number.MIN_VALUE);
    const lastWatched = portableDate(row?.lastWatched);
    const streamQuality = portableNullableString(row?.streamQuality, 80);
    const preview = portablePreview(row?.preview);
    if (
      mediaId == null ||
      episodeId === undefined ||
      progressSeconds == null ||
      (durationSeconds == null && row?.durationSeconds != null) ||
      typeof row?.completed !== "boolean" ||
      lastWatched == null ||
      streamQuality === undefined ||
      preview == null
    ) {
      skippedRows += 1;
      continue;
    }
    history.push({
      mediaId,
      episodeId,
      progressSeconds,
      durationSeconds,
      completed: row.completed,
      lastWatched,
      streamQuality,
      preview,
    });
  }

  const folders: PortableProfileBundle["folders"] = [];
  for (const raw of selected.data.folders.slice(0, 5_000)) {
    const row = portableObject(raw);
    const id = portableString(row?.id, 128);
    const name = portableString(row?.name, 120);
    const parentId = portableNullableString(row?.parentId, 128);
    const listType = portableListType(row?.listType);
    const folderKind = portableFolderKind(row?.folderKind);
    const createdAt = portableDate(row?.createdAt);
    const updatedAt = portableDate(row?.updatedAt);
    if (
      id == null ||
      name == null ||
      parentId === undefined ||
      listType == null ||
      folderKind == null ||
      typeof row?.isSystem !== "boolean" ||
      createdAt == null ||
      updatedAt == null
    ) {
      skippedRows += 1;
      continue;
    }
    folders.push({
      id,
      name,
      parentId,
      listType,
      folderKind,
      isSystem: row.isSystem,
      createdAt,
      updatedAt,
    });
  }

  const library: PortableProfileBundle["library"] = [];
  for (const raw of selected.data.library.slice(0, 20_000)) {
    const row = portableObject(raw);
    const mediaId = portableString(row?.mediaId, 128);
    const folderId = portableNullableString(row?.folderId, 128);
    const listType = portableListType(row?.listType);
    const addedAt = portableDate(row?.addedAt);
    const customListName = portableNullableString(row?.customListName, 200);
    const releaseDateHint = portableNullableString(row?.releaseDateHint, 64);
    const renewalStatus = portableNullableString(row?.renewalStatus, 64);
    const preview = portablePreview(row?.preview);
    if (
      mediaId == null ||
      folderId === undefined ||
      listType == null ||
      addedAt == null ||
      customListName === undefined ||
      releaseDateHint === undefined ||
      renewalStatus === undefined ||
      preview == null
    ) {
      skippedRows += 1;
      continue;
    }
    library.push({
      mediaId,
      folderId,
      listType,
      addedAt,
      customListName,
      releaseDateHint,
      renewalStatus,
      preview,
    });
  }

  const omissions = [
    "Credentials, profile locks, stream URLs, and device paths remain excluded.",
  ];
  if (omittedWatchlistAssignments > 0) {
    omissions.push(
      `${omittedWatchlistAssignments} watchlist folder assignment(s) were flattened because Server Mode watchlists do not use local folders.`,
    );
  }
  if (
    selected.data.tasteEvents.length > 0 ||
    selected.data.mediaCache.length > 0 ||
    selected.data.aiUsage.length > 0
  ) {
    omissions.push(
      "Local taste events, cached metadata, and AI usage history were not migrated.",
    );
  }

  return {
    profileName: selected.profile.name,
    skippedRows,
    omissions,
    bundle: {
      product: "YAWF Stream",
      format: "yawf-profile-portable",
      version: 1,
      createdAt: new Date().toISOString(),
      settings,
      watchlist,
      history,
      folders,
      library,
    },
  };
}

async function restoreRows(local: DexieStore, data: PortableRows): Promise<number> {
  const tables = PORTABLE_TABLES.map((name) => local.table(name));
  let restoredRows = 0;
  await local.transaction("rw", tables, async () => {
    for (const tableName of PORTABLE_TABLES) {
      const rows = data[tableName];
      const table = local.table(tableName);
      if (tableName === "settings") {
        await table
          .filter((row: { key?: unknown }) =>
            typeof row.key === "string" ? !SECRET_SETTING_KEYS.has(row.key) : true,
          )
          .delete();
      } else {
        await table.clear();
      }
      if (rows.length > 0) {
        await table.bulkPut(rows);
        restoredRows += rows.length;
      }
    }
  });
  return restoredRows;
}

export async function restorePortableBackup(
  backupValue: PortableBackup,
  explicitStore?: DexieStore,
): Promise<{
  preRestoreBackup: PortableBackup;
  restoredRows: number;
  restoredProfiles: number;
  unlockedProfiles: number;
}> {
  validateBackup(backupValue);
  const activeStore = requireLocalStore(explicitStore);
  const preRestoreBackup = await exportPortableBackup(explicitStore);
  let restoredRows = 0;
  let unlockedProfiles = 0;

  if (explicitStore != null) {
    restoredRows = await restoreRows(explicitStore, backupValue.profiles[0]!.data);
    return {
      preRestoreBackup,
      restoredRows,
      restoredProfiles: 1,
      unlockedProfiles: 0,
    };
  }

  const existingProfiles = await listProfiles();
  const existingById = new Map(existingProfiles.map((profile) => [profile.id, profile]));
  for (const entry of backupValue.profiles) {
    const existing = existingById.get(entry.profile.id);
    if (existing == null) {
      await createProfileRecord(entry.profile);
      unlockedProfiles += 1;
    } else {
      await updateProfileRecord(entry.profile.id, {
        name: entry.profile.name,
        avatar: entry.profile.avatar,
        color: entry.profile.color,
        isDefault: entry.profile.isDefault,
        isAdmin: entry.profile.isAdmin,
        createdAt: entry.profile.createdAt,
        lastUsedAt: entry.profile.lastUsedAt,
      });
    }

    const databaseName = dbNameForProfile(entry.profile);
    restoredRows += await withProfileStore(databaseName, activeStore, (store) =>
      restoreRows(store, entry.data),
    );
  }

  await setMultiUserEnabled(backupValue.multiUserEnabled);
  await setActiveProfileId(backupValue.activeProfileId);
  await setAutoEnterProfileId(backupValue.autoEnterProfileId);

  return {
    preRestoreBackup,
    restoredRows,
    restoredProfiles: backupValue.profiles.length,
    unlockedProfiles,
  };
}

export function portableBackupFilename(
  kind: "backup" | "pre-restore",
  createdAt = new Date(),
): string {
  const timestamp = createdAt
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");
  return `yawf-stream-${kind}-${timestamp}.json`;
}
