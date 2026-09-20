import type { Analysis } from '$lib/types';

export interface GuardrailResult {
	/** 정답·식 노출 의심. 저장하지 않고 분석 실패로 처리해 재시도한다 */
	violations: string[];
	/** 형식 경고. 저장하되 화면에 표시한다 */
	warnings: string[];
}

export const NUDGE_MAX_LENGTH = 200;

/** 답으로 이어지는 표현. "정답은 …", "올바른 식은 …", "답은 6입니다" 등 */
const LEAK_PHRASE = /정답(은|이)|올바른\s*(식|풀이|답|값|계산)|답은\s*\S+\s*(이다|입니다|이에요|예요)|(결과|값)은\s*\S+\s*(이다|입니다)/;
const HAS_EQUATION = /[=＝]/;
const IS_QUESTION = /[?？]\s*$/;

/**
 * 정답 발설 차단의 마지막 방어선. 1차 차단은 스키마에 정답을 담을 필드가 없다는 점이고,
 * 이 검사는 넛지·진단 문장에 답이 섞여 들어가는 것을 잡는다.
 * 학생이 쓴 (틀린) 식의 인용은 error_step·explanation·misconception 에 있을 수 있으므로 그 필드의 등식은 허용한다.
 */
export function checkGuardrail(a: Analysis): GuardrailResult {
	const ea = a.error_analysis;
	const violations: string[] = [];
	const warnings: string[] = [];

	// 학생에게 그대로 보이는 '질문형' 필드: 등식이 있으면 식·값 노출로 본다
	const questions: [string, string][] = [
		['넛지 Q1(조건 재확인)', ea.nudges.condition_question],
		['넛지 Q2(개념·전략 전환)', ea.nudges.strategy_question],
		['자기 점검', ea.self_check]
	];
	for (const [label, text] of questions) {
		if (HAS_EQUATION.test(text)) // 위반 메시지는 record.error 로 저장돼 화면에 표시되므로 원문을 인용하지 않는다
			violations.push(`${label}에 등식이 있음(식·값 노출 의심)`);
		if (!IS_QUESTION.test(text.trim())) warnings.push(`${label}이 질문 형태가 아님`);
		if (text.length > NUDGE_MAX_LENGTH) warnings.push(`${label}이 ${NUDGE_MAX_LENGTH}자를 넘음(${text.length}자)`);
	}

	// 진단 문장 전체: 답으로 이어지는 표현
	const prose: [string, string][] = [
		...questions,
		['최초 오류 지점', ea.error_step],
		['오류 설명', ea.explanation],
		['잘못된 규칙', ea.misconception],
		['발생 상황', ea.trigger]
	];
	for (const [label, text] of prose) {
		const m = text.match(LEAK_PHRASE);
		if (m) violations.push(`${label}에 정답 노출 표현 '${m[0]}'`);
	}
	return { violations, warnings };
}
