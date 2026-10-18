# Local D1/R2 snapshot migration and rollback

This tool is deliberately local-only. It never uses remote Cloudflare APIs, reads credentials, modifies the source snapshot, or deletes operating data. Its CLI constructs its own isolated Wrangler configuration and explicitly sets `remoteBindings:false` and `envFiles:[]`. No real-account resource identifiers are required. Production application/rollout needs separate approval; app authentication has been removed by user instruction, so only fixture data may be exposed before Zero Trust is configured.

## Reproduce the fixture proof

```sh
TMPDIR=/Users/y/.hermes/profiles/plan/cache/scratch \
  node --test scripts/cloudflare-migrate.test.mjs scripts/cloudflare-migrate.integration.test.mjs
```

The integration test uses actual local Wrangler D1/R2 (not in-memory database/storage mocks), creates a JPEG through sharp, and retains its isolated fixture directory for inspection. It verifies:

- source item/report ID sets and counts;
- every file's bytes and SHA-256, including record, provider analysis, OCR, image and report;
- complete backup before any D1/R2 write;
- exact source -> D1/R2 -> export roundtrip;
- reverse export after post-cutover favorite, viewed, feedback and report-body writes.

Verified run: 3 tests passed; fixture root `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-migrate-e2e-enioWD`; 1 source item, 1 report, 5 objects, all SHA-256 equal. A new post-cutover item and its image were exported alongside favorite/read/feedback/report changes. Deleting all live entities also produced an empty rollback export (no resurrection). Log `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-migration-tests.log`.

CLI dry-run/apply/export were additionally executed with 0 ID/count/hash mismatches. Evidence directory `/Users/y/.hermes/profiles/plan/cache/scratch/ymath-migration-cli-deb74f0e/` contains manifest, backup, local state, export and cli.log. No operating user/data was used.

## Commands

Pass explicit immutable snapshot/output paths; do not point this implementation at operating `user/data` without a separately approved snapshot procedure.

```sh
node scripts/cloudflare-migrate.mjs dry-run SNAPSHOT NEW_MANIFEST_JSON
node scripts/cloudflare-migrate.mjs apply-local SNAPSHOT NEW_BACKUP_DIRECTORY ISOLATED_LOCAL_STATE
node scripts/cloudflare-migrate.mjs export-local ISOLATED_LOCAL_STATE NEW_EXPORT_DIRECTORY
```

The snapshot must have `items/<existing-id>/record.json`, `image.jpg`, optional `ocr.md` and `analysis-<provider>.json`, plus `reports/<report-id>.json`. No configuration, root secret, arbitrary artifacts or symlinks are copied. Active item/report jobs are rejected: drain and quiesce first. Invalid IDs and missing image/report references fail explicitly. Existing target entities are rejected instead of overwritten. Output files use exclusive creation.

Every source artifact is stored privately under a migration-specific R2 prefix. Metadata is committed in one D1 batch after verified object writes. Rejected metadata imports clean up their own staged objects. `migration_files` maps original artifacts for byte-exact export when metadata is unchanged. Exports hydrate current D1 favorite/read/feedback/report fields; they do not merely restore the original record snapshot. New application items with valid normalized image keys and provider analysis rows are also exported. A non-quiescent or broken-reference export fails rather than claiming a complete rollback.

## Single-writer cutover / rollback runbook (not executed against production)

1. Stop new uploads/mutations; stop runner claims, drain work, then stop runners. Confirm no live jobs. Back up filesystem data and retain checksums in a separate failure domain. Do not remove source.
2. Take an immutable, quiescent snapshot. Run dry-run, review IDs/counts and artifact hashes. The current tool is a local verification tool, not a remote production importer.
3. For a separately approved production importer, use a new private Standard bucket/database. Preserve the same IDs and metadata/object ordering and verify all hashes before making this the only write owner.
4. Start only the new application's write owner and runners after current-runtime acceptance gates pass. Keep the legacy filesystem runtime read-only/offline; never permit dual writers.
5. To rollback, first stop new web mutations and runner claims and drain/stop runners again. Export **current** D1/R2 state, including every write since cutover. Verify references, current IDs/counts and all object hashes, and restore into a NEW filesystem root rather than overwriting the retained original.
6. Run Node-mode regression against that restored root. Only after successful reads, images, provider tabs, feedback, reports and counts should Node become the sole write owner. Keep Cloudflare read-only/offline. Reconcile deletes via the complete live export, not by merging into the original snapshot (which would resurrect deleted items).

Limits: real-account import and rollout are intentionally absent. Full-scale D1 Free transaction/row-size budgets, runner OCR-cache export for post-cutover new OCR, and failure-injection of network-ambiguous commit acknowledgements need further testing before claiming a production migration utility. A source backup alone is not sufficient rollback.
