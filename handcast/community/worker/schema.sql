-- HANDCAST "Hall of Hands" D1 schema. Idempotent: safe to run on every deploy.
-- Timestamps are epoch milliseconds. Device ids and IPs are only ever stored
-- as salted SHA-256 hashes (the Worker refuses writes without HASH_SALT);
-- IPs are reduced to their network first (IPv4 address or /24, IPv6 /64 or /48).

CREATE TABLE IF NOT EXISTS levels (
  id          TEXT PRIMARY KEY,           -- content id ('u' + 13 base36 chars)
  code        TEXT NOT NULL,              -- canonical share code (anonymised solution included)
  name        TEXT NOT NULL,              -- generated title
  author      TEXT NOT NULL,              -- generated handle
  device_hash TEXT NOT NULL,
  crystals    INTEGER NOT NULL,
  budget      INTEGER NOT NULL,
  likes       INTEGER NOT NULL DEFAULT 0,
  solves      INTEGER NOT NULL DEFAULT 0,
  reports     INTEGER NOT NULL DEFAULT 0,
  featured    INTEGER NOT NULL DEFAULT 0, -- curated by the owner: UPDATE levels SET featured = 1 WHERE id = ...
  hidden      INTEGER NOT NULL DEFAULT 0, -- set after reports from 3+ distinct networks (never on featured levels)
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS levels_new ON levels (hidden, created_at DESC);
CREATE INDEX IF NOT EXISTS levels_top ON levels (hidden, likes DESC, solves DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS levels_featured ON levels (featured, hidden, created_at DESC);
CREATE INDEX IF NOT EXISTS levels_device ON levels (device_hash, created_at);

CREATE TABLE IF NOT EXISTS solutions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  level_id    TEXT NOT NULL REFERENCES levels (id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,              -- hand-shape fingerprint (open ports + quantised finger headings)
  n_casts     INTEGER NOT NULL,
  casts       TEXT NOT NULL,              -- JSON array of anonymised cast codes
  created_at  INTEGER NOT NULL,
  UNIQUE (level_id, device_hash, fingerprint)
);
CREATE INDEX IF NOT EXISTS solutions_level ON solutions (level_id, created_at DESC);
CREATE INDEX IF NOT EXISTS solutions_level_fp ON solutions (level_id, fingerprint);
CREATE INDEX IF NOT EXISTS solutions_level_device ON solutions (level_id, device_hash, id);
CREATE INDEX IF NOT EXISTS solutions_created ON solutions (created_at);

CREATE TABLE IF NOT EXISTS likes (
  level_id    TEXT NOT NULL REFERENCES levels (id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  ip_hash     TEXT NOT NULL DEFAULT '',   -- network of the liker (at most 3 likes per level per network)
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (level_id, device_hash)
);
CREATE INDEX IF NOT EXISTS likes_created ON likes (created_at);
CREATE INDEX IF NOT EXISTS likes_level_ip ON likes (level_id, ip_hash);

CREATE TABLE IF NOT EXISTS reports (
  level_id    TEXT NOT NULL REFERENCES levels (id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  net_hash    TEXT NOT NULL DEFAULT '',   -- wider network of the reporter (IPv4 /24, IPv6 /48)
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (level_id, device_hash)
);

-- Fixed-window write counters for rate limiting (rows older than 2 h are pruned by the cron trigger).
CREATE TABLE IF NOT EXISTS rate (
  key TEXT NOT NULL,
  win INTEGER NOT NULL,
  n   INTEGER NOT NULL,
  PRIMARY KEY (key, win)
);
