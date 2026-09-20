# 수학 오답노트

문제집에서 틀린 문제를 폰으로 찍어 올리면 LLM이 문제와 풀이를 분석해 JSON으로 저장한다.
사용자가 하는 일은 **문제집 버튼 선택 + 사진 촬영**뿐이다.

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

## LLM 선택 (Claude / Codex / Agy)

- 기본은 `ANALYZE_PROVIDER`(`claude` | `codex` | `agy`, 기본 claude). `/items`의 상세에서 **다시 분석** 옆 선택 상자로 항목마다 LLM을 골라 재분석할 수 있고, 마지막 선택은 그 항목에 기록된다(`requested_provider`). 업로드 화면은 문제집 선택만 유지한다.
- 두 LLM 모두 같은 지침·분류 체계·스키마·가드레일 검사를 거친다. 결과에는 어느 LLM·모델로 분석했는지(`meta.provider`, `meta.model`)가 남는다.
- codex는 `codex exec --output-schema … -i <사진> -s read-only --ephemeral`로 호출하고 프롬프트는 stdin으로 넘긴다(`src/lib/server/llm.ts`). 사진은 첨부로 전달하므로 파일 시스템·셸이 필요 없어 읽기 전용 샌드박스로 실행한다.
- agy(Antigravity CLI, Gemini)는 `agy -p <프롬프트> --output-format json --json-schema <파일> --add-dir <항목 폴더>`로 호출한다. 이미지 첨부 옵션이 없어 에이전트가 `view_file` 도구로 사진을 열며, **권한 우회 옵션(`--dangerously-skip-permissions`)은 쓰지 않는다.** 헤드리스에서는 권한 확인창을 띄울 수 없어 셸 명령이 자동 거부되므로, 프롬프트에서 셸 사용을 금지하고 사진의 절대 경로와 `view_file`을 지정한다(안 그러면 열기 전에 `pwd && ls`부터 하려다 빈 응답이 된다). 프롬프트는 `-p` 인자로 넘기므로 120KB를 넘으면 실행하지 않고 오류를 낸다.
- Gemini는 함수 스키마의 숫자 `enum`을 거부하므로, agy로 보낼 때만 `difficulty`·`severity`를 정수 범위(`minimum`/`maximum`)로 바꿔 보낸다(`toGeminiSchema`). 결과 검증은 원래 스키마로 한다.
- agy는 대화 기록을 자체 저장소(`~/.gemini/antigravity-cli`)에 남기며 끄는 옵션이 없다. 분석한 사진 경로와 결과가 거기 남는다.
- codex는 `~/.codex/config.toml`을 읽으므로 **codex 버전이 설정 파일 형식과 맞아야** 한다. 또한 ChatGPT 계정의 사용량 한도에 걸리면 분석이 `failed`가 되고 사유(예: usage limit)가 화면에 표시된다.

## 동작

```
사진 → 축소(긴 변 1600px) + 그레이스케일 JPEG → image.jpg (OCR·LLM 입력과 보관·표시를 겸함)
     → PaddleOCR(`ocr`) → ocr.md
     → LLM(claude/codex/agy)에 사진 + OCR + 지침 + 분류 체계 → record.json
```

- 큐는 프로세스 내 단일 워커. 서버가 재시작돼도 `record.json`의 상태로 이어서 처리한다.
- OCR이 실패해도 사진만으로 분석을 계속한다(`flags.ocr_missing`).
- 문제 1개당 `user/data/items/<id>/`: `record.json`, `image.jpg`(개당 약 150KB), `ocr.md`. 원본은 저장하지 않는다.
- 이미지는 하나만 저장한다. 처음에는 16색 디더링 PNG를 따로 보관했지만 실제 종이 사진에서는 디더링 노이즈가 압축되지 않아 JPEG보다 2.6배(약 430KB 대 150KB) 커서, 용량을 줄이려는 목적에 반하므로 없앴다. 더 줄이려면 `src/lib/server/image.ts`의 `MAX_SIDE`와 JPEG `quality`를 낮춘다.

## 폴더 구조

```
user/            직접 고치거나 쌓이는 것 (config/ 문제집, prompts/ 지침·분류 체계, data/ 사진·결과·보고서, deploy/ 서비스·터널 설정)
src/, static/    소스
```
루트의 `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `node_modules/`는 npm·Vite가 루트에서 찾는 규약이라 옮길 수 없다.
빌드 결과는 숨김 폴더 `.build/`에 만들어진다(`node .build`).

## 실행

요구: Node 20+, `claude` CLI(로그인됨), `ocr` CLI와 `ocr-server.service`(127.0.0.1:9004) 가동.

```sh
npm install
npm run dev            # 개발
npm run build && npm start   # 운영: .build/ 를 실행 (BODY_SIZE_LIMIT=30M 포함)
npm test               # 단위 테스트
npm run check          # 타입 검사
```

## 배포 (이 호스트에 설치됨)

- 앱은 **루트(`/`)에서** 응답한다(vite.config.ts의 `paths.base`, 빌드 시점 고정). 2026-09 터널 전환 때 `/ymath` base를 제거했다. 하위 경로로 빌드하려면 `BASE_PATH=/other npm run build`.
- systemd 사용자 서비스 `ymath`가 `0.0.0.0:3141`에서 실행된다(`user/deploy/ymath.service`).
- 외부는 cloudflared 터널 `math`가 `math.example.com` → `127.0.0.1:3141`로 연결한다. TLS는 Cloudflare 엣지가 담당하므로 자체 인증서·nginx가 없다.
  사진 업로드를 위해 `BODY_SIZE_LIMIT=30M`을 서비스에 넣는다(기본 512KB면 폰 사진이 413으로 막힌다).
- 접속: 내부망 폰/PC는 `http://192.168.1.x:3141/upload` (로그인 없음), 외부는 `https://math.example.com/upload` (PASSWORD 로그인).

```sh
npm run build && systemctl --user restart ymath   # 코드·설정(workbooks.json은 재시작 불필요) 반영
systemctl --user status ymath                     # 상태
journalctl --user -u ymath -f                     # 로그
```

## 환경변수

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `DATA_DIR` | `./user/data` | 사진·분석 결과 저장 위치 |
| `STUDENT_NAME` | (비어있음) | 프롬프트와 분석/보고서에서 사용할 학생 이름(예: `지우`). 설정하지 않으면 자연스러운 기본형("학생", "생각 습관")으로 처리된다 |
| `ANALYZE_PROVIDER` | `claude` | 분석에 쓸 LLM 기본값: `claude`, `codex`, `agy`. 결과 화면의 **다시 분석**에서 항목별로 바꿀 수 있다 |
| `ANALYZE_MODEL` | `sonnet` | claude 모델(`claude -p --model`) |
| `CODEX_BIN` | `codex` | codex 실행 파일 경로 |
| `AGY_BIN` | `agy` | agy 실행 파일 경로 |
| `AGY_MODEL` | `gemini-3.1-pro-high` | agy 모델(`agy models`로 목록 확인). 사진을 읽어야 하므로 이미지 입력이 되는 모델 |
| `CODEX_MODEL` | `gpt-5.5` | codex 모델. 이미지 입력을 지원해야 하고, `~/.codex/config.toml`의 기본 모델은 계정에 따라 거부될 수 있어 명시한다 |
| `ANALYZE_TIMEOUT_MS` | `300000` | 분석 시간 제한 |
| `ANALYZE_MAX_ATTEMPTS` | `2` | 분석 실패 시 총 시도 횟수 |
| `OCR_BIN`, `CLAUDE_BIN` | `ocr`, `claude` | 실행 파일 경로 |
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
- **내부망 판정**: 소켓이 루프백일 때만 `X-Real-IP` 를 믿는다. cloudflared 는 `X-Real-IP` 를 보내지 않고 소켓이 루프백이라, 터널 요청은 `127.0.0.1` 로 판정되어 로그인이 필요하다. 내부망 직접 접속(`192.168.1.x`)은 소켓 주소 그대로 믿어 로그인이 없다. `CF-Connecting-IP` 헤더가 있으면 어떤 경우에도 내부망으로 보지 않는다.
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
