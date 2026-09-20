import { describe, expect, it } from 'vitest';
import { buildPrompt, parseClaudeOutput, promptVersion, validateAnalysis } from './analyze';
import { buildAnalysisSchema, loadTaxonomy } from './taxonomy';
import { validAnalysis } from './analysis.fixture';
import type { ItemRecord } from '$lib/types';

const record = { workbook: { id: 'w', name: '개념원리 공통수학1', publisher: '개념원리', grade: '고1', semester: 1 } } as ItemRecord;

const valid = validAnalysis;

describe('parseClaudeOutput', () => {
	it('structured_output 을 우선 사용한다', () => {
		expect(parseClaudeOutput(JSON.stringify({ structured_output: { a: 1 }, result: 'x' }))).toEqual({ a: 1 });
	});
	it('structured_output 이 없으면 result 의 JSON 을 쓴다', () => {
		expect(parseClaudeOutput(JSON.stringify({ result: '{"a":2}' }))).toEqual({ a: 2 });
	});
	it('is_error 면 예외', () => {
		expect(() => parseClaudeOutput(JSON.stringify({ is_error: true, result: 'boom' }))).toThrow(/boom/);
	});
	it('JSON 이 아니거나 결과가 없으면 예외', () => {
		expect(() => parseClaudeOutput('garbage')).toThrow();
		expect(() => parseClaudeOutput(JSON.stringify({ result: '그냥 말' }))).toThrow();
	});
});

describe('validateAnalysis (실제 curriculum 으로 만든 스키마)', () => {
	const schema = buildAnalysisSchema(loadTaxonomy());

	it('정상 출력은 통과', () => expect(() => validateAnalysis(schema, valid())).not.toThrow());

	it('curriculum 에 없는 영역·단원·개념은 거부', () => {
		for (const mutate of [
			(a: any) => (a.classification.topic = '통계학'), // curriculum 에 없는 영역
			(a: any) => (a.classification.unit_major = '없는 단원'),
			(a: any) => (a.classification.concept_ids = ['NOPE-X']),
			(a: any) => (a.error_analysis.root_cause_concept_ids = ['NOPE-X'])
		]) {
			const a = valid();
			mutate(a);
			expect(() => validateAnalysis(schema, a)).toThrow(/스키마/);
		}
	});

	it('필수 필드 누락·잘못된 enum·패턴 ID 형식 오류는 거부', () => {
		for (const mutate of [
			(a: any) => delete a.error_analysis.misconception,
			(a: any) => (a.error_analysis.severity = 4),
			(a: any) => (a.error_analysis.error_type = '몰라'),
			(a: any) => (a.error_analysis.error_type = '개념 부족'), // 옛 분류는 더 이상 허용하지 않는다
			(a: any) => delete a.error_analysis.nudges,
			(a: any) => delete a.error_analysis.nudges.strategy_question,
			(a: any) => delete a.verification,
			(a: any) => (a.error_analysis.error_pattern_id = 'Bad ID'),
			(a: any) => (a.extra = 1)
		]) {
			const a = valid();
			mutate(a);
			expect(() => validateAnalysis(schema, a)).toThrow();
		}
	});
});

describe('정답 발설 원천 차단(스키마)', () => {
	const schema = buildAnalysisSchema(loadTaxonomy());
	const keys = (o: unknown, out: string[] = []): string[] => {
		if (o && typeof o === 'object')
			for (const [k, v] of Object.entries(o)) {
				out.push(k);
				keys(v, out);
			}
		return out;
	};

	it('정답·풀이·올바른 접근을 담는 필드가 스키마 어디에도 없다', () => {
		const all = keys(schema);
		for (const forbidden of ['reference_solution', 'final_answer', 'steps_md', 'correct_approach', 'recognition_cue', 'correct_answer', 'solution'])
			expect(all, forbidden).not.toContain(forbidden);
	});

	it('정답을 끼워 넣을 수 있는 추가 속성도 허용하지 않는다', () => {
		const a: any = valid();
		a.reference_solution = { final_answer: '13' };
		expect(() => validateAnalysis(schema, a)).toThrow();
		const b: any = valid();
		b.error_analysis.correct_approach = '…';
		expect(() => validateAnalysis(schema, b)).toThrow();
	});
});

describe('buildPrompt', () => {
	const taxonomy = loadTaxonomy();
	const base = { guideline: '# 지침\n본문', taxonomy, record, imagePath: '/x/image.jpg' };

	it('지침, 분류 체계, 패턴, 사진 경로, OCR 을 모두 담는다', () => {
		const p = buildPrompt({
			...base,
			patterns: [{ id: 'sign-error-expansion', count: 3, example: '부호 착각' }],
			ocrText: '$x^2$'
		});
		expect(p).toContain('# 지침');
		expect(p).toContain('## 영역: 기하');
		expect(p).toContain('GEO-CIRCLE-EQ');
		expect(p).toContain('sign-error-expansion (3회): 부호 착각');
		expect(p).toContain('개념원리 공통수학1');
		expect(p).toContain('/x/image.jpg');
		expect(p).toContain('$x^2$');
	});

	it('재시도 힌트가 있을 때만 직전 문제점 섹션이 들어간다', () => {
		const without = buildPrompt({ ...base, patterns: [], ocrText: 'x' });
		expect(without).not.toContain('직전 시도의 문제점');
		const withHint = buildPrompt({ ...base, patterns: [], ocrText: 'x', hint: '넛지 Q1에 등식이 있음' });
		expect(withHint).toContain('직전 시도의 문제점');
		expect(withHint).toContain('넛지 Q1에 등식이 있음');
	});

	it('OCR 이 없거나 패턴이 없어도 안내 문구가 들어간다', () => {
		const p = buildPrompt({ ...base, patterns: [], ocrText: '  ' });
		expect(p).toContain('OCR 결과 없음');
		expect(p).toContain('아직 없음');
	});
});

describe('promptVersion', () => {
	it('지침이나 분류 체계가 바뀌면 달라지고, 같으면 같다', () => {
		expect(promptVersion('a', 'b')).toBe(promptVersion('a', 'b'));
		expect(promptVersion('a', 'b')).not.toBe(promptVersion('a2', 'b'));
		expect(promptVersion('a', 'b')).not.toBe(promptVersion('a', 'b2'));
		expect(promptVersion('ab', 'c')).not.toBe(promptVersion('a', 'bc'));
	});
});
