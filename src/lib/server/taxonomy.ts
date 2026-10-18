import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promptsDir } from './config';
import {
	buildAnalysisSchema,
	checkClassification,
	parseTaxonomy,
	renderTaxonomy,
	type Taxonomy
} from './taxonomy-core';

export type { Concept, Taxonomy, Unit } from './taxonomy-core';
export { buildAnalysisSchema, checkClassification, parseTaxonomy, renderTaxonomy } from './taxonomy-core';

export function loadTaxonomy(): Taxonomy {
	return parseTaxonomy(readFileSync(join(promptsDir(), 'curriculum.md'), 'utf8'));
}
