import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Analysis } from '$lib/types';
import analysisSchema from './analysis.schema.json';
import { promptsDir } from './config';

export interface Concept {
	id: string;
	desc: string;
	unit: string;
	topic: string;
}
export interface Unit {
	name: string;
	course: string;
	topic: string;
	concepts: Concept[];
}
export interface Taxonomy {
	topics: string[];
	units: Unit[];
	unitByName: Map<string, Unit>;
	conceptById: Map<string, Concept>;
}

const CONCEPT_ID = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$/;

/** user/prompts/curriculum.md 를 파싱한다. 형식 위반은 줄 번호와 함께 예외로 던진다. */
export function parseTaxonomy(md: string): Taxonomy {
	const topics: string[] = [];
	const units: Unit[] = [];
	const unitByName = new Map<string, Unit>();
	const conceptById = new Map<string, Concept>();
	let topic: string | null = null;
	let unit: Unit | null = null;

	md.split('\n').forEach((line, i) => {
		const at = `curriculum.md ${i + 1}행`;
		let m: RegExpMatchArray | null;
		if ((m = line.match(/^## (.+?)\s*$/))) {
			const name = m[1];
			if (topics.includes(name)) throw new Error(`${at}: 영역 중복 '${name}'`);
			topics.push(name);
			topic = name;
			unit = null;
		} else if ((m = line.match(/^### (.+?)\s*\|\s*(.+?)\s*$/))) {
			if (!topic) throw new Error(`${at}: 영역(##) 앞에 단원이 있습니다`);
			const name = m[1];
			if (unitByName.has(name)) throw new Error(`${at}: 단원 이름 중복 '${name}'`);
			unit = { name, course: m[2], topic, concepts: [] };
			units.push(unit);
			unitByName.set(name, unit);
		} else if ((m = line.match(/^- ([A-Z0-9-]+)\s*\|\s*(.+?)\s*$/))) {
			const [, id, desc] = m;
			if (!unit) throw new Error(`${at}: 단원(###) 앞에 개념이 있습니다`);
			if (!CONCEPT_ID.test(id)) throw new Error(`${at}: 개념 ID 형식 오류 '${id}'`);
			if (conceptById.has(id)) throw new Error(`${at}: 개념 ID 중복 '${id}'`);
			const concept = { id, desc, unit: unit.name, topic: unit.topic };
			unit.concepts.push(concept);
			conceptById.set(id, concept);
		}
	});

	if (topics.length === 0) throw new Error('curriculum.md: 영역(##)이 하나도 없습니다');
	// '## 메모' 같은 제목이 조용히 영역이 되지 않도록, 단원 없는 영역은 오류로 한다
	const noUnits = topics.filter((name) => !units.some((u) => u.topic === name));
	if (noUnits.length) throw new Error(`curriculum.md: 단원(###)이 없는 영역 ${noUnits.join(', ')}`);
	const empty = units.filter((u) => u.concepts.length === 0);
	if (empty.length) throw new Error(`curriculum.md: 개념이 없는 단원 ${empty.map((u) => u.name).join(', ')}`);
	return { topics, units, unitByName, conceptById };
}

export function loadTaxonomy(): Taxonomy {
	return parseTaxonomy(readFileSync(join(promptsDir(), 'curriculum.md'), 'utf8'));
}

/** 프롬프트에 넣을 선택지 목록 */
export function renderTaxonomy(t: Taxonomy): string {
	const out: string[] = [];
	for (const topic of t.topics) {
		out.push(`## 영역: ${topic}`);
		for (const u of t.units.filter((u) => u.topic === topic)) {
			out.push(`### 단원: ${u.name} (${u.course})`);
			for (const c of u.concepts) out.push(`- ${c.id}: ${c.desc}`);
		}
	}
	return out.join('\n');
}

/** 정적 스키마에 curriculum.md 기준 enum 을 채워 넣는다. */
export function buildAnalysisSchema(t: Taxonomy): Record<string, unknown> {
	// 스키마는 코드와 함께 빌드에 포함된다(실행 시점에 읽는 파일이 아니다). 원본이 바뀌지 않게 복사해서 쓴다
	const schema = structuredClone(analysisSchema) as any;
	delete schema.$comment;
	const cls = schema.properties.classification.properties;
	cls.topic.enum = t.topics;
	cls.secondary_topics.items.enum = t.topics;
	cls.unit_major.enum = t.units.map((u) => u.name);
	const ids = [...t.conceptById.keys()];
	cls.concept_ids.items.enum = ids;
	schema.properties.error_analysis.properties.root_cause_concept_ids.items.enum = ids;
	return schema;
}

/** LLM 출력이 분류 체계와 어긋나는 지점을 모은다. 비어 있으면 정합. */
export function checkClassification(t: Taxonomy, a: Analysis): string[] {
	const issues: string[] = [];
	const { topic, unit_major, concept_ids } = a.classification;
	if (!t.topics.includes(topic)) issues.push(`알 수 없는 영역 '${topic}'`);
	const unit = t.unitByName.get(unit_major);
	if (!unit) issues.push(`알 수 없는 단원 '${unit_major}'`);
	else if (unit.topic !== topic) issues.push(`단원 '${unit_major}'은 '${unit.topic}' 영역인데 topic이 '${topic}'`);
	// 문제 풀이에 쓰이는 개념은 다른 단원 소속일 수 있으므로 존재 여부만 검사한다
	for (const id of concept_ids) if (!t.conceptById.has(id)) issues.push(`알 수 없는 개념 ID '${id}'`);
	for (const id of a.error_analysis.root_cause_concept_ids)
		if (!t.conceptById.has(id)) issues.push(`알 수 없는 근본 원인 개념 ID '${id}'`);
	return issues;
}
