# Qwen 전용 분석·보고서

## 기준

- 새 분석, 재분석, 보고서 작성의 실행 provider ID는 `omlx` 하나다. 화면에는 Qwen을 표시한다.
- `zai`, `codex`, `agy`, `claude`, 미지정/알 수 없는 실행 provider를 명시적으로 실행할 수 없다. 명시적인 non-Qwen API 요청은 HTTP 400으로 거부한다.
- 과거 데이터의 `requested_provider`와 옛 서버 기본값은 실행 시 Qwen으로 안전하게 대체한다. 이 정책은 이력 삭제/마이그레이션을 뜻하지 않는다.
- OCR은 분석 provider와 별개다. `PaddleOCR-VL-1.6-mlx` 전처리는 유지한다.

## 실제 변경

- `PROVIDERS = ['omlx']`. 역사 라벨을 별도 맵으로 이동했다. `ItemRecord`, `SavedAnalysis`, `Feedback`의 저장된 provider는 문자열로 읽어 호환성을 유지한다.
- `/items` 재분석 provider selector를 Qwen 단일 표시로 바꿨다. 저장된 과거 provider가 다음 요청의 실행 provider로 전달되지 않는다.
- Node 분석·보고서 실행의 z.ai HTTP 경로, Codex/Agy CLI 실행, CLI 전용 파서·Gemini 스키마 변환·인자 길이 제한을 제거했다.
- 미사용 확인 후 `exec.ts`, `exec.test.ts`, `fake-cli.ts`를 제거했다. provider 전용 npm 의존성은 없었고 공유 dirty package 파일은 추가 변경하지 않았다.
- `config.ts`는 `providers.json`에서 `omlx` 항목만 노출한다. ZAI/CODEX/AGY 실행 환경변수와 `ANALYZE_PROVIDER`, `ANALYZE_MODEL` 레거시 경로를 제거했다. 실제 설정 파일은 수정하지 않았다. 비밀값 없이 구조와 모델 ID만 확인했으며 현재 omlx 모델은 `Qwen3.6-35B-A3B`다.
- 업로드/재분석/보고서 생성/보고서 재시도의 명시적인 non-Qwen provider를 거부한다. D1 신규 item/report job과 Node 보고서 runner는 Qwen으로 고정한다. 과거 job을 Node runner가 읽을 때도 Qwen으로 실행한다.
- 기존 다중-provider 실행 테스트를 Qwen HTTP mock 및 unknown-provider 거부 테스트로 정리했다. 이력 읽기 테스트의 옛 provider fixture는 의도적으로 유지한다.

## 검증

실제 외부 LLM 성공 결과를 검증했다는 의미가 아니다. 정상 검증은 HTTP mock과 격리 fixture를 사용한다.

1. `npx vitest run src/lib/server/qwen-only.test.ts`: 최초 RED 11 failed/1 passed, 구현 후 12 passed.
2. API provider 경계 테스트: 격리 수정 후 RED는 보고서가 201로 허용되는 오류를 재현했고, 경계 구현 후 4 passed. 서버/API 경계 합계 16 passed.
3. Qwen·설정·큐·이력·보고서 runner 관련 10개 테스트 파일: **110 passed**.
4. 초기 전체 검증은 390 passed/1 skipped였으며, 이후 다른 child의 Inngest retry 변경과 동시 검증에서 전체 테스트는 388 passed/4 failed/1 skipped였다. 실패 4건은 수정 금지한 `cloudflare/inngest-item.test.ts`의 retry/signed-protocol 기대값이었으며 **parent 통합 후 전체 `npm test`는 440 passed/1 skipped로 해소됐다.**
5. 초기 `npm run check`는 0 errors/0 warnings였다. 동시 변경 후 재실행은 `cloudflare/inngest-item-status.test.ts`의 step mock에 새 필수 `sleep`이 없는 오류 1건으로 막혔으나 **parent 통합 후 재검증에서 0 errors/0 warnings로 해소됐다.**
6. parent 최종 검증(2026-10-18): `npm test` 440 passed/1 skipped, `npm run check` 0 errors/0 warnings, `npm run build` 성공(adapter-cloudflare 번들 + worker runtime boundary PASS). `cloudflare/inngest-item.ts`의 새 결과 meta provider 라벨을 `claimed.provider ?? DEFAULT_PROVIDER ?? 'omlx'`에서 `'omlx'`로 고정했고 미사용 `DEFAULT_PROVIDER`를 `CloudflareEnv`에서 제거했다(기존 job의 실행 모델 선택과 무관, 과거 provider 라벨이 새 결과에 전파되지 않음).

이 작업 자체는 `cloudflare/inngest-item.ts`를 수정하지 않았다. parent 통합에서 새 결과 meta provider 라벨을 `'omlx'`로 고정했고(위 6번) 이 권고는 반영됐다.

## 역사 데이터 정책

- 기존 `record.json`, `analysis-<provider>.json`, 보고서, R2 객체, D1 행을 삭제하거나 일괄 변경하지 않는다.
- 옛 meta.provider와 모델 라벨은 이력 탭/피드백에서 계속 읽고 표시한다.
- 새로운 Qwen 재분석이 성공하면 기존 저장 규약대로 최신 결과와 Qwen 분석 슬롯만 갱신한다. 다른 provider의 저장된 이력은 보존한다.
- 실제 `user/config/providers.json`의 비밀값이나 레거시 설정 항목은 쓰기 변경하지 않았다.

## 테스트 격리 사고 — 증거 보존 필요

최초 신규 API 경계 RED 실행에는 DATA_DIR 격리와 보고서 큐 mock이 빠져 있었다. 그 결과 non-Qwen을 거부하지 않는 기존 보고서 API에 실제 요청이 들어가 테스트가 각 5초 뒤 timeout됐다. 다음 네 실제 보고서 파일의 생성 시각이 테스트 호출 시각과 일치한다. 이 테스트의 부작용으로 판단할 강한 근거가 있으며, 정상 사용자 작업이라고 단정해 숨기지 않는다.

- `20261018-113702-rep-6p59`
- `20261018-113707-rep-30c0`
- `20261018-113712-rep-q6uc`
- `20261018-113717-rep-cbq3`

확인 시 모두 `generating`, attempts 1, item_ids 37개, markdown/meta/error는 비어 있었다. 실제 LLM 네트워크 요청의 전송/완료 여부는 검증되지 않았다. 실제 큐에 진입했으므로 호출 가능성을 배제할 수 없다. 파일은 삭제하거나 상태를 바꾸지 않았다. 사용자 승인 전 삭제하지 않는다.

메타데이터 증거는 `/Users/y/.hermes/profiles/plan/cache/scratch/qwen-api-isolation-incident.json`에 보존했다. 최초 terminal 결과는 11:37:02 시작, 20.24초, 네 5000ms timeout이다. 이후 테스트는 USER_DIR/DATA_DIR/CONFIG_DIR를 임시 디렉터리로 격리하고 보고서 실행과 config 경계를 mock하며 fetch를 금지한다. 안전장치 추가 후 재실행은 실제 보고서 큐를 호출하지 않는다.
