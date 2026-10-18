# Item Inngest 배포·실측 게이트

## 승인 범위

- 기존 math Worker 배포 및 기존 math D1 migration 적용은 승인됨.
- 신규 원격 자원 생성, 유료 전환, 일반 실제 LLM 호출은 금지.
- 별도로 명시된 예외: 합성 이미지 1건으로 실제 PaddleOCR-VL-1.6-mlx Hosted infer 실측. 사용자 사진·전체 분석 모델 호출은 포함하지 않는다.
- ITEM_ANALYSIS_BACKEND의 기본값은 기존 runner 유지. 원격 Inngest 활성화는 별도 승인 필요.
- 현재 브랜치 feat/cloudflare-d1-r2의 더티 변경을 보존하고 commit/push하지 않는다. 로컬 ops/lead-clean 및 remote-tracking 동명 ref는 확인되지 않았다.

## 배포 전 필수 검증

- [ ] eval 또는 동적 코드 실행 없이 실제 Worker에서 WASM 정규화 실행.
- [ ] 실제 local D1+R2 binding에서 합성 raw 이미지 → 정규화 → signed SDK AIGateway OCR/분석 operation → 저장 → 기존 API 조회를 검증. upstream fixture는 합성이라고 구분.
- [ ] OCR 재사용, ocr_missing, 429/timeout 재시도, taxonomy mismatch, stale generation/delete fence, runner 배타성 검증.
- [ ] npm test, npm run check, npm run build, npm run build:node, git diff --check 각각 exit 0. 파이프로 종료 상태를 가리지 않는다.
- [ ] 새 backend를 활성화하지 않은 Worker 배포 및 배포 version/HTTP health 재조회.

## Hosted 합성 OCR 실측 완료 기준

- 합성 이미지 내부에 고유 문자열을 넣고, 텍스트 prompt에는 그 문자열을 노출하지 않는다.
- image_url data URI가 실제 Hosted AIGateway에 전달되고 실제 OCR 응답에 이미지 내부 문자열이 나타나야 한다. HTTP 200만으로 합격하지 않는다.
- CF가 실제 OCR 응답을 R2에 저장하고 해당 키를 재조회한 증거가 있어야 한다.
- 접수~완료 관측 시간과 OCR operation 지연을 구분한다. trace를 열람하지 못하면 미관측이라고 명시한다.
- 기존 runner 기본값에서 item 함수가 등록되지 않으므로, 일반 업로드를 이용해 우회 활성화하지 않는다. OCR-only 합성 프로브 경로가 필요하며 전체 분석 호출을 만들지 않아야 한다.
- 125초 초과 실측은 OCR의 120초 timeout 정상 성공과 구분한다. 별도 장시간 프로브가 없으면 NOT RUN으로 남긴다.

## 이번 재개 후 확인된 사실

- 원격 migration 최초 조회는 CF 7403 오류. whoami 및 D1 list 성공 후 동일 조회 재시도 성공.
- 원격 pending 0005_report_outbox.sql, 0006_inngest_report_owner.sql, 0007_item_outbox.sql 적용 명령 exit 0.
- 적용 후 원격 d1_migrations 재조회에서 0001~0007 확인. sqlite_master 재조회에서 report_outbox/item_outbox 존재 확인.
- npm run check 실제 exit 1: inngest-item.test.ts의 first() nullable 결과 접근 2건. dev 수정 및 재검증 대기.
- Worker 배포 및 Hosted 이미지 OCR 실측은 아직 미실행. 과거 build-only 통과는 Worker WASM 동작 증거가 아니다.

최종 실행 결과의 정본: docs/inngest-item-analysis-results.md (검증 후 작성).
