# oMLX/게이트웨이 비동기 추론 지원 조사

## 결론

현재 설치된 oMLX **0.6.4는 추론을 접수한 즉시 job ID를 반환하고, 연결을 종료해도 계속 실행되는 background inference를 구현하지 않는다.** `background` 입력 필드와 응답 조회 API의 존재만 보고 지원한다고 판단하면 안 된다.

반면 **HTTP 연결을 유지하는 streaming 및 keepalive는 구현되어 있다.** 따라서 당장 검증할 대안은 기존 추론 API의 keepalive를 이용하는 긴 호출이다. 이것은 background job이나 재접속 가능한 내구 실행과 다르다. ymath 전용 Mac runner 신설을 뜻하지 않는다.

## 조사 범위와 증거

- `https://llm.xcv.kr/openapi.json`, `http://127.0.0.1:9000/openapi.json`을 읽었다. 모두 200, API 정보 `oMLX`/`0.6.4`, 두 JSON은 구조적으로 동일하다.
- 실행 중 `omlx-server` 프로세스의 로드된 라이브러리 경로로 Homebrew 설치를 확인했다. 설치 코드: `/opt/homebrew/Cellar/omlx/0.6.4/libexec/lib/python3.11/site-packages/omlx/`.
- 이 설치의 `server.py`, `api/responses_models.py`, `api/responses_utils.py`를 정적으로 분석했다. 설정·키·저장된 응답·실사용자 데이터는 읽지 않았다.
- 설치된 keepalive 함수만 AST로 분리해 격리 실행했다. 모델·GPU·HTTP 서버를 시작하지 않았다. 아래 6개 단정이 모두 통과했다.
- `/v1/models`는 공개/로컬 모두 인증 없이 401이었다. 인증된 추론·실제 모델 호출·프록시 장시간 부하 프로브는 수행하지 않았다. 실행 환경에 QWEN_API_KEY/OMLX_API_KEY/OPENAI_API_KEY가 없으며, 기존 외부 LLM 호출 제한을 유지했다.
- 레포/상위 경로와 docs에 AGENTS.md/CLAUDE.md는 발견되지 않았다. `ops/lead-clean`은 로컬/원격 추적 브랜치 목록에서 발견되지 않았다(원격 fetch는 하지 않음).

증거 디렉터리: `/Users/y/.hermes/profiles/plan/cache/scratch/omlx-capability-audit/`.
`source-audit.json`, `{public,local}-openapi.json`, `installed-server.py`, `installed-api_responses_models.py`, `installed-api_responses_utils.py`, `probe_helpers.py`, `helper-probe-result.json`을 남겼다. scratch 보존 기간이 있으므로 본 문서에 핵심 결론/행번호를 함께 기록한다.

설치 server.py SHA-256: `fdffe13f58a66c88a7517c04e2dbbfd35085f5e3ff8de2f68352c73a4570e767`.

## 1. background: 필드는 있지만 실행 분기가 없다

- `api/responses_models.py:121`: `background: Optional[bool] = None`.
- `server.py:6084–6541`: `create_response`는 `request.background`를 읽지 않는다. 이 handler가 읽는 request 속성 목록을 AST로 추출해 확인했다.
- `server.py:6394`: non-stream 경로는 `await engine.chat(...)`로 결과를 기다린다.
- `server.py:6523–6536`: 결과를 저장한 다음 JSON 응답/keepalive 응답을 반환한다. 접수 ID만 조기 반환하는 독립 작업 생성 경로가 아니다.
- `server.py:7275–7283`: `GET /v1/responses/{response_id}`는 ResponseStore의 저장 결과를 조회할 뿐이다. `previous_response_id`와 저장된 응답 재조회 기능은 진행 중 job polling과 다르다.
- live OpenAPI와 설치 server.py에 `/v1/batches` route 선언은 없다. 이것만으로 임의의 비공개 게이트웨이 기능 전체가 없다고 증명하지는 않지만, 현재 공개된 API와 설치 handler에는 해당 계약이 없다.

따라서 **`background:true`만 붙여 긴 연결을 없앨 수 없다.** 유효한 인증·모델로 해당 요청을 보낸 동작 검증은 하지 않았지만, 설치 구현상 해당 값이 실행 경로에 반영되지 않는 점은 확인했다.

## 2. streaming/heartbeat: 지원하되 프로토콜별 차이가 있다

### Chat Completions (`/v1/chat/completions`, stream=true)

- `server.py:3902–3930`: SSE 응답을 `_with_sse_keepalive`로 감싼다.
- `server.py:2191–2299`: wrapper 진입 시 첫 keepalive를 즉시 내보내고, 대기 중 기본 **10초** 간격으로 keepalive를 내보낸다. 실제 토큰이 없어도 가능하다.
- 기본 mode `chunk`: 빈 content를 가진 유효한 Chat Completion chunk. `comment`는 SSE comment, `off`는 keepalive 비활성화.
- 초기 모델 준비·lease 획득·`preflight_chat` 등은 SSE wrapper에 들어가기 전에 발생할 수 있다. 해당 구간까지 무조건 첫 바이트를 즉시 보장하는 것은 아니다.

### Responses (`/v1/responses`, stream=true)

- SSE 자체는 지원한다(`server.py:6362–6387`).
- **주의:** `_resolve_keepalive('openai_responses')`는 기본 `chunk` 모드에서 `None`이다(`server.py:2127–2151`). 다른 response event가 발생할 수 있지만, 침묵 구간의 주기적인 keepalive는 기본 모드에서 보장되지 않는다.
- `comment` 모드에서는 keepalive를 반환한다. 실제 운영 설정은 읽거나 변경하지 않았다.

### non-stream JSON

- `_with_json_keepalive`는 즉시 공백 한 글자와 기본 10초 간격 공백을 전송한 뒤 최종 JSON을 보낸다. JSON 파싱은 선행 공백을 허용한다.
- 이 경로도 열린 HTTP 연결이고, 독립적인 비동기 job이 아니다. keepalive 이후 이미 HTTP 200을 보냈다면, 뒤늦은 실패는 HTTP 상태만으로 판별할 수 없다. 본문 오류 및 결과 스키마 검증이 필요하다.
- 연결 종료 감지 시 내부 task/stream을 취소·정리하는 코드가 있다. 따라서 연결을 끊은 뒤 반드시 추론이 계속된다고 전제할 수 없다.

## 3. 실제 실행한 격리 프로브

명령:

```sh
TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch python3 /Users/y/.hermes/profiles/plan/cache/scratch/omlx-capability-audit/probe_helpers.py
```

통과 단정:

- chunk + openai_chat → keepalive 존재.
- chunk + openai_responses → keepalive 없음.
- comment + openai_responses → keepalive 존재.
- off + openai_chat → keepalive 없음.
- 지연된 async generator를 기다리는 동안 SSE heartbeat 반복 후 실제 결과 반환.
- 지연된 JSON coroutine을 기다리는 동안 공백 heartbeat 반복 후 전체 JSON 파싱 성공.

테스트는 시간을 단축하기 위해 interval을 0.01초로 바꿨다. 기본 10초 값은 설치 함수 시그니처로 확인했다. 이는 helper 실행 증거이며 **llm.xcv.kr을 통과한 장시간 모델 추론 성공 증거는 아니다.**

## 4. ymath에 대한 판단과 남은 검증 기준

현재 API의 background job을 전제로 플랫폼을 결정하지 않는다. 먼저 기존 Chat Completions streaming/keepalive를 활용할 수 있는지 다음 프로브로 판정한다. 구현 난이도/클라우드 실행 통합은 dev 검토 전 미확정이며, UI 변경은 이 조사에 포함하지 않는다.

- [ ] 승인된 합성 입력으로 공개 llm.xcv.kr 경로의 첫 바이트 지연·최대 바이트 간 공백·총 실행 시간을 기록한다. 모델 미적재/대기열 경로도 포함한다.
- [ ] 125초보다 긴 호출에서 keepalive가 중간 프록시에 버퍼링되지 않고 전달되고, 524 없이 최종 응답을 얻는지 확인한다.
- [ ] 클라우드 호출자가 SSE를 끝까지 소비하고 빈 heartbeat를 제외해 최종 결과를 복원하며, 본문 오류·중간 종료·JSON 스키마 실패를 성공으로 처리하지 않는지 확인한다.
- [ ] 브라우저 종료와 클라우드→LLM 연결 종료를 구분해 검증한다. 브라우저는 닫혀도 클라우드 작업은 계속되어야 하며, LLM 연결이 끊기면 안전한 재시도/실패 처리가 필요하다.
- [ ] background job이 반드시 필요하다면 제공 API 측 별도 개발 사항으로 분류한다. job ID 조기 반환·상태 조회·연결 종료 후 지속·결과 보존·실패/재시작·중복 방지까지 dev가 확인하기 전 지원된다고 하지 않는다.

이번 조사에서 서버 설정, 기존 서비스, 배포, 유료 플랜, Git 커밋/푸시는 변경하지 않았다.

## 공개 소스 근거

- https://github.com/jundot/omlx/blob/v0.6.4/omlx/api/responses_models.py#L121
- https://github.com/jundot/omlx/blob/v0.6.4/omlx/server.py#L6084-L6541
- https://github.com/jundot/omlx/blob/v0.6.4/omlx/server.py#L2127-L2151
- https://github.com/jundot/omlx/blob/v0.6.4/omlx/server.py#L2191-L2299
- https://github.com/jundot/omlx/blob/v0.6.4/omlx/server.py#L7275-L7283

공개 소스는 비교 근거이고, 결론은 위 설치 코드 및 live OpenAPI로 교차 확인했다.
