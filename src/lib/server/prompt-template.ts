/** 순수(pure) 프롬프트 템플릿 치환 — node:fs 없이 Worker 번들에서 import 가능하다.
 * config.ts 가 renderPrompt 를 재노출하므로 기존 공개 계약은 그대로다. */

/** 프롬프트 템플릿의 학생 이름 치환. STUDENT_NAME 환경변수가 있으면 친근하게 반영하고, 없으면 자연스러운 기본형으로 처리 */
export function renderPrompt(template: string, name = process.env.STUDENT_NAME?.trim()): string {
	if (name) {
		return template
			.replaceAll('{{STUDENT_NAME}}', name)
			.replaceAll('{{STUDENT_PAREN}}', `(${name})`)
			.replaceAll('{{STUDENT_POSSESSIVE}}', `${name}의 `)
			.replaceAll('{{STUDENT_TOPIC}}', `${name}가 `);
	}
	return template
		.replaceAll('{{STUDENT_NAME}}', '학생')
		.replaceAll('{{STUDENT_PAREN}}', '')
		.replaceAll('{{STUDENT_POSSESSIVE}}', '')
		.replaceAll('{{STUDENT_TOPIC}}', '');
}
