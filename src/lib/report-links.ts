/**
 * 보고서 본문에 나온 문제 번호("0381", "[0394] 쎈 중3-2", "20번")를 그 오답 항목으로 가는 마크다운 링크로 바꾼다.
 * 보고서는 LLM 이 입력 JSON 의 문제 번호(사진에서 읽은 `problem.number_guess`)를 그대로 옮겨 쓰기 때문에,
 * 번호 → 항목 대응은 (번호, 문제집 이름)으로 복원할 수 있다.
 *
 * 잘못된 링크는 링크가 없는 것보다 나쁘므로 확실한 경우만 건다:
 *  - 같은 번호가 이 보고서의 여러 항목에 있으면 번호만 쓴 언급은 링크하지 않는다(문제집 이름이 함께 있으면 그걸로 가른다).
 *  - 수식($...$), 코드(`...`), 이미 있는 링크 안은 건드리지 않는다.
 *  - 번호만 쓴 언급은 3자리 이상이거나, `20번`처럼 뒤에 `번`이 붙었거나, `[0394]`처럼 대괄호일 때만 인정한다.
 *    `144cm`, `30°` 처럼 단위가 붙은 숫자는 문제 번호가 아니므로 제외한다.
 * (RegExp 뒤돌아보기(lookbehind)는 오래된 iOS Safari 에서 문법 오류가 되므로 쓰지 않는다.)
 */

export interface ProblemRef {
	id: string;
	/** 문제 번호의 숫자 부분. 예: "0381" */
	number: string;
	/** 문제집 이름. 예: "쎈 중3-2" */
	workbook: string;
}

interface ItemLike {
	id: string;
	workbook: { name: string };
	analysis: { problem: { number_guess: string } } | null;
}

/** 사진에서 읽은 문제 번호의 숫자 부분. "0359(추정, …)" 처럼 설명이 붙어도 앞의 숫자만 쓴다. 읽지 못했으면 null */
export function problemNumber(item: Pick<ItemLike, 'analysis'>): string | null {
	return item.analysis?.problem.number_guess?.trim().match(/^\D{0,2}(\d+)/)?.[1] ?? null;
}

/** 항목들에서 링크 대상(번호·문제집)을 뽑는다. 번호를 읽지 못한 항목은 뺀다. */
export function problemRefsFrom(items: ItemLike[]): ProblemRef[] {
	const refs: ProblemRef[] = [];
	for (const it of items) {
		const number = problemNumber(it);
		if (number) refs.push({ id: it.id, number, workbook: it.workbook.name });
	}
	return refs;
}

/**
 * 보고서에서 이 문제를 가리키는 표기. 코드가 만들어 LLM 에 주고 그대로 쓰게 한다(문제집 이름을 LLM 이 조합하지 않도록).
 * 예: "0255 · 쎈 중3-2". 번호를 읽지 못했으면 문제집 이름만.
 */
export function problemLabel(item: ItemLike): string {
	const n = problemNumber(item);
	return n ? `${n} · ${item.workbook.name}` : `${item.workbook.name} (번호 미확인)`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "쎈 중3-2" → 공백 유무가 달라도("쎈중3-2", "쎈 중 3-2") 맞는 패턴 */
const flexible = (name: string) =>
	[...name.replace(/\s+/g, '')]
		.map(escapeRe)
		.join('\\s*');

/** 보호 구간: 수식, 인라인 코드, 이미 있는 마크다운 링크 */
const PROTECTED = /(\$\$[\s\S]+?\$\$|\$[^$\n]+\$|`[^`\n]+`|\[[^\]\n]*\]\([^)\n]*\))/;

/** 번호 뒤에 붙으면 문제 번호가 아니라 측정값인 단위 */
const UNIT_AFTER = /^\s?(?:cm|mm|km|kg|m\b|g\b|°|%|배|개|원|점|초|분)/;

interface Hit {
	start: number;
	end: number;
	id: string;
	text: string;
}

const isDigit = (c: string | undefined) => !!c && c >= '0' && c <= '9';

function linkifyPlain(text: string, refs: ProblemRef[], hrefFor: (id: string) => string): string {
	const byNumber = new Map<string, ProblemRef[]>();
	for (const r of refs) byNumber.set(r.number, [...(byNumber.get(r.number) ?? []), r]);

	const hits: Hit[] = [];
	const overlaps = (s: number, e: number) => hits.some((h) => s < h.end && e > h.start);
	const add = (h: Hit) => {
		if (!overlaps(h.start, h.end)) hits.push(h);
	};

	// 1) 번호 + 문제집 이름 (가장 확실. 대괄호·구분 기호·공백이 달라도 됨): "0396 · 쎈 중3-2", "[0394] 쎈 중3-2"
	for (const r of refs) {
		const re = new RegExp(`\\[?${escapeRe(r.number)}(?:번)?\\]?\\s*(?:[·•∙,/:–-]\\s*)?${flexible(r.workbook)}(?!\\d)`, 'g');
		for (const m of text.matchAll(re)) {
			const start = m.index!;
			if (isDigit(text[start - 1]) && m[0][0] !== '[') continue; // 더 긴 숫자의 일부
			add({ start, end: start + m[0].length, id: r.id, text: m[0].replace(/[[\]]/g, '') });
		}
	}

	// 1-b) 문제집 + 줄바꿈 + 번호: 표의 문제 열 "쎈 중3-2<br/>0255"
	for (const r of refs) {
		const re = new RegExp(`${flexible(r.workbook)}\\s*<br\\s*\\/?>\\s*\\[?${escapeRe(r.number)}(?:번)?\\]?(?!\\d)`, 'g');
		for (const m of text.matchAll(re)) add({ start: m.index!, end: m.index! + m[0].length, id: r.id, text: m[0].replace(/[[\]]/g, '') });
	}

	// 번호만 쓴 언급: 같은 번호가 여러 항목이면 어느 것인지 알 수 없으니 링크하지 않는다
	for (const [num, list] of byNumber) {
		if (list.length !== 1) continue;
		const id = list[0].id;
		const n = escapeRe(num);

		// 2) 대괄호: "[0394]", "[20번]"
		for (const m of text.matchAll(new RegExp(`\\[${n}(?:번)?\\]`, 'g')))
			add({ start: m.index!, end: m.index! + m[0].length, id, text: m[0].replace(/[[\]]/g, '') });

		// 3) "20번" (1~3자리 번호는 뒤의 '번'이 있어야 문제 번호로 본다. "20번째" 는 순서라서 제외)
		for (const m of text.matchAll(new RegExp(`${n}(?=번(?!째))`, 'g'))) {
			const start = m.index!;
			if (isDigit(text[start - 1]) || text[start - 1] === '.' || text[start - 1] === ',') continue;
			add({ start, end: start + num.length + 1, id, text: `${num}번` }); // '번'까지 링크 글자에 포함
		}

		// 4) 번호만: 3자리 이상일 때만. "0388에서는", "(0339)", "0396, 0394, 0252처럼"
		if (num.length >= 3) {
			for (const m of text.matchAll(new RegExp(n, 'g'))) {
				const start = m.index!;
				const end = start + num.length;
				const prev = text[start - 1];
				if (isDigit(prev) || prev === '.' || prev === ',' || isDigit(text[end])) continue;
				if (UNIT_AFTER.test(text.slice(end))) continue;
				add({ start, end, id, text: num });
			}
		}
	}

	hits.sort((a, b) => a.start - b.start);
	let out = '';
	let pos = 0;
	for (const h of hits) {
		out += text.slice(pos, h.start) + `[${h.text}](${hrefFor(h.id)})`;
		pos = h.end;
	}
	return out + text.slice(pos);
}

/** 마크다운 문서 전체에서 문제 번호 언급을 링크로 바꾼다. 수식·코드·기존 링크 안은 그대로 둔다. */
export function linkifyProblemRefs(md: string, refs: ProblemRef[], hrefFor: (id: string) => string): string {
	if (refs.length === 0) return md;
	return md
		.split('\n')
		.map((line) =>
			line
				.split(PROTECTED)
				.map((seg, i) => (i % 2 === 1 ? seg : linkifyPlain(seg, refs, hrefFor)))
				.join('')
		)
		.join('\n');
}

// ───────────────────────── 문제집 이름 교정 ─────────────────────────
//
// LLM 은 "0255 · 쎈 중3-1" 처럼 번호는 맞게 쓰고 문제집 이름(특히 학기)을 잘못 조합하는 일이 있었다. 입력에 함께 있던
// 단원의 학기 표시(중3-1)를 출판사 이름에 붙여 버린 것이다. 프롬프트로 줄이지만 100%는 아니므로, 저장 전에 코드가 바로잡는다.

import { splitTableRow } from './math';

export interface WorkbookCorrection {
	number: string;
	from: string;
	to: string;
}

export interface NormalizeResult {
	markdown: string;
	corrections: WorkbookCorrection[];
	/** 교정 후에도 남은, 이 보고서의 어떤 문제집과도 다른 문제집 표기(번호 없이 쓴 경우 등). 사람이 확인할 것 */
	stray: string[];
}

const compact = (s: string) => s.replace(/\s+/g, '');

/** "쎈 중3-2", "RPM 공통수학1" 처럼 출판사 + (학년-학기 | 공통수학N) 꼴의 문제집 표기를 찾는 패턴 조각 */
function workbookLike(publishers: string[]): string {
	const pubs = [...new Set(publishers)].filter(Boolean).sort((a, b) => b.length - a.length).map(flexible).join('|');
	return `(?:${pubs})\\s*(?:(?:중|고)\\s*\\d\\s*-\\s*\\d|공통수학\\s*\\d)`;
}

/**
 * 문제 번호 바로 뒤에 붙은 문제집 표기가 실제와 다르면 실제 문제집 이름으로 바꾼다.
 *  - 그 번호의 문제집이 하나로 정해질 때만 바꾼다(같은 번호가 다른 문제집에도 있으면 어느 쪽인지 모르므로 그대로 둔다).
 *  - 수식·코드·링크 안은 건드리지 않는다.
 *  - 이미 맞으면 그대로라서 여러 번 적용해도 결과가 같다(멱등).
 * 번호 없이 쓴 문제집 표기는 고칠 수 없으므로 `stray` 로 알려 준다.
 */
export function normalizeWorkbookMentions(md: string, refs: ProblemRef[], publishers: string[]): NormalizeResult {
	const corrections: WorkbookCorrection[] = [];
	if (refs.length === 0 || publishers.length === 0) return { markdown: md, corrections, stray: [] };

	// 번호 → 그 번호를 가진 문제집들. 하나뿐이면 교정 대상
	const workbooksByNumber = new Map<string, Set<string>>();
	for (const r of refs) workbooksByNumber.set(r.number, (workbooksByNumber.get(r.number) ?? new Set()).add(r.workbook));

	const LIKE = workbookLike(publishers);
	const patterns = [...workbooksByNumber]
		.filter(([, set]) => set.size === 1)
		.map(([number, set]) => ({
			number,
			workbook: [...set][0],
			re: new RegExp(`(\\[?${escapeRe(number)}(?:번)?\\]?\\s*(?:[·•∙,/:–-]\\s*)?)(${LIKE})(?!\\d)`, 'g')
		}));

	// 표의 문제 열 형식 "쎈 중3-1<br/>0255": 문제집이 앞, 번호가 뒤
	const reversed = [...workbooksByNumber]
		.filter(([, set]) => set.size === 1)
		.map(([number, set]) => ({
			number,
			workbook: [...set][0],
			re: new RegExp(`(${LIKE})(\\s*<br\\s*\\/?>\\s*\\[?${escapeRe(number)}(?:번)?\\]?)(?!\\d)`, 'g')
		}));

	const fixPlain = (text: string) => {
		let out = text;
		for (const p of reversed) {
			out = out.replace(p.re, (m: string, wb: string, rest: string) => {
				if (compact(wb) === compact(p.workbook)) return m;
				corrections.push({ number: p.number, from: wb, to: p.workbook });
				return p.workbook + rest;
			});
		}
		for (const p of patterns) {
			out = out.replace(p.re, (m: string, prefix: string, wb: string, offset: number) => {
				if (isDigit(out[offset - 1]) && !prefix.startsWith('[')) return m; // 더 긴 숫자의 일부
				if (compact(wb) === compact(p.workbook)) return m; // 이미 맞음
				corrections.push({ number: p.number, from: wb, to: p.workbook });
				return prefix + p.workbook;
			});
		}
		return out;
	};

	const markdown = md
		.split('\n')
		.map((line) =>
			line
				.split(PROTECTED)
				.map((seg, i) => (i % 2 === 1 ? seg : fixPlain(seg)))
				.join('')
		)
		.join('\n');

	// 교정 후에도 남은 문제집 표기 중 이 보고서의 문제집이 아닌 것
	const known = new Set(refs.map((r) => compact(r.workbook)));
	const stray = new Set<string>();
	for (const line of markdown.split('\n'))
		line.split(PROTECTED).forEach((seg, i) => {
			if (i % 2 === 1) return;
			for (const m of seg.matchAll(new RegExp(LIKE, 'g'))) if (!known.has(compact(m[0]))) stray.add(m[0]);
		});

	return { markdown, corrections, stray: [...stray] };
}

// ───────────────────────── 표의 문제 열 형식 ─────────────────────────

/**
 * 진단표의 첫 열(문제)을 "문제집<br/>문제번호" 두 줄로 통일한다. 나머지 열이 여러 줄이라 한 줄로 길게 쓰면 폭만 차지한다.
 * AI 가 "0255 · 쎈 중3-2" 로 쓰든 이미 두 줄로 쓰든 결과가 같도록 코드가 보장한다(지침에만 맡기지 않는다).
 *  - 셀 전체가 문제 표기 하나일 때만 바꾼다. 다른 글이 섞인 셀, 첫 열이 아닌 셀은 건드리지 않는다.
 *  - 그 번호의 문제집이 하나로 정해지면 실제 문제집 이름을 쓰고, 아니면 쓴 그대로 둔다.
 */
export function formatProblemCells(md: string, refs: ProblemRef[], publishers: string[]): string {
	const pubs = [...new Set(publishers)].filter(Boolean);
	if (pubs.length === 0) return md;
	const LIKE = workbookLike(pubs);
	const NUM = '\\[?(\\d+)(번)?\\]?';
	const SEP = '\\s*[·•∙,/:–-]\\s*';
	// 번호 · 문제집  /  문제집 · 번호  /  문제집<br/>번호
	const numFirst = new RegExp(`^${NUM}(?:${SEP})?\\s*(${LIKE})$`);
	const wbFirst = new RegExp(`^(${LIKE})(?:\\s*<br\\s*\\/?>\\s*|${SEP})${NUM}$`);

	const wbByNumber = new Map<string, Set<string>>();
	for (const r of refs) wbByNumber.set(r.number, (wbByNumber.get(r.number) ?? new Set()).add(r.workbook));

	const convert = (cell: string): string | null => {
		const c = cell.trim();
		let m = c.match(numFirst);
		const [num, suffix, written] = m ? [m[1], m[2] ?? '', m[3]] : (m = c.match(wbFirst)) ? [m[2], m[3] ?? '', m[1]] : [null, '', ''];
		if (num === null) return null;
		const set = wbByNumber.get(num);
		const wb = set && set.size === 1 ? [...set][0] : written;
		return `${wb}<br/>${num}${suffix}`;
	};

	return md
		.split('\n')
		.map((line) => {
			const t = line.trim();
			if (!t.startsWith('|')) return line;
			const cells = splitTableRow(t);
			// 구분 줄(|---|---|)과 열이 하나뿐인 줄은 제외
			if (cells.length < 2 || cells.every((c) => /^:?-+:?$/.test(c))) return line;
			const first = convert(cells[0]);
			if (first === null || first === cells[0]) return line;
			// 첫 열만 바꾸고 나머지는 원문 그대로 잇는다. 셀을 다시 join 하면 \| 이스케이프나 수식 안의 | 가 달라져 표가 깨진다.
			// (첫 열은 문제 표기 하나뿐이라 그 안에 | 나 $ 가 없으므로, 첫 열의 끝은 두 번째 | 이다)
			return `| ${first} ${t.slice(t.indexOf('|', 1))}`;
		})
		.join('\n');
}

// ───────────────────────── 본문 첫 제목 ─────────────────────────

/**
 * 본문 맨 앞의 큰 제목(`# 제목`) 한 줄을 뗀다. 상세 창 머리에 이미 "○○ 영역 맞춤 코칭 보고서"와 기간이 있어서 중복이다.
 * 맨 앞 블록이 `# ` 제목일 때만 떼고, 본문 중간의 `# `나 `##` 이하 제목은 건드리지 않는다.
 */
export function stripLeadingTitle(md: string): string {
	const lines = md.split('\n');
	let i = 0;
	while (i < lines.length && !lines[i].trim()) i++;
	if (i >= lines.length || !/^#\s+\S/.test(lines[i].trim())) return md;
	return lines.slice(i + 1).join('\n').replace(/^\s*\n/, '').replace(/^\n+/, '');
}

