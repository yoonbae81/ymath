/** 사진 내구 백업 — 정규화된 JPEG 를 MinIO(s3.xcv.kr) 에 미러링한다.
 *
 * 정책(운영 방침 2026-11-01): 사진은 분석 성공·실패와 무관하게 자동 삭제되지 않는다.
 * 앱은 디스크 사본(user/data/items/<id>/image.jpg)으로 동작하고, S3 사본은 재해 복구용
 * 내구 카피다. S3 사본을 지우는 유일한 경로는 사용자의 명시적 삭제(UI)다 —
 * UI 삭제 시 MinIO 사본도 함께 삭제된다(아래 deleteMirror).
 * 자격증명은 .env 의 S3_ENDPOINT·S3_BUCKET·S3_REGION·S3_ACCESS_KEY_ID·S3_SECRET_ACCESS_KEY.
 */
import { AwsClient } from 'aws4fetch';

const endpoint = () => process.env.S3_ENDPOINT?.replace(/\/+$/, '') ?? '';
const bucket = () => process.env.S3_BUCKET ?? '';

export function photoBackupConfigured(): boolean {
	return Boolean(endpoint() && bucket() && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
}

/** 명시적 삭제(UI) 때만 호출한다 — MinIO 사본도 함께 지운다. 대상이 없어도(404) 성공.
 * 이 함수 외 어떤 경로도 S3 사본을 지우지 않는다(자동 삭제 없음 정책). */
export async function deleteMirror(key: string): Promise<void> {
	if (!photoBackupConfigured()) throw new Error('사진 백업 설정(.env 의 S3_*)이 없습니다');
	const client = new AwsClient({
		accessKeyId: process.env.S3_ACCESS_KEY_ID!,
		secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
		region: process.env.S3_REGION || 'us-east-1'
	});
	const objectUrl = `${endpoint()}/${bucket()}/${key.split('/').map(encodeURIComponent).join('/')}`;
	const res = await client.fetch(objectUrl, {
		method: 'DELETE',
		aws: { service: 's3', region: process.env.S3_REGION || 'us-east-1' }
	});
	if (res.status !== 404 && !res.ok) throw new Error(`사진 백업 삭제 실패(${res.status}): ${key}`);
}

/** 정규화된 사진 바이트를 S3 에 저장한다. 실패 시 던진다(접수 거절 — 보존 보장). */
export async function mirrorPhoto(key: string, bytes: Uint8Array, contentType = 'image/jpeg'): Promise<void> {
	if (!photoBackupConfigured()) throw new Error('사진 백업 설정(.env 의 S3_*)이 없습니다');
	const client = new AwsClient({
		accessKeyId: process.env.S3_ACCESS_KEY_ID!,
		secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
		region: process.env.S3_REGION || 'us-east-1'
	});
	const objectUrl = `${endpoint()}/${bucket()}/${key.split('/').map(encodeURIComponent).join('/')}`;
	const res = await client.fetch(objectUrl, {
		method: 'PUT',
		body: bytes as unknown as BodyInit,
		headers: { 'content-type': contentType },
		aws: { service: 's3', region: process.env.S3_REGION || 'us-east-1' }
	});
	if (!res.ok) throw new Error(`사진 백업 실패(${res.status}): ${key}`);
}
