# ymath 실행 플랫폼 비교 — runner 없는 클라우드 앱 (검토 초안)

## 사용자 요구와 상태

맥은 기존 llm.xcv.kr 추론 API만 제공한다. 웹/API·이미지/OCR·프롬프트·검증·보고서·재시도는 클라우드에서 실행한다. 기존 host-runner 배포는 이 요구의 완료본이 아니다. 아래는 공식 문서 비교이며 어느 대안도 이번 검토에서 구현/배포/모델 호출하지 않았다. 확정 criteria 전 dev의 Node/native 패키징 검토가 필요하다. UI 변경은 현재 제안하지 않는다.

## 선택지

### CF Workers + Workflows

- 네트워크 대기가 긴 모델 호출을 Workflow 단계에서 수행하는 것은 지원된다. CPU 한도와 별개이며 timeout을 명시해야 한다.
- 웹/D1/R2 구성을 재활용할 수 있다.
- sharp/native OCR/CLI는 그대로 이식하는 방식이 아니다. 이미지/OCR 대안의 지원 범위, CPU/메모리, 요금 프로브가 필요하다.
- 별도 설계: docs/cloudflare-long-model-calls.md.

### Vercel Node Functions + 필요 시 Workflows

- Node.js 지원으로 기존 sharp·Node 분석 코드 재사용 가능성이 CF Workers보다 높다. 해당 native binary와 OCR 구현은 배포 환경에서 실제 프로브해야 하며, 기존 Codex/Claude 등의 CLI 로그인 상태를 가져갈 수 있다고 가정하지 않는다. LLM은 기존 HTTPS API로 통일한다.
- Fluid compute 기준 Functions: Hobby 최대 300초, Pro/Enterprise 일반 최대 800초. 지원 런타임의 함수별 설정으로 최대 1800초 확장 Beta 제공. 계정 적용 가능 여부/가격 확인 전 사용을 전제하지 않는다.
- Vercel Workflows는 전체 실행을 오래 유지할 수 있지만 개별 step 실행 시간은 Functions 한도를 따른다. 따라서 하나의 추론 요청이 step 제한보다 길면 Workflow 도입만으로 해결되지 않는다.
- Function 요청/응답 payload 한도 4.5MB. 현재 25MiB 사진을 함수에 직접 올리는 경로는 그대로 유지 불가: 인증된 업로드 발급 → private R2/S3 직접 업로드 → 객체 키 기반 처리 등으로 변경 필요.
- D1/R2 binding은 Vercel에서 그대로 쓸 수 없다. R2 S3 API 등 별도 연결과 D1 접근/대체 DB를 결정해야 한다. adapter 교체만으로 완료되지 않는다.
- I/O 대기 중 active CPU 과금은 멈추지만 provisioned memory 시간 과금은 별개다. 무료 확약 불가.

### 관리형 Node 컨테이너 (예: Cloud Run)

- 기존 SvelteKit Node + sharp/OCR의 OS/native 의존성을 이미지에 함께 패키징할 수 있어, 코드 보존 관점의 우선 비교 후보다.
- Cloud Run service 요청 timeout은 기본 300초, 최대 3600초. 프레임워크/클라이언트/이벤트 트리거의 더 짧은 제한은 별도다.
- 사용자 업로드 응답은 202로 끝내고 내구성 있는 작업 전달 → 클라우드 컨테이너 처리 → 객체/DB 저장을 권장한다. 202 이후 일반 서비스의 임의 background promise가 계속 실행된다고 가정하지 않는다. task/job/항상 할당 CPU 등의 실행 모델을 명시해야 한다.
- 클라우드에서 애플리케이션 프로세스가 동작하는 것이며 맥의 ymath runner는 필요 없다. 대신 배포·DB·작업 전달·요금 설계가 필요하다.

## 모든 대안에 공통인 연결 병목

Vercel/컨테이너로 옮겨도 llm.xcv.kr 앞의 CF proxy timeout은 사라지지 않는다. 공식 524 문서는 기본 Proxy Read Timeout 125초를 명시한다. 실제 경로의 첫 바이트/청크 간 최대 지연/버퍼링/게이트웨이 timeout을 측정해야 한다. streaming을 켜도 긴 첫 응답 무음은 해결되지 않을 수 있다.

다른 실행 패턴으로는 추론 API 자체가 async inference job을 접수하고 job ID로 결과 조회/알림을 제공하는 방식이 있다. 이것은 LLM 제공 기능이지 ymath 작업 runner가 아니다. 후속 조사에서 현재 설치된 oMLX 0.6.4는 `background` 입력 필드를 받지만 이를 실행 경로에서 사용하지 않으며, 저장 응답 조회는 background job polling이 아님을 확인했다. 반면 Chat Completions streaming 및 keepalive는 구현되어 있다. 실제 공개 경로의 장시간 추론·버퍼링은 아직 미검증이다. 설치 코드·live OpenAPI·격리 프로브 결과와 후속 기준: `docs/omlx-inference-capabilities.md`.

## 판단 제안 (확정 아님)

1. 최장 입력 모델 호출의 시간과 HTTP 스트리밍 상태를 먼저 측정한다.
2. Vercel Hobby/Pro 한도 내 여유가 있고 native/OCR 프로브가 통과하면 Vercel Node를 후보로 삼는다.
3. 긴 실행/OS 의존성/기존 Node 코드 보존이 우선이면 관리형 Node 컨테이너를 우선 비교한다.
4. CF만 사용이 최우선이면 Workers+Workflows 및 이미지/OCR 재설계 비용을 명시하고 선택한다.
5. 실제 1건의 배포 프로브에서 정상 처리·브라우저 종료·timeout·429·재실행/삭제 fencing을 통과하기 전 플랫폼 적합성을 확정하지 않는다. 현재 배포 및 유료 플랜은 변경하지 않는다.

## 공식 근거

- https://vercel.com/docs/functions/limitations — duration, Node API, 4.5MB payload, memory 과금.
- https://vercel.com/docs/functions/configuring-functions/duration — 1800초 Beta 조건.
- https://vercel.com/docs/workflows — 내구 실행 구성.
- https://vercel.com/docs/workflows/pricing.md — 개별 step은 Functions 시간 한도 적용.
- https://svelte.dev/docs/kit/adapter-vercel — SvelteKit Vercel adapter.
- https://docs.cloud.google.com/run/docs/configuring/request-timeout — 최대 3600초, 긴 요청의 재시도/멱등성 요구.
- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/ — LLM 프록시 구간 제한.
