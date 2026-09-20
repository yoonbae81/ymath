import { describe, expect, it } from 'vitest';
import { NUDGE_MAX_LENGTH, checkGuardrail } from './guardrail';
import type { Analysis } from '$lib/types';

const make = (over: Partial<Analysis['error_analysis']> = {}, nudges: Partial<Analysis['error_analysis']['nudges']> = {}) =>
	({
		error_analysis: {
			error_step: '3행의 이항 과정',
			explanation: '해를 구한 뒤 문제가 요구한 수의 종류를 확인하지 않았습니다.',
			misconception: '부등식의 해가 곧 답의 범위라고 생각함',
			trigger: '해의 개수를 세는 문제',
			self_check: '내가 구한 값이 문제가 요구한 수의 종류에 모두 해당하는지 확인했나요?',
			nudges: {
				condition_question: '문제 마지막 문장에서 x는 어떤 수라고 했나요?',
				strategy_question: '구한 범위를 수직선에 나타내고 조건에 맞는 점만 골라 보면 어떨까요?',
				...nudges
			},
			...over
		}
	}) as unknown as Analysis;

describe('checkGuardrail', () => {
	it('정상적인 넛지는 통과', () => {
		expect(checkGuardrail(make())).toEqual({ violations: [], warnings: [] });
	});

	it('넛지·자기점검에 등식이 있으면 위반(식·값 노출 의심)', () => {
		for (const [over, nudges] of [
			[{}, { condition_question: 'x=6 이 조건에 맞나요?' }],
			[{}, { strategy_question: '$2x \\le 12$ 에서 $x=6$ 이면 어떤가요?' }],
			[{ self_check: 'x = 3 을 대입해 확인했나요?' }, {}],
			[{}, { condition_question: 'a＝b 인가요?' }] // 전각 등호
		] as const)
			expect(checkGuardrail(make({ ...over }, { ...nudges })).violations.length, JSON.stringify([over, nudges])).toBeGreaterThan(0);
	});

	it('진단 문장에 정답을 알려 주는 표현이 있으면 위반', () => {
		for (const text of ['정답은 6입니다.', '정답이 아니에요', '올바른 식은 x≤6 이에요', '답은 6개입니다', '올바른 풀이는 이렇습니다']) {
			expect(checkGuardrail(make({ explanation: text })).violations.length, text).toBeGreaterThan(0);
			expect(checkGuardrail(make({}, { strategy_question: `${text} 다시 볼까요?` })).violations.length, text).toBeGreaterThan(0);
		}
	});

	it('학생이 쓴(틀린) 식을 인용하는 것은 진단 필드에서 허용', () => {
		const r = checkGuardrail(
			make({
				error_step: '2행 $\\alpha^2+\\beta^2=(\\alpha+\\beta)^2+2\\alpha\\beta$',
				explanation: '2행에서 $2\\alpha\\beta$ 항의 처리가 어긋났습니다.',
				misconception: '$a^2+b^2=(a+b)^2+2ab$ 라고 생각함'
			})
		);
		expect(r.violations).toEqual([]);
	});

	it('질문 형태가 아니거나 너무 길면 경고(저장은 함)', () => {
		const r = checkGuardrail(make({}, { condition_question: '조건을 다시 확인하세요.', strategy_question: `${'가'.repeat(NUDGE_MAX_LENGTH + 1)}요?` }));
		expect(r.violations).toEqual([]);
		expect(r.warnings.length).toBe(2);
		expect(r.warnings.join()).toContain('질문 형태가 아님');
		expect(r.warnings.join()).toContain('넘음');
	});

	it('위반 메시지는 원문을 인용하지 않는다(record.error 로 화면에 노출되므로)', () => {
		const r = checkGuardrail(make({}, { condition_question: 'x=6 이 정말 맞나요?' }));
		expect(r.violations.join()).not.toContain('x=6');
	});
});
