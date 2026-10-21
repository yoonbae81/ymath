import { afterEach, expect, it, vi } from 'vitest';
import { PROVIDERS, providerLabel, type ItemRecord } from '$lib/types';
import { providerFor } from './analyze';
import { runStructured, runText } from './llm';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('Qwen, GLM, and Gemini are the available providers', () => { expect(PROVIDERS).toEqual(['omlx', 'glm', 'agy']); });
it.each(['zai', 'codex', 'agy', 'claude', 'unknown'])('rejects explicit %s without network or CLI execution', async (provider) => {
 const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
 await expect(runStructured(provider as never, { prompt: '', schema: {}, dir: '', imagePath: '' })).rejects.toThrow('사용할 수 없는 LLM');
 await expect(runText(provider as never, '')).rejects.toThrow('사용할 수 없는 LLM');
 expect(fetch).not.toHaveBeenCalled();
});
it.each(['zai', 'codex', 'agy', 'claude', 'unknown'])('safely defaults stale history %s to Qwen', (provider) => {
 vi.stubEnv('ANALYZE_PROVIDER', 'codex');
 expect(providerFor({ requested_provider: provider } as ItemRecord)).toBe('omlx');
});
it('preserves historical provider labels', () => {
 expect(providerLabel('zai')).toBe('GLM 5.3 (Z.AI)'); expect(providerLabel('codex')).toBe('Codex'); expect(providerLabel('agy')).toBe('Gemini'); expect(providerLabel('claude')).toBe('Claude');
});
