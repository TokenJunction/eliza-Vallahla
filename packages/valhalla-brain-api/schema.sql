CREATE TABLE IF NOT EXISTS api_keys (
  key_hash TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_daily (
  key_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL,
  PRIMARY KEY (key_hash, day)
);
