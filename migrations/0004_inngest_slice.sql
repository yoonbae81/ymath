-- Isolated synthetic Inngest proof-of-path jobs; application entities are untouched.
CREATE TABLE IF NOT EXISTS inngest_slice_jobs (
	id TEXT PRIMARY KEY,
	status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','publish_failed','deleted')),
	generation INTEGER NOT NULL DEFAULT 1,
	attempts INTEGER NOT NULL DEFAULT 0,
	attempt_token TEXT,
	kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','report')),
	input_text TEXT NOT NULL,
	result_text TEXT,
	last_error TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT
);
