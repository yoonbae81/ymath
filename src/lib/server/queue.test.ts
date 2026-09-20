import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobQueue, type QueueDeps } from './queue';
import { createItem, itemDir, readRecord, updateRecord } from './store';
import type { Analysis, Status } from '$lib/types';

const WB = { id: 'w', name: '쎈 중2-1', publisher: '쎈', grade: '중2', semester: 1 };
const fakeAnalysis = { classification: { topic: '대수' } } as unknown as Analysis;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'ymath-queue-'));
	process.env.DATA_DIR = dir;
});
afterEach(() => {
	delete process.env.DATA_DIR;
	rmSync(dir, { recursive: true, force: true });
});

const okDeps = (over: Partial<QueueDeps> = {}): QueueDeps => ({
	ocr: async () => '$x^2$',
	analyze: async () => ({ analysis: fakeAnalysis, provider: 'claude', model: 'sonnet', promptVersion: 'abc12345', taxonomyIssues: [], guardrailWarnings: [] }),
	maxAttempts: 2,
	...over
});

describe('JobQueue', () => {
	it('queued → ocr → analyzing → done 로 진행하고 결과와 ocr.md 를 저장한다', async () => {
		const seen: Status[] = [];
		const item = createItem(WB);
		const q = new JobQueue(
			okDeps({
				ocr: async () => {
					seen.push(readRecord(item.id)!.status);
					return '$x^2$';
				},
				analyze: async ({ ocrText }) => {
					seen.push(readRecord(item.id)!.status);
					expect(ocrText).toBe('$x^2$');
					return { analysis: fakeAnalysis, provider: 'claude', model: 'sonnet', promptVersion: 'abc12345', taxonomyIssues: [], guardrailWarnings: [] };
				}
			})
		);
		q.enqueue(item.id);
		await q.idle();

		expect(seen).toEqual(['ocr', 'analyzing']);
		const r = readRecord(item.id)!;
		expect(r).toMatchObject({ status: 'done', error: null, attempts: 1 });
		expect(r.analysis).toEqual(fakeAnalysis);
		expect(r.meta).toMatchObject({ provider: 'claude', model: 'sonnet', prompt_version: 'abc12345' });
		expect(r.flags).toEqual({ ocr_missing: false, taxonomy_mismatch: [], guardrail: [] });
		expect(readFileSync(join(itemDir(item.id), 'ocr.md'), 'utf8')).toBe('$x^2$');
	});

	it('OCR 이 죽어도 사진만으로 분석을 계속하고 ocr_missing 을 표시한다', async () => {
		const item = createItem(WB);
		let gotOcr: string | null = null;
		const q = new JobQueue(
			okDeps({
				ocr: async () => {
					throw new Error('ocr-server down');
				},
				analyze: async ({ ocrText }) => {
					gotOcr = ocrText;
					return { analysis: fakeAnalysis, provider: 'claude', model: 'sonnet', promptVersion: 'p', taxonomyIssues: [], guardrailWarnings: [] };
				}
			})
		);
		q.enqueue(item.id);
		await q.idle();

		expect(gotOcr).toBe('');
		expect(readRecord(item.id)).toMatchObject({ status: 'done', flags: { ocr_missing: true } });
		expect(existsSync(join(itemDir(item.id), 'ocr.md'))).toBe(false);
	});

	it('분석이 한 번 실패하면 재시도하고, 성공하면 done', async () => {
		const item = createItem(WB);
		let calls = 0;
		const q = new JobQueue(
			okDeps({
				analyze: async () => {
					if (++calls === 1) throw new Error('일시 오류');
					return { analysis: fakeAnalysis, provider: 'claude', model: 'sonnet', promptVersion: 'p', taxonomyIssues: [], guardrailWarnings: [] };
				}
			})
		);
		q.enqueue(item.id);
		await q.idle();
		expect(calls).toBe(2);
		expect(readRecord(item.id)).toMatchObject({ status: 'done', attempts: 2, error: null });
	});

	it('재시도 때 직전 실패 사유를 힌트로 넘긴다(첫 시도에는 없다)', async () => {
		const item = createItem(WB);
		const hints: (string | undefined)[] = [];
		const q = new JobQueue(
			okDeps({
				analyze: async ({ hint }) => {
					hints.push(hint);
					if (hints.length === 1) throw new Error('정답 노출 가드레일 위반: 넛지 Q1에 등식이 있음');
					return { analysis: fakeAnalysis, provider: 'claude', model: 'sonnet', promptVersion: 'p', taxonomyIssues: [], guardrailWarnings: ['질문 형태가 아님'] };
				}
			})
		);
		q.enqueue(item.id);
		await q.idle();
		expect(hints).toEqual([undefined, '정답 노출 가드레일 위반: 넛지 Q1에 등식이 있음']);
		expect(readRecord(item.id)!.flags.guardrail).toEqual(['질문 형태가 아님']);
	});

	it('계속 실패하면 failed 와 오류 메시지를 남긴다', async () => {
		const item = createItem(WB);
		const q = new JobQueue(
			okDeps({
				analyze: async () => {
					throw new Error('스키마와 다름');
				}
			})
		);
		q.enqueue(item.id);
		await q.idle();
		expect(readRecord(item.id)).toMatchObject({ status: 'failed', error: '스키마와 다름', attempts: 2 });
	});

	it('분류 체계 불일치는 실패가 아니라 flags 로 남긴다', async () => {
		const item = createItem(WB);
		const q = new JobQueue(
			okDeps({
				analyze: async () => ({
					analysis: fakeAnalysis,
					provider: 'claude',
					model: 'sonnet',
					promptVersion: 'p',
					taxonomyIssues: ["단원 'X'은 '기하' 영역인데 topic이 '대수'"],
					guardrailWarnings: []
				})
			})
		);
		q.enqueue(item.id);
		await q.idle();
		const r = readRecord(item.id)!;
		expect(r.status).toBe('done');
		expect(r.flags.taxonomy_mismatch).toHaveLength(1);
	});

	it('재분석은 기존 ocr.md 를 재사용해 OCR 을 다시 돌리지 않는다', async () => {
		const item = createItem(WB);
		writeFileSync(join(itemDir(item.id), 'ocr.md'), '기존 OCR');
		let ocrCalls = 0;
		let gotOcr = '';
		const q = new JobQueue(
			okDeps({
				ocr: async () => {
					ocrCalls++;
					return 'new';
				},
				analyze: async ({ ocrText }) => {
					gotOcr = ocrText;
					return { analysis: fakeAnalysis, provider: 'claude', model: 'sonnet', promptVersion: 'p', taxonomyIssues: [], guardrailWarnings: [] };
				}
			})
		);
		q.enqueue(item.id);
		await q.idle();
		expect(ocrCalls).toBe(0);
		expect(gotOcr).toBe('기존 OCR');
	});

	it('여러 항목을 한 번에 하나씩(동시성 1) 순서대로 처리한다', async () => {
		const a = createItem(WB, new Date(2026, 8, 19, 10, 0, 0));
		const b = createItem(WB, new Date(2026, 8, 19, 10, 0, 1));
		let active = 0;
		let maxActive = 0;
		const order: string[] = [];
		const q = new JobQueue(
			okDeps({
				analyze: async ({ record }) => {
					active++;
					maxActive = Math.max(maxActive, active);
					order.push(record.id);
					await new Promise((r) => setTimeout(r, 20));
					active--;
					return { analysis: fakeAnalysis, provider: 'claude', model: 'sonnet', promptVersion: 'p', taxonomyIssues: [], guardrailWarnings: [] };
				}
			})
		);
		q.enqueue(a.id);
		q.enqueue(b.id);
		q.enqueue(b.id); // 중복 enqueue 는 무시
		await q.idle();
		expect(maxActive).toBe(1);
		expect(order).toEqual([a.id, b.id]);
	});

	it('recover 는 처리 중이던 항목만 오래된 순으로 다시 처리한다', async () => {
		const stuck = createItem(WB, new Date(2026, 8, 19, 10, 0, 0));
		updateRecord(stuck.id, (r) => {
			r.status = 'analyzing';
		});
		const queued = createItem(WB, new Date(2026, 8, 19, 10, 0, 1));
		const done = createItem(WB, new Date(2026, 8, 19, 10, 0, 2));
		updateRecord(done.id, (r) => {
			r.status = 'done';
		});
		const order: string[] = [];
		const q = new JobQueue(
			okDeps({
				analyze: async ({ record }) => {
					order.push(record.id);
					return { analysis: fakeAnalysis, provider: 'claude', model: 'sonnet', promptVersion: 'p', taxonomyIssues: [], guardrailWarnings: [] };
				}
			})
		);
		expect(q.recover()).toBe(2);
		await q.idle();
		expect(order).toEqual([stuck.id, queued.id]);
		expect(readRecord(done.id)!.analysis).toBeNull(); // 건드리지 않음
	});

	it('삭제된 항목이나 이미 끝난 항목은 조용히 건너뛴다', async () => {
		const done = createItem(WB);
		updateRecord(done.id, (r) => {
			r.status = 'done';
		});
		let calls = 0;
		const q = new JobQueue(okDeps({ analyze: async () => (calls++, Promise.reject(new Error('호출되면 안 됨'))) }));
		q.enqueue(done.id);
		q.enqueue('20260101-000000-zzzz');
		await q.idle();
		expect(calls).toBe(0);
	});
});
