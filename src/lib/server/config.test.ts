import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	deleteSavedZaiApiKey,
	gradeRank,
	loadWorkbooks,
	readSavedZaiApiKey,
	renderPrompt,
	saveZaiApiKey,
	settings,
	sortWorkbooks,
	zaiApiKeySource
} from './config';
import type { Workbook } from '$lib/types';

describe('실제 user/config/workbooks.json', () => {
	const list = loadWorkbooks();
	const names = list.map((w) => w.name);

	it('요청한 문제집이 모두 있고 쎈 중2-1·중2-2는 없다', () => {
		for (const n of [
			'RPM 공통수학1',
			'RPM 공통수학2',
			'마플 공통수학1',
			'마플 공통수학2',
			'블랙라벨 중2-2',
			'최상위 중2-2',
			'쎈 공통수학1',
			'쎈 공통수학2',
			'블랙라벨 중3-1',
			'블랙라벨 중3-2',
			'최상위 중3-1',
			'최상위 중3-2'
		])
			expect(names, n).toContain(n);
		expect(names).not.toContain('쎈 중2-1');
		expect(names).not.toContain('쎈 중2-2');
	});

	it('중학교 → 고등학교, 같은 학년 안에서는 개념원리 → RPM → 쎈 → 마플 순', () => {
		const pos = (n: string) => names.indexOf(n);
		expect(pos('최상위 중3-2')).toBeLessThan(pos('개념원리 공통수학1')); // 중 < 고
		const high = ['개념원리 공통수학1', '개념원리 공통수학2', 'RPM 공통수학1', 'RPM 공통수학2', '쎈 공통수학1', '쎈 공통수학2', '마플 공통수학1', '마플 공통수학2'];
		expect(names.filter((n) => high.includes(n))).toEqual(high);
		// 중2 < 중3
		expect(pos('최상위 중2-2')).toBeLessThan(pos('쎈 중3-1'));
	});

	it('같은 출판사 안에서는 학기 순', () => {
		const pos = (n: string) => names.indexOf(n);
		expect(pos('쎈 중3-1')).toBeLessThan(pos('쎈 중3-2'));
		expect(pos('블랙라벨 중3-1')).toBeLessThan(pos('블랙라벨 중3-2'));
	});

	it('id 는 유일하다', () => expect(new Set(list.map((w) => w.id)).size).toBe(list.length));
});

describe('sortWorkbooks', () => {
	const w = (name: string, publisher: string, grade: string, semester: number): Workbook => ({ id: name, name, publisher, grade, semester });

	it('입력 순서와 무관하게 정렬하고 원본을 바꾸지 않는다', () => {
		const input = [w('쎈 고1', '쎈', '고1', 1), w('개념 중3', '개념원리', '중3', 1), w('개념 고1', '개념원리', '고1', 1)];
		expect(sortWorkbooks(input, ['개념원리', '쎈']).map((x) => x.name)).toEqual(['개념 중3', '개념 고1', '쎈 고1']);
		expect(input[0].name).toBe('쎈 고1');
	});

	it('publisherOrder 에 없는 출판사는 그 학년의 맨 뒤', () => {
		const out = sortWorkbooks([w('새책', '새출판', '중3', 1), w('쎈', '쎈', '중3', 1)], ['쎈']);
		expect(out.map((x) => x.name)).toEqual(['쎈', '새책']);
	});
});

describe('gradeRank', () => {
	it('중학교 < 고등학교, 학년 순', () => {
		expect(gradeRank('중2')).toBeLessThan(gradeRank('중3'));
		expect(gradeRank('중3')).toBeLessThan(gradeRank('고1'));
		expect(gradeRank('고1')).toBeLessThan(gradeRank('고2'));
		expect(gradeRank('???')).toBeGreaterThan(gradeRank('고2'));
	});
});

describe('loadWorkbooks 검증', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'ymath-cfg-'));
		process.env.CONFIG_DIR = dir;
	});
	afterEach(() => {
		delete process.env.CONFIG_DIR;
		rmSync(dir, { recursive: true, force: true });
	});
	const write = (obj: unknown) => writeFileSync(join(dir, 'workbooks.json'), JSON.stringify(obj));

	it('id 중복은 예외', () => {
		const a = { id: 'a', name: 'A', publisher: 'P', grade: '중3', semester: 1 };
		write({ workbooks: [a, a] });
		expect(() => loadWorkbooks()).toThrow(/중복/);
	});
	it('publisher 누락은 예외', () => {
		write({ workbooks: [{ id: 'a', name: 'A', grade: '중3', semester: 1 }] });
		expect(() => loadWorkbooks()).toThrow(/publisher/);
	});
});

describe('renderPrompt', () => {
	it('STUDENT_NAME 환경변수가 있으면 친근하게 치환한다', () => {
		const tmpl = '학생{{STUDENT_PAREN}}에게 건네는 인사. {{STUDENT_POSSESSIVE}}생각 습관. {{STUDENT_TOPIC}}기억할 점.';
		expect(renderPrompt(tmpl, '지우')).toBe('학생(지우)에게 건네는 인사. 지우의 생각 습관. 지우가 기억할 점.');
	});

	it('이름이 설정되지 않았으면 자연스럽게 기본형으로 치환한다', () => {
		const tmpl = '학생{{STUDENT_PAREN}}에게 건네는 인사. {{STUDENT_POSSESSIVE}}생각 습관. {{STUDENT_TOPIC}}기억할 점.';
		expect(renderPrompt(tmpl, '')).toBe('학생에게 건네는 인사. 생각 습관. 기억할 점.');
	});
});

describe('Z.AI API 키 저장', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'ymath-key-'));
		process.env.CONFIG_DIR = dir;
		delete process.env.ZAI_API_KEY;
	});
	afterEach(() => {
		delete process.env.CONFIG_DIR;
		delete process.env.ZAI_API_KEY;
		rmSync(dir, { recursive: true, force: true });
	});

	it('아무것도 없으면 키가 없는 상태(none)이고 값도 비어 있다', () => {
		expect(zaiApiKeySource()).toBe('none');
		expect(readSavedZaiApiKey()).toBe('');
		expect(settings().zaiApiKey).toBe('');
	});

	it('저장하면 파일로 남고 settings 가 그 키를 쓴다', () => {
		saveZaiApiKey('  test-key-123  ');
		expect(readSavedZaiApiKey()).toBe('test-key-123');
		expect(zaiApiKeySource()).toBe('saved');
		expect(settings().zaiApiKey).toBe('test-key-123');
	});

	it('환경변수가 저장한 키보다 우선한다', () => {
		saveZaiApiKey('saved-key');
		process.env.ZAI_API_KEY = 'env-key';
		expect(zaiApiKeySource()).toBe('env');
		expect(settings().zaiApiKey).toBe('env-key');
	});

	it('지우면 키가 없는 상태(none)로 돌아간다', () => {
		saveZaiApiKey('saved-key');
		deleteSavedZaiApiKey();
		expect(readSavedZaiApiKey()).toBe('');
		expect(zaiApiKeySource()).toBe('none');
	});
});
