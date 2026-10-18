import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';
import type { Plugin } from 'vite';
import { buildAnalysisSchema, parseTaxonomy } from '../src/lib/server/taxonomy-core.ts';

/** workerd prohibits AJV's runtime new Function. Preserve the exact schema and
 * error contract by compiling AJV during the build, never inside a request. */
export function workerAnalysisValidator(): Plugin {
	const id = '\0ymath:analysis-validator';
	return {
		name: 'worker-analysis-validator',
		enforce: 'pre',
		resolveId(source, importer, options) {
			if (process.env.BUILD_TARGET !== 'node' && process.env.VITEST !== 'true' && options.ssr && source === './analysis-validator' && importer?.endsWith('/analyze-prompt.ts')) return id;
		},
		load(source) {
			if (source !== id) return;
			const curriculum = new URL('../user/prompts/curriculum.md', import.meta.url);
			this.addWatchFile(curriculum.pathname);
			const schema = buildAnalysisSchema(parseTaxonomy(readFileSync(curriculum, 'utf8')));
			const ajv = new Ajv({ allErrors: true, strict: false, code: { source: true, esm: true } });
			const compiled = standaloneCode(ajv, ajv.compile(schema));
			return compiled + `
export function validateAnalysis(schema, value) {
  if (JSON.stringify(schema) !== ${JSON.stringify(JSON.stringify(schema))}) throw new Error('Worker analysis schema differs from build-time curriculum; rebuild required');
  if (!validate(value)) {
    const msg = (validate.errors ?? []).slice(0, 5).map(e => (e.instancePath || '/') + ' ' + e.message);
    throw new Error('분석 결과가 스키마와 다름: ' + msg.join('; '));
  }
}
`;
		}
	};
}
