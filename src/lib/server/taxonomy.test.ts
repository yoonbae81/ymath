import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildAnalysisSchema, checkClassification, loadTaxonomy, parseTaxonomy } from './taxonomy';
import type { Analysis } from '$lib/types';

const MINI = `
안내문은 무시된다
## 대수
### 이차방정식 | 중3-1
- ALG-QUAD-SOLVE | 풀이
### 근과 계수 | 공통수학1
- ALG-ROOT-COEFF | 근과 계수의 관계
## 기하
### 삼각비 | 중3-1
- GEO-TRIG-RATIO | 삼각비
`;

describe('parseTaxonomy', () => {
	it('영역·단원·개념을 파싱한다', () => {
		const t = parseTaxonomy(MINI);
		expect(t.topics).toEqual(['대수', '기하']);
		expect(t.units.map((u) => u.name)).toEqual(['이차방정식', '근과 계수', '삼각비']);
		expect(t.conceptById.get('GEO-TRIG-RATIO')).toMatchObject({ unit: '삼각비', topic: '기하' });
		expect(t.unitByName.get('근과 계수')?.course).toBe('공통수학1');
	});

	it('영역을 추가하기만 하면 새 영역이 생긴다(코드 수정 불필요)', () => {
		const t = parseTaxonomy(`${MINI}\n## 통계학\n### 회귀분석 | 대학\n- STT-REGRESSION-LINEAR | 선형회귀\n`);
		expect(t.topics).toContain('통계학');
		expect(t.conceptById.has('STT-REGRESSION-LINEAR')).toBe(true);
	});

	it.each([
		['단원 중복', `${MINI}\n### 삼각비 | 중3-1\n- GEO-X-Y | x\n`],
		['개념 ID 중복', `${MINI}\n### 새 단원 | 중3\n- GEO-TRIG-RATIO | x\n`],
		['ID 형식 오류', '## 대수\n### 단원 | 과정\n- alg-lower | x\n'],
		['영역 없이 단원', '### 단원 | 과정\n- ALG-A-B | x\n'],
		['개념 없는 단원', '## 대수\n### 단원 | 과정\n'],
		['단원 없는 영역(## 메모 실수)', `${MINI}\n## 메모\n`],
		['영역 없음', '아무것도 없음']
	])('형식 위반은 예외: %s', (_name, md) => {
		expect(() => parseTaxonomy(md)).toThrow();
	});
});

describe('실제 user/prompts/curriculum.md', () => {
	const t = loadTaxonomy();

	it('영역 5개(고2 미적분 포함)가 있고 모든 단원에 개념이 있다', () => {
		expect(t.topics).toEqual(['대수', '함수', '기하', '확률통계', '미적분']);
		expect(t.units.every((u) => u.concepts.length > 0)).toBe(true);
	});

	it('스키마에 영역·단원·개념 enum 이 채워진다', () => {
		const schema = buildAnalysisSchema(t) as any;
		const cls = schema.properties.classification.properties;
		expect(cls.topic.enum).toEqual(t.topics);
		expect(cls.unit_major.enum).toContain('원의 방정식');
		expect(cls.concept_ids.items.enum).toContain('GEO-CIRCLE-EQ');
		expect(schema.properties.error_analysis.properties.root_cause_concept_ids.items.enum.length).toBe(
			t.conceptById.size
		);
		expect(schema.$comment).toBeUndefined();
	});
});

describe('checkClassification', () => {
	const t = parseTaxonomy(MINI);
	const make = (over: Partial<Analysis['classification']> = {}): Analysis =>
		({
			classification: {
				topic: '대수',
				unit_major: '이차방정식',
				concept_ids: ['ALG-QUAD-SOLVE'],
				...over
			},
			error_analysis: { root_cause_concept_ids: [] }
		}) as unknown as Analysis;

	it('정합이면 이슈 없음', () => expect(checkClassification(t, make())).toEqual([]));
	it('단원의 영역과 topic 이 다르면 이슈', () =>
		expect(checkClassification(t, make({ topic: '기하' })).join()).toContain('대수'));
	it('모르는 단원·개념 ID 는 이슈', () => {
		expect(checkClassification(t, make({ unit_major: '없는 단원' })).length).toBeGreaterThan(0);
		expect(checkClassification(t, make({ concept_ids: ['ALG-NOPE-X'] })).length).toBeGreaterThan(0);
	});
	it('다른 단원 소속 개념을 쓰는 것은 허용', () =>
		expect(checkClassification(t, make({ concept_ids: ['ALG-ROOT-COEFF'] }))).toEqual([]));
});

it('analysis.schema.json 은 enum 을 하드코딩하지 않는다', () => {
	const raw = JSON.parse(readFileSync('src/lib/server/analysis.schema.json', 'utf8'));
	expect(raw.properties.classification.properties.topic.enum).toBeUndefined();
	expect(raw.properties.classification.properties.unit_major.enum).toBeUndefined();
});

describe('학기 표시(과정)를 교재 목차와 대조한 값으로 고정한다', () => {
	const t = loadTaxonomy();
	const course = (unit: string) => t.unitByName.get(unit)?.course;

	it.each([
		// 중2 (2022 개정 교재 목차)
		['유리수와 순환소수', '중2-1'], ['식의 계산', '중2-1'], ['일차부등식과 연립일차방정식', '중2-1'],
		['일차함수와 그래프', '중2-2'], ['삼각형과 사각형의 성질', '중2-2'], ['도형의 닮음', '중2-2'], ['피타고라스 정리', '중2-2'], ['경우의 수', '중2-2'], ['확률', '중2-2'],
		// 중3: 이차함수까지 1학기, 삼각비·원의 성질·통계는 2학기 (이전 초안이 삼각비·통계를 중3-1로 잘못 적었다)
		['제곱근과 실수', '중3-1'], ['다항식의 곱셈과 인수분해', '중3-1'], ['이차방정식', '중3-1'], ['이차함수와 그래프', '중3-1'],
		['삼각비', '중3-2'], ['원의 성질', '중3-2'], ['대푯값과 산포도', '중3-2'],
		// 고1: 공통수학1 = 1학기, 공통수학2 = 2학기
		['다항식', '고1-1 공통수학1'], ['방정식과 부등식', '고1-1 공통수학1'], ['경우의 수와 순열·조합', '고1-1 공통수학1'], ['행렬', '고1-1 공통수학1'],
		['평면좌표와 직선의 방정식', '고1-2 공통수학2'], ['원의 방정식', '고1-2 공통수학2'], ['도형의 이동', '고1-2 공통수학2'],
		['집합과 명제', '고1-2 공통수학2'], ['함수', '고1-2 공통수학2'], ['유리함수와 무리함수', '고1-2 공통수학2'],
		// 고2
		['수열', '고2-1 대수'], ['지수함수와 로그함수', '고2-1 대수'], ['삼각함수', '고2-1 대수'],
		['함수의 극한과 연속', '고2-2 미적분Ⅰ'], ['미분', '고2-2 미적분Ⅰ'], ['적분', '고2-2 미적분Ⅰ'],
		['중복순열·중복조합과 이항정리', '고2-2 확률과 통계'], ['확률과 조건부확률', '고2-2 확률과 통계'], ['확률분포와 통계적 추정', '고2-2 확률과 통계']
	])('%s → %s', (unit, expected) => {
		expect(course(unit)).toBe(expected);
	});

	it('고1 단원은 모두 학기(고1-1/고1-2)가, 고2 단원은 고2-1/고2-2 가 붙어 있다', () => {
		for (const u of t.units) {
			if (/공통수학/.test(u.course)) expect(u.course, u.name).toMatch(/^고1-[12] 공통수학[12]$/);
			if (/^고2/.test(u.course)) expect(u.course, u.name).toMatch(/^고2-[12] /);
		}
	});

	it('영역 배정: 미적분은 극한·미분·적분, 수열은 대수, 지수·로그·삼각함수는 함수', () => {
		const topicOf = (unit: string) => t.unitByName.get(unit)?.topic;
		for (const u of ['함수의 극한과 연속', '미분', '적분']) expect(topicOf(u)).toBe('미적분');
		expect(topicOf('수열')).toBe('대수');
		expect(topicOf('지수함수와 로그함수')).toBe('함수');
		expect(topicOf('삼각함수')).toBe('함수');
	});
});
