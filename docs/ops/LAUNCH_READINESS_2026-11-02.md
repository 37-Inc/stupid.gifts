# Stupid Gifts — Podcast launch readiness

## Decision

Use the existing Cloudflare Workers Standard plan. No additional infrastructure
upgrade is indicated for the gradual podcast audience Cameron expects. This is
a measured readiness assessment, not a load-test or audience-size guarantee.
Howie approved the revised rehearsal over the weekend, reported November 2;
the final human acceptance in `roadmap-lbbz1.5` is complete.

## Measurement

The existing property `507421709`, stream `12249530179`, measurement
`G-6RR3HPR747`, and Ads destination `AW-17626116539` are unchanged.
The authorized Admin API readback confirms six EVENT custom dimensions:
`traffic_source`, `traffic_medium`, `traffic_campaign`, `product_id`,
`ui_context`, and `source`. Automatic outbound clicks, site search, form
interactions, and history-triggered pageviews are disabled. Unrelated enhanced
measurement settings remain unchanged; the explicit sanitized adapter remains.

One real browser journey, labelled `measurement_20261102` / `qa`, opened Amazon
ASIN `B0CRRWZHK1` with `tag=goose-gifts-37-20`. Network proof: one explicit
GA4 outbound event, HTTP 204; no automatic `click`, `link_url`, or affiliate tag
in GA4 collection; PostHog accepted the two event batches with HTTP 200.
GA4's new custom dimensions are queryable, but processed rows were not yet
available. `roadmap-lbbz1.8.4.1` owns that delayed report check; old unregistered
parameters cannot be recovered retroactively. Untagged events are not proof of
human acquisition or commission. No self-purchase was made.

Private before/after receipt: `measurement-20261102-receipt.json` under the
existing protected migration directory. No secret or personal identifier is
included in this document.

For a link in the episode description, use
`https://stupid.gifts/?utm_source=howie_mandel_does_stuff&utm_medium=podcast&utm_campaign=launch`.
Listeners who simply type the domain will usually appear as direct traffic;
do not relabel all direct visits or rehearsal `/h` tests as podcast acquisition.

## Traffic and capacity

Read-only provider evidence at 19:40 UTC November 2:

- Workers account confirms `standard: true`; deployed Worker uses `standard`.
- Rolling seven-day site analytics: about 40,300 successful requests, 164
  client disconnects, one response-stream disconnect, zero reported errors.
  These are requests, not people. Successful-request p99 Worker wall duration
  was about 47 ms; this excludes the complete browser page-load experience.
- Production D1 size: 84,955,136 bytes, about 85 MB. Current UTC-day site usage:
  693,372 rows read and 16 written. Shared-account usage is about 29.4 million
  reads / 98,286 writes, mostly another project; do not attribute it to visitors.
- The existing reviewed release has about 7,021 physical assets, not 17,000.
  No new asset-store migration or consolidation is required for launch.
- Home, product HTML, browsing and keyword search use the sealed static catalog;
  ordinary visitors do not run whole-catalog D1 queries. The Worker dispatcher
  still runs for static requests, so these are not all unmetered asset hits.
- Semantic search remains capped at 50 requests / 32,768 tokens per UTC day.
  After the cap or a provider failure, keyword search remains usable. This is
  a deliberate model-spend limit, not a reason to buy another database plan.
- Read-only alert-policy API access is unavailable (403). A previous dashboard
  check observed the default billing-budget alert; this audit does not pretend
  it reverified a custom error notification or changed notification access.

Workers Standard includes 10 million requests and 30 million CPU-ms monthly;
excess rates are $0.30/million requests and $0.02/million CPU-ms. D1 includes
25 billion reads, 50 million writes and 5 GB; excess reads are $0.001/million,
writes $1/million, storage $0.75/GB-month. These are shared account allocations,
not a prepaid visitor count. The existing $5 minimum covers the current plan.
Vectorize includes 50 million queried / 10 million stored dimensions on Paid;
overages are usage-based, not a separate mandatory hosting upgrade.

Primary pricing references, checked November 2:
[Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/),
[Vectorize](https://developers.cloudflare.com/vectorize/platform/pricing/).

## Practical response

Continue the one existing daily task and portfolio pulse. No duplicate monitor,
load test, new subscription, broad logging, or automatic plan change is needed.
If sustained 5xx errors or search latency appear, first inspect Worker errors
and D1 usage. Keep static browse and keyword fallback available; disable only
semantic serving through the reviewed configuration if its provider is at fault.
Do not drop products or rebuild the catalog as an incident response.

If an actual new deployment regresses, use its retained immutable previous
Cloudflare version and verified receipt, with the normal owner/source checks.
Keep backups and Goose-domain redirects; do not recreate Vercel or Neon.
Reassess spending from real traffic rather than pre-purchasing capacity.

The routine publisher's old 1.5M-read guard was below the accepted full-catalog
run's measured 1.83M reads. The reviewed Standard profile therefore keeps a
finite 6,000 HTTP / 12,000 SQL / 3M-read / 40k-write margin. Free's profile and every prior
reserved run stay unchanged. This is not a new purchase or a larger supplier or
model allowance. Even 3M reads on each of 31 days is 93M, under 0.4% of 25B included
reads before other account usage; publication cost is not the hosting bottleneck.

## Discovery acceptance

The refresh selector and admission-before-generation cap are already merged.
The remaining engineering gap is new approved short-copy discoveries reaching
the permanent catalog publication, rather than remaining held because they
lack a durable base. The correction binds a reviewed factual name and original
short copy to the existing owned fallback and canonical retailer link, with
supplier photos kept in the already-supported finite overlay. Existing licensed
photos/copy are not replaced. A long article is optional.

Keep 10 existing refreshes per Pacific day, six Monday discovery themes and at
most 20 admitted products before generation, including held identities in
deduplication. No volume expansion or creator-research integration. Actual
scheduled operating cost and new-admission evidence must be recorded separately
from local tests or a manually triggered deployment.

The November 2 live supplier phase refreshed ten existing products. Six searches
returned 59 candidates: 37 failed quality checks, 20 were duplicates and two
entered drafting. Drafting failed; the same existing API key can read the model
but a minimal completion returns HTTP 429, `credit_balance_exhausted`. The two
new records remain private/pending, not approved or published discoveries. No
billing or key change was made. Replenishing the existing OpenAI account is an
owner action; it is not another Cloudflare upgrade. Until then, preserve old
copy and let search fall back to keywords. The retry helper reports the precise
quota code and skips futile per-product retries for this definitive failure.
