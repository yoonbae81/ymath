import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import type { ItemRecord, Workbook } from '$lib/types';
import { dataDir } from './config';
import { IMAGE_FILE } from './image';

const ID_RE = /^\d{8}-\d{6}-[a-z0-9]{4}$/;
export const isValidId = (id: string) => ID_RE.test(id);

const itemsDir = () => join(dataDir(), 'items');
export const itemDir = (id: string) => {
	if (!isValidId(id)) throw new Error(`잘못된 항목 ID: ${id}`);
	return join(itemsDir(), id);
};
const recordPath = (id: string) => join(itemDir(id), 'record.json');

/** 시간순 정렬이 되는 ID. 예: 20260919-142301-ab12 */
export function newId(now = new Date()): string {
	const p = (n: number, w = 2) => String(n).padStart(w, '0');
	const date = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
	const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
	const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
	return `${date}-${time}-${rand}`;
}

/** 쓰다 죽어도 반쪽짜리 JSON 이 남지 않도록 임시 파일에 쓰고 rename 한다. */
function writeJsonAtomic(path: string, value: unknown) {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
	renameSync(tmp, path);
}

export function createItem(workbook: Workbook, now = new Date()): ItemRecord {
	const id = newId(now);
	mkdirSync(itemDir(id), { recursive: true });
	const record: ItemRecord = {
		schema_version: 1,
		id,
		created_at: now.toISOString(),
		status: 'queued',
		error: null,
		attempts: 0,
		workbook,
		image: IMAGE_FILE,
		flags: { ocr_missing: false, taxonomy_mismatch: [], guardrail: [] },
		analysis: null,
		meta: null
	};
	writeJsonAtomic(recordPath(id), record);
	return record;
}

export function readRecord(id: string): ItemRecord | null {
	if (!isValidId(id) || !existsSync(recordPath(id))) return null;
	return JSON.parse(readFileSync(recordPath(id), 'utf8')) as ItemRecord;
}

/** 읽고-고치고-쓰기를 동기로 수행한다(단일 프로세스라 경합이 없다). */
export function updateRecord(id: string, fn: (r: ItemRecord) => void): ItemRecord {
	const record = readRecord(id);
	if (!record) throw new Error(`항목을 찾을 수 없음: ${id}`);
	fn(record);
	writeJsonAtomic(recordPath(id), record);
	return record;
}

/** 최신순 */
export function listRecords(): ItemRecord[] {
	if (!existsSync(itemsDir())) return [];
	return readdirSync(itemsDir())
		.filter(isValidId)
		.map((id) => readRecord(id))
		.filter((r): r is ItemRecord => r !== null)
		.sort((a, b) => (a.id < b.id ? 1 : -1));
}

export function deleteItem(id: string): boolean {
	if (!existsSync(itemDir(id))) return false;
	rmSync(itemDir(id), { recursive: true, force: true });
	return true;
}

/** 새 오류 패턴 ID 를 기존 것과 맞춰 쓰도록 프롬프트에 넣을 목록(많이 나온 순) */
/** 오류를 확인하지 못한 항목의 고정 패턴 ID. 재사용 목록과 재발 집계에서 뺀다 */
export const UNCONFIRMED_PATTERN_ID = 'unconfirmed';

export function knownPatternIds(limit = 60): { id: string; count: number; example: string }[] {
	const map = new Map<string, { count: number; example: string }>();
	for (const r of listRecords()) {
		const ea = r.analysis?.error_analysis;
		if (!ea?.error_pattern_id || ea.error_pattern_id === UNCONFIRMED_PATTERN_ID) continue;
		const cur = map.get(ea.error_pattern_id);
		if (cur) cur.count++;
		else map.set(ea.error_pattern_id, { count: 1, example: ea.misconception });
	}
	return [...map.entries()]
		.map(([id, v]) => ({ id, ...v }))
		.sort((a, b) => b.count - a.count)
		.slice(0, limit);
}
