# Inngest 전환: Mac runner 없는 이미지 정규화·OCR 타당성

조사/로컬 실행: 2026-10-18 KST. **판정: 소형 fixture에서 순수 Worker/WASM 변환은 실증했으나, 기존 입력·화질 계약 전체를 그대로 대체할 준비는 안 됐다.** 이 문서는 구현 완료·배포 성공 보고서가 아니다.

## 1. 결론과 권고

- `sharp`가 Workers에서 실행되지 않는다는 이유로 Mac 애플리케이션 runner가 필요한 것은 아니다. 이미지 변환은 CF Images binding 또는 Worker-compatible WASM으로 분리할 수 있다. **Mac에는 기존 추론 API만 남긴다. poller/wake/별도 OCR runner는 제안하지 않는다.**
- 현재 OCR도 로컬 Paddle 라이브러리를 실행하는 코드가 아니라 **OpenAI 호환 HTTP 추론 요청**이다. 이미지 읽기·base64·프롬프트·응답 정리는 CF로 옮기고, 승인된 기존 추론 모델의 HTTP 호출을 Inngest infer로 분리하는 것이 가장 작은 변경이다. 단, **기존 API가 OCR 모델을 실제 제공하는지는 미확인**이다.
- 정상 JPEG/PNG/WebP 처리의 우선 후보는 **기존 R2 + CF Images Free transformations binding**이다. 공개 이미지 URL이나 Images 유료 저장소는 필요 없다. 공식 문서는 월 5,000 unique transformations 무료 및 초과 시 새 변환 오류를 명시한다. 이번에는 계정 활성화·binding 추가·원격 호출을 하지 않았다.
- **TIFF는 Images 공식 지원 목록에 없다.** TIFF를 계속 받으려면 별도의 decoder가 필요하다. Photon WASM은 합성 LZW TIFF를 실제 디코드했다. 하지만 전 픽셀 RGBA를 만드는 이 경로로는 기존 50Mpx 전체 범위를 보장할 수 없다.
- 즉시 필요한 사용자 결정은 하나의 **입력 호환성 정책**이다. `TIFF + 50Mpx + 현행 25MiB/긴 이미지 허용`을 모두 유지할지, 초기 CF 경로의 제한을 허용할지다. **유료 전환이나 OCR 품질 저하를 먼저 승인받을 필요는 없다.** 현행 계약 유지가 필수면 이 spike를 완료 판정으로 쓰지 말고 메모리 절약 decoder를 추가 검증해야 한다.

## 2. 읽은 실제 코드와 계약

### 이미지

근거: `src/lib/server/image.ts:14–79`, `image.test.ts:17–75`.

1. 최소 12바이트 및 JPEG/PNG/WebP/classic TIFF 양쪽 endian magic 검사.
2. `sharp(input, { failOn: 'error', limitInputPixels: 50_000_000 })`; metadata에서 허용 format과 양수 width/height 재확인.
3. `.rotate()`로 EXIF 방향 및 mirror 보정.
4. `.resize({ width:1600, height:1600, fit:'inside', withoutEnlargement:true })`.
5. `.grayscale().jpeg({quality:80, mozjpeg:true})` → 단일 `image.jpg`. 원본색/EXIF를 보존하는 출력이 아니다.

업로드 별도 계약: `src/routes/api/upload/+server.ts:12,28–36`은 **25 × 1024 × 1024바이트** 제한. CF 업로드는 raw R2 저장/큐 등록까지만 하고, 주석과 현재 구현은 Node runner의 검증·정규화를 전제로 한다. `cloudflare/runner.ts:81–97`은 실제 `processImage()` 및 grayscale 검증을 수행한다. `:127–137`에서 OCR→분석을 실행하므로 이 잔류 경로를 제거해야 한다.

중요한 기존 테스트 조건은 단순 desaturation 표시가 아니라 **출력 JPEG를 다시 디코드했을 때 RGB 채널 값이 같음**이다. EXIF 6뿐 아니라 mirror 방향도 고려해야 한다. TIFF 모든 압축·다중 페이지·색 공간을 테스트가 보장하는 것은 아니다. 현행 `.rotate()`/기본 sharp 옵션은 전체 문서를 다중 페이지 OCR하는 계약이 아니다.

### OCR

근거: `src/lib/server/ocr.ts:10–79`, `config.ts:62–66`, `queue.ts:92–107`, `cloudflare/runner.ts:127–137`.

- `readLlmProviders().omlx`에서 주소/키를 얻고 `image.jpg`를 읽는다. **설정 파일은 조사 중 읽지 않았다.** 코드상 의존성만 확인했다.
- `POST /chat/completions`, system + user의 `image_url: data:image/jpeg;base64,...`와 텍스트, `max_tokens:8192`, `temperature:0`, `stream:false`.
- `OCR_MODEL` 기본값은 **`PaddleOCR-VL-1.6-mlx`**, 기본 timeout은 2분이다. 설정값/실제 서버 로드 상태는 확인하지 않았다.
- `choices[0].message.content`의 문자열 또는 text part 배열을 Markdown으로 모은 뒤 `<|LOC_n|>` 토큰을 지우고 빈 결과는 실패 처리한다.
- 기존 큐는 OCR 실패 시 빈 OCR로 분석을 계속한다. Cloud runner도 catch 후 빈 문자열로 계속하고 `ocr_missing`을 설정한다. **이 폴백은 분석 모델의 실제 vision 지원이 전제**다. vision이 미확인인 상태에서 성공처럼 진행하면 안 된다.

### 분석/LLM

근거: `analyze.ts:78–113,142–178`, `llm.ts:159–172,274–292`.

- 분석 프롬프트에는 참고용 OCR와 사진 직접 확인 지시가 함께 들어간다.
- oMLX 분석 요청도 `image_url` data URL을 첨부한다. 즉 OCR가 있다고 이미지 첨부를 제거하는 것은 현행 분석 계약 변경이다.
- `llm.ts`의 “Qwen3.6 ... 멀티모달” **주석은 capability 증거가 아니다**. 요청을 만들어 보내는 코드만으로 이미지가 처리된다고 판정할 수 없다.
- 제공받은 현재 모델명 **Qwen3.6-35B-A3B**만으로는 oMLX의 실제 로드 구현, vision processor, 이미지 무시 여부, 한국어 수식 OCR 능력을 알 수 없다. 이번에 모델 목록 조회·원격 추론·모델 다운로드를 하지 않았다.
- 현재 `inngest-slice/app.ts`의 `infer-text`는 문자열 user message다. 텍스트 infer 성공을 이미지/OCR 지원 성공으로 확장 해석하면 안 된다.

## 3. 후보별 계약 보존/차이

| 요구 | CF Images binding | Photon + jSquash Worker/WASM |
|---|---|---|
| JPEG/PNG/WebP | 공식 지원. production 미실행 | 합성 3포맷 decode/encode 실제 성공 |
| TIFF | 공식 지원 목록에 없음. 지원 전제로 설계 금지 | 합성 단일 LZW TIFF 실제 성공. BE/다중페이지/CCITT/JPEG-in-TIFF/CMYK 등 전체 호환 미검증 |
| EXIF rotate/mirror | 공식 문서는 metadata 제거 시에도 EXIF rotation 적용 명시. 고충실도 회귀 필요 | 기본 decoder만 믿을 수 없음. EXIF 파싱+명시적 픽셀 매핑 필요. JPEG 1–8, PNG/WebP/TIFF orientation 6 fixture 확인 |
| 50Mpx 초과 사전 거절 | 서비스 일반 영역 제한은 100MP이므로 **앱 자체 50Mpx 검사 필요**. `.info()` 또는 검증된 header parser 사용; TIFF는 info 지원 안 됨 | header parser로 50,005,000px JPEG를 decode 전 413 처리. **50Mpx 이하 전부 처리 가능하다는 의미 아님** |
| 50Mpx 이하 처리 | 일반 지원 포맷은 후보이나 20MB binding 및 문서상 12,000px 변 제한 등 추가 제약 | 50Mpx RGBA 하나가 200,000,000B = 약 190.7MiB로 Worker 128MB 초과. 이 구현의 전 범위 보존 불가 |
| 1600 inside/noenlarge | `width:1600,height:1600,fit:'scale-down'`에 대응 | 명시적 min(1,1600/w,1600/h), Lanczos3 resize. 2400×1800→1600×1200, 80×40 유지 확인 |
| grayscale | `saturation:0` 공식 기능. sharp와 luminance/ICC/alpha 및 채널 동등성 별도 비교 필요 | Photon 단독 JPEG는 채널 최대 차이 2 발생. jSquash MozJPEG GRAYSCALE 출력으로 fixture 채널 차이 0 확보. **명도 계산 자체는 sharp와 다름** |
| JPEG quality80/mozjpeg | `format:'image/jpeg',quality:80`. encoder/quality 수치가 sharp와 동치라는 보장 없음 | jSquash MozJPEG `quality:80,color_space:1`. 같은 codec 계열이어도 버전/옵션/입력픽셀 차이로 byte parity 보장 안 됨 |
| 투명 PNG/ICC/색 공간 | 기본 background는 white이므로 sharp의 실제 alpha 처리와 비교 후 명시해야 함 | 투명 빨강 fixture는 현 prototype 85, sharp 0. ICC/감마 미보존. 그대로 채택 금지 |
| 현행 25MiB upload | binding input 최대 **20MB**. 단위 차이와 20MB 초과 기존 유효 입력의 거절 정책 필요 | compressed bytes뿐 아니라 decoded/intermediate memory 제한이 필요 |
| 신규 요금 | Images Free 범위에서 가능하다는 문서 근거. 계정 현재 상태 미조회. Free 한도 초과 시 오류; 유료 전환 자동 제안/실행 안 함 | 별도 이미지 SaaS는 불필요. Worker CPU/메모리 때문에 무료 실행 보장은 못 함 |

`@jsquash/*`만의 경로는 JPEG/PNG/WebP codec/resize를 조합할 수 있지만 TIFF와 EXIF, alpha/색 공간 정책은 별도다. 이번 실행에서는 Photon이 4개 입력 decoder+resize를 맡고 jSquash가 grayscale JPEG를 출력했다.

`wasm-vips`는 streaming pipeline의 장점이 있지만 현재 upstream README는 SharedArrayBuffer를 요구하고, upstream의 CF 실험은 shared Wasm memory/threads 부재로 실패를 명시한다. **Node/브라우저 WASM이라는 이유만으로 Workers 대체품으로 선정하지 않는다.** 커스텀 single-thread 빌드는 별도 연구이며 이번에는 설치·실행하지 않았다.

## 4. 실제 실행 증거: 순수 Worker/WASM

독립 작업 디렉터리:

`/Users/y/.hermes/profiles/plan/cache/scratch/ymath-image-ocr-probe/`

설치: 이 디렉터리에만 `npm install --ignore-scripts --no-audit --no-fund` 사용. 저장소 package/lock/config/source는 수정하지 않았다.

- `@cf-wasm/photon 0.4.0`, `@jsquash/jpeg 1.6.0`, `exifr 7.1.3`, `image-size 2.0.4`, `miniflare 4.20260730.0`.
- Node harness는 기존 repo의 sharp로 **합성 도형 픽셀 fixture 생성 및 출력 검증만** 수행한다. 앱 runner는 실행하지 않았다.
- 실제 변환은 **Miniflare/workerd ES module + 정적 CompiledWasm** 내부에서 수행했다. `nodejs_compat` 없이 실행했고 user Worker의 outbound fetch는 403 반환 서비스로 차단했다. sharp/native/fs는 user Worker 실행 경로에 없다.
- Worker JS 210,275B, Photon WASM 1,566,855B, MozJPEG WASM 251,524B. browser-target bundle 및 제한 import 검사 통과. 이 standalone 검사는 앱의 전체 Wrangler bundle gate를 재실행한 것이 아니다.

재현:

```sh
node /Users/y/.hermes/profiles/plan/cache/scratch/ymath-image-ocr-probe/probe.mjs
/Users/y/Github/ymath/node_modules/.bin/tsx /Users/y/.hermes/profiles/plan/cache/scratch/ymath-image-ocr-probe/reference.mts
node /Users/y/.hermes/profiles/plan/cache/scratch/ymath-image-ocr-probe/binding-probe.mjs
```

결과 파일:

- `output/results.json`: **25 case = 변환 성공 23 + 의도한 거절 2**. 성공 23개 모두 sharp reference와 크기 일치 및 decoded RGB 최대 채널 차이 0.
- JPEG EXIF 1–8을 비대칭 neutral fixture로 추가 검증: **8개 모두 네 모서리 픽셀 순서/값이 sharp reference와 일치**. 단순 width/height 비교만으로 mirror 성공을 주장하지 않았다.
- JPEG/PNG/WebP/TIFF orientation 6: 모두 400×200→200×400. TIFF는 합성 LZW 단일 이미지다.
- 2400×1800 PNG: 1600×1200 JPEG, 마지막 로컬 실행 wall time 339ms. 작은 WebP 80×40은 그대로 유지.
- 50,005,000px 정상 JPEG: 413 `pixel limit before decode`; 비이미지: 422. 50Mpx 경계 이하 대형 decode를 실행해 OOM을 유발하는 실험은 하지 않았다.
- `output/actual-contract-results.json`: **실제 저장소 `processImage()`를 읽기 전용 import하여** 4포맷 reference를 재실행. probe의 sharp reference와 byte-identical 및 oversize/invalid 거절 확인.
- `output/baseline-results.json`: 최초 Photon 단독 JPEG encoder 결과. WebP EXIF 누락/최대 채널 차이 2가 있었음을 보존했다. WebP RIFF EXIF chunk를 별도 추출하고 MozJPEG grayscale로 변경해 후속 실행에서 교정했다.

**통과하지 않은 동등성**도 중요하다. 최종 colored fixture의 모서리 grayscale 평균 절대차는 sharp 대비 약 35 전후, resize fixture는 43이었다. 이는 전체 픽셀 품질 지표가 아니라 네 모서리 샘플 비교지만, 명도 변환을 그대로 대체할 수 없다는 충분한 반례다. 투명 PNG도 불일치한다. 재현 코드는 feasibility용이며 exif 오류 무시, header parser 범위, animation, malformed input, 메모리/동시성, 색 공간을 production 수준으로 보강하지 않았다.

wall time은 harness 왕복/초기화를 포함하며 **CF CPU 계측치가 아니다**. Workers 문서의 128MB 및 Free HTTP CPU 10ms 한도가 적용되므로 로컬 성공으로 Free 배포를 보장하지 않는다. Inngest step으로 나눈다고 이미지 decode의 isolate 메모리 한도가 사라지지도 않는다.

## 5. Images binding 로컬 probe: 실제 서비스와 구별

`output/binding-results.json`에 **offline low-fidelity mock** 결과를 저장했다. `--remote`, Cloudflare credential, 원격 리소스는 사용하지 않았다.

- `IMAGES.info()`는 JPEG/PNG/WebP의 400×200 및 MIME/fileSize를 반환했다.
- 같은 입력에 `fit:'scale-down',saturation:0,metadata:'none'` 및 JPEG quality80을 요청했지만 **400×200의 컬러 출력**이었다. EXIF 6 auto-orient도 적용되지 않았다. 최대 채널 차이는 JPEG 226, PNG 224, WebP 229.
- TIFF `info()`는 422 unsupported type. 반면 mock transform은 TIFF를 JPEG로 바꾸었다. **mock transform 성공을 production TIFF 지원 근거로 사용하면 안 된다.**
- 문서가 명시하는 local mock 범위는 width/height/rotate/format뿐이다. 이 실행은 API wiring의 로컬 증거이지 saturation/quality/auto-orient의 production 증거가 아니다.
- mock host가 내부 sharp를 사용하면서 repo sharp와 libvips dylib 중복 경고가 발생했다. 프로세스는 정상 종료했고 user Worker에 sharp를 추가한 것이 아니다. 이후 binding probe 재현 시 한 버전의 sharp만 host에 로드하도록 격리하면 경고를 줄일 수 있다.

초기 실행 문제는 scratch에서만 해결했다: sharp entrypoint 직접 경로 대신 package resolver 사용, esbuild absWorkingDir 명시, installed workerd가 허용하는 `2026-08-06` compatibility date 사용, TS harness를 `.mts`로 변경. 저장소 설정을 바꾸어 우회하지 않았다.

## 6. OCR 경로 비교와 최소 변경안

### 권고: 기존 추론 API를 호출하고 애플리케이션 로직만 CF에 배치

```text
raw R2 → CF 검증/정규화 → normalized R2
      → CF OCR 요청 조립 → Inngest infer → 기존 승인된 LLM API (추론만)
      → CF content/LOC/empty 처리 → OCR R2 + D1 상태
      → CF 분석 프롬프트/이미지 첨부 → infer → CF schema/guardrail → R2/D1
```

- 파일 경로·Node fs·설정 파일 읽기를 CF binding/secret interface로 대체한다. **실제 secret을 읽는 작업이 아니라 후속 구현 경계**다.
- OCR 모델/endpoint를 명시적으로 선택하며 `Qwen3.6-35B-A3B`로 조용히 치환하지 않는다. 기존 Paddle 모델이 실제 서비스되는지, 이미지가 처리되는지, 한국어/인쇄수식/손글씨 성능을 **사용자 승인 후 합성 fixture 원격 평가**로 확인해야 한다.
- 현재 2분 timeout, body 구조, LOC 정리, 빈 결과 오류와 `ocr_missing`/재분석 OCR 재사용을 유지한다. Inngest 재시도와 D1 generation fencing에 맞춰 normalized/OCR 결과를 먼저 멱등 저장하여 재시도마다 변환/추론하지 않게 한다.
- OCR 실패 폴백은 검증된 vision analyzer에만 허용한다. 그것도 미확인이라면 실패/보류가 정직한 상태다.
- infer에는 이미지 base64와 응답이 전달된다. R2를 private으로 둬도 payload가 Inngest를 경유한다는 데이터 경계를 문서화해야 한다. event에는 ID만 넣고 step 결과에도 큰 이미지 base64를 영구 중복 저장하지 않는 설계를 검토한다.

이 경로는 “OCR 전체를 CF CPU에서 수행”하는 것은 아니다. **CF에서 OCR 업무 로직을 수행하고 Mac은 허용된 기존 모델 추론만 제공**한다. OCR 모델이 현재 API에 없다면 자동으로 추가 서버/모델을 올릴 수 없다.

### 순수 CF CPU OCR: Tesseract.js/WASM

- Tesseract.js upstream은 browser/Node 지원을 명시한다. 기본 Node 경로는 `worker_threads.Worker`, browser 경로는 `Worker`/Blob/importScripts를 사용한다. **Web Worker 지원과 Cloudflare Worker 지원은 다르므로 기본 createWorker를 그대로 도입할 수 없다.**
- core를 직접 초기화하고 정적 Wasm·언어데이터·가상 FS를 통합하는 별도 포팅을 검토할 수 있지만 이번에는 인식 엔진을 실행하지 않았다. 따라서 “CF OCR 성공”이나 오류율을 주장하지 않는다.
- 메모리/CPU 제한, 한국어 언어데이터, 손글씨/수식/Markdown 전사와 기존 Paddle 계열 의미적 계약을 따로 검증해야 한다. 일반 텍스트 OCR 데모 통과만으로 수학 OCR 대체를 승인할 수 없다.
- CF Images는 OCR 서비스가 아니다. Workers AI/새 OCR SaaS/Containers로 문제를 옮기는 안은 이번 신규 서비스·비용 금지 범위에서 선택하지 않았다.

## 7. 후속 구현의 승인/검증 게이트

1. **입력 정책 하나 결정:** TIFF를 포함한 현행 전체 호환을 유지할지, 초기 JPEG/PNG/WebP + binding byte/dimension 제약을 허용할지. TIFF 소형 WASM fallback은 가능성이 있지만 전 범위 보존책은 아니다. 조용히 지원 형식을 줄이지 않는다.
2. Images Free 사용이 허용되면 현재 계정 상태와 무료 한도를 별도 승인된 절차로 확인하고 production synthetic fixture에서 EXIF 1–8/PNG/WebP, grayscale, alpha, resize/noenlarge, 50Mpx 경계, 20MB, 긴 변 제한, 오류/quota 경로를 검증한다. 유료 자동 전환은 하지 않는다.
3. WASM fallback을 구현한다면 먼저 grayscale/ICC/alpha를 sharp와 맞추고, decoder memory·동시성·페이지/animation 정책·malformed corpus를 검사한다. 현재 prototype의 큰 명도 차이를 사용자 품질 타협으로 넘기지 않는다.
4. 기존 추론 API에서 승인된 OCR/vision capability 확인 전 item 분석을 완료로 표시하지 않는다. 공개 모델명/주석/텍스트 infer 성공은 확인을 대체하지 못한다.
5. 이후 앱 Worker bundle gate에 native/Node runner 유입 금지를 유지하고, local D1/R2와 Inngest 재개/fencing/실패 재시도를 검증한다. 보고서 이관 담당 agent의 소스에는 이 조사에서 손대지 않았다.

## 출처

코드는 위 경로/라인을 직접 확인했고, repository/부모 경로 및 docs/src 상위의 AGENTS.md·CLAUDE.md를 확인했으나 해당 지침 파일은 없었다. 관련 `cloudflare-migration-planning`, `spike` skill을 참고했다. 외부 문서는 조사 시점 공개 문서이며 계정 entitlement의 증거는 아니다.

- [Images binding/API/local mock](https://developers.cloudflare.com/images/optimization/binding/)
- [Images 입력 포맷/변·영역·binding 20MB 제한](https://developers.cloudflare.com/images/get-started/limits/)
- [fit/saturation/metadata/EXIF/quality/background](https://developers.cloudflare.com/images/optimization/features/)
- [Images Free/Paid 및 월 unique 변환 요금](https://developers.cloudflare.com/images/pricing/)
- [Workers CPU/메모리 제한](https://developers.cloudflare.com/workers/platform/limits/)
- [Photon workerd 사용 및 메모리 경고](https://github.com/fineshopdesign/cf-wasm/tree/main/packages/photon)
- [Photon codec features: TIFF 포함](https://raw.githubusercontent.com/fineshopdesign/cf-wasm/main/packages/photon/crate/Cargo.toml)
- [jSquash Workers 정적 WASM 예제](https://github.com/jamsinclair/jSquash/tree/main/examples/cloudflare-worker-esm-format)
- [wasm-vips](https://github.com/kleisauke/wasm-vips), [upstream CF 실험의 현재 제한](https://github.com/kleisauke/cf-worker-wasm-vips)
- [Tesseract.js 지원/범위](https://github.com/naptha/tesseract.js), [Node spawnWorker](https://raw.githubusercontent.com/naptha/tesseract.js/master/src/worker/node/spawnWorker.js), [browser spawnWorker](https://raw.githubusercontent.com/naptha/tesseract.js/master/src/worker/browser/spawnWorker.js)

## 변경 범위

저장소에는 **이 새 문서만 작성**했다. 실험 파일/독립 package와 lock/출력 fixture/JSON은 scratch에만 있다. 기존 문서·앱 코드·package·Wrangler 설정을 변경하지 않았다. 실제 사용자 이미지/데이터/credentials/providers.json을 읽지 않았고, 실제 LLM 호출·Mac runner·poll/wake·commit/push/deploy·원격 리소스 생성·유료 전환을 수행하지 않았다.
