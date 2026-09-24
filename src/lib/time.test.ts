import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatDateTimeFull, formatDateTimeSeconds, formatTime } from './time';

const KST = { timeZone: 'Asia/Seoul' };

describe('시각은 24시간제로 보인다', () => {
	it('오후 시각을 18:05 로 표시한다(오후 6:05 가 아님)', () => {
		const iso = '2026-09-19T09:05:09.000Z'; // KST 18:05:09
		expect(formatDateTime(iso, KST)).toContain('18:05');
		expect(formatTime(iso, KST)).toBe('18:05');
		expect(formatDateTimeSeconds(iso, KST)).toContain('18:05:09');
	});

	it('오전·오후 표기가 어디에도 나오지 않는다', () => {
		for (const h of [0, 1, 9, 11, 12, 13, 18, 23]) {
			const iso = new Date(Date.UTC(2026, 8, 19, h - 9, 30)).toISOString(); // KST h:30
			for (const s of [formatDateTime(iso, KST), formatTime(iso, KST), formatDateTimeSeconds(iso, KST)]) {
				expect(s, `${h}시`).not.toMatch(/오전|오후|AM|PM/i);
			}
		}
	});

	it('자정은 24:xx 가 아니라 00:xx, 정오는 12:xx', () => {
		expect(formatTime('2026-09-18T15:05:00.000Z', KST)).toBe('00:05'); // KST 00:05
		expect(formatTime('2026-09-19T03:05:00.000Z', KST)).toBe('12:05'); // KST 12:05
		expect(formatDateTime('2026-09-18T15:05:00.000Z', KST)).not.toContain('24:');
	});

	it('날짜 부분은 MM/DD 로 보인다', () => {
		expect(formatDateTime('2026-09-19T09:05:00.000Z', KST)).toBe('09/19 18:05');
	});

	it('formatDate 는 시간 없이 MM/DD 날짜만 돌려준다', () => {
		const iso = '2026-09-19T09:05:09.000Z';
		expect(formatDate(iso, KST)).toBe('09/19');
		expect(formatDate(iso, KST)).not.toContain(':');
	});

	it('formatDateTimeFull 은 연월일까지 yyyy-mm-dd HH:mm 로 돌려준다', () => {
		expect(formatDateTimeFull('2026-09-19T09:05:09.000Z', KST)).toBe('2026-09-19 18:05');
	});
});
