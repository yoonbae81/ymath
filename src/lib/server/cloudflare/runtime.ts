import { claimJob, heartbeatJob, cloudItemBackend, hostedItemPipeline, runnerClaimableKind, type ClaimedJob, type D1DatabaseLike, type D1Statement } from './jobs';
import { acceptItem, markViewed, saveFeedback, setFavorite } from './repository';
import { batonDefaultProvider } from './baton-catalog';
import { formatPeriodLabel, isItemInPeriod, isPastMonthPeriod, type ItemRecord, type ReportRecord, type Workbook } from '$lib/types';
import { cloudReportBackend } from './report-outbox';
import { requireS3Store, type S3Store } from './s3-store';

export { markViewed, saveFeedback, setFavorite };
export { cloudItemBackend, runnerClaimableKind } from './jobs';

export interface CloudflareEnv { DB: D1DatabaseLike & { batch<T = unknown>(statements: D1Statement[]): Promise<T[]> }; S3: S3Store; WORKBOOKS_JSON?: string; TAXONOMY_JSON?: string; RUNNER_TOKEN?: string; TEST_ONLY_FIXTURES?: string; REPORT_BACKEND?: string; REPORT_INNGEST_EXECUTION_ENABLED?: string; ITEM_ANALYSIS_BACKEND?: string; OCR_MODEL?: string; STUDENT_NAME?: string; SYNTHETIC_SUBMIT_ENABLED?: string; INNGEST_EVENT_KEY?: string; INNGEST_SIGNING_KEY?: string; OMLX_API_KEY?: string; OMLX_BASE_URL?: string; OMLX_MODEL?: string; S3_ENDPOINT?: string; S3_BUCKET?: string; S3_REGION?: string; S3_ACCESS_KEY_ID?: string; S3_SECRET_ACCESS_KEY?: string }
export class CloudStorageError extends Error { constructor(message: string) { super(message); this.name = 'CloudStorageError'; } }

/** S3-only storage: every object path resolves the shared store up front and fails
 * closed when S3_* configuration is missing (no legacy binding fallback). */
export function resolveS3(env: CloudflareEnv): S3Store {
	const configured = env as unknown as Partial<S3Store> & CloudflareEnv;
	if (configured.S3) return configured.S3 as S3Store;
	return requireS3Store(env);
}

/** A failed D1 response can be delivered after the transaction committed. Only
 * remove a staging object after an authoritative reference check proves it unused. */
async function deleteStagedIfUnreferenced(env: CloudflareEnv, keys: string[]) {
	for (const key of new Set(keys)) {
		let used: { used: number } | null;
		try {
			used = await env.DB.prepare(`SELECT 1 AS used FROM entities WHERE deleted_at IS NULL AND (image_key=? OR report_key=? OR ocr_key=? OR raw_key=?)
				UNION ALL SELECT 1 AS used FROM analyses WHERE analysis_key=?
				UNION ALL SELECT 1 AS used FROM jobs WHERE result_key=?`).bind(key,key,key,key,key,key).first<{ used: number }>();
		} catch { continue; }
		if (!used) await resolveS3(env).delete(key).catch(() => undefined);
	}
}

export function workbooksFromEnv(value?: string): Workbook[] {
	if (!value) return [];
	const parsed = JSON.parse(value) as { workbooks?: Workbook[] };
	return Array.isArray(parsed.workbooks) ? parsed.workbooks : [];
}

export function hasImageMagicBytes(buf: Uint8Array): boolean {
	if (buf.length < 12) return false;
	return (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ||
		(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 13 && buf[5] === 10 && buf[6] === 26 && buf[7] === 10) ||
		(buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) ||
		(buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0) ||
		(buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0 && buf[3] === 0x2a);
}

export async function acceptCloudItem(env: CloudflareEnv, workbook: Workbook, raw: Uint8Array, idempotencyKey: string) {
	if (!idempotencyKey || idempotencyKey.length > 128) throw new Error('invalid idempotency key');
	const nonce = crypto.randomUUID();
	const rawKey = `items/raw/${nonce}`;
	const s3 = resolveS3(env);
	await s3.put(rawKey, raw, 'application/octet-stream');
	const outboxJobId = hostedItemPipeline(env) ? crypto.randomUUID() : undefined;
	try {
		const accepted = await acceptItem(env.DB, { workbook, imageKey: '', rawKey, idempotencyKey, provider: batonDefaultProvider, outboxJobId });
		if (!accepted.created) await s3.delete(rawKey);
		return accepted;
	} catch (e) {
		await s3.delete(rawKey).catch(() => undefined);
		throw e;
	}
}

export async function readBoundedRequest(request: Request, limit: number): Promise<Uint8Array> {
	const declared = Number(request.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > limit) throw new RangeError('upload too large');
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			throw new RangeError('upload too large');
		}
		chunks.push(value);
	}
	const out = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
	return out;
}

export async function cloudItem(env: CloudflareEnv, id: string): Promise<ItemRecord | null> {
	const row = await env.DB.prepare("SELECT record_json,favorite,viewed_at FROM entities WHERE id = ? AND kind = 'item' AND deleted_at IS NULL").bind(id).first<{ record_json: string; favorite: number; viewed_at: string | null }>();
	if (!row) return null;
	const record = JSON.parse(row.record_json) as ItemRecord;
	record.favorite = Boolean(row.favorite);
	record.viewed_at = row.viewed_at ?? undefined;
	const feedback = await env.DB.prepare('SELECT payload_json FROM feedback WHERE entity_id = ? ORDER BY updated_at').bind(id).all<{ payload_json: string }>();
	record.feedback = (feedback.results ?? []).filter((f) => typeof f.payload_json === 'string').map((f) => JSON.parse(f.payload_json));
	return record;
}

export async function cloudItems(env: CloudflareEnv): Promise<ItemRecord[]> {
	const result = await env.DB.prepare(`SELECT e.id,e.record_json,e.favorite,e.viewed_at,
		COALESCE(json_group_array(f.payload_json) FILTER (WHERE f.payload_json IS NOT NULL),'[]') AS feedback_json
		FROM entities e LEFT JOIN feedback f ON f.entity_id=e.id WHERE e.kind='item' AND e.deleted_at IS NULL
		GROUP BY e.id ORDER BY e.created_at DESC`).all<{ id: string; record_json: string; favorite: number; viewed_at: string | null; feedback_json: string }>();
	return (result.results ?? []).map((row) => {
		const record = JSON.parse(row.record_json) as ItemRecord;
		record.favorite = Boolean(row.favorite); record.viewed_at = row.viewed_at ?? undefined;
		record.feedback = (JSON.parse(row.feedback_json ?? '[]') as string[]).map((value) => JSON.parse(value));
		return record;
	});
}

export async function claimCloudJob(env: CloudflareEnv, runner: string, now = new Date().toISOString()) {
	// ITEM_ANALYSIS_BACKEND/REPORT_BACKEND 스위치로 runner 와 Inngest 의 이중실행을 막는다.
	const owns = runnerClaimableKind(env);
	if (!owns) return null;
	const job = await claimJob(env.DB, runner, now, 120, owns === 'both' ? undefined : owns);
	if (!job) return null;
	if (job.kind === 'report') {
		if (!(await updateCloudJobStage(env, job, job.lease_token, 'generating', now))) return null;
		const report = await cloudReport(env, job.entity_id);
		if (!report) return { ...job, report: null, records: [] };
		// The durable claim already incremented jobs.attempts; generator increments the snapshot once on success.
		report.attempts = Math.max(0, report.attempts - 1);
		const records = (await cloudItems(env)).filter((record) => record.status === 'done' && record.analysis?.classification.topic === report.topic);
		return { ...job, report, records };
	}
	if (job.kind === 'item') await updateCloudJobStage(env, job, job.lease_token, 'ocr', now);
	const entity = await env.DB.prepare('SELECT raw_key, image_key, record_json, ocr_key FROM entities WHERE id = ? AND deleted_at IS NULL').bind(job.entity_id).first<{ raw_key: string | null; image_key: string | null; record_json: string; ocr_key: string | null }>();
	if (!entity || job.kind !== 'item') return { ...job, entity: null };
	const record = JSON.parse(entity.record_json) as ItemRecord;
	record.requested_provider = 'omlx';
	const feedback = await env.DB.prepare('SELECT payload_json FROM feedback WHERE entity_id = ? ORDER BY updated_at').bind(job.entity_id).all<{ payload_json: string }>();
	record.feedback = (feedback.results ?? []).map((entry) => JSON.parse(entry.payload_json));
	const patterns = await env.DB.prepare(`SELECT json_extract(record_json,'$.analysis.error_analysis.error_pattern_id') AS id, COUNT(*) AS count,
		MIN(json_extract(record_json,'$.analysis.error_analysis.misconception')) AS example FROM entities WHERE kind='item' AND status='done' AND deleted_at IS NULL
		AND json_extract(record_json,'$.analysis.error_analysis.error_pattern_id') IS NOT NULL
		AND json_extract(record_json,'$.analysis.error_analysis.error_pattern_id') != 'unconfirmed'
		GROUP BY id ORDER BY count DESC LIMIT 60`).all<{ id: string; count: number; example: string }>();
	let ocrText: string | null = null;
	if (entity.ocr_key) {
		const bytes = await resolveS3(env).get(entity.ocr_key);
		// OCR text is capped at 1,000,000 characters (legacy stream cap preserved).
		if (bytes && bytes.byteLength <= 1_000_000) ocrText = new TextDecoder().decode(bytes);
	}
	return { ...job, entity: record, knownPatterns: patterns.results ?? [], rawAvailable: Boolean(entity.raw_key || entity.image_key), normalizedImage: Boolean(entity.image_key), ocrText };
}

export async function heartbeatCloudJob(env: CloudflareEnv, job: ClaimedJob, token: string, now = new Date().toISOString()) {
	return heartbeatJob(env.DB, job, token, now, 120);
}

export async function failCloudJob(env: CloudflareEnv, job: ClaimedJob, token: string, message: string, delaySeconds: number, now = new Date().toISOString()) {
	const retry = Math.max(1, Math.min(3600, Math.floor(delaySeconds)));
	const raw = job.kind === 'item' ? await env.DB.prepare('SELECT raw_key FROM entities WHERE id=? AND generation=? AND deleted_at IS NULL').bind(job.entity_id,job.entity_generation).first<{ raw_key: string | null }>() : null;
	const finalState = "CASE WHEN (SELECT state FROM jobs WHERE id=? AND updated_at=?)='failed' THEN 'failed' ELSE 'queued' END";
	const entityStatusUpdate = job.kind === 'report'
		? `UPDATE entities SET status=${finalState},updated_at=?,report_json=json_set(report_json,'$.status',${finalState},'$.error',?) WHERE id=? AND deleted_at IS NULL AND generation=? AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND entity_generation=? AND state IN ('queued','failed') AND updated_at=?)`
		: `UPDATE entities SET status=${finalState},updated_at=?,raw_key=CASE WHEN (SELECT state FROM jobs WHERE id=? AND updated_at=?)='failed' THEN NULL ELSE raw_key END,record_json=json_set(record_json,'$.status',${finalState},'$.error',?) WHERE id=? AND deleted_at IS NULL AND generation=? AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND entity_generation=? AND state IN ('queued','failed') AND updated_at=?)`;
	const out = await env.DB.batch([
		env.DB.prepare(`UPDATE jobs SET state=CASE WHEN attempts >= 5 THEN 'failed' ELSE 'queued' END,
			retry_at=CASE WHEN attempts >= 5 THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || ? || ' seconds') END,
			last_error=?,lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=?
			WHERE id=? AND state='leased' AND generation=? AND lease_token=? AND lease_until > ?
			AND EXISTS (SELECT 1 FROM entities e WHERE e.id=jobs.entity_id AND e.deleted_at IS NULL AND e.generation=jobs.entity_generation)`)
			.bind(now,retry,message.slice(0,1000),now,job.id,job.generation,token,now),
		env.DB.prepare(entityStatusUpdate)
			.bind(job.id,now,now,...(job.kind === 'item' ? [job.id,now] : []),job.id,now,message.slice(0,1000),job.entity_id,job.entity_generation,job.id,job.entity_generation,now)
	]);
	const ok = ((out[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0) === 1;
	if (ok && job.kind === 'item' && raw?.raw_key) {
		const terminal = await env.DB.prepare("SELECT 1 AS done FROM jobs WHERE id=? AND state='failed' AND updated_at=?").bind(job.id,now).first<{ done: number }>();
		if (terminal) await resolveS3(env).delete(raw.raw_key).catch(() => undefined);
	}
	return ok;
}

export async function updateCloudJobStage(env: CloudflareEnv, job: ClaimedJob, token: string, stage: 'ocr' | 'analyzing' | 'generating', now = new Date().toISOString()) {
	if (job.kind === 'report') {
		if (stage !== 'generating') return false;
		const result = await env.DB.prepare(`UPDATE entities SET status='generating',updated_at=?,report_json=json_set(report_json,'$.status','generating','$.attempts',
			(SELECT attempts FROM jobs WHERE id=?)) WHERE id=? AND kind='report' AND deleted_at IS NULL AND generation=? AND EXISTS
			(SELECT 1 FROM jobs WHERE id=? AND entity_id=? AND entity_generation=? AND state='leased' AND generation=? AND lease_token=? AND lease_until > ?)`)
			.bind(now,job.id,job.entity_id,job.entity_generation,job.id,job.entity_id,job.entity_generation,job.generation,token,now).run();
		return (result.meta?.changes ?? 0) === 1;
	}
	if (stage === 'generating') return false;
	const result = await env.DB.prepare(`UPDATE entities SET status=?,updated_at=?,record_json=json_set(record_json,'$.status',?,'$.attempts',
		(SELECT attempts FROM jobs WHERE id=?)) WHERE id=? AND deleted_at IS NULL AND generation=? AND EXISTS
		(SELECT 1 FROM jobs WHERE id=? AND entity_id=? AND entity_generation=? AND state='leased' AND generation=? AND lease_token=? AND lease_until > ?)`)
		.bind(stage,now,stage,job.id,job.entity_id,job.entity_generation,job.id,job.entity_id,job.entity_generation,job.generation,token,now).run();
	return (result.meta?.changes ?? 0) === 1;
}

export async function readClaimedRaw(env: CloudflareEnv, jobId: string, token: string) {
	const row = await env.DB.prepare(`SELECT COALESCE(e.raw_key,e.image_key) AS raw_key FROM jobs j JOIN entities e ON e.id = j.entity_id
		WHERE j.id = ? AND j.state = 'leased' AND j.lease_token = ? AND j.lease_until > ? AND e.deleted_at IS NULL AND e.generation = j.entity_generation`)
		.bind(jobId, token, new Date().toISOString()).first<{ raw_key: string | null }>();
	if (!row?.raw_key) return null;
	const bytes = await resolveS3(env).get(row.raw_key);
	return bytes ? new Response(bytes as BodyInit) : null;
}

/** Persist the normalized JPEG before any fallible OCR/analysis work. The key is stable
 * for this entity generation, so a retry can reuse exactly the same JPEG bytes. */
export async function persistCloudNormalizedImage(env: CloudflareEnv, job: ClaimedJob, token: string, jpeg: Uint8Array) {
	if (job.kind !== 'item') return false;
	const now = new Date().toISOString();
	const current = await env.DB.prepare(`SELECT e.image_key,e.raw_key FROM entities e JOIN jobs j ON j.entity_id=e.id
		WHERE e.id=? AND e.kind='item' AND e.deleted_at IS NULL AND e.generation=j.entity_generation
		AND j.id=? AND j.state='leased' AND j.generation=? AND j.lease_token=? AND j.lease_until > ?`)
		.bind(job.entity_id,job.id,job.generation,token,now).first<{ image_key: string | null; raw_key: string | null }>();
	if (!current) return false;
	if (current.image_key) return true;
	const key = `items/${job.entity_id}/normalized-${job.entity_generation}.jpg`;
	await resolveS3(env).put(key,jpeg,'image/jpeg');
	try {
		const saved = await env.DB.prepare(`UPDATE entities SET image_key=?,raw_key=NULL,updated_at=? WHERE id=? AND kind='item' AND (image_key IS NULL OR image_key='')
			AND deleted_at IS NULL AND generation=? AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND entity_id=entities.id AND state='leased'
			AND generation=? AND lease_token=? AND entity_generation=entities.generation AND lease_until > ?)`)
			.bind(key,now,job.entity_id,job.entity_generation,job.id,job.generation,token,now).run();
		if ((saved.meta?.changes ?? 0) !== 1) {
			const refs = await env.DB.prepare('SELECT 1 AS used FROM entities WHERE image_key=? AND deleted_at IS NULL').bind(key).first<{ used: number }>();
			if (!refs) await resolveS3(env).delete(key).catch(() => undefined);
			return Boolean(refs);
		}
	} catch (cause) {
		// D1 may report a transport failure after committing. Verify before considering cleanup.
		let refs: { used: number } | null;
		try { refs = await env.DB.prepare('SELECT 1 AS used FROM entities WHERE image_key=? AND deleted_at IS NULL').bind(key).first<{ used: number }>(); }
		catch { throw cause; }
		if (refs) return true;
		await resolveS3(env).delete(key).catch(() => undefined);
		throw cause;
	}
	if (current.raw_key) {
		const stillRaw = await env.DB.prepare('SELECT raw_key FROM entities WHERE id=? AND deleted_at IS NULL').bind(job.entity_id).first<{ raw_key: string | null }>();
		if (stillRaw?.raw_key !== current.raw_key) await resolveS3(env).delete(current.raw_key).catch(() => undefined);
	}
	return true;
}

export async function queueCloudReanalysis(env: CloudflareEnv, id: string, provider?: string) {
	const now = new Date().toISOString();
	const selectedProvider = provider ?? batonDefaultProvider;
	const outboxJobId = crypto.randomUUID();
	const statements = await env.DB.batch([
		env.DB.prepare(`UPDATE entities SET status='queued', generation=generation+1, updated_at=?,
		record_json=json_set(record_json,'$.status','queued','$.error',NULL,'$.attempts',0,'$.requested_provider',?)
		WHERE id=? AND kind='item' AND deleted_at IS NULL AND status IN ('done','failed')`).bind(now, selectedProvider, id),
		env.DB.prepare(`INSERT INTO jobs (id,entity_id,kind,entity_generation,state,provider,payload,created_at,updated_at)
		SELECT ?,id,'item',generation,'queued',?,'{}',?,? FROM entities e
		WHERE id=? AND status='queued' AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.entity_id=e.id AND j.state IN ('queued','leased'))`)
		.bind(outboxJobId, selectedProvider, now, now, id),
		...(hostedItemPipeline(env) ? [env.DB.prepare(`INSERT INTO item_outbox (entity_id,generation,job_id,state,attempts,created_at,updated_at)
		SELECT id,generation,?,'pending',0,?,? FROM entities e
		WHERE id=? AND status='queued' AND deleted_at IS NULL AND generation=e.generation
		AND NOT EXISTS (SELECT 1 FROM item_outbox o WHERE o.entity_id=e.id AND o.generation=e.generation)`).bind(outboxJobId, now, now, id)] : [])
	]);
	return ((statements[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0) === 1 && ((statements[1] as { meta?: { changes?: number } })?.meta?.changes ?? 0) === 1;
}

export async function commitCloudResult(env: CloudflareEnv, job: ClaimedJob, token: string, jpeg: Uint8Array, analysis: unknown, meta: { provider: string; model: string; prompt_version: string; analyzed_at: string }, flags: ItemRecord['flags'], ocrText = '') {
	const commitNow = new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z') as string;
	const record = await cloudItem(env, job.entity_id);
	if (!record) return false;
	const lease = await env.DB.prepare("SELECT 1 AS ok FROM jobs WHERE id=? AND state='leased' AND generation=? AND lease_token=? AND entity_generation=? AND lease_until > ?")
		.bind(job.id, job.generation, token, job.entity_generation, commitNow).first<{ ok: number }>();
	if (!lease) return false;

	const saved: ItemRecord = { ...record, status: 'done', error: null, analysis: analysis as ItemRecord['analysis'], flags, meta: meta as ItemRecord['meta'] };
	const imageKey = `items/${job.entity_id}/analysis-${meta.provider}-${job.id}-${job.generation}-${crypto.randomUUID()}.jpg`;
	const analysisKey = `${imageKey}.json`;
	const oldObjects = await env.DB.prepare('SELECT image_key,raw_key,ocr_key FROM entities WHERE id = ?').bind(job.entity_id).first<{ image_key: string | null; raw_key: string | null; ocr_key: string | null }>();
	const ocrKey = ocrText.trim() ? `items/${job.entity_id}/ocr-${job.id}-${job.generation}-${crypto.randomUUID()}.txt` : oldObjects?.ocr_key ?? null;
	const oldAnalysis = await env.DB.prepare('SELECT analysis_key FROM analyses WHERE entity_id=? AND provider=?').bind(job.entity_id,meta.provider).first<{ analysis_key: string }>();
	const staged = [imageKey,analysisKey,...(ocrText.trim() ? [ocrKey!] : [])];
	try {
		const s3 = resolveS3(env);
		await s3.put(imageKey, jpeg, 'image/jpeg');
		await s3.put(analysisKey, new TextEncoder().encode(JSON.stringify({ analysis, meta, flags })), 'application/json');
		if (ocrText.trim()) await s3.put(ocrKey!, new TextEncoder().encode(ocrText), 'text/plain; charset=utf-8');
	} catch (cause) {
		await deleteStagedIfUnreferenced(env, staged);
		throw cause;
	}
	let out: unknown[];
	try { out = await env.DB.batch([
		env.DB.prepare(`UPDATE entities SET record_json = ?, image_key = ?, raw_key = NULL, ocr_key = ?, status = 'done', updated_at = ?, current_analysis_key = ?
			WHERE id = ? AND kind = 'item' AND generation = ? AND deleted_at IS NULL AND EXISTS (
			 SELECT 1 FROM jobs WHERE id = ? AND entity_id = entities.id AND state = 'leased' AND generation = ? AND lease_token = ? AND entity_generation = entities.generation AND lease_until > ?)`).bind(
				JSON.stringify(saved), imageKey, ocrKey, meta.analyzed_at, analysisKey, job.entity_id, job.entity_generation, job.id, job.generation, token, commitNow),
		env.DB.prepare(`UPDATE jobs SET state = 'done', result_key = ?, lease_owner = NULL, lease_token = NULL, lease_until = NULL, updated_at = ?
			WHERE id = ? AND state = 'leased' AND generation = ? AND lease_token = ? AND lease_until > ? AND EXISTS (
			 SELECT 1 FROM entities e WHERE e.id = jobs.entity_id AND e.deleted_at IS NULL AND e.generation = jobs.entity_generation)`)
			.bind(imageKey, meta.analyzed_at, job.id, job.generation, token, commitNow),
		env.DB.prepare(`INSERT INTO analyses (entity_id,provider,generation,analysis_key,meta_json,flags_json,created_at)
			SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM entities WHERE id = ? AND status = 'done' AND image_key = ?)
			ON CONFLICT(entity_id,provider) DO UPDATE SET generation = excluded.generation, analysis_key = excluded.analysis_key, meta_json = excluded.meta_json, flags_json = excluded.flags_json, created_at = excluded.created_at`)
			.bind(job.entity_id, meta.provider, job.entity_generation, analysisKey, JSON.stringify(meta), JSON.stringify(flags), meta.analyzed_at, job.entity_id, imageKey)
	]); } catch (cause) {
		await deleteStagedIfUnreferenced(env, staged);
		throw cause;
	}
	if (!((out[0] as { meta?: { changes?: number } })?.meta?.changes && (out[1] as { meta?: { changes?: number } })?.meta?.changes)) {
		await deleteStagedIfUnreferenced(env, staged);
		return false;
	}
	const obsolete = new Set([oldObjects?.image_key,oldObjects?.raw_key,oldObjects?.ocr_key,oldAnalysis?.analysis_key].filter((key): key is string => Boolean(key) && key !== imageKey && key !== analysisKey && key !== ocrKey));
	await Promise.all([...obsolete].map((key) => resolveS3(env).delete(key).catch(() => undefined)));
	return true;
}

export async function cloudAnalyses(env: CloudflareEnv, id: string) {
	const rows = await env.DB.prepare('SELECT analysis_key,meta_json,flags_json FROM analyses WHERE entity_id = ? ORDER BY created_at').bind(id).all<{ analysis_key: string; meta_json: string; flags_json: string }>();
	return Promise.all((rows.results ?? []).map(async (row) => {
		const bytes = await resolveS3(env).get(row.analysis_key);
		if (!bytes) throw new CloudStorageError(`analysis artifact missing for ${id}`);
		let value: { analysis: unknown; meta: unknown; flags: unknown };
		try { value = JSON.parse(new TextDecoder().decode(bytes)) as typeof value; }
		catch (cause) { throw new CloudStorageError(`analysis artifact corrupt for ${id}: ${cause instanceof Error ? cause.message : String(cause)}`); }
		if (!value || typeof value !== 'object' || !('analysis' in value) || !('meta' in value) || !('flags' in value)) throw new CloudStorageError(`analysis artifact corrupt for ${id}: required fields missing`);
		return value;
	}));
}

const validReportId = (id: string) => /^\d{8}-\d{6}-rep-[a-z0-9]{4}$/.test(id);
async function fingerprintItems(items: ItemRecord[]) {
	const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
	const payload = sorted.map((item) => `${item.id}:${item.meta?.analyzed_at ?? item.created_at}`).join('|');
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(payload)));
	return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 12);
}
// The original Node report queue uses Asia/Seoul local calendar days; Workers use UTC.
const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;
const seoulItemDate = (iso: string) => new Date(new Date(iso).getTime() + SEOUL_OFFSET_MS).toISOString();
function reportMetadata(row: { report_json: string | null }): ReportRecord | null {
	if (!row.report_json) return null;
	try { return JSON.parse(row.report_json) as ReportRecord; } catch { return null; }
}

export async function cloudReport(env: CloudflareEnv, id: string): Promise<ReportRecord | null> {
	if (!validReportId(id)) return null;
	const row = await env.DB.prepare("SELECT report_json,report_key FROM entities WHERE id=? AND kind='report' AND deleted_at IS NULL")
		.bind(id).first<{ report_json: string | null; report_key: string | null }>();
	const report = reportMetadata(row ?? { report_json: null });
	if (!report) return null;
	if (report.status === 'done' && !row?.report_key) throw new CloudStorageError(`completed report ${id} has no artifact reference`);
	if (row?.report_key) report.markdown = await readReportArtifact(env,row.report_key,id);
	return report;
}

async function readReportArtifact(env: CloudflareEnv, key: string, id: string): Promise<string> {
	const bytes = await resolveS3(env).get(key);
	if (!bytes) throw new CloudStorageError(`report artifact missing for ${id}`);
	try {
		const body = JSON.parse(new TextDecoder().decode(bytes)) as { markdown?: unknown };
		if (typeof body.markdown !== 'string') throw new Error('markdown field missing');
		return body.markdown;
	} catch (cause) { throw new CloudStorageError(`report artifact corrupt for ${id}: ${cause instanceof Error ? cause.message : String(cause)}`); }
}

export async function cloudReports(env: CloudflareEnv, includeArtifacts = true): Promise<ReportRecord[]> {
	const result = await env.DB.prepare("SELECT id,report_json,report_key FROM entities WHERE kind='report' AND deleted_at IS NULL ORDER BY created_at DESC")
		.all<{ id: string; report_json: string | null; report_key: string | null }>();
	const rows = result.results ?? [];
	return Promise.all(rows.map(async (row) => {
		const report = reportMetadata(row);
		if (!report) return null;
		if (includeArtifacts && report.status === 'done' && !row.report_key) throw new CloudStorageError(`completed report ${row.id} has no artifact reference`);
		if (includeArtifacts && row.report_key) report.markdown = await readReportArtifact(env,row.report_key,row.id);
		return report;
	})).then((reports) => reports.filter((report): report is ReportRecord => report !== null));
}

export async function createCloudReport(env: CloudflareEnv, topic: string, period: string, force = false, now = new Date()) {
	const records = await cloudItems(env);
	const topicRecords = records.filter((record) => record.status === 'done' && record.analysis?.classification.topic === topic);
	const seoulNow = new Date(now.getTime() + SEOUL_OFFSET_MS);
	const targets = topicRecords.filter((record) => isItemInPeriod(seoulItemDate(record.created_at), period, seoulNow));
	if (!targets.length) throw new Error(`'${topic}' 영역의 해당 기간(${formatPeriodLabel(period, seoulNow)})에 분석 완료된 오답이 없습니다.`);
	const fingerprint = await fingerprintItems(targets);
	if (!force) {
		const done = (await cloudReports(env, false)).filter((report) => report.topic === topic && report.period === period && report.status === 'done');
		const cached = isPastMonthPeriod(period, seoulNow) ? done[0] : done.find((report) => report.items_fingerprint === fingerprint);
		if (cached) return { report: await cloudReport(env, cached.id) ?? cached, cached: true };
	}
	const p = (value: number, width = 2) => String(value).padStart(width, '0');
	const id = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}-rep-${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
	const createdAt = now.toISOString();
	const report: ReportRecord = { schema_version: 1, id, created_at: createdAt, topic, period, period_label: formatPeriodLabel(period, seoulNow), status: 'queued', error: null, attempts: 0, item_ids: targets.map((record) => record.id), items_fingerprint: fingerprint, summary: null, markdown: null, meta: null };
	const provider = 'omlx';
	const statements = [
		env.DB.prepare("INSERT INTO entities(id,kind,created_at,status,generation,report_json,updated_at) VALUES(?,'report',?,'queued',1,?,?)")
			.bind(id,createdAt,JSON.stringify(report),createdAt)
	];
	if (cloudReportBackend(env) === 'inngest') {
		statements.push(env.DB.prepare("INSERT INTO report_outbox(report_id,generation,state,attempts,created_at,updated_at) VALUES(?,1,'pending',0,?,?)").bind(id,createdAt,createdAt));
	} else {
		statements.push(env.DB.prepare("INSERT INTO jobs(id,entity_id,kind,entity_generation,state,provider,payload,created_at,updated_at) VALUES(?,?,'report',1,'queued',?,'{}',?,?)")
			.bind(crypto.randomUUID(),id,provider,createdAt,createdAt));
	}
	await env.DB.batch(statements);
	return { report, cached: false };
}

export async function retryCloudReport(env: CloudflareEnv, id: string) {
	const current = await cloudReport(env, id);
	if (!current) return null;
	if (current.status !== 'done' && current.status !== 'failed') return false;
	const now = new Date().toISOString();
	const old = await env.DB.prepare("SELECT report_key FROM entities WHERE id=? AND kind='report' AND deleted_at IS NULL").bind(id).first<{report_key:string|null}>();
	const next: ReportRecord = { ...current, status: 'queued', error: null, attempts: 0, markdown: null };
	const statements = [
		env.DB.prepare("UPDATE entities SET status='queued',generation=generation+1,report_owner=NULL,report_content_hash=NULL,report_key=NULL,report_json=?,updated_at=? WHERE id=? AND kind='report' AND deleted_at IS NULL AND status IN ('done','failed')")
			.bind(JSON.stringify(next),now,id)
	];
	if (cloudReportBackend(env) === 'inngest') {
		statements.push(env.DB.prepare("INSERT INTO report_outbox(report_id,generation,state,attempts,created_at,updated_at) SELECT id,generation,'pending',0,?,? FROM entities WHERE id=? AND status='queued' AND deleted_at IS NULL")
			.bind(now,now,id));
	} else {
		statements.push(env.DB.prepare("INSERT INTO jobs(id,entity_id,kind,entity_generation,state,provider,payload,created_at,updated_at) SELECT ?,id,'report',generation,'queued',?,'{}',?,? FROM entities WHERE id=? AND status='queued' AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM jobs active WHERE active.entity_id=entities.id AND active.state IN ('queued','leased'))")
			.bind(crypto.randomUUID(),'omlx',now,now,id));
	}
	const result = await env.DB.batch(statements);
	const changed = ((result[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0) === 1;
	if (changed && old?.report_key) await deleteStagedIfUnreferenced(env,[old.report_key]);
	return changed;
}

export async function deleteCloudReport(env: CloudflareEnv, id: string) {
	if (!validReportId(id)) return false;
	const old = await env.DB.prepare("SELECT report_key FROM entities WHERE id=? AND kind='report' AND deleted_at IS NULL").bind(id).first<{ report_key: string | null }>();
	if (!old) return false;
	const now = new Date().toISOString();
	const result = await env.DB.batch([
		env.DB.prepare('UPDATE entities SET deleted_at=?,generation=generation+1,updated_at=? WHERE id=? AND kind=\'report\' AND deleted_at IS NULL').bind(now,now,id),
		env.DB.prepare("UPDATE jobs SET state='cancelled',lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE entity_id=? AND state IN ('queued','leased')").bind(now,id)
	]);
	if (((result[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0) !== 1) return false;
	if (old.report_key) await resolveS3(env).delete(old.report_key).catch(() => undefined);
	return true;
}

export async function commitCloudReportResult(env: CloudflareEnv, job: ClaimedJob, token: string, report: ReportRecord) {
	if (job.kind !== 'report' || report.id !== job.entity_id || report.status !== 'done') return false;
	const now = new Date().toISOString();
	const artifactKey = `reports/${report.id}/result-${job.id}-${job.generation}-${crypto.randomUUID()}.json`;
	const old = await env.DB.prepare('SELECT report_key FROM entities WHERE id=? AND kind=\'report\' AND generation=? AND deleted_at IS NULL').bind(report.id,job.entity_generation).first<{ report_key: string | null }>();
	try { await resolveS3(env).put(artifactKey, new TextEncoder().encode(JSON.stringify({ markdown: report.markdown })), 'application/json'); }
	catch (cause) { await deleteStagedIfUnreferenced(env,[artifactKey]); throw cause; }
	const metadata = { ...report, markdown: null };
	let result: unknown[];
	try { result = await env.DB.batch([
		env.DB.prepare(`UPDATE entities SET status='done',report_key=?,report_json=?,updated_at=? WHERE id=? AND kind='report' AND deleted_at IS NULL AND generation=? AND EXISTS
			(SELECT 1 FROM jobs WHERE id=? AND entity_id=entities.id AND state='leased' AND generation=? AND lease_token=? AND entity_generation=entities.generation AND lease_until > ?)`)
			.bind(artifactKey,JSON.stringify(metadata),report.meta?.generated_at ?? now,report.id,job.entity_generation,job.id,job.generation,token,now),
		env.DB.prepare(`UPDATE jobs SET state='done',result_key=?,lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state='leased' AND generation=? AND lease_token=? AND lease_until > ? AND EXISTS
			(SELECT 1 FROM entities e WHERE e.id=jobs.entity_id AND e.deleted_at IS NULL AND e.generation=jobs.entity_generation)`)
			.bind(artifactKey,now,job.id,job.generation,token,now)
	]); } catch (cause) {
		await deleteStagedIfUnreferenced(env,[artifactKey]);
		throw cause;
	}
	if (!((result[0] as { meta?: { changes?: number } })?.meta?.changes && (result[1] as { meta?: { changes?: number } })?.meta?.changes)) {
		await deleteStagedIfUnreferenced(env,[artifactKey]);
		return false;
	}
	if (old?.report_key && old.report_key !== artifactKey) await resolveS3(env).delete(old.report_key).catch(() => undefined);
	return true;
}

/** Inngest report commit: generation-fenced D1 pointer swap after the Markdown
 * artifact is safely staged in S3. Immutable keys prevent a losing writer from
 * overwriting a winner; persistent owner and content hash identify save-step replay. */
export async function commitInngestReportResult(env: CloudflareEnv, generation: number, report: ReportRecord, owner: string) {
	if (report.status !== 'done' || typeof report.markdown !== 'string') return false;
	if (!owner) throw new Error('Inngest report run owner is required');
	const hashBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(report.markdown)));
	const contentHash = [...hashBytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	const before = await env.DB.prepare("SELECT report_key,status,report_json,report_content_hash FROM entities WHERE id=? AND kind='report' AND deleted_at IS NULL AND generation=? AND report_owner=?")
		.bind(report.id,generation,owner).first<{ report_key: string | null; status: string; report_json: string | null; report_content_hash: string | null }>();
	if (!before) return false;
	if (before.status === 'done') return Boolean(before.report_key && before.report_content_hash === contentHash);
	if (before.status !== 'generating') return false;
	const key = `reports/${report.id}/result-inngest-${generation}-${crypto.randomUUID()}.json`;
	try {
		await resolveS3(env).put(key,new TextEncoder().encode(JSON.stringify({ markdown: report.markdown })),'application/json');
	} catch (cause) {
		await deleteStagedIfUnreferenced(env,[key]);
		throw cause;
	}
	const metadata = { ...report, markdown: null };
	const now = report.meta?.generated_at ?? new Date().toISOString();
	try {
		const saved = await env.DB.prepare(`UPDATE entities SET status='done',report_key=?,report_content_hash=?,report_json=?,updated_at=?
			WHERE id=? AND kind='report' AND deleted_at IS NULL AND generation=? AND status='generating' AND report_owner=?`)
			.bind(key,contentHash,JSON.stringify(metadata),now,report.id,generation,owner).run();
		if ((saved.meta?.changes ?? 0) !== 1) {
			const current = await env.DB.prepare("SELECT generation,status,report_key,report_json,report_owner,report_content_hash FROM entities WHERE id=? AND kind='report' AND deleted_at IS NULL").bind(report.id)
				.first<{generation:number;status:string;report_key:string|null;report_json:string|null;report_owner:string|null;report_content_hash:string|null}>();
			if (current?.generation === generation && current.status === 'done' && current.report_owner === owner && current.report_content_hash === contentHash && current.report_json &&
				(JSON.parse(current.report_json) as ReportRecord).meta?.generated_at === report.meta?.generated_at) {
				await deleteStagedIfUnreferenced(env,[key]);
				return true;
			}
			await deleteStagedIfUnreferenced(env,[key]);
			return false;
		}
	} catch (cause) {
		let current: {generation:number;status:string;report_key:string|null;report_json:string|null;report_owner:string|null;report_content_hash:string|null} | null;
		try { current = await env.DB.prepare("SELECT generation,status,report_key,report_json,report_owner,report_content_hash FROM entities WHERE id=? AND kind='report' AND deleted_at IS NULL").bind(report.id)
			.first<{generation:number;status:string;report_key:string|null;report_json:string|null;report_owner:string|null;report_content_hash:string|null}>(); }
		catch { throw cause; }
		if (current?.generation === generation && current.status === 'done' && current.report_owner === owner && current.report_key === key && current.report_content_hash === contentHash && current.report_json &&
			(JSON.parse(current.report_json) as ReportRecord).meta?.generated_at === report.meta?.generated_at) {
			await deleteStagedIfUnreferenced(env,[key]);
			return true;
		}
		await deleteStagedIfUnreferenced(env,[key]);
		throw cause;
	}
	if (before.report_key && before.report_key !== key) await resolveS3(env).delete(before.report_key).catch(() => undefined);
	return true;
}
