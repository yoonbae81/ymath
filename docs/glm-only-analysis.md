# GLM 전용 분석·보고서

main 의 qwen 전용 구조([qwen-only-analysis.md](qwen-only-analysis.md))를 z.ai GLM 단일 provider로 전환한 기록이다. 브랜치 `feat/glm-only-analysis`에서 작업했고 main 직접 변경은 없다(merge는 parent 검증 후).

## 기준

- 새 분석, 재분석, 보고서 작성의 실행 provider ID는 `glm` 하나다. 화면 표시 라벨은 `GLM`.
- `zai`, `codex`, `agy`, `claude`, `omlx`, 미지정/알 수 없는 실행 provider를 명시적으로 실행할 수 없다. 명시적인 non-GLM API 요청은 HTTP 400으로 거부한다.
- 과거 데이터의 `requested_provider`와 옛 서버 기본값(`omlx` 포함)은 실행 시 GLM으로 안전하게 대체한다. 이 정책은 이력 삭제/마이그레이션을 뜻하지 않는다.
- 맥(oMLX) 의존을 완전히 끊는다. 분석뿐 아니라 OCR 전처리(PaddleOCR-VL)도 GLM 비전 모델로 대체한다. 설정 단일 출처는 `user/config/providers.json` 의 `zai` 항목(코딩 엔드포인트 + API 키 + 모델)이고 환경변수 우회는 없다. 유일한 예외는 OCR 모델 이름 교체(`OCR_MODEL`)다.

## 실제 변경

- `PROVIDERS = ['glm']`. `PROVIDER_LABEL = { glm: 'GLM' }`. 옛 `omlx`(Qwen (oMLX)), `agy`, `zai`, `codex`, `claude`는 LEGACY 라벨로만 읽힌다.
- `config.ts`는 `providers.json`에서 `zai` 항목만 노출한다(`zaiBaseUrl`·`zaiApiKey`·`zaiModel`). 모델 미지정 시 기본 `glm-5.3-flash`(사진 base64 첨부가 되는 비전 모델 — glm-5.3 텍스트 전용은 이미지 블록을 400으로 거부, 실호 확인). `DEFAULT_OLMX_MODEL` 제거, `DEFAULT_GLM_MODEL`/`DEFAULT_OCR_MODEL='glm-4.6v'` 추가. 실제 `user/config/providers.json` 은 쓰지 않았다(이미 `zai` 항목이 있음). `providers.example.json` 만 갱신.
- `llm.ts`: `structuredWithZai`(사진 data URL + system + 프롬프트·스키마, `response_format: json_object`)와 `runText` 가 z.ai 코딩 엔드포인트를 호출한다. `zaiExtraBody`: max_tokens 16384, flash·5V 계열은 thinking 필드 생략(추론 강제), 텍스트 전용 모델만 `thinking: disabled`. omlx 실행 경로 제거. `runStructured`/`runText` 는 `glm` 외 거부.
- `ocr.ts`: providers.json 의 `zai` 주소·키로 image.jpg 를 `glm-4.6v`(기본)로 OCR 한다.
- `analyze.ts` `providerFor` → `'glm'`, `report.ts` 기본 모델 → `settings().zaiModel`, API 경계(upload·reports·retry·items)의 허용 provider를 `'glm'`으로 바꾸고 메시지를 `GLM(glm)만 사용할 수 있습니다` 로 갱신.
- Cloudflare: `runtime.ts` 의 job provider 리터럴 3곳, `report-runner.ts`, `baton-catalog.ts` 기본값 → `'glm'`. `CloudflareEnv`의 `OMLX_*` 필드를 `ZAI_BASE_URL`/`ZAI_API_KEY` 로 교체. `item-callbacks.ts` 직접 OCR이 `ZAI_*` env + 기본 모델 `glm-4.6v`를 쓰고 오류 코드는 `OCR_NOT_CONFIGURED`. `inngest-item.ts`의 `DEFAULT_OCR_MODEL` 도 `glm-4.6v`. `wrangler.toml` vars: `OMLX_BASE_URL`(llm.xcv.kr) 제거 → `ZAI_BASE_URL=https://api.z.ai/api/coding/paas/v4`. `ZAI_API_KEY`는 시크릿이므로 배포 시 `wrangler secret put ZAI_API_KEY` 가 필요하다.
- `baton/catalog/ymath.providers.json`: providers는 `glm`(ZAI_BASE_URL/ZAI_API_KEY) 하나, profile `analysis`가 glm/ZAI_MODEL을 쓴다. `omlx`·`agy` provider와 `analysis-glm`·`analysis-agy` profile 제거. Runner 쪽(`/Users/y/Github/baton/config/ymath.cloud.json` 동기화 원본과 runner 실행 환경의 `ZAI_BASE_URL`/`ZAI_API_KEY`)은 배포 시 맞춰야 한다 — 이 카탈로그만 바꾸면 fail-closed로 거부된다.
- 테스트: `qwen-only.test.ts`(server·api)를 `glm-only.test.ts`로 대체(unknown·옛 provider 거부 + 과거 이력 GLM 대체 + 레거시 라벨). `config.test.ts`·`ocr.test.ts`·`llm.test.ts`·`analyze.provider.test.ts`·`baton-provider.test.ts`를 GLM 설정/HTTP 기대값으로 재작성. `baton-provider.test.ts`의 카탈로그 동기성 검사는 baton 저장소가 없는 환경에서 실패 대신 skip 하도록 고쳤다(기존 주석은 skip 의도였는데 실제로는 실패했다).
- `scripts/check-inngest-item-local.mjs`의 OCR 모델 식별자를 `glm-4.6v`로 갱신.
- README의 LLM 선택·동작·실행·장애·환경변수 절을 GLM 단일 기준으로 갱신.

## 역사 데이터 정책

- 기존 `record.json`, `analysis-<provider>.json`, 보고서, R2 객체, D1 행을 삭제하거나 일괄 변경하지 않는다.
- 옛 meta.provider(Qwen 포함)와 모델 라벨은 이력 탭/피드백에서 계속 읽고 표시한다. 새 재분석은 기존 저장 규약대로 최신 결과와 `analysis-glm.json` 슬롯만 갱신한다.
- 실제 `user/config/providers.json` 은 수정하지 않았다(비밀 파일). `ZAI_API_KEY` 배포 시크릿과 baton runner 환경변수는 배포 단계 작업이다.

## 검증

정상 검증은 HTTP mock과 격리 fixture 기준이다. 추가로 아래의 실호 재확인을 했다.

1. `npm test`: **372 passed / 1 skipped / 2 failed**. 실패 2건(main 브랜치 baseline 에서도 동일하게 실패하는 환경 문제, 이번 변경과 무관):
   - `src/routes/api/api.test.ts` 2건 — 로컬 체크아웃의 사진 백업 S3 설정 로딩 문제(503, `사진 백업 저장/삭제에 실패했습니다`).
   - (파일 단위) `connect-callbacks-supervisor.test.ts` — `/Users/y/Github/baton` 저장소 부재로 import 실패(환경 의존). baseline 과 동일.
   - baseline(main)은 3 failed(위 2건 + baton-provider 카탈로그 동기성). 카탈로그 동기성은 baton 저장소 부재 시 skip 으로 바뀌어 해소됐다.
2. `npm run check`: **6 errors — main 과 동일**. 전부 `/Users/y/Github/baton` 부재에 따른 import·암시적 any(stash 검증으로 main 재현 확인). 이번 변경으로 새로 생긴 오류 0건.
3. `npm run build`: 성공. `Worker runtime boundary PASS`(adapter-cloudflare 번들에 sharp·node:fs·CLI·native addon 없음).
4. 실호 재확인(설정 단일 출처 = 실제 providers.json 의 zai 항목, 코딩 엔드포인트):
   - `glm-5.3-flash` + `response_format: json_object` → HTTP 200, `{"answer": 2}`.
   - `glm-4.6v` + 8×8 JPEG data URL → HTTP 200, vision 응답 정상(참고: glm-4.6v는 `reasoning_content` 를 함께 내고 content 앞에 개행이 붙는다 — OCR 파이프라인은 content 문자열을 trim 해 쓰므로 영향 없음).

## 배포 전환 체크리스트(parent 머지 후)

1. `wrangler secret put ZAI_API_KEY`.
2. baton runner 실행 환경에 `ZAI_BASE_URL`(코딩 엔드포인트)·`ZAI_API_KEY`·(선택) `ZAI_MODEL` 설정, `/Users/y/Github/baton/config/ymath.cloud.json` 을 이 저장소의 카탈로그와 동기화.
3. 로컬/노드 실행은 `user/config/providers.json` 의 `zai` 항목만 확인하면 된다.
