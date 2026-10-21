import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'vite';
import { workerAnalysisValidator } from '../../../../scripts/worker-analysis-validator';
import { buildAnalysisSchema, parseTaxonomy } from '../taxonomy-core';
import { validAnalysis } from '../analysis.fixture';

afterEach(() => vi.unstubAllEnvs());

it('builds the actual Baton validator import for Workers without runtime code generation', async () => {
	vi.stubEnv('VITEST', 'false');
	vi.stubEnv('BUILD_TARGET', 'worker');
	const entry = fileURLToPath(new URL('./baton-analysis.ts', import.meta.url));
	// Keep the production import and importer intact; isolate only this failing seam.
	const validatorImport = readFileSync(entry, 'utf8').match(/^import \{ validateAnalysis \} from .+;$/m)![0];
	const result = await build({
		configFile: false,
		logLevel: 'silent',
		plugins: [workerAnalysisValidator(), {
			name: 'baton-validator-probe',
			load(id) { if (id === entry) return `${validatorImport}\nexport { validateAnalysis };`; }
		}],
		ssr: { noExternal: true },
		build: {
			ssr: true, write: false, minify: false,
			rollupOptions: { input: entry, output: { format: 'cjs' } }
		}
	});
	if (Array.isArray(result) || !('output' in result)) throw new Error('Expected one build output');
	const chunk = result.output.find((output) => output.type === 'chunk');
	if (!chunk || chunk.type !== 'chunk') throw new Error('Missing validator chunk');
	const exported: { validateAnalysis?: (schema: object, value: unknown) => void } = {};
	runInNewContext(chunk.code, { exports: exported }, { contextCodeGeneration: { strings: false, wasm: false } });
	const schema = buildAnalysisSchema(parseTaxonomy(readFileSync(new URL('../../../../user/prompts/curriculum.md', import.meta.url), 'utf8')));
	expect(() => exported.validateAnalysis!(schema, validAnalysis())).not.toThrow();
	const invalid = validAnalysis();
	// Actual failed receipt included a course suffix outside the taxonomy enum.
	invalid.classification.unit_major = '삼각형과 사각형의 성질 (중2-2)';
	expect(() => exported.validateAnalysis!(schema, invalid)).toThrow(/\/classification\/unit_major/);
	expect(() => exported.validateAnalysis!({}, validAnalysis())).toThrow(/rebuild required/);
});
