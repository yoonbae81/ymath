import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createItem, deleteItem, isValidId, itemDir, knownPatternIds, listRecords, newId, readRecord, updateRecord } from './store';
import type { Analysis } from '$lib/types';

const WB = { id: 'w', name: '쎈 중2-1', publisher: '쎈', grade: '중2', semester: 1 };
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'ymath-store-'));
	process.env.DATA_DIR = dir;
});
afterEach(() => {
	delete process.env.DATA_DIR;
	rmSync(dir, { recursive: true, force: true });
});

describe('store', () => {
	it('newId 는 시간순 정렬 가능하고 형식이 유효하다', () => {
		const a = newId(new Date(2026, 8, 19, 14, 23, 1));
		const b = newId(new Date(2026, 8, 19, 14, 23, 2));
		expect(isValidId(a)).toBe(true);
		expect(a.startsWith('20260919-142301-')).toBe(true);
		expect(a < b).toBe(true);
	});

	it('createItem 은 queued 상태의 record.json 을 만든다', () => {
		const r = createItem(WB);
		expect(readRecord(r.id)).toMatchObject({ status: 'queued', workbook: WB, analysis: null, attempts: 0 });
	});

	it('updateRecord 는 원자적으로 저장하고 임시 파일을 남기지 않는다', () => {
		const r = createItem(WB);
		updateRecord(r.id, (x) => {
			x.status = 'done';
		});
		expect(readRecord(r.id)?.status).toBe('done');
		expect(readdirSync(itemDir(r.id))).toEqual(['record.json']);
	});

	it('updateRecord 는 없는 항목이면 예외', () => {
		expect(() => updateRecord('20260101-000000-aaaa', () => {})).toThrow();
	});

	it('listRecords 는 최신순, deleteItem 은 폴더째 지운다', () => {
		const a = createItem(WB, new Date(2026, 8, 19, 10, 0, 0));
		const b = createItem(WB, new Date(2026, 8, 19, 11, 0, 0));
		expect(listRecords().map((r) => r.id)).toEqual([b.id, a.id]);
		expect(deleteItem(a.id)).toBe(true);
		expect(existsSync(itemDir(a.id))).toBe(false);
		expect(deleteItem(a.id)).toBe(false);
	});

	it('경로 조작이 가능한 ID 는 거부한다', () => {
		expect(() => itemDir('../etc')).toThrow();
		expect(readRecord('../../etc/passwd')).toBeNull();
	});

	it('knownPatternIds 는 많이 나온 패턴 순으로 돌려준다', () => {
		const mk = (pattern: string, when: number) => {
			const r = createItem(WB, new Date(2026, 8, 19, 10, 0, when));
			updateRecord(r.id, (x) => {
				x.analysis = { error_analysis: { error_pattern_id: pattern, misconception: `${pattern} 오해` } } as unknown as Analysis;
			});
		};
		mk('sign-error', 1);
		mk('forgot-domain', 2);
		mk('sign-error', 3);
		expect(knownPatternIds()).toEqual([
			{ id: 'sign-error', count: 2, example: 'sign-error 오해' },
			{ id: 'forgot-domain', count: 1, example: 'forgot-domain 오해' }
		]);
	});

	it('knownPatternIds 는 오류 미확인(unconfirmed) 항목을 뺀다', () => {
		const r = createItem(WB, new Date(2026, 8, 19, 11, 0, 0));
		updateRecord(r.id, (x) => {
			x.analysis = { error_analysis: { error_pattern_id: 'unconfirmed', misconception: '' } } as unknown as Analysis;
		});
		expect(knownPatternIds().map((p) => p.id)).not.toContain('unconfirmed');
	});
});
