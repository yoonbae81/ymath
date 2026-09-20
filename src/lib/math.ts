import katex from 'katex';

const escapeHtml = (s: string) =>
	s.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');

const KATEX_OPTS: katex.KatexOptions = {
	throwOnError: false,
	strict: 'ignore',
	trust: false, // OWASP ASVS V1.2.8: \href, \url 등 잠재적 위험 명령 차단
	maxSize: 500, // 과도한 글자 크기로 인한 DoS 방지
	maxExpand: 1000 // 매크로 재귀 폭탄 DoS 방지
};

/** 수식이 아닌 구간: HTML 이스케이프 후 **굵게**와 줄바꿈만 처리한다. */
const plain = (s: string) =>
	escapeHtml(s)
		.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
		.replace(/\n/g, '<br>');

const MATH = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

/**
 * `$...$`, `$$...$$` 수식을 KaTeX 로 렌더링한 HTML 을 돌려준다.
 * 수식이 아닌 구간은 모두 이스케이프하므로 LLM 출력을 {@html} 로 넣어도 안전하다.
 * (수식 안의 `<` 같은 문자는 KaTeX 가 처리하므로 먼저 이스케이프하지 않는다.)
 */
export function renderMath(text: string): string {
	let out = '';
	let last = 0;
	for (const m of text.matchAll(MATH)) {
		out += plain(text.slice(last, m.index));
		const display = m[1] !== undefined;
		try {
			out += katex.renderToString((m[1] ?? m[2]).trim(), {
				...KATEX_OPTS,
				displayMode: display
			});
		} catch {
			out += escapeHtml(m[0]);
		}
		last = m.index + m[0].length;
	}
	return out + plain(text.slice(last));
}

/**
 * 링크 주소는 이 사이트 안의 경로만 허용한다(`/x`, `./x`, `../x`, `#x`). 외부 주소·`//host`·`javascript:` 는
 * 링크로 만들지 않고 글자 그대로 둔다. LLM 이 쓴 보고서 본문을 {@html} 로 넣으므로 필수다.
 */
const SAFE_HREF = /^(?:\/(?!\/)|\.{1,2}\/|#)[^\s"'<>`\uE000]*$/;

export function parseProblemLinkText(text: string): { workbook: string | null; number: string | null } {
	const clean = text
		.replace(/&lt;br\s*\/?&gt;/gi, ' · ')
		.replace(/<br\s*\/?>/gi, ' · ')
		.replace(/[[\]]/g, '')
		.trim();

	const parts = clean.split(/\s*(?:[·•∙:\/]| - )\s*/).filter(Boolean);
	if (parts.length === 2) {
		const m0 = parts[0].match(/^(\d+)(?:번)?$/);
		const m1 = parts[1].match(/^(\d+)(?:번)?$/);
		if (m0 && !m1) {
			return { number: m0[1], workbook: parts[1].trim() };
		}
		if (m1 && !m0) {
			return { workbook: parts[0].trim(), number: m1[1] };
		}
	}

	const numFront = clean.match(/^(\d+)(?:번)?\s+(.+)$/);
	if (numFront) {
		return { number: numFront[1], workbook: numFront[2].trim() };
	}
	const numBack = clean.match(/^(.+?)\s+(\d+)(?:번)?$/);
	if (numBack) {
		return { workbook: numBack[1].trim(), number: numBack[2] };
	}

	const numOnly = clean.match(/^(\d+)(?:번)?$/);
	if (numOnly) {
		return { number: numOnly[1], workbook: null };
	}

	return { workbook: null, number: null };
}

function formatLink(text: string, href: string): string {
	if (/(?:^|\/|\.\/)items\?id=/.test(href)) {
		const parsed = parseProblemLinkText(text);
		if (parsed.workbook && parsed.number) {
			return `<a href="${href}" class="problem-link" target="_blank" rel="noreferrer"><span class="badge wb">${parsed.workbook}</span><span class="badge pnum">${parsed.number}</span></a>`;
		}
		if (parsed.number) {
			return `<a href="${href}" class="problem-link" target="_blank" rel="noreferrer"><span class="badge pnum">${parsed.number}</span></a>`;
		}
		return `<a href="${href}" class="problem-link" target="_blank" rel="noreferrer">${text}</a>`;
	}
	return `<a href="${href}" target="_blank" rel="noreferrer">${text}</a>`;
}

const inlineText = (s: string) =>
	escapeHtml(s)
		// 줄바꿈 태그만 허용한다(표 셀 안에서 "문제집<br/>문제번호" 처럼 두 줄로 쓰기 위해). 나머지 HTML 은 위에서 이미 이스케이프됐다
		.replace(/&lt;br\s*\/?&gt;/gi, '<br>')
		.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		// [글자](주소). 새 탭으로 열어 보고서를 읽던 자리를 잃지 않게 한다. 주소는 이미 escapeHtml 을 거쳤다(&amp; 등)
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, href: string) =>
			SAFE_HREF.test(href) ? formatLink(text, href) : m);

/**
 * 한 줄 안의 서식(굵게·코드·링크)과 수식을 HTML 로 만든다.
 * 수식은 먼저 자리표시자로 빼 두고 문장 전체에 서식을 적용한 뒤 되돌린다. 그래야 `**0394 쎈 중3-2 (… $x$)**` 처럼
 * 굵은 글씨 안에 수식이 끼어도 굵게 처리된다(수식 앞뒤로 문장을 쪼개서 처리하면 `**` 가 짝을 잃고 그대로 보인다).
 * 자리표시자는 사설 사용 영역 문자(U+E000)라 일반 글자와 겹치지 않고, 입력에 섞여 있으면 먼저 없앤다.
 */
const SLOT = '\uE000';

export function renderInline(text: string): string {
	const rendered: string[] = [];
	const withSlots = text.split(SLOT).join('').replace(MATH, (m, display: string | undefined, inline: string | undefined) => {
		let html: string;
		try {
			html = katex.renderToString((display ?? inline ?? '').trim(), { ...KATEX_OPTS, displayMode: display !== undefined });
		} catch {
			html = escapeHtml(m);
		}
		rendered.push(html);
		return `${SLOT}${rendered.length - 1}${SLOT}`;
	});
	return inlineText(withSlots).replace(new RegExp(`${SLOT}(\\d+)${SLOT}`, 'g'), (_m, i: string) => rendered[+i]);
}

/**
 * 표의 한 줄을 셀로 나눈다. 수식($...$) 안의 `|`(절댓값 등)와 `\|` 는 셀 경계가 아니다.
 * 양 끝의 `|` 는 있어도 없어도 된다.
 */
export function splitTableRow(line: string): string[] {
	let row = line.trim();
	if (row.startsWith('|')) row = row.slice(1);
	if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);

	const cells: string[] = [];
	let cur = '';
	let inMath = false;
	for (let i = 0; i < row.length; i++) {
		const c = row[i];
		if (c === '\\' && row[i + 1] === '|') {
			cur += '|';
			i++;
		} else if (c === '\\' && row[i + 1] === '$') {
			cur += '\\$'; // 이스케이프된 달러는 수식 경계가 아니다
			i++;
		} else if (c === '$') {
			inMath = !inMath;
			cur += c;
		} else if (c === '|' && !inMath) {
			cells.push(cur.trim());
			cur = '';
		} else cur += c;
	}
	cells.push(cur.trim());
	return cells;
}

type Align = 'left' | 'center' | 'right' | null;

/** `|---|:--:|--:|` 같은 구분 줄이면 열 정렬을 돌려주고, 아니거나 열 수가 다르면 null(GFM 규칙). */
function parseTableSeparator(line: string, columns: number): Align[] | null {
	if (!line.includes('-') || !line.includes('|')) return null;
	const cells = splitTableRow(line);
	if (cells.length !== columns || !cells.every((c) => /^:?-+:?$/.test(c))) return null;
	return cells.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
}

const cellTag = (tag: 'th' | 'td', html: string, align: Align) =>
	`<${tag}${align ? ` style="text-align:${align}"` : ''}>${html}</${tag}>`;

/**
 * 보고서 등 긴 Markdown 문서를 KaTeX 수식과 함께 HTML 로 렌더링한다.
 * 지원: 제목, 목록, 인용, 구분선, 표(GFM), 굵게, 코드, 수식, 링크, 줄바꿈(<br>).
 * 보고서·상세 화면과 같은 디자인 장치(ui.css)로 그린다:
 *  - `1. **용어:** 설명` 또는 `(1) 설명` → 번호 원 배지 단계 목록(step-list)
 *  - `### (1) 제목` → 제목 앞에 번호 원 배지
 *  - `> 💡 **제목**` + 이어지는 `> 내용` → 강조 박스(callout). 💡 노트, ⚠️ 주의, ✅ 확인
 *  - `- **라벨:** 설명` → 굵은 라벨 목록(label-list)
 */
/** 강조 박스의 맨 앞 아이콘 → 종류 */
const CALLOUT_KIND: Record<string, 'note' | 'warn' | 'ok'> = {
	'💡': 'note', '📌': 'note', '🎯': 'note', '🔍': 'note',
	'⚠️': 'warn', '⚠': 'warn', '❗': 'warn', '🚧': 'warn',
	'✅': 'ok', '💪': 'ok', '👍': 'ok', '🌟': 'ok'
};
const CALLOUT_HEAD = new RegExp(`^(${Object.keys(CALLOUT_KIND).sort((a, b) => b.length - a.length).join('|')})\\s*(.*)$`);

const stepBadge = (n: string) => `<span class="step-num">${n}</span>`;

export function renderMarkdown(md: string): string {
	const lines = md.split('\n');
	const out: string[] = [];
	let inList = false;
	let inNumList = false;

	const closeLists = () => {
		if (inList) {
			out.push('</ul>');
			inList = false;
		}
		if (inNumList) {
			out.push('</ol>');
			inNumList = false;
		}
	};
	// 번호 원 배지 단계 목록(같은 종류의 연속 항목은 한 목록으로 묶는다)
	const stepItem = (n: string, text: string) => {
		if (inList) {
			out.push('</ul>');
			inList = false;
		}
		if (!inNumList) {
			out.push('<ol class="step-list">');
			inNumList = true;
		}
		out.push(`<li>${stepBadge(n)}<span class="step-body">${renderInline(text)}</span></li>`);
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		if (!trimmed) {
			closeLists();
			continue;
		}

		if (trimmed === '---' || trimmed === '***') {
			closeLists();
			out.push('<hr>');
			continue;
		}

		// 표: 머리글 줄 바로 다음 줄이 구분 줄(|---|---|)일 때 시작하고, 빈 줄이나 `|` 없는 줄에서 끝난다
		if (trimmed.includes('|') && i + 1 < lines.length) {
			const header = splitTableRow(trimmed);
			const align = parseTableSeparator(lines[i + 1].trim(), header.length);
			if (align) {
				closeLists();
				const rows: string[] = [];
				let j = i + 2;
				for (; j < lines.length && lines[j].trim() && lines[j].includes('|'); j++) {
					const cells = splitTableRow(lines[j]);
					// 셀 수가 머리글과 다르면 모자란 만큼 비우고 넘치는 셀은 버린다(GFM)
					rows.push(`<tr>${header.map((_, k) => cellTag('td', renderInline(cells[k] ?? ''), align[k])).join('')}</tr>`);
				}
				const head = `<tr>${header.map((h, k) => cellTag('th', renderInline(h), align[k])).join('')}</tr>`;
				// 좁은 화면(폰)에서 표가 밀려 나가지 않게 가로 스크롤 상자로 감싼다
				out.push(`<div class="table-wrap" style="overflow-x:auto"><table><thead>${head}</thead><tbody>${rows.join('')}</tbody></table></div>`);
				i = j - 1;
				continue;
			}
		}

		const hMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
		if (hMatch) {
			closeLists();
			const level = Math.min(Math.max(hMatch[1].length, 1), 6);
			// "(1) 제목" 은 제목 앞에 번호 원 배지를 붙인다
			const num = hMatch[2].match(/^\((\d+)\)\s*(.+)$/);
			out.push(num ? `<h${level} class="has-step">${stepBadge(num[1])}<span>${renderInline(num[2])}</span></h${level}>` : `<h${level}>${renderInline(hMatch[2])}</h${level}>`);
			continue;
		}

		const ulMatch = trimmed.match(/^[-*]\s+(.+)$/);
		if (ulMatch) {
			if (inNumList) {
				out.push('</ol>');
				inNumList = false;
			}
			if (!inList) {
				out.push('<ul class="label-list">');
				inList = true;
			}
			out.push(`<li>${renderInline(ulMatch[1])}</li>`);
			continue;
		}

		const olMatch = trimmed.match(/^(\d+)\.\s+(.+)$/) ?? trimmed.match(/^\((\d+)\)\s+(.+)$/);
		if (olMatch) {
			stepItem(olMatch[1], olMatch[2]);
			continue;
		}

		if (/^>/.test(trimmed)) {
			closeLists();
			const quote: string[] = [];
			let j = i;
			for (; j < lines.length && /^>/.test(lines[j].trim()); j++) quote.push(lines[j].trim().replace(/^>\s?/, '').trim());
			i = j - 1;
			const head = quote[0]?.match(CALLOUT_HEAD);
			if (head) {
				const body = quote.slice(1).filter(Boolean);
				out.push(
					`<div class="callout callout-${CALLOUT_KIND[head[1]]}"><strong class="callout-title">${head[1]} ${renderInline(head[2])}</strong>` +
						(body.length ? `<div class="callout-body">${body.map((l) => `<p>${renderInline(l)}</p>`).join('')}</div>` : '') +
						'</div>'
				);
			} else {
				out.push(`<blockquote>${quote.filter(Boolean).map((l) => renderInline(l)).join('<br>')}</blockquote>`);
			}
			continue;
		}

		closeLists();
		out.push(`<p>${renderInline(trimmed)}</p>`);
	}

	closeLists();
	return out.join('\n');
}
