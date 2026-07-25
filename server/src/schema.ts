export const MIGRATION_001 = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'restricted')),
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  disabled_at TEXT
);

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  avatar_color TEXT,
  simple_mode INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE INDEX profiles_user_id_idx ON profiles(user_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  ip_hash TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE server_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE profile_settings (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (profile_id, key)
);

CREATE TABLE credential_secrets (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('server', 'profile')),
  profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'server' AND profile_id IS NULL) OR (scope = 'profile' AND profile_id IS NOT NULL))
);

CREATE INDEX credential_lookup_idx
  ON credential_secrets(provider, scope, profile_id, is_active, priority);

CREATE TABLE watchlist (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  PRIMARY KEY (profile_id, media_id)
);

CREATE INDEX watchlist_added_at_idx ON watchlist(profile_id, added_at);

CREATE TABLE watch_history (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL,
  episode_key TEXT NOT NULL DEFAULT '',
  episode_id TEXT,
  progress_seconds REAL NOT NULL DEFAULT 0,
  duration_seconds REAL,
  completed INTEGER NOT NULL DEFAULT 0,
  last_watched TEXT NOT NULL,
  stream_quality TEXT,
  preview_json TEXT NOT NULL,
  PRIMARY KEY (profile_id, media_id, episode_key)
);

CREATE INDEX watch_history_last_watched_idx
  ON watch_history(profile_id, last_watched);

CREATE TABLE library_folders (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parent_id TEXT,
  list_type TEXT NOT NULL,
  folder_kind TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES library_folders(id) ON DELETE SET NULL
);

CREATE INDEX library_folders_profile_idx ON library_folders(profile_id, list_type);

CREATE TABLE user_library (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL,
  folder_id TEXT,
  list_type TEXT NOT NULL,
  added_at TEXT NOT NULL,
  custom_list_name TEXT,
  release_date_hint TEXT,
  renewal_status TEXT,
  preview_json TEXT NOT NULL,
  UNIQUE (profile_id, media_id, folder_id),
  FOREIGN KEY (folder_id) REFERENCES library_folders(id) ON DELETE SET NULL
);

CREATE INDEX user_library_profile_idx ON user_library(profile_id, list_type, added_at);

CREATE TABLE stream_sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  encrypted_upstream_url TEXT NOT NULL,
  content_type TEXT,
  title TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX stream_sessions_profile_idx ON stream_sessions(profile_id, expires_at);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX audit_log_created_at_idx ON audit_log(created_at);
`;

export const MIGRATION_002 = `
ALTER TABLE stream_sessions ADD COLUMN bytes_served INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stream_sessions ADD COLUMN last_accessed_at TEXT;
ALTER TABLE stream_sessions ADD COLUMN completed_at TEXT;
ALTER TABLE stream_sessions ADD COLUMN last_status INTEGER;
ALTER TABLE stream_sessions ADD COLUMN last_error TEXT;
CREATE INDEX stream_sessions_created_idx ON stream_sessions(profile_id, created_at);
`;

// Household sub-profiles: a session now remembers WHICH of an account's profiles
// is active ("who's watching"). Nullable + migration-safe - existing rows get
// NULL and readAuth falls back to the account's is_default profile, so a
// single-profile deployment keeps working with zero manual steps. ON DELETE SET
// NULL so deleting a profile (which cascades its data) cleanly drops the pointer
// rather than orphaning sessions.
export const MIGRATION_004 = `
ALTER TABLE sessions
  ADD COLUMN active_profile_id TEXT
  REFERENCES profiles(id) ON DELETE SET NULL;
`;

export const MIGRATION_003 = `
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by_profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  label TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'restricted')),
  simple_mode INTEGER NOT NULL DEFAULT 1,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX invites_active_idx ON invites(expires_at, revoked_at);
`;

// Phase 3b: track a session's active transcode temp dir so a crash leftover can
// be swept on boot. Nullable → existing rows + the proxy path are unaffected.
export const MIGRATION_005 = `
ALTER TABLE stream_sessions ADD COLUMN transcode_dir TEXT;
`;

// Phase 4: title requests with an approve/deny lifecycle (kids/members request,
// owner/admins decide; approved titles surface in a shared "Requested" list).
export const MIGRATION_006 = `
CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  requester_profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')) DEFAULT 'pending',
  decided_by_profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  decision_reason TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT
);
-- One LIVE pending request per (profile, media): a denied/approved row never
-- blocks a re-request, and there can't be two pending duplicates.
CREATE UNIQUE INDEX requests_one_pending_idx
  ON requests(requester_profile_id, media_id) WHERE status = 'pending';
CREATE INDEX requests_status_idx ON requests(status, requested_at DESC);
CREATE INDEX requests_requester_idx ON requests(requester_profile_id, requested_at DESC);
`;

// Phase 4 (kids): per-profile maturity gating. `is_kid` locks the profile into
// the curated, search-disabled kid experience; `maturity_max` is the rating
// ceiling (a US movie cert: G/PG/PG-13/R/NC-17, NULL = no cap). Both default to
// the unrestricted adult behavior so existing profiles are unaffected. Set by an
// owner/admin via POST /api/account/profiles/:id/maturity. The play-block reads
// `maturity_max`; the curated-browse/search lockdown reads `is_kid`.
export const MIGRATION_007 = `
ALTER TABLE profiles ADD COLUMN is_kid INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN maturity_max TEXT;
`;

// Shared server-side metadata cache. Keys are provider-specific hashes of
// normalized upstream read URLs (credential query params stripped), so repeated
// TMDB reads can be reused across profiles without storing API keys or raw
// search strings in SQLite.
export const MIGRATION_008 = `
CREATE TABLE metadata_cache (
  provider TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  status INTEGER NOT NULL,
  value_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (provider, cache_key)
);

CREATE INDEX metadata_cache_expires_idx
  ON metadata_cache(provider, expires_at);
`;

// Optional TOTP is account-scoped. Pending enrollment remains separate from
// the active secret so scanning an authenticator never enables 2FA until a
// valid code is confirmed. Both secrets are encrypted with the server key.
export const MIGRATION_009 = `
ALTER TABLE users ADD COLUMN totp_secret_encrypted TEXT;
ALTER TABLE users ADD COLUMN totp_pending_secret_encrypted TEXT;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
`;

// Explicit next-episode handoffs must survive restart and sync, while remaining
// distinguishable from ordinary zero-progress viewed rows.
export const MIGRATION_010 = `
ALTER TABLE watch_history ADD COLUMN queued_next INTEGER NOT NULL DEFAULT 0;
CREATE INDEX watch_history_continue_idx
  ON watch_history(profile_id, queued_next, completed, last_watched DESC);
`;

/** Ordered, append-only database migrations. Never edit a released migration.
 * Add the next numbered entry so existing databases and fixture snapshots keep
 * a deterministic upgrade path. */
export const MIGRATIONS: ReadonlyArray<readonly [version: number, sql: string]> = [
  [1, MIGRATION_001],
  [2, MIGRATION_002],
  [3, MIGRATION_003],
  [4, MIGRATION_004],
  [5, MIGRATION_005],
  [6, MIGRATION_006],
  [7, MIGRATION_007],
  [8, MIGRATION_008],
  [9, MIGRATION_009],
  [10, MIGRATION_010],
];
