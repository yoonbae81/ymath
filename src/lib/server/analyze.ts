import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import type { Analysis, ItemRecord, Provider } from '$lib/types';
import { promptsDir, renderPrompt, settings } from './config';
import { checkGuardrail } from './guardrail';
import { IMAGE_FILE } from './image';
import { parseClaudeOutput, runStructured } from './llm';
import { knownPatternIds } from './store';
import {
	buildAnalysisSchema,
	checkClassification,
	loadTaxonomy,
	renderTaxonomy,
	type Taxonomy
} from './taxonomy';

// 테스트와 기존 호출부가 analyze 에서 가져오던 이름을 유지한다
export { parseClaudeOutput };

export interface AnalyzeContext {
	record: ItemRecord;
	/** 항목 폴더(image.jpg 가 있는 곳) */
	dir: string;
	ocrText: string;
	/** 재시도 때 직전 실패 사유. 프롬프트에 넣어 같은 실수를 반복하지 않게 한다 */
	hint?: string;
}

export interface AnalyzeResult {
	analysis: Analysis;
	provider: Provider;
	model: string;
	promptVersion: string;
	/** 분류 체계와 어긋난 지점. 비어 있으면 정합 */
	taxonomyIssues: string[];
	/** 형식 경고(질문 형태 아님, 너무 김 등). 정답 노출은 여기 오지 않고 예외로 처리된다 */
	guardrailWarnings: string[];
}

export type Analyzer = (ctx: AnalyzeContext) => Promise<AnalyzeResult>;

/** 어떤 지침으로 분석했는지 추적하는 해시. 지침이나 분류 체계가 바뀌면 달라진다. */
export function promptVersion(guideline: string, curriculum: string): string {
	return createHash('sha1').update(guideline).update('\0').update(curriculum).digest('hex').slice(0, 8);
}

export function buildPrompt(p: {
	guideline: string;
	taxonomy: Taxonomy;
	patterns: { id: string; count: number; example: string }[];
	record: ItemRecord;
	imagePath: string;
	ocrText: string;
	hint?: string;
	/** 사진을 전달하는 방식이 다르다: claude 는 경로를 Read 로 열고, codex 는 첨부로 받는다 */
	provider?: Provider;
}): string {
	const patterns = p.patterns.length
		? p.patterns.map((x) => `- ${x.id} (${x.count}회): ${x.example}`).join('\n')
		: '(아직 없음. 새 패턴이면 새 ID를 만드세요)';
	const ocr = p.ocrText.trim()
		? p.ocrText
		: '(OCR 결과 없음. 사진만 보고 분석하세요)';
	return [
		p.guideline.trim(),
		'---',
		'# 분류 체계 (이 안에서만 선택)',
		renderTaxonomy(p.taxonomy),
		'---',
		'# 기존 오류 패턴 ID (같은 실수면 그대로 재사용)',
		patterns,
		'---',
		'# 이번 오답',
		`- 문제집: ${p.record.workbook.name}`,
		p.provider === 'codex'
			? '- 사진: 이 메시지에 첨부된 이미지입니다. 반드시 직접 보고 분석하세요'
			: p.provider === 'agy'
				? // agy 는 헤드리스에서 셸 명령이 자동 거부되는데, 사진을 열기 전에 pwd/ls 부터 하려는 습관이 있어 도구를 못 박아 준다
					`- 사진 파일: ${p.imagePath}  ← 셸 명령(run_command)은 절대 쓰지 말고 view_file 도구로 이 파일을 직접 열어 보세요`
				: p.provider === 'zai'
					? '- 문제 정보: 제공된 OCR 텍스트와 문제집 정보를 바탕으로 분석하세요.'
					: `- 사진 파일: ${p.imagePath}  ← Read 도구로 반드시 직접 열어 보세요`,
		'',
		'## OCR 텍스트 (참고용, 오류 가능)',
		ocr,
		...(p.hint
			? ['---', '# 직전 시도의 문제점 (이번에는 반드시 고칠 것)', p.hint]
			: []),
		'---',
		'위 지침에 따라 분석하고, 결과는 지정된 JSON 스키마에 맞는 JSON 객체 하나로만 출력하세요.'
	].join('\n');
}

export function validateAnalysis(schema: object, value: unknown): asserts value is Analysis {
	const ajv = new Ajv({ allErrors: true, strict: false });
	const validate = ajv.compile(schema);
	if (!validate(value)) {
		const msg = (validate.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || '/'} ${e.message}`);
		throw new Error(`분석 결과가 스키마와 다름: ${msg.join('; ')}`);
	}
}

/** 이 항목을 분석할 LLM. 재분석 때 지정했으면 그것을, 아니면 서버 기본값(ANALYZE_PROVIDER)을 쓴다. */
export const providerFor = (record: ItemRecord): Provider => record.requested_provider ?? settings().provider;

/** 실제 분석기: 선택된 LLM(claude/codex)을 헤드리스로 호출 */
export const analyzeItem: Analyzer = async ({ record, dir, ocrText, hint }) => {
	const provider = providerFor(record);
	const guideline = renderPrompt(readFileSync(join(promptsDir(), 'analyze.md'), 'utf8'));
	const curriculum = readFileSync(join(promptsDir(), 'curriculum.md'), 'utf8');
	const taxonomy = loadTaxonomy();
	const schema = buildAnalysisSchema(taxonomy);
	const imagePath = join(dir, IMAGE_FILE);

	const prompt = buildPrompt({
		guideline,
		taxonomy,
		patterns: knownPatternIds(),
		record,
		imagePath,
		ocrText,
		hint,
		provider
	});

	const { output: out, model } = await runStructured(provider, { prompt, schema, dir, imagePath });
	validateAnalysis(schema, out);
	// 정답·식이 넛지에 섞였으면 저장하지 않고 실패시킨다(큐가 사유를 힌트로 넣어 재시도)
	const guard = checkGuardrail(out);
	if (guard.violations.length) throw new Error(`정답 노출 가드레일 위반: ${guard.violations.join(' / ')}`);
	const issues = checkClassification(taxonomy, out);
	const course = taxonomy.unitByName.get(out.classification.unit_major)?.course;
	if (course) out.classification.course = course;

	return {
		analysis: out,
		provider,
		model,
		promptVersion: promptVersion(guideline, curriculum),
		taxonomyIssues: issues,
		guardrailWarnings: guard.warnings
	};
};
