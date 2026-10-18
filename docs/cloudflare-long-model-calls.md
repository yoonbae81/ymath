# 긴 모델 호출 처리 — CF-only 재설계 초안

상태: 공식 문서 조사에 근거한 제안. 미구현·미배포·실제 provider 장시간 호출 미검증. 기존 host-runner 구조의 완료 주장을 대체하는 설계 초안이며, 최종 criteria 확정 전 dev 구현 검토가 필요하다. 이번 조사에서는 운영 데이터/키/CF 리소스를 변경하지 않았다.

## 확정된 요구

맥에는 기존 llm.xcv.kr 추론 API만 남긴다. ymath 전용 runner, 맥 polling, wake 서버는 두지 않는다. 애플리케이션 오케스트레이션은 CF가 담당한다. 이미지/OCR의 CF 실행 방식은 별도 검증 대상으로 남긴다.

## 제안: Cloudflare Workflows

1. 웹 Worker가 업로드를 R2에 저장하고 D1에 작업/instance ID와 상태를 기록한다. Workflow 시작 후 브라우저에 202와 job ID를 반환한다. D1 기록과 Workflow 생성은 하나의 원자 트랜잭션이 아니므로 deterministic instance ID, 재실행 안전성, 미기동 작업 복구를 설계한다.
2. Workflow가 전처리/OCR/프롬프트/LLM 호출/검증/최종 저장을 단계별 실행한다. 모델 API는 CF에서 llm.xcv.kr로 직접 호출한다.
3. 모델 단계는 step.do의 timeout을 명시한다. 문서 기본은 10분, 30분 설정 예제가 있다. 실제 timeout은 최장 입력의 첫 바이트/전체 응답 시간 프로브 후 결정한다. HTTP 클라이언트의 전체/유휴 timeout도 별도 설정한다.
4. 브라우저 연결이 끊어져도 Workflow는 독립 진행한다. UI는 D1 상태를 조회한다. 이는 맥이 CF 작업을 polling하는 방식과 다르다.
5. 큰 결과는 R2에 저장하고 단계 결과로 객체 키/해시 같은 작은 참조만 반환한다. Workflows의 일반 단계 결과 한도는 1MiB다.

## 반드시 따로 풀어야 할 HTTP 구간 제한

Workflow wall-clock과 llm.xcv.kr의 프록시/터널/게이트웨이 timeout은 별개다. 공식 524 문서는 Proxy Read Timeout 기본 125초를 명시한다. 실제 llm.xcv.kr의 구성/제한은 이번에 조회하지 않았다.

- LLM API가 지원한다면 stream:true로 SSE를 CF에서 소비하고, 최종 응답을 조립·검증한다. 브라우저가 스트림을 붙잡고 있을 필요는 없다.
- 첫 바이트 및 청크 간 무응답이 프록시 제한을 넘는지 측정해야 한다. stream:true 자체가 긴 prefill/추론 무응답을 해결하지는 않는다. reasoning 청크/heartbeat가 실제 전달되고 버퍼링되지 않는지도 확인한다.
- 긴 무응답을 현재 API가 피할 수 없다면 추론 API 자체의 스트리밍/비동기 추론 지원 또는 연결 경로 설정 변경이 필요하다. 이를 ymath runner로 우회하지 않는다. 현재 API 그대로 무조건 가능하다고 약속하지 않는다.

## 재시도와 정합성

- 429/일시 오류는 CF 측 durable retry/sleep으로 지연한다. 실패 종류별 상한을 둔다. step.do 기본 재시도 정책을 무비판적으로 쓰지 않는다.
- 모델 호출은 step 재실행 시 중복 추론 가능성이 있다. provider가 idempotency를 보장하지 않으면 정확히 한 번 추론을 주장하지 않는다.
- 결과 커밋은 job generation/삭제 여부를 검사하여 멱등 처리한다. timeout 후 늦은 응답/삭제 후 결과는 반영하지 않는다.
- provider 동시성 제한은 Workflows 자체가 자동 제공한다고 가정하지 않는다. CF 측 직렬화/lease 설계 및 복구를 검증한다.
- waitUntil만으로 긴 작업의 내구성을 보장하는 방식은 채택하지 않는다.

## 프로브 완료 기준 (아직 미실행)

- 실제 배포된 Workflow에서 긴 입력으로 모델 호출을 수행하고 첫 바이트/최대 청크 간격/총 시간을 기록한다. 외부 모델 사용·비용은 실행 전 사용자 승인 범위 확인.
- 브라우저 종료 후에도 결과가 D1/R2에 저장되고 재방문 시 조회된다.
- 429/연결 끊김/명시 timeout을 주입했을 때 CF 쪽에서 재시도/실패 상태를 유지한다.
- 같은 작업 재실행은 최종 반영 1회, 실행 중 삭제는 부활 0건이다. 중복 추론 횟수도 별도 기록한다.
- 맥에서 ymath 애플리케이션 프로세스 없이 기존 LLM API만 동작하는 상태로 위 경로를 통과한다.
- CPU·메모리·요청/상태 저장 비용을 실측한다. 네트워크 대기가 CPU가 아니라는 사실은 JSON 검증/이미지 처리까지 Free 한도에 맞는다는 증거가 아니다. 유료 전환은 별도 승인.

## 공식 근거

- Workflows limits: https://developers.cloudflare.com/workflows/reference/limits/ — step wall-clock 제한 없음, CPU 별도 한도, 일반 step 결과 1MiB.
- Step timeout/retry: https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/ — 기본 10분, 명시 timeout/retry 설정.
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/ — CPU와 I/O 대기 구분, 실행 컨텍스트별 제한.
- HTTP 524: https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/ — 프록시 기본 read timeout 125초. Workflow timeout을 늘려도 이 구간 제한이 자동 해제되지는 않는다.
