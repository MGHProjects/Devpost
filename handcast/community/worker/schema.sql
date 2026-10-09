-- HANDCAST "Hall of Hands" D1 schema. Idempotent: safe to run on every deploy.
-- Timestamps are epoch milliseconds. Device ids and IPs are only ever stored
-- as salted SHA-256 hashes.

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
  hidden      INTEGER NOT NULL DEFAULT 0, -- set automatically after 3 reports
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
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (level_id, device_hash)
);
CREATE INDEX IF NOT EXISTS likes_created ON likes (created_at);

CREATE TABLE IF NOT EXISTS reports (
  level_id    TEXT NOT NULL REFERENCES levels (id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (level_id, device_hash)
);

-- Fixed-window write counters for rate limiting (rows older than 2 h are pruned).
CREATE TABLE IF NOT EXISTS rate (
  key TEXT NOT NULL,
  win INTEGER NOT NULL,
  n   INTEGER NOT NULL,
  PRIMARY KEY (key, win)
);
