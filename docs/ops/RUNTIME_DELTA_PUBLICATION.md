# Short runtime publication — implementation contract

Scope: `roadmap-lbbz1.32.1`, with real-run measurements in `.36.4`.
This is unfinished implementation, **not an activated production mode**.

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
3. Assemble the public delta. Copy unchanged public projection rows in SQL,
   transfer actual differences, and independently read back the complete public
   projection. This is small public data, not archived supplier/native bodies.
4. Export the accepted public data with original finite-overlay deadlines.
   Existing retained data/collections remain on the same runtime reader.
5. Atomically check owner, source counter and expected public predecessor;
   record the real projection/publication receipt, runtime data head, resolved
   data-build request and idle owner. A body-free handoff survives a lost ACK.
   Finish the existing hosted successor CAS before releasing the publish queue.

`stageOwnedPublicProjection` is shared with legacy sealing: do not maintain a
second staging implementation. Staging alone never creates acceptance.
`assembleRuntimeCatalogDelta` preserves identities/exclusions; stock restoration
requires a genuine positive observation. Expiry falls back to cleared content.

## Search is a derived delivery, not listing acceptance

- Prepare from the exact verified saved embedding, with no second model call.
  Persist a content-addressed private native payload before the source changes;
  an additive outbox hash binds it to the original event/version and proof.
- New delivery uses immutable content-addressed IDs in BOTH existing indexes:
  original1536 bytes plus the1024 serving projection. Keep historical stable-ID
  vectors and every original native receipt untouched. Do not change index,
  model, credentials or dimensions, and do not fabricate a legacy native seal.
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

## Hosted integration / cutover still required

- Generalize the existing owner-free saved preparation for morning/photo care,
  not only staff additions. Keep original due dates, run identities, selections,
  AI reviews, limits-as-alerts and provider-stage journals.
- In the existing workflow put preparation before, and index work after, the
  short `catalog-production` publication job. Staff requests use the same commit
  code and do not queue behind a daily job's supplier/model/index work.
- Commit prepared daily work in bounded existing technical batches. Give ready
  staff admissions a turn before the next daily batch through this SAME
  publisher. Do not hold its owner for an entire day's preparation/index work,
  create a matrix job per product, or introduce parallel catalog writers.
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
