import { describe, expect, it } from 'vitest';
import { renderMath, renderMarkdown } from './math';

describe('renderMath', () => {
	it('인라인·디스플레이 수식을 KaTeX 로 렌더링한다', () => {
		expect(renderMath('값은 $x^2$ 이다')).toContain('class="katex"');
		expect(renderMath('$$\\frac{a}{b}$$')).toContain('katex-display');
	});

	it('수식이 아닌 구간의 HTML 은 이스케이프한다(주입 방지)', () => {
		const html = renderMath('<img src=x onerror=alert(1)> 와 <script>x</script>');
		expect(html).not.toContain('<img');
		expect(html).not.toContain('<script');
		expect(html).toContain('&lt;img');
	});

	it('수식 안의 부등호는 깨지지 않는다', () => {
		const html = renderMath('$a < b$');
		expect(html).toContain('class="katex"');
		expect(html).not.toContain('&amp;lt;');
	});

	it('잘못된 수식도 예외 없이 처리한다', () => {
		expect(() => renderMath('$\\frac{$')).not.toThrow();
		expect(() => renderMath('$\\badcommand{x}$')).not.toThrow();
	});

	it('짝이 없는 $ 는 그대로 둔다', () => {
		expect(renderMath('가격은 $5 입니다')).toBe('가격은 $5 입니다');
	});

	it('줄바꿈과 굵게를 처리한다', () => {
		expect(renderMath('a\nb **c**')).toBe('a<br>b <strong>c</strong>');
	});

	it('따옴표와 특수문자를 안전하게 엔티티로 변환한다(속성 주입 방지)', () => {
		const html = renderMath('테스트 "따옴표"와 \'작은따옴표\' & <태그>');
		expect(html).toContain('&quot;따옴표&quot;');
		expect(html).toContain('&#39;작은따옴표&#39;');
		expect(html).toContain('&amp;');
		expect(html).toContain('&lt;태그&gt;');
	});

	it('KaTeX 보안 설정: trust=false 로 위험 명령어를 차단한다', () => {
		const html = renderMath('$\\href{javascript:alert(1)}{click}$');
		expect(html).not.toContain('<a ');
		expect(html).not.toContain('href="javascript');
	});
});

describe('renderMarkdown', () => {
	it('제목, 목록, 수식을 올바른 HTML 로 변환한다', () => {
		const md = [
			'# 대수 보고서',
			'',
			'- 첫 번째 항목: $x+1=2$',
			'- 두 번째 항목: **중요**',
			'',
			'1. 순서 목록'
		].join('\n');

		const html = renderMarkdown(md);
		expect(html).toContain('<h1>대수 보고서</h1>');
		expect(html).toContain('<ul class="label-list">');
		expect(html).toContain('<li>첫 번째 항목: <span class="katex">');
		expect(html).toContain('<li>두 번째 항목: <strong>중요</strong></li>');
		expect(html).toContain('</ul>');
		expect(html).toContain('<ol class="step-list">');
		expect(html).toContain('<li><span class="step-num">1</span><span class="step-body">순서 목록</span></li>');
		expect(html).toContain('</ol>');
	});
});


describe('renderMarkdown 표(GFM)', () => {
	const REPORT_TABLE = [
		'## 1. 이번 오답 한눈에 돌아보기',
		'',
		'| 문제 | 처음 멈칫했던 순간 | 놓쳤던 생각의 열쇠 |',
		'|---|---|---|',
		'| 0396 · 쎈 중3-2 | 반지름 $r$을 곧바로 $(2r-6)^2=100$ 하나로 묶은 순간 | 접선 길이가 같다는 성질 |',
		'| 0394 · 쎈 중3-2 | $2\\sqrt{3}-r$ 처럼 $r$을 뺀 순간 | 두 접선의 길이는 같다 |',
		'',
		'표 아래 문단'
	].join('\n');

	it('실제 보고서의 3열 표를 <table> 로 그린다(문단으로 뭉개지지 않음)', () => {
		const html = renderMarkdown(REPORT_TABLE);
		expect(html).toContain('<table>');
		expect(html.match(/<th[\s>]/g)).toHaveLength(3);
		expect(html.match(/<tr>/g)).toHaveLength(3); // 머리글 1 + 본문 2
		expect(html.match(/<td/g)).toHaveLength(6);
		expect(html).not.toContain('|---|'); // 구분 줄이 본문으로 새지 않는다
		expect(html).not.toMatch(/<p>\|/); // 표 줄이 문단으로 나오지 않는다
	});

	it('셀 안의 수식도 렌더링하고, 표 앞뒤 블록은 그대로 유지한다', () => {
		const html = renderMarkdown(REPORT_TABLE);
		expect(html).toContain('<h2>1. 이번 오답 한눈에 돌아보기</h2>');
		expect(html).toMatch(/<td>[^]*class="katex"[^]*<\/td>/);
		expect(html).toContain('<p>표 아래 문단</p>'); // 빈 줄에서 표가 끝난다
	});

	it('수식 안의 | (절댓값)와 \\| 이스케이프는 셀 경계가 아니다', () => {
		const html = renderMarkdown(['| 식 | 설명 |', '|---|---|', '| $|x-1|<3$ | 절댓값 |', '| a \\| b | 이스케이프 |'].join('\n'));
		expect(html.match(/<td/g)).toHaveLength(4);
		expect(html).toContain('a | b');
	});

	it('정렬 표시(:---:, ---:)를 반영한다', () => {
		const html = renderMarkdown(['| a | b | c |', '|:---|:---:|---:|', '| 1 | 2 | 3 |'].join('\n'));
		expect(html).toContain('<th style="text-align:left">');
		expect(html).toContain('<th style="text-align:center">');
		expect(html).toContain('<td style="text-align:right">');
	});

	it('양 끝 | 가 없는 표와 셀 수가 어긋난 행도 처리한다', () => {
		const html = renderMarkdown(['a | b', '--- | ---', '1 |', '1 | 2 | 3'].join('\n'));
		expect(html.match(/<th[\s>]/g)).toHaveLength(2);
		expect(html.match(/<td/g)).toHaveLength(4); // 모자라면 비우고, 넘치면 버린다
	});

	it('| 가 없는 줄에서 표가 끝난다(표 바로 뒤 문장을 행으로 삼키지 않는다)', () => {
		const html = renderMarkdown(['| a |', '|---|', '| 1 |', '뒤따르는 문장'].join('\n'));
		expect(html.match(/<td/g)).toHaveLength(1);
		expect(html).toContain('<p>뒤따르는 문장</p>');
	});

	it('구분 줄이 없거나 열 수가 다르면 표가 아니라 문단으로 둔다', () => {
		expect(renderMarkdown('a | b\n그냥 문장')).not.toContain('<table>');
		expect(renderMarkdown('| a | b |\n|---|\n| 1 | 2 |')).not.toContain('<table>');
	});

	it('셀 안의 HTML 은 이스케이프한다(주입 방지)', () => {
		const html = renderMarkdown(['| 제목 |', '|---|', '| <img src=x onerror=alert(1)> |'].join('\n'));
		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;img');
	});

	it('좁은 화면에서 밀려 나가지 않도록 가로 스크롤 상자로 감싼다', () => {
		expect(renderMarkdown('| a |\n|---|\n| 1 |')).toContain('class="table-wrap"');
	});

	it('표 다음에 목록이 바로 이어져도 목록 상태가 어긋나지 않는다', () => {
		const html = renderMarkdown(['- 항목', '', '| a |', '|---|', '| 1 |', '', '- 다음'].join('\n'));
		expect(html.match(/<ul class="label-list">/g)).toHaveLength(2);
		expect(html.match(/<\/ul>/g)).toHaveLength(2);
	});
});

describe('renderMarkdown 링크', () => {
	it('사이트 내부 경로 링크를 <a> 로 만든다(새 탭)', () => {
		const html = renderMarkdown('문제 [0381](./items?id=20260919-174621-prmc) 참고');
		expect(html).toContain('<a href="./items?id=20260919-174621-prmc" class="problem-link" target="_blank" rel="noreferrer"><span class="badge pnum">0381</span></a>');
	});

	it('표 셀과 굵은 글씨 안의 링크도 동작한다', () => {
		const html = renderMarkdown(['| 문제 |', '|---|', '| [0396 · 쎈 중3-2](/ymath/items?id=a) |'].join('\n'));
		expect(html).toMatch(/<td><a href="\/ymath\/items\?id=a" class="problem-link"[^>]*><span class="badge wb">쎈 중3-2<\/span><span class="badge pnum">0396<\/span><\/a><\/td>/);
		expect(renderMarkdown('**[0381](./x)**')).toContain('<strong><a href="./x"');
	});

	it.each([
		['javascript:', '[x](javascript:alert(1))'],
		['외부 주소', '[x](https://evil.example/)'],
		['프로토콜 상대(//host)', '[x](//evil.example/)'],
		['data:', '[x](data:text/html;base64,AAAA)']
	])('위험하거나 외부인 주소는 링크로 만들지 않는다: %s', (_n, md) => {
		const html = renderMarkdown(md);
		expect(html).not.toContain('<a ');
		expect(html).not.toContain('href=');
	});

	it('주소에 따옴표가 있어도 속성을 깨고 나오지 못한다', () => {
		const html = renderMarkdown('[x](/a"onmouseover="alert(1))');
		// 따옴표는 &quot; 로 이스케이프되어 href 값 안에 머문다. 별도 속성(onmouseover=)이 생기면 안 된다
		expect(html).not.toMatch(/<a\b[^>]*\sonmouseover=/);
		expect(html).toContain('&quot;');
	});
});

describe('굵은 글씨·링크 안의 수식', () => {
	it('굵은 글씨 안에 수식이 끼어도 굵게 처리하고 별표가 남지 않는다', () => {
		const html = renderMarkdown('**0394 쎈 중3-2 (삼각형의 내접원, 구하는 것은 $\\overline{BQ}$)**');
		expect(html).toContain('<strong>');
		expect(html).toContain('class="katex"');
		expect(html).not.toContain('**');
		expect(html).toMatch(/<strong>0394 쎈 중3-2 \(삼각형의 내접원, 구하는 것은 <span class="katex">[^]*<\/span>\)<\/strong>/);
	});

	it('링크 글자 안의 수식도 링크 안에 그려진다', () => {
		const html = renderMarkdown('[구하는 것은 $x$](./items?id=a)');
		expect(html).toMatch(/<a href="\.\/items\?id=a"[^>]*>구하는 것은 <span class="katex">/);
	});

	it('링크 주소에 수식이 들어 있으면 링크로 만들지 않는다(속성 안에 HTML 이 들어가면 안 됨)', () => {
		const html = renderMarkdown('[x](/a$b$c)');
		expect(html).not.toContain('<a ');
		expect(html).not.toMatch(/href="[^"]*<span/);
	});

	it('수식이 여러 개여도 모두 그리고, 수식이 없어도 굵게 처리한다', () => {
		expect(renderMarkdown('$a$ 와 $b$ 와 **$c$**').match(/class="katex"/g)).toHaveLength(3);
		expect(renderMarkdown('그냥 **굵게**')).toContain('<strong>굵게</strong>');
	});

	it('입력에 자리표시자 문자(U+E000)가 섞여 있어도 수식이 복제되지 않는다', () => {
		const html = renderMarkdown('가0나 $a$');
		expect(html.match(/class="katex"/g)).toHaveLength(1);
	});
});

describe('<br> 줄바꿈만 허용', () => {
	it('표 셀 안의 <br/> <br> <br /> 를 줄바꿈으로 그린다', () => {
		const html = renderMarkdown(['| 문제 | 설명 |', '|---|---|', '| 쎈 중3-2<br/>0255 | a<br>b<br />c |'].join('\n'));
		expect(html).toContain('<td>쎈 중3-2<br>0255</td>');
		expect(html).toContain('<td>a<br>b<br>c</td>');
	});

	it('다른 HTML 은 여전히 이스케이프한다(br 화이트리스트가 구멍이 되지 않음)', () => {
		const html = renderMarkdown('가<br/>나 <img src=x onerror=alert(1)> <brx> <br onclick=alert(1)> <script>x</script>');
		expect(html).toContain('가<br>나');
		expect(html).not.toContain('<img');
		expect(html).not.toContain('<script');
		expect(html).not.toContain('<brx');
		expect(html).not.toMatch(/<br[^>]*onclick/);
	});

	it('링크 글자 안의 <br/> 도 줄바꿈이 된다', () => {
		expect(renderMarkdown('[쎈 중3-2<br/>0255](./items?id=a)')).toContain('<a href="./items?id=a" class="problem-link" target="_blank" rel="noreferrer"><span class="badge wb">쎈 중3-2</span><span class="badge pnum">0255</span></a>');
	});
});

describe('디자인 장치: 번호 배지·강조 박스·구분', () => {
	it('번호 목록(1. 과 (1))을 번호 원 배지 단계 목록으로 그린다', () => {
		const a = renderMarkdown(['1. **용어 하나:** 설명 하나', '2. **용어 둘:** 설명 둘'].join('\n'));
		expect(a).toContain('<ol class="step-list">');
		expect(a).toContain('<span class="step-num">1</span><span class="step-body"><strong>용어 하나:</strong> 설명 하나</span>');
		expect(a).toContain('<span class="step-num">2</span>');
		expect(a.match(/<ol/g)).toHaveLength(1); // 연속 항목은 한 목록

		const b = renderMarkdown(['(1) 첫째', '(2) 둘째'].join('\n'));
		expect(b).toContain('<span class="step-num">1</span><span class="step-body">첫째</span>');
		expect(b.match(/<ol/g)).toHaveLength(1);
	});

	it('쓴 번호를 그대로 배지에 표시한다(3부터 시작하는 목록도)', () => {
		expect(renderMarkdown('3. 셋째')).toContain('<span class="step-num">3</span>');
	});

	it('"### (1) 제목" 은 제목 앞에 번호 원 배지를 붙인다', () => {
		const html = renderMarkdown('### (1) 답을 쓰는 순간 확인하기');
		expect(html).toBe('<h3 class="has-step"><span class="step-num">1</span><span>답을 쓰는 순간 확인하기</span></h3>');
		expect(renderMarkdown('### 그냥 제목')).toBe('<h3>그냥 제목</h3>');
		expect(renderMarkdown('## (2) 이차 제목')).toContain('<h2 class="has-step">');
	});

	it('아이콘으로 시작하는 인용은 강조 박스, 이어지는 > 줄은 본문', () => {
		const html = renderMarkdown(['> 💡 **이번 한 줄 요약**', '> 첫 문장이에요.', '> 둘째 문장이에요.'].join('\n'));
		expect(html).toContain('<div class="callout callout-note">');
		expect(html).toContain('<strong class="callout-title">💡 <strong>이번 한 줄 요약</strong></strong>');
		expect(html).toContain('<div class="callout-body"><p>첫 문장이에요.</p><p>둘째 문장이에요.</p></div>');
		expect(html.match(/callout"/g) ?? []).toHaveLength(0); // 박스는 하나
		expect(html.match(/<div class="callout /g)).toHaveLength(1);
	});

	it('아이콘에 따라 종류가 달라진다(⚠️ 주의, ✅ 확인)', () => {
		expect(renderMarkdown('> ⚠️ **조심**')).toContain('callout-warn');
		expect(renderMarkdown('> ⚠ **조심**')).toContain('callout-warn');
		expect(renderMarkdown('> ✅ **확인**')).toContain('callout-ok');
	});

	it('제목만 있는 강조 박스도 그린다', () => {
		const html = renderMarkdown('> 💡 **한 줄 요약**');
		expect(html).toContain('callout-note');
		expect(html).not.toContain('callout-body');
	});

	it('아이콘이 없는 인용은 일반 인용이고 여러 줄은 하나로 묶는다', () => {
		const html = renderMarkdown(['> 첫 줄', '> 둘째 줄'].join('\n'));
		expect(html).toBe('<blockquote>첫 줄<br>둘째 줄</blockquote>');
	});

	it('강조 박스 안의 수식·굵게·링크, 그리고 HTML 이스케이프가 유지된다', () => {
		const html = renderMarkdown(['> 💡 **핵심**', '> $x^2$ 를 **먼저** 보고 <img src=x onerror=alert(1)>'].join('\n'));
		expect(html).toContain('class="katex"');
		expect(html).toContain('<strong>먼저</strong>');
		expect(html).not.toContain('<img');
	});

	it('강조 박스 앞뒤 블록이 어긋나지 않는다', () => {
		const html = renderMarkdown(['앞 문단', '', '> 💡 **박스**', '> 본문', '', '- 뒤 목록'].join('\n'));
		expect(html).toMatch(/<p>앞 문단<\/p>\s*<div class="callout[^>]*>.*<\/div>\s*<ul class="label-list">\s*<li>뒤 목록<\/li>\s*<\/ul>/s);
	});

	it('번호 목록에서 글머리 목록으로, 또는 그 반대로 바뀌어도 닫는 태그가 맞다', () => {
		const html = renderMarkdown(['1. 하나', '- 글머리', '2. 둘'].join('\n'));
		expect(html.match(/<ol/g)).toHaveLength(2);
		expect(html.match(/<\/ol>/g)).toHaveLength(2);
		expect(html.match(/<ul/g)).toHaveLength(1);
		expect(html.match(/<\/ul>/g)).toHaveLength(1);
	});
});

describe('렌더러가 만드는 디자인 클래스는 공용 스타일(ui.css)에 정의돼 있다', () => {
	it('callout·step·label·has-step 등 모든 클래스에 규칙이 있다', async () => {
		const { readFileSync } = await import('node:fs');
		const css = readFileSync('src/lib/ui.css', 'utf8');
		const html = renderMarkdown(
			['> 💡 **a**', '> b', '> ⚠️ **c**', '> ✅ **d**', '### (1) e', '1. **f:** g', '- **h:** i'].join('\n\n')
		);
		const classes = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
		for (const c of classes) {
			if (c === 'table-wrap') continue; // 표 상자는 인라인 스타일
			expect(css, `.${c} 규칙이 ui.css 에 없음`).toContain(`.${c}`);
		}
		expect([...classes]).toEqual(expect.arrayContaining(['callout', 'callout-note', 'callout-warn', 'callout-ok', 'callout-title', 'step-list', 'step-num', 'step-body', 'label-list', 'has-step']));
	});
});
