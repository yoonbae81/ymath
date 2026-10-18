# Workers AI Asynchronous Batch API — ymath 적합성 조사

## 결론

- **기존 llm.xcv.kr/oMLX를 추론 제공자로 유지한다면 직접적인 해결책이 아니다.** 문서상 Workers AI Batch API는 지원 모델을 지정해 Workers AI에서 추론을 실행하는 서비스이지, 임의의 외부 HTTPS 추론 API를 비동기 job으로 바꿔주는 범용 중개 서비스가 아니다.
- **추론 제공자를 Workers AI의 Batch 지원 모델로 교체할 수 있다면 적합한 후보다.** 즉시 request_id 반환 → 나중에 결과 조회라는 요구를 제품 자체가 제공하므로, CF→oMLX 장시간 연결 문제는 해당 호출 경로에서 제거된다. 모델 품질/비용/입력 지원 범위를 별도 검증해야 한다.
- 공식 계약은 결과 polling이다. 검토한 Batch 문서에는 완료 callback 등록 방법이 없다. callback 제품으로 설명하지 않는다. CF Workflow가 sleep 후 상태를 조회하도록 구성할 수 있으며 Mac polling은 필요 없다.

공식 문서 조사 결과이며 미구현·미배포·모델 호출 미실행이다. 계정별 가용성/요금은 확인하지 않았다. 신규 구조의 구현 난이도는 dev 검토 전 미확정이며 UI 변경은 이 조사 범위 밖이다.

## 공식 문서가 제공하는 동작

Workers binding 예시는 다음 형태다(문서 기반 설명이며 실행하지 않음).

```ts
const accepted = await env.AI.run(
  '@cf/moonshotai/kimi-k2.5',
  { requests: [{ messages: [{ role: 'user', content: '...' }] }] },
  { queueRequest: true },
);
// accepted.request_id를 영속 저장
const status = await env.AI.run('@cf/moonshotai/kimi-k2.5', {
  request_id: accepted.request_id,
});
// queued/running이면 나중에 다시 조회. 완료 시 항목별 성공/실패를 검사.
```

- 즉시 응답: status=queued, model, request_id.
- 접수는 Worker binding 또는 REST API로 가능하다.
- 완료 응답은 개별 입력에 해당하는 responses 및 항목별 success를 포함한다. 전체 HTTP 200만 보고 모든 항목 성공으로 처리하면 안 된다.
- Workers Binding 문서의 전체 payload 제한은 **10 MB 미만**이다. 기존 업로드 이미지 크기 제한과 동일시하지 않는다. 이미지 포함 방식/배치당 바이트/정규화 처리는 별도 설계 사항이다.
- `external_reference`는 입력별 상관관계 식별자이며 응답에 돌아오는 값이다. 외부 모델 URL이나 callback URL이 아니다.
- 지원 모델은 Batch capability가 있는 모델을 확인해야 한다. 전체 Workers AI 모델이 모두 Batch 지원이라고 가정하지 않는다.

## 모델 교체 후보의 근거와 한계

Cloudflare의 2026-03-19 Kimi K2.5 공지는 `@cf/moonshotai/kimi-k2.5`에 대해 vision, structured outputs 및 해당 모델을 이용한 Async Batch 예시를 명시한다. 따라서 embedding 전용 기능은 아니다.

다만 동일 공지의 vision 지원 설명만으로 ymath 사진 입력/JSON Schema/출력 길이가 Batch 경로에서 모두 원하는 방식으로 동작한다고 확정하지 않는다. 실제 합성 수학 입력으로 프로브해야 한다. 문서의 내부 테스트상 보통 5분 내 실행된다는 설명은 SLA나 완료 상한이 아니므로 사용자 응답 시간 보장으로 쓰지 않는다.

## AI Gateway와의 혼동 방지

AI Gateway Custom Providers는 self-hosted HTTPS 모델을 등록하고 관측/캐싱/rate limiting 등을 적용할 수 있다. 그러나 이 사실은 Workers AI Batch API가 custom provider를 비동기 실행한다는 근거가 아니다. 검토한 Batch API의 입력/실행 계약에 llm.xcv.kr 같은 upstream URL 지정 기능은 없다.

## 현재 요구에 대한 두 경로

1. **oMLX 유지:** Workflows가 기존 API를 호출하고 streaming/keepalive를 소비하는 경로를 검증한다. 필요하면 CF에 중개 Workflow를 두되, Batch API를 그대로 가져다 쓰는 대안은 아니다. 기존 조사: `docs/cloudflare-inference-broker.md`.
2. **Workers AI로 추론 이전:** 애플리케이션 Workflow → Batch 접수 → request_id 저장 → sleep/상태 조회 → 결과 영속화/검증 → 다음 단계. 이 경우 Mac은 해당 추론의 의존성에서 제외된다. 제공자 변경은 사용자 승인 전 실행하지 않는다.

## 채택 전 검증 기준 — 미실행

- [ ] 사용 모델의 현재 Batch 지원과 계정 가용성/요금을 확인한다.
- [ ] 합성 텍스트 1건의 접수가 request_id를 반환하고 동일 ID 조회로 완료 결과를 얻는다.
- [ ] 합성 수학 이미지 1건으로 입력 방식·payload 제한·출력 schema 준수·수학 판정 품질을 검증한다.
- [ ] queued/running 대기와 항목별 실패를 구별하고, 명시적 최대 대기/재시도 정책을 적용한다.
- [ ] 브라우저 종료 후 CF의 결과 수거가 계속되고, 중복 조회/재개에도 DB 결과는 중복 확정되지 않는다.
- [ ] 접수 응답 유실 시 재접수에 따른 중복 추론 위험, 결과 조회 가능 기간, 비용을 확인한다.
- [ ] 이미지 정규화·OCR·후처리까지 포함한 전체 클라우드 경계를 별도 검증한다. Batch 도입만으로 이 작업들이 해결된다고 하지 않는다.

## 근거

- https://developers.cloudflare.com/workers-ai/features/batch-api/ — 비동기 접수/ID/조회 및 지원 모델 범위.
- https://developers.cloudflare.com/workers-ai/features/batch-api/workers-binding/ — queueRequest, 10 MB, 상태 조회 및 항목별 결과.
- https://developers.cloudflare.com/workers-ai/features/batch-api/rest-api/ — request_id와 external_reference 계약.
- https://developers.cloudflare.com/changelog/post/2026-03-19-kimi-k2-5-workers-ai — Kimi Batch 예시, vision/structured outputs, 비보장 지연 설명.
- https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/ — 외부 HTTPS 모델용 AI Gateway와의 제품 경계.
