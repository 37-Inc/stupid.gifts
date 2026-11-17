# Short runtime publication — implementation contract

Scope: `roadmap-lbbz1.32.1`, with real-run measurements in `.36.4`.
Activated by PR458 (48b0a8b). The first unattended due-photo and full runs on
November16 UTC used this path and have independently matched public identity,
genuine D1 receipt, resolved build, idle owner and hosted successor evidence.

## Keep

- The current canonical `products`/maintenance tables, public projection tables,
  private R2 catalog objects, runtime head, genuine publication receipts and
  authenticated admission endpoints. No second product database or service.
- The shared saved product preparation, factual short-copy review, exact source
  fingerprints and original supplier/model accounting. No article requirement.
- One serialized catalog commit. App deployment, preparation, index delivery and
  expired-body cleanup do not hold its queue. No new scheduling clock.
- Frozen original runs, legacy receipts/vectors and their recovery readers.

## Replace the expensive boundary

1. Read the actual accepted public head/receipt and hash-checked public catalog.
   Preserve its products/holds/URLs/ordering, not mutable unrelated private rows.
2. Authenticate ONLY the reviewed changes against their exact current product,
   maintenance receipt, copy/licence/stock evidence and private state. Enclose
   this read with migration0020's existing source counter and original owner.
   Require the same counter and all nine invalidation triggers in the final
   transaction. Source drift rechecks the same saved proposal; never refetch.
3. Assemble/export public data with original finite-overlay deadlines. Project
   only its permanent cleared base: receipt identity must not change when an
   optional supplier photo expires. Existing data/collections keep the same
   runtime reader. No new native payload store or supplier observation.
4. Copy unchanged permanent public projection rows in SQL, transfer actual
   differences, and independently read back the full public projection. This
   is small public data, not archived supplier/native bodies.
5. Atomically check owner, source counter and expected public predecessor;
   record the real projection/publication receipt, runtime data head, resolved
   data-build request and idle owner. A body-free handoff survives a lost ACK.
   Register the original outbox sequence/operation IDs in additive migration
   `0022_runtime_index_events` in this SAME transaction. Finish the existing
   hosted successor CAS before releasing the publish queue.

`stageOwnedPublicProjection` is shared with legacy sealing: do not maintain a
second staging implementation. Staging alone never creates acceptance.
`assembleRuntimeCatalogDelta` preserves identities/exclusions; stock restoration
requires a genuine positive observation. Expiry falls back to cleared content.

## Search is a derived delivery, not listing acceptance

- Prepare from the exact verified saved embedding, with no second model call.
  Reuse the EXISTING immutable `catalog_maintenance_vector_payloads` row: it
  already retains the exact original native bytes across later source changes.
  Do not add another payload store or copy those vectors to R2. A companion
  index-event record binds the original immutable payload/operation to the real
  accepted publication. Delivery records its exact payload hash and immutable
  serving projection. Do not alter legacy outbox row
  shapes or rewrite their hashed historical receipts.
- New delivery uses immutable content-addressed IDs in BOTH existing indexes:
  original1536 bytes plus the1024 serving projection. Keep historical stable-ID
  vectors and every original native receipt untouched. Do not change index,
  model, credentials or dimensions, and do not fabricate a legacy native seal.
  Newly projected serving entries require the exact canonical-short-copy-v2
  input; a mismatch is not reinterpreted as a legacy context recipe. Existing
  legacy entries retain their original recipes and resolve independently.
- An after-publication job in the SAME workflow drains this outbox outside the
  catalog commit queue. It writes index delivery/accounting only, not products,
  publication heads or supplier observations. No separate scheduler/publisher.
- Known/unknown acknowledgements and exact readback remain durable. Identical
  immutable payload retries cannot overwrite another version. A later product
  update does not make an earlier delivery lie about its original input.
- Keyword search works immediately. The existing current-public-field/metadata
  resolver adopts semantic coverage when visible and rejects contradictory old
  copy. Missing/failed indexing alerts without withdrawing a cleared listing.
- New runtime receipt/successor metadata must explicitly distinguish this
  asynchronous index contract from legacy guaranteed native-promotion receipts.
  Never label pending delivery as verified or fake a legacy delivery ID.
- Unlisting does not delete retained native history. The companion can record
  `delete_history_retained`; it never invents a successful external deletion or
  marks that original delete outbox row delivered. Public membership already
  excludes the product. Provider Retry-After defers only index delivery.

## Hosted integration

- Generalize the existing owner-free saved preparation for morning/photo care,
  not only staff additions. Keep original due dates, run identities, selections,
  AI reviews, limits-as-alerts and provider-stage journals.
- In the existing workflow put preparation before, and index work after, the
  short `catalog-production` publication job. Staff requests use the same commit
  code and do not queue behind a daily job's supplier/model/index work.
- Apply each finite saved cohort using existing restartable technical batches.
  Give ready staff admissions the next turn before NEW daily publication, then
  check them again afterward. Finish an already-owned cohort; do not add a
  multi-release preemption queue or per-product workflow matrix. Preparation
  and indexing never hold the catalog writer.
- A prepared product may commit over a newer accepted public predecessor if its
  own exact source fingerprint still matches. Once publication has staged an
  immutable intent, resume THAT intent/owner/head or reconcile its real receipt;
  never blindly rebase an uncertain commit.
- Use the new receipt/control format only for new runtime-data runs after an
  idle/no-pending cutover. Existing configurations keep original recovery logic.
- Remove superseded active-path whole-private-catalog/native sealing calls once
  new-mode coverage passes; retain historical compatibility, not duplicate paths.

## Acceptance

- Composed 3,000+ gift fixture: new addition and normal refresh preserve all
  accepted products, exclusions, URLs, copy, photos, history and affiliate tags.
- Exact source/rights/stock checks, counter/owner/head drift, lost stage/commit
  ACKs, replay without suppliers/models, and pending index delivery covered.
- One shared short atomic publication; no unrelated private/native scan, app
  build, second publisher, clock, product regeneration or manual seed-list edit.
- Local request/wire counts are measured separately from real unattended timing.
- Review/simplify the integrated change; required CI, merge, necessary rollout,
  actual receipt/head/successor/idle-owner readback and representative live QA.
  Do not close `.32.1` on this document or staging fixtures alone.

The rollout can use a content-preserving, provider/model-free data publication
to verify the new receipt/head/recovery protocol. Do not admit another ASIN or
repeat an existing supplier batch just for a benchmark. Genuine new-product
preparation is already separately proven; composed new-row tests must exercise
the shared short commit, and real new-add latency stays explicitly measured on
the next owner-requested addition rather than guessed from a no-op.

## Implemented short-commit fixture

`commit-runtime-publication.ts` now owns the single atomic data-head transition
for both paths. The legacy caller retains its existing native/source checks;
`runtime-delta-publication.ts` supplies exact reviewed-source and accepted-public
checks instead. It stages/copies public rows, exports data, saves a body-free
handoff, commits a genuine receipt/build/head/idle transition, and recovers a
lost acknowledgement without rereading source bodies or refetching anything.

The composed 3,000-existing-plus-one-new test uses 49 read queries, five bounded
write batches, one SQL copy and one transferred public row. It verifies the
actual runtime reader and original photo deadlines, not just staging. These are
local request counts, not a production wall-time benchmark.

The shared driver now has an opt-in `runtimeCatalog.mode: public-delta` branch
and body-free successor/recovery reader. New preparation selects that mode only
when migration0022 exists and the accepted predecessor is supported; frozen
configurations keep the original path. The post-publication index drainer uses
the existing saved embeddings, immutable IDs, exact readback, durable ACKs and
external Retry-After without taking a catalog owner. Composed tests cover a
lost native ACK, no duplicate write, current-field semantic resolution, cold
expired workspace recovery, cross-scope rejection and original photo deadlines.

The existing workflow now performs owner-free provider preparation before its
single `catalog-production` job, with an exact source/config/run handoff. The
publisher refuses to begin provider work. A lost runner resumes the ORIGINAL
preparation, not another day/cohort. Index delivery follows publication using
the existing immutable saved payloads; it has no supplier/model credentials or
catalog owner. Optional pending delivery reports separately from acceptance.

Composed driver coverage verifies preparation makes no product writes, the
publisher refuses missing preparation, saved work publishes without another
provider request or native wait, and finalized retries cannot replay anything.
Production observations: due-photo43804497252 completed in21m15s; full43908209952
in85m31s. Full preparation took38m16s; its catalog job44m44s included38m06s
applying the finite saved cohort, not building the app or waiting for indexes.
The cohorts differ, so compare operation counts as well as wall time. Actual
provider billing/storage remain unknown; the full run's model-cost estimate is
not an account invoice. Seven unattended cycles remain a separate observation.

The ID/hash-only phase journal uses the existing validated control store in
public-delta runs. Its referenced provider bodies retain their original expiry;
every mutation still awaits the original durable checkpoint and accounting.
This avoids registering each recovery-metadata snapshot as expiring merchant
content. An identical ten-mutation fixture uses55 versus77 durable writes,
with unchanged recovered state. This is not a live wall-time saving claim.
