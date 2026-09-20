/**
 * 화면에 보이는 시각은 모두 24시간제(예: 18:05)로 통일한다.
 * 날짜 표시는 MM/DD 형태로 통일한다(예: 09/19).
 * `hour12: false` 는 일부 환경에서 자정을 "24:05" 로 내므로 `hourCycle: 'h23'` 을 쓴다.
 * 시각을 화면에 그릴 때는 이 함수들만 쓰고, toLocaleString 을 직접 부르지 않는다(기본값이 오전/오후 12시간제라서).
 */
type Opts = { timeZone?: string };

function getParts(iso: string, o: Opts = {}) {
	const d = new Date(iso);
	const f = new Intl.DateTimeFormat('en-US', {
		timeZone: o.timeZone,
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23'
	});
	return Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
}

/** 09/19 18:05 */
export function formatDateTime(iso: string, o: Opts = {}): string {
	const p = getParts(iso, o);
	return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

/** 09/19 18:05:09 (작업 현황처럼 초 단위가 필요한 곳) */
export function formatDateTimeSeconds(iso: string, o: Opts = {}): string {
	const p = getParts(iso, o);
	return `${p.month}/${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** 18:05 */
export function formatTime(iso: string, o: Opts = {}): string {
	const p = getParts(iso, o);
	return `${p.hour}:${p.minute}`;
}

/** 09/19 (날짜만 표시할 때) */
export function formatDate(iso: string, o: Opts = {}): string {
	const p = getParts(iso, o);
	return `${p.month}/${p.day}`;
}
