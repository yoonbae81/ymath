# Local list fixture benchmark

Command:

```sh
TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch npx tsx scripts/cloudflare-list-benchmark.mjs
```

The harness initializes all current SQL migrations in isolated actual local Wrangler D1, inserts 1,000 TEST-ONLY complete analysis records, and calls the real `cloudItems` function 12 times. No operating data or provider configuration is loaded. Each call asserts 1,000 distinct IDs and a constant query budget.

Measured run (before final report integration; rerun to compare current code):

- D1 calls per complete list: **1** (no per-item feedback query).
- p50: **28.8425 ms**; p95: **37.267291 ms**.
- D1 `meta.rows_read` over 12 calls: **36,000**. This is database accounting, not a count of distinct returned items.
- Evidence: `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-list-benchmark-obT85g/result.json` and `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-list-benchmark.log`.

These are local binding round-trip measurements, including JSON parsing. They are NOT deployed Worker CPU or latency measurements and do not prove the Workers Free 10ms CPU budget. Upload/image/provider latency and account-wide existing usage still require separate measurement before rollout. D1 Free budget comparisons must count rows scanned by joins/index lookups, not just returned rows.
