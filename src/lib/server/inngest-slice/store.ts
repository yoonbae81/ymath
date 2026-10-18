export interface SliceStatement {
	bind(...values: unknown[]): SliceStatement;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	run(): Promise<{ meta?: { changes?: number } }>;
}
export interface SliceDb { prepare(sql: string): SliceStatement }
export interface SliceJob { id: string; status: string; generation: number; attempt_token?: string; attempts?: number; kind?: 'text'|'report'; input_text: string; result_text: string | null; last_error: string | null }
const now = () => new Date().toISOString();

export function createSliceStore(db: SliceDb) {
	return {
		async create(input: string, kind: 'text'|'report' = 'text') {
			const id = `slc_${crypto.randomUUID()}`;
			const stamp = now();
			await db.prepare("INSERT INTO inngest_slice_jobs(id,status,generation,kind,input_text,created_at,updated_at) VALUES(?,'queued',1,?,?,?,?)").bind(id,kind,input,stamp,stamp).run();
			return id;
		},
		get(id: string) { return db.prepare('SELECT id,status,generation,input_text,result_text,last_error FROM inngest_slice_jobs WHERE id=?').bind(id).first<SliceJob>().then((row) => row ?? { id, status: 'missing', generation: 0, input_text: '', result_text: null, last_error: null }); },
		async markPublishFailed(id: string, reason: string) {
			await db.prepare("UPDATE inngest_slice_jobs SET status='publish_failed',last_error=?,updated_at=? WHERE id=? AND status='queued'").bind(reason.slice(0,240),now(),id).run();
		},
		async claim(id: string, generation: number) {
			const token = crypto.randomUUID();
			const row = await db.prepare("UPDATE inngest_slice_jobs SET status='running',attempts=attempts+1,attempt_token=?,updated_at=? WHERE id=? AND generation=? AND status='queued' AND attempts<1 AND deleted_at IS NULL RETURNING id,status,generation,attempt_token,attempts,kind,input_text,result_text,last_error").bind(token,now(),id,generation).first<SliceJob>();
			return row;
		},
		async complete(job: Pick<SliceJob,'id'|'generation'|'attempt_token'>, result: string) {
			const out = await db.prepare("UPDATE inngest_slice_jobs SET status='done',result_text=?,last_error=NULL,updated_at=? WHERE id=? AND generation=? AND attempt_token=? AND status='running' AND deleted_at IS NULL").bind(result,now(),job.id,job.generation,job.attempt_token).run();
			return out.meta?.changes === 1;
		},
		async fail(job: Pick<SliceJob,'id'|'generation'|'attempt_token'>, reason: string) {
			const out = await db.prepare("UPDATE inngest_slice_jobs SET status='failed',last_error=?,updated_at=? WHERE id=? AND generation=? AND attempt_token=? AND status='running' AND deleted_at IS NULL").bind(reason.slice(0,240),now(),job.id,job.generation,job.attempt_token).run();
			return out.meta?.changes === 1;
		},
		async failCurrentGeneration(id: string, generation: number, reason: string) {
			const out = await db.prepare("UPDATE inngest_slice_jobs SET status='failed',last_error=?,updated_at=? WHERE id=? AND generation=? AND status='running' AND deleted_at IS NULL").bind(reason.slice(0,240),now(),id,generation).run();
			return out.meta?.changes === 1;
		},
		async reanalyze(id: string) {
			const out = await db.prepare("UPDATE inngest_slice_jobs SET status='queued',generation=generation+1,attempts=0,attempt_token=NULL,result_text=NULL,last_error=NULL,updated_at=? WHERE id=? AND deleted_at IS NULL").bind(now(),id).run();
			if (out.meta?.changes !== 1) throw new Error('job cannot be reanalyzed');
			const row = await db.prepare('SELECT generation FROM inngest_slice_jobs WHERE id=?').bind(id).first<{generation:number}>();
			return row!.generation;
		},
		async delete(id: string) {
			await db.prepare("UPDATE inngest_slice_jobs SET status='deleted',generation=generation+1,deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL").bind(now(),now(),id).run();
		}
	};
}
