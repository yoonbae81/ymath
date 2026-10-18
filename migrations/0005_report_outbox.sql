CREATE TABLE IF NOT EXISTS report_outbox (
	report_id TEXT NOT NULL REFERENCES entities(id),
	generation INTEGER NOT NULL,
	state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','publishing','sent')),
	attempts INTEGER NOT NULL DEFAULT 0,
	lease_token TEXT,
	lease_until TEXT,
	last_error TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY(report_id,generation)
);
CREATE INDEX IF NOT EXISTS report_outbox_publish ON report_outbox(state,lease_until,created_at);
