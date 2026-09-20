import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVE_STATUSES } from '$lib/types';
import { analyzeItem, type Analyzer } from './analyze';
import { settings } from './config';
import { runOcr } from './ocr';
import { itemDir, listRecords, readRecord, updateRecord } from './store';

export interface QueueDeps {
	ocr: (dir: string) => Promise<string>;
	analyze: Analyzer;
	maxAttempts: number;
}

/**
 * 프로세스 내 단일 워커 큐. 상태는 record.json 에 있으므로 서버가 재시작돼도 recover() 로 이어간다.
 * 상태: queued → ocr → analyzing → done | failed
 */
export class JobQueue {
	private pending: string[] = [];
	private running = false;
	private waiters: (() => void)[] = [];

	constructor(private deps: QueueDeps) {}

	enqueue(id: string) {
		if (!this.pending.includes(id)) this.pending.push(id);
		void this.drain();
	}

	/** 서버 시작 시 처리 중이던 항목을 다시 큐에 넣는다(오래된 것부터). */
	recover(): number {
		const stuck = listRecords()
			.filter((r) => ACTIVE_STATUSES.includes(r.status))
			.reverse();
		for (const r of stuck) this.enqueue(r.id);
		return stuck.length;
	}

	/** 큐가 빌 때까지 기다린다(테스트용) */
	idle(): Promise<void> {
		if (!this.running && this.pending.length === 0) return Promise.resolve();
		return new Promise((res) => this.waiters.push(res));
	}

	private async drain() {
		if (this.running) return;
		this.running = true;
		try {
			let id: string | undefined;
			while ((id = this.pending.shift())) {
				try {
					await this.process(id);
				} catch (e) {
					// 상태 기록 자체가 실패한 경우에도 워커는 살아 있어야 한다
					console.error(`[queue] ${id} 처리 중 예기치 않은 오류`, e);
				}
			}
		} finally {
			this.running = false;
			this.waiters.splice(0).forEach((w) => w());
		}
	}

	private async process(id: string) {
		const rec = readRecord(id);
		if (!rec || !ACTIVE_STATUSES.includes(rec.status)) return;
		const dir = itemDir(id);
		const ocrPath = join(dir, 'ocr.md');

		// OCR: 재분석 때는 이미 만든 ocr.md 를 재사용한다. 실패해도 OCR 없이 분석을 계속한다.
		let ocrText = '';
		let ocrMissing = false;
		if (existsSync(ocrPath) && readFileSync(ocrPath, 'utf8').trim()) {
			ocrText = readFileSync(ocrPath, 'utf8');
		} else {
			updateRecord(id, (r) => {
				r.status = 'ocr';
			});
			try {
				ocrText = await this.deps.ocr(dir);
				writeFileSync(ocrPath, ocrText, 'utf8');
			} catch (e) {
				ocrMissing = true;
				console.warn(`[queue] ${id} OCR 실패, 사진만으로 분석합니다: ${(e as Error).message}`);
			}
		}

		let lastError = '';
		for (let attempt = 1; attempt <= this.deps.maxAttempts; attempt++) {
			updateRecord(id, (r) => {
				r.status = 'analyzing';
				r.attempts += 1;
				r.error = null;
			});
			try {
				const record = readRecord(id)!;
				const res = await this.deps.analyze({ record, dir, ocrText, hint: lastError || undefined });
				updateRecord(id, (r) => {
					r.status = 'done';
					r.error = null;
					r.analysis = res.analysis;
					r.flags = { ocr_missing: ocrMissing, taxonomy_mismatch: res.taxonomyIssues, guardrail: res.guardrailWarnings };
					r.meta = { provider: res.provider, model: res.model, prompt_version: res.promptVersion, analyzed_at: new Date().toISOString() };
				});
				return;
			} catch (e) {
				lastError = e instanceof Error ? e.message : String(e);
				console.warn(`[queue] ${id} 분석 실패(${attempt}/${this.deps.maxAttempts}): ${lastError}`);
			}
		}
		updateRecord(id, (r) => {
			r.status = 'failed';
			r.error = lastError;
			r.flags.ocr_missing = ocrMissing;
		});
	}
}

let instance: JobQueue | null = null;

/** 실제 러너를 연결한 싱글턴. 첫 호출 때 미완료 항목을 복구한다. */
export function getQueue(): JobQueue {
	if (!instance) {
		instance = new JobQueue({ ocr: runOcr, analyze: analyzeItem, maxAttempts: settings().maxAttempts });
		const n = instance.recover();
		if (n) console.log(`[queue] 미완료 ${n}건을 다시 큐에 넣었습니다`);
	}
	return instance;
}
