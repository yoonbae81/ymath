import Ajv from 'ajv';
import type { Analysis } from '$lib/types';

/** Node runner can compile user-editable schemas at runtime. Worker builds replace
 * this module with the same AJV validator compiled at build time. */
export function validateAnalysis(schema: object, value: unknown): asserts value is Analysis {
	const ajv = new Ajv({ allErrors: true, strict: false });
	const validate = ajv.compile(schema);
	if (!validate(value)) {
		const msg = (validate.errors ?? []).slice(0, 5).map((e: { instancePath?: string; message?: string }) => `${e.instancePath || '/'} ${e.message}`);
		throw new Error(`분석 결과가 스키마와 다름: ${msg.join('; ')}`);
	}
}
