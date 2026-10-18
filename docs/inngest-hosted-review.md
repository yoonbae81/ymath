# Inngest Hosted 제안 검토 — oMLX 유지와 추론 offload

## 판단

### 우선 방향

무료 범위의 예상 사용량이라면 자체 큐·재시도·실행 이력 기반을 추가 개발하기보다 **Inngest Hosted를 우선 채택 대상으로 삼는다.** 비교 자체를 계속 늘리기보다 기존 프로브 기준으로 실제 적합성을 판정한다. CF는 Workers/D1/R2의 앱·데이터 계층, Inngest는 실행 관리 및 infer offload, Mac은 기존 oMLX 제공으로 경계를 유지한다. 동일 목적의 CF Queues/CF Workflows를 중복 도입하지 않는다.

이 판단은 무료 한도가 충분하다는 실측이나 infer 호환성 검증 완료를 뜻하지 않는다. 적용 전 게이트는 (1) custom endpoint 합성 입력 1건 성공, (2) 125초 초과 공개 경로 호출 후 CF 재개, (3) 오류·재시도·중복 결과 방지, (4) 실제 단계 수를 반영한 executions/동시성 예산 확인이다. 무료 한도 소진 시 실행 중지 대응도 정의한다. 계정 생성·외부 모델 호출·배포·유료 전환 승인으로 해석하지 않는다. dev 검토/구현은 아직 수행하지 않았다.

Hosted는 후보가 맞지만, 제공된 callback 설계를 현재 oMLX에 그대로 적용할 수는 없다. 현재 설치된 oMLX에는 job ID 조기 반환/연결 종료 후 지속/완료 callback 계약이 없다(`docs/omlx-inference-capabilities.md`). Inngest의 waitForEvent가 그 기능을 생성해 주지는 않는다.

더 직접적인 후보는 **step.ai.infer()**다. 공식 문서는 이 기능이 추론 요청을 Inngest 인프라로 offload하고, 호출이 끝날 때까지 애플리케이션 실행을 중지했다가 결과와 함께 재개한다고 설명한다. OpenAI-compatible API를 지원하며 공식 DigitalOcean 예제는 openai adapter의 baseUrl 지정도 보여 준다. llm.xcv.kr과의 실제 호환성/시간 제한은 미검증이다.

이번 산출물은 문서 조사이며 SDK 설치·가입·배포·모델 호출·서버 변경을 하지 않았다. 구현 난이도/계약 확정은 dev 검토 전 미확정이다. UI 변경은 제안하지 않는다.

## CF와 Inngest의 책임 분담

사용자 메시지의 `D2`는 아래 설명에서 기존 레포가 사용하는 **D1**을 뜻하는 것으로 가정한다. 다른 제품을 뜻한다면 이 부분은 재확인이 필요하다.

- **CF Workers:** 웹/API, 업로드 접수, Inngest SDK endpoint, 프롬프트 구성/결과 검증/보고서 등 애플리케이션 코드를 실행한다. 이미지/OCR의 Workers 적합성은 여전히 별도 과제다.
- **CF R2:** 원본 이미지와 최종 분석/보고서 파일의 영속 저장. Inngest 실행 이력은 사용자 자료 보관소의 대체재가 아니다.
- **CF D1:** 화면에서 조회할 항목/분석 상태, R2 객체 키, 사용자 피드백 등 애플리케이션 데이터. Inngest 내부 step 상태와 구분한다.
- **Inngest Hosted:** 이벤트 수신, 실행 큐/스케줄링, 단계 결과 체크포인트, 재시도, 지연/이벤트 대기와 재개, 동시성 제어, 운영 이력/대시보드를 제공한다. 어떤 순서로 단계를 실행하고 어떤 실패를 재시도할지는 코드/설정으로 정의해야 한다.
- **Inngest infer:** 제공 API의 응답 대기를 Inngest가 담당한다. CF timeout을 늘리는 설정이 아니라 기다리는 실행 주체를 바꾸는 기능이다. 프록시/제공 API/Inngest 자체 한도는 없어지지 않는다.
- **Mac oMLX:** 기존 추론 API만 제공한다.

Inngest를 해당 파이프라인의 orchestration으로 채택하면 **같은 목적의 CF Queues, 자체 D1 기반 claim/lease 큐, CF Workflows를 모두 중복 구축할 필요는 없다.** 별도 요구가 없다면 하나의 orchestration을 주체로 고른다. 이는 기존 큐 구현을 이번 검토에서 삭제/변경했다는 뜻이 아니다.

여전히 직접 구현할 것은 SDK 함수/단계 분리와 연결, R2/D1 읽기·쓰기, 분석 로직, 인증, 결과 확정의 멱등성, 그리고 **D1 작업 생성 ↔ Inngest 이벤트 발행 사이 비원자적 실패 복구**다. 후자는 outbox/재조정 등의 방식으로 검증해야 하며, Inngest의 재시도만으로 자동 해결되지 않는다. 외부 LLM 중복 실행도 별도 위험이다.

현재 후보 흐름: CF 업로드·R2 저장·D1 항목 생성 → Inngest에 작업 전달 → CF에서 준비 단계 → Inngest infer → CF에서 검증·결과 저장·D1 상태 확정. CF는 앱/데이터 계층, Inngest는 실행 조율/복구 계층이다. CF Workflows도 겹치는 내구 실행 기능을 제공하므로, Inngest는 필수품이 아니라 외부 서비스 의존/비용/데이터 전달을 감수하고 offload와 운영 도구를 얻는 선택이다. 실제 선택은 앞서 적은 프로브와 dev 검토 전 미확정이다.

## 구분해야 할 실행 경로

### 원안: 외부 callback

CF의 Inngest 함수 → 외부 async submit endpoint → 즉시 job ID → 완료 callback → Worker 검증/이벤트 → waitForEvent 재개.

이 경로는 외부 async submit endpoint가 먼저 존재해야 한다. 현재 oMLX에는 없으므로 별도 추론 제공 계층 개발이 추가된다. Mac ymath runner 신설로 대체하지 않는다. waitForEvent는 listening 시작 이전 이벤트를 소급해서 받지 않으므로 callback 선도착 처리도 필요하다. 단순 상태 확인과 wait 사이에도 경쟁이 생길 수 있으므로 대기 선등록 또는 신호/영속 상태 재확인·재알림 프로토콜을 검증해야 한다.

### 대안: Inngest 추론 offload

CF Worker 접수 → Inngest run → CF 함수에서 step.ai.infer 요청 구성 → Inngest가 llm.xcv.kr 호출/대기 → CF 함수 재개 → 결과 검증 및 R2/D1 저장.

이 경우 LLM 서버가 별도 callback API를 구현할 필요는 없다. CF 함수가 직접 긴 fetch를 유지하는 대신 Inngest가 제공자 연결을 담당한다. 단, llm.xcv.kr 앞 프록시 timeout은 여전히 존재한다. 공식 문서상 provider streaming은 coming soon이므로 streaming 지원을 전제하지 않는다. oMLX non-stream JSON 공백 keepalive와 Inngest HTTP 처리기의 호환성도 프로브 대상이다.

**step.ai.wrap() 또는 일반 step.run(fetch)는 infer offload와 다르다.** 일반 함수 코드는 자신이 배포된 인프라에서 실행되고 해당 런타임 한도를 받는다. Hosted orchestration 도입만으로 Workers의 모든 실행 제약이 사라지지 않는다.

## 원안에서 수정할 개인정보/보안 주장

- Inngest는 event뿐 아니라 step output과 function output도 상태로 보존한다. event를 ID로 제한하더라도 step에서 prompt나 원문을 반환하면 Hosted에 들어갈 수 있다.
- infer는 Inngest가 실제 요청을 대신 보내므로 prompt와 응답이 Inngest를 통과한다. 공식 문서는 요청/응답을 workflow trace에서 추적한다고 설명한다. **infer를 쓰면서 참조 ID만 전달되고 본문은 R2/D1에만 남는다고 약속할 수 없다.**
- 원안의 LLM→R2 저장은 현재 oMLX의 기존 기능으로 확인된 것이 아니다. 일반 infer 경로에서는 CF의 재개된 단계에서 R2에 저장하는 구성이 자연스럽다.
- callback HMAC은 callback을 보내는 쪽에도 signing key가 있어야 한다. “모든 secret은 CF Worker에만”이라는 원안 표현은 송신 측과 모순된다. offload 대안에서는 별도 callback HMAC 자체가 필수는 아니다.
- SOC 2 Type II, 전송/저장 암호화, Ohio/Ashburn 인프라는 공식 보안 문서로 확인했다. 이것만으로 사용자의 실제 자료에 Hosted 적합성을 확정하지 않는다. 허용 데이터 범위는 사용자가 판단해야 한다.

## 가격 확인

공식 가격 페이지 현재 표기는 Free 50k executions/월, 500k events/월, concurrent steps 5, trace history 24시간; Pro 시작 $99/월 및 trace history 7일이다. 원안의 해당 수치는 공식 페이지와 부합한다. 실행 계량은 function run과 step을 각각 계산한다. 재시도/추론 단계/전송 이벤트까지 포함한 실제 비용은 워크플로 설계 후 확인한다. 계정별 계약·옵션은 미확인이다.

## 채택 전 프로브 기준 — 미실행

- [ ] 선택 SDK 버전에서 custom baseUrl/인증/모델 지정이 타입 검사와 합성 요청 1건으로 통과한다.
- [ ] infer 동안 CF 함수의 긴 실행/연결 유지 없이, 완료 후 함수가 결과와 함께 재개한다.
- [ ] 공개 llm.xcv.kr에서 125초 초과 호출의 성공/첫 바이트/바이트 간 최대 공백/총 시간 및 Inngest 자체 호출 timeout을 확인한다.
- [ ] JSON whitespace keepalive, 본문 error, 중간 종료, 429와 timeout을 구별하며 실패를 성공으로 저장하지 않는다.
- [ ] Inngest event/step 결과/trace에 실제로 남는 데이터 범위를 합성값으로 확인하고 사용자에게 승인받는다.
- [ ] 재시도 및 접수 응답 유실로 생기는 중복 추론 위험과 결과 확정의 멱등성을 검증한다.
- [ ] callback 방식을 고르면 별도 submit 서비스의 실행 위치/책임을 명시하고 선도착·중복·유실·위조/재전송을 검증한다.

## 공식 근거

- https://www.inngest.com/docs/features/inngest-functions/steps-workflows/step-ai-orchestration — infer offload vs wrap, OpenAI-compatible 지원, streaming 제한.
- https://www.inngest.com/blog/digitalocean-marketplace — openai adapter baseUrl 예제.
- https://www.inngest.com/docs/features/inngest-functions/steps-workflows/wait-for-event — durable wait, match/timeout, listening 이전 이벤트 미수신.
- https://www.inngest.com/docs/platform-and-operations/cloud-architecture-and-security — 앱 실행 위치, 보안/지역, step output 보존.
- https://www.inngest.com/docs/deploy/cloudflare — Cloudflare Pages/Workers runtime 연동.
- https://www.inngest.com/pricing — 공식 가격 및 계량 단위.
