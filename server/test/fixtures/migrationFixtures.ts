import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../../src/schema.js";

export const RELEASED_MIGRATION_HASHES = [
  "036508302b223d8eca911011d81ddf5b39ca347196fa32aaf999d9fb3cd53ab7",
  "fcd7cf87693c9c688f808f01b301bfd583960bdac1e172e1e4d71b9b783c32e4",
  "10fc2724b5a6def477bd509209940a38966185c21148134562a9922522729de5",
  "0dc7b3e8eefdb63ba072a89d6d7fcc9aa3a24a4df24859145a8eacee1bae05e3",
  "9440c44c8c32ad843c9dd1508f67456593d2b5b80660cc85cbc046987586e1f9",
  "c8eaf44196dacbdb79e4d69ec20514d39bf160125c54474e6a2c4f276dabc4a0",
  "51b5c8430c41d02fba7e7a79e71870401f86c7d40dec4063c3ad072c5c3f3c72",
  "14d71b01a79d1223197e2cbe487781706b2cff14e144cc11682fd298b4315697",
  "ad4bca57ae670493d02661215daddde1e2e54ef50d772acaddb608523a91c0a9",
  "c3b5b133e1767cdb9b65a21d4c5cd57bc4fb3e63d81f50a4f43a1e7d08f7ed7a",
  "6e8d675361c369d582239fb7c368a5b4e09ed52ba8c4d97eb8ee7e9ec995f72d",
] as const;

export interface LegacyServerFixture {
  name: string;
  version: 1 | 7;
}

export const LEGACY_SERVER_FIXTURES: readonly LegacyServerFixture[] = [
  { name: "first server schema", version: 1 },
  { name: "pre-metadata-cache schema", version: 7 },
];

export function migrationHashes(): string[] {
  return MIGRATIONS.map(([, sql]) =>
    createHash("sha256").update(sql).digest("hex"),
  );
}

export function createLegacyServerFixture(path: string, version: 1 | 7): void {
  const sqlite = new DatabaseSync(path);
  try {
    sqlite.exec("PRAGMA foreign_keys = ON;");
    sqlite.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    for (const [migrationVersion, sql] of MIGRATIONS) {
      if (migrationVersion > version) break;
      sqlite.exec(sql);
      sqlite.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(migrationVersion, `2025-01-0${Math.min(migrationVersion, 9)}T00:00:00.000Z`);
    }

    sqlite.exec(`
      INSERT INTO users
        (id, username, display_name, password_hash, role, created_at)
      VALUES
        ('user-fixture', 'fixture-owner', 'Fixture Owner', 'hash-fixture', 'owner', '2025-01-01T00:00:00.000Z');

      INSERT INTO profiles
        (id, user_id, display_name, avatar_color, simple_mode, is_default, created_at, updated_at)
      VALUES
        ('profile-fixture', 'user-fixture', 'Living Room', '#22c55e', 0, 1,
         '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z');

      INSERT INTO sessions
        (id, user_id, token_hash, user_agent, ip_hash, created_at, expires_at)
      VALUES
        ('session-fixture', 'user-fixture', 'token-hash-fixture', 'Fixture Browser', 'ip-hash-fixture',
         '2025-01-01T00:00:00.000Z', '2035-01-01T00:00:00.000Z');

      INSERT INTO server_settings (key, value)
      VALUES ('fixture_server_setting', 'preserve-server');

      INSERT INTO profile_settings (profile_id, key, value)
      VALUES ('profile-fixture', 'ui_theme', 'midnight');

      INSERT INTO credential_secrets
        (id, provider, scope, profile_id, label, encrypted_value, priority, is_active, created_at, updated_at)
      VALUES
        ('credential-fixture', 'real_debrid', 'profile', 'profile-fixture', 'Fixture credential',
         'v1:fixture:encrypted:value', 10, 1, '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z');

      INSERT INTO watchlist (profile_id, media_id, added_at, preview_json)
      VALUES ('profile-fixture', 'tt-fixture', '2025-01-03T00:00:00.000Z',
              '{"id":"tt-fixture","title":"Fixture Film"}');

      INSERT INTO watch_history
        (profile_id, media_id, episode_key, episode_id, progress_seconds, duration_seconds,
         completed, last_watched, stream_quality, preview_json)
      VALUES
        ('profile-fixture', 'series-fixture', 's1e1', 's1e1', 420, 1800, 0,
         '2025-01-04T00:00:00.000Z', '1080p',
         '{"id":"series-fixture","title":"Fixture Series"}');

      INSERT INTO library_folders
        (id, profile_id, name, parent_id, list_type, folder_kind, is_system, created_at, updated_at)
      VALUES
        ('folder-fixture', 'profile-fixture', 'Favorites', NULL, 'favorites', 'manual', 0,
         '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');

      INSERT INTO user_library
        (id, profile_id, media_id, folder_id, list_type, added_at, preview_json)
      VALUES
        ('library-fixture', 'profile-fixture', 'tt-library', 'folder-fixture', 'favorites',
         '2025-01-05T00:00:00.000Z', '{"id":"tt-library","title":"Saved Fixture"}');

      INSERT INTO stream_sessions
        (id, profile_id, encrypted_upstream_url, content_type, title, created_at, expires_at)
      VALUES
        ('stream-fixture', 'profile-fixture', 'v1:fixture:stream:url', 'video/mp4', 'Fixture stream',
         '2025-01-06T00:00:00.000Z', '2035-01-06T00:00:00.000Z');

      INSERT INTO audit_log
        (id, actor_user_id, actor_profile_id, action, target_type, target_id, metadata_json, created_at)
      VALUES
        ('audit-fixture', 'user-fixture', 'profile-fixture', 'fixture.created', 'fixture',
         'fixture-target', '{"safe":true}', '2025-01-07T00:00:00.000Z');
    `);

    if (version >= 7) {
      sqlite.exec(`
        UPDATE sessions SET active_profile_id = 'profile-fixture'
        WHERE id = 'session-fixture';
        INSERT INTO requests
          (id, requester_profile_id, media_id, preview_json, status, requested_at)
        VALUES
          ('request-fixture', 'profile-fixture', 'tt-request',
           '{"id":"tt-request","title":"Requested Fixture"}', 'pending',
           '2025-01-08T00:00:00.000Z');
      `);
    }
  } finally {
    sqlite.close();
  }
}
