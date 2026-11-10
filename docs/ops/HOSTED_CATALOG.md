# Stupid Gifts — Hosted catalog operations

Implementation reference: [catalog automation specification](CATALOG_AUTOMATION_SPEC.md).
After the accepted one-product canary and explicit policy activation, the single
GitHub workflow owns daily care. The old Codex writing timer stays paused. Never
run a local publisher while hosted care or a saved hosted publication is active.

## One application, one publisher

The completed October24–25 editorial recovery/upload/finish CLIs and held-preview
entrypoint are retired from maintained main. Their exact code remains in Git and
the original frozen operators alongside the private receipts. They are not
alternate daily commands; use the maintained same-run recovery path below.

- `catalog:care` remains the maintained local/hosted operator. `code-only` is its
  owner-invoked serving-only route; it preserves the genuine catalog receipt and
  accepted catalog pointer. See [CODE_ONLY_PUBLICATION.md](CODE_ONLY_PUBLICATION.md).
- `catalog:hosted` coordinates that operator, not another ingestion engine.
  Full care, due photos and explicit one-product canary use the same run journal.
- An immutable pending intent pins source, Pacific day, input version and run
  key. Resume it before new work. Its phases, reservations and publication state
  remain in `RunWorkspace` and the existing D1 controls.
- The private R2 bucket `stupid-gifts-catalog-private`, prefix `catalog-v1`, holds
  original journal/artifact/package bytes. A reservation is durable before an
  external request. Restore verifies hashes and does not copy local locks or
  rewrite historical source bindings. Original expiry registrations govern body
  cleanup; controls, accounting and history remain.
- A fresh runner also recreates private temporary publication parents when a
  build stopped before its package was sealed. This reuses the original
  registration and deadlines; it does not fetch again or renew content.
- Journal length and total journal bytes are not publication quotas. Keep the
  original history and charges across retries; do not reset or prune them to
  finish a run. Individual records remain size-bounded and every sequence,
  parent hash, source, owner and atomic head transition is still verified.
  Accounting errors retain safe workspace codes rather than describing every
  storage failure as an exhausted provider budget.
- An already-activated permanent catalog completes from its typed catalog/control
  evidence and current provider state, not expired supplier payloads or a new
  recovery-budget grant. Verify the immutable version/package marker, live release,
  genuine D1 receipt/build and owner; do not rebuild, upload or activate again.
  Finish first, then run the registered source-bound cleanup. A finalized retry
  uses its accepted successor without reopening expired phase bodies.
  The coordinator runs historical cleanup only after actual acceptance or a
  healthy photo skip and after clearing the pending pointer. Restoring an old
  journal must not hold up a new catalog release; original registrations,
  source bindings and retention deadlines remain unchanged.
  A lost D1 response after a published permanent receipt gets one same-run
  bookkeeping retry. It first inspects the saved published receipt; the normal
  finalizer then reads back the completed run and exact owner. Unconfirmed
  uploads/activations and earlier unknown writes still stop for readback.
  Numeric embedding-operation telemetry is a count, not an expired vector body;
  permanent completion accepts that counter while rejecting raw vectors/text.
  Completion reads the run-summary row, not its entire per-product log. Detailed
  history remains retained for reporting. Response-size failures expose numeric
  actual/limit diagnostics and are not retried as transient network loss.
- Routine completion uses the same automation authority and permanent-display
  rule as normal publishing: finite overlays may retain their original clocks
  above cleared permanent fallbacks. Never treat a photo deadline as catalog
  expiry or renew it during receipt completion. The exact original snapshot,
  source, native proof, version and owner still have to match.
- Routine SQL transactions are bounded by encoded request/individual statement
  constraints, not the obsolete 50-statement allowance. Never split a logical
  transaction merely to fit that count: rollback, receipt and owner CAS stay atomic.
  Failure telemetry retains safe transport code, dispatch state, statement/byte
  counts, HTTP/provider codes and phase/product IDs, never SQL/values/credentials.
  The same sanitized record is saved in the existing phase journal and job output.
- An acknowledged native write waits up to three 45-second intervals in the same
  hydrated driver before returning visibility-pending. It never resends the write
  or repeats supplier/model work. Unacknowledged writes remain uncertain.
- Recovery reads each atomic maintenance receipt once even when it changed
  several approved products. Shared operation IDs are not duplicate products.
  A prepared revision reuses its verified predecessor, with an exact comparison
  against the independent checkpoint pin, instead of loading it twice.
  Typed redacted operator errors survive the hosted wrapper without a second
  error-namespace list hiding new failures.
- Secondary semantic projection binds the exact current inventory and verified
  saved embedding text/bytes, not a supplier-fact equality or photo-only exception.
  Availability/photo changes alone do not change semantic input. Original model
  provenance stays original; changed copy, corrupt bytes or unverified input still
  cannot be relabeled as current semantic coverage.
  A legacy vector describing different public copy is omitted from new secondary
  coverage, not used to block the correct listing and working keyword fallback.
- Secondary Vectorize readback splits IDs into provider-sized groups of20,
  independent of the approved cohort/upsert group. Every approved vector is
  still processed. After acknowledged writes, bounded30-second visibility waits
  stay in process rather than immediately rehydrating the whole catalog. Provider
  failures retain operation, HTTP status and numeric codes, never raw bodies.
- Review preserves a legacy `sourceFactsHash: null` as unknown, not invalid or a
  reason to generate substitute facts. The exact proposal still binds every
  current product/display row. Identity, short copy, image and affiliate checks
  remain required; malformed/missing hashes receive a specific review error.
- Cold restoration lists only this run's immutable journal objects and downloads
  them with sixteen concurrent reads, then verifies the original anchored hash
  chain before using any state. Listing is an accelerator, not authority; no
  records, counters or original bytes are changed. Warm local caches still
  verify against the remote head. Numeric restore progress appears in job logs.
- Restored R2 bytes are a hash-verified local cache, not a second durable copy.
  Avoid per-record disk flushes during restore; original remote ACKs and all new
  reservations/appends retain their durable-before-dispatch ordering.
  Body restoration uses the same joined sixteen-transfer pool as blob uploads;
  every hash/registration is still verified before the workspace becomes usable.
- Blob/package transfers retain the original 256KiB chunks and hashes. A blob
  registers its chunk retention in one journal record, transfers at most sixteen
  immutable chunks concurrently, then attaches them in one record only after
  every transfer ACK. Its manifest is still last. Old single-chunk records stay
  readable; use the maintained compatible reader for new batched records.
  Failed transfers join before returning, retain the original registrations and
  resume the same bytes/deadlines, never a new supplier/model phase.
  Numeric package bytes/files/block counts and elapsed time stream to the job
  while it runs; raw child output, product bodies and credentials never do.
  Full inventory checks likewise emit start/completion, row count and duration,
  so repeated scans are visible instead of looking like a hung child process.
- Routine background publishing keeps its original build token and attempt
  history under the unchanged, non-expiring mutation-owner fence. Saving a large
  package does not require another timed build claim. The original source cutoff,
  publication lease, exact dispatched version and atomic source/owner checks stay
  mandatory. Legacy dispatchers and explicit historical recoveries keep their
  existing timed-lease rules; uncertain uploads are never bypassed.
- Completed hosted runs enter a small `cleanup-runs` housekeeping pointer before
  their pending intent is cleared. Each existing wake revisits one due original
  workspace using its immutable source/config and registered deadlines. Only
  expired body/package bytes are purged; source bindings, controls and charges
  remain. A cleanup failure retains its registration and alerts without blocking
  a new catalog run. This is not another publisher or scheduled service.
- Provider header/body timeouts exclude the coordinator's own durable journal
  reservation and settlement. Those writes retain their separate bounded R2
  transport and must finish before the caller releases ownership. A slow journal
  must not abort a provider request before dispatch. Real provider timeouts still
  retain the original unknown charge; uncertain writes are never replayed.
- Private R2 journal/artifact writes retain exact bytes and their original
  atomic `If-Match`/`If-None-Match` condition. Transient failures may retry at
  most three attempts after matching readback; a late earlier write still cannot
  create another transition. Changed heads, corrupt/unreadable readback,
  credentials and long throttles stop. A negative read alone is never treated
  as proof that an in-flight write failed. Safe root error codes survive a
  journal-uncertainty failure; provider bodies and secrets are not logged.
- Exact owned native proofs use a finite background window before the short
  core queue observation, rather than counting remote journal latency against
  that observation. Core still rechecks the immutable policy, owner, full source,
  projection, prior receipt, watermark and cutoff before its atomic queue write.
  Arbitrary adapters retain their existing short observation deadlines.
- Background work uses GitHub's six-hour job ceiling without a shorter child
  process cutoff, including cold restoration and full-catalog verification. This is not
  an extra supplier/model allowance or a change to original content deadlines.
  Individual request timeouts and retries remain bounded. Track actual normal
  runtime and cold-restore overhead in the seven-cycle follow-up; slow runs need
  optimization, not a visitor cutoff or a repeated supplier batch.
- Final owned activation resolution likewise performs native proof outside its
  short deployment-observation window. Fresh deployment/identity reads remain
  on both sides of the observation, with the same final receipt/owner CAS.
- Hosted source paths are stable at `/home/runner/stupid-gifts/operators/<SHA>`;
  private state is under `/home/runner/.codex/private/goose-gifts-migration`.
  Finish existing Mac-bound runs locally. Never pretend they were hosted runs.

## Credentials and input handoff

The manual workflow runs only reviewed `main` code in GitHub's `Production`
environment. PR tests have no production secrets. Dependency installation has no
application credentials. Required encrypted secret names are:

| Secret | Purpose |
| --- | --- |
| `STUPID_GIFTS_CLOUDFLARE_API_TOKEN` | Existing Worker, D1 and native/serving Vectorize operations |
| `STUPID_GIFTS_R2_ACCESS_KEY_ID` | Private bucket object access |
| `STUPID_GIFTS_R2_SECRET_ACCESS_KEY` | Corresponding scoped S3 credential |
| `STUPID_GIFTS_AMAZON_CREDENTIAL_ID` | Existing Creators API identity |
| `STUPID_GIFTS_AMAZON_CREDENTIAL_SECRET` | Corresponding existing credential |
| `STUPID_GIFTS_OPENAI_API_KEY` | Approved Luna/editorial and embedding policy |

Provisioning persistent access requires explicit owner approval. Do not copy a
Chrome session, interactive Wrangler OAuth file or Keychain database to GitHub.
No DNS, plan purchase, automatic campaign enrollment or new public bucket is
needed. Do not silently broaden scopes to solve a denied endpoint.

`prepareHostedBootstrap` is read-only. It validates the current accepted seal,
publication settings, canonical semantic catalog hash and optional campaign
inputs. `publishHostedBootstrap` requires fresh matching acceptance evidence,
then seeds versioned metadata and the initial hosted pointer without replacing
an existing different successor. It does not migrate historical runs. The new
automation policy defaults off. Pending runs retain their original input version
when newer metadata is supplied.

## Release and single-writer cutover

1. Finish local pending publication and registered cleanup. Confirm the actual
   serving identity, genuine D1 receipt, resolved build and idle owner.
2. Provision the scoped credentials and verified private inputs. Run manual
   **shadow**: read-only input/source/provider checks, no prepare, supplier/model
   call, D1 claim or remote journal repair. Shadow is not write acceptance.
3. Disable local catalog writes before the owner-invoked hosted **canary**. Pin
   one exact existing public ASIN; reuse copy/edition, with no discovery or model.
4. Verify its actual public identity, D1 receipt, resolved build, idle owner,
   successor, loaded photos/copy and representative QA-labelled flows. Resume an
   interrupted canary under the same identity; never replace its batch.
   Post-provider `catalog:care recover` requires the original proposal pin,
   including `draining` while an acknowledged native mutation becomes visible.
   That retry resumes the saved outbox event; it never re-enters supplier/model work.
   Retry/transition bounds apply to consecutive stalls, not a total number of
   gifts: a new checkpoint phase or owner epoch is progress. No accounting is reset.
   The original clean
   ancestor source/config/owner and all reservations stay bound; no refetch.
   For a saved automated `phases_running` run, a reviewed descendant controller
   may use `catalog:care recover <original-config-SHA> --run <original-key>`.
   The original writing owner and exact finite cohort must match. Reuse saved
   preparations/responses and committed receipts; only unattempted work already
   in that original cohort can execute. Original source/config/observations stay
   unchanged. Post-provider recovery still takes the actual reviewed proposal SHA.
   The coordinator keeps using that compatible controller for ledger reads,
   review, publication and successor repair; it does not return to the ancestor's
   older journal parser. At `phases_complete`, the original config digest requests
   review only; publishing still needs the actual reviewed proposal digest.
5. Only after acceptance and live QA, dispatch **activate** with that canary's
   exact ASIN. This configuration-only action verifies its saved acceptance,
   current public identity, D1 receipt, resolved build and idle owner, then
   version-updates only the automation policy. It makes no product/provider
   batch and never changes the accepted catalog pointer. Activate the same workflow's
   Pacific morning/evening wakes plus a bounded catch-up wake. Leave local writing
   off. If cutover fails, stop hosted writes, reconcile pending work, then restore
   local writing—not both. Seven unattended cycles belong to the observation Bead.

For the initial API-editor quality check, manual **editorial** uses the same
Luna/photo-backed optional homepage editor against the current accepted catalog.
Inspect its actual saved edition before activation. It fetches no supplier batch,
changes no products and does not publish or enable policy. It is not a recurring
extra job; normal morning preparation reuses the same day's saved edition.

The same workflow has Pacific-time wakes at 08:30 (full care), 20:30 (due photos)
and 10:30/22:30 (morning/evening catch-up). The two evening photo wakes share the UTC date of their evening slot; a dispatch delayed past Pacific midnight still resumes that slot, not the next evening. Full-care dates stay Pacific. Original pending identities always take precedence, without relabeling or provider replay. The coordinator logs the schedule expression and actual start time for delay diagnosis. GitHub's native IANA timezone setting handles
daylight saving time, without duplicate seasonal wakes or application clock
gates. Catch-up uses the same daily run key: completed work skips, pending work
resumes, and a missed morning can start once. Schedules can be delayed; the
independent first-week checkup is not a publisher.
See [GitHub scheduling documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onschedule).
Do not add another timer just to retry a pending publication. Usage estimates
alert; actual provider throttling, timeouts, finite payloads and integrity checks
remain. A missing usage report is unknown, not zero or a public-search cutoff.

## New policy behavior

`automation-policy.json` is explicit, versioned private input:

```json
{"schemaVersion":1,"enabled":true,"discovery":true,"homepage":true}
```

Absent/disabled policy preserves the legacy ten-product/Monday discovery path.
When activated, quiet-stock throughput scales with catalog size and the 35-day
rotation; all hot/due-photo work, current unavailable rechecks and unresolved
negative labels are additional priority work. Supplier requests use exact chunks
of ten. One hundred is not a business quota.

Daily discovery combines the finite ordinary-theme cohort, optional repeated
zero/sparse search topics, and a small saved campaign-lead observation batch.
Deduplicate all identities before visual admission. Only admitted candidates get
short-copy drafting/review and one embedding; no mandatory article. Saved model
and supplier stages are not refetched on restart. Publication membership is the
exact pinned cohort, not an enlarged arbitrary count cap. Original native and
derived serving indexes update in the same pipeline.

Homepage editing is optional: six weekly anchors plus eighteen daily discoveries
from the accepted catalog, using actual photos/canonical copy. Failure reuses the
last good edition. The separate `/h` assortment is unchanged. Campaign intake
remains optional and account-scoped; unknown/unjoined/stale/unfulfilled offers get
no monetary boost. Join and content-link obligations are manual Slack actions,
never enrollment. See [CAMPAIGN_DIGEST.md](CAMPAIGN_DIGEST.md).

## Verification

Use `test:catalog-automation`, `test:catalog-ops`, `test:catalog-availability`,
`test:homepage`, `test:search-demand`, `test:staging`, both strict typechecks and
lint. Secret-free Linux isolation tests exercise the actual pinned Wrangler
against a simulated provider; that is not a live hosted publication. Record live
canary, cutover and subsequent scheduled evidence separately in canonical Beads.
