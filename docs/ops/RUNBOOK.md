# Stupid Gifts — Catalog care

Read current canonical Beads in `~/roadmap`, the actual public
`https://stupid.gifts/.well-known/catalog-release.json`, and the hosted private
R2 `pointers/last-success.json` first. The Mac's pre-cutover
`daily-catalog-care/last-success.json` is retained history, not the current hosted
catalog pointer. Serving code and accepted catalog can differ.
Use their clean retained operator; never overwrite a newer accepted
site with an old checkout or modify a source while its run is active.

## Current mode

The single GitHub catalog workflow owns 08:30 Pacific full care, 20:30 due-photo
care, a 10:30 morning catch-up and a 22:30 evening catch-up using the same respective run identities. Photo-only keys use the evening slot's UTC date so a late overnight dispatch cannot reserve the following evening; full care retains Pacific dates. Saved pending records always keep their original day/source/config. The old
`goose-gifts-daily-ops` Codex writing timer remains paused after cutover. Never
enable both. The explicitly activated private automation policy enables scaled
due-work, daily visual admission and API homepage editing; absence/disablement
retains the legacy ten-product/Monday/model-free policy.
See [HOSTED_CATALOG.md](HOSTED_CATALOG.md)
for shadow, canary, explicit activation and single-writer recovery, and
[the approved spec](CATALOG_AUTOMATION_SPEC.md) for successor behavior.

November 6 baseline: 3,390 identities, 3,347 public gifts, 43 holds, 37 optional
articles and roughly 7,008 static files. These are observations, not growth caps.
Full migration/17k-file cleanup are complete. Earlier recoveries, grants and
publications are historical; never replay their supplier/model phases, upload,
activation or finalization.

## Preservation and service

- Release only to Cloudflare `https://stupid.gifts` on the existing Workers
  Standard/D1 allocation. No plan changes. Vercel/Neon remain retired; preserve
  backups, redirects, historical source bindings, receipts and accounting.
- Preserve identities/slugs, licensed photos/copy, editorial, native vectors and
  history. Cleared base fields never expire. Finite overlays retain original
  observations/deadlines and fall back to cleared content. Expiry or failed
  enrichment alone never hides/deletes a gift or native identity.
- Current confirmed retailer `OUT_OF_STOCK`/`UNAVAILABLE` observations withhold
  shopping/search/sitemap/buy surfaces, not identity/history. Unknown responses,
  timeouts and undated imported labels are not current stockout evidence. A real
  positive observation restores the same gift/URL. Never mass-unlist old labels.
- Every public card uses image, factual title and one canonical short description
  across home/search/guides/product pages. Articles are optional. Keep the white
  24-item gallery, disclosures, hybrid search, Random and guides.
- Keep `/h` noindex, its eight immediate approved picks and real submit-only
  search; Clear restores picks. No guest label or previously shown goat/pickle/
  vase. Follow [HOWIE_SHORTLIST.md](HOWIE_SHORTLIST.md). Directory `/gifts` and
  Weird Gift Index stay404; individual product URLs remain.
- Identity: Stupid Gifts / Thirty Seven Inc, `stupidgifts@37.technology`. No
  personal bylines, invented prices/stock or show endorsements. Affiliate tag:
  `goose-gifts-37-20`; website parent store: `rileyehrlic0b-20`.

Routine HTTP/SQL/read/write estimates are alerts, not visitor/publication cutoffs.
Preserve original manifests and charged/unknown attempts; never reset/refund or
fetch another batch to escape a failed run. Delayed Standard usage is unknown,
not zero or a release gate. Keep real provider throttling/Retry-After, finite
batches, timeouts, payload bounds, identity/integrity and single-writer checks.
Historical migration/diagnostic scopes do not authorize broader writes.

Public semantic search has no internal spending/request/token, per-IP query-count
or client-count shutoff. Preserve caching, provider timeouts and keyword fallback.
Native1536 and derived1024 delivery reuse the same saved embedding; no second
generation or manual seed edit. Changed text gets its own correct binding; never
relabel old vectors. No blanket rebuild or repeated paid smoke/load tests.

Campaign metadata is optional. Read [CAMPAIGN_DIGEST.md](CAMPAIGN_DIGEST.md): raw
research exports are leads, not video/payback scores or website participation
proof. Joins/content submissions stay manual. Only fresh accepted, active, exact
product/seller/funding/website/content evidence grants a boost; stale/unknown/
unjoined offers lose the boost, not the gift. Only new/changed actionable manual
notices may use the existing marketing Slack transport. Missing export/login/
Slack never gates care/search. No social/Pinterest posts, automatic enrollment,
seller messages, new paid service, duplicate publisher or blanket regeneration.
Search-demand topics remain private under [SEARCH_DEMAND.md](SEARCH_DEMAND.md);
never send them to GA4/PostHog or log visitor identities.

## Local fallback commands — never concurrent with hosted care

These commands are for an explicitly reconciled fallback only. First stop hosted
writes and settle its saved pending run; paused scheduling alone does not cancel
an in-flight publisher. Routine hosted resumption uses the same GitHub workflow.

Use Node22 and this scrubbed prefix from the canonical clean operator:

```sh
env -i HOME="$HOME" PATH="/Users/cameronehrlich/.nvm/versions/node/v22.23.1/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" npm run catalog:care -- prepare
```

Morning: optional `catalog:homepage preview`/`select` first, following
[HOMEPAGE_EDITOR.md](HOMEPAGE_EDITOR.md): six weekly anchors plus eighteen daily
discoveries from actual accepted photos/copy, no keyword/category quotas. Failure
reuses the last good edition. Preparation pins the edition/config.

`run_already_completed` means stop. Otherwise use the same prefix for `start`,
inspect `review`, then `publish <actual-proposal-SHA>`. Ordinary maintenance needs
no owner approval. `status` is diagnostic; `resume` continues the same saved run,
not another fetch. For named authorized work, append `--run <same-label>` to every
command. Never replace a pending run with a new label.

Legacy morning selection prioritizes due photos, then featured/other public
rotation and its weekly unavailable recheck. Monday searches six themes, dedups
all identities/families, and admits up to twenty before drafting/review/embedding.
Every admission needs short copy and one embedding, not an article. The approved
successor policy has scaled due-work and daily visual admission; it activates
only through HOSTED_CATALOG, not by rewriting historical configs.

Evening: with the same scrubbed prefix, use `prepare --run photos-YYYY-MM-DD
--photos-only`. `photos_current` means stop before suppliers/reservations.
Otherwise start/review/publish with the same label and omit `--photos-only` on
later commands; saved config pins it. Reuse unchanged copy/native bytes; no
discovery, homepage/model or article generation. Failed observations never hide
a listing or renew its deadline.

Owner-picked admissions use `prepare --run <label> --admit-asins ASIN1,ASIN2`,
then the same saved run. No unrelated fetch/search or automatic campaign joining;
this does not change scheduled cadence.

## Publication, recovery and acceptance

Use the maintained [code-only route](CODE_ONLY_PUBLICATION.md) for code over the
accepted catalog. Preserve its genuine D1 catalog receipt and accepted pointer.
After merge, select manual `code` in the existing GitHub Catalog care workflow;
do not run full maintenance merely to ship a small UI fix. It shares the same
single-writer queue and resumes only its saved code intent. Pending catalog work
must finish first. No new private per-release publisher or fake catalog receipt.

Pending work keeps original source/config/owner/checkpoint/review SHA. Do not
force locks/owners or blindly retry uncertain version/activation writes.
Content-addressed asset retries reuse exact bytes; provider readback settles
uncertainty. Allow bounded30–60-second same-publication index-visibility waits.
For older saved post-provider work, `catalog:care recover <original-review-SHA>
--run <original-key>` verifies its frozen source/helper. A reviewed descendant
controller may also resume saved automated `phases_running` work using the
original config SHA instead: the original writing owner and finite cohort must
match, saved responses and committed receipts are reused, and only originally
captured unattempted work can execute. No new batch or source/config relabeling.
Historical execution adoption stays local-only. Completed special
recovery helpers never replay. Post-acceptance output cleanup is advisory and
holds source locks, not database/Worker deployment locks.

Credentials come only from reviewed local Keychain/OAuth references or explicitly
approved hosted secrets. Access failure needs the exact attended action; never
expose/reseed keys, alter ACLs or use ambient substitutes. Registered body cleanup
uses original source bindings/deadlines and a compatible reader; preserve locks,
controls/history/charges. Cleanup is not catalog deletion.

Catalog acceptance requires finalized checkpoint, actual public identity,
genuine matching D1 receipt, resolved build, idle owner and accepted successor.
Merge/upload/exit-zero/cache200 alone is not acceptance. Code-only and catalog
receipts differ. Verify first24→48, loaded photos/short copy, search/fallback,
changed product and actual tagged Amazon URL, guides, Random and unchanged `/h`.
Browser QA uses `utm_medium=qa`; no test purchases or repeated paid queries.
Keep receipts private and execution source clean. Seven unattended hosted cycles/
cost belong to a separate follow-up, not local-fixture or manual-recovery proof.

Use isolated branches; review/simplify/test before merge. Relevant suites:
`test:catalog-automation`, `test:catalog-ops`, `test:catalog-availability`,
`test:homepage`, `test:search-demand`, `test:staging`, typechecks/lint, plus actual
production-context build/independent verification. A provider-mutating legacy
entry is not a test. Report meaningful completion/failure or exact owner action;
healthy maintenance/skips stay quiet.

Historical prose remains in [the November6 archive](archive/RUNBOOK_PRE_AUTOMATION_2026-11-06.md),
older archives, Git history and protected receipts. It is evidence, not replay
authorization or an alternate current operating source.
