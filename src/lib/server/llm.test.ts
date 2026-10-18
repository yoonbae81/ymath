import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstJsonObject, parseJsonBody, runStructured, runText } from './llm';
import { buildAnalysisSchema } from './taxonomy';
import { loadTaxonomy } from './taxonomy';

let work: string;
const SCHEMA = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };

beforeEach(() => {
	work = realpathSync(mkdtempSync(join(tmpdir(), 'ymath-llm-')));
	process.env.CONFIG_DIR = work; // 실제 user/config/providers.json 이 테스트에 새지 않게 한다
	writeFileSync(join(work, 'work.jpg'), 'img');
	writeFileSync(join(work, 'out.json'), JSON.stringify({ a: '결과' }));
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const k of ['FAKE_LOG', 'FAKE_OUT', 'FAKE_MODE', 'CODEX_BIN', 'CODEX_MODEL', 'AGY_BIN', 'AGY_MODEL', 'CONFIG_DIR']) delete process.env[k];
	rmSync(work, { recursive: true, force: true });
});

const call = () => ({ prompt: '프롬프트 본문', schema: SCHEMA, dir: work, imagePath: join(work, 'work.jpg') });

describe('Qwen HTTP와 공통 JSON/스키마', () => {
	it('omlx: OpenAI 호환 엔드포인트로 본문을 받는다', async () => {
		writeFileSync(join(work, 'providers.json'), JSON.stringify({ providers: { omlx: { baseUrl: 'http://omlx.test/v1', apiKey: 'k', models: [{ id: 'Qwen3.6-35B-A3B' }] } } }));
		let url = '';
		let body: any;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (u: string, opts: any) => {
				url = u;
				body = JSON.parse(opts.body);
				return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '보고서 본문' } }] }) };
			})
		);
		const r = await runText('omlx', '써 줘');
		expect(r).toEqual({ text: '보고서 본문', model: 'Qwen3.6-35B-A3B' });
		expect(url).toBe('http://omlx.test/v1/chat/completions');
		expect(body.model).toBe('Qwen3.6-35B-A3B');
		// 본문 요청에는 JSON 모드를 쓰지 않는다
		expect(body.response_format).toBeUndefined();
		expect(body.messages).toEqual([{ role: 'user', content: '써 줘' }]);
	});
	it('omlx: 키가 없으면 호출하지 않고 오류', async () => {
		writeFileSync(join(work, 'providers.json'), JSON.stringify({ providers: { omlx: { baseUrl: 'http://omlx.test/v1', models: [{ id: 'Qwen3.6-35B-A3B' }] } } }));
		await expect(runText('omlx', 'x')).rejects.toThrow(/oMLX API 키가 설정되지 않았습니다/);
	});
	it('parseJsonBody: thinking 이 섞인 출력에서도 첫 균형 객체를 건진다', () => {
		const noisy = "We need answer user's request: produce valid JSON only. Need think.\n{\"a\":\"결과\"}";
		expect(parseJsonBody('oMLX', noisy)).toEqual({ a: '결과' });
		// 문자열 안의 중괄호는 객체 경계가 아니다
		expect(firstJsonObject('{"s":"안에 { 있음"}')).toBe('{"s":"안에 { 있음"}');
		expect(() => parseJsonBody('oMLX', '생각만 하고 브레이스 없이 끝남')).toThrow(/JSON 이 아님/);
	});
	it('분석 스키마의 모든 객체가 OpenAI strict 요건을 만족한다', () => {
		const bad: string[] = [];
		const walk = (n: any, path: string) => {
			if (!n || typeof n !== 'object') return;
			if (n.properties) {
				if (n.additionalProperties !== false) bad.push(`${path}: additionalProperties`);
				const missing = Object.keys(n.properties).filter((k) => !(n.required ?? []).includes(k));
				if (missing.length) bad.push(`${path}: required 누락 ${missing.join(',')}`);
			}
			for (const [k, v] of Object.entries(n)) walk(v, `${path}/${k}`);
		};
		walk(buildAnalysisSchema(loadTaxonomy()), '#');
		expect(bad).toEqual([]);
	});
});
