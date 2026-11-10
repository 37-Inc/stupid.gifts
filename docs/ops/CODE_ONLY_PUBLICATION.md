# Maintained code-only publication

Small code/UI fixes use the **existing GitHub Catalog care workflow, manual
mode `code`**, after merge. This uses the same `catalog-production` concurrency
and protected pending pointer as catalog care, not another publisher/scheduler.
It builds over the accepted catalog without product refresh, discovery, copy
generation or embedding calls. A pending catalog publication must finish first;
`code` never restarts its provider phases. A scheduled wake can finish an already
pending code release before starting new maintenance.

```sh
gh workflow run catalog-manual.yml --ref main -f mode=code
```

The source-bound `serving-<commit12>` intent is idempotent. Hosted records and
journals use the existing private R2 store, not a Mac's historical pointer.
The code-only child receives Cloudflare/storage credentials only, not supplier
or model keys. `code-only-serving` tracks serving configuration separately from
the unchanged genuine catalog `last-success` pointer. Lost acknowledgements use
the same saved package, owner and exact readback, never a replacement run.

The `catalog-production` concurrency fence is job-scoped. Acceptance and the
pending-pointer handoff finish before a separate, independently serialized
`catalog-cleanup` job restores one due historical workspace. Cleanup receives
only private R2 credentials, not supplier/model or Cloudflare application keys.
It retains original source/config/deadlines; queue CAS conflicts merge fresh
registrations rather than overwriting them. Failure does not reverse acceptance.
Hosted generated checkout output disappears with its ephemeral runner; do not
download the accepted package into a new runner just to delete those local files.
Retained R2 packages still use their original registered expiry, without renewal.

Normal maintenance streams phase start/completion and elapsed time into Actions
logs. Confirmed atomic D1 writes use their acknowledged next-owner cursor;
only uncertain responses trigger the extra immutable receipt/owner readback.

For local operation/recovery, use a clean reviewed Node22 checkout and the same
scrubbed environment as catalog care. These remain owner-invoked commands:

```sh
npm run catalog:care -- code-only prepare --run descriptive-label
npm run catalog:care -- code-only start --run descriptive-label
npm run catalog:care -- code-only resume --run descriptive-label
npm run catalog:care -- code-only recover --run descriptive-label
npm run catalog:care -- code-only status --run descriptive-label
```

`prepare` is read-only remotely. `start` also prepares when needed; omitting the
verb means `start`. Resume the same label/source/config, never a replacement
label to escape an uncertain upload or activation. Root CLI wiring dispatches
the `code-only` arguments to `codeOnlyMain`.

After a reviewed controller fix, `recover` can finish an existing saved intent.
It validates the original clean checkout/helper and the clean descendant
controller, then retains the original build source, config, authority, workspace,
owner, deadlines and accounting. The controller identity is recorded separately;
it cannot prepare a new run or call suppliers/models. Explicitly abandoned
prebuild attempts are terminal, not recovery candidates.

- Existing production scope, reviewed Cloudflare credential, protected workspace and
  accounted uploader are reused. No merchant or model credentials/calls exist.
- Preparation pins the genuine accepted persistent catalog seal, exact catalog
  pointer bytes, current D1 barriers and actual serving deployment. The serving
  deployment can be newer than the catalog receipt.
- Existing presentation/analytics settings come from the accepted run's saved
  publication config, or the latest matching maintained serving config. The
  protected current semantic policy is preserved. No unpublished homepage
  edition is silently selected.
- The normal publisher builds and verifies once, uploads, activates, reads back
  uncertain writes and resolves ownership. Existing native delivery proof is
  reused behind unchanged D1 watermarks; no vectors or products are rewritten.
- UI-only publication reads the exact accepted **public** projection, including
  articles, and verifies its snapshot/projection hashes, genuine catalog receipt,
  original native journal hashes, owner and pending/write watermarks afresh at
  build/activation boundaries. Unpublished private edits are neither promoted nor
  asserted unchanged; they belong to the next normal catalog publication. This
  avoids repeated private source/vector recapture without caching mutable truth.
  Within one live invocation, already authenticated public bytes are reused only
  with in-process provenance bound to the same D1 client, run, exact input and
  frozen owner generation/epoch. Each publication boundary still checks actual
  catalog/projection receipts, original native journal hashes, watermarks,
  pending work, exact immutable/sealed projection-trigger definitions and row
  count. Missing/changed trigger protection falls back to a full authenticated
  read. New clients, restored inputs and new invocations authenticate again.
  No schema migration/out-of-band DDL is permitted under an active publication
  owner. This is not a persistent snapshot cache or private-source waiver.
- Enqueue/claim/dispatch use the sealed snapshot hash, genuine receipt and compact
  SQL barriers; they do not each repeat a fieldwise public-catalog rollback scan.
  The publisher still freshly authenticates public bytes/native anchors before
  activation and before final completion.
- Acceptance checks the actual public identity, resolved build, idle owner and
  original genuine catalog receipt. The separate private serving-only receipt
  lives in `daily-catalog-care/code-only/<label>/success.json`. Catalog
  `last-success.json` and product/supplier timestamps stay unchanged.
- A committed final-resolve response lost in transit resumes from body-free
  controls. It does not reacquire ownership or reconstruct expired bodies.
- If an independently authorized exact uploaded version is already serving,
  resume can reconcile that **observed** activation without uploading or sending
  another activation. It verifies package/bindings, exact version/deployment marker
  and public identity twice, records a truthful observed-activation pin, and CASes
  only the original build/outbox/owner into completion. Original tokens, expired
  lease values, attempts, catalog receipt, deadlines and charges remain historical;
  no prior-deployment observation or new dispatch permission is invented. Unknown
  or mismatched provider state stays pending.
- Accepted generated-output cleanup uses the source-only cleanup capability
  after deployment locks are released for a persistent local operator. Hosted
  runners skip that redundant step; their separate expiry job retains the
  original manifests, accounting and receipts.

An existing successful label is a historical no-op, not proof it is still the
current serving release. `status` reads saved records only. Missing credentials,
accepted-public/receipt/native barrier drift or unresolved provider state requires attention; none
authorizes another merchant batch, takeover, quota reset or blind POST retry.

## Separation boundary and next transition

This is a shorter release critical section, **not independent application
deployment**. App promotion still waits for an actual pending catalog run. The
Worker compiles a snapshot and serves snapshot-specific static HTML/assets, so
UI delivery still rebuilds/repackages that catalog. No bulk prepared-artifact
pipeline, second publisher, lock removal, new scheduler or accepted-pointer
rewrite is introduced. Existing stale-serving/prior checks and frozen replay
compatibility remain; this change adds no new stale-code rollback guarantee.

Offline November 10 checks (Node 22, synthetic SQLite/D1-REST fixture, 32 identities):
four fresh authentications took 24ms/40 fixture transport requests/four public-page
reads; four same-owner boundary checks took 10ms/28 requests/zero public-page
reads. These compare the two current proof paths, not production throughput or
billing. A coordinator fixture completed catalog acceptance and the next code
handoff in 10ms while historical cleanup remained blocked. That proves the local
handoff boundary, not GitHub scheduling latency or full-catalog deployment time.
The actual publisher fixture also rejects native-barrier drift during build
before upload, then reuses that same package and survives uncertain activation
with one build/upload/activation and zero native, supplier or model writes.

The next independently useful transition needs one immutable accepted runtime
catalog reference, consumed by the existing Worker/renderer rather than baked
into every app version. Keep D1 and the existing catalog writer canonical; reuse
R2/versioned metadata and current routes/rendering primitives. An app release
must preserve the current accepted catalog reference; a later catalog acceptance
must advance that reference without deploying an older Worker. The pointer
handoff must remain serialized/CAS-bound and uncertain writes must reconcile by
exact readback. Verify products, historical URLs, images, short copy, articles,
native search provenance and fallback before making that serving transition.
That renderer/data change is not implemented here; roadmap-lbbz1.16.2 remains
in progress. Admin UI and other catalog work are outside this slice.
