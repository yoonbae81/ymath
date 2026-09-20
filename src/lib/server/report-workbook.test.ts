import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validAnalysis } from './analysis.fixture';
import { ReportQueue, buildReportPrompt, calculateReportSummary, readReport } from './report';
import { createItem, updateRecord } from './store';
import type { ItemRecord } from '$lib/types';

const WB = { id: 'ssen-m3-2', name: '쎈 중3-2', publisher: '쎈', grade: '중3', semester: 2 };
let dir: string;

/** 쎈 중3-2 문제집의 삼각비 오답. 단원의 학기 표시(course)는 옛 초안처럼 '중3-1' 이라고 해 둔다(혼동을 재현) */
function addItem(number: string, at: Date) {
	const r = createItem(WB, at);
	updateRecord(r.id, (x) => {
		const a: any = validAnalysis();
		a.problem.number_guess = number;
		a.classification.course = '중3-1';
		x.status = 'done';
		x.analysis = a;
	});
	return r.id;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'ymath-rep-'));
	process.env.DATA_DIR = dir;
});
afterEach(() => {
	delete process.env.DATA_DIR;
	rmSync(dir, { recursive: true, force: true });
});

const WRONG = ['| 문제 | 순간 |', '|---|---|', '| 0255 · 쎈 중3-1 | 30° 삼각형에서 멈춤 |', '| 0252 · 쎈 중3-1 | 보조선만 긋고 멈춤 |', '', '0255, 0252처럼 도형이 복잡할 때는 각을 먼저 봐요.'].join('\n');

describe('A. 보고서 입력: 혼동의 재료 제거', () => {
	it('항목마다 label 을 주고, 단원의 학기 표시(course)는 넘기지 않는다', async () => {
		addItem('0255', new Date(2026, 8, 19, 10));
		let seen = '';
		const q = new ReportQueue(async (prompt) => ((seen = prompt), '본문'));
		await q.generateOrReuse({ topic: '대수', period: '', now: new Date(2026, 8, 19, 12) });

		expect(seen).toContain('"label": "0255 · 쎈 중3-2"');
		expect(seen).toContain('"workbook": "쎈 중3-2"');
		expect(seen).not.toContain('"course"'); // '중3-1' 이 문제집 이름에 섞여 들어갈 재료가 없다
		expect(seen).not.toContain('중3-1');
		expect(seen).toContain('`label`을 글자 그대로 쓰세요'); // 지침 파일(md)이 아니라 코드에 있어 편집해도 사라지지 않는다
	});

	it('buildReportPrompt 는 입력 항목을 바꾸지 않는다(저장된 course 는 그대로)', () => {
		const id = addItem('0255', new Date(2026, 8, 19, 10));
		const rec = { id, workbook: WB, analysis: (() => { const a: any = validAnalysis(); a.problem.number_guess = '0255'; a.classification.course = '중3-1'; return a; })(), created_at: '2026-09-19T01:00:00Z' } as unknown as ItemRecord;
		const summary = calculateReportSummary([rec], [], {});
		buildReportPrompt({ guideline: '# g', topic: '대수', periodLabel: '전체', summary, items: [rec] });
		expect(rec.analysis!.classification.course).toBe('중3-1');
	});
});

describe('B. 저장 전 교정: LLM 이 그래도 틀린 학기를 쓰면 코드가 바로잡는다', () => {
	it('틀린 "쎈 중3-1" 이 저장본에서 실제 문제집 "쎈 중3-2" 로 바뀌고 기록이 남는다', async () => {
		addItem('0255', new Date(2026, 8, 19, 10));
		addItem('0252', new Date(2026, 8, 19, 11));
		const q = new ReportQueue(async () => WRONG);
		const { report } = await q.generateOrReuse({ topic: '대수', period: '', now: new Date(2026, 8, 19, 12) });

		const saved = readReport(report.id)!;
		expect(saved.status).toBe('done');
		// 교정(쎈 중3-1 → 쎈 중3-2)과 함께 진단표의 문제 열은 두 줄(문제집<br/>번호)로 통일된다
		expect(saved.markdown).toContain('| 쎈 중3-2<br/>0255 |');
		expect(saved.markdown).toContain('| 쎈 중3-2<br/>0252 |');
		expect(saved.markdown).not.toContain('중3-1');
		expect(saved.markdown).toContain('0255, 0252처럼 도형이'); // 다른 문장은 그대로
		expect(saved.meta?.workbook_corrections).toBe(2);
		expect(saved.meta?.stray_workbooks).toBeUndefined();
	});

	it('이미 맞게 쓴 보고서는 그대로이고 교정 기록도 남지 않는다', async () => {
		addItem('0255', new Date(2026, 8, 19, 10));
		const ok = '| 쎈 중3-2<br/>0255 | 순간 |'; // 이미 두 줄이고 문제집도 맞으면 그대로
		const q = new ReportQueue(async () => ok);
		const { report } = await q.generateOrReuse({ topic: '대수', period: '', now: new Date(2026, 8, 19, 12) });
		const saved = readReport(report.id)!;
		expect(saved.markdown).toBe(ok);
		expect(saved.meta).not.toHaveProperty('workbook_corrections');
	});

	it('번호 없이 쓴 엉뚱한 문제집은 고치지 못하니 meta.stray_workbooks 로 알린다', async () => {
		addItem('0255', new Date(2026, 8, 19, 10));
		const q = new ReportQueue(async () => '0255 · 쎈 중3-2, 그리고 블랙라벨 중3-1 교재의 문제');
		const { report } = await q.generateOrReuse({ topic: '대수', period: '', now: new Date(2026, 8, 19, 12) });
		expect(readReport(report.id)!.meta?.stray_workbooks).toEqual(['블랙라벨 중3-1']);
	});
});

describe('본문 첫 제목', () => {
	it('AI 가 큰 제목을 써도 저장본에서는 빠지고 나머지는 그대로다', async () => {
		addItem('0255', new Date(2026, 8, 19, 10));
		const q = new ReportQueue(async () => '# 기하 영역 오답 코칭 편지 (최근 7일)\n\n안녕하세요.\n\n## 1. 한눈에');
		const { report } = await q.generateOrReuse({ topic: '대수', period: '', now: new Date(2026, 8, 19, 12) });
		expect(readReport(report.id)!.markdown).toBe('안녕하세요.\n\n## 1. 한눈에');
	});
});
