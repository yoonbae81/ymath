# Item Inngest criteria audit — offline SDK

> **아래 ‘429/timeout 재시도 동등성 보완’이 최신 상태이다.** 앞선 bounded retry 한계 및 retries=2/400 전파 설명은 보완 전의 이력이며 현재 구현을 뜻하지 않는다.

## 범위 및 수정

- `src/lib/server/cloudflare/inngest-item.ts`의 실제 `infer-item-ocr`에 `timeout: '2m'`을 추가했다. 실제 SDK가 반환한 AIGateway operation의 `opts.timeout` assertion을 먼저 추가해 undefined 실패를 확인한 다음 구현하여 통과시켰다.
- OCR 실패 후 분석도 terminal failure가 되면 기존 queue와 달리 `flags.ocr_missing`이 false로 남는 문제를 발견했다. signed SDK + 실제 SQLite + GET API 회귀 테스트의 false/true 실패를 확인한 다음, 분석 infer 전 `mark-item-analyzing` durable step에서 OCR 유무를 기록한다. generation/job/token/lease/deletion fencing을 적용하여 stale write를 막는다. `onFailure`가 기존 flag를 보존한다.
- `app.ts`의 `retries: 2`는 변경하지 않았다. 원격 호출·배포·커밋은 하지 않았다.

## 추가한 검증

모든 provider 응답/실패는 명시적으로 합성이다. 실제 SDK `serve`에 서명한 실행 요청을 보내며, 저장은 in-memory 실제 SQLite, R2는 in-memory object adapter를 사용한다. fetch는 이벤트 발행의 가짜 endpoint 응답만 허용하므로 실제 모델 네트워크를 호출하지 않는다.

- OCR RateLimitError(429)/TimeoutError terminal gateway 실패 → 사진 첨부 분석으로 계속 → done 및 API/D1/R2의 `ocr_missing: true`.
- 분석 RateLimitError(429)/TimeoutError terminal gateway 실패 → 실패 전에는 analyzing 유지, 분석 artifact 없음 → signed onFailure 후 job/entity/API failed. 다른 owner의 onFailure는 lease를 종료하지 못한다.
- OCR fallback 이후 분석 terminal failure에서도 API `ocr_missing: true` 유지.
- SDK의 실제 registration serializer가 item retry wire config를 `{ attempts: 2 }`로 출력하며 실패 trigger를 등록하는지 assertion.
- 미완료 분석 gateway를 attempt 1/2 요청으로 재생하면 동일 gateway ID만 재출력. 합성 성공 응답으로 재개하면 OCR/claim을 반복하지 않고 done. jobs.attempts는 claim 횟수인 1을 유지한다.
- schema enum에는 유효하지만 topic/unit 관계가 불일치하는 분석을 저장하면 reject하지 않고 canonical course와 taxonomy warning을 보존. API record, D1 analyses flags/meta, R2 JSON artifact의 내용 일치를 확인한다.

## retry 의미와 동등성의 한계

`node_modules/inngest/components/InngestFunction.js`의 getConfig는 `retries`를 `{ attempts }`로 직렬화한다. `components/execution/engine.js`의 retriability는 서비스에서 이미 실패 완료로 전달한 StepError를 non-retriable로 취급한다. 테스트에서도 memoized `{ type: 'error', error: { name, message } }`를 넣으면 SDK는 HTTP 400과 `x-inngest-no-retry: true`를 반환한다. OCR은 이를 catch하여 fallback하고, 분석은 전파한다.

**이 테스트는 서비스가 실제 provider 429/timeout을 몇 회, 어떤 backoff로 재시도하는지 검증하지 않는다.** attempt 값을 바꾼 서명 요청은 서비스 재시도 요청을 재현한 것이며 서비스 scheduler를 실행한 결과가 아니다. onFailure event 역시 명시적으로 주입한다. SDK config/재생/failure 처리 증거와 Hosted 서비스 retry 관측은 구분해야 한다. 2m도 operation 값 검증이며 실제 2분 경과 테스트가 아니다.

기존 `queue.ts`는 429를 별도 분류해 기본 10분 뒤 재접수하고 attempts를 되돌린다. 현 Inngest 구현은 bounded retry를 서비스에 위임하므로 **429 대기 시간/무기한 재접수/attempts 표시까지 동일하지 않다**. 이 정책 차이를 임의로 제거하려고 retries 값을 변경하지 않았다. 기존의 OCR fallback과 성공/실패 저장 flag, taxonomy warning 저장 구조는 이번 테스트로 확인/보완했다. 사용자 의도가 429 정책까지 완전 동등이라면 별도 정책 결정과 서비스 scheduler 검증이 필요하다.

## 실행 결과 및 통합 주의

- 최종 범위 실행: item + item-status 2 files, **39 passed** (item 19 tests).
- `npm test`: 첫 실행 **414 passed, 1 skipped**. OCR terminal-flag 회귀 테스트 보완 후 재실행 시 다른 child가 작성 중인 `qwen-only.test.ts`의 **11 failed / 전체 416 passed, 1 skipped**가 관측됐다. 해당 RED는 본 audit 범위가 아니며 그 파일/구현은 수정하지 않았다. parent 통합 후 전체 재실행 필요.
- `npm run check`: **0 errors / 0 warnings**.
- 마지막 production 수정 이후 `npm run build:node` → `npm run build`: 모두 exit 0. Worker runtime boundary PASS.
- 빌드 후 `.build/index.js`, `.svelte-kit-node/output/server/index.js`, `.svelte-kit/cloudflare/_worker.js` 세 파일이 동시에 존재함을 확인했다. Node 빌드의 SvelteKit tsconfig extends 권고 및 empty-chunk 메시지는 남아 있다.
- `git diff --check`: exit 0.
- 새 Qwen-only 정리와 병행했으므로 parent가 통합 후 최종 check/test/빌드를 다시 수행해야 한다. 본 audit의 item/item-status 테스트에는 codex/claude/gemini provider fixture가 없다.
- Hosted OCR-only 증거는 parent가 관리하는 별도 문서 섹션의 범위이며 여기서 재실행하거나 기존 문서를 덮어쓰지 않았다.

## 429/timeout 재시도 동등성 보완 — 최신

### 기준으로 확인한 실제 소스

- 원 사용자 계약인 **기존 queue 정책**을 기준으로 했다. `queue.ts:112–167`은 분석의 모든 non-quota 오류(TimeoutError, 알 수 없는 오류, 응답 검증 오류 포함)를 `settings().maxAttempts`까지 즉시 재시도한다. 별도 timeout backoff는 없다. `config.ts` 기본값은 `ANALYZE_MAX_ATTEMPTS=2`, `ANALYZE_TIMEOUT_MS=900000`이다.
- `queue.ts:11–12,146–157`은 `llm-core.ts:isQuotaOrRateLimitError`로 quota/429를 분류하고 기본 `QUOTA_RETRY_DELAY_MS=600000` 뒤 재접수한다. 해당 시도의 표시 attempts는 1 환급하며 재접수는 새 maxAttempts 루프를 시작한다. 429 횟수에 별도 cap은 없다.
- Cloudflare runner도 별도로 읽었다. `runner-poller.ts`는 `/429|rate.?limit/i`에 기본 600초, 그 외에는 30초를 반환하며 `runtime.ts:failCloudJob`/`jobs.ts`는 5회 제한이고 429 환급이 없다. 즉 **runner와 원래 queue 자체의 정책이 다르다.** 이번 구현은 이 둘을 임의 절충하지 않고 명시된 원래 queue 계약(기본 2회, non-quota 즉시 재시도, quota 환급)을 채택했다.

### 구현한 동작

- 분석 AIGateway의 terminal `StepError`를 handler에서 잡는다. 원래 quota 메시지 classifier를 공유하고, SDK 직렬화로 `instanceof QuotaExceededError`를 잃는 경우에만 실제 `StepError.name === 'QuotaExceededError'`를 보완한다. HTTP 200의 `{ error: ... }` 본문도 원래 provider 오류 메시지를 보존하여 분류한다. unknown error를 즉시 영구 실패시키지 않는다.
- 429/quota: D1 entity/API를 `queued`로 전환하고 `jobs.attempts`와 record attempts를 환급 → 실제 SDK `Sleep`(기본 `10m`) → fenced 재접수 전이에서 `analyzing`, attempts +1 → **새 ID의 AIGateway**. 동일한 실패 gateway ID에 서비스 재시도를 기대하지 않는다. 429 횟수에 코드상 cap은 없으며, non-quota 예산/직전 오류 hint는 quota 재접수 때 초기화한다.
- timeout/unknown/분석 검증 오류: queue의 maxAttempts(기본 2)에 따라 새 gateway를 즉시 생성한다. 직전 오류를 기존 `buildPrompt`의 교정 hint로 전달한다. 끝까지 실패하면 별도 durable step에서 실제 마지막 오류와 함께 job/entity/API를 `failed`로 저장하고 lease를 종료한다. OCR은 기존처럼 오류 시 photo-only fallback이다.
- item function의 SDK `retries`를 **0**으로 변경했다(다른 function 불변). SDK 숨은 재시도와 명시적 queue 예산이 중첩되지 않도록 하기 위한 설정이며 registration wire `{ attempts: 0 }`을 검증했다. `ANALYZE_MAX_ATTEMPTS`, `QUOTA_RETRY_DELAY_MS`, `ANALYZE_TIMEOUT_MS` Worker bindings를 같은 이름으로 읽는다. 기본 분석 timeout은 operation `15m`이다.
- 대기 전 lease를 **대기 시간 + 30분**으로 연장하고 깨어날 때 다시 30분으로 갱신한다. 이미 만료된 lease는 되살리지 않는다. transition/failure는 job/entity generation, owner, token, 상태, attempts, 삭제 여부로 fence한다. `jobs.payload`의 transition/failure marker를 이용해 DB 커밋 후 StepRun 응답이 유실되어도 중복 환급/증가/다른 실행의 실패 기록을 막는다. 스키마/마이그레이션은 바꾸지 않았다.
- DB job은 sleep 동안 `leased`로 보유하고 entity/API만 `queued`다. 이는 원래 in-process timer 재접수를 durable sleep으로 옮긴 표현상의 차이이며 다른 run이 같은 일을 claim하지 못하게 한다. OCR/정규화/R2 요청 이미지 읽기는 memoized 결과를 재사용한다.

### 실제 RED → GREEN 및 검증 결과

모든 provider 응답/오류와 sleep completion은 **합성**이며 실제 SDK 서명/StepError/operation 생성과 실제 SQLite 쿼리만 실행했다.

- 429 Sleep 요구를 먼저 추가: 기존 구현에서 `Sleep` 대신 HTTP 400/operation 없음으로 RED → 환급/10m sleep/새 gateway/성공 GREEN.
- timeout 및 unknown 오류 재시도 요구를 추가: 기존 400 전파로 RED → 새 gateway/attempts=2/영구 실패 GREEN.
- 기본 분석 timeout와 검증 실패 재시도/hint 요구: timeout undefined 및 기존 즉시 실패로 RED → `15m` operation/교정 gateway GREEN.
- serialized QuotaExceededError 및 HTTP-200 quota body: Sleep 대신 일반 retry gateway로 RED → 정확한 quota 경로 GREEN.
- registration `{ attempts: 0 }`: 기존 2로 RED → item 설정 변경 후 GREEN.
- 영구 실패 StepRun 응답 유실: 재생 결과 `stale_result_rejected`로 RED → 동일 실행의 failure marker 재확인으로 `failed` GREEN.
- 추가 회귀: 합성 시계를 5회 × 10분 이동하여 최초 30분 lease를 넘어서도 429마다 lease 연장, 환급 0/다음 분석 1, 새 gateway 및 최종 done을 검증했다. 네 전이 지점(429 대기 전/복귀, timeout 재시도/영구 실패)에 owner/token/job·entity generation/attempts/상태/삭제/만료 변조를 주입한 40개 signed 사례에서 D1 불변과 새 infer 거절을 확인했다. timeout 후 성공과 retry/refund StepRun 응답 유실에서도 OCR/R2 재읽기 및 중복 attempts가 없었다.
- 설정 override(3회/2분/1분)와 timeout → quota → 새 3회 예산, 누적 표시 attempts=4도 검증했다.
- 최종 narrow 실행: `npx vitest run src/lib/server/cloudflare/inngest-item.test.ts src/lib/server/cloudflare/inngest-item-status.test.ts src/lib/server/inngest-slice.protocol.test.ts src/lib/server/inngest-slice.test.ts` → **4 files, 110 passed**.
- `npm run check` → **0 errors / 0 warnings**. `git diff --check` → exit 0. 병행 작업 보호를 위해 전체 suite/build는 실행하지 않았으며 parent 최종 통합 검증 대상으로 남겼다.

### 남은 검증 한계 / 운영상의 차이

- **Hosted scheduler/provider 재시도/실제 10분·15분 경과는 NOT RUN**이다. signed offline SDK에서 출력한 Sleep/timeout/새 AIGateway와 실제 DB 상태만 증명한다. 서비스가 provider 상태를 메시지 없는 일반 오류로 바꾸면 원래 HTTP 상태를 복원할 수 없으며, 메시지 classifier 또는 보존된 QuotaExceededError 이름을 사용할 수 있는 범위까지 동등하다.
- 코드상 quota 재시도 상한은 제거했으나 Hosted의 run/step 한도, 보존 기간, 장시간 서비스 장애를 넘는 무한 가동은 증명하지 않았다. sleep 종료 후 30분 이상 전달이 지연되어 lease가 이미 만료되면 안전상 stale 거절한다(만료 lease 자동 부활은 하지 않는다).
- `retries: 0`은 item의 일반 infrastructure step에도 적용된다. 따라서 **D1/R2 자체 오류에 대한 이전 SDK 자동 재시도는 남아 있지 않다.** 이 보완은 분석 gateway/응답 검증의 queue 예산을 명시 구현한 것이며, 저장소 장애까지 포함한 전체 queue 동등성을 주장하지 않는다. 그 경우 onFailure owner fence가 적용된다. 원래 queue의 `saveAnalysis` 쓰기 오류까지 재분석 예산에 넣는 확장은 별도 검증이 필요하다.
- 기본 15분 분석/2분 OCR과 30분 lease 경로를 검증했다. 사용자 지정 분석 timeout이 lease보다 긴 경우의 추가 heartbeat/lease 예산 설계, 잘못된 retry 설정값, Hosted 한도 도달 후 새 run으로 넘기는 운용은 이번 실행에서 검증하지 않았다.
- 원격 요청·실제 LLM 호출·배포·commit·새 daemon은 하지 않았다. 변경 범위는 item 구현/관련 테스트, app item config 및 이 문서뿐이다.
