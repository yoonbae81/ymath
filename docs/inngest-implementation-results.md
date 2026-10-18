# Inngest 첫 runnable checkpoint — 구현·실행 결과

## 판정과 범위

**로컬 SDK protocol + 실제 Wrangler D1 수직 슬라이스 PASS. Hosted/전체 이전은 미완료다.**

`inngest@4.24.0` 실제 SvelteKit serve → 서명된 실행 → D1 claim → 실제 HTTP 응답의 `AIGateway` → 합성 OpenAI 응답으로 재개 → 검증 → D1 저장을 실행했다. 텍스트와 구조화된 합성 보고서 모두 `done`으로 저장되었다. 제공자 HTTP 호출은 없었다. executor/provider fixture는 명시적으로 합성이며 Hosted가 실행했다는 주장이 아니다.

기존 dirty tree, Node rollback, 기존 runner 코드는 보존했다. 이번 구현은 별도 `inngest_slice_jobs` 테이블만 사용한다. 기존 업로드/이미지/OCR/분석/실제 보고서 기능을 이 경로로 연결하지 않았다. R2 변경도 없다. Mac runner/poll/wake를 만들거나 실행하지 않았다. commit/push/deploy/원격 migration/원격 자원 생성/유료 전환/실제 모델 호출/실사용자 데이터/credential 파일 접근을 하지 않았다. `docs/inngest-implementation-criteria.md`는 수정하지 않았다.

선행 확인: 레포 및 상위 경로에 적용할 AGENTS.md/CLAUDE.md를 발견하지 못했다. `ops/lead-clean`은 로컬/remote-tracking 브랜치에 없었다. 원격 fetch는 하지 않았다.

## 첫 checkpoint 대조

- [x] **PASS** 설치 SDK 실제 API/타입 확인. `inngest=4.24.0`, adapter dependency `@inngest/ai=0.1.8`. `openai({baseUrl,apiKey,model})` 사용.
- [x] **PASS** 실제 `inngest/sveltekit` serve GET/POST/PUT 추가. 전체 Wrangler dry-run Worker bundle native boundary scan PASS.
- [x] **PASS** 접수/ID/event → 실제 SDK 함수/서명/step checkpoint → `AIGateway` → 합성 결과 재개 → 검증/저장. 실제 로컬 D1에서 text/report 두 건 각각 `StepPlanned → StepRun → AIGateway → StepPlanned → StepRun`, gateway 1회, 저장 `done`.
- [x] **PASS** key/provider 설정 누락·잘못된 HTTPS URL/model/key는 접수 전에 503. JSON/body 크기/입력 kind를 검증한다. 발행 예외는 502와 영속 `publish_failed`로 처리한다.
- [x] **PASS** 실제 SDK POST unsigned/tampered 401, PUT unsigned/tampered 401, signed in-band registration 200. SDK는 `isDev:false`로 고정했다. 공개 `/health`와 서명 필수 SDK introspection/registration/run을 구별한다.
- [x] **PASS** 실제 SQL에서 concurrent claim/중복 완료/generation·attempt-token fencing/삭제 이후 늦은 결과를 검증했다. 실패한 저장 step을 동일 signed run으로 재실행해 claim/infer 재실행 없이 저장 완료했다. signed `onFailure` 경로로 최종 `failed`를 기록하고 오래된 failure가 삭제된 새 세대를 바꾸지 않음을 검증했다.
- [x] **PASS** 아래 실제 로컬 검증 명령 실행. RED→GREEN 로그를 보존했다. 초기 단위 테스트 묶음의 RED와 후속 report prompt/retry tracer bullet의 RED→GREEN을 구별하며, 모든 개별 함수가 독립 RED를 거쳤다고 주장하지 않는다.
- [x] **PASS (인계 문서)** Hosted endpoint, secret 이름, 등록 순서를 아래에 정리했다. 실제 등록은 미실행.

## 실제 SDK offload 계약

설치된 `@inngest/ai/dist/models/openai.js`는 baseUrl 끝 `/`를 보완한 뒤 `new URL('chat/completions', baseUrl)`을 사용한다. 따라서 후보 설정 `LLM_BASE_URL=https://llm.xcv.kr/v1`은 `https://llm.xcv.kr/v1/chat/completions`로 결합된다. `apiKey`는 adapter의 `authKey`가 되고 SDK `AIGateway.opts.auth_key`로 전달된다. OpenAI-compatible Bearer 인증과 실제 모델 ID 호환성은 Hosted 프로브에서 확인해야 한다.

실제 SDK `components/InngestStepTools.js`의 infer는 `op='AIGateway'`, `opts.type='step.ai.infer'`, `url`, `auth_key`, `format`, `body`를 생성한다. 테스트는 이 private matcher를 흉내 낸 것이 아니라 **production SDK serve가 반환한 HTTP 206 operation**을 단정한다. 일반 provider fetch나 `step.ai.wrap`가 아니다. `body.model`도 adapter가 지정한 값임을 확인했다. 키는 trace 파일에 출력하지 않는다.

합성 응답은 정상 OpenAI `choices[0].message.content`와 `finish_reason:'stop'` 형식이다. error body, 잘못된 choices/content, length/content_filter/누락된 finish_reason는 성공으로 저장하지 않는다. 보고서는 bounded `title`, `summary`, `findings`, `recommendations` JSON schema를 검증하고 정규화된 JSON으로 저장한다. production fixture-output override는 없다.

재시도는 Inngest `retries:2`이며 DB claim은 generation당 한 번이다. SDK가 claim/infer step 결과를 replay하므로 저장 재시도 때 새로운 claim이나 별도 Mac 작업자가 필요하지 않다. 최종 실패는 SDK `onFailure` 별도 실행이 기록한다. 그 callback 자체의 영구 실패, Hosted quota 소진, 이벤트 전달 유실은 이번 로컬 성공만으로 해결되었다고 볼 수 없다.

## 경로·상태

아래 URL은 **향후 배포 대상 주소**다. 현재 배포본에 반영했다는 뜻이 아니다.

- SDK: `https://xcv.kr/math/api/inngest` — GET/POST/PUT, SDK 서명 검증.
- 공개 health: `https://xcv.kr/math/api/inngest/health` — 단순 서비스 상태, 작업 성공을 뜻하지 않는다.
- 접수: `POST https://xcv.kr/math/api/inngest/submit`, JSON `{ "kind":"text" 또는 "report", "text":"합성 입력" }`. 기존 app AJAX/CSRF 및 rate-limit 경계 유지(`x-requested-with: ymath`).
- 조회: `GET https://xcv.kr/math/api/inngest/jobs/{jobId}`.
- 이벤트: `ymath/slice.requested`, data는 `{jobId,generation}`만 포함. prompt는 infer에서 Inngest를 통과하므로 ID-only 개인정보 보장을 약속하지 않는다.
- 상태: `queued`, `running`, `done`, `failed`, `publish_failed`, `deleted`.

hook 예외는 exact `/api/inngest`에만 적용된다. submit/jobs를 넓게 CSRF 예외 처리하지 않는다. reanalysis/delete store helper는 fencing 검증용이며 아직 기존 UI/수동 재시도 API로 연결하지 않았다.

D1 insert와 Inngest publish는 원자적이지 않다. 발행 실패 시 거짓 202 대신 502/`publish_failed`로 표시하지만, 응답 유실/발행 직전 프로세스 종료를 자동 복구하는 outbox/reconciliation은 **다음 개발 범위**다. 기존 application 데이터 테이블을 이 미완성 경계로 전환하지 않았다.

## 실행 증거

증거 root: `/Users/y/.hermes/profiles/plan/cache/scratch/inngest-vertical-slice/`. scratch는 장기 보존소가 아니므로 핵심 결과를 본 문서에도 남긴다.

TDD:
- 초기 `red.log`: 기존 340 tests PASS, 새 slice module 부재로 새 suite RED. `green-targeted.log`는 초기 구현 단계 기록이지 현재 signed integration의 증거로 사용하지 않는다.
- `protocol-red.log`: 실제 signed report 실행이 `AIGateway`까지 도달했으나 report schema 지시(`recommendations`) 누락으로 RED. prompt를 추가한 뒤 `protocol-green.log` PASS.
- `retry-red.log`: SDK retries=0을 발견하여 RED(3 PASS/1 FAIL). `retries:2`로 구현 후 `retry-green.log` 4 PASS.
- `save-retry.log`: transient DB transport failure를 한 번 주입한 실제 SDK save step 재실행 PASS. provider 응답이나 SQL 결과를 가짜 성공으로 대체하지 않았다.

최종 독립 실행(모든 exit code 0):

| 명령 | 결과 | 로그 |
|---|---|---|
| `TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch npm test -- src/lib/server/inngest-slice.protocol.test.ts src/lib/server/inngest-slice.test.ts` | **PASS 12 tests** | `independent-targeted.log` |
| `TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch npm test` | **PASS 353 tests / 28 files** | `independent-test.log` |
| `TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch npm run check` | **PASS 0 errors / 0 warnings** | `independent-check.log` |
| `TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch npm run build` | **PASS**, complete Wrangler dry-run native bundle boundary scan PASS | `independent-build-worker.log` |
| `TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch npm run build:node` | **PASS**, 기존 empty env/ajax chunk warning만 존재 | `independent-build-node.log` |
| `git diff --check` | **PASS** | `independent-diff-check.log` |
| `TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch WRANGLER_SEND_METRICS=false npm run test:inngest:local` | **PASS real Wrangler D1 text/report protocol + fencing** | `real-d1.log` |

`independent-gates.json`은 gate별 exit code를 기록한다. `signed-protocol-trace.json`은 합성 provider response로 재개한 실제 HTTP SDK command trace이며 auth_key는 redacted다. 실제 D1 실행 결과 및 SQLite state는 `/Users/y/.hermes/profiles/plan/cache/scratch/inngest-real-d1-kiLVwi/`에 보존했다(후속 재실행은 새 scratch 디렉터리 생성). D1 migration은 `getPlatformProxy`가 제공한 **동일 DB binding**에 적용했다. 레포 Wrangler config나 `.dev.vars`를 쓰지 않고 scratch에 만든 로컬 전용 config만 사용했다. 원격 D1 ID/실제 데이터는 사용하지 않았다.

로컬 장애/해결: Codex sandbox npm DNS 실패는 상위 도구의 registry install로 해결했다. D1 `exec()`가 comment-only 첫 줄을 별도 문장으로 취급하는 문제는 단일 multiline CREATE 문에 `DB.prepare(sql).run()`을 사용해 해결했다. 최초 실패를 최종 PASS와 혼동하지 않는다.

## Hosted 정보가 필요한 시점과 등록

**로컬 checkpoint는 키 없이 끝냈다. 다음 signed Hosted handshake/실제 custom infer 프로브 직전에 정보가 필요하다.** 값은 채팅/문서/로그에 붙이지 말고 사용자의 secret 등록 수단으로 설정한다.

1. 사용자가 사용할 Inngest app/environment와 endpoint 등록 권한을 준비한다. 등록할 endpoint는 `https://xcv.kr/math/api/inngest`다.
2. 승인된 배포 단계에서 Worker `math`에 `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `LLM_API_KEY` **secret**을 등록한다. 일반 변수 `LLM_BASE_URL=https://llm.xcv.kr/v1`, 실제 제공 모델 ID인 `LLM_MODEL`도 필요하다. 키 값은 코드에 저장하지 않는다.
3. D1 `math`의 신규 `0004_inngest_slice.sql` migration 적용과 새 코드 배포는 별도 승인 단계다. R2 `math-private`와 타 프로젝트 bucket은 이 slice에 필요하지 않다.
4. 사용자의 Inngest dashboard에서 app sync/deploy 등록에 위 serve URL을 입력하고 signing key 환경을 일치시킨다. 먼저 서명 handshake/function 등록을 확인한 뒤, 승인된 합성 입력 1건만 submit한다.
5. Hosted trace에서 `AIGateway`와 CF 재개/저장을 확인한다. HTTP 200 이후 body error, 429, 중간 종료, 125초 초과 호출, non-stream whitespace keepalive 호환성과 timeout을 별도로 기록한다. oMLX background 필드는 ignored이며 연결 없는 job 계약이 생기는 것이 아니다.

**BLOCKED/NOT RUN:** 실제 Hosted sync/event receipt, llm.xcv.kr 실제 infer, 125초 초과/whitespace keepalive, Hosted 실제 quota/trace 보관 범위, 배포 및 remote migration. Local signature/protocol PASS를 Hosted 성공이라고 해석하면 안 된다.

## Hosted 배포 checkpoint — parent 검증

사용자가 secret 등록 완료 및 모델 ID `Qwen3.6-35B-A3B`를 전달한 뒤, math Worker의 secret 이름 3개(INNGEST_EVENT_KEY/INNGEST_SIGNING_KEY/LLM_API_KEY)를 목록 조회로 확인했다. 값은 읽지 않았다. wrangler vars에 `LLM_BASE_URL=https://llm.xcv.kr/v1`, `LLM_MODEL=Qwen3.6-35B-A3B`를 설정했다.

- 실제 build exit 0: `/Users/y/.hermes/profiles/plan/cache/scratch/inngest-deploy-build.log`.
- remote D1 `math`: `0004_inngest_slice.sql` 적용 성공. 재조회 `No migrations to apply`.
- 실제 배포 Worker `math`, version `e8e33c1b-3979-4000-b998-a019bfb2582f`, 기존 route `xcv.kr/math*` 유지.
- HTTP 재조회: `/math/api/inngest/health` 200 `{ok:true,service:inngest-slice}`; 서명 없는 SDK GET/POST `/math/api/inngest` 각각 401 Unauthorized.
- 기존 업로드/분석/이미지/OCR 경로는 아직 Inngest slice로 전환하지 않았다. R2 객체/사용자 데이터는 조회·변경하지 않았다.
- 다음 사용자 조치: 준비한 키와 동일 환경의 Inngest 앱 동기화에서 `https://xcv.kr/math/api/inngest` 등록. 그 전 Hosted executor/실제 infer/장시간 프로브는 여전히 NOT RUN이다.

## 실제 Hosted → oMLX → CF 프로브 — parent 검증

사용자가 Hosted 앱 동기화 성공을 알린 뒤, 합성 텍스트 1건을 실제 배포 endpoint에 접수했다. 사용자 원문/운영 자료는 사용하지 않았다.

- POST `/math/api/inngest/submit`: 202, 약 1.40초 만에 job ID `slc_9f8333cd-48ed-4b45-b027-7c17dc0d3551` 및 queued 반환.
- 동일 ID GET 조회: running에서 done으로 전환; 조회 시작 후 약 12.81초에 완료 관찰(추론 자체 소요 시간으로 동일시하지 않음).
- 실제 저장 결과: `Inngest and the local model are connected successfully.`. 합성 입력에서 요청한 문장과 일치하며, Worker에 fixture override는 없다.
- 증거: `/Users/y/.hermes/profiles/plan/cache/scratch/inngest-hosted-probe/submission.json`, `poll.json`.
- 검증 의미: 실제 Hosted가 등록된 함수를 실행하고 custom llm.xcv.kr/oMLX 응답을 받아 CF 저장 단계까지 재개하는 짧은 호출의 정상 경로 PASS. Inngest 대시보드 trace 세부/자체 token 사용량은 읽지 않았다.
- 여전히 NOT RUN: 125초 초과 호출/JSON whitespace keepalive, 429/연결 장애 실증, 기존 사진 업로드/OCR/보고서 전체 전환. 위의 배포 전 NOT RUN 표기는 해당 시점 기록이며 이 섹션이 현재 짧은 호출 상태를 갱신한다.

## 이미지/OCR feasibility와 다음 개발 범위

기존 `src/lib/server/image.ts`는 native sharp로 JPEG/PNG/WebP/TIFF 입력, EXIF rotate, 최대 50,000,000 pixels, 1600×1600 inside/no-enlargement, grayscale JPEG quality80/mozjpeg을 보장한다. native sharp를 Workers로 import하는 방식은 해법이 아니다. 이번 Worker bundle에는 sharp/fs/CLI/native addon이 유입되지 않았다.

Cloudflare Images binding은 R2의 private bytes를 받아 transform하고 R2에 반환할 수 있는 후보이며, WASM codec도 후보다. 그러나 TIFF/EXIF/grayscale/동일 품질·pixel cap·메모리·CPU·요금/무료 quota를 실제로 검증하지 않았다. 로컬 Images offline 지원이 전체 transform 계약을 보장하지도 않는다. 공식 참고: https://developers.cloudflare.com/images/transform-images/bindings/ , https://developers.cloudflare.com/images/pricing/ . 새 유료 기능이나 리소스는 활성화하지 않았다.

다음 순서: (1) Hosted 합성 text/report 실제 custom infer/장시간 프로브, (2) 품질 계약을 보존하는 cloud image-normalization fixture와 OCR runtime feasibility, (3) outbox/발행 복구와 terminal callback 실패·quota 정책, (4) 기존 report/upload/reanalysis/retry를 검증 후 연결하고 UI 상태 설계 검토, (5) 기존 Mac runner 의존 경로 제거. 그 전에는 **전체 migration 완료/이미지 처리 cloud 이전 완료라고 선언하지 않는다.**
