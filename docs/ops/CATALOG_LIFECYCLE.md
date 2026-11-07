# Stupid Gifts — Catalog lifecycle

## Operating now

- Existing local Codex task,08:30 Pacific: optional campaign digest, visual
  homepage edition, up to10 existing gift refreshes, agent review and one normal
  Cloudflare catalog publication. Urgent finite photos first; then one
  weekly-due unavailable-stock recheck; ordinarily four featured/six other gifts
  with sparse-lane backfill. All remain within10, not10 per lane.
- Homepage: six weekly highlights plus eighteen daily rediscoveries from the
  accepted catalog. Rotation is not new-product ingestion. No keyword/category
  gates or paid per-visitor curation.
- Monday only: six search themes, up to60 raw results; catalog/family dedup
  includes private holds; admit at most20 worthwhile gifts before copy/review
  and embeddings. New gifts require short factual copy, not a long article.
- Tuesday–Sunday maintenance reuses existing copy/vectors without model calls.
-20:30 Pacific: at most10 genuinely due photos, otherwise a read-only no-op.
  No new products, copy, articles or embeddings in this invocation.
- Accepted new text uses one canonical short description, one saved native
  embedding and its serving projection. Native/serving search indexes and
  static keyword data update through the same publication. Static pages and
  search continue serving on Cloudflare if the Mac is asleep; catalog care does
  not run until its local runner is available.
- Confirmed retailer-unavailable products leave public surfaces and buy links,
  retaining private identity/history and cleared content. Unknown/errors/age
  are not stock evidence. A fresh positive observation restores the same URL.
  Original supplier deadlines and settled/unknown usage never reset.

## Observed throughput, not promises

- November2:60 candidates →46 quality rejects →11 duplicates →three new public
  gifts. Two other private candidates were not public additions.
- Current maximum is20 additions/week, not20/day and not a target to fill.
- At ten checks/morning, one whole-catalog pass of roughly3,350 gifts takes at
  least335days; urgent photos and lane preferences can make it slower.
- November3's normal scheduled run took25m52s end-to-end. Supplier work took
  under a minute; most elapsed time was full-catalog verification, build/proof
  and local cleanup. Recovery engineering time is not normal run latency.

## Proposed automation transition

The consolidated [catalog automation specification](CATALOG_AUTOMATION_SPEC.md)
defines the final reviewed target, parallel implementation boundaries and staged
hosted cutover. It supersedes earlier informal target-state proposals, not the
operating-now policy above. Existing Beads remain the implementation tracker.

The specification does not itself enable a cadence/throughput change, another
batch under the current schedule, a new service plan or campaign enrollment.
