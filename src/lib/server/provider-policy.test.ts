/** provider 정책 — Agy(Gemini CLI)·GLM(z.ai) 두 레인, 나머지는 폐기됐다. */
import { afterEach, afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AVAILABLE_PROVIDERS, PROVIDERS, providerLabel, type ItemRecord } from '$lib/types';
import { providerFor } from './analyze';
import { runStructured, runText } from './llm';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// providerFor 기본값은 설정 파일을 읽으므로, 실제 user/config 과 격리한다(zai 만 있는 상태 = 디폴트 glm).
let work: string;
beforeAll(() => {
	work = mkdtempSync(join(tmpdir(), 'ymath-policy-'));
	process.env.CONFIG_DIR = work;
	writeFileSync(join(work, 'providers.json'), JSON.stringify({ providers: { zai: { baseUrl: 'https://zai.test/v4', apiKey: 'k', models: [{ id: 'glm-5.3-flash' }] } } }));
});
afterAll(() => {
	delete process.env.CONFIG_DIR;
	rmSync(work, { recursive: true, force: true });
});

it('Agy(Gemini)와 GLM 두 provider를 제공한다', () => {
	expect(PROVIDERS).toEqual(['agy', 'glm']);
	expect(AVAILABLE_PROVIDERS.map((p) => p.id)).toEqual(['agy', 'glm']);
});
it.each(['zai', 'codex', 'claude', 'omlx', 'unknown'])('rejects explicit %s without network or CLI execution', async (provider) => {
	const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
	await expect(runStructured(provider as never, { prompt: '', schema: {}, dir: '', imagePath: '' })).rejects.toThrow('사용할 수 없는 LLM');
	await expect(runText(provider as never, '')).rejects.toThrow('사용할 수 없는 LLM');
	expect(fetch).not.toHaveBeenCalled();
});
it.each(['omlx', 'codex', 'claude', 'zai', 'unknown'])('safely defaults stale history %s to the configured default (glm)', (provider) => {
	expect(providerFor({ requested_provider: provider } as ItemRecord)).toBe('glm');
});
it('honors an explicit agy request', () => {
	expect(providerFor({ requested_provider: 'agy' } as ItemRecord)).toBe('agy');
});
it('providers.json 에 agy 항목이 있으면 설정 디폴트는 agy다', () => {
	const dir = mkdtempSync(join(tmpdir(), 'ymath-policy-agy-'));
	process.env.CONFIG_DIR = dir;
	writeFileSync(join(dir, 'providers.json'), JSON.stringify({ providers: { agy: { models: [{ id: 'gemini-3.8-flash-medium' }] } } }));
	try {
		expect(providerFor({} as ItemRecord)).toBe('agy');
	} finally {
		process.env.CONFIG_DIR = work;
		rmSync(dir, { recursive: true, force: true });
	}
});
it('preserves historical provider labels', () => {
	expect(providerLabel('omlx')).toBe('Qwen (oMLX)');
	expect(providerLabel('zai')).toBe('GLM 5.3 (Z.AI)');
	expect(providerLabel('codex')).toBe('Codex');
	expect(providerLabel('claude')).toBe('Claude');
	expect(providerLabel('agy')).toBe('Gemini 3.8 (Agy)');
});
