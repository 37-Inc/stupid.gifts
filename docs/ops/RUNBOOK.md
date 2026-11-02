# Stupid Gifts — Catalog Care

This is the operating contract for the EXISTING `goose-gifts-daily-ops`
Codex task, daily at 08:30 Pacific. Canonical Beads in `~/roadmap` and the
latest protected receipt take precedence over historical journal entries.

## Current state

November2 correction: the October31 batch is uploaded but not yet accepted;
the timer remains paused until its recovery is verified. Canonical `.4.17`
records the exact version/checkpoint. Cameron approved completing it and
simplifying recovery. Cloudflare's read-only Workers API confirms Standard
is already enabled; make no subscription changes. Admission uses the actual
plan, retaining finite run budgets without obsolete Free account ceilings.
Historical unknowns remain recorded but do not categorically block readback.
Public long articles are optional; never require a fixed article count while
preserving every listing, image, short description and original history.

To finish an acknowledged permanent upload from an earlier day, use Node22
and the scrubbed environment below with:
`node --import tsx scripts/catalog/resume-publication.mjs YYYY-MM-DD`.
This uses the original retained runtime/config and the same uploaded version;
it cannot fetch merchants, invoke models, rebuild or upload. A once-only
checkpoint-bound continuation retains original deadlines and counters. Only
cleared permanent controls and numeric summaries survive supplier-body expiry.
Finite supplier fields cannot use this path. Verify actual release, D1 receipt,
resolved build, idle owner and successor before restarting daily care.

October30 Pacific / October31 00:39UTC: recovery is **COMPLETE**. Actual release
`catalog-corrected-20261030-36a54e6` serves runtime36a54e6, version
`99409f6b-ce64-4cb2-bb00-9730bcd81aaa`, deployment
`193f85c6-584d-4192-ab9c-fbf9fb72fa4e`. The original upload was reused, not
repeated. Genuine D1 receipt, resolved build, final idle owner28/555 with zero
external pending, accepted successor and public/browser checks all pass.
All3352 public gifts/31 exclusions/3383 identities/42 articles remain;7021
physical files and3397 sitemap URLs are verified. See
`evidence/2026-10-30-catalog-care-accepted.json` and canonical `.4.13`.
The app/Beads record current status of the SAME08:30Pacific timer; archived
holds never override accepted current evidence.

All one-time quota grants are historical, not normal budget increases. Retain
the combined6093HTTP/9263SQL/2181633known reads/40538writes/four original
read-only unknowns; child unknowns remain zero. Latest UTC-day account usage
was638423reads/16writes, well within Free. Preserve the frozen finish reader
`/Users/cameronehrlich/.codex/worktrees/stupid-publication-finish/stupid.gifts`
at2f6eb6f for this completed run's original36a54e6 source binding. Older readers
cannot parse its newer finish allowance. Never rerun completed recovery helpers,
upload, activation or supplier phases; original clocks/claims/history remain.

The October30 publication-only recovery is tracked in
`roadmap-lbbz1.4.13`. Its acceptance receipt is
`~/.codex/private/goose-gifts-migration/catalog-corrected-publication-20261030/accepted-publication.json`.
Read that receipt and the actual public
`https://stupid.gifts/.well-known/catalog-release.json` before operating.
A missing receipt is not success. The accepted successor for routine care is
`~/.codex/private/goose-gifts-migration/daily-catalog-care/last-success.json`.

The maintained operator is this clean, merged checkout:
`/Users/cameronehrlich/.codex/worktrees/stupid-catalog-care/stupid.gifts`.
Its runtime includes the reviewed storefront, Howie rehearsal, bounded
maintenance, source-lineage fixes and zero-native-effect recovery reader.
Keep it unchanged during a run. Historical execution checkouts are frozen
source bindings, not alternate daily operators.

Do not replay any completed migration, recovery, provider batch, upload or
activation. In particular, the incorrect 3349-public/34-held October30 staging
revision was withdrawn without deleting its history; it is never a release
candidate. The exact historical vector affected by that attempt was restored.
The one-time additional25k publication-write allowance is historical only;
it does not increase the normal30k ceiling or tomorrow's supplier allowance.

## Preservation and scope

- Cloudflare `https://stupid.gifts` is the ONLY release target. Stay on Free.
  Vercel and Neon were retired; preserve backups and Cloudflare redirects.
- Preserve all3,383 migrated identities, slugs, original licensed imagery,
  descriptions, articles, native vectors and operation history. The baseline is
  3,352public/31specific exclusions/42articles. The31 exclusions are seven
  confirmed duplicates and24individually justified ordinary products.
- Cleared base imagery/copy has no expiry. Finite supplier overlays keep their
  original deadlines and fall back to cleared content. Expiry or failed copy
  generation never deletes or deactivates a listing or native entry.
- Stupid Gifts / Thirty Seven Inc; `goosegifts@37.technology`; no personal-name
  bylines. Amazon tag: `goose-gifts-37-20`. Never fabricate prices/availability.
- Every home/search/guide card shows image, title and short description. Preserve
  the white gallery,24-item batches, factual short names and original detail
  disclosures. Six weekly anchors plus eighteen daily qualified rediscoveries
  rotate at successful publication, not midnight or each visitor.
- Directory `/gifts` and Weird Gift Index stay404; individual `/gifts/[slug]`
  pages remain canonical. The unlisted `/h` rehearsal stays noindex and keeps
  its separate opening assortment and seven approved reveal products.
- No social/Pinterest/Slack posts, new timer/hosted Cron, paid service,
  quota-consuming load test, blanket enrichment or Creator Product Research.

## Daily policy and budgets

At most ten EXISTING products per Pacific day across retries: four oldest
featured public gifts and six oldest other public gifts, with deterministic
sparse-lane backfill. A failed run does not authorize another batch.

Monday additionally searches six rotating themes and admits at most twenty
quality/family/catalog-deduplicated gifts, INCLUDING excluded identities in
deduplication. Select and cap admissions BEFORE drafting, review or embedding.
Required factual short descriptions are independent of optional long articles.
Tuesday–Sunday are model-free. Reuse unchanged approved copy and embeddings.

Normal limits remain5,000HTTP/12,000SQL/1.5Mknown reads/30kknown writes, with
separate uncertainty reserves and untouched shared-account headroom. The
operator checks fresh ACCOUNT-WIDE Free usage before work and publication.
Never raise caps, reset counters, erase unknowns, buy another batch after
failure or upgrade to finish. Stop on a genuine capacity gate.
The bounded usage query refuses truncated results and distinguishes provider
analytics throttling from Free-quota exhaustion. On `headroom_rate_limited`,
respect the provider's retry delay, then retry only the same read-only preflight
or pending publication. Never fetch a replacement batch. A reporting-only
throttle after an accepted release does not invalidate that release.

## Commands

Use Node22, the exact maintained checkout above, and a scrubbed environment:

```sh
env -i HOME="$HOME" PATH="/Users/cameronehrlich/.nvm/versions/node/v22.23.1/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" npm run catalog:care -- prepare
```

A healthy `daily_already_reserved` skip means STOP. Otherwise run `start`,
then `review`, then `publish <actual-proposal-SHA256>` with the SAME prefix.
Review the real bounded changes yourself; ordinary maintenance does not
require Cameron's approval. `status` is diagnostic, not a second provider run.

A pending publication resumes ONLY its original config/source/owner/checkpoint.
Never force locks/ownership, reset reservations, change a source checkout
during execution or improvise a replacement batch. A failed preflight for
unsealed older work must be reconciled before fetching.

Credentials come only from existing reviewed Wrangler OAuth/Goose Keychain
references. Never print values, change ACLs/reseed credentials, repeatedly retry
unattended access or substitute ambient secrets. If access actually fails,
request only the exact attended credential approval needed.

## Completion and verification

Completion requires finalized checkpoint, actual public release identity,
matching genuine D1 receipt, resolved build, idle owner and accepted successor.
A merge, upload, exit0 or cache200 alone is not completion. Code-only storefront
deployments remain distinct from D1 catalog receipts.

Check home24→48, loaded images/descriptions, a changed product, correct affiliate
tag, guides, Random, and the rehearsal. Label browser QA `utm_medium=qa`.
The reviewed derived semantic index remains enabled under its50-request/
32,768-token daily limit; changed/unproved inputs use working keyword fallback.
Do not use the nearly empty legacy native index. No live model calls are
permitted during a specifically model-free recovery; use offline search tests
and label that limitation honestly instead of claiming a live query test.

Keep routine receipts private and execution source clean. Only registered local
supplier-body cleanup is allowed, using each run's EXACT original repository
binding, original deadlines and current compatible reader. Preserve locks,
minimal controls, seals, historical receipts and all charges/unknowns. Cleanup
is not catalog deletion and never renews rights.

Record the first ACTUAL scheduled normal-run cost, database/storage growth,
static asset count and build/cleanup duration in `roadmap-lbbz1.4.8`. This
manual recovery and local builds are not steady-state billing evidence.
Fair refresh selection remains `.4.14/.4.11`; broader launch readiness is
`.4.16`. Healthy runs/skips stay quiet; report meaningful changes/failures
or exact required owner action.

## Source changes

Use an isolated `codex/` branch, preserve unrelated work, review/simplify the
diff, run focused regressions, both strict typechecks, lint/audit and an
explicit-context static build plus release verification. Browser-check the
changed flows. Commit, PR, review, merge, then publish through the normal
Cloudflare contract and verify production. Keep source integration separate
from deployment. Do not remove frozen recovery/measurement sources or another
run's registered package as routine worktree cleanup.

Historical details remain in Git history, `JOURNAL.md` and
`archive/RUNBOOK_MIGRATION_2026-10-23.md`; they are not current commands.
