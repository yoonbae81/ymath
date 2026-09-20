import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const enqueue = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/queue', () => ({ getQueue: () => ({ enqueue }) }));

import { POST as upload } from './upload/+server';
import { DELETE as remove } from './items/[id]/+server';
import { POST as retry } from './items/[id]/retry/+server';
import { POST as feedback } from './items/[id]/feedback/+server';
import { createItem, itemDir, readRecord, updateRecord } from '$lib/server/store';
import { AJAX_HEADER, AJAX_VALUE } from '$lib/ajax';
import { currentFeedback, type Analysis } from '$lib/types';

const AJAX = { [AJAX_HEADER]: AJAX_VALUE };
const WB = { id: 'gnw-common1', name: '개념원리 공통수학1', publisher: '개념원리', grade: '고1', semester: 1 };
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'ymath-api-'));
	process.env.DATA_DIR = dir;
	enqueue.mockClear();
});
afterEach(() => {
	delete process.env.DATA_DIR;
	rmSync(dir, { recursive: true, force: true });
});

const post = (url: string, headers: Record<string, string>, body?: BodyInit) =>
	new Request(`http://ymath.test${url}`, { method: 'POST', headers, body });
const ev = (request: Request, params: Record<string, string> = {}) =>
	({ request, url: new URL(request.url), params }) as never;
const photo = () =>
	sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#eee' } }).jpeg().toBuffer();
const itemCount = () => (existsSync(join(dir, 'items')) ? readdirSync(join(dir, 'items')).length : 0);

describe('POST /api/upload', () => {
	const url = '/api/upload?workbookId=gnw-common1';

	it('정상 업로드: 항목·이미지 2종을 만들고 큐에 넣는다', async () => {
		const res = await upload(ev(post(url, { ...AJAX, 'content-type': 'image/jpeg' }, new Uint8Array(await photo()))));
		expect(res.status).toBe(201);
		const { id } = await res.json();
		expect(readRecord(id)).toMatchObject({ status: 'queued', workbook: { id: 'gnw-common1' } });
		expect(readdirSync(itemDir(id)).sort()).toEqual(['image.jpg', 'record.json']); // 이미지는 하나만 저장한다
		expect(enqueue).toHaveBeenCalledWith(id);
	});

	it('커스텀 헤더가 없으면 403(다른 사이트의 위조 요청 차단)', async () => {
		await expect(upload(ev(post(url, { 'content-type': 'image/jpeg' }, new Uint8Array(await photo()))))).rejects.toMatchObject({ status: 403 });
		expect(itemCount()).toBe(0);
	});

	it('Sec-Fetch-Site: cross-site 헤더는 403 차단', async () => {
		await expect(
			upload(ev(post(url, { ...AJAX, 'content-type': 'image/jpeg', 'sec-fetch-site': 'cross-site' }, new Uint8Array(await photo()))))
		).rejects.toMatchObject({ status: 403 });
		expect(itemCount()).toBe(0);
	});

	it('다른 도메인의 Origin 헤더는 403 차단', async () => {
		await expect(
			upload(ev(post(url, { ...AJAX, 'content-type': 'image/jpeg', origin: 'https://evil.com' }, new Uint8Array(await photo()))))
		).rejects.toMatchObject({ status: 403 });
		expect(itemCount()).toBe(0);
	});

	it('SVG 이미지는 415 차단', async () => {
		await expect(upload(ev(post(url, { ...AJAX, 'content-type': 'image/svg+xml' }, '<svg></svg>')))).rejects.toMatchObject({ status: 415 });
	});

	it('이미지가 아닌 Content-Type 은 415', async () => {
		await expect(upload(ev(post(url, { ...AJAX, 'content-type': 'text/plain' }, 'x')))).rejects.toMatchObject({ status: 415 });
	});

	it('알 수 없는 문제집·빈 본문·깨진 이미지는 400 이고 항목을 남기지 않는다', async () => {
		const h = { ...AJAX, 'content-type': 'image/jpeg' };
		await expect(upload(ev(post('/api/upload?workbookId=nope', h, new Uint8Array(await photo()))))).rejects.toMatchObject({ status: 400 });
		await expect(upload(ev(post(url, h, new Uint8Array(0))))).rejects.toMatchObject({ status: 400 });
		await expect(upload(ev(post(url, h, new Uint8Array(2_000_000).fill(7))))).rejects.toMatchObject({ status: 400 });
		expect(itemCount()).toBe(0);
		expect(enqueue).not.toHaveBeenCalled();
	});

	it('25MB 초과 파일은 413 반환', async () => {
		const h = { ...AJAX, 'content-type': 'image/jpeg' };
		// 25MB + 1 byte
		const oversized = new Uint8Array(25 * 1024 * 1024 + 1);
		await expect(upload(ev(post(url, h, oversized)))).rejects.toMatchObject({ status: 413 });
		expect(itemCount()).toBe(0);
	});
});

describe('POST /api/items/[id]/retry', () => {
	// 핸들러의 error() 는 동기로 던지므로, rejects 로 검사하려면 async 로 감싼다
	const call = async (id: string, headers: Record<string, string> = AJAX) => retry(ev(post(`/api/items/${id}/retry`, headers), { id }));

	it('완료·실패 항목을 재분석 대기로 돌리고 기존 결과는 남긴다', async () => {
		const r = createItem(WB);
		updateRecord(r.id, (x) => {
			x.status = 'failed';
			x.error = '이전 오류';
			x.attempts = 2;
			x.analysis = { asks: '기존 결과' } as unknown as Analysis;
		});
		const res = await call(r.id);
		expect(res.status).toBe(202);
		expect(readRecord(r.id)).toMatchObject({ status: 'queued', error: null, attempts: 0, analysis: { asks: '기존 결과' } });
		expect(enqueue).toHaveBeenCalledWith(r.id);
	});

	it('?provider= 로 재분석 LLM 을 지정하면 항목에 기록하고, 잘못된 값은 400', async () => {
		const r = createItem(WB);
		updateRecord(r.id, (x) => {
			x.status = 'done';
		});
		const withProvider = async (p: string) =>
			retry(ev(post(`/api/items/${r.id}/retry?provider=${p}`, AJAX), { id: r.id }));
		await expect(withProvider('gpt')).rejects.toMatchObject({ status: 400 });
		expect(readRecord(r.id)).toMatchObject({ status: 'done' });
		expect(enqueue).not.toHaveBeenCalled();

		expect((await withProvider('codex')).status).toBe(202);
		expect(readRecord(r.id)).toMatchObject({ status: 'queued', requested_provider: 'codex' });
		expect(enqueue).toHaveBeenCalledWith(r.id);

		// agy 도 지정할 수 있다(done/failed 로 되돌린 뒤)
		updateRecord(r.id, (x) => {
			x.status = 'done';
		});
		expect((await withProvider('agy')).status).toBe(202);
		expect(readRecord(r.id)!.requested_provider).toBe('agy');
	});

	it('provider 를 생략하면 이전에 고른 LLM 을 유지한다', async () => {
		const r = createItem(WB);
		updateRecord(r.id, (x) => {
			x.status = 'failed';
			x.requested_provider = 'codex';
		});
		await call(r.id);
		expect(readRecord(r.id)!.requested_provider).toBe('codex');
	});

	it('이미 대기·진행 중이면 409, 없으면 404, 헤더가 없으면 403', async () => {
		const r = createItem(WB); // queued
		await expect(call(r.id)).rejects.toMatchObject({ status: 409 });
		await expect(call('20260101-000000-zzzz')).rejects.toMatchObject({ status: 404 });
		await expect(call(r.id, {})).rejects.toMatchObject({ status: 403 });
		expect(enqueue).not.toHaveBeenCalled();
	});

	it('잘못된 형식의 ID 또는 경로 탐색 시도는 400 차단', async () => {
		await expect(call('../../../etc/passwd')).rejects.toMatchObject({ status: 400 });
		await expect(call('invalid-id')).rejects.toMatchObject({ status: 400 });
		expect(enqueue).not.toHaveBeenCalled();
	});
});

describe('DELETE /api/items/[id]', () => {
	const call = async (id: string, headers: Record<string, string> = AJAX) =>
		remove(ev(new Request(`http://ymath.test/api/items/${id}`, { method: 'DELETE', headers }), { id }));

	it('완료 항목은 폴더째 삭제(204)', async () => {
		const r = createItem(WB);
		updateRecord(r.id, (x) => {
			x.status = 'done';
		});
		expect((await call(r.id)).status).toBe(204);
		expect(existsSync(itemDir(r.id))).toBe(false);
	});

	it('분석 중인 항목은 409 로 막고, 헤더가 없으면 403', async () => {
		const r = createItem(WB);
		updateRecord(r.id, (x) => {
			x.status = 'analyzing';
		});
		await expect(call(r.id)).rejects.toMatchObject({ status: 409 });
		await expect(call(r.id, {})).rejects.toMatchObject({ status: 403 });
		expect(existsSync(itemDir(r.id))).toBe(true);
	});

	it('잘못된 형식의 ID 또는 경로 탐색 시도는 400 차단', async () => {
		await expect(call('../../../etc/passwd')).rejects.toMatchObject({ status: 400 });
		await expect(call('invalid-id')).rejects.toMatchObject({ status: 400 });
	});
});

describe('POST /api/items/[id]/feedback', () => {
	const send = async (id: string, body: unknown, headers: Record<string, string> = { ...AJAX, 'content-type': 'application/json' }) =>
		feedback(ev(post(`/api/items/${id}/feedback`, headers, typeof body === 'string' ? body : JSON.stringify(body)), { id }));
	const analyzed = (at = '2026-09-20T00:00:00.000Z') => {
		const r = createItem(WB);
		updateRecord(r.id, (x) => {
			x.status = 'done';
			x.analysis = { asks: '…' } as unknown as Analysis;
			x.meta = { provider: 'claude', model: 'sonnet', prompt_version: 'abc123', analyzed_at: at };
		});
		return r.id;
	};

	it('반응을 저장하고, 그때의 지침 버전·모델을 함께 남긴다', async () => {
		const id = analyzed();
		const res = await send(id, { choice: 'wrong_diagnosis', comment: '  부호가 아니라 조건을 놓쳤어요 ' });
		expect(res.status).toBe(200);
		const rec = readRecord(id)!;
		expect(rec.feedback).toHaveLength(1);
		expect(rec.feedback![0]).toMatchObject({
			choice: 'wrong_diagnosis',
			comment: '부호가 아니라 조건을 놓쳤어요',
			analyzed_at: '2026-09-20T00:00:00.000Z',
			prompt_version: 'abc123',
			provider: 'claude',
			model: 'sonnet'
		});
		expect(currentFeedback(rec)?.choice).toBe('wrong_diagnosis');
	});

	it('같은 분석에 다시 답하면 덮어쓰고, 재분석된 뒤의 답은 새로 쌓인다', async () => {
		const id = analyzed();
		await send(id, { choice: 'too_hard' });
		await send(id, { choice: 'accurate' });
		expect(readRecord(id)!.feedback!.map((f) => f.choice)).toEqual(['accurate']);

		// 재분석: 새 분석에는 아직 답이 없고, 이전 답은 남는다
		updateRecord(id, (x) => {
			x.meta!.analyzed_at = '2026-09-21T00:00:00.000Z';
			x.meta!.prompt_version = 'def456';
		});
		expect(currentFeedback(readRecord(id)!)).toBeNull();
		await send(id, { choice: 'learned' });
		const rec = readRecord(id)!;
		expect(rec.feedback!.map((f) => [f.choice, f.prompt_version])).toEqual([
			['accurate', 'abc123'],
			['learned', 'def456']
		]);
		expect(currentFeedback(rec)?.choice).toBe('learned');
	});

	it('의견은 300자로 자르고 제어 문자는 뺀다', async () => {
		const id = analyzed();
		await send(id, { choice: 'too_hard', comment: `a\u0000b${'가'.repeat(400)}` });
		const c = readRecord(id)!.feedback![0].comment;
		expect(c.startsWith('ab')).toBe(true);
		expect(c).toHaveLength(300);
	});

	it('알 수 없는 응답·깨진 본문은 400, 분석 전이거나 재분석 중이면 409, 없으면 404', async () => {
		const id = analyzed();
		await expect(send(id, { choice: 'great' })).rejects.toMatchObject({ status: 400 });
		await expect(send(id, {})).rejects.toMatchObject({ status: 400 });
		await expect(send(id, 'not json')).rejects.toMatchObject({ status: 400 });
		await expect(send(id, { choice: 'accurate', comment: 5 })).rejects.toMatchObject({ status: 400 });
		updateRecord(id, (x) => {
			x.status = 'queued';
		});
		await expect(send(id, { choice: 'accurate' })).rejects.toMatchObject({ status: 409 });
		await expect(send(createItem(WB).id, { choice: 'accurate' })).rejects.toMatchObject({ status: 409 });
		await expect(send('20260101-000000-zzzz', { choice: 'accurate' })).rejects.toMatchObject({ status: 404 });
		expect(readRecord(id)!.feedback).toBeUndefined();
	});

	it('커스텀 헤더가 없으면 403, 잘못된 ID 는 400', async () => {
		const id = analyzed();
		await expect(send(id, { choice: 'accurate' }, { 'content-type': 'application/json' })).rejects.toMatchObject({ status: 403 });
		await expect(send('../../etc', { choice: 'accurate' })).rejects.toMatchObject({ status: 400 });
		expect(readRecord(id)!.feedback).toBeUndefined();
	});
});
