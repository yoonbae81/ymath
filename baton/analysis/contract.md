# ymath 오답 분석 계약 (contract)

이 문서는 ymath item 분석(산출물 유형 `analysis`)의 **산출물 구조·표기·검증 규칙의 유일한 근원**이다.
instruction 문서는 이 계약을 반복하지 않고 참조만 한다. 이 계약과 모델 출력이 다르면 출력이 틀린 것이다.

## 1. 산출물

- 분석 JSON 객체 **하나**. 다른 텍스트·코드펜스·주석 없이 순수 JSON 객체만 출력한다.
- 구조는 같은 디렉터리의 `analysis.output.schema.json`과 일치해야 한다(기계 검증 근원).
  아래는 같은 구조의 사람용 서술이며, 둘은 계약상 일치한다.

## 2. JSON 구조 (최상위 필드 8개, 추가 필드 금지)

- `problem`: `{ number_guess, text_md, figure_description }`
  - `number_guess`: 문제 번호. 보이지 않으면 빈 문자열.
  - `text_md`: 문제 본문. LaTeX 포함 Markdown. 도형·그래프가 있으면 풀이에 필요한 정보(길이, 각, 좌표, 표시된 조건)를 `figure_description`에 글로 옮긴다. 문제를 옮겨 적는 것은 정답 노출이 아니다.
- `classification`: `{ topic, topic_rationale, secondary_topics, unit_major, unit_minor, concept_ids, question_type, difficulty }`
  - `topic`: 영역. 정확히 하나(입력 taxonomy의 영역 목록 안에서). 판정 이유 한 줄을 `topic_rationale`에.
  - `secondary_topics`: 걸친 다른 영역 배열(집계 미사용).
  - `unit_major`: 입력 taxonomy의 단원 이름 그대로. 그 단원의 영역이 `topic`과 일치해야 한다.
  - `unit_minor`: 소단원·세부 주제 자유 서술.
  - `concept_ids`: 문제 풀이에 직접 쓰이는 개념 ID(보통 1~3개). `root_cause_concept_ids`는 근본 원인 개념(0~2개, 선수 개념·타 영역·타 학년 허용). ID는 입력 taxonomy에 있는 것만.
  - `question_type`: `"계산" | "증명·서술" | "도형" | "그래프" | "문장제" | "개념 이해" | "기타"` 중 정확히 하나.
  - `difficulty`: 1~5 정수.
- `asks`: 이 문제가 묻는 것 한 줄.
- `student_work`: `{ visible, transcription_md, student_answer }`
  - 풀이가 보이면 `visible: true`와 손글씨 그대로의 `transcription_md`. 채점 표시(×, 빗금)는 참고 반영.
- `error_analysis`: `{ error_type, error_step, explanation, root_cause_concept_ids, prerequisites, misconception, error_pattern_id, trigger, self_check, severity, nudges }`
  - `error_type`: `"숨은 전제·특수 조건 누락" | "개념의 본질적 해석 오류" | "전략·모델링 실패" | "연산·기호 착오" | "판정 불가"` 중 정확히 하나.
  - `nudges`: `{ condition_question, strategy_question }` — 정확히 2개의 질문.
- `flags`: `{ multiple_problems, unreadable }` — 둘 다 boolean. 한 사진에 여러 문제면 주된 문제 하나만 분석하고 `multiple_problems: true`. 읽을 수 없으면 추측하지 않고 `unreadable: true`.
- `confidence`: `"high" | "medium" | "low"`.
- `verification`: `{ independently_solved, student_error_confirmed }` — 둘 다 boolean. 확인한 사실만 참/거짓으로 남긴다(풀이 출력 금지).

## 3. 표기 규칙

- 모든 서술은 한국어 존댓말. 학생 평가·비난 금지.
- 수식은 LaTeX(`$...$`).
- `error_pattern_id`: 소문자 kebab-case, 3~5단어, 문제 소재가 아닌 **잘못 쓴 규칙의 이름** (예: `omit-integer-condition`). 정규식 `^[a-z0-9]+(-[a-z0-9]+)*$`. 기존 패턴 목록에 같은 오해가 있으면 표현이 달라도 그 ID를 재사용. 새 ID는 기존 목록 전체와 비교한 뒤에만 만든다.
- `판정 불가` 처리: 오류 성격을 확정할 근거가 없으면 `error_type: "판정 불가"`, `error_pattern_id: "unconfirmed"`, `severity: 1`, `confidence: low|medium`, `misconception`·`trigger`는 빈 문자열, `error_step`에 확인 불가 사실과 이유를 쓴다.

## 4. 검증 계약 (가드레일 — 위반 출력은 사용할 수 없다)

아래는 기계 검증 규칙이다. 각 규칙의 검사 대상 필드와 판정 기준을 정확히 따른다.

1. **정답·등식·풀이 전개 노출 금지(최우선).**
   - 사진에 정답이 없는 한, 어떤 필드에도 정답·최종 식·결정적 계산 전개를 쓰지 않는다. 스스로 푼 풀이의 식·값·중간 결과, 올바른 첫 수도 금지.
   - **등식 금지 필드**: `nudges.condition_question`, `nudges.strategy_question`, `self_check` — 이 세 필드에 `=`(또는 `＝`)가 포함되면 위반.
   - **질문형 필수**: 위 세 필드는 각각 물음표(`?` 또는 `？`)로 끝나는 질문이어야 한다.
   - **길이 상한**: 위 세 필드 각각 200자 이하.
   - **정답 유도 표현 금지 필드**: 위 세 필드 + `error_step`, `explanation`, `misconception`, `trigger` — "정답은/정답이", "올바른 식/풀이/답/값/계산", "답은 …이다", "(결과|값)은 …이다" 형태의 문장이 있으면 위반.
   - 학생이 쓴 (틀린) 식의 **인용**은 `error_step`·`explanation`·`misconception`에서 허용된다(그 자리에 올바른 식을 대신 쓰는 것은 금지).
   - **예외 — 사진에 보이는 답**: 사진에 인쇄되거나 학생이 적어 넣은 답은 그대로 인용해 대조·검증·진단할 수 있다(예: "적힌 답과 결괏값이 일치하는지 확인해 볼까요?"). 사진에 없는 답을 만들어 쓰는 것은 여전히 금지다.
2. 넛지 두 질문은 서로 다른 역할(Q1 조건 재확인 / Q2 개념·전략 전환)이며, 같은 말을 되풀이하지 않는다.
3. `severity`: 1~3 정수. `error_type`과 모순되지 않게 둔다.
4. 검증 후 자기 점검: "이 출력만 읽고 풀이의 다음 줄을 쓸 수 있는가?" — 쓸 수 있다면 노출 위반이다.
