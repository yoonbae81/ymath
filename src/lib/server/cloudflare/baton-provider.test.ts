/**
 * Baton 재분석 provider 선택 계약 — 카탈로그 등록 id 만 허용(fail-closed).
 *
 * 와이어: BatonExecuteRequest.profile_id, item-callbacks claim job.profile_id,
 * baton-analysis trigger 데이터 (Hosted path), Runner execute/runOnce profile selection,
 * meta.provider — 전 단계를 검증.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PROVIDERS, PROVIDER_LABEL, providerLabel, type Provider } from '$lib/types';

it('labels GLM as the only registered provider', () => {
  expect(PROVIDER_LABEL).toEqual({ glm: 'GLM' });
  // 삭제된 provider 는 레거시 라벨로 계속 읽힌다
  expect(providerLabel('omlx')).toBe('Qwen (oMLX)');
  expect(providerLabel('agy')).toBe('Agy (Gemini)');
});

/* --------------------------------------------------------------------------- */
/*  Slice 1 — 카탈로그 동기성 (RED: baton-catalog.ts 미존재 → import 실패)    */
/* --------------------------------------------------------------------------- */

import { batonCatalog, batonProfileForProvider, assertBatonProviderSelectable, batonDefaultProvider } from './baton-catalog';

const SOURCE_PATH = '/Users/y/Github/baton/config/ymath.cloud.json';

describe('catalog sync & shape', () => {
  it('checked-in catalog copy matches the baton repo source of truth (providers+profiles)', (ctx) => {
    let source: string | undefined;
    try { source = readFileSync(SOURCE_PATH, 'utf8'); }
    catch { /* baton repo not present — 동기성 검증 불가, 이 테스트만 건너뛴다 */ }
    if (!source) ctx.skip();
    const parsed = JSON.parse(source!);
    expect(batonCatalog.providers).toEqual(parsed.providers);
    expect(batonCatalog.profiles).toEqual(parsed.profiles);
  });

  it('PROVIDERS equals catalog provider ids in stable order', () => {
    expect([...PROVIDERS]).toEqual(Object.keys(batonCatalog.providers));
  });

  it('PROVIDERS contains exactly glm', () => {
    expect(PROVIDERS).toEqual(['glm']);
    expect(PROVIDERS).not.toContain('omlx');
    expect(PROVIDERS).not.toContain('agy');
  });

  it('batonDefaultProvider is glm', () => {
    expect(batonDefaultProvider).toBe('glm');
  });

  it('maps each catalog provider to its Runner profile and rejects unknown ids', () => {
    expect(batonProfileForProvider('glm')).toBe('analysis');
    for (const id of Object.keys(batonCatalog.providers)) {
      expect(batonProfileForProvider(id)).toBeTruthy();
    }
    expect(batonProfileForProvider('qwen')).toBeNull();
    expect(batonProfileForProvider('gpt')).toBeNull();
    expect(batonProfileForProvider('')).toBeNull();
  });

  it('assertBatonProviderSelectable throws for unknown providers', () => {
    expect(() => assertBatonProviderSelectable('qwen')).toThrow(/카탈로그/);
    expect(() => assertBatonProviderSelectable('gpt')).toThrow(/카탈로그/);
    expect(() => assertBatonProviderSelectable('')).toThrow(/카탈로그/);
  });

  it('assertBatonProviderSelectable passes for catalog providers', () => {
    expect(() => assertBatonProviderSelectable('glm')).not.toThrow();
    expect(() => assertBatonProviderSelectable('omlx')).toThrow(/카탈로그/);
  });
});

/* --------------------------------------------------------------------------- */
/*  Slice 2 — 와이어 계약 (RED: validateBatonRequest에 profile_id 미지원)     */
/* --------------------------------------------------------------------------- */

import { validateBatonRequest, type BatonExecuteRequest } from '../../../../baton/analysis/functions';

function baseRequest(): BatonExecuteRequest {
  return {
    job_id: '12345678-1234-1234-1234-123456789abc',
    entity_id: '20260101-000000-ab12',
    entity_generation: 1,
    request_key: 'items/20260101-000000-ab12/baton-request-12345678-1234-1234-1234-123456789abc-1.json',
    image_key: 'items/20260101-000000-ab12/image-1.jpg',
    run_id: 'run-1',
  };
}

describe('BatonExecuteRequest profile_id wire contract', () => {
  it('accepts valid profile_id', () => {
    expect(() => validateBatonRequest({ ...baseRequest(), profile_id: 'analysis' })).not.toThrow();
  });

  it.each(['analysis-glm', 'analysis-agy'])('rejects profile_id removed from the GLM-only catalog: %s', (pid) => {
    // profile_id 는 자유 문자열이라 와이어는 허용하지만, 카탈로그 선택 단계에서 fail-closed 다
    expect(batonProfileForProvider(pid)).toBeNull();
  });

  it.each([
    'analysis_glm',   // underscore not allowed
    'ANALYSIS',       // uppercase
    '',               // empty
    '../evil',        // path escape
    'aaaaa'.repeat(14), // 70 chars: exceeds 64
  ])('rejects malformed profile_id: %s', (pid) => {
    expect(() => validateBatonRequest({ ...baseRequest(), profile_id: pid })).toThrow(/REQUEST_INVALID/);
  });

  it.each([5, 123, true, null, ['x']] as const)('rejects non-string profile_id: %s', (pid) => {
    expect(() => validateBatonRequest({ ...baseRequest(), profile_id: pid as never })).toThrow(/REQUEST_INVALID/);
  });
  it('allows undefined profile_id (opt-in default)', () => {
    const req = { ...baseRequest(), profile_id: undefined } as BatonExecuteRequest;
    expect(() => validateBatonRequest(req)).not.toThrow();
  });
});
