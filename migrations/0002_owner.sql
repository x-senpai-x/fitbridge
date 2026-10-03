-- Additive: preserves existing health data and OAuth grants.
CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  credential TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  ingest_secret TEXT NOT NULL,
  timezone TEXT NOT NULL,
  primary_source TEXT NOT NULL,
  birth_year TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('setup', 'login', 'recover')),
  challenge TEXT NOT NULL,
  origin TEXT NOT NULL,
  recovery_hash TEXT,
  expires_ms INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE owner_sessions (
  token_hash TEXT PRIMARY KEY,
  owner_version INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE auth_attempts (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL
) WITHOUT ROWID;
