# ymath × Baton App 자산

이 디렉터리(`/Users/y/Github/ymath/baton`)는 Baton 공통 Runner에 등록된 App `ymath`의 자산 root다.
운영 소유권·시작 절차만 다룬다. **이 트리는 모델 입력이 아니며, 실행 중 읽기 전용이다.**
모델 프롬프트에는 `analysis/instruction.md`와 `analysis/contract.md`만 공급된다.

자산 배치 원칙(2026-10-19, baton/docs/layout-and-contracts.md §1): `functions/`·`types/`·`schemas/`
트리는 두지 않고, 산출물 유형별 디렉터리 하나에 그 유형의 function 소스와 지침·계약·schema를 함께 둔다.
참조 배치는 `/Users/y/Github/shs/baton/solutions/`다.

## 배치

```text
baton/                              # apps.ymath.root
  analysis/                         # 산출물 유형별 디렉터리 (코드+자산 함께)
    functions.ts                    # App 소유 순수 function 소스(와이어 계약·프롬프트 조립·구조 검증)
    instruction.md                  # 모델 행동 규칙 + run 입력·종료 조건
    contract.md                     # 분석 JSON 구조·표기·가드레일의 유일 근원
    analysis.output.schema.json     # 출력 기계 schema
    analysis.input.schema.json      # 요청 매니페스트 기계 schema
  output-policy.yaml                # 결과 목적지(s3/R2)·키 정책
  README.md                         # 이 문서(모델 입력 트리 아님)
```

## 운영 소유권

- 공통 Runner 프로세스는 baton 레포가 소유한다. ymath는 별도 daemon·endpoint·tunnel을 두지 않는다.
- 등록: `baton/config/runner.cloud.json`의 `apps.ymath.root` (현재 `/Users/y/Github/ymath/baton`).
- 신뢰 adapter: `baton/src/ymath/`(정적 allowlist `baton/src/runner/apps.ts`의 `ymath` 바인딩).
- ymath 쪽 카탈로그: `baton/config/ymath.cloud.json` — App root·state·storage·profile 선언.
  endpoint·credential **값**은 저장하지 않고 env 변수명만 참조한다.

## 시작 절차 (OPERATOR ONLY — 이 문서는 실행하지 않는다)

1. baton 레포에서 현황 확인: `node src/runner/cli.ts plan` (read-only, Cloud 접촉 없음)
2. 기존 공통 Runner 프로세스·lease(`/Users/y/.config/baton/runner/runner.lock`)와 in-flight 실행 확인.
   경쟁 worker를 만들지 않는다.
3. 공통 시작 계약:
   `node --env-file=/Users/y/.config/baton/secrets.env src/runner/cli.ts connect`
   - `~/.config/baton/ymath/secrets.env`가 제공해야 하는 ymath 변수: `INNGEST_EVENT_KEY_YMATH`,
     `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `WORKER_CALLBACKS_URL`.
     LLM 설정은 ymath 파일에 두지 않는다 — 공통 `~/.config/baton/secrets.env`의
     `OMLX_API_KEY`·`OMLX_BASE_URL`·`OMLX_MODEL`(Qwen)과 `ZAI_API_KEY`·`ZAI_BASE_URL`·`ZAI_MODEL`(GLM)을
     `config/ymath.cloud.json`이 참조한다. 공통 env에 `LLM_*` 이름은 없다 — provider 별 네임스페이스만 쓴다.
     실행: `node --env-file=/Users/y/.config/baton/secrets.env --env-file=/Users/y/.config/baton/ymath/secrets.env --env-file=/Users/y/.config/baton/shs/secrets.env src/runner/cli.ts connect`
   - 값 자체를 명령·문서·로그에 쓰지 않는다.
4. Cloud sync 성공과 `execute` function 등록을 확인한 뒤에만 ymath에서 `ITEM_ANALYSIS_BACKEND=baton`으로 접수한다.

## 실행 흐름 요약

`ITEM_ANALYSIS_BACKEND=baton`일 때 ymath Worker가 분석 추론을 baton execute run으로 넘긴다:
매니페스트·이미지·OCR 참조를 담은 `ymath/item.baton.requested` 이벤트(stable ID) → Runner가 R2에서
입력을 읽고 LLM 호출·구조 검증 → 결과 JSON을 R2에 readback-verify 저장 → `ymath/item.baton.completed`
이벤트(작은 참조만) → ymath Worker가 R2/D1 최종화(기존 commitCloudResult 계약, guardrail 유지).
`llm.xcv.kr` 직접 경로는 flag로 보존된다(기본값 `runner`, 기존 `inngest` 불변).

## 금지

- 이 트리에 tmp·원 응답·결과·영수증 생성 (영수증은 Runner state `/Users/y/.ymath/baton-analysis`).
- endpoint·모델명·credential 하드코딩. `apps/` 계층 생성.
- 공통 Runner 프로세스를 ymath 전용으로 재시작하는 것(전체 drain 절차는 baton 규범 문서 참조).
