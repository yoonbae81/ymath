# Inngest item 분석 전환 검증 결과

## parent 원격 배포·Hosted OCR 실측 (최신)

- **Hosted 합성 이미지 OCR → CF R2 저장/재조회 PASS. 일반 item backend 원격 활성화는 하지 않았다.** 아래의 NOT RUN 표기는 로컬 작업 당시 상태이며 이 섹션이 OCR-only 원격 실측 상태를 갱신한다.
- 원격 D1 migration `0005_report_outbox.sql`, `0006_inngest_report_owner.sql`, `0007_item_outbox.sql` 적용 exit 0. 적용 후 `d1_migrations`에서 0001~0007, `sqlite_master`에서 report_outbox/item_outbox를 다시 읽어 확인했다.
- `npx wrangler deploy` exit 0. math Worker version **`7d9aa7bb-1357-4ffe-a655-93eba98cfb2d`**, 기존 `xcv.kr/math*` route 유지. `wrangler deployments list` 재조회에서 해당 version 100% 확인.
- HTTP `/math/api/inngest/health` 200, 서명 없는 SDK GET `/math/api/inngest` 401 확인. Secret 목록에서 INNGEST_EVENT_KEY/INNGEST_SIGNING_KEY/LLM_API_KEY 이름 존재 확인(값 조회 안 함). 일반 vars는 LLM_BASE_URL/LLM_MODEL만이며 ITEM_ANALYSIS_BACKEND는 미설정, 기존 runner 기본값 유지.
- parent 실제 local workerd 스크립트 재실행 exit 0: **4개 시나리오 PASS**, 증거 `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-item-workerd-qWEZxl/evidence.json`. 외부 provider는 여기서는 합성이다.

### 실제 OCR 1건 결과

- 일반 submit API에 고정 sentinel을 **한 번만 POST**: HTTP 202, 접수 관측 2.0207초. job **`slc_b329bf06-90f5-4101-ba3f-c24e6ede5083`**.
- 실제 모델 **PaddleOCR-VL-1.6-mlx**. 텍스트 prompt에 없는 이미지 내부 marker **`YMATH7Q9K2`**와 `x + 2 = 5`가 OCR 응답에 나타났다. 따라서 사진 무시/vision 미지원 징후는 이번 합성 fixture에서 관측되지 않았다. 임의 사진의 OCR 품질까지 보장하지는 않는다.
- SDK infer 앞/뒤 메모이즈 timestamp 차이 **5,050ms**. 네트워크/step 재개가 포함된 관측 시간이며 순수 모델 compute 지연으로 해석하지 않는다. 접수 시작 기준 8.4619초에 running, **13.5618초**에 done 관측.
- 결과 JSON: `imageMarkerMatched=true`, `persistedReadback=true`, OCR text=`YMATH7Q9K2\nx + 2 = 5`.
- R2 key: **`probes/slc_b329bf06-90f5-4101-ba3f-c24e6ede5083/ocr.txt`**. CF 저장/readback 결과 외에도 parent가 `wrangler r2 object get math-private/<key> --remote`로 정확한 객체를 별도 내려받아 위 두 줄을 확인했다(exit 0).
- 원격 D1도 해당 job ID만 SELECT해 status done 및 동일 result_text 확인(exit 0). 사용자 사진·기존 운영 item을 읽거나 분석하지 않았다.
- 원격 증거: `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-hosted-image-probe/{submission.json,poll.json,ocr-readback.txt}`.
- **trace 관측 한계:** Inngest dashboard trace를 직접 열람하지 않았다. 실제 Hosted 실행과 CF 결과/R2 지속성은 확인했으나 provider 내부 상세 trace·token·모델 compute 시간은 미관측이다. 로컬 signed SDK의 AIGateway operation 검증과 원격 실행 결과를 구분한다.
- **125초 초과 실제 케이스 NOT RUN.** OCR 요구 timeout 120초보다 길어 정상 OCR 성공 케이스가 될 수 없고, 추가 장시간 실제 모델 호출은 하지 않았다. non-stream whitespace keepalive 및 Hosted 장기 연결은 별도 미검증이다.

### 활성화 및 미완료 구분

- 완료: 기존 math D1 migration, Worker 배포, 기존 secret 이름 확인, 합성 OCR-only Hosted 실측/R2 readback. 신규 원격 자원·유료 플랜 생성 없음.
- 별도 승인 후 필요한 조치: ITEM_ANALYSIS_BACKEND=inngest 설정(기본 runner를 원격에서 바꾸는 작업), OCR_MODEL=PaddleOCR-VL-1.6-mlx 및 LLM_BASE_URL/LLM_MODEL 점검, 배포 후 Inngest 앱 재동기화로 item-analysis/item-outbox-recovery 함수 등록 확인. REPORT_BACKEND는 item 활성화 때문에 변경하지 않는다.
- INNGEST_EVENT_KEY/INNGEST_SIGNING_KEY/LLM_API_KEY는 해당 Worker/Hosted 환경과 일치해야 한다. 이미 있는 이름을 확인했을 뿐 신규 secret 값은 등록하지 않았다.
- 일반 업로드→item 전체 분석 모델→기존 읽기 API의 **Hosted 전체 E2E는 NOT RUN**. 로컬 binding 전체 흐름과 원격 OCR-only 실측을 합쳐 Hosted 전체 item 전환 완료라고 주장하지 않는다.
- 최종 audit에서 main item OCR timeout 명시와 429/timeout/taxonomy 계약 추가 검증을 진행 중이다. 이 보완은 현재 원격 version 이후 변경이므로 검증 후 별도 재배포 결과를 남겨야 한다.

## 검증 범위와 결론

- **Vite → adapter-cloudflare → Wrangler dry-run → 실제 workerd에서 item 분석 경로가 실행된다.** 로컬 D1/R2에 저장한 합성 이미지로 정규화, 서명된 Inngest SDK step 재생, OCR/분석 요청 생성, 결과 커밋, item GET 재조회를 검증했다.
- 외부 OCR/LLM 호출은 하지 않았다. `AIGateway` 응답만 명시적인 합성 fixture로 주입한다. 실제 모델 품질·hosted Inngest 연결·실서비스 배포 검증을 의미하지 않는다.
- 이 구현·로컬 검증 child는 원격 접근, 원격 migration, 모델 호출, 배포, commit을 수행하지 않았다. parent 보고에 따르면 원격 migrations **0005~0007 적용은 완료**됐다(이 child의 독립 재검증은 아님). 운영 `ITEM_ANALYSIS_BACKEND` 기본값 runner는 변경하지 않았다. 아래 OCR-only probe의 **Hosted 실행은 아직 NOT RUN**이며 parent가 일반 API gate를 통해 단 1건 수동 접수할 예정이다.

## 재현된 원인과 수정

1. 설치 버전은 **Wrangler 4.151.1 / Miniflare 5.20261012.1-beta**다. Miniflare의 현재 생성자는 `workers[].config`를 요구하므로 기존 v4 형태의 옵션 객체를 바로 넘기면 `ERR_VALIDATION`이 발생했다. 설치된 `node_modules/miniflare/dist/src/index.d.ts`의 `convertV4MiniflareOptions()`를 사용한다. 변환기는 `modulesRules`를 지원하지 않으므로 dry-run 산출물의 JS와 모든 WASM을 명시적인 `ESModule`/`CompiledWasm` 모듈 목록으로 전달한다. `cf:false`, Worker outbound 차단을 사용하고 D1/R2는 새 임시 런타임에만 생성한다.
2. 위 문제를 해소한 뒤 실제 workerd에서 `normalize-item-image`가 `EvalError: Code generation from strings disallowed for this context`로 실패하는 것을 확인했다. `item-normalize.ts`의 eval을 제거하고 정적 경로의 dynamic import를 사용한다. Vite pre-resolve 플러그인은 JPEG WASM을 external import로 보존하고 Wrangler가 CompiledWasm으로 번들한다. 모듈의 `default`를 **await한 후** jSquash `init()`에 전달한다(Promise 자체를 넘기지 않는다).
3. 정규화 통과 후 AJV 런타임 `compile()`의 `new Function`에서도 같은 workerd 금지 오류를 재현했다. Worker 빌드는 `worker-analysis-validator.ts` 플러그인에서 curriculum 기반 동일 스키마를 AJV standalone ESM으로 생성한다. 런타임 스키마와 빌드 스키마가 다르면 fail-closed한다. Node runner와 unit test는 기존 AJV 런타임 검증을 유지한다. Worker에서도 잘못된 결과를 실제 거부하는 음성 테스트를 추가했다.
4. `inngest-item.test.ts`의 nullable `.first()` 반환값 두 곳을 별도 row 변수와 존재 assertion으로 수정했다. `npm run check`에서 보고된 오류를 제거했다.

## 명령과 실제 결과

작업 디렉터리: `/Users/y/Github/ymath`

```sh
export TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch
export WRANGLER_SEND_METRICS=false
npm run build:node
npm run build
node --import tsx scripts/check-inngest-item-local.mjs
npm run check
npm test -- --reporter=dot
```

| 게이트 | 실제 결과 |
| --- | --- |
| `npm run build:node` | exit 0, adapter-node 완료 |
| `npm run build` | exit 0, adapter-cloudflare 완료 + 실제 Wrangler 번들의 Worker runtime boundary PASS |
| item local script | exit 0, `status: PASS`, workerd 시나리오 4개 |
| `npm run check` | exit 0, **0 errors / 0 warnings** |
| `npm test -- --reporter=dot` | exit 0, **32 files passed / 1 skipped; 381 tests passed / 1 skipped** |

### workerd 시나리오

| 합성 ID | 결과 | AIGateway 수 |
| --- | --- | ---: |
| `20261018-000001-test` | OCR 정리·저장 → 분석 → done → item GET done | 2 |
| `20261018-000002-test` | 기존 OCR 재사용, OCR infer 생략 → done → item GET done | 1 |
| `20261018-000003-test` | 빈 OCR → 사진 기반 폴백, `ocr_missing: true` → done → item GET done | 2 |
| `20261018-000004-test` | 스키마 위반 합성 결과 → HTTP 500, 스키마 오류 메시지, done 커밋 거부 | 2 |

각 infer의 이미지 data URI를 실제 JPEG로 디코딩해 **EXIF orientation 6 적용, 2000×400 입력 → 320×1600 출력, RGB 채널 동일(그레이스케일)**을 검사했다. 외부 Worker HTTP 시도 목록은 빈 배열이어야 통과한다.

### 실행 증거 경로

- 최종 runtime 산출물/증거: `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-item-workerd-R1mRKv/`
- 집계 JSON: 위 디렉터리의 `evidence.json`
- 실제 CompiledWasm:
  - `cdf93d5c982a06e50892239da2e1bd807246e012-mozjpeg_enc.wasm`
  - `a53137fb0ae8aa1649a103b7fb379bc97522c937-photon_rs_bg.wasm`
- 로그(scratch 루트): `ymath-item-build.log`, `ymath-item-node-build.log`, `ymath-item-tests.log`, `ymath-item-workerd.log`

## 정책 차이·남은 제한

- Worker 정규화는 JPEG/PNG/WebP만 허용한다. Node sharp 경로보다 입력 포맷 범위가 좁다. decode 전에 50Mpx를 거부하며, EXIF 보정 → 최대변 1600 inside 축소 → 그레이스케일 → quality 80 JPEG 정책을 사용한다. 서로 다른 이미지 엔진이므로 sharp와 JPEG 바이트 단위 동일성을 보장하지 않는다.
- 원본 삭제, 재시도·삭제 fencing 등 나머지 경계는 기존 item unit/integration suite에서 검증되며, 이 로컬 workerd 스크립트의 4개 시나리오를 모든 장애 경로에 대한 workerd 검증으로 확대 해석하면 안 된다.
- workerd 시작 시 exifr가 `Couldn't load fs` / `Couldn't load zlib` 경고를 출력한다. 선택적 Node 모듈 탐색이며 위 이미지/EXIF 검증과 최종 실행은 통과한다. 음성 스키마 fixture의 `Inngest function error` 출력도 의도된 거부 증거다.
- `src/lib/server/ocr.ts` EOF에서 이번 세션에 생긴 빈 줄 하나만 제거했다. 이후 전체 `git diff --check` exit 0을 확인했다.
- **이 범위의 로컬 실행 blocker는 해소됐다.** Hosted 모델 호출/배포는 미수행이며 별도 검증 대상이다.

## 고정 synthetic OCR-only probe (Hosted: NOT RUN)

- 기존 `synthetic-text-analysis`에서 저장된 `job.input_text === 'SYNTHETIC_IMAGE_OCR_PROBE_V1'`일 때만 별도 `runOcrProbe`를 호출한다. 새 endpoint는 없다. 기존 submit의 text trim 계약은 유지하므로 접수 시 공백을 덧붙이지 않는다.
- `ocr-probe-fixture.ts`는 로컬 sharp로 SVG를 JPEG(1000×300, 14,080 bytes)로 렌더링한 고정 base64 상수다. 합성 영문숫자 marker와 `x + 2 = 5`만 담는다. 기대 marker는 이미지에만 전달하며 system/user 텍스트 prompt에 넣지 않는다.
- 기존 `buildOcrMessages`로 JPEG data URI 요청을 만들고 고정 모델 `PaddleOCR-VL-1.6-mlx`, `step.ai.infer`, AIGateway `timeout: '2m'`를 사용한다. `ITEM_ANALYSIS_BACKEND=runner`에서도 synthetic 함수는 등록된다. 일반 text/report 계약은 바꾸지 않는다.
- infer 앞/뒤 각각 `step.run`에 `Date.now()`를 기록해 `inferObservedMs`를 계산한다. 재생 때 새 시각으로 덮어쓰지 않는다. 이는 모델 자체 추론시간이 아니라 SDK step 관측 경과시간이다.
- OCR envelope 오류/미완료/빈 결과를 거부하고 LOC 토큰을 정리한다. `step.run` 안에서 R2 `probes/<jobId>/ocr.txt`에 저장한 뒤 별도 `step.run`에서 재조회해 **문자열 전체 일치**를 검사한다(해시 비교 아님).
- `store.complete`의 `result_text` JSON은 `imageMarkerMatched`, `ocrText`, `ocrKey`, `persistedReadback`, `inferObservedMs`, `model`을 담는다. marker 또는 readback 불일치는 증거를 보존하되 함수 결과 `status: 'probe_failed'`로 반환한다. D1의 `status: done`만으로 OCR 성공을 판단하면 안 되며 **두 boolean 모두 true**여야 probe 성공이다.

### parent가 수행할 수동 접수 (아직 실행하지 않음)

인증된 기존 사이트의 일반 API gate를 통과한 동일-origin 요청으로 아래 body를 **단 한 번** 전송한다. SDK `/api/inngest` 예외 gate를 사용하거나 인증을 우회하지 않는다.

```http
POST /math/api/inngest/submit
Content-Type: application/json

{"text":"SYNTHETIC_IMAGE_OCR_PROBE_V1"}
```

`202`의 `jobId`를 보관하고 `GET /math/api/inngest/jobs/<jobId>`로 완료 여부를 조회한다. `result`는 JSON 문자열이므로 파싱 후 위 두 boolean과 실제 `ocrText`를 확인한다. Hosted 호출/실제 모델 판독/원격 R2 readback은 이 로컬 테스트가 입증하지 않는다. 이 문서 작성 시 **Hosted NOT RUN**이다.

### probe 로컬 검증

TDD RED에서 기존 text 모델/timeout 누락으로 실패함을 확인한 뒤 구현했다. 추가 RED에서 error envelope 안의 marker를 성공으로 오인하는 문제를 재현하고 거부하도록 보완했다. 서명된 실제 SDK 프로토콜 + 실제 SQLite + 명시적인 로컬 R2 대역으로 다음을 검증했다:

- JPEG data URI, marker가 없는 prompt, OCR 모델, AIGateway 2분 timeout.
- 저장 step 일시 장애 후 동일 run 재생: infer 1회, R2 put/get 각 1회, 저장된 두 timestamp의 차이 유지.
- LOC 정리, marker 일치/불일치, R2 불일치/객체 누락, error envelope/빈 OCR 거부, 정확하지 않은 저장 input의 일반 text 처리, 기존 report 흐름.
- `npm run check`: exit 0, **0 errors / 0 warnings**.
- `npm test -- --reporter=dot`: exit 0, **33 files passed / 1 skipped; 408 tests passed / 1 skipped** (음성/재시도 fixture의 의도된 stderr 포함).
- `npm run build`: exit 0, adapter-cloudflare + 실제 Wrangler dry-run **Worker runtime boundary PASS**.
- `npm run build:node`: exit 0, adapter-node 완료. 빈 chunk 경고만 있다.
- `git diff --check`: exit 0. 빌드 로그: scratch의 `ymath-ocr-probe-build.log`, `ymath-ocr-probe-node-build.log`.

### 병행 design 검토 보완

design 검토에서 item 상태가 queued에 머무르는 회귀를 별도 child가 보완했다. `inngest-item.ts`는 기존 `updateCloudJobStage`를 `mark-item-ocr` / `mark-item-analyzing` step에서 재사용하고 fencing 실패 시 `stale_result_rejected`로 종료한다. 별도 status 회귀 테스트와 기존 item/runtime 테스트 **35 passed**, check **0/0**은 해당 child 보고이며, 위 전체 suite에도 신규 status 테스트가 포함된다. parent는 최종 shared tree를 다시 검증할 예정이다.
