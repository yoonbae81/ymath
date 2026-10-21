/** Cloudflare Workers 와 공유하는 S3(MinIO, s3.xcv.kr) 스토어 — 유일한 객체 저장 계층.
 * Cloudflare Workers 런타임에서 aws4fetch(SigV4)로 동작한다. 모든 객체(업로드 raw·정규화
 * 이미지·OCR·분석 결과·baton staging)는 이 스토어로 쓰고 읽는다 — Runner 도 같은 버킷을
 * 바라본다(ymath/baton/analysis/contract.md). S3 설정이 없으면 조용한 폴백 없이
 * 명확히 실패한다(fail closed). */
import { AwsClient } from 'aws4fetch';

export interface S3StoreEnv { S3_ENDPOINT?: string; S3_BUCKET?: string; S3_REGION?: string; S3_ACCESS_KEY_ID?: string; S3_SECRET_ACCESS_KEY?: string }

export interface S3Store {
	put(key: string, body: Uint8Array, contentType: string): Promise<void>;
	get(key: string): Promise<Uint8Array | null>;
	delete(key: string): Promise<void>;
}

export function s3StoreFromEnv(env: S3StoreEnv): S3Store | null {
	const endpoint = env.S3_ENDPOINT?.trim().replace(/\/+$/, '');
	const bucket = env.S3_BUCKET?.trim();
	const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
	const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
	if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
	if (!/^https:\/\//.test(endpoint) && !/^http:\/\/127\.0\.0\.1/.test(endpoint)) throw new Error('S3_ENDPOINT must be https');
	const region = env.S3_REGION?.trim() || 'us-east-1';
	const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region });
	const base = `${endpoint}/${bucket}`;
	return {
		async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
			const response = await client.fetch(`${base}/${key}`, { method: 'PUT', body: body as BodyInit, headers: { 'content-type': contentType } });
			if (!response.ok) throw new Error(`S3_PUT_FAILED: ${response.status} ${key}`);
		},
		async get(key: string): Promise<Uint8Array | null> {
			const response = await client.fetch(`${base}/${key}`, { method: 'GET' });
			if (response.status === 404) return null;
			if (!response.ok) throw new Error(`S3_GET_FAILED: ${response.status} ${key}`);
			return new Uint8Array(await response.arrayBuffer());
		},
		async delete(key: string): Promise<void> {
			const response = await client.fetch(`${base}/${key}`, { method: 'DELETE' });
			if (!response.ok && response.status !== 404) throw new Error(`S3_DELETE_FAILED: ${response.status} ${key}`);
		}
	};
}

/** S3 설정은 필수다 — 없으면 명확히 실패한다(조용한 폴백 금지). */
export function requireS3Store(env: S3StoreEnv): S3Store {
	const store = s3StoreFromEnv(env);
	if (!store) throw new Error('S3_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY are required (S3-only storage; no fallback)');
	return store;
}
