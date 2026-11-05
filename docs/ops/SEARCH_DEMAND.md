# Stupid Gifts — Foundational search-demand telemetry

**Live and verified November 5, 2026**, following owner approval and PR351 merge.
Acceptance: [deployment and ingestion evidence](evidence/2026-11-05-search-demand-accepted.json). Bead:
**Measure settled search demand and unmet topics** (`roadmap-lbbz1.18`).

## What it measures

- A normalized topic once current results have settled for 1.5 seconds, or sooner after explicit Search/Enter or a result click. Intermediate edits, aborted/stale responses, Clear and unmount cancel pending observations.
- Results actually shown (0–36), unavailable searches separately, and the first result selected/its one-based position. Repeated submits do not inflate a search; retries of unavailable searches are new attempts. A later click updates the same record, including when network deliveries arrive out of order.
- A random **per-search** nonce provides idempotency, not a visitor identity. We keep no IP, user/session ID, keystroke trail, product copy, separate recipient fields, full URL, referrer or cookies. The browser request omits credentials and referrer. No topics enter GA4/PostHog; their existing count-only contract is unchanged.
- A normalized topic is the search phrase itself, lowercased/space-normalized, **not an AI category label**. It can still contain personal details our filter misses; this is first-party free-text collection with the limitations below, not guaranteed anonymization.
- Obvious emails, URLs, phone-like input and oversized/freeform topics are suppressed on both sides. Filtering cannot guarantee removal of all personal details. DNT/GPC disables collection; QA attribution, localhost, Preview and illustrative fixtures do not collect.

## Storage and reporting

- One small D1 `search_demand` table, separate from catalog identities/history and publication fencing. One idempotent upsert per settled search; at most one subsequent selection update. No model, vector or supplier calls and no new service/scheduler.
- Observations expire from reports after 30 days. Indexed deletion runs with each subsequent ingestion. With no traffic, expired physical rows can remain until the next ingestion; this is not a strict wall-clock deletion guarantee. Reports always exclude them. Original expiry/day cannot be renewed by selection/retry.
- Operator-only aggregate report (UTC days, no public read endpoint):

  ```sh
  CLOUDFLARE_ACCOUNT_ID=7f05a1dcb6e16f9c239564a0293bbe74 npm run searches:report -- --days 7
  # Isolated Wrangler local DB, for fixture verification only:
  npm run searches:report -- --days 7 --local
  ```

- Report columns: completed/unavailable searches, zero/sparse (1–3) counts/rates, average shown, searches with a selection, selection rate among searches with results, average selected position and latest UTC day. Top 50 topics by observed volume. `--days` accepts 1–30; this command is SELECT-only.
- Use Node22 and the runbook's scrubbed environment. The explicit non-secret account ID avoids Wrangler's multi-account selection prompt; it does not change credentials or permissions.
- These are interactions, not unique people or proven purchases. Many results can still be poor; no selection does not prove dissatisfaction. Bots can submit observations too. An empty report means no collected observations, not no visitors/searches. Compare provider count-only events for coverage, accounting for settlement/opt-outs/suppression.
- Use frequent zero/sparse/no-selection topics to prioritize a human review of results, then propose discovery through normal quality/dedup/admission-before-enrichment. No automatic ranking changes or backfill in this foundation.

## Reliability and release

- This is an independent best-effort same-origin POST. Search never awaits its network or D1 work. Missing migration, unavailable storage, timeout and blocked browser APIs do not change results or native link navigation. No visitor quota/spending gate or new model call.
- Same-origin JSON only, strict allowlisted payload, 1 KiB transport bound, bounded optional-request timeouts, parameterized SQL and no query/provider-error logging. These protect telemetry transport, not public search availability. No CORS export or public topic read API.
- Rollout complete: the remote pending-migration list contained **only `0017_search_demand.sql`**; normal D1 migration application and independent table/history readback passed. The code-only serving release preserved the actual accepted catalog, original D1 receipt, resolved build, idle owner and successor. Do not replay the completed migration, helper, upload, activation or provider phases.
- Verify one clearly labeled synthetic search directly against an isolated local DB first. After production approval, verify a permitted observation and report readback, then check opt-out/QA emits nothing and search still works with telemetry unavailable. Ordinary QA (`utm_medium=qa`) intentionally produces no record; do not pretend a QA search proves ingestion. Use no real private recipient text.
- Rollback is code-only: previous serving code ignores this additive table; catalog and indexes are unchanged. Do not delete catalog/history or reset publication receipts to disable optional telemetry.

## Verification

- `npm run test:search-demand` covers normalization, strict schema, settlement/edit/submit/click cancellation, opt-out, dependency/transport failures, SQLite migration/upsert/idempotence, original retention, report math and slow bodies.
- Existing search, analytics and Worker regression suites cover preserved browsing/provider contracts and production-only endpoint dispatch. Both strict typechecks, lint and explicit-context static build/release verification are required before merge. A local fixture build is not production ingestion evidence.
