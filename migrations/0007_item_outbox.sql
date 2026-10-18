-- ITEM_ANALYSIS_BACKEND=inngest 전환용 durable item 이벤트 outbox.
-- jobs 테이블이 실행 상태(queued/leased/failed)를 계속 소유하고, 이 표는
-- D1 커밋과 Inngest 이벤트 발행 사이 장애 복구만 담당한다(report_outbox 와 같은 계약).
CREATE TABLE IF NOT EXISTS item_outbox (
	entity_id TEXT NOT NULL REFERENCES entities(id),
	generation INTEGER NOT NULL,
	job_id TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','publishing','sent')),
	attempts INTEGER NOT NULL DEFAULT 0,
	lease_token TEXT,
	lease_until TEXT,
	last_error TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY(entity_id,generation)
);
CREATE INDEX IF NOT EXISTS item_outbox_publish ON item_outbox(state,lease_until,created_at);
