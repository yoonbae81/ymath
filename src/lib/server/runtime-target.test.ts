import { describe, expect, it } from 'vitest';
import { requireWorkerDatabase } from './runtime-target';

describe('Worker page storage bindings', () => {
	it('returns a clean 503 when D1 is missing in Worker mode', () => {
		expect(() => requireWorkerDatabase(undefined, false)).toThrowError(expect.objectContaining({ status: 503 }));
		expect(() => requireWorkerDatabase({ env: {} }, false)).toThrowError(expect.objectContaining({ status: 503 }));
	});

	it('keeps Node storage fallback available when platform bindings are absent', () => {
		expect(() => requireWorkerDatabase(undefined, true)).not.toThrow();
	});
});
