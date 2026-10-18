# Cloudflare Workers + 자체 MinIO 이전 검토

## 상태와 결론

## 최신 인증 요구

이전 검토의 로그인·guest·공유 링크·Access 인증 제안은 superseded 됐다. 현재 요구는 익명 가족 CRUD이며, 외부 공개 배포 시 누구나 문제/사진/분석/피드백 데이터를 읽고 변경할 수 있음을 사용자에게 알린다. 앱은 PASSWORD/SESSION_SECRET/Access 설정을 요구하지 않는다. Runner API만 별도 bearer token으로 보호한다. Cloudflare Zero Trust는 별도의 향후 배포 시험 후 사용자가 구성한다.


- 검토 기준: main `ed49965`. 구현·운영 배포 승인이 아니라 구조 변경에 대한 사전 검토다.
- 레포 및 상위 경로에서 AGENTS.md/CLAUDE.md를 찾지 못했다. 현재 README, vite.config.ts와 실제 소스를 기준으로 검토했다.
- `ops/lead-clean`은 로컬·원격 추적 브랜치 목록에 없고 `git ls-remote --heads origin ops/lead-clean`도 빈 결과다. 해당 브랜치의 미병합 작업은 확인할 수 없으며, 다른 브랜치를 대신 병합하지 않았다.
- **방향은 타당하나 adapter와 저장소만 바꾸는 이전은 아니다. 웹/API와 장시간 분석 실행기를 분리해야 한다.**
- 권장 목표안: Workers = 웹·인증·API, MinIO = 이미지·OCR·분석 산출물, 기존 호스트의 Node 실행기 = 이미지 정규화·OCR·LLM·보고서 작업. 가변 메타데이터/작업 상태 저장은 별도 결정이 필요하다.
- 디자인(design)·개발(dev) 독립 정적 검토를 반영했다. 실제 Workers/MinIO 실행 검증은 아직 하지 않았다. 구현 난이도와 사용자 흐름 보존 기준의 교차 검토이지 운영 이전 승인이나 런타임 호환성 증명은 아니다.

## 코드 근거: 어디가 바뀌는가

- `vite.config.ts:2,13`: 현재 adapter-node, `.build` Node 서버. SvelteKit의 adapter-cloudflare로 웹을 옮기는 경로는 공식 지원된다.[1]
- `src/lib/server/store.ts:35-83`: 파일 rename 기반 저장과 동기 read-modify-write, 목록 디렉터리 전수 읽기. 단일 프로세스에서만 경합이 없다는 전제가 주석으로 명시돼 있다. MinIO HTTP I/O로 바꾸면 호출자까지 async 전환과 동시성 제어가 필요하다.
- `src/lib/server/report.ts:37-93`: 보고서도 별도의 로컬 파일 저장 계층이다. 문제 store만 바꿔서는 완료되지 않는다.
- `src/lib/server/queue.ts:20-55,146-157` 및 `src/hooks.server.ts:13-17`: 프로세스 내 provider별 레인·기동 복구·10분 재시도 타이머. Workers isolate의 전역 Map이나 setTimeout으로 대체하면 내구성이 없다.
- `src/lib/server/config.ts:63-66`: OCR 기본 타임아웃 2분, 분석 15분. HTTP 응답 후 waitUntil은 최대 30초 연장일 뿐이므로 내구성 있는 분석 큐 대체 수단이 아니다. 네트워크 대기 시간과 CPU 시간은 구별해야 한다.[3]
- `src/lib/server/image.ts:53-79`: sharp로 방향 보정·1600px 축소·그레이스케일 JPEG. 이 native 모듈은 일반 Workers에 그대로 싣는 것으로 가정하지 않는다. 프로브에서는 기존 Node 실행기에 둔다.
- `src/lib/server/exec.ts:1,19-25`, `src/lib/server/llm.ts`: codex/agy CLI와 child_process spawn 의존. 일반 Workers에서 로컬 실행파일을 돌리는 구조는 유지할 수 없다.[2] Cloudflare Containers 등 별도 런타임은 이번 권장 범위 밖이다.
- `src/lib/server/ocr.ts:10-23`: OCR은 HTTP 호출이지만 현재 파일을 읽고 내부 oMLX 설정을 쓴다. 클라우드에서 사설 IP로 바로 접근할 수 있다고 가정하지 않는다. 실행기가 내부망에서 호출하면 이 경계를 보존한다.
- 이전 Node 앱에는 파일 세션 키, 로그인 제한, LAN 신뢰가 있었다. 최신 요구로 해당 인증 구현은 제거됐으며 브라우저 app mutation에는 CSRF 헤더만 적용한다. Runner bearer token은 별도 보호 대상으로 남는다.
- `src/routes/api/upload/+server.ts:16-48`: 25MiB 제한·서버 이미지 검증·파일 생성 후 큐 등록. raw 업로드를 MinIO에 임시 보관한다면 정규화 완료 전에는 기존 image.jpg로 공개하지 않고, 실패/중단된 임시 객체 정리 정책을 추가한다.
- `/api/items/[id]/image`는 same-origin API로 비공개 R2 객체를 읽어 전달한다. 앱 가족 인증은 없으므로 URL에 접근할 수 있는 사용자는 사진을 조회할 수 있다. 브라우저 직결은 presigned URL 유출·만료·CORS·CSP 변경이 추가된다.

### 결합도 조사

`src/**/*.{ts,svelte}` 중 `.test.`/`.spec.` 파일을 제외해 정규식으로 집계했다. 중복 집합이므로 서로 합산하지 않는다.

- node:fs(/promises 포함) import: 12파일 / 12회.
- node:child_process 또는 spawn 호출: 1파일 / 2회.
- sharp import: 1파일 / 1회.
- readRecord/updateRecord/listRecords/itemDir/dataDir 호출: 16파일 / 46회.
- 의미: native/프로세스 의존을 떼는 지점은 좁지만, 파일 경로와 동기 저장을 API 전반에서 걷어내는 작업은 더 넓다. 포트가 이미 완전히 추상화된 레포는 아니다.

## 선택지와 권장안

### 런타임

1. **Workers 웹/API + 로컬 Node 실행기: 권장 목표.** 웹 배포를 분리하면서 sharp, 내부 OCR/oMLX, codex/agy를 보존한다. 내구성 있는 job/lease/retry와 서비스 간 인증은 새로 필요하다.
2. **Workers 프런트/프록시 + 기존 Node SSR/API + MinIO: dev 검토의 최소 변경 권장 단계.** 메타데이터까지 자체 운영을 유지하기 쉽지만 Node API가 내려가면 동적 화면/API도 여전히 영향을 받는다. '웹 전체가 독립'이라고 부르면 안 된다. origin 직접 접근을 차단하고 전달 헤더를 정제한다. 이 단계에서는 Workers가 MinIO에 직접 접근할 필요 없이 Node origin이 S3를 사용할 수 있다.
3. 전체를 일반 Workers로: 현 기능 동등성 기준 비권장. CLI 제거 또는 다른 실행 환경 도입, 이미지 처리 대체가 수반된다.

### 데이터: 객체와 가변 상태를 구분

1. **MinIO 객체 + 트랜잭션 가능한 메타데이터 저장소: 권장.** 이미지, OCR, provider별 분석/보고서 본문은 MinIO. 목록 필터, 피드백, 즐겨찾기, 현재 분석 참조, job/lease는 DB. D1은 후보지만 사용자가 요청한 것은 MinIO이므로 도입 확정으로 간주하지 않는다.
2. 자체 운영을 엄격히 유지하려면 기존 Node API가 메타데이터를 소유하는 중간 단계를 우선 비교한다. 단일 Node 쓰기 주체를 유지하고 메타데이터·내구 큐에 Node 측 SQLite를 후보로 검토한다(도입 확정 아님). 엣지 API까지 독립시키려면 별도 자체 운영 DB/API 연결 설계가 필요하다.
3. MinIO에 record.json까지 전부 저장: 가능성은 있으나 기본 권장하지 않는다. 모든 변경에 ETag 기반 조건부 쓰기와 충돌 재시도, 목록 인덱스, 작업 claim/lease 설계가 필요하다. 단순 GET→PUT은 분석 완료와 피드백의 동시 갱신을 덮어쓸 수 있다. AIStor 문서의 지원을 사용자의 MinIO 버전에 그대로 적용할 수 없으며 If-Match/If-None-Match를 실서버에서 검증해야 한다.[5]

MinIO는 R2가 아니므로 R2 binding에 사용자 endpoint를 넣는 방식이 아니다. S3 endpoint/bucket/region/addressing 방식과 SigV4 호환 클라이언트를 구성한다. 목표안의 Worker 직접 접근에는 Worker에서 닿는 HTTPS 경로가 필요하며 버킷 공개 권한은 필요하지 않다. 최소 프록시 단계에서는 Node→MinIO 접근만 필요하다. Cloudflare Tunnel을 쓴다면 경로·Host·서명 헤더 보존을 시험한다. 앱 Access 정책은 이번 변경에 포함하지 않는다. MinIO 콘솔 공개는 필요 없다.

### Workers KV 활용 검토 — 후속 제안

**활용 가능하다. 다만 일반 Workers KV는 읽기 위주 설정·캐시용으로 두고, 가변 record/job의 유일한 원본 저장소로 쓰지 않는 것을 권장한다.** 아래는 공식 문서에 근거한 후속 검토이며, 신규 구현·실서버 프로브 또는 추가 design/dev 승인 결과는 아니다.

- 적합: 문제집 목록·교육과정·프롬프트의 버전 고정 사본, 변경 빈도가 낮은 비보안 설정, 다시 만들 수 있는 통계/완료 결과 캐시. 정적 설정은 번들만으로 충분하면 KV를 추가하지 않아도 된다. 프롬프트 버전을 job에 고정해 실행기와 웹의 버전 혼선을 막는다.
- 부적합한 단독 용도: 현재 분석 참조, 피드백·즐겨찾기·읽음의 원본, 접수 중복 방지, job claim/lease, 정확한 공개 API 남용 제한, 즉시 반영돼야 하는 권한 변경/삭제 판정.
- 근거: 일반 KV는 eventual consistency이며 다른 위치에서 변경/신규 키가 보이는 데 60초 이상 걸릴 수 있다. 같은 위치에서도 즉시 가시성을 보장하지 않는다. 없는 키라는 조회 결과도 캐시된다.[6] 따라서 접수 직후 목록에서 항목이 사라지거나 완료가 계속 대기로 보일 수 있다.
- 동일 키 동시 쓰기는 last-write-wins이며 원자적 read-modify-write/트랜잭션용이 아니다. 동일 키 쓰기 제한은 초당 1회라 빠른 queued→ocr→analyzing 전이도 같은 record 키를 갱신하면 제한에 걸릴 수 있다.[7] 사용자가 적어도 경합 자체가 없어지지는 않는다.
- Durable Object 한 곳으로 쓰기를 직렬화해도 다른 Workers가 KV에서 읽으면 KV의 오래된 읽기 특성은 남는다. 즉시 최신이어야 하는 읽기도 원본 상태 저장소로 보내야 한다.
- 조정된 목표 후보: **Workers 웹/API + D1 또는 SQLite-backed Durable Object(가변 metadata/job) + MinIO(이미지·분석 산출물) + 기존 Node 분석기**. KV는 필요할 때 읽기 캐시/버전 설정으로만 추가한다. D1과 DO를 모두 도입하는 것이 전제가 아니며, 필터·집계 중심이면 D1, 단일 가정 단위 상태 직렬화 중심이면 DO를 비교한다. job 재시도/알림 실행과 상태 저장은 별도 책임이다.
- 캐시 보안: 앱 응답은 가족 인증이 없으므로 공유 캐시에서 공개됨을 전제로 다룬다. immutable result ID/version으로 캐시하고 삭제된 항목을 다시 제공하지 않는다. KV 장애/미전파는 원본 fallback으로 처리하며 성공 응답한 쓰기를 잃지 않아야 한다. runner bearer token은 KV가 아니라 Worker Secret 관리 경계다.

KV 채택 시 추가 acceptance criteria:

- KV mock에서 이전 값·null·오류를 각각 반환시켜도 접수 후 동일 ID 상세 조회, 최신 결과/피드백 확인, 중복 요청 처리는 원본 저장소 기준으로 정확해야 한다.
- 동일 item의 상태 갱신·피드백·즐겨찾기를 병렬 실행해 성공한 쓰기의 유실 0건. KV write 실패는 cache 미갱신으로 격리하고 원본 commit을 덮어쓰거나 사용자에게 실패로 오보하지 않는다.
- 삭제 상태를 원본에서 변경한 뒤 KV에 이전 데이터를 강제로 남겨도 삭제된 데이터를 제공하지 않아야 한다. 버전 고정 프롬프트 캐시 miss는 다른 버전으로 조용히 대체하지 않는다.

추가 근거:

6. Workers KV consistency: https://developers.cloudflare.com/kv/concepts/how-kv-works/index.md
7. Workers KV put/concurrent writes/동일 키 초당 1회 제한: https://developers.cloudflare.com/kv/api/write-key-value-pairs/
8. SQLite-backed Durable Objects storage: https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/

### 제안 데이터 흐름

```text
폰 → Workers 웹/인증/API → MinIO 임시 업로드 + 내구성 있는 job 상태
                         ↓
                 로컬 Node 실행기가 claim
                 sharp → 내부 OCR/oMLX 또는 기존 CLI
                         ↓
                 MinIO 결과 저장 → 현재 결과 참조/상태 commit
                         ↓
폰 ← Workers 인가 후 결과/이미지 제공
```

- 작업 실행은 at-least-once를 전제로 한다. job ID·generation·lease/fencing으로 재실행을 허용하되 결과 반영은 멱등(idempotent)하게 만든다.
- 분석 결과 객체를 먼저 저장하고 검증한 뒤 현재 분석 참조를 commit한다. 중간 실패는 재시도/고아 객체 정리로 복구한다. 객체 PUT과 DB commit이 하나의 트랜잭션이라고 가정하지 않는다.
- 삭제와 재분석이 경합할 때 오래된 실행 결과가 항목을 부활시키지 않도록 generation/tombstone 확인이 필요하다. 보고서도 동일한 작업 내구성 범위에 포함한다.
- 실행기는 outbound polling으로 작업을 가져오는 방식을 우선 검토한다. Workers가 내부 LLM/CLI 호스트에 인바운드로 직접 붙는 터널을 기본 요구하지 않는다.

## 얻는 것 / 얻지 못하는 것

- 웹 배포와 분석 호스트의 수명 주기를 분리하고, 데이터 파일을 앱 설치 경로에서 분리할 수 있다.
- GPU 추론 속도가 빨라지는 변경은 아니다. MinIO가 집에 있으면 집 정전/회선 장애는 여전히 데이터 접근 장애다.
- 메타데이터도 자체 호스트에 두면 동적 화면까지 집 서버 의존이 남는다. D1에 둬도 MinIO 이미지와 로컬 분석은 별도 장애 지점이다.
- 객체 스토리지 도입 자체가 백업은 아니다. 별도 장애 영역의 백업과 복구 시험이 필요하다.
- 비용 절감·속도 향상은 아직 측정하지 않았다. Worker 플랜, MinIO 상향 회선, HTTP 호출량을 프로브에서 측정한다. Free의 CPU 10ms/요청 및 128MB 메모리 한도는 SSR/대용량 버퍼링에 주의해야 한다.[3]

## 무변경 범위

- 정답을 발설하지 않는 스키마·guardrail, 교육과정 taxonomy, 프롬프트 의미 및 prompt_version 추적.
- 문제집 선택→촬영→업로드, 목록·기간/영역 필터, provider별 분석 탭, 피드백·즐겨찾기·읽음, 영역 보고서의 의미.
- OCR/oMLX 및 외부 LLM의 모델/주소/키는 임의 변경하지 않는다. 필요 키는 해당 실행 경계에만 제공하며 MinIO/LLM 장기 키를 브라우저에 보내지 않는다.
- 앱 로그인·guest·공유 링크·LAN 인증은 사용하지 않는다. 공개 API가 사진과 가족 데이터를 제공하므로 배포 범위를 명시한다. Runner API는 별도 bearer 인증을 유지한다.
- URL base `/math`와 기존 ID를 1차 유지한다. 앱 인증 쿠키를 요구하지 않는다.

## D1 + R2 비용 재검토 — 자체 MinIO가 비용 때문에 필요한가

**현재 로컬 데이터와 가족 사용 가정에서는 D1 + R2 Standard의 추가 사용료가 $0 범위에 머무를 가능성이 매우 높다. 비용 절약만을 이유로 MinIO 운영·네트워크 경계를 추가할 필요는 약하다.** 사용자 후속 제안에 따라 Workers + D1 + R2 Standard + 기존 Node 분석기를 우선 비교하는 것으로 권고를 보완한다. 자체 보관/통제권이 목적이면 MinIO는 여전히 유효하다. 이 변경안은 공식 가격 및 로컬 파일 측정에 근거한 후속 제안이며 추가 dev/design 검토·구현 승인이나 청구액 보증은 아니다.

### 확인된 무료 범위

- D1 Workers Free: 계정 전체 저장 5GB, DB 하나당 최대 500MB, 읽기 5,000,000행/일, 쓰기 100,000행/일. 초과하면 자동 유료 전환이 아니라 쿼리/쓰기 제한이다. 인덱스·쿼리가 스캔한 행도 사용량에 포함된다.
- R2 Standard: 월 10GB-month, Class A(PUT/LIST 등) 1,000,000회, Class B(GET/HEAD 등) 10,000,000회 무료. 인터넷 egress 무료. Infrequent Access는 이번 무료 가정에서 제외한다.
- Workers 자체는 별도다. Free는 100,000요청/일·CPU 10ms/호출이며, Paid를 선택하면 계정 최소 $5/월이 발생한다. D1/R2 추가 사용료 $0와 서비스 전체 청구 $0는 다르다.
- 기존 Cloudflare 계정의 타 프로젝트 소비량·현재 플랜·실제 운영 트래픽은 확인하지 않았다. R2 무료 제공량은 초과 시 과금될 수 있는 무료 구간이지 강제 지출 한도가 아니다.

### 실제 로컬 측정 및 예시 계산

Python으로 user/data/items 및 user/data/reports의 파일만 집계했다. 세션 키·설정 키는 포함하지 않는다.

- 항목 69개, 이미지 69개. 이미지 합계 10,110,546 bytes.
- 문제/보고서 디렉터리 전체 221파일, 10,547,367 bytes(약 10.55MB, 십진 표기). record.json 합계 308,437 bytes. 후자는 D1 이관 후 DB/인덱스 크기와 같다는 뜻은 아니다.
- 이미지당 150KB 가정: 10,000개도 이미지 1.5GB. OCR/JSON/버전/임시 업로드/백업은 별도.
- 예시 부하(실제 트래픽 아님): 하루 100문제 × 문제당 4 PUT × 30일 = 12,000 Class A/월. 실제 설계의 LIST·멀티파트·재시도 등은 추가 집계한다.
- 예시 이미지 조회 하루 1,000 GET × 30일 = 30,000 Class B/월.
- 예시 D1에서 현 69행 전수 조회 하루 1,000회 = 69,000행 읽기/일. 실제 조회·조인·통계·폴링은 meta.rows_read/rows_written으로 측정한다.

### 무료 범위 검증 기준

- 프로브에서 D1 실제 DB 크기·rows_read/rows_written, R2 저장량·Class A/B, Workers 요청·CPU를 기록하고 계정의 기존 사용량을 더해 무료/포함량과 비교한다.
- raw 원본은 정규화 후 정리하고 불필요한 LIST/HEAD·상시 폴링·재시도 루프를 피한다. R2 bucket은 비공개로 유지하고 인증 없는 이미지 대량 조회를 허용하지 않는다.
- 예산/사용량 알림을 구성하되 알림은 강제 과금 차단이 아님을 명시한다. Workers Paid가 필요하면 최소 $5/월을 별도 승인 항목으로 남긴다.

가격 근거:
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/workers/platform/pricing/

## 규모와 한계

- 이 개발 체크아웃의 로컬 데이터: record 69개, report 1개, image.jpg 69개, 이미지 합계 10,110,546 bytes. 운영 전체 데이터라고 단정하지 않는다.
- README의 이미지 약 150KB/개를 십진 가정하면 1,000개 = 150,000,000 bytes, 10,000개 = 1,500,000,000 bytes. OCR/JSON/버전/백업은 별도다. Python 계산 결과이며 용량 예약값이 아니다.
- MinIO 용량보다 목록 전수 조회가 먼저 문제가 될 수 있다. 매 목록 요청마다 N개 JSON GET을 하는 설계는 피한다. 프로브는 현 스냅샷과 1,000개 fixture 규모로 목록 호출 수·p50/p95를 기록한다.
- 작은 규모 MinIO-only 안도 승인된 p95/호출량 예산을 넘거나 동시 갱신 복구 기준을 못 맞추면 채택 중단하고 인덱스/트랜잭션 저장소를 도입한다. 근거 없는 최대 항목 수·성능 보장은 하지 않는다.

## 프로브와 완료 기준(criteria)

아래는 향후 구현의 acceptance criteria이며 현재 통과 결과가 아니다. 먼저 별도 prefix/bucket의 샘플 1개로 끝까지 검증하고 기존 운영은 건드리지 않는다.

아래 P1–P3는 **Workers 웹/API 목표안** 기준이다. 최소 프록시 단계만 먼저 채택하면 직접 S3 접근·isolate 상태·웹 번들 분리 기준은 후속 단계로 명시적으로 넘기고, Worker→보호된 Node→MinIO E2E·원본 회귀·origin 접근 차단을 우선 게이트로 삼는다. 프록시 프로브 통과를 목표안 완료로 보고하지 않는다.

### P1 — 최소 수직 프로브

1. **Worker→실제 MinIO:** 배포한 시험 Worker에서 인증된 PUT/HEAD/GET/DELETE 성공. 원문과 GET의 SHA-256 일치. 무자격 접근 403, 다른 prefix 접근 거부. 키/서명/비밀번호가 응답·브라우저 번들·로그에 없어야 한다. endpoint/TLS/region/path-style 설정과 실제 MinIO 버전을 기록한다.
2. **사진 1개 끝까지:** 시험 환경의 `/math/upload`에서 문제집 선택·사진 업로드 후 상태가 정규화/대기→OCR→분석→done으로 관측되고 `/math/items`에서 저장 이미지·분석이 보인다. raw를 받는 새 단계는 기존 queued와 구분해 설명한다. 정규화 JPEG는 긴 변 1600px 이하, EXIF 방향 적용, raw 임시 객체는 최종 처리 후 정리된다. 분석 결과는 기존 schema/guardrail을 통과한다.
3. **브라우저 종료·실행기 재시작:** 접수된 작업 후 탭을 닫고 실행기를 중간 강제 종료해도 재기동/lease 만료 후 같은 job이 done 또는 설명 있는 failed에 도달한다. 무한 analyzing·중복 현재 결과·잃어버린 접수는 0건. provider별 직렬/서로 다른 provider 병렬 정책을 시험한다.
4. **동시성:** 같은 item에 분석 완료·피드백·즐겨찾기 갱신을 병렬 실행해 성공 응답한 변경의 유실 0건을 확인한다. 분석 중 피드백은 현행 409 정책을 유지하고, 완료 후 재시도하면 해당 최신 분석에 연결돼야 한다. 피드백 검사와 저장 사이에 재분석이 시작돼도 다른 분석에 잘못 붙지 않도록 원자적 검증을 포함한다. 동일 job 중복 전달과 삭제→늦은 완료를 재현해 중복 반영/항목 부활 0건. MinIO-only 후보라면 stale ETag PUT이 실패하고 재조회/재적용되며 신규 객체 조건부 생성 경합에서 단 하나만 성공하는지 실측한다.
5. **장애 구분:** MinIO 연결 실패 시 성공/업로드 완료를 표시하지 않고 재시도 안내를 보인다. 실행기만 꺼졌고 업로드와 job은 영속화됐으면 '접수됨·분석기 대기'로 보인다. 같은 업로드 재전송은 같은 idempotency key로 중복 항목을 만들지 않는다. 손상 파일·25MiB 초과 입력은 분석 등록 없이 거절한다.
6. **권한:** 앱 화면 및 CRUD API는 익명 접근이며 공개 배포 시 누구나 데이터를 읽고 변경·삭제할 수 있다. 브라우저 mutation은 CSRF 헤더를 요구하고, runner claim/raw/result는 RUNNER_TOKEN bearer가 없으면 401이다. Zero Trust는 별도의 배포 시험 뒤 Cloudflare에서 구성한다.
7. **계측:** 업로드 접수·목록·이미지 p50/p95, Worker CPU/메모리 오류, 객체별 요청 수, OCR/분석 소요, 실패/재시도 횟수를 실제 실행 출력으로 남긴다. 1,000개 fixture 목록도 측정한다. 배포 전 성능 예산을 사용자와 확정하고 초과 시 P2로 진행하지 않는다.

### P2 — 저장/작업 계층 전환

8. `npm test`, `npm run check`, `npm run build` 통과. 별도 Workers 로컬/배포 통합 테스트를 추가해 실제 MinIO와 job runner를 검증한다. Node 단위 테스트 통과만으로 Workers 호환성 통과라고 하지 않는다. 웹 번들에 sharp/child_process/로컬 데이터 쓰기가 유입되지 않음을 빌드 출력으로 확인한다.
9. provider별 분석 비교·피드백 재분석 보존·즐겨찾기·읽음·기간 필터·영역 보고서를 회귀 시나리오로 실행한다. 오류 진단 내용의 품질 재평가가 아니라 동일 schema·guardrail·저장 의미 보존을 게이트로 한다.
10. 실행기·MinIO 각각 오프라인/복구, 영구 실패, 재시도 지연, 보고서 작업 중단을 시험한다. health/heartbeat와 마지막 오류가 `/math/status`에서 구별되고 키·내부 경로는 노출되지 않는다. 상태 폴링 실패를 빈 목록으로 바꾸지 않고 최종 갱신 시각·갱신 실패로 표시한다. 이미지 저장소 일시 장애는 503 등 일시 오류로, 없는 항목/삭제는 404로 구분하며 대체 UI와 재시도를 제공한다. 객체 다운로드 실패를 OCR 인식 실패로 취급해 불완전한 분석을 계속하지 않는다. 외부 API 429 지연 재시도도 별도로 검증한다.

### P3 — 이관·전환·롤백

11. 쓰기 중지 또는 변경 추적 경계를 명시한 snapshot으로 문제/보고서/분석/피드백을 이관한다. 원본 manifest와 대상의 건수·ID 집합·객체 SHA-256 전수 일치, 누락/깨진 참조 0건. multipart ETag를 무조건 MD5로 간주하지 않는다.
12. 서비스 쓰기 소유자는 전환 시점에 하나로 고정한다. 전환 이후 쓰기까지 복원하는 역이관/재생 절차를 시험해야 롤백 가능으로 판정한다. 원본 디렉터리만 보관한 것을 충분한 롤백으로 부르지 않는다. 별도 백업에서 샘플 항목과 보고서 복원까지 확인한다.

## 교차 검토 반영 사항

### dev: 구현 경계

- 최소 변경안은 Workers를 보호된 Node origin 앞에 두는 프록시 단계다. 목표안인 Workers SSR/API 독립과 혼동하지 않는다.
- `src/lib/server/analyze.ts:121-123`의 Ajv.compile은 런타임 코드 생성 호환성 검토 대상이다. 프로브에서는 Node 분석기에 남기며, Workers로 이동할 경우 standalone validator 등의 실제 빌드·실행 검증을 선행한다.
- `src/lib/server/report.ts:458-460`, `src/routes/api/reports/+server.ts:55-57`은 보고서 생성을 요청 안에서 기다린다. 목표안에서는 영속 job 접수→상태 조회로 바꾸고 호출 화면도 맞춘다.
- upload intent/outbox 또는 동등한 재조정 절차로 객체 저장→메타데이터→큐 등록 간 중간 실패를 복구한다. OCR 실패 fallback과 MinIO 파일 입출력 장애를 구분한다.

### design: 화면은 유지하고 실패 의미만 보강

- 메뉴·문제집 버튼→카메라 순서·카메라/앨범·마지막 문제집 기억·연속 촬영·배지·필터·모달은 재설계하지 않는다. 저장소/모델 선택을 업로드 화면에 추가하지 않는다(`src/routes/upload/+page.svelte`).
- 접수 실패는 파일/재선택 경로를 유지하고 재시도 가능하게 한다. 응답 유실에 따른 동일 요청 재전송만 멱등 처리하며, 의도적으로 같은 사진을 새로 올리는 행위는 콘텐츠 해시로 자동 차단하지 않는다.
- 저장된 분석 탭 전환은 조회만 수행하고 재분석 중 기존 결과를 보존한다. 피드백 통신 실패 시 입력을 유지한다. 실제 분석기가 꺼져 있으면 실행 중 스피너 대신 연결 대기·마지막 확인 시각을 표시한다.
- 이전 guest 분석목록 제한은 익명 가족 CRUD 요구로 제거됐다.
- 기존 주의점: 과거 분석 탭에서도 피드백은 최신 분석에 저장된다. '최신 분석에 대한 피드백' 안내/과거 탭 입력 숨김은 별도 소규모 개선으로 검토하고 저장 의미를 몰래 바꾸지 않는다.

## 남은 결정·실측

- MinIO가 이미지/산출물만을 의미하는지, metadata까지 전부 자체 운영해야 하는지. D1/DO/Queues 같은 Cloudflare 상태 서비스 추가를 허용하는지.
- 사용자 MinIO 버전·endpoint·TLS·bucket/policy·region·외부 도달 경로. 아직 접속 정보나 권한을 요청/사용하지 않았다.
- 실행기를 상시 가동할 호스트, job 상태 저장/claim 프로토콜, 복구 시간 목표와 대기 한계.
- Workers 요금제, 운영 항목 수·실제 회선 성능, 성능 예산, raw 임시 객체 TTL/버전/백업 보존 정책.
- design/dev 정적 검토는 반영 완료. 프로브 실측은 구현 승인 후 이 문서에 추가한다. 구현·배포·이관은 아직 하지 않았다.

## 외부 근거

1. SvelteKit Cloudflare adapter: https://svelte.dev/docs/kit/adapter-cloudflare
2. Workers Node.js compatibility: https://developers.cloudflare.com/workers/runtime-apis/nodejs/ — 지원 API와 non-functional stub 구분. compatibility date에 따라 동작이 달라지므로 프로브에서 고정한다.
3. Workers limits: https://developers.cloudflare.com/workers/platform/limits/ — CPU와 네트워크 대기 구분, 128MB, waitUntil 응답 후 최대 30초.
4. Workers fs: https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/ — /bundle 읽기전용, /tmp는 요청별 임시 메모리 파일시스템. 영구 user/data 대체 불가.
5. MinIO AIStor S3 compatibility: https://docs.min.io/aistor/developers/s3-api-compatibility — 조건부 쓰기 문서. 사용자 설치 버전의 보증은 아님.
