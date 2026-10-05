# 수학 오답노트

문제집에서 틀린 문제를 폰으로 찍어 올리면 LLM이 문제와 풀이를 분석해 JSON으로 저장한다.
사용자가 하는 일은 **문제집 버튼 선택 + 사진 촬영**뿐이다.

앱은 `/math` 하위 경로에 있고, 아래 경로 앞에 `/math` 이 붙는다(배포·운영 참고).

- `/upload` — 📷 업로드: 문제집 큰 버튼 → 카메라 → 자동 분석 큐 등록
- `/items` — 📋 문제별: 오답 분석 결과 확인(영역·문제집·오류유형·상태 필터, 재분석, 삭제)
- `/areas` — 📊 영역별: 대수·기하·함수 등 영역별 통계 및 취약점 분석 보고서
- `/status` — ⚡ 작업 상태: 문제 분석 및 보고서 생성 큐 실시간 모니터링
- `/` — `/upload`로 리디렉트(향후 대시보드 자리)

## 직접 고칠 파일

| 파일 | 역할 |
| --- | --- |
| `user/config/workbooks.json` | 업로드 화면의 문제집 버튼. 한 줄 추가하면 끝(정렬은 코드가 처리: 학년 → `publisherOrder` → 학기) |
| `user/prompts/analyze.md` | **개별 문제를 어떻게 분석할지** 지침. 다음 분석부터 바로 반영 |
| `user/prompts/report.md` | **영역별 개선방향 보고서**를 어떻게 쓸지 지침 |
| `user/prompts/curriculum.md` | 영역(대수/함수/기하/확률통계…) → 단원 → 개념 ID. **분류의 유일한 원천**. 영역 추가(예: 미적분)는 여기만 고치면 됨 |

지침이나 분류 체계를 고친 뒤 이미 분석된 항목에 반영하려면 `/items`에서 **다시 분석**한다.
각 결과에는 `prompt_version`(지침 해시)이 남아 어떤 지침으로 분석했는지 알 수 있다.

## 정답 발설 차단 (가드레일)

답을 알려 주지 않고 스스로 다시 생각하게 하는 것이 목적이라 3중으로 막는다.

1. **스키마에 정답을 담을 자리가 없다.** 올바른 풀이·정답·올바른 접근 필드가 없고(`src/lib/server/analysis.schema.json`, 회귀 테스트로 고정), LLM은 정답 검증을 머릿속에서만 하고 `verification`에 참/거짓만 남긴다.
2. **프롬프트(`user/prompts/analyze.md`, `user/prompts/report.md`)의 절대 규칙**: 정답·최종 식·계산 전개·올바른 첫 수 금지, 넛지는 질문만.
3. **서버 검사(`src/lib/server/guardrail.ts`)**: 넛지·자기 점검에 등식이나 "정답은…" 표현이 있으면 결과를 저장하지 않고 실패로 처리해 위반 사유를 힌트로 붙여 재시도한다. 질문 형태가 아니거나 너무 길면 저장하되 화면에 경고를 표시한다.

오류 유형은 심화 문항용 4종이다: 숨은 전제·특수 조건 누락 / 개념의 본질적 해석 오류 / 전략·모델링 실패 / 연산·기호 착오(+ 판정 불가).
결과 화면은 최초 오류 지점 → 오류 유형 → 사고 전환 넛지 Q1(조건 재확인)·Q2(개념·전략 전환) 순이다.

## UI 일관성 및 배지 체계

- **배지 시스템**: `[영역]`(기하/대수 등), `[문제집명]`, `[문제번호]`(예: `0255`, 괄호 없이 연한 배경), `[오류유형]`, `[상태]` 순으로 일관되게 제공.
- **날짜 표기**: 전 화면 통일된 `MM/DD` 배지(`src/lib/ui.css`의 `.badge.date`)로 표기하며, 목록 카드 박스에서는 우측 끝으로 정렬.
- **보고서-문제 연동**: 영역별 보고서의 추천 문제 링크와 문제별 화면의 문제집/번호 배지 스타일 일치.

## 분석 반응 (학생 피드백)

`/items` 상세 맨 아래 "오답노트 피드백"에서 학생이 분석을 읽은 뒤 라디오로 반응을 고른다(읽음 확인 + 지침 개선 자료). 목록 카드에는 아직 답하지 않은 항목에 `미확인` 배지가 붙고, 목록 위의 `미확인` 체크박스로 그것만 모아 볼 수 있다. 읽기 전용 방문자에게는 보이지 않는다.

| 값 | 레이블 | 개선 방향 |
| --- | --- | --- |
| `accurate` | 정확함 | 진단 정확, 유지 |
| `learned` | 새로 앎 | 코칭 효과 |
| `already_knew` | 이미 앎 | 수준이 낮음 |
| `too_hard` | 어려움 | 표현·난이도 조정(한 줄 의견 선택 입력) |
| `wrong_diagnosis` | 다름 | 오진단, 지침 개선의 핵심(한 줄 의견 선택 입력) |

- `POST /api/items/<id>/feedback` `{choice, comment}` → `record.json`의 `feedback[]`에 `{choice, comment, analyzed_at, prompt_version, provider, model}`로 쌓인다. 어떤 지침·모델의 분석에 대한 반응인지 남으므로 지침을 바꾼 뒤 `wrong_diagnosis` 비율이 줄었는지 비교할 수 있다.
- 같은 분석에 다시 답하면 덮어쓰고, **다시 분석**하면 이전 반응은 남긴 채 새 분석에 대한 답을 새로 받는다. 분석 중·실패 항목에는 남길 수 없다(409).
- 선택은 읽었다는 강한 증거는 아니다(아무거나 눌러도 저장됨). 스크롤·체류 시간은 기록하지 않는다.

## LLM 선택 (GLM / Codex / Agy)

- 기본은 `ANALYZE_PROVIDER`(`omlx` | `zai` | `codex` | `agy`, 기본 omlx — Qwen3.8 27B). `/items`의 상세에서 **다시 분석** 옆 선택 상자로 항목마다 LLM을 골라 재분석할 수 있고, 마지막 선택은 그 항목에 기록된다(`requested_provider`). 업로드 화면은 문제집 선택만 유지한다.
- Claude 지원은 제거됐다. 옛 기록에 `requested_provider: claude` 가 남아 있으면 재분석 때 서버 기본값으로 되돌리고, 화면 표시에는 옛 라벨(`Claude`)이 그대로 남는다.
- z.ai(GLM)는 Z.AI Coding Plan 엔드포인트의 chat/completions로 호출하며 JSON 모드(`response_format: json_object`)로 답을 받는다. 각 LLM의 주소·모델·API 키는 **`user/config/providers.json`** 파일 한 곳에서 관리한다(~/.openclaw 의 `models.providers` 와 같은 형식, 커밋 안 됨). 같은 이름의 환경변수가 있으면 그쪽이 우선하고, 어디에도 키가 없으면 분석이 실패하며 사유가 화면에 표시된다.
- z.ai는 사진을 base64 data URL(`image_url` 콘텐츠 블록)로 메시지에 첨부하므로 **이미지 입력이 되는 모델**을 써야 한다(기본 `glm-5.3-flash` — 네이티브 비전 지원). 텍스트 전용 모델(`glm-5.3`)을 지정하면 사진을 받지 못해 OCR 텍스트만으로 분석한다. GLM-5.3-Flash·GLM-5V 계열은 추론을 강제해서 `thinking`을 끌 수 없어, 텍스트 전용 모델일 때만 thinking을 끼워 보낸다.
- 세 LLM 모두 같은 지침·분류 체계·스키마·가드레일 검사를 거친다. 결과에는 어느 LLM·모델로 분석했는지(`meta.provider`, `meta.model`)가 남는다.
- omlx(집 내부망 oMLX 서버, Qwen3.8 27B)는 OpenAI 호환 `/v1/chat/completions`로 호출하며 사진 없이 OCR 텍스트·문제집 정보만으로 분석한다(z.ai와 달리 사진 미전송). 서버가 API 키를 요구하므로 providers.json 의 `omlx.apiKey` 가 필요하다.
- codex는 `codex exec --output-schema … -i <사진> -s read-only --ephemeral`로 호출하고 프롬프트는 stdin으로 넘긴다(`src/lib/server/llm.ts`). 사진은 첨부로 전달하므로 파일 시스템·셸이 필요 없어 읽기 전용 샌드박스로 실행한다.
- agy(Antigravity CLI, Gemini)는 `agy -p <프롬프트> --output-format json --json-schema <파일> --add-dir <항목 폴더>`로 호출한다. 이미지 첨부 옵션이 없어 에이전트가 `view_file` 도구로 사진을 열며, **권한 우회 옵션(`--dangerously-skip-permissions`)은 쓰지 않는다.** 헤드리스에서는 권한 확인창을 띄울 수 없어 셸 명령이 자동 거부되므로, 프롬프트에서 셸 사용을 금지하고 사진의 절대 경로와 `view_file`을 지정한다(안 그러면 열기 전에 `pwd && ls`부터 하려다 빈 응답이 된다). 프롬프트는 `-p` 인자로 넘기므로 120KB를 넘으면 실행하지 않고 오류를 낸다.
- Gemini는 함수 스키마의 숫자 `enum`을 거부하므로, agy로 보낼 때만 `difficulty`·`severity`를 정수 범위(`minimum`/`maximum`)로 바꿔 보낸다(`toGeminiSchema`). 결과 검증은 원래 스키마로 한다.
- agy는 대화 기록을 자체 저장소(`~/.gemini/antigravity-cli`)에 남기며 끄는 옵션이 없다. 분석한 사진 경로와 결과가 거기 남는다.
- codex는 `~/.codex/config.toml`을 읽으므로 **codex 버전이 설정 파일 형식과 맞아야** 한다. 또한 ChatGPT 계정의 사용량 한도에 걸리면 분석이 `failed`가 되고 사유(예: usage limit)가 화면에 표시된다.

## 여러 LLM 분석 비교 (탭)

한 항목에 서로 다른 LLM으로 여러 번 분석한 결과를 함께 남기고, 상세 화면에서 탭으로 골라 본다.

- **저장 위치**: 분석이 성공할 때마다 항목 폴더에 `analysis-<llm>.json`(예: `analysis-zai.json`, `analysis-omlx.json`)을 쓴다. 같은 LLM으로 다시 분석하면 그 파일만 덮어쓰고, 다른 LLM이면 파일이 하나 더 생긴다. 쓰기를 `record.json` 갱신보다 먼저 하므로, 파일 저장이 실패하면 그 분석은 실패로 처리돼 재시도된다.
- **탭 표시**: `/items` 상세 모달에 분석이 2개 이상이면 탭이 뜬다(기본은 가장 최근 분석). 모달을 열 때 `GET /api/items/<id>/analyses` 로 파일 목록을 받아오고, 탭을 바꾸면 저장된 결과를 그대로 보여 준다(재분석 요청은 하지 않는다).
- **`record.json` 은 마지막 분석만** 가진다. 목록 카드·피드백·영역별 통계·보고서가 쓰는 값이 여기 있으므로, 어느 LLM 분석을 보고 통계를 낸 것인지 잊지 않도록 탭 기본값을 항상 여기서 맞춘다.
- **한계**: 이 기능은 분석 파일이 생긴 뒤부터 동작한다. 배포 전에 분석된 기존 항목에는 `record.json` 의 마지막 분석만 있어 탭이 1개로 보인다(재분석 한 번이면 파일이 생겨 탭이 열린다). 또한 읽기 전용 게스트(`/s/…` 공유 링크)는 분석 목록 API 가 403 이므로 탭 없이 마지막 분석만 본다.
- 파일은 프로바이더별이라 같은 LLM의 다른 모델로 분석하면 이전 모델 결과가 덮어써진다. 모델별 보존이 필요하면 파일명에 모델을 넣도록 바꿔야 한다(현재는 `analysis-<llm>.json`).

## 동작

```
사진 → 축소(긴 변 1600px) + 그레이스케일 JPEG → image.jpg (OCR·LLM 입력과 보관·표시를 겸함)
     → oMLX chat/completions(OCR: PaddleOCR-VL) → ocr.md
     → LLM(zai/codex/agy)에 사진 + OCR + 지침 + 분류 체계 → record.json
```

- 큐는 LLM(프로바이더)별 레인으로 나눠 돈다. 같은 LLM끼리는 하나씩 직렬(내부망 omlx GPU 독점 방지), 서로 다른 LLM끼리는 병렬로 처리한다(omlx 가 밀려 있어도 zai 항목은 기다리지 않는다). 서버가 재시작돼도 `record.json`의 상태로 이어서 처리한다.
- 분석이 끝나면 항목 폴더에 `analysis-<llm>.json`(예: `analysis-zai.json`)으로 프로바이더별로 남긴다. 같은 LLM으로 다시 분석하면 덮어쓰고, 다른 LLM으로 분석하면 파일이 늘어나 `/items` 상세에서 탭으로 전환해 볼 수 있다. `record.json`의 `analysis`는 마지막 분석(목록·보고서·통계는 이것을 쓴다).
- OCR이 실패해도 사진만으로 분석을 계속한다(`flags.ocr_missing`).
- 문제 1개당 `user/data/items/<id>/`: `record.json`, `image.jpg`(개당 약 150KB), `ocr.md`, `analysis-<llm>.json`. 원본은 저장하지 않는다.
- 이미지는 하나만 저장한다. 처음에는 16색 디더링 PNG를 따로 보관했지만 실제 종이 사진에서는 디더링 노이즈가 압축되지 않아 JPEG보다 2.6배(약 430KB 대 150KB) 커서, 용량을 줄이려는 목적에 반하므로 없앴다. 더 줄이려면 `src/lib/server/image.ts`의 `MAX_SIDE`와 JPEG `quality`를 낮춘다.

## 폴더 구조

```
user/            직접 고치거나 쌓이는 것 (config/ 문제집, prompts/ 지침·분류 체계, data/ 사진·결과·보고서, deploy/ 서비스·터널 설정)
src/, static/    소스
```
루트의 `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `node_modules/`는 npm·Vite가 루트에서 찾는 규약이라 옮길 수 없다.
빌드 결과는 숨김 폴더 `.build/`에 만들어진다(`node .build`).

## 실행

요구: Node 20+, 각 LLM 주소·API 키(`user/config/providers.json` 에 입력), OCR과 omlx 분석용 OpenAI 호환 oMLX 서버가 필요하다. codex·agy를 쓸 때는 각 CLI도 필요하다.

```sh
npm install
npm run dev            # 개발
npm run build && npm start   # 운영: .build/ 를 실행 (BODY_SIZE_LIMIT=30M 포함)
npm test               # 단위 테스트
npm run check          # 타입 검사
```

## 배포 (이 호스트에 설치됨)

- 앱은 **`/math` 하위 경로**에서 응답한다(`vite.config.ts`의 `paths.base` 기본값 `/math`, 빌드 시점 고정). 즉 모든 경로에 `/math` 이 붙는다. 루트(`/`)로 내려앉히려면 `BASE_PATH=/ npm run build` 로 다시 빌드하고, `PUBLIC_URL` 과 터널 경로도 함께 바꿔야 한다.
- systemd 사용자 서비스 `ymath`가 `0.0.0.0:3141`에서 실행된다(`user/deploy/ymath.service`).
- 외부는 cloudflared 터널 `math`가 `math.example.com` → `127.0.0.1:3141`로 연결한다. TLS는 Cloudflare 엣지가 담당하므로 자체 인증서·nginx가 없다.
  사진 업로드를 위해 `BODY_SIZE_LIMIT=30M`을 서비스에 넣는다(기본 512KB면 폰 사진이 413으로 막힌다).
- 접속: 내부망 폰/PC는 `http://192.168.1.x:3141/math/upload` (로그인 없음), 외부는 `https://math.example.com/math/upload` (PASSWORD 로그인).

```sh
npm run build && systemctl --user restart ymath   # 코드·설정(workbooks.json은 재시작 불필요) 반영
systemctl --user status ymath                     # 상태
journalctl --user -u ymath -f                     # 로그
```

재시작하면 진행 중(1건)인 항목은 `record.json` 상태로 보고 시작 시 큐에 다시 들어간다(중간 결과는 버려지고 처음부터 다시 분석한다). 그래서 배포 전에 분석이 돌고 있으면 재시작 후 그 항목만 한 번 더 돈다.

개발 PC에서 edge 에 코드를 올릴 때는 `rsync` 가 없을 수 있어 `tar` 파이프를 쓴다(`.git`·`user/`·`.build` 는 건드리지 않는다).

```sh
tar -cf - src/lib/server/queue.ts src/lib/server/store.ts | ssh edge 'tar -xf - -C /opt/ymath'
ssh edge 'cd /opt/ymath && npm run build && systemctl --user restart ymath'
```

## 운영 점검 · 장애 대응

- **큐 상태**: `/math/status` 화면이 실시간이다. 서버에서 곧바로 세려면 항목 폴더를 센다.
  ```sh
  ssh edge 'cd /opt/ymath && python3 -c "
  import json,glob,collections
  c=collections.Counter(json.load(open(p))[\"status\"] for p in glob.glob(\"user/data/items/*/record.json\"))
  print(dict(c))"'
  ```
  `analyzing` 이 2 이상이면 프로바이더가 서로 다른 항목이 동시에 돌고 있는 것이다(정상). `queued` 가 쌓여 있으면 그 프로바이더의 흐름이 막힌 것이다.
- **base 경로를 빼먹으면 404**: 앱은 `/math` 아래에 있으므로 상태 확인도 `curl http://127.0.0.1:3141/math/items` 처럼 경로에 `/math` 이 들어가야 한다. 루트로 조회하면 404 가 뜨고, 그 404 는 경로 착각이지 장애가 아니다.
- **`fetch failed`**: OCR과 omlx 분석은 `user/config/providers.json`의 같은 `omlx.baseUrl`을 쓴다. 이 서버가 죽거나 주소가 틀리면 OCR은 사진만으로 계속 진행하지만 omlx 분석은 실패한다. 서버와 주소가 정상화된 뒤 `/items`에서 **다시 분석** 하면 된다.
- **`분석 시간 초과(900초)`**: omlx 처럼 느린 로컬 모델이 이 한도를 넘으면 실패로 기록되고 1회 자동 재시도한다(`ANALYZE_MAX_ATTEMPTS`, 기본 2). 한도가 모자라면 `ANALYZE_TIMEOUT_MS` 를 올리되, 느린 원인을 먼저 확인한다(서버 부하·모델 교체).
- **`정답 노출 가드레일 위반`**: LLM 결과에 정답·등식이 섞여 저장하지 않고, 위반 사유를 힌트로 주어 1회 자동 재지도로 다시 돌린다. 두 번 다 실패하면 `failed` 로 남고 사유가 화면에 보인다.
- **재시도 큐 되돌리기**: `failed` 항목이 한꺼번에 쌓였을 때 서버를 재시작해도 `queued` 로 되돌아가지 않는다(재시작은 진행 중 항목만 회수한다). 그럴 때는 항목 `record.json` 을 `queued` 로 되돌린 뒤 서비스를 재시작한다.
- **비밀값**: `user/config/providers.json` 과 `~/.config/ymath.env` 에 API 키·비밀번호가 있다. 로그나 문서에 값이 새지 않게 하고, 커밋 대상이 아니다.

## 환경변수

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `DATA_DIR` | `./user/data` | 사진·분석 결과 저장 위치 |
| `STUDENT_NAME` | (비어있음) | 프롬프트와 분석/보고서에서 사용할 학생 이름(예: `지우`). 설정하지 않으면 자연스러운 기본형("학생", "생각 습관")으로 처리된다 |
| `ANALYZE_PROVIDER` | `omlx` | 분석에 쓸 LLM 기본값: `omlx`, `zai`, `codex`, `agy`. 결과 화면의 **다시 분석**에서 항목별로 바꿀 수 있다 |
| `ANALYZE_MODEL` | `glm-5.3-flash` | z.ai 모델. 사진을 첨부하므로 이미지 입력이 되는 모델이어야 한다(`glm-5.3` 은 텍스트 전용). `ZAI_MODEL` 로도 지정할 수 있다(`ANALYZE_MODEL` 이 이긴다) |
| `ZAI_API_KEY` | (없음) | Z.AI API 키. 보통은 `user/config/providers.json` 의 `zai.apiKey` 를 쓰고, 환경변수가 있으면 그쪽이 이긴다 |
| `ZAI_BASE_URL` | `https://api.z.ai/api/coding/paas/v4` | Z.AI Coding Plan 엔드포인트. `providers.json` 의 `zai.baseUrl` 으로도 지정 가능 |
| `OMLX_BASE_URL` | `http://192.168.1.9:9000/v1` | oMLX(내부망 OpenAI 호환 서버) 주소. `providers.json` 의 `omlx.baseUrl` 으로도 지정 가능 |
| `OMLX_MODEL` | `Qwen3.8-27B-8bit` | oMLX에서 쓸 모델. `providers.json` 의 `omlx.models[0].id` 로도 지정 가능 |
| `OMLX_API_KEY` | (없음) | oMLX 서버의 API 키. 보통은 `providers.json` 의 `omlx.apiKey` 를 쓴다. 서버가 키를 요구하므로 어느 쪽에든 필요 |
| `CODEX_BIN` | `codex` | codex 실행 파일 경로 |
| `AGY_BIN` | `agy` | agy 실행 파일 경로 |
| `AGY_MODEL` | `gemini-3.1-pro-high` | agy 모델(`agy models`로 목록 확인). 사진을 읽어야 하므로 이미지 입력이 되는 모델 |
| `CODEX_MODEL` | `gpt-5.5` | codex 모델. 이미지 입력을 지원해야 하고, `~/.codex/config.toml`의 기본 모델은 계정에 따라 거부될 수 있어 명시한다 |
| `ANALYZE_TIMEOUT_MS` | `900000` | 분석 시간 제한(15 분 — 로컬 27B 추론 등 느린 모델 감안) |
| `ANALYZE_MAX_ATTEMPTS` | `2` | 분석 실패 시 총 시도 횟수 |
| `OCR_MODEL` | `PaddleOCR-VL-1.6-mlx` | oMLX OpenAI 호환 `chat/completions`로 직접 호출할 OCR 모델. 주소·API 키는 `providers.json`의 `omlx` 설정을 함께 쓴다 |
| `OCR_TIMEOUT_MS` | `120000` | OCR 시간 제한 |
| `USER_DIR`, `PROMPTS_DIR`, `CONFIG_DIR` | `./user`, `./user/prompts`, `./user/config` | 위치 변경 |
| `PASSWORD` | (없음) | 내부망 밖에서 들어올 때 쓰는 비밀번호. **없으면 밖에서는 아무도 못 들어온다** |
| `TRUSTED_CIDRS` | `192.168.1.0/24` | 로그인을 생략하는 내부망(쉼표로 여러 개, IPv4 만). 개발할 때는 `127.0.0.1` 을 더한다 |
| `PUBLIC_URL` | (없음) | 밖에서 접속하는 주소(예: `https://math.example.com`). 공유 링크를 이 주소로 만든다 |
| `SESSION_SECRET` | (자동) | 쿠키·링크 서명 키. 없으면 `user/data/session-secret` 에 만들어 쓴다. 바꾸거나 지우면 모든 로그인과 링크가 무효가 된다 |
| `GUEST_PHOTOS` | (꺼짐) | `1` 이면 읽기 전용 방문자에게 원본 오답 사진도 보여 준다 |

## 접근 제어 (인터넷에 열 때)

계정·DB 없이 서명(HMAC)만 쓴다(`src/lib/server/auth.ts`, 게이트는 `src/hooks.server.ts`).

| 누가 | 어떻게 | 권한 |
| --- | --- | --- |
| 내부망(`TRUSTED_CIDRS`) | 로그인 없음 | 전부 |
| 밖의 가족 | `/login` 에서 `PASSWORD` → 쿠키 30일 | 전부 |
| 지인 | 가족이 만든 공유 링크 `/s/<만료>.<서명>` → 쿠키(링크와 같은 시각에 만료) | **읽기 전용**(문제별·영역별·작업상태 화면) |

- 공유 링크는 화면 오른쪽 위 **🔗** 에서 만든다(가족 권한에서만 노출). 읽기 전용 게스트에게는 1시간 링크 만들기 아이콘이 차단되어 링크를 임의로 연장할 수 없으며, API(`/api/share`)도 403 Forbidden으로 엄격 차단된다.
- 게스트 세션 쿠키는 내부망(Wi-Fi) IP 판정보다 우선 적용되므로, 집 내부망에서 공유 링크를 열어 테스트할 때도 읽기 전용 권한이 정확히 유지된다.
- 공유 링크는 만든 시각부터 정확히 1시간 유효하고, 서버에 저장하지 않는다. 링크만 따로 취소할 수는 없다. 급하면 `session-secret` 을 지우고 재시작하면 모든 로그인·링크가 무효가 된다.
- 로그인은 IP 별로 10분에 5번까지 틀릴 수 있다.
- **내부망 판정**: 소켓이 루프백일 때만 `X-Real-IP` 를 믿는다. cloudflared 는 `X-Real-IP` 를 보내지 않고 소켓이 루프백이라, 터널 요청은 `127.0.0.1` 로 판정되어 로그인이 필요하다. 내부망 직접 접속(`192.168.1.x`)은 소켓 주소 그대로 믿어 로그인이 없다. `CF-Connecting-IP` 헤더가 있으면 어떤 경우에도 내부망으로 보지 않는다. 서비스에 `ADDRESS_HEADER`(예: `x-forwarded-for`)를 설정하면 **안 된다** — 어댑터가 소켓 주소 대신 그 헤더만 읽게 되어, 헤더가 없는 요청에서 클라이언트 주소를 못 얻어(`ip=unknown`) 내부망 자동 신뢰가 전부 무효화된다.
- **HTTPS 는 Cloudflare 엣지에서 처리**한다. 터널은 내부에 `X-Forwarded-Proto(https)`, `X-Forwarded-Host`, `CF-Connecting-IP` 를 넘긴다. 내부망 직접 접속은 `http://192.168.1.x:3141` 그대로 쓴다.
- 배포 전에 **셀룰러 데이터(와이파이 끔)로 접속해 로그인 화면이 뜨는지** 꼭 확인한다. 공유기가 바깥에서 온 요청을 내부 주소로 바꿔 전달(SNAT)하면 밖에서 온 요청이 내부망으로 보일 수 있다.

## 보안 메모

`adapter-node`는 `ORIGIN`이 없으면 요청을 `https`로 가정해 SvelteKit의 폼 Origin 검사가 `http://IP` 접속을 모두 막는다.
그래서 업로드는 multipart 대신 **바이너리 본문**(`Content-Type: image/*`)으로 받고, 상태를 바꾸는 API(업로드·재분석·삭제)는
커스텀 헤더 `X-Requested-With: ymath`를 요구한다(`src/lib/server/guard.ts`). 다른 사이트에서 이 서버로 요청을 위조하려면
CORS 사전 요청을 통과해야 하는데 서버가 허용하지 않으므로 `ORIGIN` 고정 없이도 안전하다.

### 의존성 정책 (OWASP ASVS V15.2.1)

- 런타임 의존성은 `dependencies` 3개(ajv·katex·sharp)로 최소화한다. 다른 기능이 필요하면 우선 직접 구현을 검토하고,
  추가하더라도 같은 기능을 하는 패키지가 두 개 이상 들어가지 않게 한다.
- 배포 전에 `npm run audit`(`npm audit --omit=dev`)로 알려진 취약점이 없는지 확인한다. `high` 이상이 나오면
  메이저 업데이트로 고치거나(실행 중이면 정기 배포 때 반영) 대체 패키지로 옮긴다.
- 미사용 의존성은 즉시 제거한다. SvelteKit·Vite는 메이저 버전이 자주 올라오므로 `dependencies`는 유지 보수 시마다
  최신 메이저를 따라간다.
