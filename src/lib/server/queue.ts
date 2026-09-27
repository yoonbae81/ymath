import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVE_STATUSES } from '$lib/types';
import type { Provider } from '$lib/types';
import { analyzeItem, providerFor, type Analyzer } from './analyze';
import { settings } from './config';
import { isQuotaOrRateLimitError } from './llm';
import { runOcr } from './ocr';
import { itemDir, listRecords, readRecord, saveAnalysis, updateRecord } from './store';

/** 할당량 소진 또는 429 오류 시 재시도 대기 시간 (기본 10분) */
export const quotaRetryDelayMs = () => Number(process.env.QUOTA_RETRY_DELAY_MS ?? 10 * 60_000);

export interface QueueDeps {
	ocr: (dir: string) => Promise<string>;
	analyze: Analyzer;
	maxAttempts: number;
}

/**
 * 프로세스 내 프로바이더별 레인 큐. 같은 LLM(예: 내부망 omlx GPU)끼리는 하나씩 직렬로 처리하고,
 * 서로 다른 프로바이더(omlx 대기 중에도 zai 등 외부 API)끼리는 병렬로 돈다. 상태는 record.json 에
 * 있으므로 서버가 재시작돼도 recover() 로 이어간다. 상태: queued → ocr → analyzing → done | failed
 */
export class JobQueue {
	private lanes = new Map<Provider, string[]>();
	private runningLanes = new Set<Provider>();
	/** 어떤 레인에든 대기 중인 id — 레인 간 중복 등록을 막는다 */
	private queued = new Set<string>();
	private waiters: (() => void)[] = [];

	constructor(private deps: QueueDeps) {}

	private laneOf(id: string): Provider {
		const rec = readRecord(id);
		return rec ? providerFor(rec) : settings().provider;
	}

	enqueue(id: string) {
		if (this.queued.has(id)) return;
		const lane = this.laneOf(id);
		this.queued.add(id);
		const q = this.lanes.get(lane) ?? [];
		q.push(id);
		this.lanes.set(lane, q);
		void this.drain(lane);
	}

	/** 서버 시작 시 처리 중이던 항목을 다시 큐에 넣는다(오래된 것부터). */
	recover(): number {
		const stuck = listRecords()
			.filter((r) => ACTIVE_STATUSES.includes(r.status))
			.reverse();
		for (const r of stuck) this.enqueue(r.id);
		return stuck.length;
	}

	/** 모든 레인이 빌 때까지 기다린다(테스트용) */
	idle(): Promise<void> {
		if (this.queued.size === 0 && this.runningLanes.size === 0) return Promise.resolve();
		return new Promise((res) => this.waiters.push(res));
	}

	private releaseIfIdle() {
		if (this.queued.size === 0 && this.runningLanes.size === 0) this.waiters.splice(0).forEach((w) => w());
	}

	private async drain(lane: Provider) {
		if (this.runningLanes.has(lane)) return;
		this.runningLanes.add(lane);
		try {
			let id: string | undefined;
			while ((id = this.lanes.get(lane)?.shift())) {
				this.queued.delete(id);
				try {
					await this.process(id);
				} catch (e) {
					// 상태 기록 자체가 실패한 경우에도 워커는 살아 있어야 한다
					console.error(`[queue] ${id} 처리 중 예기치 않은 오류`, e);
				}
			}
		} finally {
			this.runningLanes.delete(lane);
			this.releaseIfIdle();
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
				const meta = {
					provider: res.provider,
					model: res.model,
					prompt_version: res.promptVersion,
					analyzed_at: new Date().toISOString()
				};
				const flags = { ocr_missing: ocrMissing, taxonomy_mismatch: res.taxonomyIssues, guardrail: res.guardrailWarnings };
				// 파일을 먼저 쓴다. 쓰기가 실패하면 이 시도가 실패로 처리돼 재시도한다
				saveAnalysis(id, { analysis: res.analysis, meta, flags });
				updateRecord(id, (r) => {
					r.status = 'done';
					r.error = null;
					r.analysis = res.analysis;
					r.flags = flags;
					r.meta = meta;
				});
				return;
			} catch (e) {
				if (isQuotaOrRateLimitError(e)) {
					const delayMs = quotaRetryDelayMs();
					console.warn(`[queue] ${id} 429 또는 사용량 할당량 소진 감지. ${Math.round(delayMs / 60_000)}분 뒤 다시 시도합니다: ${(e as Error).message}`);
					updateRecord(id, (r) => {
						r.status = 'queued';
						r.attempts = Math.max(0, r.attempts - 1);
						r.error = `API 할당량 초과 또는 요청 제한(429)으로 ${Math.round(delayMs / 60_000)}분 후 자동으로 다시 시도합니다.`;
					});
					setTimeout(() => {
						this.enqueue(id);
					}, delayMs);
					return;
				}
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
