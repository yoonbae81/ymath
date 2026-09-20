/** 실제 curriculum.md 와 스키마를 통과하는 분석 결과 예시(테스트용) */
export const validAnalysis = () => ({
	problem: { number_guess: '12', text_md: '$x^2-5x+6=0$', figure_description: '' },
	classification: {
		topic: '대수',
		topic_rationale: '근과 계수의 관계',
		secondary_topics: [],
		unit_major: '방정식과 부등식',
		unit_minor: '근과 계수의 관계',
		concept_ids: ['ALG-ROOT-COEFF'],
		question_type: '계산',
		difficulty: 2
	},
	asks: 'α²+β²의 값',
	student_work: { visible: true, transcription_md: '…', student_answer: '37' },
	error_analysis: {
		error_type: '연산·기호 착오',
		error_step: '3번째 줄',
		explanation: '…',
		root_cause_concept_ids: ['ALG-EXPANSION'],
		prerequisites: ['곱셈공식'],
		misconception: '2αβ 부호 착각',
		error_pattern_id: 'sign-error-expansion',
		trigger: '합의 제곱을 변형할 때',
		self_check: '두 근을 직접 구해 내 결과와 비교해 봤나요?',
		nudges: {
			condition_question: '2행에서 (α+β)²을 전개했을 때 나오는 항들을 모두 적어 보면 어떤 항이 남나요?',
			strategy_question: 'α²+β²를 (α+β)²과 비교해 보면 두 식은 어떤 항만큼 차이가 나나요?'
		},
		severity: 1
	},
	flags: { multiple_problems: false, unreadable: false },
	verification: { independently_solved: true, student_error_confirmed: true },
	confidence: 'high'
});
