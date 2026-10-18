# Cloudflare D1/R2 local implementation results

## Scope and boundary

The local implementation now covers the Worker CRUD paths, durable item and report jobs, private R2 objects, and the standalone Node runner. The first report implementation checkpoint was expanded with D1 acceptance/cache/retry/delete/list/detail/status, R2 artifact storage, lease fencing, and report generation from the D1 claim snapshot.

No commit, push, remote deployment, Cloudflare resource change, paid-plan change, operating snapshot read, actual user-data/config/provider-credential read, or external OCR/LLM call was made. `drop5-files` was not read or changed. All Wrangler and migration data used TEST-ONLY fixtures in local scratch directories. The local report and analysis fixtures are not evidence of a real provider run.

Authentication follows the latest user requirement: anonymous family CRUD, with no app login, Access integration, LAN/cookie auth, guest, or share semantics. The public exposure is documented in [cloudflare-access-auth.md](cloudflare-access-auth.md). Zero Trust remains a later user-configured deployment step.

## Verified local gates

- `npm test`: **PASS**, 26 test files / 339 tests, including >50M-pixel input rejection, 25 MiB upload bounds, EXIF orientation, grayscale JPEG output, <=1600 px normalization, bounded runner poller concurrency, quota retry defaults, and Worker missing-D1 503 behavior. Log: `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-cloudflare-vertical/npm-test-final.log`.
- `npm run check`: **PASS**, 0 errors / 0 warnings. Log: `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-cloudflare-vertical/npm-check-final.log`.
- `npm run build`: **PASS**. The build runs a real `wrangler deploy --dry-run` into a temporary local scratch directory and checks the complete bundled Worker output. It contains no sharp/native image code, Node filesystem/path imports, child-process/CLI code, persistent filesystem writes, or native addon. Log: `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-cloudflare-vertical/worker-build-final.log`.
- `npm run build:node` and `scripts/test-node-isolated.mjs`: **PASS**. Isolated `/math/items` and `/math/api/items` returned 200, retired login returned 410, the isolated store was empty, and there were zero provider calls. Log: `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-cloudflare-vertical/node-build-final.log`, `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-cloudflare-vertical/node-runtime-final.log`.
- `scripts/test-cloudflare-local.mjs`: **PASS** against local Wrangler D1/R2. In addition to upload, normalization, analysis/report, retry, lease fencing, deletion, CSRF, and bearer checks, the E2E read the committed TEST-ONLY OCR text directly from local R2, confirmed an item reanalysis claim returned that exact text, and confirmed item deletion removed the R2 OCR object. It also concurrently leased two distinct provider lanes from real local D1 while same-provider claims remained serialized. The fixture runner was one-shot, loopback-only, and TEST-ONLY. Transcript: `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-cloudflare-vertical/wrangler-e2e.log`; summary: `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-cloudflare-vertical/wrangler-e2e-final.log`.
- `npm run test:migration`: **PASS**, 3 tests. Local Wrangler D1/R2 imported source OCR into `entities.ocr_key`; rollback exported the current OCR object after its content changed post-cutover. The integration fixture also compared all source SHA-256 values, preserved post-cutover feedback/favorite/read/report/item/image writes, and kept deletions empty in export. Log: `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-cloudflare-vertical/migration-test-final.log`.
- `npx tsx scripts/cloudflare-list-benchmark.mjs`: **PASS**, 1,000 local D1 items, one query per list (12 samples), 36,000 rows read total across the samples; p50 32.6 ms and p95 45.2 ms in this local run. This measures only a local fixture, not production latency or CPU. Log: `list-benchmark.log`.

All evidence logs are under `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-cloudflare-vertical/`. They contain local fixture output only.

## Runtime details verified

- Worker runtime selection is a Vite compile-time constant. The final Wrangler bundle scan traverses the actual dry-run artifact, not only SvelteKit's wrapper entry. Node-only queue/store/config/report/taxonomy/image/LLM modules remain available to the separate Node build and are removed from the Worker bundle.
- D1 list hydration merges favorite/read/feedback columns using a single joined query. The 1,000-row local fixture measured one query per list.
- Item claims return the stored provider, current D1 record, feedback, up to 60 confirmed pattern examples from the current JSON schema, and cached OCR text capped at 1,000,000 characters. New OCR text is stored as a private R2 object referenced by `entities.ocr_key`; result commits include the live job lease and entity generation fence. Reanalysis reuses the cached text, missing OCR continues through the existing empty-text fallback, and deletion removes the OCR object.
- The default Node poller runs four bounded claim loops concurrently; D1 prevents active work for the same provider while allowing different providers to proceed. Runner 429/rate-limit failures use `QUOTA_RETRY_DELAY_MS`, defaulting to the legacy 600,000 ms (600 seconds).
- Worker page loaders for items, areas, upload, and status return 503 when the required D1 binding is absent. D1 transport errors in the status loader retain its storage-error state so the UI can show stale data and retry.
- Reports use the legacy period/fingerprint cache behavior. Their metadata and status live in D1; Markdown artifacts live in private R2 and are only returned through same-origin app APIs. Report claims include the current D1 report and matching current D1 item snapshot. Result commits require a live lease, entity generation, and non-tombstoned report.
- Permanent item failure clears the raw-object reference and removes the raw object. Item tombstones remove current images, raw objects, saved analysis objects, and job result objects. Report tombstones cancel active jobs and remove the report artifact.
- Cloud report calendar filtering uses Asia/Seoul day/month boundaries to match the existing Node report behavior on the configured host.

## Not verified and not authorized in this stage

- No real OCR/LLM or provider credential was used. Provider configuration correctness and model quality remain unverified.
- No Cloudflare account plan/usage audit or current operating-data snapshot was performed. The local 1,000-row fixture does not establish account quota headroom.
- No real D1/R2 resources, production data import, Access/Zero Trust policy, deployment URL, or public deployment was created. The deployment gate is still open; local pass results do not mean deployed or production-ready.
- Snapshot ID/count/object-hash parity and rollback were tested with synthetic local fixtures, not an operating user snapshot.

## Reproduction commands

```sh
npm test
npm run check
TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch npm run build
npm run build:node
TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch node scripts/test-node-isolated.mjs
TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch node scripts/test-cloudflare-local.mjs
TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch npm run test:migration
TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch npx tsx scripts/cloudflare-list-benchmark.mjs
```

## Deployment target (configured, not deployed)

`wrangler.toml` now targets the CF-native route **`xcv.kr/math*`** (zone route, `workers_dev = false`). Deployment, real resource creation, and the runner rollout are user-executed steps; the exact procedure lives in [cloudflare-deploy-runbook.md](cloudflare-deploy-runbook.md).

## Final bounded reliability pass (2026-10-17)

This pass fixed the four remaining issues from `ymath-final-review-second.txt` and preserved the earlier `ocr_key` migration, OCR cache, bounded pollers, 600-second default quota retry, missing-binding 503 behavior, and migration rollback coverage.

- **A — expired report lease:** the D1 lease reaper now updates `report_json.status/error` together with entity status when the fifth lease expires. The original probe was RED at `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-report-expiry-red.log`; the same probe is GREEN at `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-cloudflare-vertical/ymath-report-expiry-green.log`. Permanent regression: `src/lib/server/cloudflare/jobs.test.ts`. Local Wrangler D1 E2E also expires a fifth report lease and verifies both metadata fields become `failed`.
- **B — normalized photo durability:** the runner now persists the policy-checked JPEG through an authenticated, lease-fenced endpoint before OCR/analysis. The D1 image reference is committed before raw cleanup. Retry claims use the saved JPEG bytes directly, avoiding another lossy JPEG conversion. The TEST-ONLY standalone Node runner is injected to fail immediately after normalization; the local D1/R2 E2E verifies the JPEG remains displayable, raw R2 is removed, retry completes, and before/after JPEG bytes are identical. It does not call real OCR or LLM providers.
- **C — uncertain D1 commit outcomes:** item/report result handlers verify authoritative D1 references before deleting newly staged R2 keys after batch or put errors. If verification itself errors, staged objects are retained. A local Wrangler D1/R2 fault-injection gate confirms item pre-commit staging is removed, while item and report objects survive a simulated lost D1 response after the batch committed.
- **D — report and analysis artifacts:** completed reports with absent references, missing R2 objects, invalid JSON, or invalid markdown payloads now raise `CloudStorageError`; report APIs return 503. Missing or malformed referenced analysis objects also raise `CloudStorageError`, and the analyses API returns 503. Non-completed reports without artifact references still return `markdown: null`. Local Wrangler R2/D1 exercises missing and corrupt objects through runtime reads and HTTP report list/detail paths.

### Final pass gates and evidence

Every command below passed. Logs are TEST-ONLY local fixtures, stored under `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-cloudflare-vertical/`.

- `npm test`: **26 files / 340 tests passed**. Log: `npm-test-reliability.log`.
- `npm run check`: **0 errors / 0 warnings**. Log: `npm-check-reliability.log`.
- `TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch npm run build`: **PASS**; complete Wrangler dry-run Worker bundle passed native/Node filesystem/CLI isolation scan. Log: `worker-build-reliability.log`.
- `npm run build:node`: **PASS**. Log: `node-build-reliability.log`.
- `TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch node scripts/test-node-isolated.mjs`: **PASS**; 200 responses, retired login 410, zero provider calls. Log: `node-runtime-reliability.log`.
- `npx tsx /Users/y/.hermes/profiles/plan/cache/scratch/ymath-report-expiry-probe.mts`: **PASS**, fifth expired report lease and `report_json` status both `failed`. Log: `ymath-report-expiry-green.log`; original RED log remains at `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-report-expiry-red.log`.
- `TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch node scripts/test-cloudflare-local.mjs`: **PASS** against local Wrangler D1/R2, including post-normalization failure/retry byte equality, fifth report lease recovery, and missing/corrupt report HTTP 503. Summary: `wrangler-reliability-summary.log`; full Wrangler transcript: `wrangler-e2e.log`.
- `TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch npx tsx scripts/test-cloudflare-storage-reliability.mjs`: **PASS** against local Wrangler D1/R2. It confirms item staged-object cleanup before commit, item/report retention after commit with a lost response, and explicit missing/corrupt completed-report and analysis errors. Log: `storage-reliability.log`.
- `TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch npm run test:migration`: **3/3 PASS**, including source SHA parity, post-cutover writes, and rollback after object changes/deletions. Log: `migration-reliability.log`.
- `git diff --check`: **PASS**.

Iteration failures and resolution: `npm test -- --run` was an invalid invocation because the npm script already supplies `--run` (Vitest rejected duplicate flags); the required exact `npm test` passed. The first local runner attempt got a CSRF 403 until the fenced normalized-image request included its same-origin `Origin`; the next attempt got 404 because Wrangler was serving a stale generated route manifest, resolved by rebuilding before the local gate. The first standalone storage-fault script had no tables because its Wrangler CLI migration and proxy used different local persistence directories; it now applies repository migrations directly to the isolated local proxy D1 binding. Final commands above pass.

Remaining limits are unchanged: provider integration/quality, real user snapshot parity, Cloudflare account plan/usage, remote resources, deployment, and production authorization policy were not accessed or verified. No commit or push was made, and `drop5-files` remained untouched.

## Parent independent re-verification (2026-10-17, after the reliability pass)

The orchestrator re-ran every gate itself after the delegated coder exited, with no concurrent edits:

- `npm test`: **PASS, 26 files / 340 tests** (`ymath-final-test.log`).
- `npm run check`: **0 errors / 0 warnings** (`ymath-final-check.log`).
- `npm run build` + `npm run build:node` + `node scripts/check-worker-bundle.mjs`: **PASS**; the complete Wrangler dry-run Worker bundle again passed the native/Node isolation scan (`ymath-final-build.log`, `ymath-final-build-node.log`, `ymath-final-bundle.log`).
- `npm run test:migration`: **3/3 PASS** after the migration-ledger change below (`ymath-migration-tests.log`).

### Additional defect found and fixed by the parent

- **Worker/Node build interference (regression found by real UI probe):** `build:node` overwrote `.svelte-kit/output/server/index.js` with the Node adapter build, so a subsequent `npm run build` published a Worker whose server graph still contained sharp/fs/child_process. `check-worker-bundle` was RED before the fix (`ymath-build-isolation-red.log`) and GREEN after (`ymath-build-isolation-green.log`). Fix: Node builds now write to `.svelte-kit-node` (`vite.config.ts` `outDir`, gitignored), so the two adapters never share a manifest. Reproduction: run `npm run build:node` then `npm run build`, then `node scripts/check-worker-bundle.mjs`.
- **Migration re-application on a migrated local D1** failed with `duplicate column name: ocr_key` because `initializeLocalDatabase` re-ran `ALTER TABLE` unconditionally. It now keeps a `d1_migrations` ledger in the target DB and skips already-applied files; `npm run test:migration` still passes.

### UI storage-failure behavior — live probe against real local Wrangler D1/R2

TEST-ONLY fixture (one item, one JPEG) in scratch `ymath-ui-storage-proof`; real `wrangler dev` on 127.0.0.1:8883:

- Healthy DB: list page renders the fixture item and its image (screenshot `screenshots/before.png`).
- Simulated D1 storage failure (`DROP TABLE feedback`): the page render fails with a 500 error screen — **not** a fake empty success list. Screenshot not separately retained; the error state is reproducible by re-running the break/restore sequence above.
- Restored DB: a fresh visit renders the list and image again (`screenshots/after-restore.png`).
- Known residual: SvelteKit's default 500 page offers no in-page retry button; the browser reload/recovers once storage returns. This matches "통신 실패는 빈 목록으로 바꾸지 않는다" but not a dedicated retry affordance; noted as a remaining UX polish item, not a data-integrity defect.
- Probe tooling: scratch `ymath-ui-storage-proof.mts` (seed/break/restore, `remoteBindings:false`, `envFiles:[]`), server logs `ymath-ui-storage-proof/server*.log`.

### Remaining known gaps (unchanged)

- Criteria gate 11/12 (account plan/usage read, remote resources, deployment, Zero Trust policy) remain unverified — authorization boundary, not implementation.
- The 500 error screen after a D1 failure is correct but minimal; a friendlier retry state inside the items/status pages is still open polish work.
