/**
 * Baton 분석용 카탈로그 매핑 — catalog/ymath.providers.json 기반.
 *
 * ymath Worker 실행 시점에서 페이징·네트워크 없이 동기 실행하는 유일한 근원.
 * 복제의 근거: /Users/y/Github/baton/config/ymath.cloud.json (providers+profiles).
 * 동기성 테스트: baton-provider.test.ts.
 */
import catalog from '../../../../baton/catalog/ymath.providers.json';

/** 현재 허용된 Baton analysis provider id 목록 (카탈로그 서버 기준). */
export const PROVIDERS = Object.keys(catalog.providers) as string[];

/** 현재 카탈로그 객체 (동기성 테스트용). */
export const batonCatalog = catalog;

/** 기본 (하향 호환) provider id. 명시적 선택 없이 호출되면 이 값으로 실행. */
export const batonDefaultProvider = PROVIDERS[0] ?? 'omlx';

/**
 * catalog 매핑 — provider id → Runner profile id.
 * catalog.json profiles[profile].provider === provider 인 profile 키를 찾는다.
 * None found → null.
 */
export function batonProfileForProvider(provider: string): string | null {
	for (const [profileId, profile] of Object.entries(catalog.profiles)) {
		if (profile.provider === provider) return profileId;
	}
	return null;
}

/**
 * provider 가 카탈로그에 등록되었는지 검증하고, 미등록 시 에러.
 * Runner 재시작 없이 설치가 완료되지 않은 provider 로 접근하면 fail-closed.
 */
export function assertBatonProviderSelectable(provider: string): void {
	if (!batonProfileForProvider(provider)) {
		throw new Error(`카탈로그에 등록되지 않은 LLM provider 입니다: ${provider}`);
	}
}
