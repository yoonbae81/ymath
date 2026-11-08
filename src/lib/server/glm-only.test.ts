import { afterEach, expect, it, vi } from 'vitest';
import { PROVIDERS, providerLabel, type ItemRecord } from '$lib/types';
import { providerFor } from './analyze';
import { runStructured, runText } from './llm';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('GLM is the only available provider', () => { expect(PROVIDERS).toEqual(['glm']); });
it.each(['zai', 'codex', 'agy', 'claude', 'omlx', 'unknown'])('rejects explicit %s without network or CLI execution', async (provider) => {
 const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
 await expect(runStructured(provider as never, { prompt: '', schema: {}, dir: '', imagePath: '' })).rejects.toThrow('사용할 수 없는 LLM');
 await expect(runText(provider as never, '')).rejects.toThrow('사용할 수 없는 LLM');
 expect(fetch).not.toHaveBeenCalled();
});
it.each(['omlx', 'codex', 'agy', 'claude', 'unknown'])('safely defaults stale history %s to GLM', (provider) => {
 expect(providerFor({ requested_provider: provider } as ItemRecord)).toBe('glm');
});
it('preserves historical provider labels', () => {
 expect(providerLabel('omlx')).toBe('Qwen (oMLX)'); expect(providerLabel('zai')).toBe('GLM 5.3 (Z.AI)'); expect(providerLabel('codex')).toBe('Codex'); expect(providerLabel('agy')).toBe('Agy (Gemini)'); expect(providerLabel('claude')).toBe('Claude');
});
