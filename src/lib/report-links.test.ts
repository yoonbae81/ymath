import { describe, expect, it } from 'vitest';
import { linkifyProblemRefs, problemRefsFrom, type ProblemRef } from './report-links';
import { renderMarkdown } from './math';

const A = (id: string, number: string, workbook = '쎈 중3-2'): ProblemRef => ({ id, number, workbook });
const href = (id: string) => `./items?id=${id}`;
const REFS = [A('id0396', '0396'), A('id0394', '0394'), A('id0388', '0388'), A('id0381', '0381'), A('id0339', '0339'), A('id0252', '0252', '쎈 중3-1'), A('id20', '20', '개념원리 공통수학2')];
const link = (t: string, id: string) => `[${t}](./items?id=${id})`;

describe('linkifyProblemRefs — 실제 보고서 본문 형태', () => {
	it('번호만 쓴 문장 속 언급을 모두 링크한다', () => {
		const out = linkifyProblemRefs('0388에서는 삼각형이, 0381에서는 비례식의 값이, 0394에서는 $r$이 그랬어요.', REFS, href);
		expect(out).toBe(`${link('0388', 'id0388')}에서는 삼각형이, ${link('0381', 'id0381')}에서는 비례식의 값이, ${link('0394', 'id0394')}에서는 $r$이 그랬어요.`);
	});

	it('괄호·쉼표로 나열된 번호도 링크한다', () => {
		const out = linkifyProblemRefs('호의 길이(0339), 접선의 길이(0394)처럼 / 0396, 0394, 0252처럼', REFS, href);
		for (const [n, id] of [['0339', 'id0339'], ['0394', 'id0394'], ['0396', 'id0396'], ['0252', 'id0252']]) expect(out).toContain(link(n, id));
		expect((out.match(/\]\(/g) ?? []).length).toBe(5);
	});

	it('표 셀의 "번호 · 문제집" 전체를 하나의 링크로 만든다', () => {
		const out = linkifyProblemRefs('| 0396 · 쎈 중3-2 | 처음 멈칫한 순간 |', REFS, href);
		expect(out).toBe(`| ${link('0396 · 쎈 중3-2', 'id0396')} | 처음 멈칫한 순간 |`);
	});

	it('대괄호 표기 "[0394] 쎈 중3-2 (…)" 도 하나의 링크로 만든다', () => {
		const out = linkifyProblemRefs('**[0394] 쎈 중3-2 (삼각형의 내접원)**', REFS, href);
		expect(out).toBe(`**${link('0394 쎈 중3-2', 'id0394')} (삼각형의 내접원)**`);
	});

	it('"[20번] 개념원리 공통수학2 (…)" 처럼 번이 대괄호 안에 있어도 하나의 링크', () => {
		const out = linkifyProblemRefs('**[20번] 개념원리 공통수학2 (각의 이등분선과 좌표)**', REFS, href);
		expect(out).toBe(`**${link('20번 개념원리 공통수학2', 'id20')} (각의 이등분선과 좌표)**`);
		expect(linkifyProblemRefs('| 20번 · 개념원리 공통수학2 | x |', REFS, href)).toBe(`| ${link('20번 · 개념원리 공통수학2', 'id20')} | x |`);
		expect(linkifyProblemRefs('[20번] 만', REFS, href)).toBe(`${link('20번', 'id20')} 만`);
	});

	it('짧은 번호는 "20번" 처럼 뒤에 번이 있을 때만 링크한다', () => {
		const out = linkifyProblemRefs('제곱한 길이의 비(20번)와 20번째 줄, 그리고 값 20', REFS, href);
		expect(out).toContain(`(${link('20번', 'id20')})`);
		expect(out.match(/\]\(/g)).toHaveLength(1); // "20번째", 단독 "20" 은 링크하지 않는다
	});
});

describe('linkifyProblemRefs — 잘못 거는 것을 막는 규칙', () => {
	it('수식·코드·기존 링크 안의 번호는 건드리지 않는다', () => {
		const md = '$0381 + 1$ 와 `0381` 와 [0381](/x) 와 그냥 0381';
		const out = linkifyProblemRefs(md, REFS, href);
		expect(out).toBe(`$0381 + 1$ 와 \`0381\` 와 [0381](/x) 와 그냥 ${link('0381', 'id0381')}`);
	});

	it('단위가 붙은 숫자와 더 긴 숫자의 일부는 문제 번호가 아니다', () => {
		const out = linkifyProblemRefs('길이 0381cm, 각 0381°, 비율 0381%, 값 10381, 소수 1.0381', REFS, href);
		expect(out).toBe('길이 0381cm, 각 0381°, 비율 0381%, 값 10381, 소수 1.0381');
	});

	it('같은 번호가 여러 항목이면 번호만 쓴 언급은 링크하지 않고, 문제집 이름이 있으면 그걸로 가른다', () => {
		const refs = [A('a', '0255', '쎈 중3-1'), A('b', '0255', '블랙라벨 중3-1')];
		expect(linkifyProblemRefs('0255 는 어느 것?', refs, href)).toBe('0255 는 어느 것?');
		expect(linkifyProblemRefs('0255 · 블랙라벨 중3-1', refs, href)).toBe('[0255 · 블랙라벨 중3-1](./items?id=b)');
		expect(linkifyProblemRefs('0255 · 쎈 중3-1', refs, href)).toBe('[0255 · 쎈 중3-1](./items?id=a)');
	});

	it('문제집 이름의 공백이 달라도 맞는다', () => {
		expect(linkifyProblemRefs('0396 · 쎈중3-2', REFS, href)).toBe(`${link('0396 · 쎈중3-2', 'id0396')}`);
		expect(linkifyProblemRefs('0396 쎈 중 3-2', REFS, href)).toBe(`${link('0396 쎈 중 3-2', 'id0396')}`);
	});

	it('항목이 없으면 원문 그대로', () => {
		expect(linkifyProblemRefs('0381', [], href)).toBe('0381');
	});
});

describe('problemRefsFrom', () => {
	const item = (id: string, guess: string | null, wb = '쎈 중3-2') =>
		({ id, workbook: { name: wb }, analysis: guess === null ? null : { problem: { number_guess: guess } } }) as never;

	it('번호 뒤에 설명이 붙어도 앞의 숫자만 쓰고, 번호가 없는 항목은 뺀다', () => {
		const refs = problemRefsFrom([item('a', '0359(추정, 번호가 가려져 있음)'), item('b', ''), item('c', null), item('d', '12.')]);
		expect(refs).toEqual([
			{ id: 'a', number: '0359', workbook: '쎈 중3-2' },
			{ id: 'd', number: '12', workbook: '쎈 중3-2' }
		]);
	});
});

describe('링크가 실제 화면(HTML)까지 이어진다', () => {
	it('표 셀의 링크가 <a> 로 그려진다', () => {
		const md = linkifyProblemRefs(['| 문제 | 순간 |', '|---|---|', '| 0396 · 쎈 중3-2 | 반지름 $r$ |'].join('\n'), REFS, href);
		const html = renderMarkdown(md);
		expect(html).toContain('<a href="./items?id=id0396" class="problem-link" target="_blank" rel="noreferrer"><span class="badge wb">쎈 중3-2</span><span class="badge pnum">0396</span></a>');
		expect(html).toContain('class="katex"'); // 수식은 그대로
	});
});

// ───────────── 문제집 이름 교정 ─────────────
import { normalizeWorkbookMentions, problemLabel, problemNumber } from './report-links';

describe('normalizeWorkbookMentions — 실제 사고: 단원의 학기 표시(중3-1)를 출판사에 붙여 "쎈 중3-1" 이라고 씀', () => {
	const PUBS = ['개념원리', 'RPM', '쎈', '마플', '블랙라벨', '최상위'];
	// 실제 항목: 0255·0252 는 쎈 중3-2, 20 은 개념원리 공통수학2
	const refs = [A('a0255', '0255'), A('a0252', '0252'), A('a0396', '0396'), A('a20', '20', '개념원리 공통수학2')];

	it('표의 "번호 · 문제집" 에서 틀린 학기를 바로잡는다', () => {
		const md = ['| 문제 | 순간 |', '|---|---|', '| 0255 · 쎈 중3-1 | 30° 삼각형 |', '| 0252 · 쎈 중3-1 | 보조선 |', '| 0396 · 쎈 중3-2 | 반지름 |'].join('\n');
		const r = normalizeWorkbookMentions(md, refs, PUBS);
		expect(r.markdown).toContain('| 0255 · 쎈 중3-2 |');
		expect(r.markdown).toContain('| 0252 · 쎈 중3-2 |');
		expect(r.markdown).not.toContain('중3-1');
		expect(r.corrections).toEqual([
			{ number: '0255', from: '쎈 중3-1', to: '쎈 중3-2' },
			{ number: '0252', from: '쎈 중3-1', to: '쎈 중3-2' }
		]);
		expect(r.stray).toEqual([]);
	});

	it('대괄호 표기 "**[0255] 쎈 중3-1 (삼각비)**" 도 바로잡는다', () => {
		const r = normalizeWorkbookMentions('**[0255] 쎈 중3-1 (삼각비, 구하는 것은 $x$)**', refs, PUBS);
		expect(r.markdown).toBe('**[0255] 쎈 중3-2 (삼각비, 구하는 것은 $x$)**');
	});

	it('출판사까지 틀려도, 학기 없이 공통수학 꼴이어도 바로잡는다', () => {
		expect(normalizeWorkbookMentions('20번 · 쎈 공통수학1', refs, PUBS).markdown).toBe('20번 · 개념원리 공통수학2');
		expect(normalizeWorkbookMentions('0255 · 블랙라벨 중3-1', refs, PUBS).markdown).toBe('0255 · 쎈 중3-2');
	});

	it('공백이 달라도 같은 이름이면 그대로 둔다(불필요한 변경 없음)', () => {
		const md = '0255 · 쎈중3-2, 0396 · 쎈 중 3-2';
		const r = normalizeWorkbookMentions(md, refs, PUBS);
		expect(r.markdown).toBe(md);
		expect(r.corrections).toEqual([]);
	});

	it('멱등: 이미 교정된 결과에 다시 적용해도 그대로', () => {
		const once = normalizeWorkbookMentions('| 0255 · 쎈 중3-1 |', refs, PUBS).markdown;
		const twice = normalizeWorkbookMentions(once, refs, PUBS);
		expect(twice.markdown).toBe(once);
		expect(twice.corrections).toEqual([]);
	});

	it('같은 번호가 서로 다른 문제집에 있으면 어느 쪽인지 모르므로 건드리지 않는다', () => {
		const dup = [A('x', '0255', '쎈 중3-2'), A('y', '0255', '블랙라벨 중3-2')];
		const md = '0255 · 쎈 중3-1';
		expect(normalizeWorkbookMentions(md, dup, PUBS).markdown).toBe(md);
	});

	it('같은 번호가 같은 문제집에 두 번(재업로드) 있으면 교정한다', () => {
		const same = [A('x', '0255'), A('y', '0255')];
		expect(normalizeWorkbookMentions('0255 · 쎈 중3-1', same, PUBS).markdown).toBe('0255 · 쎈 중3-2');
	});

	it('번호와 무관한 위치의 문제집 표기, 수식·코드 안은 건드리지 않는다', () => {
		const md = '쎈 중3-1 교재의 0255 와 `0255 · 쎈 중3-1` 와 $0255 · 쎈 중3-1$';
		const r = normalizeWorkbookMentions(md, refs, PUBS);
		expect(r.markdown).toBe(md);
		expect(r.corrections).toEqual([]);
	});

	it('번호 없이 쓴 엉뚱한 문제집 표기는 고치지 못하므로 stray 로 알린다', () => {
		const r = normalizeWorkbookMentions('이번 쎈 중3-2 와 블랙라벨 중3-1 교재에서 나온 문제들', refs, PUBS);
		expect(r.stray).toEqual(['블랙라벨 중3-1']); // 쎈 중3-2 는 이 보고서의 문제집이라 정상
	});

	it('다른 숫자의 일부에는 걸리지 않는다', () => {
		const md = '10255 · 쎈 중3-1';
		expect(normalizeWorkbookMentions(md, refs, PUBS).markdown).toBe(md);
	});

	it('항목이 없거나 출판사 목록이 없으면 원문 그대로', () => {
		expect(normalizeWorkbookMentions('0255 · 쎈 중3-1', [], PUBS).markdown).toBe('0255 · 쎈 중3-1');
		expect(normalizeWorkbookMentions('0255 · 쎈 중3-1', refs, []).markdown).toBe('0255 · 쎈 중3-1');
	});

	it('교정한 결과에는 링크 로직이 그대로 이어진다(교정 → 링크)', () => {
		const fixed = normalizeWorkbookMentions('| 0255 · 쎈 중3-1 |', refs, PUBS).markdown;
		expect(linkifyProblemRefs(fixed, refs, href)).toBe('| [0255 · 쎈 중3-2](./items?id=a0255) |');
	});
});

describe('problemLabel / problemNumber', () => {
	const item = (guess: string | null, wb = '쎈 중3-2') => ({ id: 'i', workbook: { name: wb }, analysis: guess === null ? null : { problem: { number_guess: guess } } }) as never;
	it('"번호 · 문제집" 형태이고, 설명이 붙은 번호는 숫자만 쓴다', () => {
		expect(problemLabel(item('0255'))).toBe('0255 · 쎈 중3-2');
		expect(problemLabel(item('0359(추정, 번호가 가려져 있음)'))).toBe('0359 · 쎈 중3-2');
		expect(problemNumber(item('20번'))).toBe('20');
	});
	it('번호를 읽지 못했으면 문제집 이름만', () => {
		expect(problemLabel(item(''))).toBe('쎈 중3-2 (번호 미확인)');
		expect(problemLabel(item(null))).toBe('쎈 중3-2 (번호 미확인)');
	});
});

// ───────────── 표의 문제 열: 문제집<br/>문제번호 ─────────────
import { formatProblemCells } from './report-links';

describe('formatProblemCells', () => {
	const PUBS = ['개념원리', 'RPM', '쎈', '마플', '블랙라벨', '최상위'];
	const refs = [A('a0255', '0255'), A('a0396', '0396'), A('a20', '20', '개념원리 공통수학2')];
	const table = (...rows: string[]) => ['| 문제 | 순간 | 열쇠 |', '|---|---|---|', ...rows].join('\n');

	it('"번호 · 문제집" 을 "문제집<br/>번호" 두 줄로 바꾼다', () => {
		const out = formatProblemCells(table('| 0396 · 쎈 중3-2 | 반지름 | 접선 |', '| 20번 · 개념원리 공통수학2 | 첫 줄 | 비 |'), refs, PUBS);
		expect(out).toContain('| 쎈 중3-2<br/>0396 | 반지름 | 접선 |');
		expect(out).toContain('| 개념원리 공통수학2<br/>20번 | 첫 줄 | 비 |');
		expect(out.split('\n').slice(0, 2).join('\n')).toBe('| 문제 | 순간 | 열쇠 |\n|---|---|---|'); // 머리글·구분 줄은 그대로
	});

	it('대괄호·다른 구분 기호·문제집 먼저 쓴 형태도 같은 결과', () => {
		for (const cell of ['[0396] 쎈 중3-2', '0396 쎈 중3-2', '0396, 쎈중3-2', '쎈 중3-2 · 0396', '쎈 중3-2<br>0396', '쎈 중3-2<br />0396'])
			expect(formatProblemCells(table(`| ${cell} | x | y |`), refs, PUBS), cell).toContain('| 쎈 중3-2<br/>0396 | x | y |');
	});

	it('이미 두 줄이면 그대로(멱등)', () => {
		const once = formatProblemCells(table('| 0396 · 쎈 중3-2 | x | y |'), refs, PUBS);
		expect(formatProblemCells(once, refs, PUBS)).toBe(once);
	});

	it('번호로 문제집이 정해지면 틀린 문제집 이름도 실제 이름으로 쓴다', () => {
		expect(formatProblemCells(table('| 0255 · 쎈 중3-1 | x | y |'), refs, PUBS)).toContain('| 쎈 중3-2<br/>0255 | x | y |');
	});

	it('같은 번호가 여러 문제집이면 쓴 문제집을 그대로 쓴다', () => {
		const dup = [A('x', '0255', '쎈 중3-2'), A('y', '0255', '블랙라벨 중3-2')];
		expect(formatProblemCells(table('| 0255 · 블랙라벨 중3-2 | x | y |'), dup, PUBS)).toContain('| 블랙라벨 중3-2<br/>0255 |');
	});

	it('다른 글이 섞인 셀, 첫 열이 아닌 셀, 표가 아닌 줄은 건드리지 않는다', () => {
		const md = [
			table('| 0396 · 쎈 중3-2 에서 멈춤 | 0255 · 쎈 중3-2 | y |'),
			'0396 · 쎈 중3-2 는 표가 아닌 문장',
			'| 0396 · 쎈 중3-2 |' // 열이 하나뿐인 줄
		].join('\n');
		expect(formatProblemCells(md, refs, PUBS)).toBe(md);
	});

	it('나머지 열의 수식(|x|)과 \\| 이스케이프는 원문 그대로 유지한다', () => {
		const row = '| 0396 · 쎈 중3-2 | $|x-1|<3$ 에서 멈춤 | a \\| b |';
		const out = formatProblemCells(table(row), refs, PUBS);
		expect(out).toContain('| 쎈 중3-2<br/>0396 | $|x-1|<3$ 에서 멈춤 | a \\| b |');
	});

	it('출판사 목록이 없으면 원문 그대로', () => {
		const md = table('| 0396 · 쎈 중3-2 | x | y |');
		expect(formatProblemCells(md, refs, [])).toBe(md);
	});
});

describe('새 표기(문제집<br/>번호)에서도 교정·링크가 동작한다', () => {
	const PUBS = ['개념원리', 'RPM', '쎈', '마플', '블랙라벨', '최상위'];
	const refs = [A('a0255', '0255'), A('a20', '20', '개념원리 공통수학2')];

	it('틀린 문제집을 바로잡는다', () => {
		const r = normalizeWorkbookMentions('| 쎈 중3-1<br/>0255 | x |', refs, PUBS);
		expect(r.markdown).toBe('| 쎈 중3-2<br/>0255 | x |');
		expect(r.corrections).toEqual([{ number: '0255', from: '쎈 중3-1', to: '쎈 중3-2' }]);
	});

	it('셀 전체를 하나의 링크로 만든다(줄바꿈 포함)', () => {
		expect(linkifyProblemRefs('| 쎈 중3-2<br/>0255 | x |', refs, href)).toBe('| [쎈 중3-2<br/>0255](./items?id=a0255) | x |');
		expect(linkifyProblemRefs('| 개념원리 공통수학2<br/>20번 | x |', refs, href)).toBe('| [개념원리 공통수학2<br/>20번](./items?id=a20) | x |');
	});

	it('교정 → 형식 통일 → 링크 → 렌더링이 이어져 두 줄 링크 셀이 된다', () => {
		let md = ['| 문제 | 순간 |', '|---|---|', '| 0255 · 쎈 중3-1 | 30° 삼각형 |'].join('\n');
		md = normalizeWorkbookMentions(md, refs, PUBS).markdown;
		md = formatProblemCells(md, refs, PUBS);
		md = linkifyProblemRefs(md, refs, href);
		const html = renderMarkdown(md);
		expect(html).toContain('<td><a href="./items?id=a0255" class="problem-link" target="_blank" rel="noreferrer"><span class="badge wb">쎈 중3-2</span><span class="badge pnum">0255</span></a></td>');
	});
});

// ───────────── 본문 첫 제목 제거 ─────────────
import { stripLeadingTitle } from './report-links';

describe('stripLeadingTitle', () => {
	it('맨 앞의 큰 제목 한 줄을 떼고 뒤의 빈 줄도 정리한다', () => {
		expect(stripLeadingTitle('# 기하 오답 코칭 편지 (최근 7일)\n\n안녕하세요.\n\n## 1. 절')).toBe('안녕하세요.\n\n## 1. 절');
	});

	it('앞에 빈 줄이 있어도 뗀다', () => {
		expect(stripLeadingTitle('\n\n# 제목\n본문')).toBe('본문');
	});

	it('제목이 없으면 그대로', () => {
		const md = '안녕하세요.\n\n> 💡 **요약**';
		expect(stripLeadingTitle(md)).toBe(md);
	});

	it('## 이하 제목, 본문 중간의 # 제목은 건드리지 않는다', () => {
		expect(stripLeadingTitle('## 1. 절\n본문')).toBe('## 1. 절\n본문');
		const mid = '인사\n\n# 중간 제목\n본문';
		expect(stripLeadingTitle(mid)).toBe(mid);
	});

	it('#해시태그 처럼 # 뒤에 공백이 없는 줄은 제목이 아니다', () => {
		expect(stripLeadingTitle('#해시태그 문장')).toBe('#해시태그 문장');
	});

	it('빈 문서, 제목뿐인 문서도 안전하다', () => {
		expect(stripLeadingTitle('')).toBe('');
		expect(stripLeadingTitle('# 제목만')).toBe('');
	});

	it('여러 번 적용해도 결과가 같다(멱등)', () => {
		const once = stripLeadingTitle('# 제목\n\n본문');
		expect(stripLeadingTitle(once)).toBe(once);
	});
});
