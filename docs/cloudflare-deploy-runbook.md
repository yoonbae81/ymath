# ymath Cloudflare 배포 런북 (xcv.kr/math, Workers Routes)

> 로컬 검증은 전부 통과된 상태. 아래는 실계정 리소스 생성·배포 절차로, **사용자가 직접 실행**하는 단계다.
> 사전 조건: `npx wrangler whoami` 로그인 유효, `xcv.kr` 존이 같은 CF 계정에 프록시(주황 구름) 상태.

## 0. 사전 확인

```sh
npx wrangler whoami          # 계정/OAuth 유효 확인
npm test                     # 로컬 게이트 최종 확인 (340 tests)
TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch npm run build   # Worker 번들 + 네이티브 분리 스캔
```

## 1. 실계정 리소스 생성 (기존 drop5-files 건드리지 않음)

```sh
npx wrangler d1 create ymath            # → 출력된 database_id 복사
# S3 bucket is external at https://s3.xcv.kr (ymath). No local R2 bucket creation needed.
```

`wrangler.toml`의 `database_id = "local-only"`를 위에서 복사한 실제 ID로 교체.

## 2. D1 스키마 적용 (remote)

```sh
npx wrangler d1 migrations apply ymath --remote   # 0001~0003 적용
npx wrangler d1 execute ymath --remote --command "SELECT name FROM d1_migrations" # 확인(로컬 ledger와 별개)
```

## 3. 실행기 토큰 시크릿 등록

```sh
npx wrangler secret put RUNNER_TOKEN    # 강한 랜덤 값 입력 (openssl rand -hex 32)
```

Worker 와 Mac Connect Runner 는 공통 `RUNNER_TOKEN` 하나만 사용한다.
데이터 저장소는 `s3.xcv.kr`의 MinIO 버킷 `ymath`이며 R2 바인딩은 사용하지 않는다.

## 3.5 Connect item 파이프라인 (baton Connect app 소유)

- `ITEM_ANALYSIS_BACKEND=baton` 일 때 item 파이프라인(업로드 접수 → Inngest 이벤트 →
  baton Connect Runner 실행 → 콜백 확정)의 소유자는 **baton 레포의 Connect app**
  (`baton/src/ymath/connect-item.ts`, function id `ymath-item-pipeline`)이다. Worker 는
  narrow 한 인증 콜백(`RUNNER_TOKEN` bearer)만 제공한다.
- 레거시 리포트(`/api/inngest`, hosted slice-app 의존)는 여전히 남아 있으며 별도 백엔드다 —
  item 파이프라인과 혼동하지 않는다.
- Connect Runner 콜백 베이스 URL 은 `/math/api` 까지 포함해야 한다
  (예: `https://xcv.kr/math/api` → 콜백 경로 `${callbacksBase}/runner/items/<action>`).
- Worker 와 Mac Connect Runner 의 콜백 인증 env 는 `RUNNER_TOKEN` 하나다.
- 커밋 영수증: Runner commit 콜백은 finalization 이전에 live lease fence 아래 불변 영수증을
  D1 jobs.payload(`connect_commit`)에 묶고, done 트랜잭션이 이를 확정한다. 응답 유실 replay 는
  삭제된 S3 staging 없이 이 영수증만으로 판정하며 다른 token/result/hash 는 409 로 거부한다.
- 배포/전환 시: 이 파이프라인은 Worker 와 Mac Connect Runner 가 **하나의 shared Inngest
  drain** 을 공유하므로, 롤아웃은 coordinated shared drain + 양쪽 재시작이 필요하다.
  이 런북은 배포·재시작을 수행하지 않는다(실행은 운영 담당).

## 4. 빌드 + 배포

> **2026-10-21 바인딩·env rename**: Worker S3 바인딩과 baton Runner 쪽 ymath env 모두
> `YMATH_S3_*` → `S3_*`로 변경되었다. Runner env 파일은 `~/.config/baton/ymath/secrets.env`에서
> `S3_*`, `WORKER_CALLBACKS_URL`, `INNGEST_EVENT_KEY_YMATH`를 제공한다. `INNGEST_EVENT_KEY_YMATH`만
> 접미사를 유지한다 — SHS가 공용 `INNGEST_EVENT_KEY`를 먼저 읽으므로 prefix를 지우면 충돌한다.
> LLM credential은 앱 파일에 없다 — 공통 `secrets.env`의 `OMLX_*`(Qwen)·`ZAI_*`(GLM)만 참조한다.

```sh
TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch npm run build
npx wrangler deploy
```

`wrangler.toml`에 이미 `routes = [{ pattern = "xcv.kr/math*", zone_name = "xcv.kr" }]`, `workers_dev = false` 반영됨.
배포 후 `https://xcv.kr/math` 가 Worker로 라우팅된다. 첫 배포 시 CF가 존에 라우트를 자동 등록한다.

## 5. 배포 후 스모크 (익명 앱 — URL 아는 사람은 전부 읽기/쓰기 가능)

```sh
curl -s https://xcv.kr/math/api/items | head -c 200          # {"items":[]} 기대
curl -s -o /dev/null -w '%{http_code}\n' https://xcv.kr/math/login   # 410 기대
```

브라우저에서 `https://xcv.kr/math` → 사진 업로드 1건 → "대기 중" 표시 확인.

## 6. Batron Runner 기동 (Mac Studio)

Runner 설정 파일 생성 또는 업데이트:
```sh
cat ~/.config/baton/secrets.env
```
S3 / LLM 키는 앱별·공통 secrets 파일로 분리되어 있다:
```sh
cat ~/.config/baton/secrets.env        # 공통: INNGEST_SIGNING_KEY, RUNNER_TOKEN,
                                       #       OMLX_API_KEY/OMLX_BASE_URL/OMLX_MODEL (Qwen),
                                       #       ZAI_API_KEY/ZAI_BASE_URL/ZAI_MODEL (GLM)
cat ~/.config/baton/ymath/secrets.env  # ymath: S3_ENDPOINT, S3_BUCKET,
                                       #        S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
                                       #        INNGEST_EVENT_KEY_YMATH, WORKER_CALLBACKS_URL
```

(시크릿 값은 런북에서 제거했다. 실제 값은 로컬 secrets 파일/`wrangler secret` 으로만 관리한다.)
Runner 실행 (baton runner가 ymath app을 포함):
```sh
cd /Users/y/Github/baton
npm run build  # sitter 서비스 파일 tidy
# runner.cloud.json에 apps.ymath 추가 완료
cat /Users/y/Github/baton/config/runner.cloud.json
```

## 7. 정상 확인 후 Zero Trust 적용 (사용자 계획 단계)

- CF 대시보드 → Zero Trust → Access → Applications → `xcv.kr` 존에 `/math*` 경로 앱 생성
- **`/math/api/runner/*` 는 별도 정책**: 브라우저 로그인 정책만 걸면 Node 실행기가 막힌다.
  Access service token(Zero Trust → Access controls → Service credentials)을 만들어 실행기 정책으로 허용하고,
  실행기 요청에 `CF-Access-Client-ID` / `CF-Access-Client-Secret` 헤더를 추가하거나, 실행기 경로만 Bypass/Service-Auth 정책으로 두고 앱의 `RUNNER_TOKEN` bearer를 1차 방어로 유지
- 참고: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/

## 롤백

- 코드 롤백: `npx wrangler rollback` (직전 배포로 복구)
- 데이터 롤백: 이관 전 원본은 기존 Node 로컬 데이터에 그대로 있으므로, 운영 데이터를 넣기 전까지는 배포 해제(`wrangler delete`)만으로 완전 복구. 운영 데이터 이관은 별도 단계 — `scripts/cloudflare-migrate.mjs` dry-run부터 (docs/cloudflare-migration.md)