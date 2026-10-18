# Workers + D1 + R2 Standard 전환 완료 기준

## 승인 범위

사용자 승인: 로컬에서 D1·R2 기반 완전한 구현을 만들고 Wrangler fixtures로 검증한다. 브랜치 `feat/cloudflare-d1-r2`, 기준 `main ed49965`. 상위/레포 AGENTS.md·CLAUDE.md 미발견, ops/lead-clean 로컬/원격 미발견. 기존 검토는 docs/workers-minio-review.md 참고. 이 문서가 이번 구현 범위의 기준이다.

- 웹·조회/변경 API: Cloudflare Workers/SvelteKit adapter-cloudflare. 앱은 익명 가족 앱이며 인증·sharing 의미는 주장하지 않는다.
- 가변 메타데이터·내구 job: D1. 사진·OCR·분석 결과 객체: 비공개 R2 Standard.
- sharp·OCR·LLM/CLI·보고서 생성: 기존 호스트의 독립 Node 실행기. 인증된 outbound claim/result 프로토콜로 연결한다.
- KV/DO/Queues/Containers는 기본 도입하지 않는다. Workers Free부터 검증하며 Paid 전환, 타 프로젝트 설정 변경, 공개 bucket, 운영 원본 삭제는 이번 승인 범위 밖이다.
- 로컬 파일 실행 방식은 마이그레이션/롤백을 위해 유지하거나 동등한 복구 경로를 제공한다. 기존 user/data/config/providers.json 등 비밀은 커밋하지 않는다.

## 검증 게이트

1. `npm test`, `npm run check`, `npm run build`가 실제 통과한다. 별도 Node 실행기 빌드/시작 명령도 실제 실행한다. 웹 산출물에 sharp/child_process/로컬 영구 파일 쓰기 의존이 없어야 한다.
2. Wrangler 로컬 D1·R2를 사용하는 통합 smoke에서 업로드→영속 job→실행기 claim→실제 이미지 정규화→결과 반영→목록/상세/이미지 조회를 끝까지 실행한다. 외부 LLM 무단 호출 없이 fixture 분석을 사용할 경우 이를 명시하고 실제 LLM 검증과 구분한다.
3. 사진 포맷/매직바이트·25MiB 제한·50M pixel 제한·EXIF 보정·긴 변 1600px 이하·회색 JPEG 정책을 보존한다. raw 객체는 검증 전 공개하지 않고 처리 후 정리한다.
4. job claim은 원자적이며 lease·generation·재시도 시각이 영속화된다. 중복 전달/실행기 강제 중단 후 복구, provider 직렬 실행, stale result 거부, 삭제 후 늦은 결과로 항목 부활 0건을 테스트한다. 보고서도 동일 경계로 처리한다.
5. 업로드 idempotency key 재시도로 같은 ID 반환. 성공한 피드백/즐겨찾기/읽음 변경의 동시성 유실 0건. 분석 중 피드백 409 및 최신 분석 연결을 유지한다.
6. 최신 사용자 요구: 앱은 익명 가족 CRUD이며 guest/share 의미는 제공하지 않는다. 로그인·Access·LAN·쿠키 인증은 없고, 공개 배포 시 누구나 문제·사진·분석·피드백을 읽고 변경·삭제할 수 있다. 기존 로그인/로그아웃/공유 경로는 410, UI와 PASSWORD/SESSION_SECRET/Access 설정 의존은 제거한다. 브라우저 변경 요청에는 커스텀 CSRF 헤더를 요구하고 runner claim/raw/result/heartbeat/fail에는 RUNNER_TOKEN bearer가 계속 필수다. Zero Trust는 향후 배포 시험 후 사용자가 Cloudflare에서 구성한다.
7. provider별 분석 탭, 기존 분석 보존 재분석, taxonomy·schema·guardrail, 기간/영역 필터·집계·피드백·보고서 의미가 회귀 테스트로 보존된다.
8. MinIO는 이번 구현에서 필수 의존이 아니다. R2에는 binding을 쓰고 공개 CORS/presigned URL 기본 도입 없이 동일 origin 이미지 proxy API를 유지한다.
9. 상태 화면에서 저장 실패/실행기 연결 대기/분석 실패/갱신 실패를 구분한다. 통신 실패는 빈 목록으로 바꾸지 않고 재시도를 제공한다. 메인 화면 구조/문제집→카메라 흐름은 유지한다.
10. dry-run 가능한 이관 도구가 기존 ID·분석·피드백·보고서를 보존한다. 테스트 snapshot의 ID 집합/건수/객체 SHA-256 대조를 실제 실행한다. 적용 전 backup, 쓰기 소유자 전환 및 전환 후 쓰기를 포함하는 rollback 절차를 문서화한다.
11. 배포 전 계정/Workers 플랜·기존 사용량을 읽기 확인한다. D1 Free DB 500MB/계정 5GB·읽기 5M행/일·쓰기 100K행/일, R2 Standard 10GB-month·Class A 1M/월·B 10M/월, Workers Free 요청/CPU와 비교한다. 사용량 알림은 hard cap이 아님을 안내한다.
12. 실계정 resource 생성/배포/운영 이관을 수행하면 정확한 resource ID·배포 URL을 기록하고 읽기 조회와 익명 앱/bearer runner E2E로 확인한다. 인증·권한·플랜 확인이 막히면 배포 미완료로 보고하며 로컬 통과를 배포 성공이라고 하지 않는다. OAuth 로그인은 사용자 대화형 승인이 필요하면 요청하고 토큰을 채팅에 요구하지 않는다.

## 현황

> 이전 Access 로그인과 guest sharing 설계는 superseded 됐다. 앱은 익명 가족 CRUD이며 guest/share 의미를 제공하지 않는다. 공개 배포 시 데이터 전체가 공개될 수 있다. Zero Trust는 향후 배포 시험 뒤 사용자가 별도 구성한다.

- 로컬 코드·fixture 기준 게이트 1–8은 [cloudflare-implementation-results.md](cloudflare-implementation-results.md)에 기록된 TEST-ONLY evidence로 확인했다. 실제 provider 품질은 검증하지 않았다.
- 9번의 대기/저장 오류/실패 상태 표시는 구현했다. 실제 저장소 transport 장애를 재현해 UI의 이전 데이터 유지까지 end-to-end 검증하지는 않았다.
- 10번의 이관·rollback은 synthetic local fixture로 SHA 대조와 cutover 뒤 쓰기를 확인했다. 실제 operating snapshot의 ID/count/SHA 대조는 수행하지 않았다.
- 1,000개 local D1 list fixture는 요청당 SQL 1회, 12회 반복 전체 36,000 rows-read로 측정했다. 이는 계정 사용량이나 실제 성능이 아니다.
- 실계정 plan/사용량 읽기, remote resource 접근, 운영 데이터 읽기/이관, Zero Trust 정책, 배포는 하지 않았다. 따라서 11–12와 배포 완료는 미검증이며 local pass를 배포 성공으로 간주하지 않는다.
- task 범위에서 remote account access를 사용하지 않았고 bucket `drop5-files`는 건드리지 않았다.
