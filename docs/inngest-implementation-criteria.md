# Inngest 구현·인계 기준

## 승인 및 경계

사용자는 Inngest 구현을 승인했으며 Hosted 접속 정보는 필요 시 제공한다. 가입/유료 플랜/원격 자원 생성/배포/실제 LLM 호출/운영 데이터 접근까지 일괄 승인한 것으로 해석하지 않는다. Git commit/push 금지를 유지한다. 더티 트리 변경은 보존한다. 모든 fixture와 로그는 `/Users/y/.hermes/profiles/plan/cache/scratch`에 둔다.

목표 경계: CF Workers/D1/R2=애플리케이션·데이터, Inngest Hosted=실행 관리·infer offload, Mac=기존 llm.xcv.kr 추론 API만. ymath Mac runner/poll/wake 새 프로세스는 금지한다. CF Queues/Workflows를 동일 목적의 새 실행 관리자로 중복 도입하지 않는다.

## 첫 구현 checkpoint: 실제 SDK를 통한 실행 가능한 수직 슬라이스

선행 검증 없이 전체 파이프라인을 한 번에 교체하지 않는다. 첫 checkpoint는 전체 전환 완료가 아니다.

- [ ] 현재 설치할 SDK 버전의 실제 API/타입으로 custom OpenAI-compatible endpoint의 infer 설정을 검증한다. adapter의 base URL 결합, 인증, 모델명 설정을 추측하지 않는다.
- [ ] Workers/SvelteKit용 실제 SDK serve endpoint를 추가하고 node/native 서버 모듈이 배포 번들에 유입되지 않는다.
- [ ] 합성 입력 작업의 접수/식별자 → Inngest function → infer offload 명령 → 결과 검증/저장 경로를 로컬에서 실행한다. 실제 SDK protocol과 검증 가능한 테스트를 이용하며, fake provider 결과는 명시적으로 합성 fixture로 표기한다.
- [ ] 키 없음/오설정 시 명시적 비활성 또는 오류이며 가짜 접수 성공·영구 대기를 만들지 않는다. 로그/문서에 secret 값을 남기지 않는다.
- [ ] unsigned/tampered serve 요청의 거부를 실제 SDK 검증 경로에서 확인한다. health/registration 공개 범위를 구분한다.
- [ ] 재시도·중복 완료·삭제/재분석 이후 늦게 온 결과가 현재 결과를 덮어쓰지 않는다. 영속성은 실제 로컬 D1/R2 binding 또는 실제 SQLite schema로 검증한다.
- [ ] 신규 동작별 TDD RED→GREEN 증거를 남긴다. 최소 targeted tests, npm test, npm run check, npm run build, git diff --check를 실행하고 결과를 기록한다.
- [ ] Hosted 통합에 필요한 이벤트 키/서명 키/LLM key의 등록 위치와 접속 endpoint를 정리하되 값을 요구하거나 파일에 저장하지 않는다.

## 실제 Hosted 프로브 — 별도 접속 단계

- [ ] 사용자 Hosted app/키 등록 후 서명된 endpoint 호출과 이벤트 수신을 확인한다.
- [ ] 승인된 합성 입력 1건을 실제 llm.xcv.kr으로 호출하고 CF 단계가 재개되어 저장까지 완료된다.
- [ ] 125초 초과 호출에서 provider/프록시/Inngest timeout 및 JSON whitespace keepalive 호환성을 기록한다. 기본 streaming 미지원 여부를 SDK/Hosted로 재확인한다.
- [ ] 실제 단계별 executions, 동시성, trace에 남는 prompt/응답 범위를 확인한다. 무료 quota 도달 시 처리 정책을 명시한다.

## 전체 전환 완료 기준 — 아직 미달

- [ ] 업로드·재분석·수동 재시도·보고서가 Inngest 실행 흐름으로 끝까지 동작한다.
- [ ] 이미지 정규화/OCR이 클라우드에서 실행되는 방식을 dev가 검토하고 실제 입력으로 검증한다. sharp의 Workers 비호환을 무시하거나 업로드 품질 요건을 조용히 낮추지 않는다.
- [ ] D1 작업 생성과 Inngest 발행 사이 장애를 복구하며 발행 중복과 결과 확정 멱등성을 구별한다.
- [ ] LLM 429/중간 종료/본문 오류/schema 오류/타임아웃이 가짜 성공이 되지 않는다.
- [ ] 기존 정상 데이터와 로컬 Node rollback 경로를 보존한다. 이전 runner 의존 경로의 제거/전환은 기능 검증 후 수행한다.
- [ ] UI에서 대기/진행/재시도/실패를 사실대로 표시한다. 기존 화면 상태가 충분한지 design 검토를 받는다.

## OCR/분석 파이프라인의 실제 구성 — parent 검증(git history)

사용자 질문("당초 서버형 구조에서 conv OCR과 qwen3.6 OCR을 결합했나")에 대해 코드·git history로 확인한 사실:

- **OCR 단계는 단일 모델이었다.** 역사: `ocr` CLI(PaddleOCR 데몬) → `mdconv POST /convert`(내부망, 여전히 PaddleOCR-VL 사용) → 2026-10-05부터 oMLX `chat/completions`를 `PaddleOCR-VL-1.6-mlx`로 직접 호출. "conv 결과 + Qwen 결과를 결합한 OCR" 구현은 커밋 이력에 없다.
- **결합은 분석 단계에서 일어났다.** OCR 텍스트(참고용) + 사진 첨부 + 지침을 분석 LLM에 함께 전달(`buildPrompt`, analyze.ts). 즉 "OCR + 사진을 함께 보는 것"은 별도 결합 로직이 아니라 분석 프롬프트의 구성이다.
- OCR 실패 시 사진만으로 분석을 계속하는 폴백(`ocr_missing`)이 기존 동작이다.
- 현재 Inngest 전환도 이 구성을 유지한다: OCR(단일 모델 호출) → 분석(OCR 텍스트 + 사진 + 스키마 검증). "결합" 처리는 Inngest function이 같은 프롬프트 구성으로 수행하면 되며, 이미지 인식을 Inngest로 옮기는 것은 사용자 지적대로 가능하다. 단, 이미지 첨부 infer가 Inngest AIGateway에서 그대로 동작하는지는 미검증이다.
- `Qwen3.6-35B-A3B`는 분석 모델이며 OCR 모델(`PaddleOCR-VL-1.6-mlx`)과 다르다. OCR_MODEL로 oMLX의 실제 제공 모델 확인이 필요하다.

## 두 번째 slice(보고서)와 이미지/OCR 조사 — parent 재검증

dev 보고서 slice와 image/OCR feasibility 조사 종료 후 부모가 직접 재실행: npm test 369 passed/1 skipped(32 files), npm run check 0/0, npm run build(Worker bundle boundary PASS), git diff --check PASS, test:inngest:wrangler:local 실제 로컬 D1+R2 text/report PASS(증거 `inngest-real-d1-DDFu32`). 보고서 slice는 기본값에서 기존 runner 소유를 유지하며, REPORT_BACKEND=inngest + REPORT_INNGEST_EXECUTION_ENABLED 2단계 스위치로만 활성화된다. 원격 migration 0005/0006·Hosted 보고서 실증은 아직 실행하지 않았다. image/OCR 조사는 Photon+jSquash WASM fixture 25건(성공 23)과 Images binding 로컬 mock 한계를 기록했고, 기존 50Mpx/TIFF/25MiB 전체 계약 유지 여부가 사용자 결정 사항으로 남았다. UI acceptance 항목은 이후 전체 전환 단계에서 런타임 검증이 필요하다.

## Parent checkpoint와 design 검토 반영

부모가 dev 종료 후 직접 재실행: npm test 353/28 PASS, npm run check 0 errors/0 warnings, npm run build 및 전체 Wrangler bundle boundary PASS, git diff --check PASS. test:inngest:local은 실제 로컬 D1 text/report 모두 AIGateway 1회 후 done, 중복/삭제 fencing PASS. 증거 `/Users/y/.hermes/profiles/plan/cache/scratch/inngest-real-d1-3grDfh/`. 이는 실제 SDK + 합성 executor/provider 응답을 이용한 로컬 프로브이며 Hosted/oMLX 실제 호출은 아니다. 첫 checkpoint는 별도 `inngest_slice_jobs` D1 저장으로 한정되며 기존 이미지/보고서/R2 전환 완료는 아니다.

Design 정적 검토 결과: 기존 배지/화면을 재사용하되 다음 UI acceptance는 전체 전환 시 필수다(아직 NOT RUN).

- [ ] 키/등록/발행 실패 fixture에서 업로드가 '자동 진행' 성공으로 표시되지 않는다. publish_failed가 조회 가능하고 정상 queued와 구분된다.
- [ ] 최초 대기와 오류 후 자동 재시도 대기를 구분하고, 재시도 조건 또는 예정 시각을 표시한다.
- [ ] quota 소진/등록 실패/장기 정체를 '실행기가 연결되면 처리'라고 안내하지 않는다. 정상 대기만 있을 때 실제 분석 실행 중으로 표시하지 않는다.
- [ ] 이전 분석/보고서가 남은 새 실행 실패에서도 최신 실패 원인과 이전 결과임을 함께 표시한다. summary/markdown 존재로 실패 문구를 숨기지 않는다.
- [ ] 보고서 수동 재시도도 요청 중 중복 클릭을 막고, 접수 오류 원인을 표시하며 실제 새 작업 상태를 조회한다.
- [ ] 조회 실패는 빈 목록/완료로 위장하지 않으며, 마지막 데이터 유지 시 오래된 데이터임과 갱신 수단을 표시한다.

주요 대상: src/routes/upload/+page.svelte, status/+page.svelte, items/+page.svelte, areas/+page.svelte, src/lib/status.ts/types.ts. 세부 design 리뷰는 기존 코드의 정적 판정이며 새 Inngest slice의 UI 런타임 검증 증거가 아니다.

## base64 이미지 전송의 과금·한도 — parent 검증(공식 문서)

사용자 질문("이미지를 base64로 전송하면 cloudflare의 과금 범위에 들어가진 않나")에 대한 공식 문서 확인:

- **Workers 과금 단위는 요청 수와 CPU 시간이다.** base64로 이미지를 담아도 "데이터 크기" 자체로 청구되는 항목은 없다. 공식: "There are no additional charges for data transfer (egress) or throughput (bandwidth)."
- **크기에 영향을 주는 것은 과금이 아니라 한도다.** CF zone 요청 body 상한(Free/Pro 100MB) — 현재 업로드 25MiB와 무관하게 여유. Worker isolate 메모리 128MB — base64 버퍼(원본 대비 약 1.33배)가 이 한도와 상호작용하므로 대형 이미지는 스트리밍/청크 고려. R2 Class B 읽기(PUT/GET 등 op 단위 과금)와 D1 rows read/write는 이미지 주고받기와 무관하게 발생하는 별도 단위다.
- **Inngest 측 한도가 더 작다.** event size는 Free 256KiB/Pro 3MiB. 따라서 이미지 base64를 Inngest **event에** 넣으면 안 되고, step.ai.infer body(호출 시점에 CF가 만들어 전달)로 유지해야 한다. step 결과(=base64를 저장하는 step)도 trace/span에 기록되므로 observability 용량에 영향. 이미지 자체는 R2에 두고 CF가 infer 호출 시점에만 조립하는 현재 설계가 맞다.
- 1600px grayscale JPEG은 통상 수십~수백 KB 수준이므로 실무 위험은 한도보다 Inngest trace 보관 범위가 크다. R2 읽기 요금(Class B op)과 Inngest executions 무료 50k/월은 별도로 관리.

결론: **base64 전송 자체는 CF 과금 항목을 새로 만들지 않는다.** 다만 메모리 한도(Worker 128MB), Inngest event/trace 한도, R2 op·D1 row 단위는 설계에 반영한다.
