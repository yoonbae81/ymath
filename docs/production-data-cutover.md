# 운영 데이터 cutover — 승인 전 실행 금지

## 현재 판정

**운영 업로드 미실행. 사용자 공개범위 결정과 parent의 명시적 승인이 필요하다.**

이 문서는 데이터 이관 도구의 로컬 검증과 향후 승인된 실행 절차다. 원격 배포·설정 변경·LLM 호출을 수행했다는 뜻이 아니다. `scripts/cloudflare-migrate.mjs`는 기존 **local-only** 도구이며, 운영에 재사용하지 않는다.

원본 read-only 조사에서 확인한 추가 차단 사유:

- items 69개. reports는 처음 집계한 1개가 아니라 5개다.
- `20261018-113702-rep-6p59`, `20261018-113707-rep-30c0`, `20261018-113712-rep-q6uc`, `20261018-113717-rep-cbq3`는 `generating`, markdown 없음. 각각 item 37개를 참조한다. 생성 주체는 이 조사로 판단하지 않는다.
- 기존 done 보고서 `20260919-221106-rep-sgcz`도 참조 13개 중 **`20260919-162612-99cx`가 현재 items에 없다.**
- 실제 원본 `prepareSnapshot`은 `broken report reference`로 중단했다. 원본은 수정·삭제하지 않았고 snapshot/backup 생성이나 원격 접근으로 진행하지 않았다.
- active 보고서가 없어져도 위 dangling reference를 해결/승인 없이 무시해서는 안 된다. 이 도구에는 보고서 제외, 원본 수정, ID 자동 교정, 참조 자동 삭제 옵션이 없다. 원본 복구 또는 별도 승인된 정책 결정이 필요하다.

사이트의 anonymous API 200 상태에서는 원본 문제 이미지·분석·보고서 공개 위험이 있다. **Access 보호를 확인하거나, 사용자가 공개를 명시적으로 선택하기 전에는 apply 금지.** 도구의 승인 JSON은 실제 Access/maintenance 상태를 자동 구성하거나 증명하지 않는다.

## 범위와 파일

- 구현: `scripts/production-data-cutover.mjs`
- 테스트: `scripts/production-data-cutover.test.mjs`, `scripts/production-data-cutover.integration.test.mjs`
- 합성 fixture: `scripts/production-data-cutover.fixture.mjs`
- `prepare`: 로컬 전용. 입력 원본을 수정하지 않고, 서로 독립적인 새 snapshot/backup 디렉터리를 생성한다.
- `verify`: 로컬 전용. manifest/각 파일 SHA-256/bytes/집계/참조를 재검사한다.
- `apply`: **parent 승인 후에만** 명시적 remote binding을 연다. 기존 앱 설정이나 LLM/queue는 호출하지 않는다. 운영 스키마 자동 마이그레이션도 하지 않는다.

허용하는 원본 파일은 아래뿐이다. items 내부의 예상하지 않은 파일과 symlink는 fail-closed다.

```text
items/<exact-valid-id>/record.json
items/<exact-valid-id>/image.jpg
items/<exact-valid-id>/ocr.md                         # 존재할 경우
items/<exact-valid-id>/analysis-<provider>.json       # 존재하는 모든 과거 provider 보존
reports/<exact-valid-report-id>.json
```

`user/data`의 `session-secret`, `ymath.db` 등 다른 루트 파일은 열거나 복사하지 않는다. `user/config` 전체를 순회하지 않는다. 사용자가 명시한 **workbooks.json 한 파일만** 읽고, `id/name/publisher/grade/semester` 필드만 허용한다. providers 설정·키·계정·프롬프트는 이관 범위가 아니다.

snapshot과 backup 각각에 `data/`, `WORKBOOKS_JSON.json`, `manifest.json`을 저장하고 독립적으로 검증한다. 파일 mode 0400, 디렉터리 0500으로 seal한다. OS 관리자 수준의 진짜 변경불가 플래그는 아니므로 **승인한 manifest SHA**를 외부 승인 기록에 보관하고 매 실행 재검증한다. 실제 경로를 해석하여 symlink ancestor를 통한 source/snapshot/backup 중첩도 거부한다.

## 문제집 목록 계약

`src/lib/server/config.ts`의 **실제 `sortWorkbooks`를 호출**한다. 정렬은 학년 → 원본 `publisherOrder` → 학기 → `localeCompare(name, 'ko')`다. 별도의 비슷한 정렬을 구현하지 않는다.

생성하는 `WORKBOOKS_JSON.json`의 모양은 `{"workbooks":[...]}`이며 `workbooksFromEnv(env.WORKBOOKS_JSON)` 계약과 일치한다. 이 파일의 SHA도 manifest에 포함된다.

**도구는 운영 WORKBOOKS_JSON var를 자동 변경하지 않는다.** 사용자/parent의 별도 설정변경 승인 후, 기존 vars를 보존하는 정상 배포 절차로 이 파일의 JSON을 정확히 `WORKBOOKS_JSON` 문자열 값에 반영해야 한다. Wrangler 설정 전체를 덮어쓰거나, Workbook JSON을 secret으로 전송하거나, provider 설정을 함께 복사하지 않는다. 목록 UI의 전체 ID·순서가 동일해야 완료다.

## 승인 전에 가능한 로컬 명령

아래 경로는 예시이며 출력 디렉터리는 **미존재·비중첩 경로**여야 한다. 원본 writer/개발 서버/테스트가 계속 쓰는 동안 prepare를 통과시키려고 파일을 손대지 않는다.

```bash
cd /Users/y/Github/ymath
export TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch
node --import tsx --test \
  scripts/production-data-cutover.test.mjs \
  scripts/production-data-cutover.integration.test.mjs

node --import tsx scripts/production-data-cutover.mjs prepare \
  --source /Users/y/Github/ymath/user/data \
  --workbooks /Users/y/Github/ymath/user/config/workbooks.json \
  --snapshot /ABS/PRIVATE/CUTOVER/snapshot \
  --backup /ABS/OTHER-PRIVATE-LOCATION/backup

node --import tsx scripts/production-data-cutover.mjs verify \
  --snapshot /ABS/PRIVATE/CUTOVER/snapshot
node --import tsx scripts/production-data-cutover.mjs verify \
  --snapshot /ABS/OTHER-PRIVATE-LOCATION/backup
```

현재 원본은 위 차단 사유로 prepare가 실패하는 것이 정상이다. fixture 테스트는 실제 원본을 사용하지 않으며 모든 입력/설정/저장소가 TMPDIR 아래 합성 데이터다.

## 실제 apply 전 필수 승인 게이트

1. 사용자가 개인정보 공개범위를 결정했다. `access-protected`이면 익명 요청 차단과 승인 사용자 접근을 실제로 확인한다. `public-approved`는 사용자 명시 동의가 있을 때만 쓴다.
2. **parent가 최종 manifest SHA, 전체 source counts, 정확한 target IDs를 검토하고 실제 apply를 승인했다.** 에이전트가 자기 승인 JSON을 만들어 진행하지 않는다.
3. source writer가 중지되어 quiescent하다. 원격 앱의 모든 생성·변경·삭제·스케줄·outbox·Inngest writer도 멈춘 승인된 유지보수 창이다. `maintenanceConfirmed`는 운영자의 확인이다. 이 도구가 앱 writer를 자동 차단하지 않는다.
4. 원본 reports/items 참조가 유효하고 active 상태가 없다. snapshot 이후 원본/문제집 목록이 조금이라도 달라지면 새 snapshot과 새 승인이 필요하다.
5. backup이 snapshot과 SHA/bytes/manifest까지 일치하며 독립 보관되어 있다. 예시는 두 경로지만 장애 대비로 별도 저장매체 보관도 권장한다.
6. target은 기존 전체 schema migrations가 이미 적용된 정확한 D1/R2다. 도구가 schema migrations를 대신 적용하지 않는다. 승인한 DB/bucket 식별자를 다시 확인한다.
7. entities(삭제 행 포함), analyses, feedback, jobs, report/item outbox, synthetic Inngest jobs, migration_files가 모두 0이다. R2도 비어 있거나 **같은 manifest run의 허용된 staging key만** 존재해야 한다. 다른 run/기존 object 충돌은 중단한다.
8. 정상적인 Wrangler 인증을 준비한다. 키를 chat/명령 인자/로그/소스 파일로 옮기지 않는다. 본 작업에서는 원격 credential 값을 열람·출력하지 않았고 remote binding을 열지 않았다.

승인 파일은 아래 스키마의 **실제 승인 기록**이어야 한다. `expectedCounts`는 prepare 출력의 모든 필드를 정확히 복사한다. 다음 값들은 실행 가능한 승인 예시가 아닌 placeholder다.

```json
{
  "approvedByParent": true,
  "privacyDecision": "access-protected",
  "maintenanceConfirmed": true,
  "expectedEmpty": true,
  "target": {
    "accountId": "EXACT_APPROVED_ACCOUNT_ID",
    "databaseId": "EXACT_APPROVED_DATABASE_ID",
    "bucket": "EXACT_APPROVED_BUCKET_NAME"
  },
  "manifestSha256": "EXACT_APPROVED_PREPARE_SHA256",
  "expectedCounts": {
    "items": 69,
    "reports": "COPY_ACTUAL_VERIFIED_INTEGER",
    "objects": "COPY_ACTUAL_VERIFIED_INTEGER",
    "analyses": "COPY_ACTUAL_VERIFIED_INTEGER",
    "feedback": "COPY_ACTUAL_VERIFIED_INTEGER",
    "workbooks": 17
  }
}
```

**아래 명령은 parent 승인 후에만 실행한다. 이 문서를 작성하면서 실행하지 않았다.**

```bash
node --import tsx scripts/production-data-cutover.mjs apply \
  --apply-remote --approval /ABS/PRIVATE/CUTOVER/approved.json \
  --source /Users/y/Github/ymath/user/data \
  --workbooks /Users/y/Github/ymath/user/config/workbooks.json \
  --snapshot /ABS/PRIVATE/CUTOVER/snapshot \
  --backup /ABS/OTHER-PRIVATE-LOCATION/backup \
  --account EXACT_APPROVED_ACCOUNT_ID \
  --database EXACT_APPROVED_DATABASE_ID \
  --bucket EXACT_APPROVED_BUCKET_NAME
```

CLI는 승인/manifest/counts/backup/source 검사를 **원격 proxy 생성 및 인증 조회 전에** 수행한다. 원격 연결은 격리된 임시 Wrangler config에 `remote:true` D1/R2만 명시하고 `remoteBindings:true`, `envFiles:[]`로 연다. 앱 wrangler.toml이나 .env, LLM binding을 사용하지 않는다. Wrangler remote proxy 지원과 실제 운영 권한·quota는 아직 원격에서 검증하지 않았다.

## publication / 재개 / 장애 처리

- run ID는 승인한 manifest bytes의 SHA-256. R2 key는 `cutover/<run-sha>/<allowlisted-path>`다.
- **모든 파일의 PUT 후 GET bytes 길이와 SHA-256을 검사**한다. 존재하는 같은 run key는 bytes가 정확히 같을 때만 재사용한다. 다르면 덮어쓰지 않고 실패한다.
- D1 `cutover_runs`, `cutover_rows`, `cutover_guards`와 `migration_files`를 만든다. staging row INSERT는 최대 25문장/100 bound values로 분할한다. 아직 앱 entities에는 보이지 않는다.
- 전체 staging metadata를 기대한 값과 비교하고 R2 전 파일, source quiescence, snapshot/backup/manifest/counts를 publication 직전에 다시 검사한다.
- 최종 D1 **6문장 batch 한 번**으로 empty-target CHECK guard → entities → analyses → feedback → migration_files → run published를 묶는다. 개별 entity마다 publication batch를 쪼개지 않는다. D1 batch의 transaction rollback을 이용하므로 R2의 다중 key transaction이 필요하지 않다.
- 성공 후 D1의 전체 ID/행/record bytes/refs/null pointers/삭제 상태/집계/FK, queue와 outbox 0, R2 전 파일 bytes/SHA를 다시 확인한다.
- 재시도는 **같은 source/snapshot/backup/승인/target**만 사용한다. 이미 published이면 전체 metadata와 objects가 일치할 때만 read-only resumed 성공이다. 앱에서 데이터가 변경된 뒤에는 resume가 실패하는 것이 정상이다.
- **어떤 예외에도 R2 staged 객체를 자동 삭제하지 않는다.** D1 commit 성공 후 응답만 유실되었을 수 있다. 기존 local importer의 무조건 catch-delete 패턴을 운영에 쓰면 live metadata가 참조하는 파일을 지울 수 있다. 본 도구는 cleanup/delete API 자체를 호출하지 않는다.
- 중단 후에는 app writer를 멈춘 채 상태를 읽어 판정한다. 다른 run으로 재시도하거나 임의로 staging을 덮어쓰지 않는다. GC/rollback은 별도 승인 절차이며 이 도구에는 자동 cleanup/rollback이 없다.

## 실제 완료 판정 — DB 성공만으로 완료 선언 금지

- [ ] approved snapshot/backup의 manifest SHA와 source counts를 기록했다.
- [ ] source와 backup은 그대로 보존되어 있다.
- [ ] D1 items/reports/provider analyses/feedback의 전체 ID·값·참조가 일치하고 jobs/outbox는 0이다.
- [ ] R2 **전 object** GET bytes/SHA가 source manifest와 일치한다.
- [ ] 별도 승인 배포로 `WORKBOOKS_JSON`가 반영되었고 upload/items UI에서 전체 문제집 ID·정렬 순서가 원본과 같다.
- [ ] 선택한 개인정보 정책을 익명/승인 사용자 각각 실제 요청으로 확인했다.
- [ ] `GET /api/items`의 전체 ID set과 상태/workbook/current embedded analysis가 일치한다.
- [ ] 모든 item에 `GET /api/items/<id>`, `GET /api/items/<id>/image`, `GET /api/items/<id>/analyses`를 수행한다. image bytes/SHA, provider 목록·analysis/meta/flags를 원본과 비교한다. 분석파일이 없고 record 내 분석만 있는 경우도 구분한다.
- [ ] `GET /api/reports`의 전체 ID set 및 모든 `GET /api/reports/<id>`의 item_ids/상태/markdown/meta가 원본과 일치한다.
- [ ] 확인용 GET 외 업로드/재분석/retry/report 생성/LLM 호출은 하지 않았다.
- [ ] metadata와 API 검증을 마친 뒤에만 유지보수 해제를 별도 승인한다.

API/실제 공개범위/운영 quota/실제 remote binding 검증은 **아직 미실행**이다. 로컬 검증은 운영 완료가 아니다.

## 운영 apply 완료 기록 (2026-10-18)

사용자 승인(삭제·public-approved·배포) 하에 실행했다.

- 사전 원본 정리: 사고 보고서 4개 삭제, done 보고서 `20260919-221106-rep-sgcz`에서 없는 item `20260919-162612-99cx` 참조 제거(백업 `~/ymath-cutover/source-fix-backup/`).
- manifest SHA `a08b0f91…54db75c`, counts items 69 / reports 1 / objects 221 / analyses 16 / feedback 72 / workbooks 17.
- target: D1 `math`(ba4ef0c4), R2 `math`(구 `math-private` 삭제 후 신규 생성). apply `published: true`.
- 완료 판정: D1 entities 70(=69+report), jobs/outbox/inngest 0. R2 221객체. 라이브 API 전수 대조 — 69개 item 상세/이미지 bytes·SHA-256/분석 provider·내용 전부 원본과 일치, 보고서 markdown까지 일치. `WORKBOOKS_JSON` var로 문제집 17개 순서 동일. 익명 요청 200 확인(public-approved).
- runner: `user/runner-cloudflare.env`(RUNNER_URL/RUNNER_TOKEN, 0600)로 기동, bearer claim 200 확인. 원본 `user/data`는 read-only 보존.

## 로컬 검증 근거

신규 테스트 **13개 통과**. 실제 Wrangler local D1/R2(`remoteBindings:false`, 별도 합성 config, `envFiles:[]`)에서 실행했다.

- 69 item + 1 report + provider 분석 69개 fixture: object 277개 SHA 검증, staging 17 batch(최대 25문장), publication 6문장.
- commit 완료 후 응답 유실: live 객체 5개 보존, delete 0회, 같은 run 재개 성공.
- staging 중 writer 경쟁: empty CHECK가 전체 publication rollback.
- entities INSERT 이후 FK 실패: entities/guard도 rollback, R2 staging 보존.
- staging 중 source generating 재활성화: publication 차단.
- R2 부분 업로드 재개, 충돌 bytes 거부/덮어쓰기 없음.
- 승인 없는 CLI가 원격 session을 열지 않음, source active report/예상 밖 파일/symlink/tamper/경로 alias 거부.

참고: 기존 local helper의 SQL 초기화는 `sql.split(';')` 때문에 SQL comment 안의 세미콜론/주석-only 조각에서 실패할 수 있다. 이번 integration fixture는 comments를 제거한 실제 schema SQL을 local D1에 적용했다. 기존 local helper는 변경하지 않았다.

Cloudflare batch transaction 계약: <https://developers.cloudflare.com/d1/worker-api/d1-database/#batch>.
