export async function runPollerCycle(concurrency: number, runOnce: () => Promise<boolean>): Promise<boolean[]> {
	const lanes = Math.max(1, Math.min(8, Math.floor(concurrency) || 1));
	return Promise.all(Array.from({ length: lanes }, () => runOnce()));
}

export function quotaRetryDelayMs(value = process.env.QUOTA_RETRY_DELAY_MS): number {
	const parsed = Number(value ?? 600_000);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 600_000;
}

export function retryAfterSeconds(message: string, delayMs = quotaRetryDelayMs()): number {
	return /429|rate.?limit/i.test(message) ? Math.ceil(delayMs / 1000) : 30;
}
