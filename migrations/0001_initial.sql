PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('item','report')),
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  workbook_json TEXT,
  record_json TEXT,
  current_analysis_key TEXT,
  image_key TEXT,
  raw_key TEXT,
  report_json TEXT,
  report_key TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  viewed_at TEXT,
  idempotency_key TEXT UNIQUE,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entities_list ON entities(kind, deleted_at, created_at DESC);
CREATE INDEX IF NOT EXISTS entities_status ON entities(kind, status, updated_at);
CREATE TABLE IF NOT EXISTS analyses (
  entity_id TEXT NOT NULL REFERENCES entities(id), provider TEXT NOT NULL,
  generation INTEGER NOT NULL, analysis_key TEXT NOT NULL, meta_json TEXT NOT NULL,
  flags_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(entity_id, provider)
);
CREATE TABLE IF NOT EXISTS feedback (
  entity_id TEXT NOT NULL REFERENCES entities(id), analyzed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(entity_id, analyzed_at)
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES entities(id),
  kind TEXT NOT NULL CHECK(kind IN ('item','report')),
  entity_generation INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
  provider TEXT, payload TEXT NOT NULL DEFAULT '{}', generation INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, retry_at TEXT,
  lease_owner TEXT, lease_token TEXT, lease_until TEXT,
  result_key TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_claim ON jobs(state, retry_at, created_at);
CREATE INDEX IF NOT EXISTS jobs_entity ON jobs(entity_id, entity_generation);
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL
);
