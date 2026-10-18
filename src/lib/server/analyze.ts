import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Analysis, type Feedback, type ItemRecord, type Provider } from '$lib/types';
import { promptsDir, renderPrompt } from './config';
import { checkGuardrail } from './guardrail';
import { IMAGE_FILE } from './image';
import { runStructured } from './llm';
import { knownPatternIds } from './store';
import { buildAnalysisSchema, checkClassification, loadTaxonomy } from './taxonomy';
import { buildPrompt as buildPromptPure, promptVersionAsync, validateAnalysis as validateAnalysisPure } from './analyze-prompt';

// 순수 구현은 analyze-prompt.ts 가 소유하고 여기서 재노출한다(계약 보존).
export const buildPrompt: typeof buildPromptPure = buildPromptPure;
export const validateAnalysis: (schema: object, value: unknown) => asserts value is Analysis = validateAnalysisPure;
export { promptVersionAsync } from './analyze-prompt';

export interface AnalyzeContext {
	record: ItemRecord;
	/** 항목 폴더(image.jpg 가 있는 곳) */
	dir: string;
	ocrText: string;
	/** 지금 다시 분석하려는 기존 분석에 사용자가 남긴 반응 */
	feedback?: Feedback;
	/** Cloud runner can provide a bounded taxonomy pattern snapshot without depending on the Node disk store. */
	knownPatterns?: { id: string; count: number; example: string }[];
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

/**
 * 과거 requested_provider를 변경하지 않고 실행할 때만 Qwen으로 고정한다.
 */
export const providerFor = (record: ItemRecord): Provider =>
	'omlx';

/** 실제 분석기: Qwen(oMLX)을 호출해 구조화된 결과를 받는다 */
export const analyzeItem: Analyzer = async ({ record, dir, ocrText, feedback, hint, knownPatterns }) => {
	const provider = providerFor(record);
	const guideline = renderPrompt(readFileSync(join(promptsDir(), 'analyze.md'), 'utf8'));
	const curriculum = readFileSync(join(promptsDir(), 'curriculum.md'), 'utf8');
	const taxonomy = loadTaxonomy();
	const schema = buildAnalysisSchema(taxonomy);
	const imagePath = join(dir, IMAGE_FILE);

	const prompt = buildPrompt({
		guideline,
		taxonomy,
		patterns: knownPatterns ?? knownPatternIds(),
		record,
		imagePath,
		ocrText,
		feedback,
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

/** Worker(Inngest) 경로와 Node 경로가 같은 프롬프트 버전 해시를 내는지 확인하는 동등성 검증용이다. */
export const promptVersionHexMatchesWorker = async (guideline: string, curriculum: string) =>
	(await promptVersionAsync(guideline, curriculum)) === promptVersion(guideline, curriculum);
