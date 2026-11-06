# Stupid Gifts — Search health and demand measurement

Read-only production audit, November 5, 2026, approximately noon Pacific. Proposed collection below is **not enabled** by this documentation PR.

## Verified now

- Today's scheduled catalog publication completed: public release `daily-2026-11-05-76fa8ba2-9d850ef2`, manifest `a4cd86ecd0aa3a144d7b576ccb11c229fa57c267cfa008de6c943d83afd7ea8f`, matching protected accepted successor. No provider batch was run for this audit.
- Desktop and 390px mobile homepage show the intended heading, 24 pictured/described cards and no horizontal overflow. Sampled photos, including the previously repaired alligator mitts and rooster, loaded. Offscreen lazy images are not broken images. Load more expanded to 48 cards, all with short copy.
- Exact `raw chicken vase` search ranked that item first; natural-language cat search returned cat gifts; `fishing` returned 30 results; nonsense input returned the useful empty state. Clear restored browsing. Guides and hydrated Surprise me worked; sampled retailer URL retained `goose-gifts-37-20`. Browser checks used `utm_medium=qa`; no retailer click or purchase was generated.
- No warning/error appeared in the inspected browser log. This is representative browser QA, not proof that every route/provider is error-free or a load test. All 23 focused search, relevance and static analytics tests passed against the actual serving source `76fa8ba2`.
- Live PostHog readback: 1,106 non-QA `search` events November 3–5 through approximately 11:50 Pacific; 175 showed zero results and 151 showed 1–3. No event lacked `result_count`. These count completed rendered searches, **not distinct humans or necessarily settled queries**; results are capped at 36 shown. Last-hour activity also included 18 searches and 10 retailer outbound events.

## Quality work still warranted

- Fishing results include many ordinary nets/aprons; cat results lead with several similar blankets. Transport works, but result count alone does not prove funny, diverse, relevant results.
- `/gifts/get-knit-together-with-mickey-stuffed-animal` currently shows a six-pack of insect nets with unrelated “snuggle buddy”/cartoon copy. Investigate old editorial versus refreshed supplier identity before correcting; do not rename/delete the stable record casually.
- The homepage My First Fire prank-box card repeats its disclosure in the short description. Review card presentation without losing the important empty-box disclosure.
- Track these in **Repair mismatched catalog copy and improve search result quality**. Keep this separate from campaign selection; commission must not override relevance.

## Small telemetry proposal

- **Reuse existing providers for counts only.** `Search.tsx` calls `captureStaticSearch(products.length)` after each successful 400ms-debounced response. The explicit GA4/PostHog contract deliberately excludes query text; production snapshot search disables per-query D1 diagnostics. Old Neon search logs are not current traffic evidence.
- **Add a first-party daily aggregate, not a visitor log.** Record a bounded normalized topic, completed-search count, zero/1–3-result counts, displayed-result count and whether a result was selected. Keep topic text out of GA4/PostHog. No IP, persistent session/user ID, recipient information, raw keystroke trail or raw request/error logging.
- **Define “settled,” don't pretend to know intent:** count after 1.5 seconds without further typing, once current results have rendered; explicit Search/Enter or selecting a result can commit sooner. Cancel pending telemetry immediately on edits, Clear, stale/aborted responses and unmount. Deduplicate Enter-plus-debounce. A later genuine new search is a new interaction. Count failures separately; they are not zero-result searches. A missing click is not automatically a bad result.
- Suppress obvious personal identifiers, emails, URLs and phone-like input; bound length and avoid retaining freeform recipient details. Respect DNT/GPC and exclude QA. Automated PII detection is imperfect: review suppression tests and accurate privacy wording before enabling collection. The present policy promises no search text to third-party analytics; preserve that promise. Also remove its obsolete claim that semantic search has a daily limit when that policy next changes.
- Retain topic aggregates for 30 days; clean them through existing maintenance, not another scheduler. Telemetry is best effort: timeout/failure cannot delay or disable search. No new model call, visitor budget cutoff or automatic catalog backfill.
- Report top topics, zero/sparse-result rate and result-selection rate with sample sizes. Review actual results for frequently underserved topics, then propose relevant discoveries through normal admission-before-enrichment. Do not infer demand from bots/QA or quality from result count alone.
- Test settled/cancel/submit/click/history behavior, privacy suppression, QA/DNT/GPC, unavailable telemetry and empty/error distinction before reviewed deployment. Keep historical response-event counts distinct from the new settled-search metric.

## Source references

- `static-site/components/Search.tsx`, `static-site/lib/analytics.ts`, `lib/analytics-contract.ts`, `lib/client-analytics.ts`.
- `workers/site/index.ts` / `search.ts`: semantic service with keyword fallback; snapshot keyword results intentionally avoid diagnostic writes.
- `lib/privacy-policy.ts`; `docs/ops/HOMEPAGE_EDITOR.md`; private `daily-catalog-care/runs/scheduled-2026-11-05/success.json` and accepted pointer.
- Follow-up: **Measure settled search demand and unmet topics** (`roadmap-lbbz1.18`). No new collection, ranking change, campaign enrollment or deployment in this PR.
