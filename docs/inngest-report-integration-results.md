# Inngest application report slice: implementation evidence

## Scope and result

This branch adds an opt-in application-report execution path using the existing app `ReportRecord` contract and prompt/summary rules. It does not use the synthetic report schema from the first Inngest slice. The report path creates or retries reports through the existing APIs, records durable outbox work in D1, executes through the installed Inngest SDK's signed function endpoint and `step.ai.infer`, validates and normalizes Markdown into the existing report fields, stages the result in R2, and publishes a generation-fenced D1 pointer consumed by the existing report GET APIs.

The implementation and offline/synthetic protocol gates pass. **Actual Wrangler local D1+R2 binding integration also passes** in an out-of-sandbox run (`test:inngest:wrangler:local`, exit 0): the report slice ran the real installed SDK signed serve protocol against local D1/R2 bindings and still recovered, on the same signed run, from injected binding-level faults. Fixture-only (`listen EPERM` sandbox) and binding-backed runs are distinguished above. This is not Hosted completion.

## Safety and activation

`REPORT_BACKEND` selects report ownership explicitly. The default (unset or any value other than `inngest`) remains `runner`; in that mode the existing runner retains report jobs. With `REPORT_BACKEND=inngest`, report create/retry is accepted only when the second switch `REPORT_INNGEST_EXECUTION_ENABLED=true` is also set; the API writes a `report_outbox` row transactionally and the old runner claims only item jobs, so it cannot claim the same report work. With the second switch unset, report API writes are rejected, the generation function is registered in a no-op state for Inngest sync, and the recovery cron is not registered. Enabling execution registers the recovery cron, which publishes only already-created durable outbox rows. It does not import legacy queued reports. Publishing has stable event IDs, exact `(report_id,generation)` leases/CAS, retryable failures, and duplicate acceptance. Report claims and result commits are fenced by generation and persistent Inngest run ownership; same-run retries can reclaim after a lost committed claim response. Report Markdown uses unique immutable R2 staging keys and a D1 owner/content-hash compare-and-swap. Delete/retry makes stale completions inert. Terminal Inngest `onFailure` updates only a matching generation and run owner and cannot change a done report.

Do not enable this on a Hosted environment yet. Safe activation requires all of the following, performed as an explicitly approved deployment operation:

1. Apply migrations `0005_report_outbox.sql` and `0006_inngest_report_owner.sql` to the intended D1 database after reviewing its target.
2. Drain the old runner's report work and verify there are no pre-existing queued or generating reports; this slice intentionally does not import legacy rows. Deploy the Worker with D1/R2 bindings and Inngest signed endpoint configured, with `REPORT_BACKEND=inngest` and `REPORT_INNGEST_EXECUTION_ENABLED` unset. This registers the report function but keeps report API writes rejected and omits the recovery cron during the registration stage.
3. Configure the required Inngest event/signing keys and LLM provider credentials in the correct secret store, plus the intended non-secret model/base URL. No secret values belong in this document or ordinary config.
4. In an approved isolated environment with synthetic data, explicitly set `REPORT_INNGEST_EXECUTION_ENABLED=true`, sync/register the endpoint, and verify a real binding-backed report end-to-end, including create, retry, GET, stale-generation fencing, terminal failure, and outbox recovery. Only after that acceptance should a separate production activation approval set the execution switch for production.

The SDK remains `isDev: false`. No Wrangler deployment, remote migration/resource creation, secret access, or actual LLM invocation was performed for this work. Existing image analysis is unchanged. The prior synthetic text-function Hosted success does not demonstrate application report completion.

## Tests and gates

Feature tests were run RED before implementation, with persistent logs under `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-report-vslice`:

- `owner-storage-red.log` and `outbox-generation-red.log` reproduce the review's owner/storage replay and multi-generation outbox defects; `execution-flag-registration-red.log` reproduces the activation-stage registration failure. Earlier `report-contract-red.log`, `outbox-red.log`, `report-store-red.log`, `runner-fence-red.log`, `reconcile-red.log`, and `attempt-count-red.log` record prior missing contracts and failures.
- `fix-targeted-final.log` records the updated report owner/storage, exact-generation outbox, and activation switch feature tests passing (**17 tests**); `execution-flag-registration-green.log` records the no-op registration and cron-gating test passing; `concurrency-green-3.log` records three repeated passing SQLite save-fencing runs. Earlier `attempt-count-green.log`, `report-outbox-green.log`, and `report-storage-error-green.log` retain the first implementation's GREEN evidence.
- Final `npm test`: **369 passed, 1 skipped** (370 total), in `final2-test.log`.
- Final `npm run check`: **0 errors, 0 warnings**, in `final2-check.log`.
- Final `npm run build`: **passed**, including the Wrangler dry-run worker-bundle boundary check, in `final2-build.log`.
- Final `npm run build:node`: **passed** in `final2-build-node.log`; only existing empty `env.js` and `ajax.js` chunk warnings were emitted.
- Final `git diff --check`: **passed** in `final2-diff.log`.
- `TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch npm run test:inngest:fixture`: **passed**, in `final2-fixture.log`. This explicit fixture-only protocol check uses the real installed Inngest SDK signed serve protocol and intercepted synthetic AIGateway completion; it verifies `step.ai.infer`, Markdown normalization, report GET, retry, deletion fencing, and signed terminal-failure callback. No actual LLM call is made. Result: `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-inngest-report-local-vmPg4k/report-result.json`. It does not exercise actual Wrangler bindings.
- `TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch npm run test:inngest:local`: **PASSED against actual local Wrangler D1+R2 bindings** in an out-of-sandbox run (`final-actual-wrangler.log`). The signed report run recovered, on the same run, from three real binding-level faults injected around the actual D1 SQL (committed claim response lost, post-claim snapshot read failure, D1 save failure after the R2 PUT) and still finished `done` via the existing GET API.
- `TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch npm run test:inngest:wrangler:local`: **PASSED** (report binding integration plus the first synthetic slice check). Evidence is `final-actual-wrangler.log`; binding artifacts in `ymath-inngest-report-local-Lu7ym6`.

All local test, build, and integration commands used the allowed scratch root for temporary data/logs. Actual local Wrangler report binding acceptance and Hosted checks remain outstanding; no Hosted completion is claimed.
