/** Compatibility utilities for per-process mutation throttling and request address logging.
 * Family application access is anonymous; this module intentionally contains no login,
 * session-cookie, password, LAN-trust, guest, or share-link authentication code.
 */
function createLimiter(max = 300, windowMs = 10 * 60_000, capacity = 500) {
	const hits = new Map<string, { count: number; resetAt: number }>();
	const live = (key: string, now: number) => {
		const hit = hits.get(key);
		if (hit && hit.resetAt > now) return hit;
		hits.delete(key);
		return null;
	};
	return {
		blocked: (key: string, now = Date.now()) => (live(key, now)?.count ?? 0) >= max,
		fail(key: string, now = Date.now()) {
			const hit = live(key, now);
			if (hit) { hit.count++; return; }
			if (hits.size >= capacity) {
				for (const [entry, value] of hits) if (value.resetAt <= now) hits.delete(entry);
				if (hits.size >= capacity) hits.delete(hits.keys().next().value as string);
			}
			hits.set(key, { count: 1, resetAt: now + windowMs });
		},
		reset: (key: string) => void hits.delete(key)
	};
}

export const mutationLimiter = createLimiter();

export function clientIp(socketAddress: string, headers: Headers): string {
	const socket = socketAddress.trim().replace(/^::ffff:/i, '');
	if (!(socket === '::1' || socket.startsWith('127.'))) return socket;
	return (headers.get('x-real-ip') ?? '').trim().replace(/^::ffff:/i, '') || socket;
}
