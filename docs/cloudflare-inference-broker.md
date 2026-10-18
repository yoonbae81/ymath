# CF를 추론 중개자로 사용하는 방식 — 가능 범위

## 상태

공식 문서에 근거한 구조 설명이며 미구현·미배포다. dev의 구현/복구 설계 검토 전 확정 criteria가 아니다. UI 변경은 제안하지 않는다. 현재 설치된 oMLX 지원 조사: `docs/omlx-inference-capabilities.md`.

## 핵심 구분

Cloudflare는 job ID 발급, 내구 실행 시작, LLM 응답 대기, 결과 저장, 상위 Workflow로 완료 이벤트 전달을 담당할 수 있다. 단, 동기식 oMLX API를 감싸는 중개자는 그 뒤에서 모델 응답 연결을 계속 유지해야 한다. CF에 중개자를 둔다고 oMLX 자체가 연결과 독립적인 background job/callback API가 되는 것은 아니다.

### A. 단일 Workflow — 더 단순한 후보

1. 접수 Worker가 Workflow instance를 만들고 해당 ID를 즉시 요청자에게 반환한다.
2. Workflow의 step.do가 llm.xcv.kr에 요청하고 streaming/keepalive를 계속 읽는다.
3. 완료 결과를 R2/D1에 저장하고 다음 애플리케이션 단계로 진행한다.

사용자 HTTP 연결은 유지하지 않는다. CF→LLM 연결은 유지한다. 자체 callback이 필수는 아니다.

### B. 상위 애플리케이션 Workflow와 추론 중개 Workflow 분리

1. 상위 Workflow가 중개 Worker에 작업을 접수한다.
2. 중개 Worker는 추론용 Workflow instance를 생성하고 job ID를 곧바로 반환한다.
3. 추론용 Workflow가 oMLX에 연결하여 완료까지 응답을 소비한다.
4. 결과를 영속 저장하고 상위 instance에 완료 이벤트를 보낸다.
5. 상위 Workflow는 step.waitForEvent로 기다리다가 결과 키를 받아 재개한다.

CF 내부에서 완료를 전달할 때 반드시 공개 HTTP callback이 필요한 것은 아니다. Workflows 이벤트 전달 API를 사용할 수 있다. 외부 LLM 서비스가 직접 callback하는 구조와 구별한다. 이벤트 선도착/대기 timeout/중복 전달/결과 저장과 알림 사이 장애는 dev 검토 및 프로브 대상이다.

## 안 되는 가정

- 현재 oMLX에 요청을 보내 job ID만 받은 뒤 CF→oMLX 연결도 닫고, 나중에 oMLX가 알아서 callback한다고 가정할 수 없다. 현재 설치 구현에 그 계약은 없다.
- 일반 Worker가 202를 반환한 뒤 무제한 background promise로 추론을 기다리는 방식은 적합하지 않다. waitUntil은 응답/연결 종료 후 최대 30초 연장이지 내구 실행기가 아니다.
- Workflows의 내구 실행은 진행 중 네트워크 연결/모델 토큰까지 체크포인트한다는 의미가 아니다. step 중 장애 시 추론을 다시 요청할 수 있으며 제공 API의 idempotency 없이는 중복 추론 비용을 완전히 막을 수 없다.

## 남은 검증 기준

- [ ] API 접수 응답은 모델 완료보다 먼저 돌아오고 반환 ID로 결과 상태가 연결된다.
- [ ] 브라우저 종료 후에도 Workflow가 합성 입력 분석을 완료한다.
- [ ] 공개 llm.xcv.kr 경로에서 125초 초과 추론을 수행하고 첫 바이트/최대 공백/총 시간을 기록하며 524 없이 결과를 얻는다.
- [ ] 의도한 timeout과 재시도 정책을 설정하고 중간 연결 종료가 성공으로 기록되지 않는다.
- [ ] 결과 저장 후 알림 실패 및 중복 완료 이벤트에도 상위 작업 결과가 한 번만 확정된다.
- [ ] 재시도 시 중복 추론 가능성과 결과 확정의 멱등성을 구분하여 검증한다.

## 공식 근거

- https://developers.cloudflare.com/workflows/build/events-and-parameters/ — Worker에서 instance 생성 및 ID 반환, waitForEvent 및 이벤트 전달.
- https://developers.cloudflare.com/workflows/reference/limits/ — step wall-clock unlimited, CPU 한도 별도, waitUntil의 응답 이후 30초 연장.
- https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/ — step별 timeout 기본 10분, 명시적 조정 및 재시도 정책.

긴 네트워크 대기가 가능한 것과 실제 서비스 적합성·요금·이미지/OCR 처리 가능성이 검증된 것은 다르다. 이번 설명은 추론 중개 역할에 한정한다.
