import type { ItemRecord, Status } from './types';

export const STATUS_LABEL: Record<Status, string> = {
	queued: '대기 중',
	ocr: '글자 인식 중',
	analyzing: '분석 중',
	done: '분석 완료',
	failed: '분석 실패'
};

export const STATUS_TONE: Record<Status, 'muted' | 'accent' | 'ok' | 'bad'> = {
	queued: 'muted',
	ocr: 'accent',
	analyzing: 'accent',
	done: 'ok',
	failed: 'bad'
};

export const hasActive = (items: Pick<ItemRecord, 'status'>[]) =>
	items.some((i) => i.status === 'queued' || i.status === 'ocr' || i.status === 'analyzing');
