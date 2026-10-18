import { afterEach, describe, expect, it, vi } from 'vitest';
import { quotaRetryDelayMs, retryAfterSeconds, runPollerCycle } from './runner-poller';

describe('Cloudflare runner poll orchestration', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('runs different claim lanes concurrently while respecting its configured bound', async () => {
		let active = 0;
		let peak = 0;
		let started = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const cycle = runPollerCycle(4, async () => {
			active++;
			peak = Math.max(peak, active);
			started++;
			if (started === 4) release();
			await gate;
			await new Promise((resolve) => setTimeout(resolve, 0));
			active--;
			return true;
		});
		expect(await cycle).toEqual([true, true, true, true]);
		expect(peak).toBe(4);
	});

	it('preserves the 10 minute default quota retry delay', () => {
		expect(quotaRetryDelayMs()).toBe(600_000);
		expect(quotaRetryDelayMs('120000')).toBe(120_000);
		expect(quotaRetryDelayMs('invalid')).toBe(600_000);
		expect(retryAfterSeconds('429 quota exceeded')).toBe(600);
	});
});
