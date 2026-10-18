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
npx wrangler r2 bucket create ymath-private
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

## 4. 빌드 + 배포

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

## 6. Node 실행기 기동 (Mac Studio)

```sh
RUNNER_URL=https://xcv.kr/math \
RUNNER_TOKEN=<3번과 동일한 값> \
npm run runner:cloudflare        # src/lib/server/cloudflare/runner.ts 폴링
```

실행기 기동 후 업로드한 항목이 `queued → ocr → analyzing → done` 으로 바뀌는지 목록 새로고침에서 확인.
주의: 실행기는 실제 OCR/LLM을 호출한다 — `user/config/providers.json`의 실제 provider 설정을 사용하므로, 원하지 않으면 기동 전에 해당 설정을 확인할 것.

## 7. 정상 확인 후 Zero Trust 적용 (사용자 계획 단계)

- CF 대시보드 → Zero Trust → Access → Applications → `xcv.kr` 존에 `/math*` 경로 앱 생성
- **`/math/api/runner/*` 는 별도 정책**: 브라우저 로그인 정책만 걸면 Node 실행기가 막힌다.
  Access service token(Zero Trust → Access controls → Service credentials)을 만들어 실행기 정책으로 허용하고,
  실행기 요청에 `CF-Access-Client-ID` / `CF-Access-Client-Secret` 헤더를 추가하거나, 실행기 경로만 Bypass/Service-Auth 정책으로 두고 앱의 `RUNNER_TOKEN` bearer를 1차 방어로 유지
- 참고: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/

## 롤백

- 코드 롤백: `npx wrangler rollback` (직전 배포로 복구)
- 데이터 롤백: 이관 전 원본은 기존 Node 로컬 데이터에 그대로 있으므로, 운영 데이터를 넣기 전까지는 배포 해제(`wrangler delete`)만으로 완전 복구. 운영 데이터 이관은 별도 단계 — `scripts/cloudflare-migrate.mjs` dry-run부터 (docs/cloudflare-migration.md)
